#!/usr/bin/env python3
"""Capture a bounded SkyMapper DR4 CCD metadata increment; never fetch FITS pixels."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


SOURCE_URL = "https://api.skymapper.nci.org.au/public/tap/sync"
SIAP_GET_IMAGE = "https://api.skymapper.nci.org.au/public/siap/dr4/get_image"
SOURCE_ID = "skymapper-dr4-2014-mar15-18-ccds"
SURVEY_ID = "skymapper"
RELEASE_ID = "skymapper-dr4"
IMAGE_ID_START = 20140315000000
IMAGE_ID_END = 20140318000000
FILTERS = ("g", "r", "i")
EXPECTED_ROWS = 5666
PAGE_SIZE = 5000
CUTOUT_SIZE_DEG = "0.0833"
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
VOTABLE_NS = "http://www.ivoa.net/xml/VOTable/v1.3"
SCOPE_QUERY = (
    "SELECT image_id, ccd, filter, filename, coverage FROM dr4.ccds "
    "WHERE image_id >= 20140315000000 AND image_id < 20140318000000 "
    "AND filter IN ('g','r','i') ORDER BY image_id, ccd"
)
IMAGE_FILE = re.compile(r"^\d{5}/\d{2}/Skymapper_[A-Za-z0-9_.:-]+_\d{2}_red\.fits$")


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


def query_text(cursor: tuple[int, int] | None = None, count: bool = False) -> str:
    selection = "COUNT(*) AS n" if count else "image_id, ccd, filter, filename, coverage"
    predicate = (
        f"image_id >= {IMAGE_ID_START} AND image_id < {IMAGE_ID_END} "
        "AND filter IN ('g','r','i')"
    )
    if cursor is not None:
        image_id, ccd = cursor
        predicate += f" AND (image_id > {image_id} OR (image_id = {image_id} AND ccd > {ccd}))"
    return f"SELECT {'TOP ' + str(PAGE_SIZE) + ' ' if not count else ''}{selection} FROM dr4.ccds WHERE {predicate}" + ("" if count else " ORDER BY image_id, ccd")


def fetch_query(query: str, timeout: int) -> tuple[bytes, str, int]:
    params = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "QUERY": query})
    url = f"{SOURCE_URL}?{params}"
    request = urllib.request.Request(url, headers={
        "Accept": "application/x-votable+xml",
        "User-Agent": "Astro-Survey-Atlas-Assets metadata-only SkyMapper collector/1.0",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError(f"SkyMapper TAP returned HTTP {response.status}")
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("SkyMapper TAP metadata page exceeded the 64 MiB limit")
        return body, response.url, response.status


def parse_votable(body: bytes) -> tuple[list[str], list[list[str]]]:
    root = ET.fromstring(body)
    info = root.find(f".//{{{VOTABLE_NS}}}INFO[@name='QUERY_STATUS']")
    if info is None or info.get("value") != "OK":
        status = info.get("value") if info is not None else "missing"
        detail = (info.text or "").strip() if info is not None else ""
        raise ValueError(f"SkyMapper TAP QUERY_STATUS={status}: {detail}")
    table = root.find(f".//{{{VOTABLE_NS}}}TABLE")
    if table is None:
        raise ValueError("SkyMapper TAP response has no VOTable table")
    fields = [field.get("name", "") for field in table.findall(f"{{{VOTABLE_NS}}}FIELD")]
    data = table.find(f"{{{VOTABLE_NS}}}DATA/{{{VOTABLE_NS}}}TABLEDATA")
    if data is None:
        raise ValueError("SkyMapper TAP response is not TABLEDATA")
    rows = [[(cell.text or "").strip() for cell in tr.findall(f"{{{VOTABLE_NS}}}TD")] for tr in data.findall(f"{{{VOTABLE_NS}}}TR")]
    if any(len(row) != len(fields) for row in rows):
        raise ValueError("SkyMapper TAP row width differs from its field declaration")
    return fields, rows


def spherical_center(s_region: str) -> tuple[float, float]:
    match = re.fullmatch(r"POLYGON\s+ICRS\s+(.+)", s_region.strip(), re.IGNORECASE)
    if not match:
        raise ValueError("SkyMapper CCD coverage must be an ICRS polygon")
    values = [float(value) for value in match.group(1).split()]
    if len(values) < 6 or len(values) % 2:
        raise ValueError("SkyMapper CCD polygon must contain at least three coordinate pairs")
    xyz = [0.0, 0.0, 0.0]
    for ra, dec in zip(values[0::2], values[1::2]):
        if not math.isfinite(ra) or not math.isfinite(dec) or not 0 <= ra < 360 or not -90 <= dec <= 90:
            raise ValueError("SkyMapper CCD polygon contains an invalid ICRS coordinate")
        longitude, latitude = math.radians(ra), math.radians(dec)
        xyz[0] += math.cos(latitude) * math.cos(longitude)
        xyz[1] += math.cos(latitude) * math.sin(longitude)
        xyz[2] += math.sin(latitude)
    norm = math.sqrt(sum(value * value for value in xyz))
    if norm < 1e-12:
        raise ValueError("SkyMapper CCD polygon has no stable spherical center")
    ra = math.degrees(math.atan2(xyz[1], xyz[0])) % 360
    dec = math.degrees(math.asin(xyz[2] / norm))
    return ra, dec


def cutout_uri(unit_id: str, center: tuple[float, float]) -> str:
    ra, dec = center
    params = urllib.parse.urlencode({
        "IMAGE": unit_id,
        "SIZE": CUTOUT_SIZE_DEG,
        "POS": f"{ra:.6f},{dec:.6f}",
        "FORMAT": "fits",
    })
    return f"{SIAP_GET_IMAGE}?{params}"


def normalize_row(values: dict[str, str]) -> dict:
    image_id = values["image_id"].strip()
    ccd = int(values["ccd"])
    band = values["filter"].strip().lower()
    filename = values["filename"].strip()
    coverage = values["coverage"].strip()
    if not re.fullmatch(r"\d{14}", image_id) or not IMAGE_ID_START <= int(image_id) < IMAGE_ID_END:
        raise ValueError("SkyMapper image_id is outside the locked increment")
    if not 1 <= ccd <= 32 or band not in FILTERS or not IMAGE_FILE.fullmatch(filename):
        raise ValueError("SkyMapper CCD identity, filter or original filename is invalid")
    center = spherical_center(coverage)
    unit_id = f"{image_id}-{ccd:02d}"
    return {
        "unitId": unit_id,
        "sRegion": coverage,
        "bands": [band.upper()],
        "filename": filename,
        "accessUris": [{"uri": cutout_uri(unit_id, center), "accessType": "file", "band": band}],
        "sourceMetadata": {
            "imageId": image_id,
            "ccd": ccd,
            "filter": band,
            "originalFilename": filename,
            "sourceCoverage": coverage,
            "geometrySource": "dr4.ccds.coverage",
            "coordinateFrame": "ICRS",
            "accessSemantics": "five-arcmin-fits-cutout-not-full-ccd",
            "cutoutSizeDeg": 0.0833,
            "cutoutCenterIcrs": [round(center[0], 6), round(center[1], 6)],
        },
    }


def file_reference(root: Path, path: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body)}


def acquire(output: Path, timeout: int = 60, fetch=fetch_query) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    metadata_refs = []
    count_query = query_text(count=True)
    count_body, count_url, count_status = fetch(count_query, timeout)
    count_fields, count_rows = parse_votable(count_body)
    if count_status != 200 or count_fields != ["n"] or len(count_rows) != 1:
        raise ValueError("SkyMapper bounded count query returned an invalid result")
    expected_count = int(count_rows[0][0])
    if expected_count != EXPECTED_ROWS:
        raise ValueError(f"Locked SkyMapper increment expected {EXPECTED_ROWS} rows, source returned {expected_count}")
    count_path = output / "metadata/count.votable.xml"
    immutable_write(count_path, count_body)
    metadata_refs.append(file_reference(output, count_path, count_url))

    all_rows = []
    page_receipts = []
    seen = set()
    cursor = None
    for page_number in range(1, 4097):
        query = query_text(cursor)
        body, url, status = fetch(query, timeout)
        fields, rows = parse_votable(body)
        if status != 200 or fields != ["image_id", "ccd", "filter", "filename", "coverage"]:
            raise ValueError("SkyMapper CCD metadata page has an unexpected HTTP or column response")
        page_rows = []
        keys = []
        for row in rows:
            record = dict(zip(fields, row))
            key = (int(record["image_id"]), int(record["ccd"]))
            if cursor is not None and key <= cursor or keys and key <= keys[-1] or key in seen:
                raise ValueError("SkyMapper TAP pages contain duplicate or unordered CCD keys")
            keys.append(key)
            seen.add(key)
            page_rows.append(normalize_row(record))
        page_path = output / f"metadata/tap-page-{page_number:04d}.votable.xml"
        immutable_write(page_path, body)
        ref = file_reference(output, page_path, url)
        metadata_refs.append(ref)
        page_receipts.append({
            "page": page_number,
            "query": query,
            "url": url,
            "status": status,
            "queryStatus": "OK",
            "rows": len(rows),
            "firstKey": list(keys[0]) if keys else None,
            "lastKey": list(keys[-1]) if keys else None,
            "sha256": ref["sha256"],
            "sizeBytes": ref["sizeBytes"],
        })
        all_rows.extend(page_rows)
        print(f"SkyMapper DR4 CCD page {page_number}: {len(rows)} rows", flush=True)
        if len(rows) < PAGE_SIZE:
            break
        if not keys:
            raise ValueError("SkyMapper keyset query returned an empty nonterminal page")
        cursor = keys[-1]
    else:
        raise ValueError("SkyMapper metadata acquisition exceeded 4096 pages")

    if len(all_rows) != expected_count:
        raise ValueError(f"SkyMapper keyset pages contain {len(all_rows)} rows; bounded count is {expected_count}")
    rows_path = output / "rows/skymapper-dr4-20140315-18-ccds.ndjson.gz"
    row_body = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in all_rows).encode("utf-8")
    import gzip
    immutable_write(rows_path, gzip.compress(row_body, mtime=0))
    row_file = file_reference(output, rows_path, SOURCE_URL)
    row_file["rows"] = len(all_rows)
    manifest = {
        "schemaVersion": 1,
        "adapter": "skymapper-dr4-ccd",
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "capturedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "inventoryComplete": False,
        "queryPagesComplete": True,
        "rowCount": len(all_rows),
        "scope": {
            "imageIdStartInclusive": IMAGE_ID_START,
            "imageIdEndExclusive": IMAGE_ID_END,
            "filters": list(FILTERS),
            "expectedRowCount": expected_count,
            "fullReleaseInventory": False,
        },
        "sourcePagination": {
            "queryPagesComplete": True,
            "pageSize": PAGE_SIZE,
            "expectedRowCount": expected_count,
            "pages": page_receipts,
        },
        "metadataDocuments": metadata_refs,
        "rowFiles": [row_file],
    }
    manifest_body = (json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, manifest_body)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", default=60, type=int)
    args = parser.parse_args()
    manifest = acquire(args.output, timeout=args.timeout)
    print(f"Captured {manifest['rowCount']} SkyMapper DR4 g/r/i CCD rows in {len(manifest['sourcePagination']['pages'])} pages; inventoryComplete=false")


if __name__ == "__main__":
    main()
