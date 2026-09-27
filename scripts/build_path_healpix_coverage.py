#!/usr/bin/env python3
"""Build exact coverage artifacts for a frozen path-HEALPix scan batch."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from astro_survey_moc_core.core import canonical_cells, project_cells, read_moc_fits, validate_moc_fits, write_moc_fits


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def same_strings(left: list[str], right: list[str]) -> bool:
    return len(left) == len(right) and sorted(left) == sorted(right)


def file_digest(path: Path) -> str:
    return digest(path.read_bytes())


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_immutable(path: Path, data: bytes) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"ref": path.name, "sha256": digest(data), "sizeBytes": len(data)}
    try:
        with path.open("xb") as target:
            target.write(data)
    except FileExistsError:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != len(data) or file_digest(path) != record["sha256"]:
            raise ValueError(f"Immutable evidence conflicts with existing file: {path}")
    return record


def copy_immutable(source: Path, target: Path) -> dict[str, Any]:
    return write_immutable(target, source.read_bytes())


def es_total(response: dict[str, Any]) -> int:
    total = response.get("hits", {}).get("total", 0)
    return int(total.get("value", 0) if isinstance(total, dict) else total)


def warehouse_scan(recipe: dict[str, Any]) -> dict[str, Any]:
    endpoint = os.environ.get("ASSETS_WAREHOUSE_ES_URL", "").rstrip("/")
    if not endpoint:
        raise ValueError("ASSETS_WAREHOUSE_ES_URL is required to confirm the frozen scan scope")
    recipe_data = recipe["recipe"]
    layer_id = f"assets-batch-{recipe['productId']}"
    scope_id = recipe_data["scopeId"]
    expected = int(recipe_data["expectedPartitions"])
    index = os.environ.get("ASSETS_WAREHOUSE_PARTITION_INDEX", "ast_partition_index_v1")
    query = {
        "size": expected + 2,
        "track_total_hits": True,
        "query": {"bool": {"filter": [
            {"term": {"layer_id": layer_id}},
            {"term": {"scope_id": scope_id}},
        ]}},
    }
    request = urllib.request.Request(
        f"{endpoint}/{index}/_search",
        data=json_bytes(query),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ValueError(f"Warehouse frozen-scope query failed: {error}") from error
    if result.get("timed_out") or result.get("_shards", {}).get("failed", 0):
        raise ValueError("Warehouse frozen-scope query returned partial results")
    hits = result.get("hits", {}).get("hits", [])
    if es_total(result) != expected + 1 or len(hits) != expected + 1:
        raise ValueError("Warehouse frozen scope does not contain exactly one scope lock plus all expected partitions")
    rows = [hit.get("_source", {}) for hit in hits]
    locks = [row for row in rows if row.get("state") == "SCOPE" and row.get("partition_id") == "scope-lock"]
    partitions = [row for row in rows if row not in locks]
    if len(locks) != 1 or len(partitions) != expected:
        raise ValueError("Warehouse frozen scope lock or partition count is invalid")
    lock = locks[0]
    expected_scope_sha = recipe_data["scopeSnapshotSha256"]
    if (lock.get("layer_id") != layer_id or lock.get("scope_id") != scope_id
            or lock.get("scope_snapshot_sha256") != expected_scope_sha
            or int(lock.get("expected_partition_count", -1)) != expected):
        raise ValueError("Warehouse frozen scope lock differs from the recipe")

    partition_ids: set[str] = set()
    scan_runs: set[str] = set()
    indexed_layers: set[str] = set()
    total_files = total_coverage = total_errors = 0
    receipt_partitions: list[dict[str, Any]] = []
    for row in partitions:
        partition_id = row.get("partition_id")
        run_id = row.get("active_scan_run_id")
        indexed_layer = row.get("active_layer_id")
        source_sha = row.get("source_snapshot_sha256")
        if (row.get("layer_id") != layer_id or row.get("scope_id") != scope_id
                or row.get("scope_snapshot_sha256") != expected_scope_sha
                or int(row.get("expected_partition_count", -1)) != expected
                or int(row.get("partition_version", -1)) != 1
                or row.get("state") != "ACTIVE"
                or not isinstance(partition_id, str) or not partition_id
                or not isinstance(run_id, str) or not run_id
                or not isinstance(indexed_layer, str) or not indexed_layer
                or not isinstance(source_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", source_sha)):
            raise ValueError("Warehouse scope contains a failed or invalid partition record")
        if partition_id in partition_ids or run_id in scan_runs or indexed_layer in indexed_layers:
            raise ValueError("Warehouse scope contains duplicate partition, run, or indexed-layer identities")
        partition_ids.add(partition_id)
        scan_runs.add(run_id)
        indexed_layers.add(indexed_layer)
        file_count = int(row.get("file_count", 0))
        coverage_count = int(row.get("coverage_count", 0))
        error_count = int(row.get("error_count", 0))
        total_files += file_count
        total_coverage += coverage_count
        total_errors += error_count
        receipt_partitions.append({
            "partitionId": partition_id,
            "indexedLayerId": indexed_layer,
            "scanRunId": run_id,
            "sourceSnapshotSha256": source_sha,
            "fileCount": file_count,
            "coverageCount": coverage_count,
            "errorCount": error_count,
            "updatedAt": row.get("updated_at"),
        })
    expected_files = int(recipe_data["fileCount"])
    expected_coverage = int(recipe_data["coverageCount"])
    if (total_files != expected_files or total_coverage != expected_coverage or total_errors != 0
            or len(scan_runs) != int(recipe_data["scanRunCount"])
            or len(partitions) != int(recipe_data["completedPartitions"])):
        raise ValueError("Warehouse committed partition totals differ from the locked scan batch")
    receipt_partitions.sort(key=lambda row: row["partitionId"])
    return {
        "schemaVersion": 1,
        "kind": "desi-path-healpix-warehouse-scan-receipt",
        "batchId": recipe_data["scanBatchId"],
        "scopeId": scope_id,
        "scopeSnapshotSha256": expected_scope_sha,
        "rosterSha256": recipe_data["rosterSha256"],
        "evidenceLayerId": layer_id,
        "expectedPartitions": expected,
        "committedPartitions": len(partitions),
        "scanRunCount": len(scan_runs),
        "sourceSnapshotCount": len(partitions),
        "fileCount": total_files,
        "coverageCount": total_coverage,
        "errorCount": total_errors,
        "partitions": receipt_partitions,
    }


def validate_inventory(source: dict[str, Any], cells_doc: dict[str, Any], recipe: dict[str, Any]) -> list[int]:
    recipe_data = recipe["recipe"]
    prefix = recipe_data["sourcePrefix"]
    if (source.get("schemaVersion") != 1 or source.get("kind") != "desi-path-healpix-file-manifest"
            or source.get("batchName") != recipe_data["scanBatchId"] or source.get("layerId") != recipe["layerId"]
            or source.get("productId") != recipe["productId"] or source.get("sourcePrefix") != prefix
            or source.get("order") != 6 or source.get("ordering") != "NESTED"):
        raise ValueError("Source manifest identity, path prefix, or order differs from the recipe")
    source_files = source.get("files")
    if not isinstance(source_files, list) or len(source_files) != int(recipe_data["fileCount"]):
        raise ValueError("Source manifest file count differs from the recipe")
    prefix_url = urlparse(prefix)
    prefix_segments = [part for part in prefix_url.path.split("/") if part]
    seen_uris: set[str] = set()
    pixels: list[int] = []
    for entry in source_files:
        if not isinstance(entry, dict):
            raise ValueError("Source manifest contains a non-object file row")
        uri = entry.get("uri")
        parsed = urlparse(uri) if isinstance(uri, str) else None
        if (parsed is None or parsed.scheme != "oss" or parsed.netloc != prefix_url.netloc
                or not uri.startswith(prefix) or parsed.query or parsed.fragment):
            raise ValueError("Source manifest URI is outside the locked OSS prefix")
        segments = [part for part in parsed.path.split("/") if part]
        if len(segments) != len(prefix_segments) + 3 or segments[:len(prefix_segments)] != prefix_segments:
            raise ValueError("Source manifest URI does not match the group/pixel path layout")
        try:
            group, pixel = int(segments[-3]), int(segments[-2])
        except ValueError as error:
            raise ValueError("Source manifest path contains a non-numeric group or pixel") from error
        match = re.fullmatch(r"redrock-main-bright-(\d+)\.fits(?:\.gz)?", segments[-1])
        if (match is None or int(match.group(1)) != pixel or group != pixel // 100
                or entry.get("order") != 6 or entry.get("ipix") != pixel or entry.get("group") != group
                or not isinstance(entry.get("sizeBytes"), int) or entry["sizeBytes"] < 0):
            raise ValueError("Source manifest filename, group, or order-6 pixel is inconsistent")
        if uri in seen_uris:
            raise ValueError("Source manifest contains duplicate file URIs")
        seen_uris.add(uri)
        pixels.append(pixel)
    pixels.sort()
    if len(set(pixels)) != len(pixels):
        raise ValueError("Source manifest assigns multiple files to the same order-6 pixel")
    if (source.get("fileCount") != len(pixels) or source.get("uniqueCellCount") != len(pixels)
            or source.get("frozenScope", {}).get("scopeSnapshotSha256") != recipe_data["scopeSnapshotSha256"]
            or source.get("frozenScope", {}).get("rosterSha256") != recipe_data["rosterSha256"]):
        raise ValueError("Source manifest frozen scope differs from the recipe")
    cells = cells_doc.get("cells")
    if (cells_doc.get("order") != 6 or cells_doc.get("ordering") != "NESTED"
            or not isinstance(cells, list) or any(not isinstance(cell, int) or cell < 0 or cell >= 12 * 4 ** 6 for cell in cells)):
        raise ValueError("Path cell input must be a valid NESTED order-6 pixel set")
    normalized_cells = sorted(set(cells))
    if normalized_cells != pixels or len(cells) != len(normalized_cells):
        raise ValueError("Order-6 cells do not exactly match the source file roster")
    return normalized_cells


def validate_coverage_contract(document: dict[str, Any]) -> None:
    required = {"schemaVersion", "layerId", "surveyId", "releaseId", "productId", "coordinateFrame", "ordering", "availableOrders", "overviewOrder", "maxOrder", "sourceSnapshot", "steps", "outputs", "scanBatchId", "scanRunIds"}
    if not required.issubset(document) or set(document) - (required | {"modality", "scanRunId"}):
        raise ValueError("Coverage evidence does not match the required coverage-evidence-v1 schema properties")
    if (document["schemaVersion"] != 1 or document["coordinateFrame"] != "ICRS" or document["ordering"] != "NESTED"
            or not isinstance(document["availableOrders"], list) or document["maxOrder"] != max(document["availableOrders"])):
        raise ValueError("Coverage evidence identity or order contract is invalid")
    snapshot = document["sourceSnapshot"]
    if (set(snapshot) not in ({"uri", "sha256"}, {"uri", "sha256", "sizeBytes"})
            or not re.fullmatch(r"[a-f0-9]{64}", snapshot["sha256"])
            or ("sizeBytes" in snapshot and (not isinstance(snapshot["sizeBytes"], int) or snapshot["sizeBytes"] < 0))):
        raise ValueError("Coverage evidence source snapshot is invalid")
    if not isinstance(document["scanRunIds"], list) or not document["scanRunIds"] or len(set(document["scanRunIds"])) != len(document["scanRunIds"]):
        raise ValueError("Coverage evidence scan run list is invalid")
    for key in ("moc", "query", "preview", "statistics", "manifest", "provenance"):
        item = document["outputs"].get(key)
        if not isinstance(item, dict) or set(item) != {"uri", "sha256", "sizeBytes", "deliveryClass"}:
            raise ValueError(f"Coverage evidence output {key} does not match the schema")
        if (not isinstance(item["uri"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
                or not isinstance(item["sizeBytes"], int) or item["sizeBytes"] < 0
                or item["deliveryClass"] not in {"runtime", "evidence"}):
            raise ValueError(f"Coverage evidence output {key} is invalid")
    if not isinstance(document["steps"], list) or not document["steps"]:
        raise ValueError("Coverage evidence steps are required")
    for step in document["steps"]:
        if (not isinstance(step, dict) or set(step) - {"id", "kind", "title", "implementationRef", "order", "evidenceRefs"}
                or not {"id", "kind", "title", "implementationRef", "order"}.issubset(step)
                or not isinstance(step["order"], int)):
            raise ValueError("Coverage evidence contains an invalid recipe step")


def build(source_path: Path, cells_path: Path, recipe_path: Path, output_dir: Path, evidence_root: Path) -> dict[str, Any]:
    source = read_json(source_path)
    cells_doc = read_json(cells_path)
    recipe = read_json(recipe_path)
    if (recipe.get("schemaVersion") != 1 or recipe.get("kind") != "coverage-recipe-lock"
            or recipe.get("mode") != "path-healpix" or recipe.get("coordinateFrame") != "ICRS"
            or recipe.get("ordering") != "NESTED"):
        raise ValueError("Unsupported path-HEALPix recipe lock")
    recipe_data = recipe.get("recipe", {})
    snapshot = recipe.get("snapshot", {})
    for path, expected_sha, expected_size, label in (
        (source_path, snapshot.get("sourceManifestSha256"), snapshot.get("sourceManifestSizeBytes"), "source manifest"),
        (cells_path, snapshot.get("pathCellsSha256"), snapshot.get("pathCellsSizeBytes"), "order-6 cells"),
    ):
        if file_digest(path) != expected_sha or path.stat().st_size != expected_size:
            raise ValueError(f"Locked {label} bytes changed")
    cells = validate_inventory(source, cells_doc, recipe)
    scan = warehouse_scan(recipe)
    if scan["scopeSnapshotSha256"] != source["frozenScope"]["scopeSnapshotSha256"]:
        raise ValueError("Warehouse scan scope does not match the source manifest")

    root = evidence_root.resolve()
    output = output_dir.resolve()
    if not output.is_relative_to(root):
        raise ValueError("Output directory must be under ASSETS_EVIDENCE_ROOT")
    output.mkdir(parents=True, exist_ok=True)
    inputs_dir = output
    source_record = copy_immutable(source_path, inputs_dir / "source-manifest.json")
    cells_record = copy_immutable(cells_path, inputs_dir / "path-healpix-cells-order6.json")
    scan_record = write_immutable(inputs_dir / "warehouse-scan-receipt.json", json_bytes(scan))

    moc_path = output / "moc.fits"
    moc_sha = write_moc_fits(moc_path, [(6, pixel) for pixel in cells], max_order=6)
    native_cells = canonical_cells(read_moc_fits(moc_path), max_order=6)
    validate_moc_fits(moc_path)
    available_orders = sorted({order for order, _ in native_cells})
    if not available_orders or max(available_orders) != 6 or list(project_cells(native_cells, 6)) != cells:
        raise ValueError("Generated native MOC does not preserve the exact source order-6 cells")
    query_pixels = list(project_cells(native_cells, 6))
    preview_pixels = list(project_cells(native_cells, 4))
    query_record = write_immutable(output / "query-order6.json", json_bytes({"schemaVersion": 1, "order": 6, "ordering": "NESTED", "pixels": query_pixels}))
    preview_record = write_immutable(output / "preview-order4.json", json_bytes({"schemaVersion": 1, "order": 4, "ordering": "NESTED", "pixels": preview_pixels}))
    moc_record = {"ref": "moc.fits", "sha256": moc_sha, "sizeBytes": moc_path.stat().st_size}
    statistics = {
        "schemaVersion": 1,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "cellCount": len(native_cells),
        "availableOrders": available_orders,
        "maxOrder": 6,
        "mocSha256": moc_sha,
        "queryOrder": 6,
        "queryPixelCount": len(query_pixels),
        "previewOrder": 4,
        "previewPixelCount": len(preview_pixels),
        "sourceManifestSha256": source_record["sha256"],
        "pathCellsSha256": cells_record["sha256"],
        "scopeSnapshotSha256": scan["scopeSnapshotSha256"],
    }
    statistics_record = write_immutable(output / "statistics.json", json_bytes(statistics))

    input_manifest = {
        "schemaVersion": 1,
        "kind": "desi-path-healpix-input-manifest",
        "layerId": recipe["layerId"],
        "productId": recipe["productId"],
        "surveyId": recipe["surveyId"],
        "releaseId": recipe["releaseId"],
        "modality": recipe["modality"],
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "completeness": "incomplete",
        "sourcePrefix": recipe_data["sourcePrefix"],
        "sourceManifest": {"ref": "source-manifest.json", "sha256": source_record["sha256"], "sizeBytes": source_record["sizeBytes"]},
        "pathCells": {"ref": "path-healpix-cells-order6.json", "sha256": cells_record["sha256"], "sizeBytes": cells_record["sizeBytes"], "cellCount": len(cells)},
        "recipeRef": "recipe.lock.json",
        "scan": {
            "batchId": scan["batchId"],
            "scopeId": scan["scopeId"],
            "phase": "SUCCEEDED",
            "order": 6,
            "groupSize": 100,
            "expectedPartitions": scan["expectedPartitions"],
            "completedPartitions": scan["committedPartitions"],
            "failedPartitions": scan["expectedPartitions"] - scan["committedPartitions"],
            "scanRunCount": scan["scanRunCount"],
            "sourceSnapshotCount": scan["sourceSnapshotCount"],
            "fileCount": scan["fileCount"],
            "coverageCount": scan["coverageCount"],
            "errorCount": scan["errorCount"],
            "rosterSha256": scan["rosterSha256"],
            "scopeSnapshotSha256": scan["scopeSnapshotSha256"],
            "scanRunIds": [partition["scanRunId"] for partition in scan["partitions"]],
        },
    }
    input_manifest_record = write_immutable(output / "input-manifest.json", json_bytes(input_manifest))
    manifest_rel = str((output / "input-manifest.json").relative_to(root))
    outputs = {"moc": moc_record, "query": query_record, "preview": preview_record, "statistics": statistics_record}
    build_manifest = {
        "schemaVersion": 1,
        "kind": "path-healpix-moc-provenance",
        "layerId": recipe["layerId"],
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "maxOrder": 6,
        "queryOrder": 6,
        "previewOrder": 4,
        "precision": "exact",
        "inputs": {
            "inputManifestSha256": input_manifest_record["sha256"],
            "sourceManifestSha256": source_record["sha256"],
            "pathCellsSha256": cells_record["sha256"],
        },
        "scan": {
            "batchId": scan["batchId"],
            "scopeId": scan["scopeId"],
            "rosterSha256": scan["rosterSha256"],
            "scopeSnapshotSha256": scan["scopeSnapshotSha256"],
            "expectedPartitions": scan["expectedPartitions"],
            "committedPartitions": scan["committedPartitions"],
            "scanRunCount": scan["scanRunCount"],
            "sourceSnapshotCount": scan["sourceSnapshotCount"],
            "fileCount": scan["fileCount"],
            "coverageCount": scan["coverageCount"],
            "errorCount": scan["errorCount"],
            "scanRunIds": input_manifest["scan"]["scanRunIds"],
        },
        "outputs": {key: {"ref": item["ref"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]} for key, item in outputs.items()},
    }
    manifest_record = write_immutable(output / "build-manifest.json", json_bytes(build_manifest))
    locked_recipe = copy.deepcopy(recipe)
    locked_recipe["availableOrders"] = available_orders
    locked_recipe["outputs"] = {
        "moc": {**moc_record, "order": 6, "precision": "exact"},
        "query": {**query_record, "order": 6, "precision": "exact"},
        "preview": {**preview_record, "order": 4, "precision": "estimated"},
        "statistics": {**statistics_record, "precision": "exact"},
        "manifest": {**manifest_record, "precision": "exact"},
    }
    recipe_record = write_immutable(output / "recipe.lock.json", json_bytes(locked_recipe))
    provenance = {
        "schemaVersion": 1,
        "kind": "path-healpix-provenance",
        "layerId": recipe["layerId"],
        "buildManifest": {"ref": "build-manifest.json", "sha256": manifest_record["sha256"], "sizeBytes": manifest_record["sizeBytes"]},
        "recipe": {"ref": "recipe.lock.json", "sha256": recipe_record["sha256"], "sizeBytes": recipe_record["sizeBytes"]},
        "scanReceipt": {"ref": "warehouse-scan-receipt.json", "sha256": scan_record["sha256"], "sizeBytes": scan_record["sizeBytes"]},
        "inputManifest": {"ref": manifest_rel, "sha256": input_manifest_record["sha256"], "sizeBytes": input_manifest_record["sizeBytes"]},
        "outputs": {**{key: {"ref": item["ref"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]} for key, item in outputs.items()},
                    "manifest": {"ref": "build-manifest.json", "sha256": manifest_record["sha256"], "sizeBytes": manifest_record["sizeBytes"]}},
    }
    provenance_record = write_immutable(output / "provenance.json", json_bytes(provenance))
    coverage_document = {
        "schemaVersion": 1,
        "layerId": recipe["layerId"],
        "surveyId": recipe["surveyId"],
        "releaseId": recipe["releaseId"],
        "productId": recipe["productId"],
        "modality": recipe["modality"],
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "availableOrders": available_orders,
        "overviewOrder": 4,
        "maxOrder": 6,
        "scanBatchId": scan["batchId"],
        "scanRunIds": input_manifest["scan"]["scanRunIds"],
        "sourceSnapshot": {"uri": f"warehouse-scan-scope:{scan['scopeId']}", "sha256": scan["scopeSnapshotSha256"]},
        "steps": [
            {"id": "input", "kind": "source-inventory", "title": "Frozen source manifest and cell set", "implementationRef": "Assets path-HEALPix input snapshot", "order": 0, "evidenceRefs": ["input-manifest.json", "source-manifest.json"]},
            {"id": "scan", "kind": "warehouse-scan", "title": "Committed Warehouse partitions", "implementationRef": "data-warehouse PathHealpixHandler", "order": 1, "evidenceRefs": ["warehouse-scan-receipt.json"]},
            {"id": "validate", "kind": "path-healpix-validation", "title": "Validate order-6 NESTED paths", "implementationRef": "scripts/build_path_healpix_coverage.py:validate_inventory", "order": 2, "evidenceRefs": ["source-manifest.json", "path-healpix-cells-order6.json"]},
            {"id": "moc", "kind": "native-moc", "title": "Write exact native MOC", "implementationRef": "astro_survey_moc_core.core:write_moc_fits", "order": 3, "evidenceRefs": ["recipe.lock.json"]},
            {"id": "project", "kind": "order-projection", "title": "Generate O6 query and O4 preview", "implementationRef": "astro_survey_moc_core.core:project_cells", "order": 4, "evidenceRefs": ["recipe.lock.json"]},
            {"id": "outputs", "kind": "locked-outputs", "title": "Hash all published outputs", "implementationRef": "scripts/build_path_healpix_coverage.py:write_immutable", "order": 5, "evidenceRefs": ["build-manifest.json", "provenance.json"]},
        ],
        "outputs": {
            "moc": {"uri": "moc.fits", "sha256": moc_record["sha256"], "sizeBytes": moc_record["sizeBytes"], "deliveryClass": "runtime"},
            "query": {"uri": "query-order6.json", "sha256": query_record["sha256"], "sizeBytes": query_record["sizeBytes"], "deliveryClass": "runtime"},
            "preview": {"uri": "preview-order4.json", "sha256": preview_record["sha256"], "sizeBytes": preview_record["sizeBytes"], "deliveryClass": "runtime"},
            "statistics": {"uri": "statistics.json", "sha256": statistics_record["sha256"], "sizeBytes": statistics_record["sizeBytes"], "deliveryClass": "runtime"},
            "manifest": {"uri": "build-manifest.json", "sha256": manifest_record["sha256"], "sizeBytes": manifest_record["sizeBytes"], "deliveryClass": "evidence"},
            "provenance": {"uri": "provenance.json", "sha256": provenance_record["sha256"], "sizeBytes": provenance_record["sizeBytes"], "deliveryClass": "evidence"},
        },
    }
    validate_coverage_contract(coverage_document)
    coverage_record = write_immutable(output / "coverage-evidence.json", json_bytes(coverage_document))
    evidence_files = [
        ("DESI path-HEALPix source manifest", "source-manifest.json", source_record),
        ("DESI order-6 path cell set", "path-healpix-cells-order6.json", cells_record),
        ("DESI recipe lock", "recipe.lock.json", recipe_record),
        ("Warehouse scan receipt", "warehouse-scan-receipt.json", scan_record),
        ("Coverage evidence contract", "coverage-evidence.json", coverage_record),
        ("Build provenance", "provenance.json", provenance_record),
    ]
    input_evidence = [{"label": label, "ref": str((output / ref).relative_to(root)), "sha256": record["sha256"], "sizeBytes": record["sizeBytes"]} for label, ref, record in evidence_files]
    output_files = {
        key: {"label": label, "ref": str((output / name).relative_to(root)), "sha256": record["sha256"], "sizeBytes": record["sizeBytes"]}
        for key, label, name, record in (
            ("moc", "Native order-6 MOC", "moc.fits", moc_record),
            ("query", "Order-6 query projection", "query-order6.json", query_record),
            ("preview", "Order-4 preview projection", "preview-order4.json", preview_record),
            ("statistics", "MOC statistics", "statistics.json", statistics_record),
            ("manifest", "Path-HEALPix MOC build manifest", "build-manifest.json", manifest_record),
        )
    }
    return {
        "source": {"url": recipe["sourceUrl"], "snapshotRef": manifest_rel, "snapshotSha256": input_manifest_record["sha256"], "sizeBytes": input_manifest_record["sizeBytes"]},
        "inputEvidence": input_evidence,
        "outputs": output_files,
        "coverageEvidence": {
            "evidenceKind": "published-moc",
            "precision": "exact",
            "completeness": "incomplete",
            "scienceFileScan": "partial",
            "sourceIdentity": "User-provided partial DESI DR1 bright-program OSS copy; order-6 redrock path partitions",
            "sourceSnapshotSha256": scan["scopeSnapshotSha256"],
            "summary": "Exact mapping from each indexed redrock file URI to its NESTED order-6 path partition. Scope is the user's partial OSS copy (904 files in 228 committed partitions), not a complete DESI DR1/BGS inventory; order-6 partitions are not Tiles and no FITS science arrays or BGS-only row filters were read.",
        },
        "scanSummary": {key: scan[key] for key in ("batchId", "scopeId", "expectedPartitions", "committedPartitions", "scanRunCount", "sourceSnapshotCount", "fileCount", "coverageCount", "errorCount")},
        "coverageEvidenceDocument": {"ref": str((output / "coverage-evidence.json").relative_to(root)), "sha256": coverage_record["sha256"], "sizeBytes": coverage_record["sizeBytes"]},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--cells", type=Path, required=True)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, default=Path(os.environ.get("ASSETS_EVIDENCE_ROOT", "/var/lib/assets-evidence")))
    args = parser.parse_args()
    print(json.dumps(build(args.source_manifest, args.cells, args.recipe, args.output_dir, args.evidence_root), ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    main()
