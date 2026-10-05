#!/usr/bin/env python3
"""Capture Pan-STARRS DR1 zone 23 skycell listings and metadata-only WCS evidence."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS


SOURCE_ID = "panstarrs-dr1-zone23-skycells"
SOURCE_URL = "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py"
GRID_URL = "https://outerspace.stsci.edu/download/attachments/298812317/ps1grid.fits?version=1&modificationDate=1532367528459&api=v2"
SURVEY_ID = "panstarrs"
RELEASE_ID = "panstarrs-dr1"
ADAPTER = "panstarrs-dr1-skycell"
QUERY = "skycell={projection}.{subcell}&type=stack"
ZONE_ID = 23
PROJECTION_START = 1322
PROJECTION_COUNT = 90
SUBCELLS_PER_PROJECTION = 100
EXPECTED_SKYCELLS = PROJECTION_COUNT * SUBCELLS_PER_PROJECTION
FILTERS = ("g", "r", "i", "z", "y")
HEADER_SAMPLE = "1405.053"
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only Pan-STARRS collector/1.0"
MAX_LISTING_BYTES = 2 * 1024 * 1024


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def immutable_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(body)


def request_bytes(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, timeout: int = 60) -> tuple[bytes, int, dict[str, str], str]:
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    request = urllib.request.Request(url, method=method, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_LISTING_BYTES + 1)
        if len(body) > MAX_LISTING_BYTES:
            raise ValueError("Pan-STARRS metadata response exceeded its size budget")
        return body, response.status, dict(response.headers.items()), response.url


def grid_zone_record(body: bytes) -> dict[str, int | float]:
    with fits.open(io.BytesIO(body), memmap=False) as hdus:
        table = hdus[1].data
        matches = [row for row in table if int(row["ZONE"]) == ZONE_ID]
        if len(matches) != 1:
            raise ValueError("Official PS1 grid does not contain exactly one zone 23 row")
        row = matches[0]
        record = {
            "zone": int(row["ZONE"]),
            "projectionStart": int(row["PROJCELL"]),
            "projectionCount": int(row["NBAND"]),
            "decCenter": float(row["DEC"]),
            "decMin": float(row["DEC_MIN"]),
            "decMax": float(row["DEC_MAX"]),
            "xCell": int(row["XCELL"]),
            "yCell": int(row["YCELL"]),
            "crpix1": float(row["CRPIX1"]),
            "crpix2": float(row["CRPIX2"]),
        }
    expected = {
        "zone": ZONE_ID,
        "projectionStart": PROJECTION_START,
        "projectionCount": PROJECTION_COUNT,
        "decCenter": 2.0,
        "decMin": 1.3877787807814457e-17,
        "decMax": 3.998086931795508,
        "xCell": 6240,
        "yCell": 6243,
        "crpix1": 240.0,
        "crpix2": 242.0,
    }
    if record != expected:
        raise ValueError(f"Official PS1 zone 23 grid differs from its reviewed values: {record}")
    return record


def skycell_ids(grid: dict[str, int | float]) -> list[str]:
    return [f"{projection}.{subcell:03d}"
            for projection in range(int(grid["projectionStart"]), int(grid["projectionStart"]) + int(grid["projectionCount"]))
            for subcell in range(SUBCELLS_PER_PROJECTION)]


def parse_listing(body: bytes, skycell: str) -> list[dict[str, object]]:
    text = body.decode("ascii")
    lines = text.rstrip().splitlines()
    expected_header = "projcell subcell ra dec filter mjd type filename shortname badflag"
    if not lines or " ".join(lines[0].split()) != expected_header:
        raise ValueError(f"PS1 listing has an unexpected header for {skycell}")
    projection_id, subcell = (int(value) for value in skycell.split("."))
    rows = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) != 10:
            raise ValueError(f"PS1 listing has a malformed row for {skycell}")
        proj, sub, ra, dec, band, mjd, image_type, filename, shortname, badflag = fields
        ra_value = float(ra)
        dec_value = float(dec)
        mjd_value = float(mjd)
        badflag_value = int(badflag)
        if (int(proj) != projection_id or int(sub) != subcell or band not in FILTERS or image_type != "stack"
                or not -360 <= ra_value < 360 or not -90 <= dec_value <= 90 or not np.isfinite(mjd_value) or badflag_value < 0):
            raise ValueError(f"PS1 listing returned a row outside requested skycell {skycell}")
        expected_path = f"/rings.v3.skycell/{projection_id:04d}/{subcell:03d}/rings.v3.skycell.{skycell}.stk.{band}.unconv.fits"
        if filename != expected_path or shortname != filename.rsplit("/", 1)[-1]:
            raise ValueError(f"PS1 listing returned a noncanonical DR1 stack file for {skycell}")
        rows.append({
            "projectionId": projection_id,
            "subcell": subcell,
            "ra": ra_value % 360,
            "dec": dec_value,
            "band": band,
            "mjd": mjd_value,
            "type": image_type,
            "filename": filename,
            "shortname": shortname,
            "badflag": badflag_value,
        })
    return rows


def listing_url(skycell: str) -> str:
    query = urllib.parse.urlencode((("skycell", skycell), ("type", "stack")))
    return f"{SOURCE_URL}?{query}"


def query_skycell(skycell: str) -> dict[str, object]:
    url = listing_url(skycell)
    failure: Exception | None = None
    for attempt in range(4):
        try:
            body, status, _headers, final_url = request_bytes(url, headers={"Accept": "text/plain"})
            if status != 200 or final_url != url:
                raise ValueError(f"PS1 metadata service returned HTTP {status} or redirected {skycell}")
            rows = parse_listing(body, skycell)
            return {"skycell": skycell, "url": final_url, "status": status, "rows": len(rows),
                    "responseSha256": sha256(body), "bodyBase64": base64.b64encode(body).decode("ascii")}
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            failure = error
            if isinstance(error, urllib.error.HTTPError) and error.code < 500 and error.code != 429:
                break
            if attempt < 3:
                time.sleep(2**attempt)
    assert failure is not None
    status = failure.code if isinstance(failure, urllib.error.HTTPError) else 0
    return {"skycell": skycell, "url": url, "status": status, "rows": 0,
            "responseSha256": "", "error": str(failure)}


def validate_query_receipt(receipt: dict[str, object], skycell: str) -> bool:
    body_base64 = str(receipt.get("bodyBase64", ""))
    try:
        body = base64.b64decode(body_base64, validate=True)
        rows = parse_listing(body, skycell)
    except (ValueError, base64.binascii.Error):
        return False
    return (receipt.get("skycell") == skycell and receipt.get("url") == listing_url(skycell)
            and receipt.get("status") == 200 and bool(body)
            and base64.b64encode(body).decode("ascii") == body_base64
            and receipt.get("responseSha256") == sha256(body) and receipt.get("rows") == len(rows))


def write_checkpoint(path: Path, receipt: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(receipt, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
    os.replace(temporary, path)


def frame_polygon(grid: dict[str, int | float], projection_id: int, subcell: int) -> tuple[str, list[tuple[float, float]]]:
    x = subcell % 10
    y = subcell // 10
    reference_ra = 360.0 * (projection_id - int(grid["projectionStart"])) / int(grid["projectionCount"])
    crpix1 = float(grid["crpix1"]) + (5 - x) * (int(grid["xCell"]) - 480)
    crpix2 = float(grid["crpix2"]) + (5 - y) * (int(grid["yCell"]) - 480)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [reference_ra, float(grid["decCenter"])]
    wcs.wcs.crpix = [crpix1, crpix2]
    wcs.wcs.cdelt = [0.25 / 3600, 0.25 / 3600]
    wcs.wcs.pc = [[-1.0, 0.0], [0.0, 1.0]]
    corners = np.asarray([[0.5, 0.5], [int(grid["xCell"]) + 0.5, 0.5],
                          [int(grid["xCell"]) + 0.5, int(grid["yCell"]) + 0.5],
                          [0.5, int(grid["yCell"]) + 0.5]])
    world = wcs.all_pix2world(corners, 1)
    icrs = SkyCoord(ra=world[:, 0] * u.deg, dec=world[:, 1] * u.deg,
                    frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    vertices = [(float(ra % 360), float(dec)) for ra, dec in zip(icrs.ra.deg, icrs.dec.deg)]
    region = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in vertices)
    return region, vertices


def fits_extension_header(header_bytes: bytes) -> fits.Header:
    end_offsets = [offset for offset in range(0, len(header_bytes), 80)
                   if header_bytes[offset:offset + 8].strip() == b"END"]
    if len(end_offsets) < 2:
        raise ValueError("PS1 sample range did not reach both FITS header END cards")
    extension_start = ((end_offsets[0] // 2880) + 1) * 2880
    extension_end = ((end_offsets[1] // 2880) + 1) * 2880
    return fits.Header.fromstring(header_bytes[extension_start:extension_end].decode("ascii"), sep="")


def capture_sample_header(grid: dict[str, int | float], listing_receipt: dict[str, object]) -> tuple[dict[str, object], bytes]:
    sample_rows = parse_listing(base64.b64decode(str(listing_receipt["bodyBase64"])), HEADER_SAMPLE)
    g_row = next((row for row in sample_rows if row["band"] == "g" and row["badflag"] == 0), None)
    if g_row is None:
        raise ValueError("PS1 representative skycell has no usable g stack image")
    url = "https://ps1images.stsci.edu" + str(g_row["filename"])
    _head_body, head_status, head_headers, final_url = request_bytes(url, method="HEAD", headers={"Accept": "application/fits"})
    file_size = int(head_headers.get("Content-Length", "0"))
    if head_status != 200 or final_url != url or file_size < 23_040 or head_headers.get("Accept-Ranges", "").lower() != "bytes":
        raise ValueError("PS1 representative stack image does not support bounded range-header checks")
    chunks: list[bytes] = []
    ranges: list[dict[str, object]] = []
    end_cards = 0
    for block in range(64):
        start = block * 2880
        end = start + 2879
        body, status, headers, _final = request_bytes(url, headers={"Range": f"bytes={start}-{end}", "Accept": "application/fits"})
        expected_range = f"bytes {start}-{end}/{file_size}"
        if status != 206 or len(body) != 2880 or headers.get("Content-Range") != expected_range:
            raise ValueError("PS1 representative FITS header range was not an exact HTTP 206 block")
        chunks.append(body)
        ranges.append({"start": start, "endInclusive": end, "status": status,
                       "contentRange": headers["Content-Range"], "bytesRead": len(body)})
        end_cards = sum(1 for offset in range(0, sum(map(len, chunks)), 80)
                        if b"".join(chunks)[offset:offset + 8].strip() == b"END")
        if end_cards >= 2:
            break
    header_bytes = b"".join(chunks)
    if end_cards != 2 or len(header_bytes) != 23_040:
        raise ValueError("PS1 representative image headers did not end at the expected two HDU boundaries")
    header = fits_extension_header(header_bytes)
    if header.get("SKYCELL") != "skycell.1405.053" or header.get("ZNAXIS1") != 6240 or header.get("ZNAXIS2") != 6243:
        raise ValueError("PS1 representative FITS header identity or compressed-image dimensions changed")
    sample_wcs = WCS(header, naxis=2)
    corners = np.asarray([[0.5, 0.5], [6240.5, 0.5], [6240.5, 6243.5], [0.5, 6243.5]])
    world = sample_wcs.all_pix2world(corners, 1)
    sample_icrs = SkyCoord(ra=world[:, 0] * u.deg, dec=world[:, 1] * u.deg,
                           frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    _region, derived = frame_polygon(grid, 1405, 53)
    separations = sample_icrs.separation(SkyCoord(ra=[p[0] for p in derived] * u.deg,
                                                  dec=[p[1] for p in derived] * u.deg, frame=ICRS()))
    if max(separations.arcsec) > 0.25:
        raise ValueError("Official PS1 grid geometry differs from the representative FITS header by more than one pixel")
    metadata = {
        "unitId": HEADER_SAMPLE,
        "band": "g",
        "url": url,
        "status": 206,
        "fileSizeBytes": file_size,
        "headerBytes": len(header_bytes),
        "sha256": sha256(header_bytes),
        "endCards": end_cards,
        "gridWcsMaxCornerDifferenceArcsec": float(max(separations.arcsec)),
        "wcs": {key: header[key] for key in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2", "PC001001", "PC002002", "ZNAXIS1", "ZNAXIS2")},
        "ranges": ranges,
    }
    return metadata, header_bytes


def write_gzip_jsonl(path: Path, rows: list[dict[str, object]]) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    body = path.read_bytes()
    return sha256(body), len(body)


def document_record(path: Path, ref: str, url: str) -> dict[str, object]:
    body = path.read_bytes()
    return {"ref": ref, "sha256": sha256(body), "sizeBytes": len(body), "url": url}


def capture(output: Path, workers: int, resume: bool = False) -> dict[str, object]:
    if output.exists():
        raise FileExistsError(f"Immutable output path already exists: {output}")
    checkpoint = output.with_name(output.name + ".partial")
    if resume:
        if not checkpoint.is_dir():
            raise FileNotFoundError(f"No Pan-STARRS partial capture exists to resume: {checkpoint}")
    else:
        checkpoint.mkdir(parents=True, exist_ok=False)

    grid_body, grid_status, _grid_headers, _grid_response_url = request_bytes(GRID_URL, headers={"Accept": "application/fits"})
    if grid_status != 200 or len(grid_body) != 11_520:
        raise ValueError("Official PS1 grid FITS response did not match its reviewed size")
    grid = grid_zone_record(grid_body)
    grid_sha = sha256(grid_body)
    capture_state_path = checkpoint / "capture.json"
    if capture_state_path.exists():
        capture_state = json.loads(capture_state_path.read_text(encoding="utf-8"))
        if capture_state.get("zone") != ZONE_ID or capture_state.get("gridSha256") != grid_sha:
            raise ValueError("Pan-STARRS partial capture does not match the current official zone 23 grid")
        captured_at = str(capture_state["capturedAt"])
    else:
        captured_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        write_checkpoint(capture_state_path, {"zone": ZONE_ID, "gridSha256": grid_sha, "capturedAt": captured_at})
    cells = skycell_ids(grid)
    if len(cells) != EXPECTED_SKYCELLS:
        raise ValueError("Official PS1 zone 23 candidate grid has an unexpected number of skycells")

    responses: dict[str, dict[str, object]] = {}
    previous_failures: dict[str, dict[str, object]] = {}
    pending_cells = []
    for cell in cells:
        receipt_path = checkpoint / "queries" / f"{cell}.json"
        if not receipt_path.exists():
            pending_cells.append(cell)
            continue
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if validate_query_receipt(receipt, cell):
            responses[cell] = receipt
        elif receipt.get("status") == 200:
            raise ValueError(f"Pan-STARRS successful checkpoint is corrupt for {cell}")
        else:
            if receipt.get("skycell") != cell or receipt.get("url") != listing_url(cell):
                raise ValueError(f"Pan-STARRS failed checkpoint identity does not match {cell}")
            previous_failures[cell] = receipt
            pending_cells.append(cell)

    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(query_skycell, cell): cell for cell in pending_cells}
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            cell = futures[future]
            try:
                receipt = future.result()
            except Exception as error:
                receipt = {"skycell": cell, "url": listing_url(cell), "status": 0, "rows": 0,
                           "responseSha256": "", "error": str(error)}
            if cell in previous_failures:
                receipt["previousFailure"] = previous_failures[cell]
            write_checkpoint(checkpoint / "queries" / f"{cell}.json", receipt)
            if validate_query_receipt(receipt, cell):
                responses[cell] = receipt
            else:
                failures.append(cell)
            if index % 250 == 0 or index == len(pending_cells):
                print(f"Pan-STARRS zone 23: {len(responses)}/{len(cells)} successful metadata responses; {len(failures)} failures this run", flush=True)

    if failures:
        raise RuntimeError(f"Pan-STARRS metadata capture has {len(failures)} failed skycell queries; rerun with --resume")
    if len(responses) != len(cells):
        raise RuntimeError(f"Pan-STARRS metadata capture has only {len(responses)}/{len(cells)} verified skycell responses")

    receipt_rows = [responses[cell] for cell in cells]
    normalized_rows: list[dict[str, object]] = []
    band_counts = {band.upper(): 0 for band in FILTERS}
    empty_count = 0
    badflag_excluded = 0
    for cell in cells:
        receipt = responses[cell]
        source_rows = parse_listing(base64.b64decode(str(receipt["bodyBase64"])), cell)
        if not source_rows:
            empty_count += 1
        projection_id, subcell = (int(value) for value in cell.split("."))
        region, _vertices = frame_polygon(grid, projection_id, subcell)
        query_response_sha = str(receipt["responseSha256"])
        query_url = str(receipt["url"])
        for item in source_rows:
            if item["badflag"] != 0:
                badflag_excluded += 1
                continue
            band = str(item["band"]).upper()
            file_name = str(item["shortname"])
            source_filename = str(item["filename"])
            uri = "https://ps1images.stsci.edu" + source_filename
            normalized_rows.append({
                "unitId": cell,
                "sRegion": region,
                "bands": [band],
                "filename": file_name,
                "accessUris": [{"sourceId": "ps1-stsci", "uri": uri, "fileName": file_name, "accessType": "file", "band": band}],
                "sourceMetadata": {
                    "zone": ZONE_ID,
                    "projectionId": projection_id,
                    "subcell": subcell,
                    "filter": str(item["band"]),
                    "imageType": "stack",
                    "badFlag": 0,
                    "catalogRa": item["ra"],
                    "catalogDec": item["dec"],
                    "sourceFilename": source_filename,
                    "coordinateFrame": "FK5(J2000)",
                    "geometrySource": "official PS1 zone 23 skycell WCS rule; representative FITS header checked",
                    "geometryPrecision": "estimated",
                    "gridSha256": grid_sha,
                    "listingResponseSha256": query_response_sha,
                    "queryUrl": query_url,
                    "validPixelMasksChecked": False,
                    "individualFileAvailabilityVerified": False,
                },
            })
            band_counts[band] += 1

    if not normalized_rows:
        raise ValueError("PS1 zone 23 query produced no usable stack files")

    header_details, header_body = capture_sample_header(grid, responses[HEADER_SAMPLE])
    output.mkdir(parents=True, exist_ok=False)
    grid_path = output / "metadata/ps1-grid.fits"
    immutable_write(grid_path, grid_body)
    zone_path = output / "metadata/zone-23-grid.json"
    zone_bytes = (json.dumps({**grid, "gridSha256": sha256(grid_body)}, sort_keys=True, separators=(",", ":")) + "\n").encode()
    immutable_write(zone_path, zone_bytes)
    receipts_path = output / "metadata/skycell-query-receipts.ndjson.gz"
    receipt_sha, receipt_size = write_gzip_jsonl(receipts_path, receipt_rows)
    header_path = output / "metadata/representative-header.bin"
    immutable_write(header_path, header_body)
    header_receipt_path = output / "metadata/representative-header.json"
    header_receipt_bytes = (json.dumps(header_details, sort_keys=True, separators=(",", ":")) + "\n").encode()
    immutable_write(header_receipt_path, header_receipt_bytes)
    row_path = output / "normalized/native-rows.ndjson.gz"
    row_sha, row_size = write_gzip_jsonl(row_path, normalized_rows)

    documents = [
        document_record(grid_path, "metadata/ps1-grid.fits", GRID_URL),
        document_record(zone_path, "metadata/zone-23-grid.json", GRID_URL),
        document_record(receipts_path, "metadata/skycell-query-receipts.ndjson.gz", SOURCE_URL),
        document_record(header_receipt_path, "metadata/representative-header.json", str(header_details["url"])),
        document_record(header_path, "metadata/representative-header.bin", str(header_details["url"])),
    ]
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "deliveryClass": "evidence",
        "adapter": ADAPTER,
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "capturedAt": captured_at,
        "coordinateFrame": "ICRS",
        "nativeCoordinateFrame": "FK5(J2000)",
        "ordering": "NESTED",
        "inventoryComplete": False,
        "queryPagesComplete": True,
        "rowCount": len(normalized_rows),
        "scope": {
            "zone": ZONE_ID,
            "projectionStart": PROJECTION_START,
            "projectionCount": PROJECTION_COUNT,
            "expectedSkycellCount": EXPECTED_SKYCELLS,
            "queriedSkycellCount": len(responses),
            "emptySkycellCount": empty_count,
            "expectedImageCount": len(normalized_rows),
            "badFlagAcceptedValue": 0,
            "badFlagExcludedRows": badflag_excluded,
            "bandCounts": band_counts,
            "fullSurveyInventory": False,
            "geometryPrecision": "estimated",
            "geometrySource": "official zone 23 grid WCS rule, checked against representative DR1 stack FITS header",
            "validPixelMasksChecked": False,
            "headerOnlyGeometryCheck": True,
            "individualFileAvailabilityVerified": False,
        },
        "sourcePagination": {
            "queryPagesComplete": True,
            "pageSize": 1,
            "expectedSkycellCount": EXPECTED_SKYCELLS,
            "pages": [{"page": 1, "status": 200, "queryStatus": "OK", "query": QUERY,
                       "url": SOURCE_URL, "rows": EXPECTED_SKYCELLS,
                       "receiptRef": "metadata/skycell-query-receipts.ndjson.gz", "receiptSha256": receipt_sha}],
        },
        "metadataDocuments": documents,
        "rowFiles": [{"ref": "normalized/native-rows.ndjson.gz", "sha256": row_sha,
                      "sizeBytes": row_size, "rows": len(normalized_rows), "sourceUrl": SOURCE_URL}],
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode())
    return {"manifest": str(manifest_path), "skycellCount": len(cells), "emptySkycellCount": empty_count,
            "imageCount": len(normalized_rows), "badFlagExcludedRows": badflag_excluded,
            "bandCounts": band_counts, "gridSha256": sha256(grid_body), "receiptSha256": receipt_sha,
            "rowSha256": row_sha, "rowBytes": row_size, "sampleHeaderSha256": str(header_details["sha256"])}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new immutable evidence capture directory")
    parser.add_argument("--workers", type=int, default=8, help="parallel metadata requests (1-16; default 8)")
    parser.add_argument("--resume", action="store_true", help="resume the matching <output>.partial metadata capture")
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("--workers must be between 1 and 16")
    result = capture(args.output, args.workers, args.resume)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
