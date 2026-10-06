#!/usr/bin/env python3
"""Capture one SPHEREx QR2 observation roster and FITS headers, never pixels."""

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

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS


SOURCE_ROOT = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IRSA_ROOT = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
SOURCE_ID = "spherex-qr2-2025w17-4b-0001-1"
SURVEY_ID = "spherex"
RELEASE_ID = "spherex-qr2"
OBSERVING_RUN = "2025W17_4B"
PROCESSING_VERSION = "l2b-v20-2025-240"
OBSERVATION_SELECTOR = "2025W17_4B_0001_1"
OBSERVATION_ID = OBSERVATION_SELECTOR
DETECTORS = [2, 3, 4, 5, 6]
PAGE_SIZE = 1000
EXPECTED_ROW_COUNT = len(DETECTORS)
BLOCK_SIZE = 2880
MAX_HEADER_BLOCKS = 64
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only SPHEREx collector/1.0"
LISTING_QUERY = (
    "ListObjectsV2 prefix=qr2/level2/2025W17_4B/l2b-v20-2025-240/"
    "{2,3,4,5,6}/level2_2025W17_4B_0001_1D{2,3,4,5,6}_spx_l2b-v20-2025-240.fits; one QR2 observation"
)
SPHEREX_D1_V241_SOURCE_ID = "spherex-qr2-2025w17-4b-0001-1-d1-v241"
SPHEREX_D1_V241_QUERY = (
    "ListObjectsV2 prefix=qr2/level2/2025W17_4B/l2b-v20-2025-241/1/"
    "level2_2025W17_4B_0001_1D1_spx_l2b-v20-2025-241.fits; one QR2 D1 observation"
)
CAPTURE_PROFILES = {
    "observation-v20-240": {
        "source_id": SOURCE_ID,
        "observing_run": OBSERVING_RUN,
        "processing_version": PROCESSING_VERSION,
        "observation_selector": OBSERVATION_SELECTOR,
        "observation_id": OBSERVATION_ID,
        "detectors": DETECTORS,
        "query": LISTING_QUERY,
        "versioned_unit_id": False,
    },
    "d1-v20-241": {
        "source_id": SPHEREX_D1_V241_SOURCE_ID,
        "observing_run": OBSERVING_RUN,
        "processing_version": "l2b-v20-2025-241",
        "observation_selector": OBSERVATION_SELECTOR,
        "observation_id": OBSERVATION_ID,
        "detectors": [1],
        "query": SPHEREX_D1_V241_QUERY,
        "versioned_unit_id": True,
    },
}
DEFAULT_PROFILE = CAPTURE_PROFILES["observation-v20-240"]


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
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body)}


def response_header(headers, name: str) -> str:
    for key, value in headers.items():
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def request_bytes(url: str, headers: dict | None = None, timeout: int = 45):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        limit = BLOCK_SIZE if headers and "Range" in headers else 16 * 1024 * 1024
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("SPHEREx metadata response exceeded its byte budget")
        return body, response.geturl(), response.status, response.headers


def list_url(prefix: str, continuation: str | None = None) -> str:
    params = {"list-type": "2", "prefix": prefix, "max-keys": str(PAGE_SIZE)}
    if continuation:
        params["continuation-token"] = continuation
    return SOURCE_ROOT + "?" + urllib.parse.urlencode(params)


def local_name(element: ET.Element) -> str:
    return str(element.tag).rsplit("}", 1)[-1]


def parse_listing(body: bytes) -> tuple[list[dict], bool, str | None]:
    root = ET.fromstring(body)
    if local_name(root) != "ListBucketResult" or root.findtext("{*}Name") != "nasa-irsa-spherex":
        raise ValueError("Unexpected SPHEREx S3 ListObjects response")
    entries = []
    for content in root.iter():
        if local_name(content) != "Contents":
            continue
        item = {local_name(child): (child.text or "").strip() for child in content}
        if not item.get("Key") or not item.get("Size") or not item.get("ETag"):
            raise ValueError("SPHEREx object listing is missing its key, size or ETag")
        entries.append({"key": item["Key"], "sizeBytes": int(item["Size"]),
                        "eTag": item["ETag"].strip('"'), "lastModified": item.get("LastModified", "")})
    truncated = root.findtext("{*}IsTruncated") == "true"
    token = root.findtext("{*}NextContinuationToken")
    if truncated and not token:
        raise ValueError("SPHEREx S3 listing was truncated without a continuation token")
    return entries, truncated, token


