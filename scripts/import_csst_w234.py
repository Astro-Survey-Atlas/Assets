"""Import completed CSST W2/W3/W4 data-warehouse coverage results into Assets.

This importer reads the selected task sink's normalized documents, locks the
input snapshot, and lets Assets MOC Core produce the public artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from astro_survey_moc_core.core import build_layer
from astro_survey_moc_core.resource_package import build_resource_package

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = ROOT / "artifacts/public-survey-footprints"
CSST_ROOT = ARTIFACT_ROOT / "csst"
SOURCE_URL = "https://nadc.china-vo.org/data/"
OSS_ROOT = "http://oss-cn-hangzhou-zjy-d01-a.res.cloud.zhejianglab.com/data-and-computing/projects/CSST/shared-data/simulation-1000-w1-20250731/outputs_wide1000sqdeg"
PATTERN = re.compile(r"^CSST_MSC_MS_WIDE_.*\.fits$")
BANDS = ("W2", "W3", "W4")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def request_json(url: str, method: str = "GET", body: Any | None = None) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def fetch_docs(es_url: str, run_id: str) -> list[dict[str, Any]]:
    query = {
        "size": 1000,
        "_source": ["name", "coverage_cells", "spatial_status", "spatial_error", "wcs_summary", "size_bytes", "urn", "scan_run_id"],
        "query": {"bool": {"should": [
            {"term": {"scan_run_id.keyword": run_id}},
            {"term": {"scan_run_id": run_id}},
        ], "minimum_should_match": 1}},
    }
    page = request_json(f"{es_url}/astro_file_index_v1/_search?scroll=10m", "POST", query)
    scroll_id = page.get("_scroll_id")
    docs = [hit.get("_source", {}) for hit in page.get("hits", {}).get("hits", [])]
    while scroll_id and page.get("hits", {}).get("hits"):
        page = request_json(f"{es_url}/_search/scroll", "POST", {"scroll": "10m", "scroll_id": scroll_id})
        scroll_id = page.get("_scroll_id", scroll_id)
        docs.extend(hit.get("_source", {}) for hit in page.get("hits", {}).get("hits", []))
    if scroll_id:
        try:
            request_json(f"{es_url}/_search/scroll", "DELETE", {"scroll_id": scroll_id})
        except Exception:
            pass
    return docs


def import_band(es_url: str, band: str, run_id: str) -> dict[str, Any]:
    lower = band.lower()
    release_id = f"csst-sim-{lower}-20250731"
    product = f"{band} simulated wide-field images"
    docs = fetch_docs(es_url, run_id)
    if not docs:
        raise RuntimeError(f"No normalized Warehouse documents found for {run_id}")
    included: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    cells: set[tuple[int, int]] = set()
    for doc in docs:
        name = str(doc.get("name", ""))
        raw_cells = doc.get("coverage_cells") or []
        if not PATTERN.fullmatch(name) or not raw_cells:
            excluded.append(doc)
            continue
        for pixel in raw_cells:
            cells.add((8, int(pixel)))
        included.append(doc)
    if not cells or not included:
        raise RuntimeError(f"Warehouse run {run_id} has no usable FITS-WCS coverage cells")
    if any(doc.get("spatial_error") for doc in included):
        raise RuntimeError(f"Warehouse run {run_id} contains WCS errors in included documents")

    normalized_path = CSST_ROOT / f"{lower}-normalized-scan.json"
    normalized = {
        "schemaVersion": 1,
        "surveyId": "csst",
        "releaseId": release_id,
        "product": product,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "order": 8,
        "coverageRole": "image_extent",
        "dataOrigin": "simulated",
        "sourceTier": "user_file_derived",
        "scannerRunId": run_id,
        "fileNamePattern": PATTERN.pattern,
        "matchedFiles": len(docs),
        "includedFiles": len(included),
        "excludedFiles": len(excluded),
        "cells": [{"order": order, "ipix": pixel} for order, pixel in sorted(cells)],
    }
    write_json(normalized_path, normalized)
    snapshot = {"sha256": sha(normalized_path), "sizeBytes": normalized_path.stat().st_size}
    spec = {
        "layerId": f"csst-sim-{lower}-image-extent",
        "surveyId": "csst",
        "releaseId": release_id,
        "product": product,
        "modality": "imaging",
        "sourceUrl": f"{OSS_ROOT}/{band}_Phot",
        "mode": "nested-healpix",
        "coverageRole": "image_extent",
        "dataOrigin": "simulated",
        "sourceTier": "user_file_derived",
        "input": str(normalized_path.relative_to(ROOT)).replace("\\", "/"),
        "maxOrder": 8,
        "queryOrder": 8,
        "previewOrder": 4,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "recipe": {"values": "ipix", "order": 8, "scannerMode": "fits-wcs", "fileNamePattern": PATTERN.pattern, "scannerRunId": run_id},
        "snapshot": snapshot,
    }
    spec_path = ROOT / "src/layers/recipes" / f"csst-sim-{lower}-image-extent.lock.json"
    write_json(spec_path, spec)
    output = ARTIFACT_ROOT / "layers" / f"csst-sim-{lower}-image-extent"
    built = build_layer(spec, output, base_dir=ROOT)
    stats = json.loads((output / "statistics.json").read_text(encoding="utf-8"))
    # Keep scanner counts with the scientific MOC statistics for catalog
    # provenance and downstream release manifests.
    stats = {
        **stats,
        "matchedFiles": len(docs),
        "processedFiles": len(included),
        "excludedFiles": len(excluded),
        "coverageDocuments": len(cells),
        "scannerRunId": run_id,
    }
    snapshot_record = {
        "schemaVersion": 1,
        "surveyId": "csst", "releaseId": release_id, "product": product,
        "status": "succeeded", "scannerRunId": run_id,
        "sourcePrefix": f"s3://data-and-computing/{OSS_ROOT.split('/data-and-computing/', 1)[1]}/{band}_Phot/",
        "fileNamePattern": PATTERN.pattern, "coordinateFrame": "ICRS", "ordering": "NESTED",
        "coverageRole": "image_extent", "dataOrigin": "simulated", "sourceTier": "user_file_derived",
        "maxOrder": 8, "queryOrder": 8, "previewOrder": 4,
        "matchedFiles": len(docs), "processedFiles": len(included), "excludedFiles": len(excluded),
        "coverageDocuments": len(cells), "wcsErrors": sum(bool(doc.get("spatial_error")) for doc in docs),
        "mocSha256": built.sha256,
    }
    write_json(CSST_ROOT / f"{lower}-coverage-job-snapshot.json", snapshot_record)
    write_json(CSST_ROOT / f"{lower}-run-statistics.json", stats)
    write_json(CSST_ROOT / f"{lower}-sample-report.json", {"scannerRunId": run_id, "fileNamePattern": PATTERN.pattern, "samples": [{"name": doc.get("name"), "wcsSummary": doc.get("wcs_summary")} for doc in included[:5]], "excludedSamples": [{"name": doc.get("name"), "error": doc.get("spatial_error")} for doc in excluded[:5]]})
    write_json(CSST_ROOT / f"{lower}-provenance.json", {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "scannerRunId": run_id, "sourcePrefix": snapshot_record["sourcePrefix"], "fileNamePattern": PATTERN.pattern, "matchedFiles": len(docs), "includedFiles": len(included), "excludedFiles": len(excluded), "wcsErrors": snapshot_record["wcsErrors"], "coordinateFrame": "ICRS", "ordering": "NESTED", "coverageRole": "image_extent", "dataOrigin": "simulated", "sourceTier": "user_file_derived", "input": {"path": normalized_path.name, **snapshot}, "outputs": {"moc": {"path": built.moc_path.name, "sha256": sha(built.moc_path)}, "query": {"path": built.query_path.name, "sha256": sha(built.query_path)}, "preview": {"path": built.preview_path.name, "sha256": sha(built.preview_path)}, "statistics": {"path": built.statistics_path.name, "sha256": sha(built.statistics_path)}}})
    return {"band": band, "releaseId": release_id, "product": product, "runId": run_id, "spec": spec, "specPath": str(spec_path.relative_to(ROOT)).replace("\\", "/"), "output": str(output.relative_to(ROOT)).replace("\\", "/"), "mocSha256": built.sha256, "preview": json.loads(built.preview_path.read_text(encoding="utf-8"))["pixels"], "stats": stats}


def update_catalogs(results: list[dict[str, Any]]) -> None:
    survey_path = ROOT / "src/surveys/survey-catalog.json"
    survey = json.loads(survey_path.read_text(encoding="utf-8"))
    for result in results:
        release = next(item for item in next(item for item in survey["surveys"] if item["id"] == "csst")["releases"] if item["id"] == result["releaseId"])
        product = release["products"][0]
        product["status"] = "acquired"
        product.pop("reason", None)
        product.pop("manualStep", None)
        product["description"] = f"{result['band']}_Phot FITS-WCS 图像范围由 data-warehouse coverage task 扫描并由 Assets MOC Core 锁定；实际覆盖面积 {result['stats']['areaDeg2']:.6f} 平方度。"
    write_json(survey_path, survey)

    sources_path = ARTIFACT_ROOT / "sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8"))
    for result in results:
        release = next(item for item in sources["releases"] if item["releaseId"] == result["releaseId"] and item["surveyId"] == "csst")
        product = release["products"][0]
        product["status"] = "acquired"
        product.pop("reason", None)
        product.pop("manualStep", None)
        product["notes"] = f"data-warehouse run {result['runId']} matched {result['stats']['matchedFiles']} files and processed {result['stats']['processedFiles']} FITS-WCS documents; Core MOC area {result['stats']['areaDeg2']:.6f} deg2."
    write_json(sources_path, sources)

    footprint_path = ROOT / "src/footprints/survey-footprints.json"
    footprint = json.loads(footprint_path.read_text(encoding="utf-8"))
    existing = {(item["surveyId"], item["releaseId"], item["product"]) for item in footprint["footprints"]}
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for result in results:
        key = ("csst", result["releaseId"], result["product"])
        record = {"surveyId": "csst", "releaseId": result["releaseId"], "product": result["product"], "label": f"CSST {result['band']} simulated WIDE-image WCS coverage", "nside": 16, "pixels": result["preview"], "quality": "moc", "sourceUrl": f"{OSS_ROOT}/{result['band']}_Phot", "retrievedAt": now, "notes": f"FITS-WCS coverage from data-warehouse run {result['runId']}; Core authoritative MOC at order 8, projected to NSIDE 16 for display."}
        footprint["footprints"] = [item for item in footprint["footprints"] if (item["surveyId"], item["releaseId"], item["product"]) != key] + [record]
    footprint["footprints"].sort(key=lambda item: (item["surveyId"], item["releaseId"], item["product"]))
    write_json(footprint_path, footprint)
    write_json(ARTIFACT_ROOT / "normalized/survey-footprints.json", footprint)

    registry_path = ROOT / "src/layers/layer-registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    for result in results:
        layer = next(item for item in registry["layers"] if item["layerId"] == result["spec"]["layerId"])
        layer.update({"maxOrder": 8, "status": "acquired", "recipePath": result["specPath"], "artifactPath": f"{result['output']}/{result['spec']['layerId']}.moc.fits", "expectedSha256": result["mocSha256"]})
        layer.pop("pendingReason", None)
        layer.pop("plannedMode", None)
    write_json(registry_path, registry)
    plan_path = ROOT / "src/layers/public-build-plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    for result in results:
        build = {"spec": result["specPath"], "output": result["output"], "expectedSha256": result["mocSha256"]}
        plan["builds"] = [item for item in plan["builds"] if item["spec"] != build["spec"]] + [build]
    plan["builds"].sort(key=lambda item: item["spec"])
    write_json(plan_path, plan)

    package_footprints = {"schemaVersion": 1, "generatedAt": now, "coordinateFrame": "ICRS", "nside": 16, "footprints": [item for item in footprint["footprints"] if item["surveyId"] == "csst"]}
    package_fp_path = CSST_ROOT / "package-footprints.json"
    write_json(package_fp_path, package_footprints)
    package_provenance = {"schemaVersion": 1, "generatedAt": now, "surveyId": "csst", "releases": [{"releaseId": result["releaseId"], "scannerRunId": result["runId"], "mocSha256": result["mocSha256"], "statistics": result["stats"]} for result in results]}
    package_prov_path = CSST_ROOT / "package-provenance.json"
    write_json(package_prov_path, package_provenance)
    readme_path = CSST_ROOT / "package-README.md"
    readme_path.write_text("CSST W1/W2/W3/W4 simulation image-extent Resource Package v3. Coverage is produced by data-warehouse coverage tasks using the task's configured source and sink, then finalized by Assets MOC Core as ICRS/NESTED MOCs. It is not a formal CSST survey footprint or catalog-object distribution.\n", encoding="utf-8")
    package_spec = {"id": "public-csst-footprints", "version": "3.0.0", "surveyId": "csst", "footprintPath": str(package_fp_path.relative_to(ROOT)), "provenancePath": str(package_prov_path.relative_to(ROOT)), "readmePath": str(readme_path.relative_to(ROOT)), "layers": []}
    for result in results:
        package_spec["layers"].append({"layerId": result["spec"]["layerId"], "surveyId": "csst", "coverageRole": "image_extent", "dataOrigin": "simulated", "sourceTier": "user_file_derived", "modality": "imaging", "releaseId": result["releaseId"], "sourcePath": f"{result['output']}/{result['spec']['layerId']}.moc.fits"})
    w1 = ARTIFACT_ROOT / "csst/csst-w1-image-extent-order8.fits"
    package_spec["layers"].append({"layerId": "csst-sim-w1-image-extent", "surveyId": "csst", "coverageRole": "image_extent", "dataOrigin": "simulated", "sourceTier": "user_file_derived", "modality": "imaging", "releaseId": "csst-sim-w1-20250731", "sourcePath": str(w1.relative_to(ROOT))})
    package_archive = ARTIFACT_ROOT / "packages/public-csst-footprints-3.0.0.zip"
    built_package = build_resource_package(package_spec, package_archive, base_dir=ROOT)
    catalog_path = ARTIFACT_ROOT / "packages/catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    entry = next(item for item in catalog["packages"] if item["id"] == "public-csst-footprints")
    entry.update({"name": "CSST W1-W4 Simulation", "description": "CSST W1/W2/W3/W4 simulated wide-field image-extent MOCs generated from data-warehouse FITS-WCS coverage tasks and finalized by Assets MOC Core.", "coverageAuthorities": ["data-warehouse-reviewed-wcs"], "accessModes": ["task-configured source"], "releases": ["csst-sim-w1-20250731", *[result["releaseId"] for result in results]], "releaseLabels": {f"csst-sim-{band.lower()}-20250731": f"CSST {band} Simulation 2025-07-31" for band in BANDS}, "sources": [{"releaseId": f"csst-sim-{band.lower()}-20250731", "label": f"CSST {band} simulated WIDE-image WCS coverage", "url": f"{OSS_ROOT}/{band}_Phot", "authority": "data-warehouse coverage task and Assets MOC Core"} for band in BANDS], "sizeBytes": package_archive.stat().st_size, "sha256": built_package.archive_sha256, "updatedAt": now})
    write_json(catalog_path, catalog)
    print(json.dumps({"results": results, "package": {"archive": str(package_archive), "sha256": built_package.archive_sha256, "sizeBytes": package_archive.stat().st_size}}, ensure_ascii=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--es-url", default="http://127.0.0.1:19200")
    parser.add_argument("--run", action="append", required=True, metavar="BAND=RUN_ID")
    args = parser.parse_args()
    runs = {item.split("=", 1)[0].upper(): item.split("=", 1)[1] for item in args.run}
    if set(runs) != set(BANDS):
        raise SystemExit("--run must provide W2, W3 and W4")
    results = [import_band(args.es_url.rstrip("/"), band, runs[band]) for band in BANDS]
    update_catalogs(results)


if __name__ == "__main__":
    main()
