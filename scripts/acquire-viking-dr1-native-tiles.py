#!/usr/bin/env python3
"""Capture VIKING DR1 J-band Tile metadata and ESO DataLink evidence only."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


TAP_URL = "https://archive.eso.org/tap_obs/sync"
RELEASE_URL = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/24"
SOURCE_URL = TAP_URL
SOURCE_ID = "vista-viking-dr1-j-tiles"
SURVEY_ID = "vista"
RELEASE_ID = "viking"
PAGE_SIZE = 5000
EXPECTED_ROWS = 110
OFFICIAL_TILE_COUNT = 151
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only VIKING DR1 collector/1.0"
SELECT = "dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description, dataproduct_subtype"
WHERE = (
    "obs_collection = 'VIKING' AND release_description = "
    f"'{RELEASE_URL}' AND dataproduct_type = 'image' AND filter = 'J' "
    "AND (dataproduct_subtype IS NULL OR dataproduct_subtype = '')"
)
SOURCE_QUERY = f"SELECT TOP {PAGE_SIZE} {SELECT} FROM ivoa.ObsCore WHERE {WHERE} ORDER BY dp_id"
DENOMINATOR_QUERY = f"SELECT COUNT(*) AS row_count FROM ivoa.ObsCore WHERE {WHERE}"
BAND_COUNTS_QUERY = f"SELECT filter, COUNT(*) AS n FROM ivoa.ObsCore WHERE {WHERE} GROUP BY filter ORDER BY filter"


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def immutable_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to replace different evidence: {path}")
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def request_bytes(url: str, timeout: int = 90, accept: str = "*/*", retries: int = 3) -> tuple[bytes, int, str]:
    failure: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), response.status, response.url
        except urllib.error.HTTPError as error:
            failure = error
            if error.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError) as error:
            failure = error
        if attempt + 1 < retries:
            time.sleep(2**attempt)
    assert failure is not None
    raise failure


def parse_votable(body: bytes) -> tuple[list[dict[str, str]], bool]:
    root = ET.fromstring(body)
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    statuses = [item.get("value", "") for item in root.iter() if local(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    if "ERROR" in statuses or "OK" not in statuses:
        raise ValueError(f"ESO TAP QUERY_STATUS={statuses}")
    table = next((item for item in root.iter() if local(item) == "TABLE"), None)
    if table is None:
        raise ValueError("ESO TAP VOTable has no TABLE")
    fields = [field.get("name", "").strip().lower() for field in table if local(field) == "FIELD"]
    if not fields or len(fields) != len(set(fields)):
        raise ValueError("ESO TAP VOTable fields are missing or duplicated")
    tabledata = next((item for item in table.iter() if local(item) == "TABLEDATA"), None)
    if tabledata is None:
        raise ValueError("ESO TAP response is not TABLEDATA")
    rows: list[dict[str, str]] = []
    for tr in tabledata:
        if local(tr) != "TR":
            continue
        values = [(cell.text or "").strip() for cell in tr if local(cell) == "TD"]
        if len(values) != len(fields):
            raise ValueError("ESO TAP row width differs from its FIELD declaration")
        rows.append(dict(zip(fields, values)))
    return rows, "OVERFLOW" in statuses


def tap_url(query: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(PAGE_SIZE), "QUERY": query}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def query(query_text: str) -> tuple[bytes, list[dict[str, str]], bool, str]:
    body, status, response_url = request_bytes(tap_url(query_text), accept="application/x-votable+xml")
    if status != 200:
        raise ValueError(f"ESO TAP returned HTTP {status}")
    rows, overflow = parse_votable(body)
    return body, rows, overflow, response_url


def transform_j2000_polygon(value: str) -> str:
    parts = value.split()
    if len(parts) < 8 or parts[0].upper() != "POLYGON" or parts[1].upper() != "J2000" or (len(parts) - 2) % 2:
        raise ValueError("VIKING geometry must be a complete POLYGON J2000")
    try:
        coordinates = [float(part) for part in parts[2:]]
    except ValueError as error:
        raise ValueError("VIKING polygon contains a non-numeric coordinate") from error
    if any(not 0 <= ra < 360 or not -90 <= dec <= 90 for ra, dec in zip(coordinates[0::2], coordinates[1::2])):
        raise ValueError("VIKING polygon coordinate is outside the celestial sphere")
    sky = SkyCoord(ra=coordinates[0::2] * u.deg, dec=coordinates[1::2] * u.deg, frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    vertices = " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in zip(sky.ra.wrap_at(360 * u.deg).deg, sky.dec.deg))
    return f"POLYGON ICRS {vertices}"


def parse_datalink(body: bytes, dp_id: str, filename: str) -> dict[str, str]:
    root = ET.fromstring(body)
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    table = next((item for item in root.iter() if local(item) == "TABLE"), None)
    if table is None:
        raise ValueError("ESO DataLink response has no TABLE")
    fields = [field.get("name", "").strip().lower() for field in table if local(field) == "FIELD"]
    records: list[dict[str, str]] = []
    for tr in (item for item in table.iter() if local(item) == "TR"):
        values = [(cell.text or "").strip() for cell in tr if local(cell) == "TD"]
        if len(values) != len(fields):
            raise ValueError("ESO DataLink row width differs from its FIELD declaration")
        records.append(dict(zip(fields, values)))
    science = [record for record in records if record.get("semantics") == "#this"]
    expected_uri = f"https://dataportal.eso.org/dataPortal/file/{dp_id}"
    if len(science) != 1 or science[0].get("eso_category") != "SCIENCE.IMAGE" or science[0].get("eso_origfile") != filename or science[0].get("access_url") != expected_uri:
        raise ValueError(f"ESO DataLink #this does not match the VIKING J science image {dp_id}")
    return science[0]


def normalize_row(row: dict[str, str], image: dict[str, str], data_link_url: str, response_sha: str) -> dict:
    dp_id = row["dp_id"]
    filename = image["eso_origfile"]
    tile_match = re.fullmatch(r"viking_er1_[A-Za-z0-9.+-]+_tile_j_(deepimage|image)_(\d+)\.fits\.fz", filename, re.I)
    if not tile_match or row["filter"] != "J" or row["release_description"] != RELEASE_URL or row.get("dataproduct_subtype", ""):
        raise ValueError("VIKING source row does not identify a selected J-band Tile image")
    if row.get("obs_creator_did", "").partition("?")[2] != filename or not re.fullmatch(r"ADP\.[A-Za-z0-9.:-]+", dp_id):
        raise ValueError("VIKING source identity and DataLink filename do not match")
    parsed = urllib.parse.urlsplit(data_link_url)
    expected_id = f"ivo://eso.org/ID?{dp_id}"
    if parsed.scheme != "https" or parsed.hostname != "archive.eso.org" or parsed.path != "/datalink/links" or urllib.parse.parse_qs(parsed.query).get("ID") != [expected_id]:
        raise ValueError("VIKING DataLink URL is not the source-listed request for this dp_id")
    direct_uri = image["access_url"]
    return {
        "unitId": tile_match.group(2),
        "sRegion": transform_j2000_polygon(row["s_region"]),
        "bands": ["J"],
        "filename": filename,
        "accessUris": [{"sourceId": "eso-datalink", "uri": direct_uri, "fileName": filename, "band": "J", "accessType": "file"}],
        "sourceMetadata": {
            "dpId": dp_id,
            "obsId": row.get("obs_id", ""),
            "obsCreatorDid": row.get("obs_creator_did", ""),
            "obsCollection": "VIKING",
            "targetName": row["target_name"],
            "tileId": tile_match.group(2),
            "tileProduct": tile_match.group(1).lower(),
            "dataproductType": "image",
            "dataproductSubtype": "",
            "filter": "J",
            "releaseDescription": RELEASE_URL,
            "nativeCoordinateFrame": "J2000",
            "sourceSRegion": row["s_region"],
            "geometryTransform": "FK5(equinox=J2000) polygon vertices transformed to ICRS with Astropy",
            "dataLinkUrl": data_link_url,
            "dataLinkUri": direct_uri,
            "dataLinkResponseSha256": response_sha,
            "dataLinkSemantics": "#this",
            "dataLinkCategory": image["eso_category"],
            "dataLinkFileName": filename,
            "esoOriginalFile": filename,
            "dataLinkListed": True,
            "contentLength": int(image["content_length"]) if image.get("content_length", "").isdigit() else None,
            "officialReleaseTileCount": OFFICIAL_TILE_COUNT,
            "observedTileCount": EXPECTED_ROWS,
            "validPixelMasksChecked": False,
            "accessSemantics": "whole-tile-science-image",
        },
    }


def acquire_datalink(row: dict[str, str]) -> tuple[str, bytes, dict[str, str], str]:
    body, status, response_url = request_bytes(row["access_url"], accept="application/x-votable+xml,text/xml,*/*")
    if status != 200:
        raise ValueError(f"ESO DataLink returned HTTP {status} for {row['dp_id']}")
    filename = row.get("obs_creator_did", "").partition("?")[2]
    if not filename:
        raise ValueError(f"VIKING ObsCore row has no source filename: {row['dp_id']}")
    image = parse_datalink(body, row["dp_id"], filename)
    return row["dp_id"], body, image, response_url


def write_gzip_jsonl(path: Path, rows: list[dict]) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    body = path.read_bytes()
    return sha256(body), len(body)


def probe_head(uri: str) -> dict[str, object]:
    request = urllib.request.Request(uri, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return {"uri": uri, "status": response.status, "contentType": response.headers.get("Content-Type"), "contentLength": response.headers.get("Content-Length"), "method": "HEAD"}
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        return {"uri": uri, "status": None, "error": str(reason)[:300], "method": "HEAD"}


def capture(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    release_pdf, release_status, release_uri = request_bytes(RELEASE_URL, accept="application/pdf,*/*")
    if release_status != 200 or not release_pdf.startswith(b"%PDF-"):
        raise ValueError("ESO VIKING DR1 release description did not return the expected PDF")
    immutable_write(output / "metadata/release-description-24.pdf", release_pdf)

    denominator_body, denominator_rows, denominator_overflow, denominator_url = query(DENOMINATOR_QUERY)
    band_body, band_rows, band_overflow, band_url = query(BAND_COUNTS_QUERY)
    source_body, source_rows, source_overflow, source_page_url = query(SOURCE_QUERY)
    if denominator_overflow or band_overflow or source_overflow or len(denominator_rows) != 1 or int(denominator_rows[0]["row_count"]) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore VIKING J Tile-image denominator changed from 110")
    observed_bands = {row["filter"]: int(row["n"]) for row in band_rows}
    if observed_bands != {"J": EXPECTED_ROWS} or len(source_rows) != EXPECTED_ROWS:
        raise ValueError(f"VIKING J Tile-image counts changed: rows={len(source_rows)}, bands={observed_bands}")
    ids = [row["dp_id"] for row in source_rows]
    filenames = [row.get("obs_creator_did", "").partition("?")[2] for row in source_rows]
    matches = [re.fullmatch(r"viking_er1_[A-Za-z0-9.+-]+_tile_j_(?:deepimage|image)_(\d+)\.fits\.fz", name, re.I) for name in filenames]
    if ids != sorted(ids) or len(set(ids)) != EXPECTED_ROWS or len(set(filenames)) != EXPECTED_ROWS or any(match is None for match in matches):
        raise ValueError("VIKING rows are not a unique ordered list of source-listed J Tile identities")
    tile_ids = [match.group(1) for match in matches if match]
    if len(set(tile_ids)) != EXPECTED_ROWS:
        raise ValueError("VIKING J source filenames do not resolve to 110 unique numeric Tile IDs")

    immutable_write(output / "metadata/denominator.vot", denominator_body)
    immutable_write(output / "metadata/band-counts.vot", band_body)
    immutable_write(output / "metadata/tap-page-001.vot", source_body)

    link_results: dict[str, tuple[bytes, dict[str, str], str, str]] = {}
    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(acquire_datalink, row) for row in source_rows]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                dp_id, body, image, response_url = future.result()
                link_results[dp_id] = (body, image, response_url, sha256(body))
            except Exception as error:
                failures.append(str(error))
            if index % 25 == 0:
                print(json.dumps({"dataLinksCompleted": index, "resolved": len(link_results), "errors": len(failures)}), flush=True)
    if failures or len(link_results) != EXPECTED_ROWS:
        failure_doc = {"expected": EXPECTED_ROWS, "resolved": len(link_results), "errors": sorted(failures)}
        immutable_write(output / "metadata/datalink-failures.json", json.dumps(failure_doc, sort_keys=True, indent=2).encode())
        raise ValueError(f"VIKING DataLink capture incomplete: {len(link_results)}/{EXPECTED_ROWS} resolved")

    raw_links: list[dict[str, object]] = []
    normalized_rows: list[dict] = []
    for row in source_rows:
        body, image, response_url, response_sha = link_results[row["dp_id"]]
        normalized_rows.append(normalize_row(row, image, row["access_url"], response_sha))
        raw_links.append({"dpId": row["dp_id"], "url": row["access_url"], "status": 200, "responseSha256": response_sha, "bodyBase64": base64.b64encode(body).decode("ascii")})
    raw_links.sort(key=lambda item: str(item["dpId"]))
    datalink_sha, datalink_size = write_gzip_jsonl(output / "metadata/datalinks.ndjson.gz", raw_links)
    row_sha, row_size = write_gzip_jsonl(output / "normalized/native-rows.ndjson.gz", normalized_rows)
    head_checks = [probe_head(normalized_rows[0]["accessUris"][0]["uri"])]
    head_body = json.dumps(head_checks, sort_keys=True, indent=2).encode()
    immutable_write(output / "metadata/representative-head-checks.json", head_body)

    metadata_documents = []
    for ref, url in [
        ("metadata/band-counts.vot", band_url),
        ("metadata/datalinks.ndjson.gz", "https://archive.eso.org/datalink/links"),
        ("metadata/denominator.vot", denominator_url),
        ("metadata/release-description-24.pdf", release_uri),
        ("metadata/representative-head-checks.json", "https://dataportal.eso.org/"),
        ("metadata/tap-page-001.vot", source_page_url),
    ]:
        body = (output / ref).read_bytes()
        metadata_documents.append({"ref": ref, "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": url})
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "eso-obscore-viking", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured_at, "coordinateFrame": "ICRS", "nativeCoordinateFrame": "J2000", "ordering": "NESTED",
        "queryPagesComplete": True, "inventoryComplete": False,
        "scope": {"releaseDescription": RELEASE_URL, "obsCollection": "VIKING", "dataproductType": "image", "filter": "J",
            "subtypeSelector": "blank-or-null", "officialReleaseTileCount": OFFICIAL_TILE_COUNT, "expectedRowCount": EXPECTED_ROWS,
            "expectedTileCount": EXPECTED_ROWS, "unitIdentity": "numeric ESO source filename tile suffix", "validPixelMasksChecked": False},
        "sourcePagination": {"queryPagesComplete": True, "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROWS, "tileCount": EXPECTED_ROWS,
            "dataLinkRequestedCount": EXPECTED_ROWS, "dataLinkThisCount": len(raw_links), "dataLinkErrors": 0,
            "denominator": {"status": 200, "queryStatus": "OK", "rowCount": int(denominator_rows[0]["row_count"])},
            "bandCounts": {"status": 200, "queryStatus": "OK", "J": observed_bands["J"]},
            "releaseDocument": {"status": release_status, "url": release_uri},
            "pages": [{"ref": "metadata/tap-page-001.vot", "url": source_page_url, "status": 200, "queryStatus": "OK", "rows": len(source_rows),
                "overflow": False, "firstDpId": ids[0], "lastDpId": ids[-1], "query": SOURCE_QUERY}]},
        "metadataDocuments": metadata_documents,
        "rowFiles": [{"ref": "normalized/native-rows.ndjson.gz", "sha256": row_sha, "sizeBytes": row_size, "rows": len(normalized_rows)}],
        "rowCount": len(normalized_rows),
    }
    manifest_body = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    immutable_write(output / "manifest.json", manifest_body)
    return {"sourceId": SOURCE_ID, "manifest": "manifest.json", "manifestSha256": sha256(manifest_body), "manifestSizeBytes": len(manifest_body),
        "rowCount": len(normalized_rows), "tileCount": len(tile_ids), "officialTileCount": OFFICIAL_TILE_COUNT,
        "metadataDocuments": len(metadata_documents), "dataLinkEvidenceSha256": datalink_sha, "rowSha256": row_sha, "headChecks": head_checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New immutable staging directory")
    args = parser.parse_args()
    print(json.dumps(capture(args.output), indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
