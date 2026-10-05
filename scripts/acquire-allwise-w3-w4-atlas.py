#!/usr/bin/env python3
"""Capture AllWISE W3/W4 Atlas-image metadata only; never fetch FITS pixels."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
SOURCE_ID = "allwise-w3-w4-atlas"
SURVEY_ID = "allwise"
RELEASE_ID = "allwise"
PAGE_SIZE = 1000
MAXREC = 2000
EXPECTED_ROWS = 36480
EXPECTED_COADDS = 18240
EXPECTED_BAND_COUNTS = {"W3": 18240, "W4": 18240}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only AllWISE collector/1.0"
SELECT = ("coadd_id, band, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4, "
          "crval1, crval2, crpix1, crpix2, naxis1, naxis2, ctype1, ctype2, "
          "cdelt1, cdelt2, crota2, equinox, cntr")
SOURCE_QUERY = f"SELECT TOP {PAGE_SIZE} {SELECT} FROM allwise_p3am_cdd WHERE band IN (3,4) ORDER BY coadd_id, band"
DENOMINATOR_QUERY = "SELECT COUNT(*) AS row_count FROM allwise_p3am_cdd WHERE band IN (3,4)"
BAND_COUNTS_QUERY = "SELECT band, COUNT(*) AS n FROM allwise_p3am_cdd GROUP BY band ORDER BY band"
W3_DISTINCT_QUERY = "SELECT COUNT(DISTINCT coadd_id) AS n FROM allwise_p3am_cdd WHERE band = 3"
W4_DISTINCT_QUERY = "SELECT COUNT(DISTINCT coadd_id) AS n FROM allwise_p3am_cdd WHERE band = 4"
TABLE_SCHEMA_QUERY = ("SELECT column_name, datatype, description, unit, ucd FROM TAP_SCHEMA.columns "
                      "WHERE table_name = 'allwise_p3am_cdd' ORDER BY column_name")
REQUIRED_SCHEMA_COLUMNS = {
    "coadd_id", "band", "ra1", "dec1", "ra2", "dec2", "ra3", "dec3", "ra4", "dec4",
    "crval1", "crval2", "crpix1", "crpix2", "naxis1", "naxis2", "ctype1", "ctype2",
    "cdelt1", "cdelt2", "crota2", "equinox", "cntr",
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


def request_bytes(url: str, timeout: int = 90, accept: str = "application/x-votable+xml", retries: int = 3) -> tuple[bytes, int, str]:
    failure: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read(16 * 1024 * 1024 + 1)
                if len(body) > 16 * 1024 * 1024:
                    raise ValueError("AllWISE TAP metadata response exceeded its byte budget")
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
        raise ValueError(f"AllWISE TAP QUERY_STATUS={statuses}")
    if "OVERFLOW" in statuses:
        raise ValueError("AllWISE TAP returned an overflowed response")
    table = next((item for item in root.iter() if local_name(item) == "TABLE"), None)
    if table is None:
        raise ValueError("AllWISE TAP VOTable has no TABLE")
    fields = [field.get("name", "").strip().lower() for field in table if local_name(field) == "FIELD"]
    if not fields or len(fields) != len(set(fields)):
        raise ValueError("AllWISE TAP VOTable fields are missing or duplicated")
    tabledata = next((item for item in table.iter() if local_name(item) == "TABLEDATA"), None)
    if tabledata is None:
        raise ValueError("AllWISE TAP response is not TABLEDATA")
    rows: list[dict[str, str]] = []
    for tr in tabledata:
        if local_name(tr) != "TR":
            continue
        values = [(cell.text or "").strip() for cell in tr if local_name(cell) == "TD"]
        if len(values) != len(fields):
            raise ValueError("AllWISE TAP row width differs from its FIELD declaration")
        rows.append(dict(zip(fields, values)))
    return fields, rows, False


def tap_url(query: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(MAXREC), "QUERY": query}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def query(query_text: str, fetch=request_bytes, timeout: int = 90) -> tuple[bytes, list[str], list[dict[str, str]], str]:
    body, status, response_url = fetch(tap_url(query_text), timeout)
    if status != 200 or urllib.parse.urlsplit(response_url).hostname != "irsa.ipac.caltech.edu":
        raise ValueError(f"AllWISE TAP returned unexpected HTTP/source identity: {status} {response_url}")
    fields, rows, _ = parse_votable(body)
    return body, fields, rows, response_url


def required_int(row: dict[str, str], name: str) -> int:
    try:
        return int(row[name])
    except (KeyError, ValueError) as error:
        raise ValueError(f"Invalid AllWISE integer metadata field: {name}") from error


def required_float(row: dict[str, str], name: str) -> float:
    try:
        value = float(row[name])
    except (KeyError, ValueError) as error:
        raise ValueError(f"Invalid AllWISE numeric metadata field: {name}") from error
    if not math.isfinite(value):
        raise ValueError(f"Invalid AllWISE non-finite metadata field: {name}")
    return value


def normalize_row(values: dict[str, str]) -> dict:
    coadd_id = values.get("coadd_id", "").strip()
    if not re.fullmatch(r"\d{4}[pm]\d{3}_ac\d+", coadd_id, flags=re.I):
        raise ValueError("AllWISE row has an invalid native coadd_id")
    band_number = required_int(values, "band")
    if band_number not in (3, 4):
        raise ValueError("AllWISE capture contains a row outside W3/W4")
    band = f"W{band_number}"
    corners_j2000 = [[required_float(values, f"ra{index}"), required_float(values, f"dec{index}")]
                     for index in range(1, 5)]
    if any(not 0 <= ra < 360 or not -90 <= dec <= 90 for ra, dec in corners_j2000):
        raise ValueError("AllWISE source corners are outside the celestial sphere")
    coords = SkyCoord(ra=np.asarray([point[0] for point in corners_j2000]) * u.deg,
                      dec=np.asarray([point[1] for point in corners_j2000]) * u.deg,
                      frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    corners_icrs = [[float(ra), float(dec)] for ra, dec in zip(coords.ra.wrap_at(360 * u.deg).deg, coords.dec.deg)]
    footprint = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in corners_icrs)

    naxis1 = required_int(values, "naxis1")
    naxis2 = required_int(values, "naxis2")
    equinox = required_float(values, "equinox")
    ctype1 = values.get("ctype1", "").strip().upper()
    ctype2 = values.get("ctype2", "").strip().upper()
    if naxis1 != 4095 or naxis2 != 4095 or equinox != 2000 or ctype1 != "RA---SIN" or ctype2 != "DEC--SIN":
        raise ValueError("AllWISE source WCS differs from the documented J2000 SIN Atlas frames")
    wcs = {
        "naxis1": naxis1, "naxis2": naxis2,
        "crval1": required_float(values, "crval1"), "crval2": required_float(values, "crval2"),
        "crpix1": required_float(values, "crpix1"), "crpix2": required_float(values, "crpix2"),
        "ctype1": ctype1, "ctype2": ctype2,
        "cdelt1": required_float(values, "cdelt1"), "cdelt2": required_float(values, "cdelt2"),
        "crota2": required_float(values, "crota2"),
    }
    file_name = f"{coadd_id}-w{band_number}-int-3.fits"
    uri = (f"https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/"
           f"{coadd_id[:2]}/{coadd_id[:4]}/{coadd_id}/{file_name}")
    return {
        "unitId": coadd_id,
        "sRegion": footprint,
        "bands": [band],
        "filename": file_name,
        "accessUris": [{"sourceId": "irsa-allwise-ibe", "uri": uri, "fileName": file_name,
                        "accessType": "file", "band": band}],
        "sourceMetadata": {
            "table": "allwise_p3am_cdd", "coaddId": coadd_id, "band": band, "bandNumber": band_number,
            "sourceNativeFrame": "FK5(J2000)", "coordinateTransform": "FK5(equinox=J2000) to ICRS via Astropy",
            "sourceCornersJ2000": corners_j2000, "cornersIcrs": corners_icrs, "footprint": footprint,
            "geometrySource": "allwise_p3am_cdd ra1/dec1 through ra4/dec4", "equinox": 2000,
            "sourceWcs": wcs, "validPixelMasksChecked": False,
            "accessSemantics": "whole-intensity-fits", "uriRule": "official AllWISE IBE p3am_cdd path",
            "sourceCounter": values.get("cntr", ""),
        },
    }


def document_ref(root: Path, path: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body)}


def count_response(fetch, query_text: str, timeout: int) -> tuple[dict, bytes, str]:
    body, fields, rows, url = query(query_text, fetch=fetch, timeout=timeout)
    if len(rows) != 1:
        raise ValueError("AllWISE count query must return exactly one row")
    return {"status": 200, "queryStatus": "OK", "count": required_int(rows[0], fields[-1])}, body, url


def read_band_counts(fetch, timeout: int) -> tuple[dict[str, int], bytes, str]:
    body, _, rows, url = query(BAND_COUNTS_QUERY, fetch=fetch, timeout=timeout)
    counts = {f"W{required_int(row, 'band')}": required_int(row, "n") for row in rows if required_int(row, "band") in (3, 4)}
    if counts != EXPECTED_BAND_COUNTS:
        raise ValueError(f"AllWISE source band counts changed: {counts}")
    return counts, body, url


def count_snapshot(fetch, timeout: int, suffix: str) -> tuple[dict, list[tuple[str, bytes, str]]]:
    total, total_body, total_url = count_response(fetch, DENOMINATOR_QUERY, timeout)
    if total["count"] != EXPECTED_ROWS:
        raise ValueError(f"AllWISE W3/W4 denominator changed: {total['count']}")
    bands, bands_body, bands_url = read_band_counts(fetch, timeout)
    counts: dict[str, dict] = {"denominator": {**total, "rowCount": total.pop("count")},
                               "bandCounts": {"status": 200, "queryStatus": "OK", "perBand": bands}}
    docs = [(f"metadata/denominator-{suffix}.vot", total_body, total_url),
            (f"metadata/band-counts-{suffix}.vot", bands_body, bands_url)]
    for band_number, band_name in ((3, "W3"), (4, "W4")):
        query_text = W3_DISTINCT_QUERY if band_number == 3 else W4_DISTINCT_QUERY
        result, body, url = count_response(fetch, query_text, timeout)
        if result["count"] != EXPECTED_COADDS:
            raise ValueError(f"AllWISE {band_name} distinct coadd denominator changed: {result['count']}")
        counts[f"{band_name.lower()}DistinctCoadds"] = {**result, "query": query_text}
        docs.append((f"metadata/{band_name.lower()}-distinct-{suffix}.vot", body, url))
    return counts, docs


def page_query(last_coadd_id: str | None = None, last_band: int | None = None) -> str:
    if last_coadd_id is None:
        return SOURCE_QUERY
    if last_band not in (3, 4):
        raise ValueError("AllWISE keyset continuation needs a source W3/W4 band")
    start = SOURCE_QUERY.index(" FROM allwise_p3am_cdd")
    select = SOURCE_QUERY[:start]
    return (f"{select} FROM allwise_p3am_cdd WHERE band IN (3,4) AND "
            f"(coadd_id > '{last_coadd_id}' OR (coadd_id = '{last_coadd_id}' AND band > {last_band})) "
            "ORDER BY coadd_id, band")


def acquire(output: Path, timeout: int = 90, fetch=request_bytes) -> dict:
    if output.exists():
        raise FileExistsError(f"Refusing to reuse an existing capture path: {output}")
    schema_body, schema_fields, schema_rows, schema_url = query(TABLE_SCHEMA_QUERY, fetch=fetch, timeout=timeout)
    if not {"column_name", "datatype"}.issubset(schema_fields):
        raise ValueError("AllWISE TAP_SCHEMA response lacks column definitions")
    schema_columns = {row.get("column_name", "").lower() for row in schema_rows}
    if not REQUIRED_SCHEMA_COLUMNS.issubset(schema_columns):
        raise ValueError(f"AllWISE source table is missing WCS/identity columns: {sorted(REQUIRED_SCHEMA_COLUMNS - schema_columns)}")
    before, before_docs = count_snapshot(fetch, timeout, "before")

    pages: list[dict] = []
    page_documents: list[tuple[str, bytes, str]] = []
    normalized_rows: list[dict] = []
    coadds = {"W3": set(), "W4": set()}
    pairs: set[tuple[str, str]] = set()
    previous: tuple[str, int] | None = None
    while True:
        query_text = page_query(*(previous or (None, None)))
        body, _, source_rows, url = query(query_text, fetch=fetch, timeout=timeout)
        if not source_rows or len(source_rows) > PAGE_SIZE:
            raise ValueError("AllWISE TAP pagination returned an empty or over-sized continuation page")
        parsed: list[tuple[str, int, dict]] = []
        for row in source_rows:
            coadd_id = row.get("coadd_id", "").strip()
            band = required_int(row, "band")
            key = (coadd_id, band)
            if band not in (3, 4) or previous is not None and key <= previous:
                raise ValueError("AllWISE TAP page is not strictly ordered after its previous keyset")
            if parsed and key <= (parsed[-1][0], parsed[-1][1]):
                raise ValueError("AllWISE TAP page contains duplicate or unordered coadd/band keys")
            normalized = normalize_row(row)
            pair = (coadd_id, normalized["sourceMetadata"]["band"])
            if pair in pairs:
                raise ValueError("AllWISE TAP capture contains a duplicate coadd/band pair")
            pairs.add(pair)
            coadds[pair[1]].add(coadd_id)
            parsed.append((coadd_id, band, normalized))
        number = len(pages) + 1
        ref = f"metadata/tap-page-{number:03d}.vot"
        page_documents.append((ref, body, url))
        pages.append({"page": number, "query": query_text, "url": url, "status": 200, "queryStatus": "OK",
                      "overflow": False, "rows": len(parsed), "firstCoaddId": parsed[0][0], "firstBand": parsed[0][1],
                      "lastCoaddId": parsed[-1][0], "lastBand": parsed[-1][1], "sha256": sha256(body), "sizeBytes": len(body)})
        normalized_rows.extend(item[2] for item in parsed)
        previous = (parsed[-1][0], parsed[-1][1])
        if len(parsed) < PAGE_SIZE:
            break
        if len(pages) >= 37:
            raise ValueError("AllWISE TAP exceeded the locked 37-page W3/W4 roster")

    if len(normalized_rows) != EXPECTED_ROWS or len(pairs) != EXPECTED_ROWS:
        raise ValueError(f"AllWISE W3/W4 keyset capture is incomplete: {len(normalized_rows)} rows")
    if any(len(coadds[band]) != EXPECTED_COADDS for band in ("W3", "W4")) or coadds["W3"] != coadds["W4"]:
        raise ValueError("AllWISE W3/W4 coadd ID sets do not match the two official distinct-count denominators")
    if len(pages) != 37 or [page["rows"] for page in pages] != [PAGE_SIZE] * 36 + [480]:
        raise ValueError("AllWISE TAP pagination differs from the locked 36,480-row page structure")
    after, after_docs = count_snapshot(fetch, timeout, "after")
    if before["denominator"]["rowCount"] != after["denominator"]["rowCount"] \
            or before["bandCounts"]["perBand"] != after["bandCounts"]["perBand"] \
            or any(before[f"{band.lower()}DistinctCoadds"]["count"] != after[f"{band.lower()}DistinctCoadds"]["count"] for band in ("W3", "W4")):
        raise ValueError("AllWISE source-table denominators changed during capture")

    output.mkdir(parents=True, exist_ok=False)
    table_schema_path = output / "metadata/table-schema.vot"
    immutable_write(table_schema_path, schema_body)
    metadata_documents = [document_ref(output, table_schema_path, schema_url)]
    for ref, body, url in [*before_docs, *page_documents, *after_docs]:
        absolute = output / ref
        immutable_write(absolute, body)
        metadata_documents.append(document_ref(output, absolute, url))
    row_path = output / "normalized/native-rows.ndjson.gz"
    row_bytes = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in normalized_rows).encode("utf-8")
    compressed_rows = gzip.compress(row_bytes, mtime=0)
    immutable_write(row_path, compressed_rows)
    row_file = document_ref(output, row_path, TAP_URL)
    captured = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "allwise-ibe-atlas",
        "surveyId": SURVEY_ID, "releaseId": RELEASE_ID, "capturedAt": captured,
        "coordinateFrame": "ICRS", "nativeCoordinateFrame": "FK5(J2000)", "ordering": "NESTED",
        "inventoryComplete": True, "queryPagesComplete": True, "rowCount": len(normalized_rows),
        "scope": {
            "dataset": "AllWISE Image Atlas", "table": "allwise_p3am_cdd", "bands": ["W3", "W4"],
            "bandNumbers": {"W3": 3, "W4": 4}, "expectedRowCount": EXPECTED_ROWS,
            "expectedCoaddCount": EXPECTED_COADDS, "bandCounts": EXPECTED_BAND_COUNTS,
            "coaddIdSetsEqual": True, "officialAtlasTileCount": EXPECTED_COADDS,
            "fullSourceTableRoster": True, "validPixelMasksChecked": False,
            "sourceFrame": "FK5(equinox=J2000)", "projection": "RA---SIN/DEC--SIN",
            "geometrySource": "allwise_p3am_cdd ra1/dec1 through ra4/dec4",
        },
        "sourcePagination": {
            "queryPagesComplete": True, "pageSize": PAGE_SIZE, "pageCount": len(pages),
            "expectedRowCount": EXPECTED_ROWS, "expectedCoaddCount": EXPECTED_COADDS,
            "coaddIdSetsEqual": True, "denominator": before["denominator"],
            "bandCounts": {**before["bandCounts"], "perBandCount": EXPECTED_COADDS},
            "w3DistinctCoadds": before["w3DistinctCoadds"], "w4DistinctCoadds": before["w4DistinctCoadds"],
            "denominatorAfter": after["denominator"], "bandCountsAfter": after["bandCounts"],
            "w3DistinctCoaddsAfter": after["w3DistinctCoadds"], "w4DistinctCoaddsAfter": after["w4DistinctCoadds"],
            "denominatorsStable": True, "pages": pages,
        },
        "metadataDocuments": metadata_documents,
        "rowFiles": [{**row_file, "rows": len(normalized_rows)}],
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
    print(f"Captured {manifest['rowCount']} AllWISE W3/W4 rows across {manifest['scope']['expectedCoaddCount']} Tiles; inventoryComplete=true")


if __name__ == "__main__":
    main()
