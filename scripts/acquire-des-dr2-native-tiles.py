#!/usr/bin/env python3
"""Capture the complete DES DR2 normal coadd Tile/file roster from NOIRLab TAP."""

import argparse
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
SOURCE_ID = "des-dr2-coadd-tiles"
SURVEY_ID = "des"
RELEASE_ID = "des-dr2"
FILTERS = ["g", "r", "i", "z", "Y"]
PAGE_SIZE = 5000
EXPECTED_TILE_COUNT = 10169
EXPECTED_ROW_COUNT = EXPECTED_TILE_COUNT * len(FILTERS)
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
VOTABLE_NS = "http://www.ivoa.net/xml/VOTable/v1.3"
BASE_WHERE = "obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y') AND fileref NOT LIKE '%nobkg%'"
SOURCE_QUERY = (
    "SELECT object, fileref, filter, obs_pub_did, access_url, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 "
    "FROM ivoa_des_dr2.siav1 WHERE " + BASE_WHERE + " ORDER BY obs_pub_did"
)
ROW_FIELDS = ["object", "fileref", "filter", "obs_pub_did", "access_url", "ra1", "dec1", "ra2", "dec2", "ra3", "dec3", "ra4", "dec4"]
SCHEMA_QUERY = (
    "SELECT column_name, description, unit, ucd, utype FROM TAP_SCHEMA.columns "
    "WHERE table_name = 'ivoa_des_dr2.siav1' AND column_name IN "
    "('object','fileref','filter','obs_pub_did','access_url','ra1','dec1','ra2','dec2','ra3','dec3','ra4','dec4') "
    "ORDER BY column_name"
)
DENOMINATOR_QUERY = (
    "SELECT object, COUNT(*) AS files FROM ivoa_des_dr2.siav1 "
    "WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y') "
    "GROUP BY object ORDER BY object"
)
BAND_COUNTS_QUERY = "SELECT filter, COUNT(*) AS n FROM ivoa_des_dr2.siav1 WHERE " + BASE_WHERE + " GROUP BY filter ORDER BY filter"
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only DES DR2 collector/1.0"


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


def tap_url(query: str, maxrec: int) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(maxrec), "QUERY": query}
    return SOURCE_URL + "?" + urllib.parse.urlencode(params)


def request_bytes(url: str, timeout: int = 90) -> tuple[bytes, str, int]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/x-votable+xml",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if response.status != 200 or len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("NOIRLab TAP response exceeded its HTTP or metadata-size contract")
        return body, response.url, response.status


def parse_votable(body: bytes) -> tuple[list[str], list[dict[str, str]]]:
    root = ET.fromstring(body)
    local_name = lambda element: str(element.tag).rsplit("}", 1)[-1]
    status_rows = [item for item in root.iter() if local_name(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    status = next((item for item in status_rows if item.get("value") != "OK"), status_rows[0] if status_rows else None)
    if status is None or status.get("value") != "OK":
        value = status.get("value") if status is not None else "missing"
        detail = (status.text or "").strip() if status is not None else ""
        raise ValueError(f"NOIRLab TAP QUERY_STATUS={value}: {detail}")
    if any(item.get("value") == "OVERFLOW" for item in status_rows):
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
    tile = values["object"].strip()
    filename = values["fileref"].strip()
    band = values["filter"].strip()
    publisher_did = values["obs_pub_did"].strip()
    access_url = values["access_url"].strip()
    if not re.fullmatch(r"DES\d{4}[+-]\d{4}", tile) or band not in FILTERS:
        raise ValueError("DES DR2 row has an invalid Tile or filter identity")
    if not re.fullmatch(r"DES\d{4}[+-]\d{4}_[A-Za-z0-9]+_[grizY]\.fits\.fz", filename) or not filename.startswith(tile + "_") or not filename.endswith(f"_{band}.fits.fz"):
        raise ValueError("DES DR2 row has an invalid normal coadd filename")
    if not publisher_did.startswith("ivo://datalab.noao/des_dr2/") or not publisher_did.endswith("/" + filename + "#1"):
        raise ValueError("DES DR2 publisher identity does not identify the selected normal image HDU")
    parsed = urllib.parse.urlsplit(access_url)
    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
    raw_file_refs = [
        urllib.parse.unquote(part.partition("=")[2])
        for part in parsed.query.split("&")
        if urllib.parse.unquote(part.partition("=")[0]) == "siaRef"
    ]
    if parsed.scheme != "https" or parsed.hostname != "datalab.noirlab.edu" or parsed.path != "/svc/cutout" or parsed.username or parsed.password \
            or query.get("col") != ["des_dr2"] or raw_file_refs != [filename] or query.get("extn") != ["1"] \
            or "POS" in query or "SIZE" in query:
        raise ValueError("DES DR2 access URL is not the source-listed no-cutout full-file URL")

    corners = []
    for index in range(1, 5):
        try:
            ra = float(values[f"ra{index}"])
            dec = float(values[f"dec{index}"])
        except (ValueError, KeyError) as error:
            raise ValueError("DES DR2 row is missing an ICRS corner") from error
        if not 0 <= ra < 360 or not -90 <= dec <= 90:
            raise ValueError("DES DR2 ICRS corner is outside the celestial sphere")
        corners.append([ra, dec])
    footprint = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in corners)
    return {
        "unitId": tile,
        "sRegion": footprint,
        "bands": [band.upper()],
        "filename": filename,
        "accessUris": [{"uri": access_url, "fileName": filename, "band": band.upper(), "accessType": "file"}],
        "sourceMetadata": {
            "tileId": tile,
            "fileRef": filename,
            "filter": band.upper(),
            "publisherDid": publisher_did,
            "accessUrl": access_url,
            "hdu": 1,
            "coordinateFrame": "ICRS",
            "geometrySource": "ivoa_des_dr2.siav1 ICRS image corners",
            "cornersIcrs": corners,
            "footprint": footprint,
            "accessSemantics": "full-coadd-image-no-region-cutout",
        },
    }


def file_reference(root: Path, path: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body)}


