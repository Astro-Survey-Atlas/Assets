"""Deterministic MOC generation and FITS I/O.

The authoritative representation is a canonical set of ``(order, ipix)``
NESTED cells. FITS output is written as an IVOA NUNIQ binary table. Optional
third-party packages are imported only by the input adapters that need them.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import stat
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

import numpy as np
from astropy.io import fits

from .contract import CORE_VERSION, CoverageSpec, normalize_spec

Cell = tuple[int, int]


@dataclass(frozen=True)
class BuildResult:
    layer_id: str
    moc_path: Path
    query_path: Path
    preview_path: Path
    statistics_path: Path
    provenance_path: Path
    sha256: str
    cells: tuple[Cell, ...]


def uniq_for_cell(order: int, ipix: int) -> int:
    if order < 0 or order > 29 or ipix < 0 or ipix >= 12 * (4**order):
        raise ValueError(f"Invalid NESTED cell: order={order}, ipix={ipix}")
    return 4 * (4**order) + ipix


def cell_for_uniq(uniq: int) -> Cell:
    if not isinstance(uniq, (int, np.integer)) or int(uniq) < 4:
        raise ValueError(f"Invalid NUNIQ value: {uniq}")
    value = int(uniq)
    order = 0
    base = 4
    while order < 29 and value >= base * 4:
        base *= 4
        order += 1
    ipix = value - base
    if ipix < 0 or ipix >= 12 * (4**order):
        raise ValueError(f"Invalid NUNIQ value: {uniq}")
    return order, ipix


def canonical_cells(cells: Iterable[Cell], max_order: int | None = None) -> tuple[Cell, ...]:
    """Deduplicate and normalize mixed-order cells deterministically.

    A parent removes all descendants. Four complete siblings collapse to their
    parent repeatedly, which makes shard merge and single-pass builds identical.
    """

    normalized: set[Cell] = set()
    for order, ipix in cells:
        order = int(order)
        ipix = int(ipix)
        if max_order is not None and order > max_order:
            raise ValueError(f"Input cell order {order} exceeds maxOrder {max_order}")
        uniq_for_cell(order, ipix)
        normalized.add((order, ipix))
    changed = True
    while changed:
        changed = False
        for order, ipix in sorted(normalized, key=lambda value: (value[0], value[1])):
            if any((parent_order, ipix >> (2 * (order - parent_order))) in normalized for parent_order in range(order)):
                normalized.discard((order, ipix))
                changed = True
        for order in range(1, 30):
            groups: dict[Cell, set[int]] = {}
            for child_order, child_ipix in normalized:
                if child_order != order:
                    continue
                parent = (order - 1, child_ipix >> 2)
                groups.setdefault(parent, set()).add(child_ipix & 3)
            for parent, quadrants in groups.items():
                if quadrants == {0, 1, 2, 3} and (max_order is None or parent[0] <= max_order):
                    normalized.difference_update((order, (parent[1] << 2) | quadrant) for quadrant in range(4))
                    normalized.add(parent)
                    changed = True
    return tuple(sorted(normalized, key=lambda value: (value[0], value[1])))


def project_cells(cells: Iterable[Cell], order: int) -> tuple[int, ...]:
    """Project a MOC to one fixed order, expanding coarse cells inclusively."""

    if order < 0 or order > 29:
        raise ValueError("Projection order must be between 0 and 29")
    projected: set[int] = set()
    for source_order, ipix in canonical_cells(cells):
        if source_order == order:
            projected.add(ipix)
        elif source_order > order:
            projected.add(ipix >> (2 * (source_order - order)))
        else:
            factor = 4 ** (order - source_order)
            projected.update((ipix * factor) + offset for offset in range(factor))
    return tuple(sorted(projected))


def write_moc_fits(path: str | Path, cells: Iterable[Cell], *, max_order: int | None = None, overwrite: bool = True) -> str:
    """Write a deterministic IVOA FITS MOC and return its SHA-256."""

    canonical = canonical_cells(cells, max_order=max_order)
    if not canonical:
        highest = 0 if max_order is None else max_order
    else:
        highest = max(order for order, _ in canonical)
    values = np.asarray([uniq_for_cell(order, ipix) for order, ipix in canonical], dtype=np.int64)
    primary = fits.PrimaryHDU()
    primary.header["EXTEND"] = True
    columns = fits.ColDefs([fits.Column(name="UNIQ", format="1K", array=values)])
    table = fits.BinTableHDU.from_columns(columns, name="MOC")
    table.header["MOCVERS"] = "2.0"
    table.header["ORDERING"] = "NUNIQ"
    table.header["COORDSYS"] = "C"
    table.header["MOCDIM"] = "SPACE"
    table.header["MOCORD_S"] = highest
    table.header["MOCORDER"] = highest
    table.header["MOCTOOL"] = "AstroSurveyAtlasAssets"
    hdul = fits.HDUList([primary, table])
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    hdul.writeto(target, overwrite=overwrite, checksum=False, output_verify="silentfix")
    return hashlib.sha256(target.read_bytes()).hexdigest()


def read_moc_fits(path: str | Path) -> tuple[Cell, ...]:
    """Read the first MOC/NUNIQ table from any FITS HDU."""

    with fits.open(path, memmap=False, lazy_load_hdus=False) as hdul:
        for hdu in hdul:
            names = getattr(hdu.data, "names", None)
            if names and "UNIQ" in {str(name).upper() for name in names}:
                column = next(name for name in names if str(name).upper() == "UNIQ")
                return canonical_cells(cell_for_uniq(value) for value in hdu.data[column])
    raise ValueError(f"No UNIQ column found in FITS MOC: {path}")


def validate_moc_fits(path: str | Path) -> tuple[Cell, ...]:
    """Validate the authoritative IVOA/ICRS/NUNIQ FITS contract."""

    with fits.open(path, memmap=False, lazy_load_hdus=False) as hdul:
        for hdu in hdul:
            names = getattr(hdu.data, "names", None)
            if not names or "UNIQ" not in {str(name).upper() for name in names}:
                continue
            if hdu.header.get("ORDERING") != "NUNIQ":
                raise ValueError("FITS MOC ORDERING must be NUNIQ")
            if hdu.header.get("COORDSYS") != "C":
                raise ValueError("FITS MOC COORDSYS must be ICRS celestial (C)")
            if str(hdu.header.get("MOCVERS", "")) != "2.0":
                raise ValueError("FITS MOC must declare MOCVERS 2.0")
            if hdu.header.get("MOCDIM") != "SPACE":
                raise ValueError("FITS MOC must declare MOCDIM SPACE")
            return read_moc_fits(path)
    raise ValueError(f"No UNIQ column found in FITS MOC: {path}")


def _healpix(order: int):
    try:
        from astropy_healpix import HEALPix
        from astropy.coordinates import ICRS
        return HEALPix(nside=2**order, order="nested", frame=ICRS())
    except ImportError as error:  # pragma: no cover - exercised in minimal installs
        raise RuntimeError("This input mode requires astropy-healpix") from error


def _skycoord(ra: Sequence[float], dec: Sequence[float]):
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    return SkyCoord(np.asarray(ra) * u.deg, np.asarray(dec) * u.deg, frame="icrs")


def _cells_from_radec(points: Sequence[tuple[float, float]], order: int) -> set[Cell]:
    if not points:
        return set()
    hp = _healpix(order)
    coords = _skycoord([point[0] for point in points], [point[1] for point in points])
    pixels = np.asarray(hp.skycoord_to_healpix(coords), dtype=np.int64).reshape(-1)
    return {(order, int(pixel)) for pixel in pixels}


def _cells_from_radec_circles(points: Sequence[tuple[float, float]], order: int, radius_deg: float) -> set[Cell]:
    if radius_deg <= 0:
        return _cells_from_radec(points, order)
    result: set[Cell] = set()
    from mocpy import MOC
    import astropy.units as u
    for ra, dec in points:
        moc = MOC.from_cone(lon=ra * u.deg, lat=dec * u.deg, radius=radius_deg * u.deg, max_depth=order)
        result.update((order, int(pixel)) for pixel in moc.flatten())
    return result


def _read_json_or_csv(path: Path) -> Any:
    if path.suffix.lower() in {".json", ".jsonl"}:
        if path.suffix.lower() == ".jsonl":
            return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return json.loads(path.read_text(encoding="utf-8"))
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _rows_from_input(path: Path, recipe: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if path.suffix.lower() in {".fits", ".fit", ".fz"}:
        with fits.open(path, memmap=False) as hdul:
            for hdu in hdul:
                if getattr(hdu.data, "names", None):
                    requested_hdu = recipe.get("hdu")
                    if requested_hdu is not None and hdu.name.upper() != str(requested_hdu).upper():
                        continue
                    names = {str(name).upper(): name for name in hdu.data.names}
                    ra_keys = (str(recipe["raColumn"]).upper(),) if "raColumn" in recipe else ("RA", "RA_OBJ", "RA_PNT", "TARGET_RA")
                    dec_keys = (str(recipe["decColumn"]).upper(),) if "decColumn" in recipe else ("DEC", "DEC_OBJ", "DEC_PNT", "TARGET_DEC")
                    nexp_key = str(recipe.get("nexpColumn", "NEXP")).upper()
                    ra_name = next((names[key] for key in ra_keys if key in names), None)
                    dec_name = next((names[key] for key in dec_keys if key in names), None)
                    if ra_name and dec_name:
                        rows = []
                        for row in hdu.data:
                            rows.append({"ra": float(row[ra_name]), "dec": float(row[dec_name]), **({"nexp": int(row[names[nexp_key]])} if nexp_key in names else {})})
                        return rows
        raise ValueError(f"No RA/DEC table found in {path}")
    value = _read_json_or_csv(path)
    if isinstance(value, Mapping):
        for key in ("rows", "objects", "points", "pixels", "cells"):
            if key in value:
                return value[key]
    if not isinstance(value, list):
        raise ValueError("Input must be a list or an object containing rows/points/cells")
    return value


def _parse_points(rows: Iterable[Any], recipe: Mapping[str, Any]) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for row in rows:
        if isinstance(row, Mapping):
            ra_key = str(recipe.get("raColumn", "ra"))
            dec_key = str(recipe.get("decColumn", "dec"))
            ra = row.get(ra_key, row.get(ra_key.upper(), row.get("ra", row.get("RA", row.get("RA_OBJ")))))
            dec = row.get(dec_key, row.get(dec_key.upper(), row.get("dec", row.get("DEC", row.get("DEC_OBJ")))))
        else:
            ra, dec = row[0], row[1]
        if ra is None or dec is None:
            continue
        ra_float, dec_float = float(ra), float(dec)
        if not math.isfinite(ra_float) or not math.isfinite(dec_float) or not -90 <= dec_float <= 90:
            raise ValueError(f"Invalid ICRS coordinate: {ra}, {dec}")
        points.append((ra_float % 360, dec_float))
    return points


def _cells_from_nested(spec: CoverageSpec, path: Path) -> set[Cell]:
    if path.suffix.lower() in {".fits", ".fit", ".fz"} or path.name.lower().endswith((".fits.gz", ".fit.gz")):
        # Native NUNIQ FITS is accepted as a nested-healpix snapshot only after
        # the same IVOA/ICRS contract validation applied to generated MOCs.
        return set(validate_moc_fits(path))
    value = _read_json_or_csv(path)
    if isinstance(value, Mapping):
        order = value.get("order", value.get("maxOrder", spec.max_order))
        values = value.get("uniq", value.get("cells", value.get("pixels", [])))
        if value.get("nside") is not None:
            order = round(math.log2(int(value["nside"])))
    else:
        order, values = spec.recipe.get("order", spec.max_order), value
    result: set[Cell] = set()
    for item in values:
        if isinstance(item, Mapping):
            if "uniq" in item:
                result.add(cell_for_uniq(int(item["uniq"])))
            else:
                pixel = item.get("ipix", item.get("pixel"))
                if pixel is None:
                    raise ValueError("Nested HEALPix cell requires ipix or pixel")
                result.add((int(item.get("order", order)), int(pixel)))
        elif spec.recipe.get("values", "ipix") == "uniq":
            result.add(cell_for_uniq(int(item)))
        else:
            result.add((int(order), int(item)))
    return result


def _wcs_headers(path: Path) -> list[fits.Header]:
    if path.suffix.lower() in {".json", ".jsonl"}:
        value = _read_json_or_csv(path)
        if isinstance(value, Mapping):
            value = value.get("headers", value.get("header", value))
        records = value if isinstance(value, list) else [value]
        if not all(isinstance(record, Mapping) for record in records):
            raise ValueError("Parsed WCS input must contain header objects")
        return [fits.Header(record) for record in records]
    with fits.open(path, memmap=False) as hdul:
        return [hdu.header.copy() for hdu in hdul]


def _polygon_cells(vertices: Any, order: int) -> set[Cell]:
    try:
        from mocpy import MOC
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("Polygon inputs require mocpy") from error
    moc = MOC.from_polygon_skycoord(vertices, max_depth=order)
    return {(order, int(pixel)) for pixel in moc.flatten()}


def _cells_from_fits_wcs(spec: CoverageSpec, path: Path) -> set[Cell]:
    from astropy.wcs import WCS
    result: set[Cell] = set()
    found = False
    for hdu_index, header in enumerate(_wcs_headers(path)):
        if "NAXIS1" not in header or "NAXIS2" not in header:
            continue
        ctype = f"{header.get('CTYPE1', '')} {header.get('CTYPE2', '')}".upper()
        if not any(token in ctype for token in ("RA", "DEC", "GLON", "GLAT", "ELON", "ELAT")):
            continue
        found = True
        try:
            wcs = WCS(header, naxis=2).celestial
            if not wcs.has_celestial:
                raise ValueError("header has no celestial axes")
            width, height = int(header["NAXIS1"]), int(header["NAXIS2"])
            if width < 1 or height < 1:
                raise ValueError("image dimensions must be positive")
            samples = max(4, int(spec.recipe.get("edgeSamples", 64)))
            x_forward = np.linspace(-0.5, width - 0.5, samples)
            y_forward = np.linspace(-0.5, height - 0.5, samples)
            edge = (
                [(x, -0.5) for x in x_forward]
                + [(width - 0.5, y) for y in y_forward[1:]]
                + [(x, height - 0.5) for x in x_forward[-2::-1]]
                + [(-0.5, y) for y in y_forward[-2:0:-1]]
            )
            sky = wcs.pixel_to_world(np.asarray([point[0] for point in edge]), np.asarray([point[1] for point in edge])).icrs
            result.update(_polygon_cells(sky, spec.max_order))
        except Exception as error:
            raise ValueError(f"Invalid WCS in HDU {hdu_index} of {path}: {error}") from error
    if not found:
        raise ValueError(f"No two-dimensional celestial WCS found in {path}")
    return result


def _cells_from_regions(spec: CoverageSpec, path: Path) -> set[Cell]:
    try:
        from regions import Regions
        from mocpy import MOC
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("This input mode requires regions and mocpy") from error
    result: set[Cell] = set()
    region_sets: list[Any]
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            requested = spec.recipe.get("members")
            requested_members = set(requested) if isinstance(requested, list) else None
            seen: set[str] = set()
            region_sets = []
            for info in infos:
                member = info.filename
                member_path = Path(member)
                mode = info.external_attr >> 16
                if member_path.name != member or member in seen or info.is_dir() or stat.S_ISLNK(mode) or info.file_size > 16 * 1024 * 1024:
                    raise ValueError(f"Unsafe regions archive member: {member}")
                seen.add(member)
                if requested_members is not None and member not in requested_members:
                    continue
                if not member.lower().endswith(".reg"):
                    raise ValueError(f"Unsupported regions archive member: {member}")
                region_sets.append(Regions.parse(archive.read(member).decode("utf-8"), format=spec.recipe.get("format", "ds9")))
            if requested_members is not None and seen.intersection(requested_members) != requested_members:
                raise ValueError("Regions archive is missing a locked member")
            if not region_sets:
                raise ValueError("Regions archive contains no selected regions")
    else:
        region_sets = [Regions.read(path, format=spec.recipe.get("format", "ds9"))]
    for region in (region for region_set in region_sets for region in region_set):
        moc = MOC.from_astropy_regions(region, max_depth=spec.max_order)
        result.update((spec.max_order, int(pixel)) for pixel in moc.flatten())
    return result


def _input_cells(spec: CoverageSpec, base_dir: Path) -> set[Cell]:
    if not spec.input:
        raise ValueError("A local input path is required")
    path = (base_dir / spec.input).resolve() if not Path(spec.input).is_absolute() else Path(spec.input)
    if not path.is_file():
        raise FileNotFoundError(path)
    if spec.mode == "nested-healpix":
        return _cells_from_nested(spec, path)
    if spec.mode == "fits-wcs":
        return _cells_from_fits_wcs(spec, path)
    if spec.mode in {"catalog-radec", "tile-table"}:
        rows = _rows_from_input(path, spec.recipe)
        if spec.mode == "tile-table" and "nexpMin" in spec.recipe:
            n_exp_min = int(spec.recipe["nexpMin"])
            filtered: list[Mapping[str, Any]] = []
            nexp_key = str(spec.recipe.get("nexpColumn", "NEXP"))
            for row in rows:
                value = row.get("nexp", row.get(nexp_key, row.get(nexp_key.upper())))
                if value is None:
                    raise ValueError(f"tile-table recipe requires {nexp_key}")
                if int(value) >= n_exp_min:
                    filtered.append(row)
            rows = filtered
        points = _parse_points(rows, spec.recipe)
        radius = float(spec.recipe.get("radiusDeg", 0))
        return _cells_from_radec_circles(points, spec.max_order, radius)
    if spec.mode == "regions":
        return _cells_from_regions(spec, path)
    raise ValueError(f"Unsupported coverage mode: {spec.mode}")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _source_date_epoch() -> int | None:
    raw = os.environ.get("SOURCE_DATE_EPOCH")
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError("SOURCE_DATE_EPOCH must be an integer") from error
    if value < 0:
        raise ValueError("SOURCE_DATE_EPOCH must be non-negative")
    return value


def _generated_at() -> str:
    epoch = _source_date_epoch()
    when = datetime.fromtimestamp(epoch, tz=timezone.utc) if epoch is not None else datetime.now(timezone.utc)
    return when.isoformat().replace("+00:00", "Z")


def _redact_url(value: str | None) -> str | None:
    if not value:
        return value
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    hostname = parsed.hostname or ""
    if parsed.port is not None:
        hostname = f"{hostname}:{parsed.port}"
    return urlunsplit((parsed.scheme, hostname, parsed.path, "", ""))


def _redact_provenance(value: Any, key: str = "") -> Any:
    lowered = key.lower()
    if any(token in lowered for token in ("password", "credential", "authorization", "accesskey", "sessiontoken", "secret")):
        return "[REDACTED]"
    if isinstance(value, str) and lowered.endswith("url"):
        return _redact_url(value)
    if isinstance(value, Mapping):
        return {child_key: _redact_provenance(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact_provenance(child, key) for child in value]
    return value


def _file_record(path: Path) -> dict[str, Any]:
    return {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "sizeBytes": path.stat().st_size}


def build_layer(raw_spec: Mapping[str, Any] | CoverageSpec, output_dir: str | Path, *, base_dir: str | Path = ".", rebuild: bool = False) -> BuildResult:
    """Build authoritative MOC, fixed-order projections and redacted provenance."""

    spec = raw_spec if isinstance(raw_spec, CoverageSpec) else normalize_spec(raw_spec)
    spec.validate()
    if rebuild and spec.snapshot.get("sha256") is None:
        raise ValueError("rebuild requires a locked snapshot with sha256")
    input_path = ((Path(base_dir) / spec.input).resolve() if spec.input and not Path(spec.input).is_absolute() else Path(spec.input)) if spec.input else None
    input_digest = hashlib.sha256(input_path.read_bytes()).hexdigest() if input_path else None
    if rebuild and input_digest != spec.snapshot.get("sha256"):
        raise ValueError("Locked snapshot SHA-256 does not match the local input")
    if rebuild and spec.snapshot.get("sizeBytes") is not None and input_path and input_path.stat().st_size != spec.snapshot["sizeBytes"]:
        raise ValueError("Locked snapshot size does not match the local input")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    cells = canonical_cells(_input_cells(spec, Path(base_dir)), max_order=spec.max_order)
    moc_path = out / f"{spec.layer_id}.moc.fits"
    sha256 = write_moc_fits(moc_path, cells, max_order=spec.max_order)
    query_path = out / "query-order8.json"
    preview_path = out / "preview-order4.json"
    query_path.write_bytes(canonical_json({"schemaVersion": 1, "order": spec.query_order, "ordering": "NESTED", "pixels": project_cells(cells, spec.query_order)}) + b"\n")
    preview_path.write_bytes(canonical_json({"schemaVersion": 1, "order": spec.preview_order, "ordering": "NESTED", "pixels": project_cells(cells, spec.preview_order)}) + b"\n")
    statistics_path = out / "statistics.json"
    statistics_path.write_bytes(canonical_json({
        "schemaVersion": 1,
        "cellCount": len(cells),
        "maxOrder": max((cell[0] for cell in cells), default=spec.max_order),
        "queryPixelCount": len(project_cells(cells, spec.query_order)),
        "previewPixelCount": len(project_cells(cells, spec.preview_order)),
        "areaDeg2": sum((4 * math.pi / (12 * (4**order))) * ((180 / math.pi) ** 2) for order, _ in cells),
        "mocSha256": sha256,
    }) + b"\n")
    provenance_path = out / "provenance.json"
    provenance_path.write_bytes(canonical_json({
        "schemaVersion": 1,
        "generatedAt": _generated_at(),
        "coreVersion": CORE_VERSION,
        "layerId": spec.layer_id,
        "coverageRole": spec.coverage_role,
        "dataOrigin": spec.data_origin,
        "sourceTier": spec.source_tier,
        "coordinateFrame": spec.coordinate_frame,
        "ordering": spec.ordering,
        "recipe": _redact_provenance(dict(spec.recipe)),
        "snapshot": _redact_provenance(dict(spec.snapshot)),
        "sourceUrl": _redact_url(spec.source_url),
        "input": {"path": input_path.name, "sha256": input_digest} if input_path else None,
        "outputs": {
            "moc": _file_record(moc_path),
            "query": _file_record(query_path),
            "preview": _file_record(preview_path),
            "statistics": _file_record(statistics_path),
        },
    }) + b"\n")
    return BuildResult(spec.layer_id, moc_path, query_path, preview_path, statistics_path, provenance_path, sha256, cells)
