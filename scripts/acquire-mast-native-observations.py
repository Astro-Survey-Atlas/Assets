#!/usr/bin/env python3
"""Acquire public CAOM observation metadata, never scientific products.

The output is staged evidence for the authenticated native-unit import workflow.
This command neither mutates managed indexes nor downloads any access URI.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import time
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


SOURCE_URL = "https://mast.stsci.edu/api/v0/invoke"
SERVICE = "Mast.Caom.Filtered"
USER_AGENT = (
    "Mozilla/5.0 (compatible; Astro-Survey-Atlas-Assets/1.0; "
    "+https://astro.assets.dev.72602.space/)"
)
COLUMNS = [
    "obsid", "obs_id", "objID", "obs_collection", "provenance_name", "project",
    "dataproduct_type", "calib_level", "proposal_id", "target_name",
    "instrument_name", "filters", "t_min", "t_max", "s_region", "dataRights",
    "dataURL", "s_ra", "s_dec", "jpegURL",
]
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def mast_request(request: dict) -> tuple[bytes, dict]:
    body = urlencode({"request": json.dumps(request, separators=(",", ":"))}).encode()
    started = time.monotonic()
    with urlopen(Request(SOURCE_URL, data=body, headers={
        "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
    }), timeout=180) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("MAST metadata response exceeded the 16 MiB bound")
        if response.status != 200:
            raise ValueError(f"MAST metadata returned HTTP {response.status}")
        receipt = {
            "capturedAt": now(), "url": SOURCE_URL, "request": request,
            "httpMethod": "POST", "httpStatus": response.status,
            "tlsValidation": "CA-chain-and-hostname-and-time",
            "userAgent": USER_AGENT, "sha256": sha256(raw), "sizeBytes": len(raw),
            "elapsedSeconds": time.monotonic() - started,
        }
    return raw, receipt


def parsed_page(raw: bytes, page: int, page_size: int) -> dict:
    value = json.loads(raw)
    paging, rows = value.get("paging", {}), value.get("data")
    if value.get("status") != "COMPLETE" or not isinstance(rows, list):
        raise ValueError(f"MAST page {page} incomplete: {value.get('msg', '')}")
    if (paging.get("page") != page or paging.get("pageSize") != page_size
            or paging.get("rows") != len(rows)
            or not isinstance(paging.get("rowsFiltered"), int)
            or not isinstance(paging.get("pagesFiltered"), int)):
        raise ValueError(f"MAST page {page} inconsistent pagination")
    return value


def fetch_page(directory: Path, request: dict, request_hash: str) -> tuple[dict, list[dict]]:
    page = request["page"]
    filename = f"page-{page:06d}.json.gz"
    page_path, receipt_path = directory / filename, directory / f"page-{page:06d}.receipt.json"
    value = None
    if page_path.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_bytes())
        if receipt.get("queryHash") == request_hash and receipt.get("request") == request:
            raw = gzip.decompress(page_path.read_bytes())
            if sha256(raw) == receipt.get("sha256"):
                value = parsed_page(raw, page, request["pagesize"])
    if value is None:
        for attempt in range(1, 4):
            try:
                raw, receipt = mast_request(request)
                value = parsed_page(raw, page, request["pagesize"])
                receipt["queryHash"] = request_hash
                page_path.write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))
                receipt_path.write_bytes(json_bytes(receipt))
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(min(attempt, 2))
    documents = []
    for path in [page_path, receipt_path]:
        data = path.read_bytes()
        documents.append({"ref": path.name, "url": SOURCE_URL,
                          "sha256": sha256(data), "sizeBytes": len(data)})
    return value, documents


def observation_access_uris(row: dict) -> list[dict]:
    request = {"service": "Mast.Caom.Products", "params": {"obsid": str(row["obsid"])},
               "format": "json", "pagesize": 2000, "page": 1}
    uris = [{"url": SOURCE_URL + "?" + urlencode({"request": json.dumps(request, separators=(",", ":"))}),
             "fileName": f"MAST-observation-{row['obsid']}-products.json"}]
    data_uri = row.get("dataURL")
    if isinstance(data_uri, str) and data_uri:
        parsed = urlparse(data_uri)
        if parsed.scheme in ("http", "https", "mast"):
            # Preserve the archive-reported URI. Do not turn mast: into an
            # asserted direct download URL or guess a filename from a target.
            uris.append({"url": data_uri, "fileName": parsed.path.rsplit("/", 1)[-1]})
    return uris


def normalize_row(row: dict, collection: str) -> dict:
    if row.get("obs_collection") != collection or row.get("dataRights") != "PUBLIC":
        raise ValueError("MAST returned a row outside the declared public collection")
    if row.get("dataproduct_type") not in ("image", "spectrum"):
        raise ValueError("MAST returned a row outside the requested scientific modality")
    if not isinstance(row.get("obsid"), (str, int)) or not str(row["obsid"]):
        raise ValueError("MAST observation has no source-supported native identity")
    if row.get("calib_level") not in (1, 2, 3, 4):
        raise ValueError("MAST returned an unobserved/planned or uncalibrated observation")
    if not isinstance(row.get("t_min"), (float, int)) or not math.isfinite(row["t_min"]):
        raise ValueError("MAST returned an observation without a verified observation time")
    s_region = row.get("s_region")
    return {
        "unitId": str(row["obsid"]), "obs_id": str(row.get("obs_id") or ""),
        "objID": str(row.get("objID") or ""), "obs_collection": collection,
        "sRegion": s_region if isinstance(s_region, str) else "",
        "instrument": str(row.get("instrument_name") or ""),
        "filters": str(row.get("filters") or ""),
        "provenance_name": str(row.get("provenance_name") or ""),
        "project": str(row.get("project") or ""),
        "proposalId": str(row.get("proposal_id") or ""),
        "targetName": str(row.get("target_name") or ""),
        "dataproduct_type": row["dataproduct_type"],
        "t_min": row["t_min"], "t_max": row.get("t_max"),
        "dataRights": row["dataRights"], "calib_level": row["calib_level"],
        "s_ra": row.get("s_ra"), "s_dec": row.get("s_dec"),
        "dataURL": row.get("dataURL"), "jpegURL": row.get("jpegURL"),
        "accessUris": observation_access_uris(row),
    }


def acquire(args: argparse.Namespace) -> dict:
    collection = args.survey.upper()
    filters = [
        {"paramName": "obs_collection", "values": [collection]},
        {"paramName": "dataRights", "values": ["PUBLIC"]},
        {"paramName": "dataproduct_type", "values": args.modality},
        {"paramName": "calib_level", "values": [1, 2, 3, 4]},
    ]
    if args.project:
        filters.append({"paramName": "project", "values": args.project})
    if args.proposal:
        filters.append({"paramName": "proposal_id", "values": args.proposal})
    if args.target:
        filters.append({"paramName": "target_name", "values": args.target})
    if args.release_path:
        if collection != "GALEX":
            raise ValueError("A GR6/GR7 path selector applies only to GALEX")
        filters.append({"paramName": "dataURL", "values": [],
                        "freeText": f"%/data/{args.release_path}/%"})
    query = {"columns": ",".join(COLUMNS), "filters": filters}
    query_hash = sha256(json_bytes(query))
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    request = {"service": SERVICE, "params": query, "format": "json", "pagesize": args.page_size, "page": 1}
    first, documents = fetch_page(directory, request, query_hash)
    baseline = first["paging"]
    upstream_page_count = baseline["pagesFiltered"]
    if upstream_page_count < 1 or baseline["rowsFiltered"] < 1:
        raise ValueError("MAST query returned no public observations")
    count = min(upstream_page_count, args.max_pages) if args.max_pages else upstream_page_count
    pages = {1: first}
    print(f"{collection}: 1/{count} pages, upstream rows={baseline['rowsFiltered']}", flush=True)
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        future_pages = {
            executor.submit(fetch_page, directory, {**request, "page": page}, query_hash): page
            for page in range(2, count + 1)
        }
        for future in as_completed(future_pages):
            page, docs = future.result()
            current = page["paging"]
            for key in ("pagesFiltered", "rowsFiltered", "rowsTotal"):
                if current[key] != baseline[key]:
                    raise ValueError("MAST pagination totals changed during metadata acquisition")
            pages[current["page"]] = page
            documents.extend(docs)
            print(f"{collection}: {len(pages)}/{count} pages", flush=True)
    row_file = directory / "observations.ndjson.gz"
    row_count, ids, projects, provenance, targets, released_paths = 0, set(), {}, {}, {}, {}
    with row_file.open("wb") as destination:
        with gzip.GzipFile(fileobj=destination, filename="", mode="wb", compresslevel=6, mtime=0) as output:
            for page in sorted(pages):
                for source_row in pages[page]["data"]:
                    row = normalize_row(source_row, collection)
                    output.write((json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
                    row_count += 1
                    ids.add(row["unitId"])
                    for counts, key in [(projects, "project"), (provenance, "provenance_name"), (targets, "targetName")]:
                        counts[row[key]] = counts.get(row[key], 0) + 1
                    for release in ("GR6", "GR7"):
                        if f"/data/{release}/" in str(row.get("dataURL")):
                            released_paths[release] = released_paths.get(release, 0) + 1
    full_query = count == upstream_page_count
    if full_query and row_count != baseline["rowsFiltered"]:
        raise ValueError("Captured all pages but row count differs from the upstream count")
    captured_at = now()
    row_bytes = row_file.read_bytes()
    manifest = {
        "schemaVersion": 1, "adapter": "mast-observation", "surveyId": args.survey,
        "releaseId": args.release, "capturedAt": captured_at, "coordinateFrame": "ICRS", "ordering": "NESTED",
        "metadataDocuments": sorted(documents, key=lambda d: d["ref"]),
        "rowFiles": [{"ref": row_file.name, "sha256": sha256(row_bytes), "sizeBytes": len(row_bytes), "rows": row_count}],
        "rowCount": row_count, "inventoryComplete": False, "queryPagesComplete": full_query,
        "scope": args.scope,
        "sourceUrl": SOURCE_URL, "service": SERVICE, "query": query,
        "sourcePagination": {"pageSize": args.page_size, "pageCount": upstream_page_count,
                             "rowsFiltered": baseline["rowsFiltered"], "rowsTotal": baseline["rowsTotal"],
                             "capturedPages": sorted(pages), "queryPagesComplete": full_query},
        "summary": {"uniqueObservations": len(ids), "projects": projects, "provenance": provenance,
                    "distinctTargets": len(targets),
                    "targets": targets if len(targets) <= 50 else dict(sorted(targets.items(), key=lambda item: (-item[1], item[0]))[:20]),
                    "archiveReleasePaths": released_paths},
        "limitations": [
            "Scientific image, spectrum, catalogue, ASDF and preview bytes were not downloaded.",
            "Original CAOM s_region is archive spatial evidence; valid-pixel coverage was not verified.",
            "The full declared query is not a complete survey/file inventory or a new public coverage release.",
            "Archive-reported dataURL can identify a product with a different subtype; use the Products API for current policy and inventory.",
        ] + ([] if full_query else ["Only the captured upstream page numbers were acquired; this is a bounded snapshot."]),
    }
    (directory / "manifest.json").write_bytes(json_bytes(manifest))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--survey", choices=("galex", "jwst"), required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--project", action="append")
    parser.add_argument("--proposal", action="append")
    parser.add_argument("--target", action="append")
    parser.add_argument("--release-path", choices=("GR6", "GR7"))
    parser.add_argument("--modality", action="append", choices=("image", "spectrum"))
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-pages", type=int, default=0, help="0 obtains every page of the declared metadata query")
    args = parser.parse_args()
    args.modality = args.modality or ["image"]
    if not 1 <= args.page_size <= 2000 or not 1 <= args.concurrency <= 8 or args.max_pages < 0:
        parser.error("page-size must be 1..2000, concurrency 1..8 and max-pages nonnegative")
    result = acquire(args)
    print(json.dumps({"manifest": str(Path(args.output).resolve() / "manifest.json"),
                      "rows": result["rowCount"],
                      **{key: value for key, value in result["summary"].items() if key != "targets"}},
                     ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