def list_detector(detector: int, output: Path, timeout: int, fetch, profile: dict = DEFAULT_PROFILE) -> tuple[list[dict], list[dict], list[dict]]:
    run = profile["observing_run"]
    processing_version = profile["processing_version"]
    observation_selector = profile["observation_selector"]
    prefix = f"qr2/level2/{run}/{processing_version}/{detector}/level2_{observation_selector}D{detector}_spx_{processing_version}.fits"
    token = None
    seen_tokens = set()
    seen_keys = set()
    all_entries = []
    documents = []
    pages = []
    page_number = 0
    while True:
        url = list_url(prefix, token)
        body, final_url, status, headers = fetch(url, {}, timeout)
        if status != 200 or not final_url.startswith(SOURCE_ROOT):
            raise ValueError("SPHEREx S3 object listing did not return the official public response")
        entries, truncated, next_token = parse_listing(body)
        if any(not item["key"].startswith(prefix) for item in entries):
            raise ValueError("SPHEREx S3 listing returned an object outside its detector selector")
        if any(item["key"] in seen_keys for item in entries):
            raise ValueError("SPHEREx S3 listing repeated an object identity")
        seen_keys.update(item["key"] for item in entries)
        page_number += 1
        relative = f"metadata/listing-detector-{detector}-page-{page_number}.xml"
        listing_path = output / relative
        immutable_write(listing_path, body)
        documents.append(file_reference(output, listing_path, final_url))
        pages.append({"detector": detector, "page": page_number, "url": final_url,
                      "status": status, "rows": len(entries), "isTruncated": truncated,
                      "responseSha256": sha256(body)})
        all_entries.extend(entries)
        if not truncated:
            break
        if next_token in seen_tokens:
            raise ValueError("SPHEREx S3 listing repeated its continuation token")
        seen_tokens.add(next_token)
        token = next_token
    expected = {f"level2_{observation_selector}D{detector}_spx_{processing_version}.fits"}
    actual = {item["key"].rsplit("/", 1)[-1] for item in all_entries}
    if actual != expected:
        raise ValueError(f"SPHEREx detector {detector} does not have exactly one listed file for this observation")
    return all_entries, documents, pages


def has_end_card(block: bytes) -> bool:
    return any(block[index:index + 8].strip() == b"END" for index in range(0, len(block), 80))


def read_header(url: str, file_size: int, timeout: int, fetch) -> tuple[bytes, list[dict]]:
    blocks = []
    receipts = []
    offset = 0
    completed_headers = 0
    for _ in range(MAX_HEADER_BLOCKS):
        end = offset + BLOCK_SIZE - 1
        if end >= file_size:
            raise ValueError("SPHEREx FITS file ended before a complete header block")
        body, final_url, status, headers = fetch(url, {"Range": f"bytes={offset}-{end}"}, timeout)
        expected_range = f"bytes {offset}-{end}/{file_size}"
        if status != 206 or final_url != url or len(body) != BLOCK_SIZE or response_header(headers, "Content-Range") != expected_range:
            raise ValueError("SPHEREx FITS range response differs from its metadata-only byte request")
        blocks.append(body)
        receipts.append({"start": offset, "endInclusive": end, "status": status,
                         "contentRange": expected_range, "bytesRead": len(body)})
        if has_end_card(body):
            completed_headers += 1
            if completed_headers == 2:
                return b"".join(blocks), receipts
        offset += BLOCK_SIZE
    raise ValueError("SPHEREx FITS header exceeded the configured metadata-only block limit")


