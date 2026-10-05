#!/usr/bin/env python3
"""Capture the complete DECaPS DR2 SIAv1 CCD metadata inventory from NOIRLab TAP."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


SOURCE_URL = "https://datalab.noirlab.edu/tap/sync"
SOURCE_ID = "decaps-dr2-native-ccds"
SURVEY_ID = "decaps"
RELEASE_ID = "decaps-dr2"
FILTERS = ["g", "i", "r", "Y", "z"]
EXPECTED_ROW_COUNT = 1_065_941
EXPECTED_BAND_COUNTS = {"g": 222_948, "i": 213_595, "r": 220_344, "Y": 198_019, "z": 211_035}
PAGE_SIZE = 5000
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
VOTABLE_NS = "http://www.ivoa.net/xml/VOTable/v1.3"
ROW_FIELDS = [
    "obs_collection", "propid", "obs_id", "obs_pub_did", "access_url", "access_format", "access_estsize",
    "filter", "im_naxis1", "im_naxis2", "wcsaxes1", "wcsaxes2", "date_obs", "mjd_obs", "expnum", "exptime",
    "fileref", "proctype", "prodtype", "obstype", "telescope", "instrument_name", "object",
    "ra1", "dec1", "ra2", "dec2", "ra3", "dec3", "ra4", "dec4",
]
SOURCE_QUERY = (
    "SELECT " + ", ".join(ROW_FIELDS) + " FROM ivoa_decaps_dr2.siav1 "
    "WHERE filter IN ('g','i','r','Y','z') ORDER BY obs_pub_did"
)
SCHEMA_QUERY = (
    "SELECT column_name, description, unit, ucd, utype FROM TAP_SCHEMA.columns "
    "WHERE table_name = 'ivoa_decaps_dr2.siav1' AND column_name IN "
    "(" + ",".join(f"'{name}'" for name in ROW_FIELDS) + ") ORDER BY column_name"
)
COUNT_QUERY = "SELECT COUNT(*) AS n FROM ivoa_decaps_dr2.siav1 WHERE filter IN ('g','i','r','Y','z')"
BAND_COUNTS_QUERY = (
    "SELECT filter, COUNT(*) AS n FROM ivoa_decaps_dr2.siav1 "
    "WHERE filter IN ('g','i','r','Y','z') GROUP BY filter ORDER BY filter"
)
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only DECaPS DR2 collector/1.0"


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def immutable_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to replace different captured evidence: {path}")
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def file_reference(root: Path, path: Path, url: str) -> dict:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": digest.hexdigest(), "sizeBytes": size}


def tap_url(query: str, maxrec: int) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(maxrec), "QUERY": query}
    return SOURCE_URL + "?" + urllib.parse.urlencode(params)


def request_bytes(url: str, timeout: int = 90) -> tuple[bytes, str, int]:
    request = urllib.request.Request(url, headers={"Accept": "application/x-votable+xml", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if response.status != 200 or len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("NOIRLab TAP response exceeded its HTTP or metadata-size contract")
        return body, response.url, response.status


def parse_votable(body: bytes) -> tuple[list[str], list[dict[str, str]]]:
    root = ET.fromstring(body)
    local_name = lambda element: str(element.tag).rsplit("}", 1)[-1]
    statuses = [item for item in root.iter() if local_name(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    status = next((item for item in statuses if item.get("value") != "OK"), statuses[0] if statuses else None)
    if status is None or status.get("value") != "OK":
        value = status.get("value") if status is not None else "missing"
        detail = (status.text or "").strip() if status is not None else ""
        raise ValueError(f"NOIRLab TAP QUERY_STATUS={value}: {detail}")
    if any(item.get("value") == "OVERFLOW" for item in statuses):
        raise ValueError("NOIRLab TAP reported an overflowed result")
    table = next((item for item in root.iter() if local_name(item) == "TABLE"), None)
    if table is None:
        raise ValueError("NOIRLab TAP VOTable has no table")
    fields = [field.get("name", "").strip().lower() for field in table if local_name(field) == "FIELD"]
    if not fields or len(fields) != len(set(fields)):
        raise ValueError("NOIRLab TAP field names are missing or duplicated")
    data = next((item for item in table if local_name(item) == "DATA"), None)
    tabledata = next((item for item in data if local_name(item) == "TABLEDATA"), None) if data is not None else None
    if tabledata is None:
        raise ValueError("NOIRLab TAP response is not VOTable TABLEDATA")
    rows = []
    for tr in tabledata:
        if local_name(tr) != "TR":
            continue
        values = [(cell.text or "").strip() for cell in tr if local_name(cell) == "TD"]
        if len(values) != len(fields):
            raise ValueError("NOIRLab TAP row width differs from its FIELD declaration")
        rows.append(dict(zip(fields, values)))
    return fields, rows


def normalize_row(values: dict[str, str]) -> dict:
    publisher_did = values["obs_pub_did"].strip()
    match = re.fullmatch(r"ivo://datalab\.noirlab/decaps_dr2/([A-Za-z0-9_.-]+\.fits\.fz)#(\d+)", publisher_did)
    if not match:
        raise ValueError("DECaPS row has an invalid CCD publisher identity")
    filename, extension = match.groups()
    filter_name = values["filter"].strip()
    if values["obs_collection"] != "DECaPS DR2" or filter_name not in FILTERS:
        raise ValueError("DECaPS row is outside the locked DR2 image collection or filter set")
    if values["fileref"].strip() != filename or values["prodtype"].strip().lower() != "image" \
            or values["obstype"].strip().lower() != "object" or values["access_format"].strip().lower() != "image/fits":
        raise ValueError("DECaPS row is not a source-identified public FITS image CCD")
    if values["wcsaxes1"].strip().upper() != "RA---TPV" or values["wcsaxes2"].strip().upper() != "DEC--TPV":
        raise ValueError("DECaPS CCD does not declare the supported ICRS TPV frame")

    corners = []
    for index in range(1, 5):
        ra = float(values[f"ra{index}"])
        dec = float(values[f"dec{index}"])
        if not (0 <= ra < 360 and -90 <= dec <= 90):
            raise ValueError("DECaPS ICRS corner is outside the celestial sphere")
        corners.append([ra, dec])
    footprint = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in corners)

    access_url = values["access_url"].strip()
    parsed = urllib.parse.urlsplit(access_url)
    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
    raw_sia_refs = [part.partition("=")[2] for part in parsed.query.split("&") if part.partition("=")[0] == "siaRef"]
    if parsed.scheme != "https" or parsed.hostname != "datalab.noirlab.edu" or parsed.path != "/svc/cutout" \
            or parsed.username or parsed.password or query.get("col") != ["decaps_dr2"] \
            or len(raw_sia_refs) != 1 or urllib.parse.unquote(raw_sia_refs[0]) != filename \
            or query.get("extn") != [extension] or any(key.upper() in {"POS", "SIZE"} for key in query):
        raise ValueError("DECaPS access URL must identify the full CCD image without POS/SIZE cutout parameters")

    band = filter_name.upper()
    unit_id = f"{filename}#{extension}"
    return {
        "unitId": unit_id,
        "sRegion": footprint,
        "bands": [band],
        "filename": filename,
        "accessUris": [{"uri": access_url, "fileName": filename, "band": band, "accessType": "file"}],
        "sourceMetadata": {
            "publisherDid": publisher_did,
            "fileRef": filename,
            "extension": int(extension),
            "filter": band,
            "exposureNumber": int(values["expnum"]),
            "observationId": values["obs_id"],
            "dateObserved": values["date_obs"],
            "exposureSeconds": float(values["exptime"]),
            "estimatedSizeKiB": int(values["access_estsize"]),
            "dimensions": [int(values["im_naxis1"]), int(values["im_naxis2"])],
            "telescope": values["telescope"],
            "instrument": values["instrument_name"],
            "coordinateFrame": "ICRS",
            "wcsProjection": "TPV",
            "geometrySource": "NOIRLab ivoa_decaps_dr2.siav1 CCD ICRS corner columns",
            "cornersIcrs": corners,
            "footprint": footprint,
            "accessSemantics": "source-listed full DECaPS CCD FITS extension; POS/SIZE cutout parameters absent",
        },
    }


def save_metadata(root: Path, relative: str, body: bytes, url: str) -> dict:
    path = root / relative
    immutable_write(path, body)
    return file_reference(root, path, url)


def query_count(fetch, timeout: int, query: str, relative: str, output: Path) -> tuple[dict, dict]:
    url = tap_url(query, 10)
    body, final_url, status = fetch(url, timeout)
    fields, rows = parse_votable(body)
    if status != 200 or fields != ["n"] or len(rows) != 1:
        raise ValueError("DECaPS SIAv1 denominator query returned an invalid response")
    result = {"status": status, "queryStatus": "OK", "rowCount": int(rows[0]["n"])}
    return result, save_metadata(output, relative, body, final_url)


def query_band_counts(fetch, timeout: int, relative: str, output: Path) -> tuple[dict, dict]:
    url = tap_url(BAND_COUNTS_QUERY, 100)
    body, final_url, status = fetch(url, timeout)
    fields, rows = parse_votable(body)
    counts = {row["filter"]: int(row["n"]) for row in rows}
    if status != 200 or fields != ["filter", "n"] or counts != EXPECTED_BAND_COUNTS:
        raise ValueError("DECaPS SIAv1 per-filter counts differ from the locked complete DR2 table")
    return {"status": status, "queryStatus": "OK", "counts": counts}, save_metadata(output, relative, body, final_url)


def acquire(output: Path, timeout: int = 90, fetch=request_bytes) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    metadata_documents = []

    schema_url = tap_url(SCHEMA_QUERY, 100)
    schema_body, final_url, status = fetch(schema_url, timeout)
    schema_fields, schema_rows = parse_votable(schema_body)
    schema_names = {row["column_name"].lower() for row in schema_rows}
    if status != 200 or not {"column_name", "description"}.issubset(schema_fields) or not set(ROW_FIELDS).issubset(schema_names):
        raise ValueError("DECaPS TAP schema does not declare every locked CCD identity, access and ICRS corner field")
    metadata_documents.append(save_metadata(output, "metadata/table-schema.votable.xml", schema_body, final_url))

    count_before, count_before_file = query_count(fetch, timeout, COUNT_QUERY, "metadata/count-before.votable.xml", output)
    bands_before, bands_before_file = query_band_counts(fetch, timeout, "metadata/filter-counts-before.votable.xml", output)
    metadata_documents.extend([count_before_file, bands_before_file])
    if count_before["rowCount"] != EXPECTED_ROW_COUNT:
        raise ValueError("DECaPS SIAv1 row count differs from the locked 1,065,941-row DR2 roster")

    row_path = output / "normalized/native-rows.ndjson.gz"
    row_path.parent.mkdir(parents=True, exist_ok=True)
    page_receipts = []
    seen = set()
    row_count = 0
    observed_bands = Counter()
    cursor = None
    with row_path.open("wb") as raw_output, gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as rows_output:
        for page_number in range(1, 4097):
            continuation = f" AND obs_pub_did > '{cursor}'" if cursor else ""
            query = f"SELECT TOP {PAGE_SIZE} {', '.join(ROW_FIELDS)} FROM ivoa_decaps_dr2.siav1 WHERE filter IN ('g','i','r','Y','z'){continuation} ORDER BY obs_pub_did"
            url = tap_url(query, PAGE_SIZE)
            body, final_url, status = fetch(url, timeout)
            fields, rows = parse_votable(body)
            if status != 200 or fields != ROW_FIELDS or len(rows) > PAGE_SIZE:
                raise ValueError("DECaPS keyset page has an unexpected HTTP status, columns or size")
            first_id = rows[0]["obs_pub_did"] if rows else None
            last_id = rows[-1]["obs_pub_did"] if rows else None
            previous = cursor
            for values in rows:
                publisher = values["obs_pub_did"]
                if previous is not None and publisher <= previous:
                    raise ValueError("DECaPS keyset pages contain unordered or duplicate publisher identities")
                if publisher in seen:
                    raise ValueError("DECaPS SIAv1 contains a duplicate CCD publisher identity")
                normalized = normalize_row(values)
                seen.add(publisher)
                observed_bands[values["filter"]] += 1
                row_count += 1
                rows_output.write((json.dumps(normalized, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8"))
                previous = publisher
            page_ref = save_metadata(output, f"metadata/tap-page-{page_number:04d}.votable.xml", body, final_url)
            page_receipts.append({"page": page_number, "query": query, "url": final_url, "status": status, "queryStatus": "OK",
                                  "rows": len(rows), "firstPublisherDid": first_id, "lastPublisherDid": last_id,
                                  "sha256": page_ref["sha256"], "sizeBytes": page_ref["sizeBytes"]})
            metadata_documents.append(page_ref)
            if len(rows) < PAGE_SIZE:
                break
            if not last_id:
                raise ValueError("DECaPS nonterminal page has no continuation identity")
            cursor = last_id
        else:
            raise ValueError("DECaPS acquisition exceeded the page safety limit")

    count_after, count_after_file = query_count(fetch, timeout, COUNT_QUERY, "metadata/count-after.votable.xml", output)
    bands_after, bands_after_file = query_band_counts(fetch, timeout, "metadata/filter-counts-after.votable.xml", output)
    metadata_documents.extend([count_after_file, bands_after_file])
    if row_count != EXPECTED_ROW_COUNT or len(seen) != EXPECTED_ROW_COUNT or observed_bands != EXPECTED_BAND_COUNTS:
        raise ValueError("DECaPS captured identities or band counts differ from the complete SIAv1 denominator")
    if count_after != count_before or bands_after["counts"] != bands_before["counts"]:
        raise ValueError("DECaPS source table changed while its metadata pages were being captured")

    row_file = file_reference(output, row_path, SOURCE_URL)
    captured = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "noirlab-decaps-tap",
        "surveyId": SURVEY_ID, "releaseId": RELEASE_ID, "capturedAt": captured,
        "coordinateFrame": "ICRS", "nativeCoordinateFrame": "ICRS", "ordering": "NESTED",
        "sourceUrl": SOURCE_URL, "query": SOURCE_QUERY,
        "scope": {
            "table": "ivoa_decaps_dr2.siav1", "collection": "DECaPS DR2", "filters": FILTERS,
            "expectedRowCount": EXPECTED_ROW_COUNT, "expectedCcdCount": EXPECTED_ROW_COUNT,
            "bandCounts": EXPECTED_BAND_COUNTS, "completeTableInventory": True,
            "fileIdentity": "NOIRLab obs_pub_did including FITS extension; CCD rows may share a multi-extension FITS file",
            "accessSemantics": "source-listed Data Lab full CCD-extension FITS service URL without POS/SIZE cutout parameters",
            "geometryPrecision": "estimated ICRS TPV frame corners; valid-pixel masks and edge curvature are unchecked",
            "individualFileAvailabilityVerified": False,
        },
        "sourcePagination": {
            "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROW_COUNT, "expectedCcdCount": EXPECTED_ROW_COUNT,
            "queryPagesComplete": True, "denominatorBefore": count_before, "denominatorAfter": count_after,
            "filterCountsBefore": bands_before, "filterCountsAfter": bands_after, "denominatorsStable": True,
            "pages": page_receipts,
        },
        "queryPagesComplete": True, "inventoryComplete": True, "metadataDocuments": metadata_documents,
        "rowFiles": [{**row_file, "rows": row_count}], "rowCount": row_count,
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    manifest_ref = file_reference(output, manifest_path, SOURCE_URL)
    return {"manifest": manifest, "manifestFile": manifest_ref, "rowFile": row_file, "ccdCount": len(seen), "bandCounts": dict(observed_bands)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", default=90, type=int)
    args = parser.parse_args()
    result = acquire(args.output, timeout=args.timeout)
    print(json.dumps({"output": str(args.output), "manifest": result["manifestFile"], "rowFile": result["rowFile"],
                      "ccdCount": result["ccdCount"], "bandCounts": result["bandCounts"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