def save_metadata(root: Path, relative: str, body: bytes, url: str) -> dict:
    path = root / relative
    immutable_write(path, body)
    return file_reference(root, path, url)


def acquire(output: Path, timeout: int = 90, fetch=request_bytes) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    metadata_documents = []

    schema_url = tap_url(SCHEMA_QUERY, 100)
    schema_body, final_url, status = fetch(schema_url, timeout)
    schema_fields, schema_rows = parse_votable(schema_body)
    if status != 200 or not {"column_name", "description"}.issubset(schema_fields):
        raise ValueError("DES DR2 TAP schema query returned an invalid response")
    schema_names = {row["column_name"].lower() for row in schema_rows}
    if not set(ROW_FIELDS).issubset(schema_names):
        raise ValueError("DES DR2 TAP schema does not declare every identity, URL and ICRS corner column")
    metadata_documents.append(save_metadata(output, "metadata/tap-schema.votable.xml", schema_body, final_url))

    denominator_url = tap_url(DENOMINATOR_QUERY, 20000)
    denominator_body, final_url, status = fetch(denominator_url, timeout)
    denominator_status = status
    denominator_fields, denominator_rows = parse_votable(denominator_body)
    if status != 200 or not {"object", "files"}.issubset(denominator_fields):
        raise ValueError("DES DR2 Tile denominator query returned an invalid response")
    tile_ids = [row["object"] for row in denominator_rows]
    if len(tile_ids) != EXPECTED_TILE_COUNT or len(set(tile_ids)) != len(tile_ids):
        raise ValueError("DES DR2 Tile denominator differs from the locked 10,169-Tile roster")
    if any(not re.fullmatch(r"DES\d{4}[+-]\d{4}", tile) or int(row["files"]) != 10 for tile, row in zip(tile_ids, denominator_rows)):
        raise ValueError("DES DR2 denominator does not contain ten extension rows per Tile")
    metadata_documents.append(save_metadata(output, "metadata/tile-denominator.votable.xml", denominator_body, final_url))

    band_url = tap_url(BAND_COUNTS_QUERY, 100)
    band_body, final_url, status = fetch(band_url, timeout)
    band_status = status
    band_fields, band_rows = parse_votable(band_body)
    if status != 200 or not {"filter", "n"}.issubset(band_fields):
        raise ValueError("DES DR2 normal coadd band-count query returned an invalid response")
    band_counts = {row["filter"]: int(row["n"]) for row in band_rows}
    if band_counts != {band: EXPECTED_TILE_COUNT for band in FILTERS}:
        raise ValueError("DES DR2 normal coadd selector does not contain one file per band per Tile")
    metadata_documents.append(save_metadata(output, "metadata/normal-coadd-band-counts.votable.xml", band_body, final_url))

    normalized_rows = []
    page_receipts = []
    seen_publishers = set()
    seen_tile_bands = set()
    cursor = None
    for page_number in range(1, 4097):
        cursor_clause = f" AND obs_pub_did > '{cursor}'" if cursor else ""
        query = f"SELECT TOP {PAGE_SIZE} {', '.join(ROW_FIELDS)} FROM ivoa_des_dr2.siav1 WHERE {BASE_WHERE}{cursor_clause} ORDER BY obs_pub_did"
        url = tap_url(query, PAGE_SIZE)
        body, final_url, status = fetch(url, timeout)
        fields, rows = parse_votable(body)
        if status != 200 or not set(ROW_FIELDS).issubset(fields):
            raise ValueError("DES DR2 coadd page returned an unexpected HTTP status or column set")
        if len(rows) > PAGE_SIZE:
            raise ValueError("DES DR2 keyset page exceeded its fixed size")
        first_key = rows[0]["obs_pub_did"] if rows else None
        last_key = rows[-1]["obs_pub_did"] if rows else None
        for values in rows:
            publisher = values["obs_pub_did"]
            if publisher in seen_publishers:
                raise ValueError("DES DR2 keyset pages contain duplicate publisher identities")
            seen_publishers.add(publisher)
            record = normalize_row(values)
            key = (record["unitId"], record["bands"][0])
            if key in seen_tile_bands:
                raise ValueError("DES DR2 contains duplicate normal coadd files for a Tile and band")
            seen_tile_bands.add(key)
            normalized_rows.append(record)
        page_ref = save_metadata(output, f"metadata/coadd-page-{page_number:04d}.votable.xml", body, final_url)
        page_receipts.append({
            "page": page_number, "query": query, "url": final_url, "status": status, "queryStatus": "OK",
            "rows": len(rows), "firstPublisherDid": first_key, "lastPublisherDid": last_key, "sha256": page_ref["sha256"],
        })
        metadata_documents.append(page_ref)
        if len(rows) < PAGE_SIZE:
            break
        if not last_key:
            raise ValueError("DES DR2 nonterminal page has no continuation key")
        cursor = last_key
    else:
        raise ValueError("DES DR2 acquisition exceeded the page safety limit")

    if len(normalized_rows) != EXPECTED_ROW_COUNT or len(seen_tile_bands) != EXPECTED_ROW_COUNT:
        raise ValueError("DES DR2 capture differs from the locked 50,845 normal coadd rows")
    captured_tiles = {row["unitId"] for row in normalized_rows}
    if captured_tiles != set(tile_ids):
        raise ValueError("DES DR2 native file rows do not cover the exact source Tile denominator")
    observed_band_counts = {band: sum(row["bands"] == [band.upper()] for row in normalized_rows) for band in FILTERS}
    if observed_band_counts != band_counts:
        raise ValueError("DES DR2 captured band counts disagree with the saved grouped query")

    row_path = output / "rows/des-dr2-normal-coadd-tiles.ndjson.gz"
    row_text = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in normalized_rows).encode("utf-8")
    immutable_write(row_path, gzip.compress(row_text, mtime=0))
    row_file = file_reference(output, row_path, SOURCE_URL)
    captured = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1, "adapter": "noirlab-des-tap", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured, "coordinateFrame": "ICRS", "ordering": "NESTED",
        "sourceUrl": SOURCE_URL, "query": SOURCE_QUERY,
        "scope": {
            "collection": "des_dr2", "table": "ivoa_des_dr2.siav1", "filters": FILTERS, "hdu": 1,
            "normalCoaddsOnly": True, "cutoutParametersIncluded": False,
            "expectedRowCount": EXPECTED_ROW_COUNT, "expectedTileCount": EXPECTED_TILE_COUNT,
            "bandCounts": band_counts, "inventoryComplete": True,
            "accessSemantics": "source-listed full coadd FITS image URL with no POS/SIZE cutout parameters",
            "geometryPrecision": "estimated image-frame corners; valid-pixel masks not inspected",
        },
        "sourcePagination": {
            "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROW_COUNT, "expectedTileCount": EXPECTED_TILE_COUNT,
            "queryPagesComplete": True,
            "denominator": {"status": denominator_status, "queryStatus": "OK", "tileCount": len(tile_ids), "uniqueTileCount": len(set(tile_ids))},
            "bandCounts": {"status": band_status, "queryStatus": "OK", "perBandCount": EXPECTED_TILE_COUNT},
            "pages": page_receipts,
        },
        "queryPagesComplete": True, "inventoryComplete": True,
        "metadataDocuments": metadata_documents,
        "rowFiles": [{**row_file, "rows": len(normalized_rows)}], "rowCount": len(normalized_rows),
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    manifest_ref = file_reference(output, manifest_path, SOURCE_URL)
    return {"manifest": manifest, "manifestFile": manifest_ref, "rowFile": row_file, "tileCount": len(captured_tiles), "bandCounts": observed_band_counts}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New immutable capture directory outside the Assets Git worktree")
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    result = acquire(args.output, args.timeout)
    print(json.dumps({"output": str(args.output), "manifest": result["manifestFile"], "tiles": result["tileCount"],
                      "rows": result["manifest"]["rowCount"], "bandCounts": result["bandCounts"],
                      "inventoryComplete": result["manifest"]["inventoryComplete"]}, indent=2))


if __name__ == "__main__":
    main()
