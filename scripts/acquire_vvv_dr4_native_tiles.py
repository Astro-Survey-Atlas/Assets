#!/usr/bin/env python3
"""Capture VVV DR4 incremental ObsCore rows and their ESO DataLink #this records."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


TAP_URL = "https://archive.eso.org/tap_obs/sync"
RELEASE_URL = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/80"
USER_AGENT = "Astro-Survey-Atlas-Assets-native-metadata/1.0"
PAGE_SIZE = 5000
MAX_PAGES = 32
LINK_WORKERS = 12
LINK_FILTERS = {"H", "J", "Y", "Z"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request_bytes(url: str, timeout: int = 90) -> tuple[bytes, int]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv,application/x-votable+xml,*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.status


def query_url(cursor: str | None) -> tuple[str, str]:
    cursor_clause = f" AND dp_id > '{cursor}'" if cursor else ""
    query = (
        f"SELECT TOP {PAGE_SIZE} dp_id, target_name, filter, obs_id, obs_creator_did, "
        "s_region, access_url, release_description "
        "FROM ivoa.ObsCore "
        "WHERE obs_collection = 'VVV' "
        f"AND release_description = '{RELEASE_URL}' "
        f"AND dataproduct_type = 'image'{cursor_clause} "
        "ORDER BY dp_id"
    )
    return TAP_URL + "?" + urllib.parse.urlencode({
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "MAXREC": str(PAGE_SIZE), "QUERY": query,
    }), query


def parse_csv_page(data: bytes) -> list[dict[str, str]]:
    text = data.decode("utf-8-sig")
    required = {"dp_id", "target_name", "filter", "s_region", "access_url", "release_description"}
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if not reader.fieldnames or not required.issubset(reader.fieldnames):
        raise ValueError("ESO TAP response did not contain the required ObsCore CSV columns")
    return list(reader)


def transform_s_region_j2000(value: str) -> str:
    parts = value.split()
    if len(parts) < 9 or parts[0].upper() != "POLYGON" or parts[1].upper() != "J2000" or (len(parts) - 2) % 2:
        raise ValueError("VVV ObsCore footprint must be a POLYGON J2000")
    values = [float(part) for part in parts[2:]]
    coordinates = SkyCoord(
        ra=values[0::2] * u.deg,
        dec=values[1::2] * u.deg,
        frame=FK5(equinox=Time("J2000")),
    ).transform_to(ICRS())
    vertices = " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in zip(coordinates.ra.wrap_at(360 * u.deg).deg, coordinates.dec.deg))
    return f"POLYGON ICRS {vertices}"


def parse_datalink_response(data: bytes, dp_id: str) -> dict[str, str] | None:
    root = ET.fromstring(data)
    fields = [element.attrib.get("name", "").lower() for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "FIELD"]
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "TR":
            continue
        values = [child.text or "" for child in list(element) if child.tag.rsplit("}", 1)[-1] == "TD"]
        row = dict(zip(fields, values))
        if row.get("semantics") != "#this":
            continue
        uri = row.get("access_url", "")
        parsed = urllib.parse.urlsplit(uri)
        if parsed.scheme != "https" or parsed.hostname != "dataportal.eso.org" or parsed.path != f"/dataPortal/file/{dp_id}" or parsed.username or parsed.password:
            raise ValueError(f"ESO DataLink #this is not the requested single-file product: {dp_id}")
        if not row.get("eso_origfile") or not re.search(r"\.fits(?:\.(?:gz|bz2|fz))?$", row["eso_origfile"], re.IGNORECASE):
            raise ValueError(f"ESO DataLink #this lacks the source filename: {dp_id}")
        return row
    return None


def capture_datalink(row: dict[str, str]) -> tuple[str, bytes | None, dict[str, str] | None, str | None]:
    dp_id = row["dp_id"]
    url = row["access_url"]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "archive.eso.org" or parsed.path != "/datalink/links":
        return dp_id, None, None, "ObsCore access_url is not the official ESO DataLink endpoint"
    try:
        data, status = request_bytes(url, timeout=90)
        if status != 200:
            return dp_id, data, None, f"DataLink returned HTTP {status}"
        result = parse_datalink_response(data, dp_id)
        if result is None:
            return dp_id, data, None, "DataLink response has no semantics=#this row"
        return dp_id, data, result, None
    except (urllib.error.URLError, TimeoutError, ValueError, ET.ParseError) as error:
        return dp_id, None, None, str(error)[:500]


def write_gzip_jsonl(path: Path, rows: list[dict[str, object]]) -> tuple[str, int]:
    with path.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    data = path.read_bytes()
    return sha256(data), len(data)


def acquire(output: Path) -> dict[str, object]:
    output.mkdir(parents=True, exist_ok=False)
    capture_time = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    tap_files: list[dict[str, object]] = []
    observations: list[dict[str, str]] = []
    page_summaries: list[dict[str, object]] = []
    cursor: str | None = None
    tap_complete = False

    for page_number in range(1, MAX_PAGES + 1):
        url, query = query_url(cursor)
        data, status = request_bytes(url)
        if status != 200:
            raise RuntimeError(f"ESO TAP returned HTTP {status}")
        page = parse_csv_page(data)
        if page_number == 1 and not page:
            raise RuntimeError("ESO TAP returned no VVV DR4 image records")
        if len(page) > PAGE_SIZE:
            raise RuntimeError("ESO TAP exceeded the requested page size")
        ids = [row["dp_id"] for row in page]
        if any(not re.fullmatch(r"ADP\.[A-Za-z0-9.:-]+", item) for item in ids) or ids != sorted(ids) or len(set(ids)) != len(ids):
            raise RuntimeError("ESO TAP page has an invalid or unstable dp_id ordering")
        if cursor and ids and ids[0] <= cursor:
            raise RuntimeError("ESO TAP continuation repeated or reversed a dp_id")
        for row in page:
            if row["release_description"] != RELEASE_URL:
                raise RuntimeError("ESO TAP returned a row outside the frozen DR4 submission")
            if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", row["target_name"]):
                raise RuntimeError(f"VVV row has an unsupported source target identity: {row['target_name']}")
            if not row["s_region"].upper().startswith("POLYGON J2000 "):
                raise RuntimeError(f"VVV row has an unsupported ObsCore geometry: {row['dp_id']}")
        filename = f"tap-page-{page_number:03d}.csv"
        (output / filename).write_bytes(data)
        tap_files.append({"ref": filename, "sha256": sha256(data), "sizeBytes": len(data), "url": url, "sourceUrl": TAP_URL})
        page_summaries.append({"page": page_number, "rows": len(page), "sha256": sha256(data), "httpStatus": status, "query": query})
        observations.extend(page)
        print(f"TAP page {page_number}: {len(page)} rows", file=sys.stderr, flush=True)
        if len(page) < PAGE_SIZE:
            tap_complete = True
            break
        cursor = ids[-1]
    if not tap_complete:
        raise RuntimeError(f"ESO TAP exceeded the {MAX_PAGES}-page capture budget")

    if len({row["dp_id"] for row in observations}) != len(observations):
        raise RuntimeError("VVV ObsCore pages contain duplicate dp_id values")
    linked_rows = [row for row in observations if row["filter"].strip().upper() in LINK_FILTERS
                   and re.fullmatch(r"[bd]\d{3}", row["target_name"].lower())]
    links: dict[str, tuple[bytes, dict[str, str] | None, str | None]] = {}
    failures: list[dict[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=LINK_WORKERS) as pool:
        futures = {pool.submit(capture_datalink, row): row["dp_id"] for row in linked_rows}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            dp_id, raw, result, error = future.result()
            if raw is not None:
                links[dp_id] = (raw, result, error)
            else:
                links[dp_id] = (b"", result, error)
            if error:
                failures.append({"dpId": dp_id, "error": error})
            if index % 100 == 0 or index == len(futures):
                print(f"DataLink metadata: {index}/{len(futures)}; failures={len(failures)}", file=sys.stderr, flush=True)

    data_link_evidence: list[dict[str, object]] = []
    normalized_rows: list[dict[str, object]] = []
    for row in observations:
        dp_id = row["dp_id"]
        band = row["filter"].strip().upper()
        unit_id = row["target_name"].lower()
        native_tile_identity = bool(re.fullmatch(r"[bd]\d{3}", unit_id))
        raw_link, listed, error = links.get(dp_id, (b"", None, None))
        access_uris: list[dict[str, object]] = []
        if raw_link:
            data_link_evidence.append({"dpId": dp_id, "url": row["access_url"], "sha256": sha256(raw_link), "httpStatus": 200,
                                      "bodyBase64": base64.b64encode(raw_link).decode("ascii")})
        if listed:
            access_uris.append({"uri": listed["access_url"], "fileName": listed["eso_origfile"], "band": band, "accessType": "file"})
        source_s_region = row["s_region"]
        native_row = {
            "unitId": unit_id,
            "targetName": unit_id,
            "sRegion": transform_s_region_j2000(source_s_region),
            "bands": [band],
            "sourceMetadata": {
                "dpId": dp_id,
                "obsId": row.get("obs_id", ""),
                "obsCreatorDid": row.get("obs_creator_did", ""),
                "targetName": unit_id,
                "sourceTargetName": row["target_name"],
                "nativeTileIdentity": native_tile_identity,
                "filter": band,
                "nativeCoordinateFrame": "J2000",
                "sourceSRegion": source_s_region,
                "geometryTransform": "FK5(J2000.0) to ICRS using Astropy",
                "releaseDescription": RELEASE_URL,
                "dataLinkUrl": row["access_url"],
                "dataLinkListed": listed is not None,
                "dataLinkResponseSha256": sha256(raw_link) if raw_link else None,
                "dataLinkError": error,
                "contentLength": int(listed["content_length"]) if listed and listed.get("content_length", "").isdigit() else None,
                "esoOriginalFile": listed.get("eso_origfile") if listed else None,
            },
            "accessUris": access_uris,
        }
        if native_tile_identity:
            normalized_rows.append(native_row)
    if len(data_link_evidence) != len([row for row in linked_rows if links.get(row["dp_id"], (b"", None, None))[0]]):
        raise RuntimeError("DataLink evidence count is inconsistent")

    tap_metadata = [{"ref": str(item["ref"]), "sha256": str(item["sha256"]), "sizeBytes": int(item["sizeBytes"]),
                     "url": str(item["url"]), "sourceUrl": TAP_URL} for item in tap_files]
    link_evidence_sha, link_evidence_size = write_gzip_jsonl(output / "datalink-responses.ndjson.gz", data_link_evidence)
    rows_sha, rows_size = write_gzip_jsonl(output / "native-rows.ndjson.gz", normalized_rows)
    metadata_documents = [*tap_metadata, {"ref": "datalink-responses.ndjson.gz", "sha256": link_evidence_sha,
        "sizeBytes": link_evidence_size, "url": "https://archive.eso.org/datalink/links", "sourceUrl": "https://archive.eso.org/datalink/links"}]
    query_complete = tap_complete and not failures
    manifest = {
        "schemaVersion": 1,
        "adapter": "eso-obscore-vvv",
        "surveyId": "vista",
        "releaseId": "vista-vvv-dr4",
        "capturedAt": capture_time,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "nativeCoordinateFrame": "J2000",
        "inventoryComplete": False,
        "queryPagesComplete": query_complete,
        "scope": {
            "releaseDescription": RELEASE_URL,
            "obsCollection": "VVV",
            "dataproductType": "image",
            "cumulativeInventory": False,
            "dr4IncrementRows": len(observations),
            "dr4IncrementTileCountFromRows": len({row["target_name"].lower() for row in observations if re.fullmatch(r"[bd]\d{3}", row["target_name"].lower())}),
            "nonTileTargetRows": sum(1 for row in observations if not re.fullmatch(r"[bd]\d{3}", row["target_name"].lower())),
            "bandRows": {label: sum(row["filter"].strip().upper() == value for row in observations) for label, value in [("Ks", "KS"), ("Z", "Z"), ("Y", "Y"), ("J", "J"), ("H", "H")]},
            "linkedBands": sorted(LINK_FILTERS),
            "notes": "The ESO release description says the 11,452 rows are the DR4 submission increment, following 18,011 images in DR3. This is not the cumulative DR4 inventory. Non-Tile calibration target rows remain in the raw TAP pages and are excluded from the native Tile row file.",
        },
        "sourcePagination": {
            "queryPagesComplete": query_complete,
            "tap": {"pageSize": PAGE_SIZE, "pages": page_summaries, "rows": len(observations), "queryPagesComplete": tap_complete},
            "dataLink": {"requested": len(linked_rows), "listed": len(data_link_evidence) - sum(1 for row in linked_rows if links.get(row["dp_id"], (b"", None, None))[2]),
                         "failed": failures, "queryPagesComplete": not failures},
        },
        "metadataDocuments": metadata_documents,
        "rowFiles": [{"ref": "native-rows.ndjson.gz", "sha256": rows_sha, "sizeBytes": rows_size,
                      "sourceUrl": TAP_URL, "rows": len(normalized_rows)}],
        "rowCount": len(normalized_rows),
        "query": "Exact ESO ObsCore VVV DR4 release-description filter; dataproduct_type=image; stable dp_id keyset pagination; DataLink #this captured only for H/J/Y/Z.",
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    (output / "manifest.json").write_bytes(manifest_bytes)
    return {"capturedAt": capture_time, "manifestSha256": sha256(manifest_bytes), "manifestSizeBytes": len(manifest_bytes),
            "tapRows": len(observations), "nativeTileRows": len(normalized_rows), "tileIds": manifest["scope"]["dr4IncrementTileCountFromRows"],
            "bandRows": manifest["scope"]["bandRows"], "dataLinkRequested": len(linked_rows),
            "dataLinkListed": manifest["sourcePagination"]["dataLink"]["listed"], "dataLinkFailures": len(failures),
            "queryPagesComplete": query_complete, "inventoryComplete": False, "output": str(output)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New output directory outside the repository")
    args = parser.parse_args()
    summary = acquire(args.output)
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
