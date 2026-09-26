#!/usr/bin/env python3
"""Convert selected MAST CAOM s_region polygons into MOC-Core region inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path, PurePosixPath
from typing import Any


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def relative_evidence_ref(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or not value or "\\" in value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("source-ref must be a safe relative evidence path")
    return path.as_posix()


def safe_identifier(value: str, field: str, max_length: int = 63) -> str:
    if len(value) > max_length or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", value):
        raise ValueError(f"{field} must be a lower-case letters, digits, and hyphens identifier of at most {max_length} characters")
    return value


def required_text(value: Any, field: str, max_length: int = 256) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ValueError(f"MAST {field} is missing or invalid")
    result = str(value).strip()
    if not result or len(result) > max_length or any(ord(character) < 32 or ord(character) == 127 for character in result):
        raise ValueError(f"MAST {field} is missing or invalid")
    return result


def parse_stcs_polygons(value: str) -> list[list[str]]:
    tokens = value.split()
    polygons: list[list[str]] = []
    cursor = 0
    while cursor < len(tokens):
        if tokens[cursor].upper() != "POLYGON":
            raise ValueError(f"Unsupported s_region token: {tokens[cursor]}")
        cursor += 1
        coordinates: list[str] = []
        while cursor < len(tokens) and tokens[cursor].upper() != "POLYGON":
            coordinate = tokens[cursor]
            number = float(coordinate)
            if not math.isfinite(number):
                raise ValueError("s_region contains a non-finite coordinate")
            coordinates.append(coordinate)
            cursor += 1
        if len(coordinates) < 8 or len(coordinates) % 2:
            raise ValueError("Each s_region polygon must contain at least three closed ICRS vertices")
        points = list(zip(coordinates[::2], coordinates[1::2]))
        if points[0] != points[-1] or len(set(points[:-1])) < 3:
            raise ValueError("Each s_region polygon must be explicitly closed with three distinct vertices")
        for ra, dec in points:
            if not 0 <= float(ra) <= 360 or not -90 <= float(dec) <= 90:
                raise ValueError("s_region coordinate is outside ICRS bounds")
        polygons.append(coordinates)
    if not polygons:
        raise ValueError("s_region contains no POLYGON geometry")
    return polygons


def rows_from_caom(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("Tables"), list) or not payload["Tables"]:
        raise ValueError("Input is not a MAST CAOM table response")
    table = payload["Tables"][0]
    columns = table.get("Columns")
    rows = table.get("Rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        raise ValueError("MAST CAOM response is missing table columns or rows")
    names = [column.get("dataIndex") for column in columns if isinstance(column, dict)]
    required = {"obsid", "obs_collection", "dataproduct_type", "dataRights", "proposal_id", "target_name", "instrument_name", "filters", "s_region", "t_min", "t_max"}
    if len(names) != len(columns) or len(set(names)) != len(names) or not required.issubset(names):
        raise ValueError("MAST CAOM response does not contain the locked observation fields")
    result: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != len(names):
            raise ValueError("MAST CAOM response contains a malformed row")
        record = dict(zip(names, row))
        if str(record["obs_collection"]).upper() != "HST" or str(record["dataproduct_type"]).lower() != "image" or str(record["dataRights"]).upper() != "PUBLIC":
            raise ValueError("MAST CAOM snapshot contains a row outside the locked public HST image policy")
        result.append(record)
    return result


def ds9_text(observation_id: str, polygons: list[list[str]]) -> str:
    lines = [
        "# Region file format: DS9 version 4.1",
        "icrs",
        f"# MAST CAOM observation {observation_id}",
    ]
    lines.extend(f"polygon({','.join(polygon)})" for polygon in polygons)
    return "\n".join(lines) + "\n"


def make_spec(
    row: dict[str, Any],
    region_name: str,
    region_body: bytes,
    source_ref: str,
    source_sha: str,
    source_size: int,
    max_order: int,
    survey_id: str,
    release_id: str,
    layer_id_prefix: str,
    product_label_prefix: str,
) -> dict[str, Any]:
    observation_id = required_text(row["obsid"], "observation ID", 128)
    if not re.fullmatch(r"[0-9]+", observation_id):
        raise ValueError("MAST observation ID must contain decimal digits only")
    proposal_id = required_text(row["proposal_id"], "proposal ID", 128)
    target_name = required_text(row["target_name"], "target name")
    instrument = required_text(row["instrument_name"], "instrument", 128)
    filters = required_text(row["filters"], "filters")
    t_min = float(row["t_min"])
    t_max = float(row["t_max"])
    if not math.isfinite(t_min) or not math.isfinite(t_max) or t_max < t_min:
        raise ValueError("MAST observation has invalid time bounds")
    layer_id = safe_identifier(f"{layer_id_prefix}-{observation_id}", "layerId")
    product = f"{product_label_prefix} {instrument} {filters} observation {observation_id}"
    if len(product) > 256:
        raise ValueError("Generated product label exceeds 256 characters")
    return {
        "schemaVersion": 1,
        "layerId": layer_id,
        "surveyId": survey_id,
        "releaseId": release_id,
        "product": product,
        "modality": "imaging",
        "mode": "regions",
        "coverageRole": "image_extent",
        "dataOrigin": "observed",
        "sourceTier": "official_geometry",
        "sourceUrl": "https://mast.stsci.edu/api/v0/invoke",
        "input": region_name,
        "maxOrder": max_order,
        "queryOrder": 8,
        "previewOrder": 4,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "recipe": {
            "format": "ds9",
            "geometryField": "s_region",
            "sourceSyntax": "STC-S POLYGON",
            "observationId": observation_id,
            "proposalId": proposal_id,
            "targetName": target_name,
            "instrument": instrument,
            "filters": filters,
            "tMinMjd": t_min,
            "tMaxMjd": t_max,
            "sourceSnapshotRef": source_ref,
            "sourceSnapshotSha256": source_sha,
            "sourceSnapshotSizeBytes": source_size,
            "precision": "estimated",
            "precisionJustification": "Official MAST CAOM s_region polygons are rasterized by MOC-Core/MOCpy into ICRS NESTED cells up to the locked maximum order; output statistics and the staged record preserve the decoded native maximum order.",
            "completeness": "incomplete",
            "completenessDescription": "One explicitly selected public HST observation; not a complete HST archive inventory.",
            "scienceFileScan": "not-scanned",
        },
        "snapshot": {
            "sha256": digest(region_body),
            "sizeBytes": len(region_body),
            "sourceSnapshotSha256": source_sha,
            "sourceSnapshotSizeBytes": source_size,
            "sourceSnapshotRef": source_ref,
        },
    }


def build_inputs(
    input_path: Path,
    output_dir: Path,
    source_ref: str,
    observation_ids: list[str],
    max_order: int,
    survey_id: str,
    release_id: str,
    layer_id_prefix: str,
    product_label_prefix: str,
) -> dict[str, Any]:
    source_ref = relative_evidence_ref(source_ref)
    if survey_id != "hst":
        raise ValueError("survey-id must be hst for the MAST HST observation importer")
    release_id = safe_identifier(release_id, "release-id")
    layer_id_prefix = safe_identifier(layer_id_prefix, "layer-id-prefix", 53)
    product_label_prefix = product_label_prefix.strip()
    if not product_label_prefix or len(product_label_prefix) > 128 or any(ord(character) < 32 or ord(character) == 127 for character in product_label_prefix):
        raise ValueError("product-label-prefix must contain 1 to 128 printable characters")
    source_body = input_path.read_bytes()
    source_sha = digest(source_body)
    payload = json.loads(source_body)
    rows = rows_from_caom(payload)
    by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        if str(row["obs_collection"]).upper() != "HST":
            raise ValueError("Selected source rows must belong to the HST collection")
        observation_id = required_text(row["obsid"], "observation ID", 128)
        if not re.fullmatch(r"[0-9]+", observation_id):
            raise ValueError("MAST observation ID must contain decimal digits only")
        if observation_id in by_id:
            raise ValueError(f"Duplicate MAST observation row: {observation_id}")
        by_id[observation_id] = row
    if len(set(observation_ids)) != len(observation_ids):
        raise ValueError("Observation IDs must be unique")
    missing = sorted(set(observation_ids) - set(by_id))
    if missing:
        raise ValueError(f"Selected observation IDs are missing from the locked response: {', '.join(missing)}")
    output_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for observation_id in observation_ids:
        row = by_id[observation_id]
        polygons = parse_stcs_polygons(str(row["s_region"]))
        region_body = ds9_text(observation_id, polygons).encode("utf-8")
        region_name = f"obs-{observation_id}.reg"
        region_path = output_dir / region_name
        region_path.write_bytes(region_body)
        spec = make_spec(
            row,
            region_name,
            region_body,
            source_ref,
            source_sha,
            len(source_body),
            max_order,
            survey_id,
            release_id,
            layer_id_prefix,
            product_label_prefix,
        )
        spec_path = output_dir / f"obs-{observation_id}.lock.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        records.append({
            "observationId": observation_id,
            "layerId": spec["layerId"],
            "product": spec["product"],
            "proposalId": spec["recipe"]["proposalId"],
            "targetName": spec["recipe"]["targetName"],
            "instrument": spec["recipe"]["instrument"],
            "filters": spec["recipe"]["filters"],
            "tMinMjd": spec["recipe"]["tMinMjd"],
            "tMaxMjd": spec["recipe"]["tMaxMjd"],
            "polygonCount": len(polygons),
            "precision": "estimated",
            "completeness": "incomplete",
            "scienceFileScan": "not-scanned",
            "sourceSnapshot": {"ref": source_ref, "sha256": source_sha, "sizeBytes": len(source_body)},
            "regionInput": {"ref": region_name, "sha256": digest(region_body), "sizeBytes": len(region_body)},
            "recipe": spec_path.name,
        })
    manifest = {
        "schemaVersion": 1,
        "kind": "mast-hst-observation-region-inputs",
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "maxOrder": max_order,
        "sourceSnapshot": {"ref": source_ref, "sha256": source_sha, "sizeBytes": len(source_body)},
        "selectedObservationIds": observation_ids,
        "surveyId": survey_id,
        "releaseId": release_id,
        "layerIdPrefix": layer_id_prefix,
        "productLabelPrefix": product_label_prefix,
        "precision": "estimated",
        "completeness": "incomplete",
        "scienceFileScan": "not-scanned",
        "completenessDescription": "Explicit MAST observation subset only; not complete for the HST archive.",
        "observations": records,
    }
    (output_dir / "input-manifest.json").write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--obsid", action="append", required=True)
    parser.add_argument("--survey-id", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--layer-id-prefix", required=True)
    parser.add_argument("--product-label-prefix", required=True)
    parser.add_argument("--max-order", type=int, default=10)
    args = parser.parse_args()
    if args.max_order < 4 or args.max_order > 10:
        parser.error("max-order must be between the public minimum order 4 and Core default order 10")
    try:
        print(json.dumps(build_inputs(
            args.input,
            args.output_dir,
            args.source_ref,
            args.obsid,
            args.max_order,
            args.survey_id,
            args.release_id,
            args.layer_id_prefix,
            args.product_label_prefix,
        ), ensure_ascii=True, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
