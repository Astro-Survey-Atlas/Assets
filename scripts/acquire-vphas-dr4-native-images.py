#!/usr/bin/env python3
"""Capture VPHAS+ DR4 image metadata and ESO DataLink evidence only."""

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
RELEASE_URL = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/145"
SOURCE_URL = TAP_URL
SOURCE_ID = "vphas-dr4-eso-images"
SURVEY_ID = "vphas"
RELEASE_ID = "vphas-dr4"
PAGE_SIZE = 5000
EXPECTED_ROWS = 15534
EXPECTED_BANDS = {"g_SDSS": 3829, "i_SDSS": 1876, "NB_659": 2835, "r_SDSS": 4437, "u_SDSS": 2557}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only VPHAS+ DR4 collector/1.0"
SELECT = "dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description"
WHERE = (
    "obs_collection = 'VPHASplus' AND release_description = "
    f"'{RELEASE_URL}' AND dataproduct_type = 'image'"
)
SOURCE_QUERY = f"SELECT TOP {PAGE_SIZE} {SELECT} FROM ivoa.ObsCore WHERE {WHERE} ORDER BY dp_id"
DENOMINATOR_QUERY = f"SELECT COUNT(*) AS row_count FROM ivoa.ObsCore WHERE {WHERE}"
BAND_COUNTS_QUERY = f"SELECT filter, COUNT(*) AS n FROM ivoa.ObsCore WHERE {WHERE} GROUP BY filter ORDER BY filter"


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


