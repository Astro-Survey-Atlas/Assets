#!/usr/bin/env python3
"""Capture CFHTLS Wide T0007 image metadata only; never fetch FITS pixels."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


TAP_URL = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync"
DATA_ROOT = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/"
SOURCE_ID = "cfhtls-wide-t0007-single-band-images"
SURVEY_ID = "cfhtls"
RELEASE_ID = "cfhtls-wide"
PAGE_SIZE = 1000
MAXREC = 2000
EXPECTED_ROWS = 855
EXPECTED_FIELDS = 171
EXPECTED_BANDS = {"U": 171, "G": 171, "R": 171, "I": 171, "Z": 171}
EXPECTED_FILTERS = {
    "g.MP9401": 171, "gri": 80, "gry": 19,
    "i.MP9701": 139, "i.MP9702": 32, "r.MP9601": 171,
    "ryg": 11, "u.MP9301": 171, "z.MP9801": 171,
}
BAND_BY_FILTER = {"u.MP9301": "U", "g.MP9401": "G", "r.MP9601": "R",
                  "i.MP9701": "I", "i.MP9702": "I", "z.MP9801": "Z"}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only CFHTLS collector/1.0"
TABLE_SCHEMA_QUERY = (
    "SELECT table_name, column_name, datatype, unit, ucd, description FROM TAP_SCHEMA.columns "
    "WHERE table_name IN ('caom2.Observation','caom2.Plane','caom2.Artifact','caom2.Part','caom2.Chunk') "
    "ORDER BY table_name, column_name"
)
JOIN = (
    " FROM caom2.Observation AS o JOIN caom2.Plane AS p ON o.obsID=p.obsID "
    "JOIN caom2.Artifact AS a ON a.planeID=p.planeID"
)
SCOPE = (
    " WHERE o.collection='CFHTTERAPIX' AND o.observationID LIKE 'CFHTLS_W_%' "
    "AND p.provenance_version='T0007' AND a.productType='science' "
    "AND a.uri LIKE '%_T0007_MEDIAN.fits'"
)
SINGLE_BAND = " AND p.energy_bandpassName IN ('g.MP9401','i.MP9701','i.MP9702','r.MP9601','u.MP9301','z.MP9801')"
COUNT_QUERY = "SELECT COUNT(DISTINCT a.artifactID) AS row_count, COUNT(DISTINCT o.observationID) AS field_count" + JOIN + SCOPE + SINGLE_BAND
FILTER_COUNTS_QUERY = (
    "SELECT p.energy_bandpassName AS filter_name, COUNT(DISTINCT a.artifactID) AS artifact_count" + JOIN + SCOPE
    + " AND p.energy_bandpassName IN ('g.MP9401','gri','gry','i.MP9701','i.MP9702','r.MP9601','ryg','u.MP9301','z.MP9801')"
    " GROUP BY p.energy_bandpassName ORDER BY p.energy_bandpassName"
)
SOURCE_QUERY = (
    f"SELECT TOP {PAGE_SIZE} o.collection, o.observationID, o.obsID, p.productID, p.provenance_version, "
    "p.energy_bandpassName, p.position_bounds, p.position_dimension_naxis1, p.position_dimension_naxis2, "
    "a.artifactID, a.uri, a.productType, a.contentType, a.contentLength, a.contentChecksum, "
    "c.position_coordsys, c.position_equinox"
    + JOIN
    + " JOIN caom2.Part AS pt ON pt.artifactID=a.artifactID JOIN caom2.Chunk AS c ON c.partID=pt.partID"
    + SCOPE + SINGLE_BAND + " ORDER BY o.observationID,p.productID,a.uri"
)
REQUIRED_COLUMNS = {
    "caom2.Observation": {"obsID", "observationID", "collection"},
    "caom2.Plane": {"planeID", "productID", "provenance_version", "energy_bandpassName", "position_bounds"},
    "caom2.Artifact": {"artifactID", "planeID", "uri", "productType", "contentType", "contentLength", "contentChecksum"},
    "caom2.Part": {"artifactID", "partID"},
    "caom2.Chunk": {"partID", "position_coordsys", "position_equinox"},
}


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


def query_url(query_text: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(MAXREC), "QUERY": query_text}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def request_bytes(url: str, timeout: int = 90, retries: int = 3) -> tuple[bytes, int, str]:
    failure: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/x-votable+xml"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read(16 * 1024 * 1024 + 1)
                if len(body) > 16 * 1024 * 1024:
                    raise ValueError("CADC metadata response exceeded its byte budget")
                return body, response.status, response.url
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


def local_name(item: ET.Element) -> str:
    return str(item.tag).rsplit("}", 1)[-1]


def parse_votable(body: bytes) -> tuple[list[str], list[dict[str, str]], bool]:
    root = ET.fromstring(body)
    statuses = [item.get("value", "") for item in root.iter()
                if local_name(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    if "ERROR" in statuses or "OK" not in statuses:
        raise ValueError(f"CADC TAP QUERY_STATUS={statuses}")
    if "OVERFLOW" in statuses:
        raise ValueError("CADC TAP returned an overflowed response")
    table = next((item for item in root.iter() if local_name(item) == "TABLE"), None)
    if table is None:
        raise ValueError("CADC TAP VOTable has no TABLE")
    fields = [field.get("name", "").strip().lower() for field in table if local_name(field) == "FIELD"]
    if not fields or len(fields) != len(set(fields)):
        raise ValueError("CADC TAP VOTable fields are missing or duplicated")
    tabledata = next((item for item in table.iter() if local_name(item) == "TABLEDATA"), None)
    if tabledata is None:
        raise ValueError("CADC TAP response is not TABLEDATA")
    rows: list[dict[str, str]] = []
    for tr in tabledata:
        if local_name(tr) != "TR":
            continue
        values = [(cell.text or "").strip() for cell in tr if local_name(cell) == "TD"]
        if len(values) != len(fields):
            raise ValueError("CADC TAP row width differs from its FIELD declaration")
        rows.append(dict(zip(fields, values)))
    return fields, rows, False


def query(query_text: str, fetch=request_bytes, timeout: int = 90) -> tuple[bytes, list[str], list[dict[str, str]], str]:
    url = query_url(query_text)
    body, status, response_url = fetch(url, timeout)
    parsed = urllib.parse.urlsplit(response_url)
    if status != 200 or parsed.scheme != "https" or parsed.hostname != "ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca":
        raise ValueError(f"CADC TAP returned unexpected HTTP/source identity: {status} {response_url}")
    fields, rows, _ = parse_votable(body)
    return body, fields, rows, response_url


def document_ref(root: Path, path: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "sha256": sha256(body), "sizeBytes": len(body), "url": url}


def normalize_row(values: dict[str, str]) -> dict:
    observation_id = values.get("observationid", "").strip()
    product_id = values.get("productid", "").strip()
    passband = values.get("energy_bandpassname", "").strip()
    band = BAND_BY_FILTER.get(passband)
    raw_bounds = values.get("position_bounds", "").strip()
    tokens = raw_bounds.split()
    if not observation_id.startswith("CFHTLS_W_") or not product_id.startswith("CFHTLS_W_"):
        raise ValueError("CADC row is not a CFHTLS Wide identity")
    if passband not in BAND_BY_FILTER or not tokens or tokens[0].lower() != "polygon" or len(tokens[1:]) < 6 or len(tokens[1:]) % 2:
        raise ValueError("CFHTLS row has an unsupported band or source polygon")
    for index, token in enumerate(tokens[1:]):
        number = float(token)
        invalid = not 0 <= number <= 360 if index % 2 == 0 else not -90 <= number <= 90
        if invalid:
            raise ValueError("CFHTLS polygon coordinate is outside ICRS bounds")
    if values.get("position_coordsys", "").upper() != "ICRS" or float(values.get("position_equinox", "nan")) != 2000:
        raise ValueError("CFHTLS image geometry is not corroborated as ICRS by its CAOM Chunk")
    if values.get("collection", "") != "CFHTTERAPIX" or values.get("provenance_version", "") != "T0007":
        raise ValueError("CFHTLS row is outside the locked TERAPIX T0007 scope")
    if values.get("producttype", "").lower() != "science" or values.get("contenttype", "").lower() != "application/fits":
        raise ValueError("CFHTLS row is not a science FITS artifact")
    artifact_uri = values.get("uri", "")
    match = re.fullmatch(r"cadc:CFHTTERAPIX/(.+_T0007_MEDIAN\.fits)", artifact_uri)
    if not match or ".." in match.group(1):
        raise ValueError("CFHTLS row has an unsupported source-listed CADC artifact URI")
    artifact_path = match.group(1)
    filename = artifact_path.rsplit("/", 1)[-1]
    if product_id + ".fits" != filename:
        raise ValueError("CFHTLS productID does not match the source artifact filename")
    try:
        content_length = int(values["contentlength"])
    except (KeyError, ValueError) as error:
        raise ValueError("CFHTLS source artifact has no valid byte length") from error
    content_checksum = values.get("contentchecksum", "").lower()
    if content_length < 1 or not re.fullmatch(r"md5:[0-9a-f]{32}", content_checksum):
        raise ValueError("CFHTLS source artifact lacks its upstream length or MD5 identity")
    encoded_path = "/".join(urllib.parse.quote(part, safe="-_.!~*'()") for part in artifact_path.split("/"))
    direct_uri = DATA_ROOT + encoded_path
    s_region = "POLYGON ICRS " + " ".join(tokens[1:])
    try:
        dimensions = [int(values.get("position_dimension_naxis1", "")), int(values.get("position_dimension_naxis2", ""))]
    except ValueError:
        dimensions = []
    return {
        "unitId": observation_id,
        "sRegion": s_region,
        "bands": [band],
        "filename": filename,
        "accessUris": [{"sourceId": "cadc-cfht-terapix", "uri": direct_uri, "fileName": filename, "accessType": "file", "band": band}],
        "sourceMetadata": {
            "collection": "CFHTTERAPIX", "observationId": observation_id,
            "productId": product_id, "provenanceVersion": "T0007",
            "energyBandpassName": passband, "artifactId": values.get("artifactid", ""),
            "artifactUri": artifact_uri, "artifactProductType": "science",
            "contentType": values["contenttype"], "contentLength": content_length,
            "contentChecksum": content_checksum, "positionBounds": raw_bounds,
            "chunkCoordinateSystem": "ICRS", "positionEquinox": 2000,
            "geometrySource": "caom2.Plane.position_bounds corroborated by joined caom2.Chunk.position_coordsys",
            "positionDimensions": dimensions or None, "validPixelMasksChecked": False,
            "accessSemantics": "CADC public whole-file API derived from the source cadc: artifact URI",
            "availabilityChecked": False,
        },
    }


def count_record(rows: list[dict[str, str]]) -> dict[str, int]:
    if len(rows) != 1:
        raise ValueError("CADC denominator query did not return exactly one row")
    row = rows[0]
    return {"rowCount": int(row["row_count"]), "fieldCount": int(row["field_count"])}


def filter_counts(rows: list[dict[str, str]]) -> dict[str, int]:
    counts = {row["filter_name"]: int(row["artifact_count"]) for row in rows}
    if counts != EXPECTED_FILTERS:
        raise ValueError(f"CFHTLS T0007 passband counts changed: {counts}")
    return counts


def acquire(output: Path, timeout: int = 90, fetch=request_bytes) -> dict:
    schema_body, schema_fields, schema_rows, schema_url = query(TABLE_SCHEMA_QUERY, fetch, timeout)
    if not {"table_name", "column_name", "datatype", "unit", "ucd", "description"}.issubset(schema_fields):
        raise ValueError("CADC TAP schema response is missing declared metadata columns")
    schema = {table: set() for table in REQUIRED_COLUMNS}
    for row in schema_rows:
        table = row["table_name"]
        if table in schema:
            schema[table].add(row["column_name"])
    if any(not columns.issubset(schema[table]) for table, columns in REQUIRED_COLUMNS.items()):
        raise ValueError("CADC CAOM schema no longer exposes the required image or WCS metadata")

    before_body, _, before_rows, before_url = query(COUNT_QUERY, fetch, timeout)
    before = count_record(before_rows)
    filter_before_body, _, filter_before_rows, filter_before_url = query(FILTER_COUNTS_QUERY, fetch, timeout)
    before_filters = filter_counts(filter_before_rows)
    page_body, _, rows, page_url = query(SOURCE_QUERY, fetch, timeout)
    if len(rows) != EXPECTED_ROWS:
        raise ValueError(f"CFHTLS source selector returned {len(rows)} files, expected {EXPECTED_ROWS}")
    if len({row.get("productid") for row in rows}) != EXPECTED_ROWS:
        raise ValueError("CFHTLS CAOM page contains duplicate product IDs")
    normalized = [normalize_row(row) for row in rows]
    fields = {row["unitId"] for row in normalized}
    bands = {band: sum(item["bands"] == [band] for item in normalized) for band in EXPECTED_BANDS}
    if len(fields) != EXPECTED_FIELDS or bands != EXPECTED_BANDS:
        raise ValueError(f"CFHTLS source file and field counts do not reconcile: fields={len(fields)}, bands={bands}")
    page_filters: dict[str, int] = {}
    for row in rows:
        value = row["energy_bandpassname"]
        page_filters[value] = page_filters.get(value, 0) + 1
    expected_single_band = {key: value for key, value in EXPECTED_FILTERS.items() if key in BAND_BY_FILTER}
    if page_filters != expected_single_band:
        raise ValueError(f"CFHTLS single-band file counts do not reconcile: {page_filters}")

    after_body, _, after_rows, after_url = query(COUNT_QUERY, fetch, timeout)
    after = count_record(after_rows)
    filter_after_body, _, filter_after_rows, filter_after_url = query(FILTER_COUNTS_QUERY, fetch, timeout)
    after_filters = filter_counts(filter_after_rows)
    if before != after or before_filters != after_filters or before != {"rowCount": EXPECTED_ROWS, "fieldCount": EXPECTED_FIELDS}:
        raise ValueError("CFHTLS source denominators changed during capture")

    output.mkdir(parents=True, exist_ok=False)
    raw_documents = [
        ("metadata/table-schema.vot", schema_body, schema_url),
        ("metadata/count-before.vot", before_body, before_url),
        ("metadata/filter-counts-before.vot", filter_before_body, filter_before_url),
        ("metadata/tap-page-001.vot", page_body, page_url),
        ("metadata/count-after.vot", after_body, after_url),
        ("metadata/filter-counts-after.vot", filter_after_body, filter_after_url),
    ]
    metadata_documents = []
    for ref, body, url in raw_documents:
        path = output / ref
        immutable_write(path, body)
        metadata_documents.append(document_ref(output, path, url))
    row_ref = "normalized/native-rows.ndjson.gz"
    row_path = output / row_ref
    row_bytes = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in normalized).encode("utf-8")
    compressed = gzip.compress(row_bytes, mtime=0)
    immutable_write(row_path, compressed)
    row_file = document_ref(output, row_path, TAP_URL)
    page_doc = metadata_documents[3]
    captured = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "cadc-caom-cfhtls",
        "surveyId": SURVEY_ID, "releaseId": RELEASE_ID, "capturedAt": captured,
        "coordinateFrame": "ICRS", "nativeCoordinateFrame": "ICRS", "ordering": "NESTED",
        "inventoryComplete": True, "queryPagesComplete": True, "rowCount": len(normalized),
        "scope": {
            "collection": "CFHTTERAPIX", "provenanceVersion": "T0007", "observationPattern": "CFHTLS_W_%",
            "singleBandMedianImagesOnly": True, "fullArchiveInventory": False,
            "expectedRowCount": EXPECTED_ROWS, "expectedFieldCount": EXPECTED_FIELDS,
            "bandCounts": EXPECTED_BANDS, "filterCounts": EXPECTED_FILTERS,
            "excludedRgbCount": sum(EXPECTED_FILTERS[key] for key in ("gri", "gry", "ryg")),
            "geometrySource": "caom2.Plane.position_bounds corroborated per file by caom2.Chunk.position_coordsys=ICRS",
            "validPixelMasksChecked": False, "wholeFileAccess": True,
        },
        "sourcePagination": {
            "queryPagesComplete": True, "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROWS,
            "denominatorBefore": {"status": 200, "queryStatus": "OK", **before},
            "filterCountsBefore": {"status": 200, "queryStatus": "OK", "counts": before_filters},
            "denominatorAfter": {"status": 200, "queryStatus": "OK", **after},
            "filterCountsAfter": {"status": 200, "queryStatus": "OK", "counts": after_filters},
            "denominatorsStable": True,
            "pages": [{"page": 1, "query": SOURCE_QUERY, "url": page_url, "status": 200,
                       "queryStatus": "OK", "overflow": False, "rows": len(rows),
                       "sha256": page_doc["sha256"], "sizeBytes": page_doc["sizeBytes"]}],
        },
        "metadataDocuments": metadata_documents,
        "rowFiles": [{**row_file, "ref": row_ref, "rows": len(normalized)}],
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    manifest = acquire(args.output, timeout=args.timeout)
    print(f"Captured {manifest['rowCount']} CFHTLS T0007 median images across {manifest['scope']['expectedFieldCount']} fields; inventoryComplete=true within this selector")


if __name__ == "__main__":
    main()
