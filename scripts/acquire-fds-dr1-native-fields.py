#!/usr/bin/env python3
"""Capture FDS DR1 science-image metadata and ESO DataLink evidence only."""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


TAP_URL = "https://archive.eso.org/tap_obs/sync"
RELEASE_URL = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/157"
SOURCE_URL = "https://archive.eso.org/tap_obs/sync"
SOURCE_ID = "fds-dr1-science-fields"
SURVEY_ID = "fds"
RELEASE_ID = "fds-dr1"
PAGE_SIZE = 5000
EXPECTED_ROWS = 97
EXPECTED_FIELDS = 26
EXPECTED_BANDS = {"u_SDSS": 20, "g_SDSS": 26, "r_SDSS": 26, "i_SDSS": 25}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only FDS DR1 collector/1.0"
SOURCE_QUERY = (
    "SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description "
    "FROM ivoa.ObsCore WHERE obs_collection = 'FDS' AND release_description = "
    f"'{RELEASE_URL}' AND dataproduct_type = 'image' ORDER BY dp_id"
)
DENOMINATOR_QUERY = (
    "SELECT COUNT(*) AS row_count FROM ivoa.ObsCore WHERE obs_collection = 'FDS' "
    f"AND release_description = '{RELEASE_URL}' AND dataproduct_type = 'image'"
)
BAND_COUNTS_QUERY = (
    "SELECT filter, COUNT(*) AS n FROM ivoa.ObsCore WHERE obs_collection = 'FDS' "
    f"AND release_description = '{RELEASE_URL}' AND dataproduct_type = 'image' GROUP BY filter ORDER BY filter"
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def immutable_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to replace different evidence: {path}")
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def request_bytes(url: str, timeout: int = 90, accept: str = "*/*") -> tuple[bytes, int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.status, response.url


def tap_url(query: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(PAGE_SIZE), "QUERY": query}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def parse_votable(body: bytes) -> tuple[str, list[str], list[dict[str, str]]]:
    root = ET.fromstring(body)
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    statuses = [item for item in root.iter() if local(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    if any(item.get("value") == "OVERFLOW" for item in statuses):
        raise ValueError("ESO TAP reported an overflowed response")
    status = next(iter(statuses), None)
    if status is None or status.get("value") != "OK":
        value = status.get("value") if status is not None else "missing"
        raise ValueError(f"ESO TAP QUERY_STATUS={value}")
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
    return "OK", fields, rows


def query(query_text: str) -> tuple[bytes, list[dict[str, str]], str]:
    body, status, response_url = request_bytes(tap_url(query_text), accept="application/x-votable+xml")
    if status != 200:
        raise ValueError(f"ESO TAP returned HTTP {status}")
    _, _, rows = parse_votable(body)
    return body, rows, response_url


def transform_j2000_polygon(value: str) -> str:
    parts = value.split()
    if len(parts) < 8 or parts[0].upper() != "POLYGON" or parts[1].upper() != "J2000" or (len(parts) - 2) % 2:
        raise ValueError("FDS geometry must be a complete POLYGON J2000")
    try:
        coordinates = [float(part) for part in parts[2:]]
    except ValueError as error:
        raise ValueError("FDS polygon contains a non-numeric coordinate") from error
    if any(not 0 <= ra < 360 or not -90 <= dec <= 90 for ra, dec in zip(coordinates[0::2], coordinates[1::2])):
        raise ValueError("FDS polygon coordinate is outside the celestial sphere")
    sky = SkyCoord(ra=coordinates[0::2] * u.deg, dec=coordinates[1::2] * u.deg, frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    vertices = " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in zip(sky.ra.wrap_at(360 * u.deg).deg, sky.dec.deg))
    return f"POLYGON ICRS {vertices}"


def parse_datalink(body: bytes, dp_id: str, source_filename: str) -> tuple[dict[str, str], dict[str, str]]:
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
    weights = [record for record in records if record.get("semantics") == "#auxiliary"]
    if len(science) != 1 or len(weights) != 1:
        raise ValueError(f"ESO DataLink must identify one science image and one weight map for {dp_id}")
    image, weight = science[0], weights[0]
    expected_uri = f"https://dataportal.eso.org/dataPortal/file/{dp_id}"
    if image.get("eso_category") != "SCIENCE.IMAGE" or image.get("eso_origfile") != source_filename or image.get("access_url") != expected_uri:
        raise ValueError(f"ESO DataLink #this does not match the source science image {dp_id}")
    if weight.get("eso_category") != "ANCILLARY.WEIGHTMAP" or not re.fullmatch(r"FDS_F\d{1,2}_OCAM_[ugri]_SDSS_wei\.fits", weight.get("eso_origfile", ""), re.I):
        raise ValueError(f"ESO DataLink #auxiliary is not the paired FDS weight map {dp_id}")
    weight_url = weight.get("access_url", "")
    parsed_weight = urllib.parse.urlsplit(weight_url)
    if parsed_weight.scheme != "https" or parsed_weight.hostname != "dataportal.eso.org" or not re.fullmatch(r"/dataPortal/file/ADP\.[A-Za-z0-9.:-]+", parsed_weight.path):
        raise ValueError(f"ESO DataLink weight-map URI is not an official single-file URI {dp_id}")
    return image, weight


def normalize_row(row: dict[str, str], image: dict[str, str], weight: dict[str, str], data_link_url: str, response_sha: str) -> dict:
    unit_id = row["target_name"]
    dp_id = row["dp_id"]
    source_filter = row["filter"]
    band = source_filter[:1].upper()
    filename = image["eso_origfile"]
    if not re.fullmatch(r"FDS_F\d{1,2}", unit_id) or source_filter not in EXPECTED_BANDS:
        raise ValueError("FDS row has an unsupported native field or filter")
    if row["release_description"] != RELEASE_URL or not re.fullmatch(r"ADP\.[A-Za-z0-9.:-]+", dp_id):
        raise ValueError("FDS row is outside its frozen DR1 identity")
    if not re.fullmatch(rf"{re.escape(unit_id)}_OCAM_{band.lower()}_SDSS_sci\.fits\.fz", filename, re.I):
        raise ValueError("FDS DataLink filename does not match the field and source filter")
    data_link = urllib.parse.urlsplit(data_link_url)
    expected_id = f"ivo://eso.org/ID?{dp_id}"
    if data_link.scheme != "https" or data_link.hostname != "archive.eso.org" or data_link.path != "/datalink/links" or urllib.parse.parse_qs(data_link.query).get("ID") != [expected_id]:
        raise ValueError("FDS DataLink metadata URL is not the source-listed request for this dp_id")
    return {
        "unitId": unit_id,
        "sRegion": transform_j2000_polygon(row["s_region"]),
        "bands": [band],
        "filename": filename,
        "accessUris": [{"uri": image["access_url"], "fileName": filename, "band": band, "accessType": "file"}],
        "sourceMetadata": {
            "dpId": dp_id,
            "obsId": row.get("obs_id", ""),
            "obsCreatorDid": row.get("obs_creator_did", ""),
            "targetName": unit_id,
            "sourceTargetName": unit_id,
            "obsCollection": "FDS",
            "dataproductType": "image",
            "filter": source_filter,
            "nativeCoordinateFrame": "J2000",
            "sourceSRegion": row["s_region"],
            "geometryTransform": "FK5(equinox=J2000) polygon vertices transformed to ICRS with Astropy",
            "releaseDescription": RELEASE_URL,
            "dataLinkUrl": data_link_url,
            "dataLinkUri": image["access_url"],
            "dataLinkResponseSha256": response_sha,
            "dataLinkSemantics": "#this",
            "dataLinkCategory": image["eso_category"],
            "dataLinkFileName": image["eso_origfile"],
            "esoOriginalFile": image["eso_origfile"],
            "dataLinkListed": True,
            "contentLength": int(image["content_length"]) if image.get("content_length", "").isdigit() else None,
            "ancillaryWeightMap": {"semantics": "#auxiliary", "category": weight["eso_category"], "fileName": weight["eso_origfile"], "uri": weight["access_url"]},
            "accessSemantics": "whole-science-image",
        },
    }


def probe_head(uri: str, timeout: int = 45) -> dict[str, object]:
    request = urllib.request.Request(uri, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {"uri": uri, "status": response.status, "contentType": response.headers.get("Content-Type"), "contentLength": response.headers.get("Content-Length"), "method": "HEAD"}
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        return {"uri": uri, "status": None, "error": str(reason)[:300], "method": "HEAD"}


def write_gzip_jsonl(path: Path, rows: list[dict]) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    body = path.read_bytes()
    return sha256(body), len(body)


def capture(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    release_pdf, release_status, release_uri = request_bytes(RELEASE_URL, accept="application/pdf,*/*")
    if release_status != 200 or not release_pdf.startswith(b"%PDF-"):
        raise ValueError("ESO FDS DR1 release description did not return the expected PDF")
    release_path = output / "metadata/release-description-157.pdf"
    immutable_write(release_path, release_pdf)

    denominator_body, denominator_rows, denominator_url = query(DENOMINATOR_QUERY)
    band_body, band_rows, band_url = query(BAND_COUNTS_QUERY)
    page_body, source_rows, page_url = query(SOURCE_QUERY)
    if len(denominator_rows) != 1 or int(denominator_rows[0]["row_count"]) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore denominator differs from the official 97-image FDS DR1 release")
    observed_bands = {row["filter"]: int(row["n"]) for row in band_rows}
    if observed_bands != EXPECTED_BANDS:
        raise ValueError(f"ESO ObsCore FDS DR1 band counts changed: {observed_bands}")
    source_rows.sort(key=lambda row: row["dp_id"])
    identifiers = [row["dp_id"] for row in source_rows]
    fields = {row["target_name"] for row in source_rows}
    if len(source_rows) != EXPECTED_ROWS or len(set(identifiers)) != EXPECTED_ROWS or len(fields) != EXPECTED_FIELDS:
        raise ValueError("ESO ObsCore FDS DR1 rows do not match the unique file/field denominator")
    for row in source_rows:
        if row["release_description"] != RELEASE_URL or not row["s_region"].upper().startswith("POLYGON J2000 "):
            raise ValueError(f"FDS DR1 row has an unexpected release or geometry declaration: {row.get('dp_id')}")

    metadata_documents: list[dict[str, object]] = []
    for relative, body, uri in [
        ("metadata/denominator.vot", denominator_body, denominator_url),
        ("metadata/band-counts.vot", band_body, band_url),
        ("metadata/tap-page-001.vot", page_body, page_url),
        ("metadata/release-description-157.pdf", release_pdf, release_uri),
    ]:
        file_path = output / relative
        immutable_write(file_path, body)
        metadata_documents.append({"ref": relative, "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": uri})

    datalink_dir = output / "metadata/datalinks"
    datalink_dir.mkdir(parents=True, exist_ok=True)
    link_results: dict[str, tuple[dict[str, str], dict[str, str], str, str, str]] = {}
    failures: list[str] = []

    def acquire_link(row: dict[str, str]) -> tuple[str, bytes, dict[str, str], dict[str, str], str, str]:
        uri = row["access_url"]
        body, status, response_uri = request_bytes(uri, timeout=90, accept="application/x-votable+xml,text/xml,*/*")
        if status != 200:
            raise ValueError(f"DataLink returned HTTP {status} for {row['dp_id']}")
        original = row["obs_creator_did"].partition("?")[2]
        if not original:
            raise ValueError(f"ObsCore row has no source filename in obs_creator_did: {row['dp_id']}")
        image, weight = parse_datalink(body, row["dp_id"], original)
        return row["dp_id"], body, image, weight, uri, response_uri

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(acquire_link, row) for row in source_rows]
        for future in concurrent.futures.as_completed(futures):
            try:
                dp_id, body, image, weight, source_uri, response_uri = future.result()
                filename = f"{dp_id}.vot"
                relative = f"metadata/datalinks/{filename}"
                immutable_write(output / relative, body)
                digest = sha256(body)
                metadata_documents.append({"ref": relative, "sha256": digest, "sizeBytes": len(body), "sourceUrl": source_uri})
                link_results[dp_id] = (image, weight, source_uri, response_uri, digest)
            except Exception as error:  # retain all failures in the failed staging receipt
                failures.append(str(error))
    metadata_documents.sort(key=lambda item: str(item["ref"]))
    if failures or len(link_results) != EXPECTED_ROWS:
        failure_doc = {"expected": EXPECTED_ROWS, "resolved": len(link_results), "errors": sorted(failures)}
        immutable_write(output / "metadata/datalink-failures.json", json.dumps(failure_doc, sort_keys=True, indent=2).encode())
        raise ValueError(f"FDS DataLink capture incomplete: {len(link_results)}/{EXPECTED_ROWS} resolved")

    normalized_rows = []
    data_link_urls = set()
    for row in source_rows:
        image, weight, data_link_url, _, digest = link_results[row["dp_id"]]
        normalized = normalize_row(row, image, weight, data_link_url, digest)
        normalized_rows.append(normalized)
        data_link_urls.add(data_link_url)
    row_path = output / "normalized/native-rows.ndjson.gz"
    row_sha, row_size = write_gzip_jsonl(row_path, normalized_rows)

    sample_rows = [source_rows[0], next(row for row in source_rows if row["dp_id"] == "ADP.2020-08-26T11:45:32.265"), source_rows[-1]]
    head_checks = [probe_head(link_results[row["dp_id"]][0]["access_url"]) for row in sample_rows]
    head_path = output / "metadata/representative-head-checks.json"
    head_body = json.dumps(head_checks, sort_keys=True, indent=2).encode()
    immutable_write(head_path, head_body)
    metadata_documents.append({"ref": "metadata/representative-head-checks.json", "sha256": sha256(head_body), "sizeBytes": len(head_body), "sourceUrl": "https://dataportal.eso.org/"})
    metadata_documents.sort(key=lambda item: str(item["ref"]))

    band_counts = {band[:1].upper(): count for band, count in observed_bands.items()}
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "eso-obscore-fds", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured_at, "coordinateFrame": "ICRS", "nativeCoordinateFrame": "J2000", "ordering": "NESTED",
        "queryPagesComplete": True, "inventoryComplete": True,
        "scope": {
            "obsCollection": "FDS", "releaseDescription": RELEASE_URL, "dataproductType": "image",
            "filters": list(EXPECTED_BANDS), "bandCounts": band_counts, "expectedRowCount": EXPECTED_ROWS,
            "expectedFieldCount": EXPECTED_FIELDS, "scienceImageRowsOnly": True, "weightMapRowsIncluded": False,
            "weightMapFileCount": EXPECTED_ROWS, "validPixelMasksChecked": False,
        },
        "sourcePagination": {
            "queryPagesComplete": True, "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROWS,
            "dataLinkRequestedCount": EXPECTED_ROWS, "dataLinkThisCount": len(data_link_urls),
            "dataLinkAuxiliaryCount": EXPECTED_ROWS, "dataLinkErrors": 0,
            "denominator": {"status": 200, "queryStatus": "OK", "rowCount": int(denominator_rows[0]["row_count"])},
            "bandCounts": {"status": 200, "queryStatus": "OK", "counts": band_counts},
            "releaseDocument": {"status": release_status, "sha256": sha256(release_pdf), "sizeBytes": len(release_pdf)},
            "pages": [{"page": 1, "status": 200, "queryStatus": "OK", "rows": len(source_rows), "overflow": False, "query": SOURCE_QUERY}],
            "accessChecks": head_checks,
        },
        "rowCount": len(normalized_rows),
        "metadataDocuments": metadata_documents,
        "rowFiles": [{"ref": "normalized/native-rows.ndjson.gz", "sha256": row_sha, "sizeBytes": row_size, "rows": len(normalized_rows)}],
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, json.dumps(manifest, sort_keys=True, indent=2).encode())
    return {"manifest": str(manifest_path), "sha256": sha256(manifest_path.read_bytes()), "sizeBytes": manifest_path.stat().st_size,
            "rowCount": len(normalized_rows), "fieldCount": len(fields), "bandCounts": band_counts,
            "headChecks": head_checks, "metadataDocuments": len(metadata_documents)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new immutable capture directory")
    args = parser.parse_args()
    result = capture(args.output)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
