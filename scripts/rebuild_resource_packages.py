"""Rebuild the public Resource Package v3 archives for every eligible survey.

The layer registry is the only identity/classification authority.  The script
keeps the v3 archive shape stable, writes support files in a temporary
directory, and refreshes the package catalog with the resulting archive hash.
It never includes input manifests, normalized scans, or task snapshots.

Surveys without acquired registry layers keep their existing migrated
archives untouched.  Content changes bump the package minor version and keep
the previous archive on disk so older release-history entries stay
downloadable.  Surveys containing native MOCs below the public O4 minimum
are deferred without changing their existing package or catalog entry.
Surveys listed in ASSETS_DENIED_SURVEYS (default ``csst``) are
never rebuilt or cataloged.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("ASSET_WORKTREE_ROOT", SCRIPT_ROOT)).resolve()
CORE_ROOT = Path(os.environ.get("MOC_CORE_ROOT", SCRIPT_ROOT.parent / "MOC-Core-SDK")).resolve()
sys.path.insert(0, str(CORE_ROOT))
from astro_survey_moc_core.resource_package import build_resource_package, validate_moc_fits
ARTIFACT_ROOT = ROOT / "artifacts/public-survey-footprints"
REGISTRY_PATH = ROOT / "src/layers/layer-registry.json"
FOOTPRINT_PATH = ROOT / "src/footprints/survey-footprints.json"
SURVEY_CATALOG_PATH = ROOT / "src/surveys/survey-catalog.json"
CATALOG_PATH = ARTIFACT_ROOT / "packages/catalog.json"
SOURCE_DATE_EPOCH = 1787184000
DENIED_SURVEYS = {
    item.strip().lower()
    for item in os.environ.get("ASSETS_DENIED_SURVEYS", "csst").split(",")
    if item.strip()
}
REGIME_WAVELENGTHS = {
    "ultraviolet": "ultraviolet",
    "far-ultraviolet": "far-ultraviolet",
    "optical": "optical",
    "infrared": "infrared",
    "near-infrared": "near-infrared",
    "far-infrared": "far-infrared",
    "radio": "radio",
    "millimeter": "millimeter",
    "submillimeter": "submillimeter",
}
COVERAGE_ROLE_PRODUCT_TYPES = {
    "image_extent": "image-extent-MOC",
    "object_presence": "object-presence-MOC",
    "footprint_extent": "footprint-extent-MOC",
}
SOURCE_TIER_AUTHORITIES = {
    "third_party_moc": "third-party-moc",
    "official_geometry": "official-geometry",
    "official_table": "official-tile-table",
}
ACCESS_MODE_BY_AUTHORITY = {
    "CDS public HiPS/MOC": "CDS HiPS",
    "DECam Legacy Survey DR5": "Legacy Survey viewer",
    "ANU SkyMapper DR4": "SkyMapper data release",
    "ESO VISTA Phase 3": "ESO Phase 3 archive",
}
UNIVERSAL_ACCESS_MODE = "Resource Package v3"


class PublicPrecisionError(ValueError):
    """Frozen geometry cannot satisfy the public native-order gate."""


def derive_access_modes(sources: list[dict[str, Any]], curated: list[str] | None) -> list[str]:
    modes = list(curated or [])
    for source in sources:
        authority = str(source.get("authority") or "").strip()
        if authority:
            modes.append(ACCESS_MODE_BY_AUTHORITY.get(authority, authority))
    modes.append(UNIVERSAL_ACCESS_MODE)
    return sorted({mode for mode in modes if mode})


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_product_id(survey_id: str, release_id: str, product: str) -> str:
    identity = f"{survey_id}\n{release_id}\n{product}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()[:20]


def native_coverage_revision(cells: tuple[tuple[int, int], ...]) -> str:
    ranges = sorted(
        (
            pixel * (4 ** (13 - order)),
            (pixel + 1) * (4 ** (13 - order)),
        )
        for order, pixel in cells
        if order <= 13
    )
    if any(order > 13 for order, _ in cells):
        raise RuntimeError("Public package MOC exceeds the supported O13 ceiling")
    merged: list[list[int]] = []
    for low, high in ranges:
        if merged and merged[-1][1] == low:
            merged[-1][1] = high
        else:
            merged.append([low, high])
    payload = json.dumps(
        {"coordinateFrame": "ICRS", "ordering": "NESTED", "intervalOrder": 13, "ranges": merged},
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(payload)


def package_layer_spec(layer: dict[str, Any]) -> dict[str, Any]:
    source_path = ROOT / layer["artifactPath"]
    source_bytes = source_path.read_bytes()
    source_hash = sha256_bytes(source_bytes)
    expected_hash = layer.get("expectedSha256")
    if not isinstance(expected_hash, str) or source_hash != expected_hash:
        raise RuntimeError(f"Frozen MOC checksum mismatch for {layer['layerId']}")
    cells = validate_moc_fits(source_path)
    native_max_order = max((order for order, _ in cells), default=0)
    if native_max_order < 4:
        raise PublicPrecisionError(
            f"{layer['layerId']}: native O{native_max_order} is below the public O4 minimum"
        )
    declared_max_order = layer.get("maxOrder")
    if type(declared_max_order) is int and declared_max_order != native_max_order:
        raise RuntimeError(f"Frozen native maximum order mismatch for {layer['layerId']}")

    recipe_doc = read_json(ROOT / layer["recipePath"]) if layer.get("recipePath") else {}
    recipe = recipe_doc.get("recipe") if isinstance(recipe_doc.get("recipe"), dict) else {}
    geometry_precision = next(
        (value for value in (layer.get("geometryPrecision"), recipe.get("precision")) if isinstance(value, str) and value in {"exact", "estimated", "unknown"}),
        "unknown",
    )
    completeness = next(
        (value for value in (layer.get("completeness"), recipe.get("completeness")) if isinstance(value, str) and value in {"complete", "incomplete", "unknown"}),
        "unknown",
    )
    overview_order = next(
        (value for value in (layer.get("overviewOrder"), layer.get("previewOrder"), recipe.get("overviewOrder"), recipe.get("previewOrder"))
         if type(value) is int and 0 <= value <= native_max_order),
        min(4, native_max_order),
    )
    precision_notes = [layer.get("precisionNote"), recipe.get("precisionJustification")]
    limitations = recipe.get("limitations")
    if isinstance(limitations, list):
        precision_notes.extend(limitations)
    precision_note = "; ".join(value.strip() for value in precision_notes if isinstance(value, str) and value.strip())
    if not precision_note:
        precision_note = "Source precision and completeness were not declared in the frozen layer recipe."
    precision_note += f" Precision: {geometry_precision}; completeness: {completeness}."
    access_availability = layer.get("accessAvailability")
    if not isinstance(access_availability, str) or access_availability not in {"geometry-only", "entrypoint-only", "tile-resolved", "unavailable"}:
        access_availability = "geometry-only"

    return {
        "layerId": layer["layerId"],
        "surveyId": layer["surveyId"],
        "releaseId": layer["releaseId"],
        "modality": layer["modality"],
        "coverageRole": layer["coverageRole"],
        "dataOrigin": layer["dataOrigin"],
        "sourceTier": layer["sourceTier"],
        "sourcePath": str(source_path),
        "productId": stable_product_id(layer["surveyId"], layer["releaseId"], layer["product"]),
        "product": layer["product"],
        "sourceId": layer["layerId"],
        "overviewOrder": overview_order,
        "coverageRevision": native_coverage_revision(cells),
        "indexRevision": None,
        "geometryPrecision": geometry_precision,
        "completeness": completeness,
        "precisionNote": precision_note,
        "accessAvailability": access_availability,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "mocEncoding": "NUNIQ",
        "maxOrder": native_max_order,
    }


def install_archive_immutable(source: Path, target: Path) -> bool:
    """Create a new package version without replacing an existing archive."""
    target.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256_bytes(source.read_bytes())
    if target.exists():
        if sha256_bytes(target.read_bytes()) != source_hash:
            raise RuntimeError(f"Refusing to replace different Resource Package bytes: {target}")
        return False

    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{target.name}.", dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
            with source.open("rb") as input_file:
                shutil.copyfileobj(input_file, handle)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, target)
            return True
        except FileExistsError:
            if sha256_bytes(target.read_bytes()) != source_hash:
                raise RuntimeError(f"Refusing to replace different Resource Package bytes: {target}")
            return False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def next_version(version: str) -> str:
    match = re.match(r"^3\.(\d+)\.0$", version)
    if not match:
        return "3.1.0"
    return f"3.{int(match.group(1)) + 1}.0"


def package_layers(registry: dict[str, Any], survey_id: str) -> list[dict[str, Any]]:
    layers = [
        layer
        for layer in registry["layers"]
        if layer.get("surveyId") == survey_id
        and layer.get("status") in {"acquired", "frozen-review-exception"}
        and layer.get("artifactPath")
    ]
    if not layers:
        raise RuntimeError(f"No acquired registry layers for {survey_id}")
    return sorted(layers, key=lambda layer: layer["layerId"])


def support_documents(
    package_id: str,
    package_version: str,
    survey_id: str,
    layers: list[dict[str, Any]],
    footprint: dict[str, Any],
    registry: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], str]:
    layer_keys = {(layer["surveyId"], layer["releaseId"], layer["product"]) for layer in layers}
    selected = [
        item for item in footprint.get("footprints", [])
        if (item.get("surveyId"), item.get("releaseId"), item.get("product")) in layer_keys
    ]
    if len(selected) != len(layers):
        raise RuntimeError(f"Footprint manifest does not cover every {survey_id} registry layer")
    footprint_doc = {
        "schemaVersion": footprint["schemaVersion"],
        "generatedAt": footprint["generatedAt"],
        "coordinateFrame": "ICRS",
        "nside": footprint["nside"],
        "footprints": selected,
    }
    provenance_layers: list[dict[str, Any]] = []
    for layer in layers:
        recipe = read_json(ROOT / layer["recipePath"]) if layer.get("recipePath") else {}
        snapshot = recipe.get("snapshot") if isinstance(recipe.get("snapshot"), dict) else {}
        provenance_layers.append({
            "layerId": layer["layerId"],
            "surveyId": layer["surveyId"],
            "releaseId": layer["releaseId"],
            "product": layer["product"],
            "modality": layer["modality"],
            "coverageRole": layer["coverageRole"],
            "dataOrigin": layer["dataOrigin"],
            "sourceTier": layer["sourceTier"],
            **({"sourceId": recipe["recipe"]["sourceId"]}
               if isinstance(recipe.get("recipe"), dict)
               and isinstance(recipe["recipe"].get("sourceId"), str)
               else {}),
            "method": recipe.get("mode"),
            "sourceUrl": recipe.get("sourceUrl"),
            "sourceSnapshot": {
                "sha256": snapshot.get("sha256"),
                "sizeBytes": snapshot.get("sizeBytes"),
            },
            **({"attributionUrl": recipe["recipe"]["attributionUrl"]}
               if isinstance(recipe.get("recipe"), dict)
               and isinstance(recipe["recipe"].get("attributionUrl"), str)
               else {}),
            "mocSha256": layer["expectedSha256"],
        })
    provenance_doc = {
        "schemaVersion": 1,
        "packageId": package_id,
        "packageVersion": package_version,
        "generatedAt": footprint["generatedAt"],
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "generator": {"name": "astro-survey-moc-core", "version": registry["coreVersion"]},
        "layers": provenance_layers,
    }
    readme = f"""# {survey_id.upper()} public coverage\n\nThis Resource Package v3 contains reviewed {survey_id} coverage layers from the Assets layer registry. The authoritative files are ICRS/NESTED FITS MOCs. `healpix/order4.json` and `healpix/order8.json` list the native MOC projected to those fixed NESTED orders; each file records per-layer precision and completeness, including layers omitted when their native maximum order is too low. The footprint JSON remains an order-4 display projection.\n\nUse the official release links for scientific files and queries. Assets publishes discovery geometry and verification metadata; it does not proxy the survey archive.\n"""
    return footprint_doc, provenance_doc, readme