def header_after_primary(header_bytes: bytes) -> tuple[fits.Header, bytes, int]:
    offset = 0
    primary = None
    while offset < len(header_bytes):
        block = header_bytes[offset:offset + BLOCK_SIZE]
        if len(block) != BLOCK_SIZE:
            raise ValueError("SPHEREx FITS header is not aligned to standard blocks")
        offset += BLOCK_SIZE
        if has_end_card(block):
            if primary is None:
                primary_bytes = header_bytes[:offset]
                primary = fits.Header.fromstring(primary_bytes.decode("ascii"), sep="")
                if int(primary.get("NAXIS", -1)) != 0:
                    raise ValueError("SPHEREx primary HDU unexpectedly contains pixel data")
                continue
            extension_bytes = header_bytes[len(primary.tostring(sep="", endcard=True, padding=True)):offset]
            extension = fits.Header.fromstring(extension_bytes.decode("ascii"), sep="")
            if extension.get("XTENSION", "").strip() != "IMAGE":
                raise ValueError("SPHEREx first data HDU is not an IMAGE extension")
            return extension, extension_bytes, len(primary.tostring(sep="", endcard=True, padding=True))
    raise ValueError("SPHEREx FITS image extension header is missing its END card")


def polygon_from_wcs(header: fits.Header) -> tuple[str, list[list[float]]]:
    if str(header.get("RADESYS", "")).strip().upper() != "ICRS" \
            or str(header.get("CTYPE1", "")).strip() != "RA---TAN-SIP" \
            or str(header.get("CTYPE2", "")).strip() != "DEC--TAN-SIP":
        raise ValueError("SPHEREx image extension must provide an ICRS TAN-SIP WCS")
    width, height = int(header.get("NAXIS1", 0)), int(header.get("NAXIS2", 0))
    if not 1 <= width <= 4096 or not 1 <= height <= 4096:
        raise ValueError("SPHEREx image dimensions are outside the supported metadata bounds")
    edge_x = np.linspace(-0.5, width - 0.5, 9)
    edge_y = np.linspace(-0.5, height - 0.5, 9)
    pixels = [(x, -0.5) for x in edge_x]
    pixels.extend((width - 0.5, y) for y in edge_y[1:])
    pixels.extend((x, height - 0.5) for x in edge_x[-2::-1])
    pixels.extend((-0.5, y) for y in edge_y[-2:0:-1])
    world = WCS(header, relax=True).all_pix2world(np.asarray(pixels, dtype=float), 0)
    points = []
    for ra, dec in world:
        if not np.isfinite(ra) or not np.isfinite(dec) or not -90 <= float(dec) <= 90:
            raise ValueError("SPHEREx TAN-SIP WCS produced an invalid ICRS frame edge")
        points.append([round(float(ra) % 360, 10), round(float(dec), 10)])
    region = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in points)
    return region, points


def normalize_entry(entry: dict, detector: int, output: Path, timeout: int, fetch, profile: dict = DEFAULT_PROFILE) -> tuple[dict, dict]:
    key = entry["key"]
    filename = key.rsplit("/", 1)[-1]
    match = re.fullmatch(
        rf"level2_{profile['observation_selector']}D{detector}_spx_{re.escape(profile['processing_version'])}\.fits",
        filename,
    )
    if not match or entry["sizeBytes"] < BLOCK_SIZE * 2:
        raise ValueError("SPHEREx S3 key does not match the locked observation and detector selector")
    mirror_url = SOURCE_ROOT + key
    original_url = IRSA_ROOT + key
    header_bytes, range_receipts = read_header(mirror_url, entry["sizeBytes"], timeout, fetch)
    extension, extension_bytes, extension_offset = header_after_primary(header_bytes)
    if int(extension.get("DETECTOR", -1)) != detector or str(extension.get("OBSID", "")).strip() != profile["observation_id"]:
        raise ValueError("SPHEREx FITS header observation or detector differs from its listed path")
    region, frame_points = polygon_from_wcs(extension)
    version_part = f"/{profile['processing_version']}" if profile["versioned_unit_id"] else ""
    unit_id = f"{profile['observation_id']}{version_part}/D{detector}"
    header_ref = f"metadata/headers/detector-{detector}/{filename}.header"
    header_path = output / header_ref
    immutable_write(header_path, header_bytes)
    header_document = file_reference(output, header_path, mirror_url)
    row = {
        "unitId": unit_id,
        "sRegion": region,
        "bands": [f"D{detector}"],
        "filename": filename,
        "accessUris": [
            {"uri": original_url, "fileName": filename, "band": f"D{detector}", "accessType": "file"},
            {"uri": mirror_url, "fileName": filename, "band": f"D{detector}", "accessType": "file"},
        ],
        "sourceMetadata": {
            "observationId": profile["observation_id"],
            "detector": detector,
            "processingVersion": profile["processing_version"],
            "objectKey": key,
            "fileName": filename,
            "fileSizeBytes": entry["sizeBytes"],
            "providerETag": entry["eTag"],
            "lastModified": entry["lastModified"],
            "coordinateFrame": "ICRS",
            "geometrySource": "SPHEREx FITS IMAGE extension TAN-SIP pixel-edge transform",
            "wcsHeaderRef": header_ref,
            "wcsHeaderSha256": header_document["sha256"],
            "headerRangeEndInclusive": len(header_bytes) - 1,
            "imageHeaderOffset": extension_offset,
            "imageWidth": int(extension["NAXIS1"]),
            "imageHeight": int(extension["NAXIS2"]),
            "wcsCtype": [str(extension["CTYPE1"]), str(extension["CTYPE2"])],
            "referenceIcrs": [float(extension["CRVAL1"]), float(extension["CRVAL2"])],
            "frameEdgeIcrs": frame_points,
            "sourceListedUri": original_url,
            "mirrorUri": mirror_url,
            "availabilityEvidence": "public-object-listing-and-header-ranges",
            "rangeRequests": range_receipts,
            "frameSemantics": "detector image frame; valid-pixel mask not checked",
        },
    }
    return row, header_document