def tap_url(query_text: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(PAGE_SIZE), "QUERY": query_text}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def parse_votable(body: bytes) -> tuple[list[dict[str, str]], bool]:
    root = ET.fromstring(body)
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    statuses = [item.get("value", "") for item in root.iter() if local(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    if "ERROR" in statuses or not any(status in ("OK", "OVERFLOW") for status in statuses):
        raise ValueError(f"ESO TAP QUERY_STATUS={statuses}")
    overflow = "OVERFLOW" in statuses
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
    return rows, overflow


def query(query_text: str) -> tuple[bytes, list[dict[str, str]], bool, str]:
    body, status, response_url = request_bytes(tap_url(query_text), accept="application/x-votable+xml")
    if status != 200:
        raise ValueError(f"ESO TAP returned HTTP {status}")
    rows, overflow = parse_votable(body)
    return body, rows, overflow, response_url


def parse_j2000_union(value: str) -> list[list[tuple[float, float]]]:
    stripped = value.strip()
    if (not stripped.upper().startswith("UNION J2000 (") or not stripped.endswith(")")
            or stripped.count("(") != 1 or stripped.count(")") != 1):
        raise ValueError("VPHAS+ geometry must be a parenthesized UNION J2000 region")
    tokens = value.replace("(", " ").replace(")", " ").split()
    if len(tokens) < 10 or tokens[0].upper() != "UNION" or tokens[1].upper() != "J2000":
        raise ValueError("VPHAS+ geometry must be a UNION J2000 region")
    index = 2
    polygons: list[list[tuple[float, float]]] = []
    while index < len(tokens):
        if tokens[index].upper() != "POLYGON":
            raise ValueError("VPHAS+ UNION contains a non-polygon component")
        index += 1
        if index < len(tokens) and tokens[index].upper() == "J2000":
            index += 1
        start = index
        while index < len(tokens) and tokens[index].upper() != "POLYGON":
            index += 1
        coordinates = tokens[start:index]
        if len(coordinates) < 6 or len(coordinates) % 2:
            raise ValueError("VPHAS+ CCD polygon has an invalid coordinate count")
        try:
            values = [float(coordinate) for coordinate in coordinates]
        except ValueError as error:
            raise ValueError("VPHAS+ CCD polygon contains a non-numeric coordinate") from error
        polygon = list(zip(values[0::2], values[1::2]))
        if any(not 0 <= ra < 360 or not -90 <= dec <= 90 for ra, dec in polygon):
            raise ValueError("VPHAS+ CCD polygon is outside the celestial sphere")
        polygons.append(polygon)
    if not 1 <= len(polygons) <= 32:
        raise ValueError("VPHAS+ pawprint must retain between 1 and 32 CCD polygons")
    return polygons


def transform_j2000_union(value: str) -> tuple[str, int]:
    polygons = parse_j2000_union(value)
    transformed: list[str] = []
    frame = FK5(equinox=Time("J2000"))
    for polygon in polygons:
        sky = SkyCoord(
            ra=[point[0] for point in polygon] * u.deg,
            dec=[point[1] for point in polygon] * u.deg,
            frame=frame,
        ).transform_to(ICRS())
        vertices = " ".join(
            f"{ra:.10f} {dec:.10f}"
            for ra, dec in zip(sky.ra.wrap_at(360 * u.deg).deg, sky.dec.deg)
        )
        transformed.append(f"POLYGON {vertices}")
    return f"UNION ICRS ({' '.join(transformed)})", len(polygons)


def parse_datalink(body: bytes, dp_id: str, source_filename: str) -> dict[str, str]:
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
    if len(science) != 1:
        raise ValueError(f"ESO DataLink must identify one #this science image for {dp_id}")
    image = science[0]
    expected_uri = f"https://dataportal.eso.org/dataPortal/file/{dp_id}"
    if image.get("eso_category") != "SCIENCE.MEFIMAGE" or image.get("eso_origfile") != source_filename or image.get("access_url") != expected_uri:
        raise ValueError(f"ESO DataLink #this does not match the source image {dp_id}")
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.fits(?:\.fz)?", source_filename, re.I):
        raise ValueError(f"VPHAS+ source filename is not a single FITS image: {dp_id}")
    return image


def band_for_filter(source_filter: str) -> str:
    bands = {"u_SDSS": "U", "g_SDSS": "G", "r_SDSS": "R", "i_SDSS": "I", "NB_659": "HALPHA"}
    try:
        return bands[source_filter]
    except KeyError as error:
        raise ValueError(f"Unexpected VPHAS+ DR4 filter: {source_filter}") from error


def normalize_row(row: dict[str, str], image: dict[str, str], response_sha: str, geometry: str, polygon_count: int) -> dict:
    dp_id = row["dp_id"]
    source_filter = row["filter"]
    filename = image["eso_origfile"]
    if not re.fullmatch(r"ADP\.[A-Za-z0-9.:-]+", dp_id) or source_filter not in EXPECTED_BANDS:
        raise ValueError("VPHAS+ row is outside the frozen DR4 image roster")
    if row["release_description"] != RELEASE_URL:
        raise ValueError("VPHAS+ row is outside release description 145")
    data_link = urllib.parse.urlsplit(row["access_url"])
    expected_id = f"ivo://eso.org/ID?{dp_id}"
    if data_link.scheme != "https" or data_link.hostname != "archive.eso.org" or data_link.path != "/datalink/links" or urllib.parse.parse_qs(data_link.query).get("ID") != [expected_id]:
        raise ValueError("VPHAS+ ObsCore DataLink URL is not the source-listed request for this dp_id")
    if filename != row.get("sourceFileName"):
        raise ValueError("VPHAS+ DataLink filename differs from the source-listed original filename")
    uri = image["access_url"]
    return {
        "unitId": dp_id,
        "sRegion": geometry,
        "bands": [band_for_filter(source_filter)],
        "filename": filename,
        "accessUris": [{"sourceId": "eso-datalink", "uri": uri, "fileName": filename, "band": band_for_filter(source_filter), "accessType": "file"}],
        "sourceMetadata": {
            "dpId": dp_id,
            "obsId": row.get("obs_id", ""),
            "obsCreatorDid": row.get("obs_creator_did", ""),
            "targetName": row.get("target_name", ""),
            "obsCollection": "VPHASplus",
            "dataproductType": "image",
            "filter": source_filter,
            "nativeCoordinateFrame": "J2000",
            "sourceSRegion": row["s_region"],
            "geometryTransform": "all source-listed UNION J2000 CCD polygons transformed to ICRS with Astropy",
            "ccdPolygonCount": polygon_count,
            "releaseDescription": RELEASE_URL,
            "dataLinkUrl": row["access_url"],
            "dataLinkUri": uri,
            "dataLinkResponseSha256": response_sha,
            "dataLinkSemantics": "#this",
            "dataLinkCategory": image["eso_category"],
            "dataLinkFileName": filename,
            "esoOriginalFile": filename,
            "contentLength": int(image["content_length"]) if image.get("content_length", "").isdigit() else None,
            "accessSemantics": "whole-unstacked-omegacam-pawprint-image",
        },
    }


def should_continue_page(row_count: int, overflow: bool) -> bool:
    if row_count < 0 or row_count > PAGE_SIZE or (overflow and row_count != PAGE_SIZE):
        raise ValueError("ESO TAP keyset page has an invalid row count or overflow status")
    return overflow or row_count == PAGE_SIZE


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
        raise ValueError("ESO VPHAS+ DR4 release description did not return the expected PDF")
    denominator_body, denominator_rows, _, denominator_url = query(DENOMINATOR_QUERY)
    band_body, band_rows, _, band_url = query(BAND_COUNTS_QUERY)
    if len(denominator_rows) != 1 or int(denominator_rows[0]["row_count"]) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore denominator differs from the official 15,534-image VPHAS+ DR4 submission")
    observed_bands = {row["filter"]: int(row["n"]) for row in band_rows}
    if observed_bands != EXPECTED_BANDS:
        raise ValueError(f"ESO ObsCore VPHAS+ DR4 band counts changed: {observed_bands}")

    tap_pages: list[dict[str, object]] = []
    source_rows: list[dict[str, str]] = []
    last_dp_id = ""
    while True:
        query_text = SOURCE_QUERY if not last_dp_id else (
            f"SELECT TOP {PAGE_SIZE} {SELECT} FROM ivoa.ObsCore WHERE {WHERE} AND dp_id > '{last_dp_id}' ORDER BY dp_id"
        )
        page_body, page_rows, overflow, page_url = query(query_text)
        if not should_continue_page(len(page_rows), overflow):
            if not page_rows and not source_rows:
                raise ValueError("ESO TAP returned an empty VPHAS+ DR4 roster")
        ids = [row.get("dp_id", "") for row in page_rows]
        if not ids or ids != sorted(ids) or len(ids) != len(set(ids)) or (last_dp_id and ids[0] <= last_dp_id):
            raise ValueError("ESO TAP VPHAS+ keyset pages are not strictly ordered by dp_id")
        relative = f"metadata/tap-page-{len(tap_pages) + 1:03d}.vot"
        immutable_write(output / relative, page_body)
        tap_pages.append({"ref": relative, "url": page_url, "status": 200, "queryStatus": "OVERFLOW" if overflow else "OK", "rows": len(page_rows),
            "overflow": overflow, "firstDpId": ids[0], "lastDpId": ids[-1], "query": query_text})
        source_rows.extend(page_rows)
        last_dp_id = ids[-1]
        print(json.dumps({"tapPages": len(tap_pages), "rows": len(source_rows), "overflow": overflow}), flush=True)
        if not should_continue_page(len(page_rows), overflow):
            break
        if len(tap_pages) > 10:
            raise ValueError("ESO TAP VPHAS+ keyset page budget exceeded")

    source_rows.sort(key=lambda row: row["dp_id"])
    if len(source_rows) != EXPECTED_ROWS or len({row["dp_id"] for row in source_rows}) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore rows differ from the complete declared VPHAS+ DR4 submission")
    row_bands: dict[str, int] = {}
    for row in source_rows:
        if row.get("release_description") != RELEASE_URL or row.get("dataproduct_type", "image").lower() != "image":
            raise ValueError(f"VPHAS+ row escaped the frozen DR4 image selector: {row.get('dp_id')}")
        if not row.get("target_name") or not row.get("obs_creator_did", "").partition("?")[2]:
            raise ValueError(f"VPHAS+ row lacks its field or source file identity: {row.get('dp_id')}")
        parse_j2000_union(row.get("s_region", ""))
        row_bands[row["filter"]] = row_bands.get(row["filter"], 0) + 1
    if row_bands != EXPECTED_BANDS:
        raise ValueError(f"VPHAS+ captured file rows do not match the release band counts: {row_bands}")

    metadata_documents: list[dict[str, object]] = []
    fixed_documents = [
        ("metadata/denominator.vot", denominator_body, denominator_url),
        ("metadata/band-counts.vot", band_body, band_url),
        ("metadata/release-description-145.pdf", release_pdf, release_uri),
    ]
    for relative, body, url in fixed_documents:
        immutable_write(output / relative, body)
        metadata_documents.append({"ref": relative, "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": url})
    for page in tap_pages:
        body = (output / str(page["ref"])).read_bytes()
        metadata_documents.append({"ref": page["ref"], "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": page["url"]})

    link_results: dict[str, tuple[bytes, dict[str, str], str]] = {}
    failures: list[str] = []

    def acquire_link(row: dict[str, str]) -> tuple[str, bytes, dict[str, str], str]:
        body, status, response_uri = request_bytes(row["access_url"], timeout=90, accept="application/x-votable+xml,text/xml,*/*")
        if status != 200:
            raise ValueError(f"ESO DataLink returned HTTP {status} for {row['dp_id']}")
        source_filename = row["obs_creator_did"].partition("?")[2]
        image = parse_datalink(body, row["dp_id"], source_filename)
        return row["dp_id"], body, image, response_uri

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(acquire_link, row) for row in source_rows]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                dp_id, body, image, response_uri = future.result()
                link_results[dp_id] = (body, image, response_uri)
            except Exception as error:
                failures.append(str(error))
            if index % 250 == 0:
                print(json.dumps({"dataLinksCompleted": index, "resolved": len(link_results), "errors": len(failures)}), flush=True)
    if failures or len(link_results) != EXPECTED_ROWS:
        failure_doc = {"expected": EXPECTED_ROWS, "resolved": len(link_results), "errors": sorted(failures)}
        immutable_write(output / "metadata/datalink-failures.json", json.dumps(failure_doc, sort_keys=True, indent=2).encode())
        raise ValueError(f"VPHAS+ DR4 DataLink capture incomplete: {len(link_results)}/{EXPECTED_ROWS} resolved")

    normalized_rows: list[dict] = []
    raw_datalinks: list[dict[str, object]] = []
    unique_links: set[str] = set()
    polygon_counts: dict[str, int] = {}
    for row in source_rows:
        dp_id = row["dp_id"]
        body, image, response_uri = link_results[dp_id]
        geometry, polygon_count = transform_j2000_union(row["s_region"])
        response_sha = sha256(body)
        normalized = {**row, "sourceFileName": image["eso_origfile"]}
        normalized_rows.append(normalize_row(normalized, image, response_sha, geometry, polygon_count))
        polygon_counts[str(polygon_count)] = polygon_counts.get(str(polygon_count), 0) + 1
        unique_links.add(row["access_url"])
        raw_datalinks.append({"dpId": dp_id, "url": row["access_url"], "responseUrl": response_uri,
            "status": 200, "responseSha256": response_sha, "bodyBase64": base64.b64encode(body).decode("ascii")})

    raw_path = output / "metadata/datalinks.ndjson.gz"
    raw_sha, raw_size = write_gzip_jsonl(raw_path, raw_datalinks)
    metadata_documents.append({"ref": "metadata/datalinks.ndjson.gz", "sha256": raw_sha, "sizeBytes": raw_size, "sourceUrl": SOURCE_URL})
    row_path = output / "normalized/native-rows.ndjson.gz"
    row_sha, row_size = write_gzip_jsonl(row_path, normalized_rows)

    sample = normalized_rows[EXPECTED_ROWS // 2]["accessUris"][0]["uri"]
    head_checks = [probe_head(sample)]
    head_body = json.dumps(head_checks, sort_keys=True, indent=2).encode()
    immutable_write(output / "metadata/representative-head-checks.json", head_body)
    metadata_documents.append({"ref": "metadata/representative-head-checks.json", "sha256": sha256(head_body), "sizeBytes": len(head_body), "sourceUrl": "https://dataportal.eso.org/"})
    metadata_documents.sort(key=lambda item: str(item["ref"]))

    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "eso-obscore-vphas", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured_at, "coordinateFrame": "ICRS", "nativeCoordinateFrame": "J2000", "ordering": "NESTED",
        "queryPagesComplete": True, "inventoryComplete": False,
        "scope": {"obsCollection": "VPHASplus", "releaseDescription": RELEASE_URL, "dataproductType": "image",
            "filters": list(EXPECTED_BANDS), "bandCounts": {band_for_filter(key): count for key, count in EXPECTED_BANDS.items()},
            "expectedRowCount": EXPECTED_ROWS, "expectedFieldCount": len({row["target_name"] for row in source_rows}),
            "nativeProduct": "unstacked 32-CCD OmegaCAM pawprint exposures", "cumulativeInventory": False,
            "validPixelMasksChecked": False, "geometryComponents": "per-file UNION of source CCD polygons"},
        "sourcePagination": {"queryPagesComplete": True, "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROWS,
            "dataLinkRequestedCount": EXPECTED_ROWS, "dataLinkThisCount": len(unique_links), "dataLinkErrors": 0,
            "denominator": {"status": 200, "queryStatus": "OK", "rowCount": int(denominator_rows[0]["row_count"])},
            "bandCounts": {"status": 200, "queryStatus": "OK", "counts": EXPECTED_BANDS},
            "releaseDocument": {"status": release_status, "sha256": sha256(release_pdf), "sizeBytes": len(release_pdf)},
            "pages": tap_pages, "polygonCountDistribution": polygon_counts, "accessChecks": head_checks},
        "rowCount": len(normalized_rows), "metadataDocuments": metadata_documents,
        "rowFiles": [{"ref": "normalized/native-rows.ndjson.gz", "sha256": row_sha, "sizeBytes": row_size, "rows": len(normalized_rows)}],
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, json.dumps(manifest, sort_keys=True, indent=2).encode())
    return {"manifest": str(manifest_path), "sha256": sha256(manifest_path.read_bytes()), "sizeBytes": manifest_path.stat().st_size,
        "rowCount": len(normalized_rows), "fieldCount": manifest["scope"]["expectedFieldCount"], "bandCounts": manifest["scope"]["bandCounts"],
        "polygonCountDistribution": polygon_counts, "headChecks": head_checks, "metadataDocuments": len(metadata_documents)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new immutable capture directory")
    args = parser.parse_args()
    print(json.dumps(capture(args.output), sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
