#!/usr/bin/env python3
"""Capture ACT DR5 whole-map identities and FITS headers without reading pixels."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS


GET_URL = "https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_get.html"
SCRIPT_URL = "https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_wget.sh"
MAP_ROOT = "https://lambda.gsfc.nasa.gov/data/suborbital/ACT/ACT_dr5/maps/"
SOURCE_ID = "act-dr5-normal-whole-maps"
SURVEY_ID = "act"
RELEASE_ID = "act-dr5"
FREQUENCIES = ("090", "150", "220")
SELECTIONS = ("night", "daynight")
MAP_FILES = tuple(
    (frequency, selection, f"act_dr5.01_s08s18_AA_f{frequency}_{selection}_map.fits")
    for frequency in FREQUENCIES
    for selection in SELECTIONS
)
HEADER_BLOCK_BYTES = 2880
MAX_HEADER_BLOCKS = 2
HEADER_SEGMENTS = 360
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only ACT DR5 collector/1.0"
EXPECTED_QUERY = (
    "Official ACT DR5 normal ACT-only whole-map selector: frequencies 090/150/220 GHz x night/daynight; "
    "lock the six matching FITS members from the official 42-file download script and capture only their FITS header blocks."
)


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def response_header(headers, name: str) -> str:
    return next((str(value) for key, value in headers.items() if key.lower() == name.lower()), "")


def file_reference(root: Path, path: Path, url: str, **extra) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body), **extra}


def fetch_document(url: str, timeout: int) -> tuple[bytes, str, int, dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_DOCUMENT_BYTES + 1)
        headers = dict(response.headers.items())
        if response.status != 200 or len(body) > MAX_DOCUMENT_BYTES:
            raise ValueError("ACT official roster document exceeded its HTTP or metadata-size contract")
        return body, response.url, response.status, headers


def fetch_head(url: str, timeout: int) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="HEAD")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        headers = dict(response.headers.items())
        return response.status, response.url, headers


def fetch_range(url: str, start: int, end: int, timeout: int) -> tuple[bytes, str, int, dict]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Range": f"bytes={start}-{end}"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 206 or response.url != url:
            raise ValueError("ACT FITS server did not honor the exact metadata-only byte range")
        expected = f"bytes {start}-{end}/"
        content_range = response_header(response.headers, "Content-Range")
        if not content_range.startswith(expected):
            raise ValueError("ACT FITS Content-Range does not match the requested header block")
        body = response.read(HEADER_BLOCK_BYTES + 1)
        if len(body) != HEADER_BLOCK_BYTES:
            raise ValueError("ACT FITS header range did not return one complete FITS block")
        return body, response.url, response.status, dict(response.headers.items())


def end_card_offset(block: bytes) -> int | None:
    for offset in range(0, len(block), 80):
        if block[offset : offset + 8].strip() == b"END":
            return offset
    return None


def parse_header_blocks(body: bytes) -> tuple[fits.Header, int]:
    if not body or len(body) % HEADER_BLOCK_BYTES:
        raise ValueError("ACT FITS header is not aligned to complete 2,880-byte blocks")
    for block_offset in range(0, len(body), HEADER_BLOCK_BYTES):
        block = body[block_offset : block_offset + HEADER_BLOCK_BYTES]
        if end_card_offset(block) is not None:
            header_size = block_offset + HEADER_BLOCK_BYTES
            try:
                header = fits.Header.fromstring(body[:header_size].decode("ascii"), sep="")
            except Exception as exc:
                raise ValueError("ACT FITS header is not valid ASCII FITS metadata") from exc
            return header, header_size
    raise ValueError("ACT FITS header blocks contain no END card")


def read_header(url: str, timeout: int, head=fetch_head, ranged=fetch_range) -> tuple[bytes, dict]:
    head_status, final_url, headers = head(url, timeout)
    if head_status != 200 or final_url != url:
        raise ValueError("ACT FITS endpoint did not pass its direct whole-file HEAD check")
    size_text = response_header(headers, "Content-Length")
    size = int(size_text) if size_text.isdigit() else 0
    if size <= HEADER_BLOCK_BYTES or response_header(headers, "Accept-Ranges").lower() != "bytes":
        raise ValueError("ACT FITS endpoint must expose a byte-ranged whole-file resource")
    blocks = []
    ranges = []
    for block_index in range(MAX_HEADER_BLOCKS):
        start = block_index * HEADER_BLOCK_BYTES
        end = start + HEADER_BLOCK_BYTES - 1
        if end >= size:
            raise ValueError("ACT FITS file ended before a complete header block")
        block, range_url, status, range_headers = ranged(url, start, end, timeout)
        expected_range = f"bytes {start}-{end}/{size}"
        if status != 206 or range_url != url or response_header(range_headers, "Content-Range") != expected_range:
            raise ValueError("ACT FITS range response differs from its metadata-only byte request")
        blocks.append(block)
        ranges.append({"start": start, "endInclusive": end, "status": status,
                       "contentRange": expected_range, "bytesRead": len(block)})
        if end_card_offset(block) is not None:
            header = b"".join(blocks)
            parse_header_blocks(header)
            return header, {
                "headStatus": head_status,
                "headUrl": final_url,
                "fileSizeBytes": size,
                "acceptRanges": "bytes",
                "ranges": ranges,
                "headerBytes": len(header),
            }
    raise ValueError("ACT FITS primary header exceeds the two-block metadata-only limit")


def footprint_from_header(header: fits.Header, segment_count: int = HEADER_SEGMENTS) -> tuple[str, list[float]]:
    if header.get("RADESYS", "").strip().upper() != "ICRS":
        raise ValueError("ACT normal map must declare an ICRS coordinate frame")
    if str(header.get("CTYPE1", "")).strip().upper() != "RA---CAR" \
            or str(header.get("CTYPE2", "")).strip().upper() != "DEC--CAR":
        raise ValueError("ACT normal map must declare the supported CAR sky projection")
    width, height = int(header.get("NAXIS1", 0)), int(header.get("NAXIS2", 0))
    if width != 43_200 or height != 10_320 or int(header.get("NAXIS3", 0)) != 3:
        raise ValueError("ACT normal map must retain its declared 43,200x10,320x3 axes")
    if not 1 <= segment_count <= width:
        raise ValueError("ACT frame segment count is outside its pixel axis")

    try:
        wcs = WCS(header).celestial
        pc = wcs.wcs.get_pc()
        if not np.allclose(pc[:2, :2], np.eye(2), rtol=0, atol=1e-12) \
                or not np.isclose(abs(wcs.wcs.cdelt[0] * width), 360.0, rtol=0, atol=1e-6):
            raise ValueError("ACT CAR map does not have an unrotated full-RA longitude axis")
        x_edges = np.linspace(-0.5, width - 0.5, segment_count + 1)
        points = []
        for x0, x1 in zip(x_edges[:-1], x_edges[1:]):
            points.extend(((x0, -0.5), (x1, -0.5), (x1, height - 0.5), (x0, height - 0.5)))
        pixel_points = np.asarray(points, dtype=float)
        # The first outer edge is half a pixel beyond CAR's +/-180 degree branch.
        pixel_points[:, 0] %= width
        world = wcs.all_pix2world(pixel_points, 0)
    except Exception as exc:
        raise ValueError("ACT CAR WCS could not be transformed at the image-frame edges") from exc
    if world.shape != (segment_count * 4, 2) or not np.all(np.isfinite(world)) \
            or np.any(world[:, 1] < -90) or np.any(world[:, 1] > 90):
        raise ValueError("ACT CAR WCS produced invalid ICRS frame-edge coordinates")

    polygons = []
    ras = []
    decs = []
    for index in range(segment_count):
        ring = []
        for ra, dec in world[index * 4 : index * 4 + 4]:
            normalized_ra = float(ra) % 360.0
            normalized_dec = float(dec)
            ring.append(f"{normalized_ra:.8f} {normalized_dec:.8f}")
            ras.append(normalized_ra)
            decs.append(normalized_dec)
        polygons.append("POLYGON ICRS " + " ".join(ring))
    region = f"UNION ICRS ({' '.join(polygons)})"
    if len(region) > 131_072:
        raise ValueError("ACT segmented frame footprint exceeds the native region size limit")
    return region, [min(decs), max(decs)]


def normalize_map(frequency: str, selection: str, filename: str, header_bytes: bytes,
                  header_ref: str, header_sha: str, receipt: dict) -> dict:
    header, header_size = parse_header_blocks(header_bytes)
    if header_size != len(header_bytes) or header.get("SIMPLE") is not True:
        raise ValueError("ACT map header capture must end exactly at a complete FITS primary-header block")
    region, declination_bounds = footprint_from_header(header)
    url = MAP_ROOT + filename
    unit_id = filename
    return {
        "unitId": unit_id,
        "sRegion": region,
        "bands": [f"{int(frequency)} GHZ"],
        "filename": filename,
        "accessUris": [{"uri": url, "fileName": filename, "band": f"{int(frequency)} GHZ", "accessType": "file"}],
        "sourceMetadata": {
            "mapId": f"{frequency}-{selection}",
            "frequencyGHz": int(frequency),
            "timeSelection": selection,
            "fileName": filename,
            "fileSizeBytes": receipt["fileSizeBytes"],
            "coordinateFrame": "ICRS",
            "projection": "CAR",
            "dimensions": [int(header["NAXIS1"]), int(header["NAXIS2"]), int(header["NAXIS3"])],
            "declinationBoundsDeg": declination_bounds,
            "frameSemantics": "whole-map image frame; ACT valid-pixel holes and masks are not checked",
            "geometrySource": "ACT DR5 FITS primary-header ICRS CAR WCS transformed along image-frame edges",
            "geometryPrecision": "estimated",
            "headerRef": header_ref,
            "headerSha256": header_sha,
            "headerBytes": len(header_bytes),
            "headStatus": receipt["headStatus"],
            "rangeReceipts": receipt["ranges"],
            "accessSemantics": "source-listed direct whole-map FITS file; no archive wrapper",
        },
    }


def capture(output: Path, timeout: int = 60, get=fetch_document, head=fetch_head, ranged=fetch_range) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    page, page_url, page_status, _ = get(GET_URL, timeout)
    script, script_url, script_status, _ = get(SCRIPT_URL, timeout)
    if page_status != 200 or page_url != GET_URL or script_status != 200 or script_url != SCRIPT_URL:
        raise ValueError("ACT official product page or download script did not match its pinned HTTPS source")
    script_text = script.decode("utf-8")
    listed = set(re.findall(re.escape(MAP_ROOT) + r"([^/\s]+\.fits)", script_text))
    expected_names = {filename for _, _, filename in MAP_FILES}
    normal_act_maps = {name for name in listed if re.fullmatch(r"act_dr5\.01_s08s18_AA_f(?:090|150|220)_(?:night|daynight)_map\.fits", name)}
    if normal_act_maps != expected_names:
        raise ValueError("ACT official wget script normal-map roster differs from the locked six-file selector")

    page_path = output / "metadata/act-dr5-get.html"
    script_path = output / "metadata/act-dr5-coadd-maps-wget.sh"
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_bytes(page)
    script_path.write_bytes(script)
    documents = [file_reference(output, page_path, page_url), file_reference(output, script_path, script_url)]
    rows = []
    map_receipts = []
    for frequency, selection, filename in MAP_FILES:
        url = MAP_ROOT + filename
        header_bytes, receipt = read_header(url, timeout, head=head, ranged=ranged)
        header_ref = f"metadata/headers/{filename}.header"
        header_path = output / header_ref
        header_path.parent.mkdir(parents=True, exist_ok=True)
        header_path.write_bytes(header_bytes)
        header_sha = sha256(header_bytes)
        documents.append(file_reference(output, header_path, url, mapId=f"{frequency}-{selection}"))
        rows.append(normalize_map(frequency, selection, filename, header_bytes, header_ref, header_sha, receipt))
        map_receipts.append({"mapId": f"{frequency}-{selection}", "fileName": filename,
                             "url": url, "headStatus": receipt["headStatus"], "acceptRanges": receipt["acceptRanges"],
                             "fileSizeBytes": receipt["fileSizeBytes"], "ranges": receipt["ranges"],
                             "headerBytes": receipt["headerBytes"], "headerSha256": header_sha})

    row_path = output / "normalized/native-rows.ndjson.gz"
    row_path.parent.mkdir(parents=True, exist_ok=True)
    with row_path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8"))
    row_file = file_reference(output, row_path, SCRIPT_URL, rows=len(rows))
    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    manifest = {
        "schemaVersion": 1,
        "deliveryClass": "evidence",
        "adapter": "act-dr5-whole-map",
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "capturedAt": captured_at,
        "coordinateFrame": "ICRS",
        "nativeCoordinateFrame": "ICRS",
        "ordering": "NESTED",
        "queryPagesComplete": True,
        "inventoryComplete": False,
        "rowCount": len(rows),
        "scope": {
            "selector": "normal ACT-only frequency/time-selection whole maps",
            "frequenciesGHz": [90, 150, 220],
            "timeSelections": list(SELECTIONS),
            "mapIds": [f"{frequency}-{selection}" for frequency, selection, _ in MAP_FILES],
            "fileRosterComplete": True,
            "fullSurveyInventory": False,
            "headerOnly": True,
            "validPixelMasksChecked": False,
            "expectedDimensions": [43_200, 10_320, 3],
            "geometryPrecision": "estimated",
        },
        "sourcePagination": {
            "queryPagesComplete": True,
            "pageSize": len(rows),
            "expectedRowCount": len(rows),
            "pages": [{"page": 1, "status": 200, "queryStatus": "OK", "query": EXPECTED_QUERY,
                       "rows": len(rows), "mapIds": [receipt["mapId"] for receipt in map_receipts],
                       "rosterSha256": documents[1]["sha256"]}],
            "maps": map_receipts,
        },
        "metadataDocuments": documents,
        "rowFiles": [row_file],
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    manifest = capture(args.output, args.timeout)
    print(json.dumps({"manifest": str(args.output / "manifest.json"), "rows": manifest["rowCount"],
                      "inventoryComplete": manifest["inventoryComplete"], "metadataFiles": len(manifest["metadataDocuments"]),
                      "headerBytes": sum(item["sizeBytes"] for item in manifest["metadataDocuments"] if item["ref"].endswith(".header"))}, indent=2))


if __name__ == "__main__":
    main()
