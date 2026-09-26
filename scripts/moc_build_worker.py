#!/usr/bin/env python3
"""Small, isolated MOC build worker used by Assets.

The worker deliberately imports the published MOC-Core-SDK contract instead of
reimplementing FITS/NUNIQ parsing. Network acquisition happens in the Node
service; this process only reads the SHA-256-locked local snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any

from astro_survey_moc_core.contract import normalize_spec
from astro_survey_moc_core.core import build_layer, canonical_cells, project_cells, read_moc_fits, validate_moc_fits, write_moc_fits


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def write_json(path: Path, value: Any) -> dict[str, Any]:
    encoded = (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(encoded)
    return {"path": str(path), "sha256": hashlib.sha256(encoded).hexdigest(), "sizeBytes": len(encoded)}


def validate(source: Path) -> dict[str, Any]:
    cells = validate_moc_fits(source)
    orders = sorted({order for order, _ in cells})
    return {"valid": True, "cells": len(cells), "availableOrders": orders, "maxOrder": max(orders) if orders else 0}


def build(source: Path, output: Path, max_order: int, query_order: int, preview_order: int) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    cells = canonical_cells(read_moc_fits(source), max_order=max_order)
    moc = output / "moc.fits"
    moc_sha = write_moc_fits(moc, cells, max_order=max_order)
    query = write_json(output / f"query-order{query_order}.json", {"schemaVersion": 1, "order": query_order, "ordering": "NESTED", "pixels": project_cells(cells, query_order)})
    preview = write_json(output / f"preview-order{preview_order}.json", {"schemaVersion": 1, "order": preview_order, "ordering": "NESTED", "pixels": project_cells(cells, preview_order)})
    stats = write_json(output / "statistics.json", {
        "schemaVersion": 1,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "cellCount": len(cells),
        "availableOrders": sorted({order for order, _ in cells}),
        "queryOrder": query_order,
        "queryPixelCount": len(project_cells(cells, query_order)),
        "previewOrder": preview_order,
        "previewPixelCount": len(project_cells(cells, preview_order)),
        "sourceSha256": digest(source),
    })
    return {
        "valid": True,
        "cells": len(cells),
        "availableOrders": sorted({order for order, _ in cells}),
        "maxOrder": max((order for order, _ in cells), default=0),
        "moc": {"path": str(moc), "sha256": moc_sha, "sizeBytes": moc.stat().st_size},
        "query": query,
        "preview": preview,
        "statistics": stats,
    }


def build_regions(spec_path: Path, output: Path) -> dict[str, Any]:
    if spec_path.is_symlink():
        raise ValueError("Region recipe lock must be a regular local file")
    spec_path = spec_path.resolve()
    if not spec_path.is_file():
        raise ValueError("Region recipe lock must be a regular local file")
    raw_spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if not isinstance(raw_spec, dict):
        raise ValueError("Region recipe lock must contain a JSON object")
    spec = normalize_spec(raw_spec)
    if spec.mode != "regions" or spec.coordinate_frame != "ICRS" or spec.ordering != "NESTED":
        raise ValueError("Region recipe must declare regions mode with ICRS/NESTED coordinates")
    if spec.max_order < 4:
        raise ValueError("Region recipe maxOrder must be at least the public minimum order 4")
    if spec.query_order != 8 or spec.preview_order != 4:
        raise ValueError("Region recipe must use the supported query order 8 and preview order 4")
    recipe = raw_spec.get("recipe")
    if not isinstance(recipe, dict) or recipe.get("format") != "ds9" or recipe.get("geometryField") != "s_region" or recipe.get("sourceSyntax") != "STC-S POLYGON":
        raise ValueError("Region recipe must lock MAST s_region STC-S POLYGON as DS9")
    if (
        recipe.get("precision") != "estimated"
        or recipe.get("completeness") != "incomplete"
        or recipe.get("scienceFileScan") != "not-scanned"
        or not recipe.get("observationId")
    ):
        raise ValueError("Region recipe must identify one estimated, incomplete, not-scanned MAST observation")
    input_ref = spec.input
    if not isinstance(input_ref, str) or not input_ref or "\\" in input_ref:
        raise ValueError("Region recipe input must be a safe relative local path")
    input_path = PurePosixPath(input_ref)
    if input_path.is_absolute() or any(part in {"", ".", ".."} for part in input_ref.split("/")):
        raise ValueError("Region recipe input must be a safe relative local path")
    input_root = spec_path.parent.resolve()
    local_input = input_root.joinpath(*input_path.parts)
    parent = local_input
    while parent != input_root:
        if parent.is_symlink():
            raise ValueError("Region recipe input must not follow symbolic links")
        parent = parent.parent
    if not local_input.is_file() or not local_input.resolve().is_relative_to(input_root):
        raise ValueError("Region recipe input must be a local file under the recipe directory")
    snapshot_sha = spec.snapshot.get("sha256")
    if not isinstance(snapshot_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", snapshot_sha):
        raise ValueError("Region recipe must lock its local input with a SHA-256")

    result = build_layer(spec, output, base_dir=spec_path.parent, rebuild=True)
    available_orders = sorted({order for order, _ in result.cells})
    actual_max_order = max(available_orders, default=0)
    if not available_orders:
        raise ValueError("Region recipe produced no MOC cells")
    if actual_max_order < 4:
        raise ValueError(f"Region MOC native maxOrder {actual_max_order} is below the public minimum order 4")
    if actual_max_order < spec.query_order:
        raise ValueError(f"Region MOC native maxOrder {actual_max_order} is below locked queryOrder {spec.query_order}")
    if actual_max_order > spec.max_order:
        raise ValueError(f"Region MOC native maxOrder {actual_max_order} exceeds locked maxOrder {spec.max_order}")

    def file_record(path: Path, order: int | None = None) -> dict[str, Any]:
        body_digest = digest(path)
        record = {"path": str(path), "sha256": body_digest, "sizeBytes": path.stat().st_size}
        if order is not None:
            record["order"] = order
        return record

    return {
        "valid": True,
        "cells": len(result.cells),
        "availableOrders": available_orders,
        "maxOrder": actual_max_order,
        "requestedMaxOrder": spec.max_order,
        "moc": file_record(result.moc_path),
        "query": file_record(result.query_path, spec.query_order),
        "preview": file_record(result.preview_path, spec.preview_order),
        "statistics": file_record(result.statistics_path),
        "provenance": file_record(result.provenance_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--source", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--source", required=True)
    build_parser.add_argument("--output", required=True)
    build_parser.add_argument("--max-order", type=int, default=12)
    build_parser.add_argument("--query-order", type=int, default=8)
    build_parser.add_argument("--preview-order", type=int, default=4)
    regions_parser = sub.add_parser("build-regions")
    regions_parser.add_argument("--spec", required=True)
    regions_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "validate":
        result = validate(Path(args.source))
    elif args.command == "build":
        result = build(Path(args.source), Path(args.output), args.max_order, args.query_order, args.preview_order)
    else:
        result = build_regions(Path(args.spec), Path(args.output))
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