def acquire(output: Path, timeout: int = 45, fetch=request_bytes, profile: dict = DEFAULT_PROFILE) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    listings = []
    listing_pages = []
    entries = []
    detectors = profile["detectors"]
    expected_row_count = len(detectors)
    for detector in detectors:
        detector_entries, documents, pages = list_detector(detector, output, timeout, fetch, profile)
        entries.extend((detector, item) for item in detector_entries)
        listings.extend(documents)
        listing_pages.extend(pages)
    if len(entries) != expected_row_count or len({entry["key"] for _, entry in entries}) != expected_row_count:
        raise ValueError("SPHEREx bounded observation roster has an unexpected row count or duplicate key")

    rows = []
    header_documents = []
    for detector, entry in entries:
        row, document = normalize_entry(entry, detector, output, timeout, fetch, profile)
        rows.append(row)
        header_documents.append(document)
    rows.sort(key=lambda row: row["unitId"])
    row_body = gzip.compress(b"".join((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode() for row in rows), mtime=0)
    row_path = output / "rows/observation.jsonl.gz"
    immutable_write(row_path, row_body)
    row_file = file_reference(output, row_path, SOURCE_ROOT)
    manifest = {
        "schemaVersion": 1,
        "adapter": "spherex-qr2-s3-observation",
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "sourceId": profile["source_id"],
        "query": profile["query"],
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "queryPagesComplete": True,
        "inventoryComplete": False,
        "nativeCoordinateFrame": "ICRS",
        "scope": {
            "observingRun": profile["observing_run"],
            "processingVersion": profile["processing_version"],
            "observationSelector": profile["observation_selector"],
            "observationId": profile["observation_id"],
            "detectors": detectors,
            "expectedRowCount": expected_row_count,
            "fullObservationRoster": True,
            "fullReleaseInventory": False,
            "inventoryComplete": False,
            "headerOnly": True,
            "validPixelMasksChecked": False,
        },
        "sourcePagination": {
            "pageSize": PAGE_SIZE,
            "expectedRowCount": expected_row_count,
            "queryPagesComplete": True,
            "pages": listing_pages,
        },
        "metadataDocuments": listings + header_documents,
        "rowFiles": [row_file | {"rows": len(rows)}],
        "rowCount": len(rows),
    }
    manifest_bytes = json.dumps(manifest, sort_keys=True, indent=2).encode() + b"\n"
    immutable_write(output / "manifest.json", manifest_bytes)
    return {"manifest": manifest, "manifestSha256": sha256(manifest_bytes), "rowCount": len(rows), "output": str(output)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--profile", choices=sorted(CAPTURE_PROFILES), default="observation-v20-240")
    args = parser.parse_args()
    result = acquire(args.output, args.timeout, profile=CAPTURE_PROFILES[args.profile])
    print(json.dumps({key: value for key, value in result.items() if key != "manifest"}, sort_keys=True))


if __name__ == "__main__":
    main()
