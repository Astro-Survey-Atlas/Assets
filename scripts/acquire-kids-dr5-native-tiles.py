#!/usr/bin/env python3
"""Capture KiDS DR5 ESO image metadata and source-listed file identities only."""

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
RELEASE_URL = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/229"
SOURCE_URL = "https://archive.eso.org/tap_obs/sync"
ROSTER_URL = "https://kids.strw.leidenuniv.nl/DR5/kids_dr5.0_sci_wget.sh"
SOURCE_ID = "kids-dr5-eso-images"
SURVEY_ID = "kids"
RELEASE_ID = "kids-dr5"
PAGE_SIZE = 1000
EXPECTED_ROWS = 5388
EXPECTED_TILES = 1347
EXPECTED_BANDS = {"g_SDSS": 1347, "r_SDSS": 1347, "i_SDSS": 2694}
EXPECTED_ROSTER_BANDS = {"u": 1347, "g": 1347, "r": 1347, "i": 1347, "i2": 1347}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only KiDS DR5 collector/1.0"
SELECT = "dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description"
WHERE = (
    "obs_collection = 'KIDS' AND release_description = "
    f"'{RELEASE_URL}' AND dataproduct_type = 'image' AND filter IN ('g_SDSS','r_SDSS','i_SDSS')"
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
            time.sleep(2 ** attempt)
    assert failure is not None
    raise failure


def votable_status(root: ET.Element) -> tuple[str, bool]:
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    statuses = [item.get("value", "") for item in root.iter() if local(item) == "INFO" and item.get("name") == "QUERY_STATUS"]
    if "ERROR" in statuses:
        raise ValueError("ESO TAP reported QUERY_STATUS=ERROR")
    if "OK" not in statuses and "OVERFLOW" not in statuses:
        raise ValueError(f"ESO TAP QUERY_STATUS={statuses}")
    return "OK", "OVERFLOW" in statuses


def parse_votable(body: bytes) -> tuple[list[dict[str, str]], bool]:
    root = ET.fromstring(body)
    local = lambda item: str(item.tag).rsplit("}", 1)[-1]
    _, overflow = votable_status(root)
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


def tap_url(query_text: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "MAXREC": str(PAGE_SIZE), "QUERY": query_text}
    return TAP_URL + "?" + urllib.parse.urlencode(params)


def query(query_text: str) -> tuple[bytes, list[dict[str, str]], bool, str]:
    body, status, response_url = request_bytes(tap_url(query_text), accept="application/x-votable+xml")
    if status != 200:
        raise ValueError(f"ESO TAP returned HTTP {status}")
    rows, overflow = parse_votable(body)
    return body, rows, overflow, response_url


def should_continue_tap_pages(row_count: int, overflow: bool) -> bool:
    if row_count < 1 or row_count > PAGE_SIZE or (overflow and row_count != PAGE_SIZE):
        raise ValueError("ESO TAP keyset page has an invalid row count or overflow status")
    return overflow or row_count == PAGE_SIZE


def transform_j2000_polygon(value: str) -> str:
    parts = value.split()
    if len(parts) < 8 or parts[0].upper() != "POLYGON" or parts[1].upper() != "J2000" or (len(parts) - 2) % 2:
        raise ValueError("KiDS geometry must be a complete POLYGON J2000")
    try:
        coordinates = [float(part) for part in parts[2:]]
    except ValueError as error:
        raise ValueError("KiDS polygon contains a non-numeric coordinate") from error
    if any(not 0 <= ra < 360 or not -90 <= dec <= 90 for ra, dec in zip(coordinates[0::2], coordinates[1::2])):
        raise ValueError("KiDS polygon coordinate is outside the celestial sphere")
    sky = SkyCoord(ra=coordinates[0::2] * u.deg, dec=coordinates[1::2] * u.deg, frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    vertices = " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in zip(sky.ra.wrap_at(360 * u.deg).deg, sky.dec.deg))
    return f"POLYGON ICRS {vertices}"


def parse_roster(body: bytes) -> tuple[dict[str, str], dict[str, int]]:
    by_name: dict[str, str] = {}
    counts = {band: 0 for band in EXPECTED_ROSTER_BANDS}
    for line_number, line in enumerate(body.decode("utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) != 2 or parts[0] != "wget":
            raise ValueError(f"Unexpected KiDS wget-list command on line {line_number}")
        uri = parts[1]
        parsed = urllib.parse.urlsplit(uri)
        match = re.fullmatch(r"KiDS_DR5\.0_[0-9.]+_-?[0-9.]+_(u|g|r|i|i2)_sci\.fits", parsed.path.rsplit("/", 1)[-1])
        if parsed.scheme != "http" or parsed.hostname != "ds.astro.rug.astro-wise.org" or parsed.port != 8000 or parsed.query or parsed.fragment or not match:
            raise ValueError(f"Unexpected KiDS Astro-WISE file URI on line {line_number}")
        filename = parsed.path.rsplit("/", 1)[-1]
        if filename in by_name:
            raise ValueError(f"Duplicate KiDS Astro-WISE filename: {filename}")
        by_name[filename] = uri
        counts[match.group(1)] += 1
    if len(by_name) != 6735 or counts != EXPECTED_ROSTER_BANDS:
        raise ValueError(f"KiDS Astro-WISE roster differs from its official denominator: {len(by_name)} rows, {counts}")
    return by_name, counts


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
        raise ValueError(f"ESO DataLink must identify exactly one #this science image for {dp_id}")
    image = science[0]
    expected_uri = f"https://dataportal.eso.org/dataPortal/file/{dp_id}"
    if image.get("eso_category") != "SCIENCE.IMAGE" or image.get("eso_origfile") != source_filename or image.get("access_url") != expected_uri:
        raise ValueError(f"ESO DataLink #this does not match the source science image {dp_id}")
    return image


def normalize_row(row: dict[str, str], image: dict[str, str], response_sha: str, astro_wise_uri: str) -> dict:
    unit_id = row["target_name"]
    dp_id = row["dp_id"]
    source_filter = row["filter"]
    filename = image["eso_origfile"]
    filename_match = re.fullmatch(r"KiDS_DR5\.0_(.+)_(g|r|i2?)_sci\.fits", filename)
    if not re.fullmatch(r"KIDS_[+-]?[0-9]+(?:\.[0-9]+)?_[+-]?[0-9]+(?:\.[0-9]+)?", unit_id) or not filename_match:
        raise ValueError("KiDS row has an unsupported native Tile or file identity")
    if row["release_description"] != RELEASE_URL or source_filter not in EXPECTED_BANDS:
        raise ValueError("KiDS row is outside the frozen DR5 gri selector")
    if filename_match.group(1) != unit_id[5:] or urllib.parse.urlsplit(astro_wise_uri).path.rsplit("/", 1)[-1] != filename:
        raise ValueError("KiDS ESO and Astro-WISE rows do not match by exact filename")
    epoch = filename_match.group(2)
    band = "I" if epoch in ("i", "i2") else epoch.upper()
    if (source_filter[0].upper() != band or (source_filter[0].lower() == "i" and epoch not in ("i", "i2"))):
        raise ValueError("KiDS source filter and filename epoch disagree")
    data_link_url = urllib.parse.urlsplit(row["access_url"])
    expected_id = f"ivo://eso.org/ID?{dp_id}"
    if data_link_url.scheme != "https" or data_link_url.hostname != "archive.eso.org" or data_link_url.path != "/datalink/links" or urllib.parse.parse_qs(data_link_url.query).get("ID") != [expected_id]:
        raise ValueError("KiDS ObsCore DataLink URL is not the source-listed request for this dp_id")
    return {
        "unitId": unit_id,
        "sRegion": transform_j2000_polygon(row["s_region"]),
        "bands": [band],
        "filename": filename,
        "accessUris": [
            {"sourceId": "eso-datalink", "uri": image["access_url"], "fileName": filename, "band": band, "accessType": "file"},
            {"sourceId": "kids-astro-wise-wget-list", "uri": astro_wise_uri, "fileName": filename, "band": band, "accessType": "file"},
        ],
        "sourceMetadata": {
            "dpId": dp_id,
            "obsId": row.get("obs_id", ""),
            "obsCreatorDid": row.get("obs_creator_did", ""),
            "targetName": unit_id,
            "sourceTargetName": unit_id,
            "obsCollection": "KIDS",
            "dataproductType": "image",
            "filter": source_filter,
            "epoch": epoch,
            "nativeCoordinateFrame": "J2000",
            "sourceSRegion": row["s_region"],
            "geometryTransform": "FK5(equinox=J2000) polygon vertices transformed to ICRS with Astropy",
            "releaseDescription": RELEASE_URL,
            "dataLinkUrl": row["access_url"],
            "dataLinkUri": image["access_url"],
            "dataLinkResponseSha256": response_sha,
            "dataLinkSemantics": "#this",
            "dataLinkCategory": image["eso_category"],
            "dataLinkFileName": image["eso_origfile"],
            "esoOriginalFile": image["eso_origfile"],
            "astroWiseUri": astro_wise_uri,
            "astroWiseFilename": filename,
            "astroWiseRosterMatchedBy": "exact-filename",
            "accessSemantics": "whole-science-image",
            "contentLength": int(image["content_length"]) if image.get("content_length", "").isdigit() else None,
        },
    }


def acquire_datalink(row: dict[str, str]) -> tuple[str, bytes, dict[str, str], str, str]:
    body, status, response_uri = request_bytes(row["access_url"], timeout=90, accept="application/x-votable+xml,text/xml,*/*")
    if status != 200:
        raise ValueError(f"ESO DataLink returned HTTP {status} for {row['dp_id']}")
    source_filename = row.get("obs_creator_did", "").partition("?")[2]
    if not source_filename:
        raise ValueError(f"KiDS ObsCore row has no original filename in obs_creator_did: {row['dp_id']}")
    image = parse_datalink(body, row["dp_id"], source_filename)
    return row["dp_id"], body, image, row["access_url"], response_uri


def write_gzip_jsonl(path: Path, rows: list[dict]) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    body = path.read_bytes()
    return sha256(body), len(body)


def probe_head(uri: str, timeout: int = 60) -> dict[str, object]:
    request = urllib.request.Request(uri, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {"uri": uri, "status": response.status, "contentType": response.headers.get("Content-Type"), "contentLength": response.headers.get("Content-Length"), "method": "HEAD"}
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        return {"uri": uri, "status": None, "error": str(reason)[:300], "method": "HEAD"}


def capture(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    release_pdf, release_status, release_uri = request_bytes(RELEASE_URL, accept="application/pdf,*/*")
    if release_status != 200 or not release_pdf.startswith(b"%PDF-"):
        raise ValueError("ESO KiDS DR5 release description did not return the expected PDF")
    release_path = output / "metadata/release-description-229.pdf"
    immutable_write(release_path, release_pdf)

    roster_body, roster_status, roster_uri = request_bytes(ROSTER_URL, accept="text/plain,*/*")
    if roster_status != 200:
        raise ValueError(f"KiDS DR5 Astro-WISE source list returned HTTP {roster_status}")
    roster_by_name, roster_band_counts = parse_roster(roster_body)
    roster_path = output / "metadata/kids_dr5.0_sci_wget.sh"
    immutable_write(roster_path, roster_body)

    denominator_body, denominator_rows, _, denominator_url = query(DENOMINATOR_QUERY)
    band_body, band_rows, _, band_url = query(BAND_COUNTS_QUERY)
    if len(denominator_rows) != 1 or int(denominator_rows[0]["row_count"]) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore denominator differs from the official 5,388-image KiDS DR5 gri release")
    observed_bands = {row["filter"]: int(row["n"]) for row in band_rows}
    if observed_bands != EXPECTED_BANDS:
        raise ValueError(f"ESO ObsCore KiDS DR5 band counts changed: {observed_bands}")

    tap_pages: list[dict[str, object]] = []
    source_rows: list[dict[str, str]] = []
    last_dp_id = ""
    while True:
        query_text = SOURCE_QUERY if not last_dp_id else (
            f"SELECT TOP {PAGE_SIZE} {SELECT} FROM ivoa.ObsCore WHERE {WHERE} AND dp_id > '{last_dp_id}' ORDER BY dp_id"
        )
        page_body, page_rows, overflow, page_url = query(query_text)
        continue_pages = should_continue_tap_pages(len(page_rows), overflow)
        ids = [row["dp_id"] for row in page_rows]
        if ids != sorted(ids) or (last_dp_id and ids[0] <= last_dp_id):
            raise ValueError("ESO TAP keyset pages are not strictly ordered by dp_id")
        relative = f"metadata/tap-page-{len(tap_pages) + 1:03d}.vot"
        immutable_write(output / relative, page_body)
        tap_pages.append({
            "ref": relative, "url": page_url, "status": 200, "queryStatus": "OVERFLOW" if overflow else "OK", "rows": len(page_rows),
            "overflow": overflow, "firstDpId": ids[0], "lastDpId": ids[-1], "query": query_text,
        })
        source_rows.extend(page_rows)
        last_dp_id = ids[-1]
        print(json.dumps({"tapPages": len(tap_pages), "rows": len(source_rows), "overflow": overflow}), flush=True)
        if not continue_pages:
            break
        if len(tap_pages) > 10:
            raise ValueError("ESO TAP keyset page budget exceeded")

    if len(source_rows) != EXPECTED_ROWS or len({row["dp_id"] for row in source_rows}) != EXPECTED_ROWS:
        raise ValueError("ESO ObsCore rows differ from the complete KiDS DR5 gri image denominator")
    tile_ids = {row["target_name"] for row in source_rows}
    if len(tile_ids) != EXPECTED_TILES:
        raise ValueError(f"ESO ObsCore Tile count differs from the official 1,347 Tiles: {len(tile_ids)}")
    source_rows.sort(key=lambda row: row["dp_id"])

    metadata_documents: list[dict[str, object]] = []
    for relative, body, uri in [
        ("metadata/denominator.vot", denominator_body, denominator_url),
        ("metadata/band-counts.vot", band_body, band_url),
        ("metadata/release-description-229.pdf", release_pdf, release_uri),
        ("metadata/kids_dr5.0_sci_wget.sh", roster_body, roster_uri),
    ]:
        file_path = output / relative
        immutable_write(file_path, body)
        metadata_documents.append({"ref": relative, "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": uri})
    for page in tap_pages:
        page_path = output / str(page["ref"])
        body = page_path.read_bytes()
        metadata_documents.append({"ref": page["ref"], "sha256": sha256(body), "sizeBytes": len(body), "sourceUrl": page["url"]})

    link_results: dict[str, tuple[bytes, dict[str, str], str, str, str]] = {}
    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(acquire_datalink, row) for row in source_rows]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                dp_id, body, image, source_uri, response_uri = future.result()
                link_results[dp_id] = (body, image, source_uri, response_uri, sha256(body))
            except Exception as error:
                failures.append(str(error))
            if index % 250 == 0:
                print(json.dumps({"datalinksCompleted": index, "resolved": len(link_results), "errors": len(failures)}), flush=True)
    if failures or len(link_results) != EXPECTED_ROWS:
        failure_doc = {"expected": EXPECTED_ROWS, "resolved": len(link_results), "errors": sorted(failures)}
        immutable_write(output / "metadata/datalink-failures.json", json.dumps(failure_doc, sort_keys=True, indent=2).encode())
        raise ValueError(f"KiDS DR5 DataLink capture incomplete: {len(link_results)}/{EXPECTED_ROWS} resolved")

    raw_datalinks = []
    normalized_rows = []
    epoch_counts = {"i": 0, "i2": 0}
    observed_image_counts = {band: 0 for band in EXPECTED_BANDS}
    source_uri_set: set[str] = set()
    for row in source_rows:
        body, image, data_link_url, _, response_sha = link_results[row["dp_id"]]
        filename = image["eso_origfile"]
        astro_wise_uri = roster_by_name.get(filename)
        if not astro_wise_uri:
            raise ValueError(f"KiDS DR5 ESO filename is absent from the official Astro-WISE roster: {filename}")
        normalized_rows.append(normalize_row(row, image, response_sha, astro_wise_uri))
        match = re.search(r"_(i2?|g|r)_sci\.fits$", filename)
        if not match:
            raise ValueError(f"KiDS DR5 source filename has no supported band epoch: {filename}")
        epoch = match.group(1)
        source_filter = row["filter"]
        observed_image_counts[source_filter] += 1
        if epoch in epoch_counts:
            epoch_counts[epoch] += 1
        source_uri_set.add(data_link_url)
        raw_datalinks.append({
            "dpId": row["dp_id"], "url": data_link_url, "status": 200,
            "responseSha256": response_sha, "bodyBase64": base64.b64encode(body).decode("ascii"),
        })
    if len(source_uri_set) != EXPECTED_ROWS or observed_image_counts != EXPECTED_BANDS or epoch_counts != {"i": 1347, "i2": 1347}:
        raise ValueError("KiDS DR5 filename, band or i-epoch rows do not match the published source roster")
    raw_datalinks.sort(key=lambda item: str(item["dpId"]))
    datalink_path = output / "metadata/datalinks.ndjson.gz"
    datalink_sha, datalink_size = write_gzip_jsonl(datalink_path, raw_datalinks)
    metadata_documents.append({"ref": "metadata/datalinks.ndjson.gz", "sha256": datalink_sha, "sizeBytes": datalink_size, "sourceUrl": "https://archive.eso.org/datalink/links"})

    row_path = output / "normalized/native-rows.ndjson.gz"
    row_sha, row_size = write_gzip_jsonl(row_path, normalized_rows)

    samples = [
        next(row for row in normalized_rows if row["sourceMetadata"]["epoch"] == "g"),
        next(row for row in normalized_rows if row["sourceMetadata"]["epoch"] == "i2"),
    ]
    heads = []
    for sample in samples:
        for access in sample["accessUris"]:
            heads.append(probe_head(access["uri"]))
    head_body = json.dumps(heads, sort_keys=True, indent=2).encode()
    immutable_write(output / "metadata/representative-head-checks.json", head_body)
    metadata_documents.append({"ref": "metadata/representative-head-checks.json", "sha256": sha256(head_body), "sizeBytes": len(head_body), "sourceUrl": "https://dataportal.eso.org/"})
    metadata_documents.sort(key=lambda item: str(item["ref"]))

    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "eso-obscore-kids", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured_at, "coordinateFrame": "ICRS", "nativeCoordinateFrame": "J2000", "ordering": "NESTED",
        "queryPagesComplete": True, "inventoryComplete": True,
        "scope": {
            "obsCollection": "KIDS", "releaseDescription": RELEASE_URL, "dataproductType": "image",
            "filters": ["g_SDSS", "r_SDSS", "i_SDSS"], "bandCounts": {"G": 1347, "R": 1347, "I": 2694},
            "expectedRowCount": EXPECTED_ROWS, "expectedTileCount": EXPECTED_TILES, "scienceImageRowsOnly": True,
            "sourceRosterRows": 6735, "sourceRosterTileCount": EXPECTED_TILES, "rosterBandCounts": roster_band_counts,
            "rosterJoinRows": EXPECTED_ROWS, "iEpochCounts": epoch_counts, "validPixelMasksChecked": False,
            "sourceRepresentationsByteIdentical": False,
        },
        "sourcePagination": {
            "queryPagesComplete": True, "pageSize": PAGE_SIZE, "expectedRowCount": EXPECTED_ROWS, "tileCount": EXPECTED_TILES,
            "dataLinkRequestedCount": EXPECTED_ROWS, "dataLinkThisCount": len(source_uri_set), "dataLinkErrors": 0,
            "denominator": {"status": 200, "queryStatus": "OK", "rowCount": int(denominator_rows[0]["row_count"])},
            "bandCounts": {"status": 200, "queryStatus": "OK", **observed_bands},
            "releaseDocument": {"status": release_status, "url": release_uri},
            "sourceRoster": {"status": roster_status, "url": roster_uri, "rowCount": len(roster_by_name), "sha256": sha256(roster_body)},
            "pages": tap_pages,
        },
        "metadataDocuments": metadata_documents,
        "rowFiles": [{"ref": "normalized/native-rows.ndjson.gz", "sha256": row_sha, "sizeBytes": row_size, "rows": len(normalized_rows)}],
        "rowCount": len(normalized_rows),
    }
    manifest_body = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    immutable_write(output / "manifest.json", manifest_body)
    return {"sourceId": SOURCE_ID, "manifest": "manifest.json", "manifestSha256": sha256(manifest_body), "manifestSizeBytes": len(manifest_body), "rowCount": len(normalized_rows), "tileCount": len(tile_ids), "metadataDocuments": len(metadata_documents), "dataLinkEvidenceSha256": datalink_sha, "rowSha256": row_sha, "heads": heads}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New immutable staging directory")
    args = parser.parse_args()
    print(json.dumps(capture(args.output), indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
