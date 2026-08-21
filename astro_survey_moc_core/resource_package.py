"""Resource Package v3 deterministic builder and hostile-ZIP validator."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from .contract import COVERAGE_ROLES, DATA_ORIGINS, SOURCE_TIERS
from .core import canonical_json, validate_moc_fits

PACKAGE_VERSION = "3.0.0"
REQUIRED_FILES = frozenset(("resource-package.json", "footprints/survey-footprints.json", "provenance.json", "README.md"))
MAX_ENTRY_BYTES = 512 * 1024 * 1024
MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 10_000


class PackageValidationError(ValueError):
    """Raised when a resource package is malformed or unsafe."""


@dataclass(frozen=True)
class ValidatedPackage:
    manifest: Mapping[str, Any]
    archive_sha256: str
    entries: tuple[str, ...]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_name(name: str) -> str:
    if not name or "\x00" in name or "\\" in name:
        raise PackageValidationError(f"Unsafe ZIP entry: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise PackageValidationError(f"Unsafe ZIP entry: {name!r}")
    normalized = path.as_posix()
    allowed = normalized in REQUIRED_FILES or (normalized.startswith("mocs/") and normalized.endswith(".moc.fits"))
    if not allowed:
        raise PackageValidationError(f"Unexpected v3 package entry: {normalized}")
    return normalized


def _validate_layer(layer: Mapping[str, Any], names: set[str]) -> None:
    required = ("layerId", "surveyId", "coverageRole", "dataOrigin", "sourceTier", "modality", "releaseId", "path", "sizeBytes", "sha256")
    missing = [key for key in required if key not in layer]
    if missing:
        raise PackageValidationError(f"Layer is missing fields: {', '.join(missing)}")
    if "evidenceRole" in layer:
        raise PackageValidationError("evidenceRole is removed; use coverageRole")
    layer_id = layer["layerId"]
    if not isinstance(layer_id, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]*", layer_id) is None:
        raise PackageValidationError(f"Invalid layerId: {layer_id}")
    expected_path = f"mocs/{layer_id}.moc.fits"
    if layer["path"] != expected_path or expected_path not in names:
        raise PackageValidationError(f"Layer path must be {expected_path}")
    if layer["coverageRole"] not in COVERAGE_ROLES:
        raise PackageValidationError(f"Invalid coverageRole for {layer_id}")
    if layer["dataOrigin"] not in DATA_ORIGINS:
        raise PackageValidationError(f"Invalid dataOrigin for {layer_id}")
    if layer["sourceTier"] not in SOURCE_TIERS:
        raise PackageValidationError(f"Invalid sourceTier for {layer_id}")
    if "coordinateFrame" in layer and layer["coordinateFrame"] != "ICRS":
        raise PackageValidationError(f"Only ICRS is supported for {layer_id}")
    if "ordering" in layer and layer["ordering"] != "NESTED":
        raise PackageValidationError(f"Only NESTED ordering is supported for {layer_id}")
    for key in ("surveyId", "modality", "releaseId"):
        if not isinstance(layer[key], str) or not layer[key].strip():
            raise PackageValidationError(f"Invalid {key} for {layer_id}")
    if not isinstance(layer["sizeBytes"], int) or layer["sizeBytes"] < 1:
        raise PackageValidationError(f"Invalid sizeBytes for {layer_id}")
    if not isinstance(layer["sha256"], str) or re.fullmatch(r"[a-f0-9]{64}", layer["sha256"]) is None:
        raise PackageValidationError(f"Invalid SHA-256 for {layer_id}")


def validate_resource_package(archive: str | Path, *, require_public_catalog: Mapping[str, Any] | None = None) -> ValidatedPackage:
    """Validate v3 structure, paths, links, limits, MOCs and all hashes.

    Passing ``require_public_catalog`` enables the public trust gate: the archive
    hash and package ID/version must be present in the Assets-owned catalog.
    """

    archive_path = Path(archive)
    if archive_path.stat().st_size > MAX_PACKAGE_BYTES:
        raise PackageValidationError("ZIP exceeds the archive size limit")
    archive_sha256 = _sha256(archive_path)
    with zipfile.ZipFile(archive_path) as source:
        infos = source.infolist()
        if len(infos) > MAX_ENTRIES:
            raise PackageValidationError("ZIP contains too many entries")
        names: list[str] = []
        total = 0
        for info in infos:
            name = _safe_name(info.filename)
            if name in names:
                raise PackageValidationError(f"Duplicate ZIP entry: {name}")
            names.append(name)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise PackageValidationError(f"Symbolic links are forbidden: {name}")
            if info.flag_bits & 0x1:
                raise PackageValidationError(f"Encrypted entries are forbidden: {name}")
            if info.is_dir():
                raise PackageValidationError(f"Directory entries are not part of v3: {name}")
            if info.file_size < 1 or info.file_size > MAX_ENTRY_BYTES:
                raise PackageValidationError(f"Invalid uncompressed size for {name}")
            total += info.file_size
            if total > MAX_PACKAGE_BYTES:
                raise PackageValidationError("ZIP exceeds the uncompressed size limit")
        name_set = set(names)
        missing = REQUIRED_FILES - name_set
        if missing:
            raise PackageValidationError(f"Missing v3 entries: {', '.join(sorted(missing))}")
        manifest = json.loads(source.read("resource-package.json"))
        if manifest.get("schemaVersion") != 3 or manifest.get("version") != PACKAGE_VERSION:
            raise PackageValidationError("Only Resource Package 3.0.0 is accepted")
        if "evidenceRole" in manifest:
            raise PackageValidationError("evidenceRole is removed; use coverageRole")
        if "coordinateFrame" in manifest and manifest["coordinateFrame"] != "ICRS":
            raise PackageValidationError("Only ICRS is supported by Resource Package v3")
        if "ordering" in manifest and manifest["ordering"] != "NESTED":
            raise PackageValidationError("Only NESTED ordering is supported by Resource Package v3")
        package_id = manifest.get("id")
        if not isinstance(package_id, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]*", package_id) is None:
            raise PackageValidationError("Resource Package v3 requires a stable package id")
        layers = manifest.get("layers")
        if not isinstance(layers, list) or not layers:
            raise PackageValidationError("Resource Package v3 requires at least one layer")
        layer_ids: set[str] = set()
        for layer in layers:
            if not isinstance(layer, Mapping):
                raise PackageValidationError("Layer records must be JSON objects")
            _validate_layer(layer, name_set)
            if layer["layerId"] in layer_ids:
                raise PackageValidationError(f"Duplicate layerId: {layer['layerId']}")
            layer_ids.add(layer["layerId"])
            info = source.getinfo(layer["path"])
            if info.file_size != layer["sizeBytes"]:
                raise PackageValidationError(f"Size mismatch: {layer['path']}")
            data = source.read(layer["path"])
            if hashlib.sha256(data).hexdigest() != layer["sha256"]:
                raise PackageValidationError(f"SHA-256 mismatch: {layer['path']}")
            with tempfile.NamedTemporaryFile(suffix=".moc.fits") as handle:
                handle.write(data)
                handle.flush()
                validate_moc_fits(handle.name)
        moc_entries = {name for name in name_set if name.startswith("mocs/")}
        declared_mocs = {layer["path"] for layer in layers}
        if moc_entries != declared_mocs:
            raise PackageValidationError("Every MOC must have exactly one manifest layer")
        support = manifest.get("files")
        if not isinstance(support, list) or len(support) != 3:
            raise PackageValidationError("Resource Package v3 requires supporting file hashes")
        support_paths = {"footprints/survey-footprints.json", "provenance.json", "README.md"}
        if {record.get("path") for record in support if isinstance(record, Mapping)} != support_paths:
            raise PackageValidationError("Supporting file manifest is incomplete")
        for record in support:
            if not isinstance(record, Mapping) or not isinstance(record.get("sizeBytes"), int) or re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", ""))) is None:
                raise PackageValidationError("Invalid supporting file record")
            info = source.getinfo(record["path"])
            data = source.read(record["path"])
            if info.file_size != record["sizeBytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise PackageValidationError(f"Supporting file mismatch: {record['path']}")
        try:
            footprint = json.loads(source.read("footprints/survey-footprints.json"))
            provenance = json.loads(source.read("provenance.json"))
            source.read("README.md").decode("utf-8")
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PackageValidationError("Supporting files must be valid JSON and UTF-8") from error
        if not isinstance(footprint, Mapping) or not isinstance(footprint.get("footprints"), list):
            raise PackageValidationError("Invalid survey footprint manifest")
        if not isinstance(provenance, Mapping) or provenance.get("schemaVersion") is None:
            raise PackageValidationError("Invalid provenance document")
        if require_public_catalog is not None:
            matches = [entry for entry in require_public_catalog.get("packages", []) if entry.get("id") == manifest.get("id") and entry.get("version") == PACKAGE_VERSION]
            if not any(entry.get("sha256") == archive_sha256 for entry in matches):
                raise PackageValidationError("Package is not trusted by the Assets public catalog")
    return ValidatedPackage(manifest, archive_sha256, tuple(names))


def _zip_timestamp() -> tuple[int, int, int, int, int, int]:
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))
    # ZIP timestamps cannot predate 1980 and are stored at two-second precision.
    when = datetime.fromtimestamp(max(epoch, 315532800), tz=timezone.utc)
    return (when.year, when.month, when.day, when.hour, when.minute, when.second - (when.second % 2))


def _zip_write(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, _zip_timestamp())
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    archive.writestr(info, data, compresslevel=9)


def build_resource_package(spec: Mapping[str, Any], output: str | Path, *, base_dir: str | Path = ".") -> ValidatedPackage:
    """Build a deterministic v3 archive from local, already-reviewed inputs."""

    if spec.get("version", PACKAGE_VERSION) != PACKAGE_VERSION:
        raise PackageValidationError("New Assets builds only produce version 3.0.0")
    package_id = spec.get("id")
    if not isinstance(package_id, str) or not package_id:
        raise PackageValidationError("Package id is required")
    base = Path(base_dir)
    footprint_source = base / str(spec.get("footprintPath", ""))
    provenance_source = base / str(spec.get("provenancePath", ""))
    readme_source = base / str(spec.get("readmePath", ""))
    for source in (footprint_source, provenance_source, readme_source):
        if not source.is_file():
            raise PackageValidationError(f"Package source is missing: {source}")
    layers: list[dict[str, Any]] = []
    moc_files: dict[str, bytes] = {}
    for raw in spec.get("layers", []):
        source = base / str(raw.get("sourcePath", ""))
        if not source.is_file():
            raise PackageValidationError(f"Layer source is missing: {source}")
        validate_moc_fits(source)
        layer_id = raw.get("layerId")
        target = f"mocs/{layer_id}.moc.fits"
        data = source.read_bytes()
        layer = {key: raw[key] for key in ("layerId", "surveyId", "coverageRole", "dataOrigin", "sourceTier", "modality", "releaseId")}
        layer.update({"path": target, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        layers.append(layer)
        moc_files[target] = data
    support_data = {
        "footprints/survey-footprints.json": footprint_source.read_bytes(),
        "provenance.json": provenance_source.read_bytes(),
        "README.md": readme_source.read_bytes(),
    }
    manifest = {
        "schemaVersion": 3,
        "id": package_id,
        "version": PACKAGE_VERSION,
        "surveyId": spec.get("surveyId"),
        "layers": sorted(layers, key=lambda layer: layer["layerId"]),
        "files": [
            {"path": name, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(support_data.items())
        ],
    }
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=output_path.parent, prefix=f".{output_path.name}.", delete=False) as handle:
            temporary = handle.name
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            entries = {
                "resource-package.json": canonical_json(manifest) + b"\n",
                **moc_files,
                **support_data,
            }
            for name in sorted(entries):
                _zip_write(archive, name, entries[name])
        validated = validate_resource_package(temporary)
        os.replace(temporary, output_path)
        temporary = None
        return validated
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
