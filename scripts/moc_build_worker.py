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
from pathlib import Path
from typing import Any

from astro_survey_moc_core.core import canonical_cells, project_cells, read_moc_fits, validate_moc_fits, write_moc_fits


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
    args = parser.parse_args()
    source = Path(args.source)
    if args.command == "validate":
        result = validate(source)
    else:
        result = build(source, Path(args.output), args.max_order, args.query_order, args.preview_order)
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
