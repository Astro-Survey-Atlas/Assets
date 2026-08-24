#!/usr/bin/env python3
"""One-shot migration of CSST file/coverage evidence into warehouse ES.

The source URL is intentionally required: a legacy Elasticsearch endpoint may
only be used for this explicit migration and is never a runtime default.
Use --dry-run first. With --evidence-dir and pyarrow installed, the same read
also writes files.parquet and coverage_edges.parquet for the evidence PVC.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

DEFAULT_TARGET = "http://warehouse-elasticsearch.warehouse.svc.cluster.local:9200"
INDICES = ("astro_file_index_v1", "astro_coverage_index_v1")
RUN_METADATA = {
    "workspace-coverage-04a0be5dc49c": ("w1", "csst-sim-w1-20250731", "W1 simulated wide-field images"),
    "workspace-coverage-ec9448e73ced-retry4": ("w2", "csst-sim-w2-20250731", "W2 simulated wide-field images"),
    "workspace-coverage-ee904e0f11af-retry3": ("w3", "csst-sim-w3-20250731", "W3 simulated wide-field images"),
    "workspace-coverage-dbf269d0f221-retry3": ("w4", "csst-sim-w4-20250731", "W4 simulated wide-field images"),
}


def request_json(url: str, method: str = "GET", body: Any | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=payload, method=method, headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from error


def source_id(index: str, run_id: str, hit: dict[str, Any]) -> str:
    if hit.get("_id"):
        return str(hit["_id"])
    raw = json.dumps(hit.get("_source", {}), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{index}|{run_id}|{raw}".encode()).hexdigest()


def iter_scroll(source_url: str, index: str, run_id: str, page_size: int = 2000) -> Any:
    query = {"size": page_size, "_source": True, "query": {"bool": {"should": [
        {"term": {"scan_run_id.keyword": run_id}}, {"term": {"scan_run_id": run_id}},
        {"term": {"run_id.keyword": run_id}}, {"term": {"run_id": run_id}},
    ], "minimum_should_match": 1}}}
    page = request_json(f"{source_url}/{index}/_search?scroll=10m", "POST", query)
    scroll_id = page.get("_scroll_id")
    try:
        while True:
            batch = page.get("hits", {}).get("hits", [])
            if not batch:
                break
            for hit in batch:
                yield hit
            if not scroll_id:
                break
            page = request_json(f"{source_url}/_search/scroll", "POST", {"scroll": "10m", "scroll_id": scroll_id})
            scroll_id = page.get("_scroll_id", scroll_id)
    finally:
        if scroll_id:
            try:
                request_json(f"{source_url}/_search/scroll", "DELETE", {"scroll_id": scroll_id})
            except RuntimeError:
                pass
def count_matching(source_url: str, index: str, run_id: str) -> int:
    query = {"query": {"bool": {"should": [
        {"term": {"scan_run_id.keyword": run_id}}, {"term": {"scan_run_id": run_id}},
        {"term": {"run_id.keyword": run_id}}, {"term": {"run_id": run_id}},
    ], "minimum_should_match": 1}}}
    result = request_json(f"{source_url}/{index}/_count", "POST", query)
    return int(result.get("count", 0))


def send_bulk(target_url: str, lines: list[str], headers: dict[str, str]) -> None:
    payload = ("\n".join(lines) + "\n").encode()
    request = urllib.request.Request(f"{target_url}/_bulk?refresh=false", data=payload, method="POST", headers={**headers, "content-type": "application/x-ndjson"})
    with urllib.request.urlopen(request, timeout=300) as response:
        result = json.loads(response.read())
    if result.get("errors"):
        raise RuntimeError("warehouse Elasticsearch bulk import reported item errors")


def bulk(target_url: str, records: Iterable[tuple[str, str, str, dict[str, Any]]], headers: dict[str, str], dry_run: bool, batch_size: int = 2000) -> int:
    lines: list[str] = []
    count = 0
    for index, doc_id, _run_id, document in records:
        lines.append(json.dumps({"index": {"_index": index, "_id": doc_id}}, separators=(",", ":")))
        lines.append(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
        count += 1
        if len(lines) >= batch_size * 2:
            if not dry_run:
                send_bulk(target_url, lines, headers)
            lines.clear()
    if lines and not dry_run:
        send_bulk(target_url, lines, headers)
    return count


def value(source: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def enrich(index: str, run_id: str, source: dict[str, Any]) -> dict[str, Any]:
    """Add stable Assets identity without removing warehouse scanner fields."""
    band, release_id, product = RUN_METADATA.get(run_id, (None, None, None))
    if not band:
        return source
    result = dict(source)
    result.setdefault("scan_run_id", run_id)
    result.setdefault("run_id", run_id)
    result.setdefault("survey_id", "csst")
    result.setdefault("surveyId", "csst")
    result.setdefault("release_id", release_id)
    result.setdefault("releaseId", release_id)
    result.setdefault("product", product)
    result.setdefault("product_id", f"csst:{release_id}:{product}")
    result.setdefault("productId", f"csst:{release_id}:{product}")
    result.setdefault("layer_id", f"csst-sim-{band}-image-extent")
    result.setdefault("layerId", f"csst-sim-{band}-image-extent")
    if index == "astro_coverage_index_v1":
        if "healpix_order" in result and "order" not in result:
            result["order"] = result["healpix_order"]
        if "healpix" in result and "ipix" not in result:
            result["ipix"] = result["healpix"]
    return result


class EvidenceParquetWriter:
    """Incremental Parquet writer so a full CSST run stays bounded in memory."""

    def __init__(self, directory: Path) -> None:
        try:
            import pyarrow as pa  # type: ignore
            import pyarrow.parquet as pq  # type: ignore
        except ImportError as error:
            raise RuntimeError("Parquet export requires pyarrow; install the evidence tooling extra before using --evidence-dir") from error
        directory.mkdir(parents=True, exist_ok=True)
        self.pa = pa
        self.pq = pq
        self.directory = directory
        self.file_schema = pa.schema([
            ("sourceFileId", pa.string()), ("scanRunId", pa.string()), ("fileName", pa.string()), ("sourceUri", pa.string()),
            ("etag", pa.string()), ("sizeBytes", pa.int64()), ("wcsSummary", pa.string()), ("spatialStatus", pa.string()),
        ])
        self.edge_schema = pa.schema([
            ("edgeId", pa.string()), ("layerId", pa.string()), ("surveyId", pa.string()), ("releaseId", pa.string()), ("productId", pa.string()),
            ("modality", pa.string()), ("scanRunId", pa.string()), ("sourceFileId", pa.string()), ("sourceUri", pa.string()), ("fileName", pa.string()),
            ("order", pa.int16()), ("ipix", pa.int64()), ("raMin", pa.float64()), ("raMax", pa.float64()), ("decMin", pa.float64()), ("decMax", pa.float64()),
            ("coverageMethod", pa.string()), ("coverageRole", pa.string()), ("etag", pa.string()), ("sizeBytes", pa.int64()),
        ])
        self.file_writer = None
        self.edge_writer = None
        self.files: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self.chunk_size = 2000

    def add(self, index: str, doc_id: str, doc: dict[str, Any]) -> None:
        if index == "astro_file_index_v1":
            self.files.append({
                "sourceFileId": doc_id, "scanRunId": value(doc, "scan_run_id", "scanRunId", "run_id"), "fileName": value(doc, "name", "file_name", "fileName"),
                "sourceUri": value(doc, "urn", "uri", "source_uri", "sourceUri"), "etag": value(doc, "etag", "ETag"), "sizeBytes": value(doc, "size_bytes", "sizeBytes", "size"),
                "wcsSummary": json.dumps(value(doc, "wcs_summary", "wcsSummary"), ensure_ascii=False) if value(doc, "wcs_summary", "wcsSummary") is not None else None,
                "spatialStatus": value(doc, "spatial_status", "spatialStatus"),
            })
            if len(self.files) >= self.chunk_size:
                self.flush_files()
            return
        order = value(doc, "order", "healpix_order", "coverage_order")
        ipix = value(doc, "ipix", "pixel", "healpix", "healpix_ipix", "healpix_pixel")
        if order is None or ipix is None:
            return
        self.edges.append({
            "edgeId": doc_id, "layerId": value(doc, "layer_id", "layerId", "layer"), "surveyId": value(doc, "survey_id", "surveyId", "survey"),
            "releaseId": value(doc, "release_id", "releaseId", "release"), "productId": value(doc, "product_id", "productId"), "modality": value(doc, "modality"),
            "scanRunId": value(doc, "scan_run_id", "scanRunId", "run_id"), "sourceFileId": value(doc, "source_file_id", "sourceFileId", "file_id", "fileId"),
            "sourceUri": value(doc, "source_uri", "sourceUri", "urn"), "fileName": value(doc, "file_name", "fileName", "name"), "order": int(order), "ipix": int(ipix),
            "raMin": value(doc, "ra_min", "raMin"), "raMax": value(doc, "ra_max", "raMax"), "decMin": value(doc, "dec_min", "decMin"), "decMax": value(doc, "dec_max", "decMax"),
            "coverageMethod": value(doc, "coverage_method", "coverageMethod"), "coverageRole": value(doc, "coverage_role", "coverageRole"),
            "etag": value(doc, "etag", "ETag"), "sizeBytes": value(doc, "size_bytes", "sizeBytes", "size"),
        })
        if len(self.edges) >= self.chunk_size:
            self.flush_edges()

    def flush_files(self) -> None:
        if not self.files:
            return
        table = self.pa.Table.from_pylist(self.files, schema=self.file_schema)
        if self.file_writer is None:
            self.file_writer = self.pq.ParquetWriter(self.directory / "files.parquet", self.file_schema, compression="zstd")
        self.file_writer.write_table(table)
        self.files.clear()

    def flush_edges(self) -> None:
        if not self.edges:
            return
        table = self.pa.Table.from_pylist(self.edges, schema=self.edge_schema)
        if self.edge_writer is None:
            self.edge_writer = self.pq.ParquetWriter(self.directory / "coverage_edges.parquet", self.edge_schema, compression="zstd")
        self.edge_writer.write_table(table)
        self.edges.clear()

    def close(self) -> None:
        self.flush_files()
        self.flush_edges()
        if self.file_writer is not None:
            self.file_writer.close()
        if self.edge_writer is not None:
            self.edge_writer.close()


def write_parquet(directory: Path, file_hits: list[tuple[str, dict[str, Any]]], coverage_hits: list[tuple[str, dict[str, Any]]]) -> None:
    """Compatibility helper for bounded callers; migration uses the streaming writer."""
    writer = EvidenceParquetWriter(directory)
    try:
        for index, entries in (("astro_file_index_v1", file_hits), ("astro_coverage_index_v1", coverage_hits)):
            for doc_id, doc in entries:
                writer.add(index, doc_id, doc)
    finally:
        writer.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-es-url", required=True, help="explicit legacy/source Elasticsearch URL")
    parser.add_argument("--target-es-url", default=DEFAULT_TARGET)
    parser.add_argument("--run", action="append", required=True, metavar="BAND=RUN_ID", help="repeat for W1/W2/W3/W4")
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--api-key", default=None, help="optional target Elasticsearch API key")
    parser.add_argument("--batch-size", type=int, default=2000, help="documents per target bulk request")
    parser.add_argument("--scroll-size", type=int, default=2000, help="documents per source scroll page")
    args = parser.parse_args()
    if args.batch_size < 1 or args.scroll_size < 1 or args.batch_size > 10000 or args.scroll_size > 10000:
        parser.error("--batch-size and --scroll-size must be between 1 and 10000")
    runs = {}
    for item in args.run:
        if "=" not in item:
            parser.error("--run must use BAND=RUN_ID")
        band, run_id = item.split("=", 1)
        runs[band.upper()] = run_id
    if not runs:
        parser.error("at least one --run is required")
    source_url = args.source_es_url.rstrip("/")
    target_url = args.target_es_url.rstrip("/")
    headers = {"Authorization": f"ApiKey {args.api_key}"} if args.api_key else {}
    parquet_writer = EvidenceParquetWriter(args.evidence_dir) if args.evidence_dir else None
    summary: dict[str, dict[str, int]] = {}
    try:
        for band, run_id in sorted(runs.items()):
            counts = {}
            for index in INDICES:
                if args.dry_run:
                    counts[index] = count_matching(source_url, index, run_id)
                    continue
                def records_for_index() -> Any:
                    for hit in iter_scroll(source_url, index, run_id, args.scroll_size):
                        doc = enrich(index, run_id, hit.get("_source", {}))
                        doc_id = source_id(index, run_id, hit)
                        if parquet_writer:
                            parquet_writer.add(index, doc_id, doc)
                        yield (index, doc_id, run_id, doc)
                counts[index] = bulk(target_url, records_for_index(), headers, False, args.batch_size)
            summary[band] = counts
    finally:
        if parquet_writer:
            parquet_writer.close()
    imported = sum(sum(values.values()) for values in summary.values())
    print(json.dumps({"sourceEsUrl": source_url, "targetEsUrl": target_url, "dryRun": args.dry_run, "runs": summary, "records": imported, "evidenceDir": str(args.evidence_dir) if args.evidence_dir else None}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, urllib.error.URLError) as error:
        print(f"migration failed: {error}", file=sys.stderr)
        raise SystemExit(2)