def build_archive(
    support_root: Path,
    package_id: str,
    package_version: str,
    survey_id: str,
    layers: list[dict[str, Any]],
    footprint: dict[str, Any],
    registry: dict[str, Any],
    output: Path,
) -> None:
    footprint_doc, provenance_doc, readme = support_documents(
        package_id, package_version, survey_id, layers, footprint, registry,
    )
    support = support_root / f"{package_id}-{package_version}"
    support.mkdir(exist_ok=True)
    footprint_file = support / "footprints.json"
    provenance_file = support / "provenance.json"
    readme_file = support / "README.md"
    footprint_file.write_text(json.dumps(footprint_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    provenance_file.write_text(json.dumps(provenance_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    readme_file.write_text(readme, encoding="utf-8")
    spec = {
        "id": package_id,
        "version": package_version,
        "surveyId": survey_id,
        "footprintPath": str(footprint_file),
        "provenancePath": str(provenance_file),
        "readmePath": str(readme_file),
        "includeHealpixSidecars": True,
        "layers": [package_layer_spec(layer) for layer in layers],
    }
    result = build_resource_package(spec, output, base_dir=ROOT)
    if result.manifest["id"] != package_id or result.manifest["version"] != package_version:
        raise RuntimeError(f"Unexpected manifest identity for {package_id}")


def derive_catalog_entry(
    package_id: str,
    survey_id: str,
    survey: dict[str, Any],
    layers: list[dict[str, Any]],
    footprint_generated_at: str,
    version: str,
    archive: Path,
) -> dict[str, Any]:
    releases = sorted({layer["releaseId"] for layer in layers})
    release_by_id = {release["id"]: release for release in survey.get("releases", [])}
    release_labels: dict[str, str] = {}
    for release_id in releases:
        release = release_by_id.get(release_id)
        release_labels[release_id] = (release or {}).get("label") or release_id
    modalities = sorted({layer["modality"] for layer in layers})
    survey_modalities = sorted({
        modality
        for release_id in releases
        for modality in (release_by_id.get(release_id) or {}).get("modalities", [])
    })
    wavelengths = sorted({
        REGIME_WAVELENGTHS[modality]
        for modality in survey_modalities + modalities
        if modality in REGIME_WAVELENGTHS
    })
    if not wavelengths:
        wavelengths = ["optical"]
    product_types = sorted({
        COVERAGE_ROLE_PRODUCT_TYPES.get(layer["coverageRole"], "coverage-MOC")
        for layer in layers
    })
    authorities = sorted({
        SOURCE_TIER_AUTHORITIES.get(layer.get("sourceTier", ""), layer.get("sourceTier", ""))
        for layer in layers
    } - {""})
    sources = []
    for release_id in releases:
        release = release_by_id.get(release_id) or {}
        product = next(
            (item for item in release.get("products", []) if item.get("sourceUrl")),
            None,
        )
        if product is None:
            continue
        sources.append({
            "releaseId": release_id,
            "label": f"{survey['name']} {release_labels[release_id]} coverage source",
            "url": product["sourceUrl"],
            "authority": product.get("sourceLabel") or survey.get("mission") or survey["name"],
        })
    if not sources:
        raise RuntimeError(f"Unable to derive coverage sources for {survey_id}")
    return {
        "surveyId": survey_id,
        "name": survey["name"],
        "description": survey.get("description", f"{survey['name']} public coverage layers."),
        "modalities": modalities,
        "wavelengths": wavelengths,
        "productTypes": product_types,
        "facilities": [survey["mission"]] if survey.get("mission") else [],
        "coverageAuthorities": authorities,
        "accessModes": derive_access_modes(sources, []),
        "version": version,
        "sources": sources,
        "id": package_id,
        "releases": releases,
        "releaseLabels": release_labels,
        "archiveUrl": archive.name,
        "sizeBytes": archive.stat().st_size,
        "sha256": sha256_bytes(archive.read_bytes()),
        "updatedAt": footprint_generated_at,
    }


def main() -> None:
    os.environ.setdefault("SOURCE_DATE_EPOCH", str(SOURCE_DATE_EPOCH))
    registry = read_json(REGISTRY_PATH)
    footprint = read_json(FOOTPRINT_PATH)
    survey_catalog = read_json(SURVEY_CATALOG_PATH)
    catalog = read_json(CATALOG_PATH)
    catalog_by_id = {entry["id"]: entry for entry in catalog["packages"]}
    survey_by_id = {entry["id"]: entry for entry in survey_catalog["surveys"]}

    survey_ids = sorted({
        layer["surveyId"]
        for layer in registry["layers"]
        if layer.get("status") in {"acquired", "frozen-review-exception"}
        and layer.get("artifactPath")
        and layer["surveyId"] not in DENIED_SURVEYS
    })
    print(f"rebuilding {len(survey_ids)} surveys: {', '.join(survey_ids)}")

    generated: list[tuple[str, str, str, int, bool]] = []
    with tempfile.TemporaryDirectory(prefix="assets-package-support-") as temp_dir:
        support_root = Path(temp_dir)
        for survey_id in survey_ids:
            package_id = f"public-{survey_id}-footprints"
            survey = survey_by_id.get(survey_id)
            if survey is None:
                raise RuntimeError(f"Survey catalog lacks {survey_id}")
            layers = package_layers(registry, survey_id)
            existing = catalog_by_id.get(package_id)
            current_version = existing["version"] if existing else "3.0.0"
            probe_root = support_root / "probe"
            probe_root.mkdir(exist_ok=True)
            probe = probe_root / f"{package_id}-{current_version}.zip"
            try:
                build_archive(support_root, package_id, current_version, survey_id, layers, footprint, registry, probe)
            except PublicPrecisionError as error:
                action = "existing package retained" if existing else "no package created"
                print(f"deferred {package_id}: {error}; {action}")
                continue
            new_sha = sha256_bytes(probe.read_bytes())
            archive = ARTIFACT_ROOT / "packages" / f"{package_id}-{current_version}.zip"
            changed = existing is None or existing["sha256"] != new_sha
            if not changed:
                if not archive.is_file():
                    raise RuntimeError(f"Cataloged Resource Package is missing; refusing implicit recovery: {archive}")
                original = archive.read_bytes()
                if len(original) != existing["sizeBytes"] or sha256_bytes(original) != existing["sha256"]:
                    raise RuntimeError(f"Cataloged Resource Package integrity mismatch: {archive}")
                fresh = derive_catalog_entry(
                    package_id, survey_id, survey, layers, footprint["generatedAt"], current_version, archive,
                )
                if fresh["sha256"] != new_sha:
                    raise RuntimeError(f"Unchanged package probe differs from stored archive: {archive}")
                curated = existing.get("accessModes") or []
                existing.clear()
                existing.update(fresh)
                existing["accessModes"] = derive_access_modes(fresh["sources"], curated)
                catalog_by_id[package_id] = existing
                generated.append((package_id, current_version, new_sha, archive.stat().st_size, False))
                continue

            version = next_version(current_version) if existing else current_version
            archive = ARTIFACT_ROOT / "packages" / f"{package_id}-{version}.zip"
            version_probe = probe_root / f"{package_id}-{version}.zip"
            build_archive(support_root, package_id, version, survey_id, layers, footprint, registry, version_probe)
            install_archive_immutable(version_probe, archive)
            fresh = derive_catalog_entry(
                package_id, survey_id, survey, layers, footprint["generatedAt"], version, archive,
            )
            if existing is None:
                catalog["packages"].append(fresh)
                entry = fresh
            else:
                curated = existing.get("accessModes") or []
                existing.clear()
                existing.update(fresh)
                existing["accessModes"] = derive_access_modes(fresh["sources"], curated)
                entry = existing
            catalog_by_id[package_id] = entry
            generated.append((package_id, version, entry["sha256"], entry["sizeBytes"], True))

    catalog["packages"].sort(key=lambda entry: entry["id"])
    catalog["generatedAt"] = footprint["generatedAt"]
    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for package_id, version, archive_hash, size, changed_flag in generated:
        marker = "rebuilt" if changed_flag else "unchanged"
        print(f"{marker} {package_id}@{version}: {size} bytes sha256={archive_hash}")


if __name__ == "__main__":
    main()
