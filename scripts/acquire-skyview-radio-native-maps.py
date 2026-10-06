#!/usr/bin/env python3
"""Capture SkyView NVSS/SUMSS/WENSS map rosters and FITS headers, never pixels."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import warnings
import xml.etree.ElementTree as ET
import zlib

import numpy as np
from astropy import units as u
from astropy.coordinates import FK4, FK5, SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS


BASE = "https://skyview.gsfc.nasa.gov"
SURVEY_MANIFEST_URL = f"{BASE}/current/jar/surveys/survey.manifest"
SOURCE_ID = {
    "nvss": "nvss-final-native-maps",
    "sumss": "sumss-final-native-maps",
    "wenss": "wenss-final-native-maps",
}
RELEASE_ID = {"nvss": "nvss-final", "sumss": "sumss-final", "wenss": "wenss-final"}
EXPECTED_ROWS = {"nvss": 2326, "sumss": 748, "wenss": 493}
XML_URL = {name: f"{BASE}/current/jar/surveys/xml/{name}.xml.gz" for name in SOURCE_ID}
MAP_ROOT = {
    "nvss": f"{BASE}/surveys/nvss/",
    "sumss": f"{BASE}/surveys/sumss/mosaics/",
    "wenss": f"{BASE}/surveys/wenss/",
}
MAP_PATH_PATTERNS = {
    "nvss": re.compile(r"I\d{4}[PM]\d{2}\.fits\.gz"),
    "sumss": re.compile(r"(?:Galactic|Extragalactic)/J\d{4}[PM]\d{2}\.FITS"),
    "wenss": re.compile(r"w[np]\d{5}h\.fits\.gz"),
}
PUBLISHER_BAND = {"nvss": "1400 MHZ", "sumss": "843 MHZ", "wenss": "325 MHZ"}
NATIVE_FRAME = {"nvss": "FK5(J2000)", "sumss": "FK5(J2000)", "wenss": "FK4(B1950)"}
PRODUCER = {
    "nvss": {"name": "National Radio Astronomy Observatory", "countryCode": "US", "status": "original-anonymous-ftp-unavailable"},
    "sumss": {"name": "University of Sydney SUMSS", "countryCode": "AU", "status": "original-archive-unavailable"},
    "wenss": {"name": "WENSS team: NFRA/ASTRON and Leiden Observatory", "countryCode": "NL", "status": "original-image-routes-unavailable"},
}
HEADER_EVIDENCE_REF = "metadata/map-headers.ndjson.gz"
HEADER_BLOCK_BYTES = 2880
MAX_HEADER_BYTES = 1024 * 1024
MAX_GZIP_PREFIX = 131072
EDGE_SEGMENTS = 32
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only radio map collector/1.0"


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def file_reference(root: Path, file: Path, url: str | None = None) -> dict:
    body = file.read_bytes()
    return {
        "ref": file.relative_to(root).as_posix(),
        "sha256": sha256(body),
        "sizeBytes": len(body),
        **({"url": url} if url else {}),
    }


def header_value(headers, key: str) -> str:
    return next((str(value) for name, value in headers.items() if name.lower() == key.lower()), "")


def fetch_document(url: str, timeout: int) -> tuple[bytes, dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(4 * 1024 * 1024 + 1)
        if response.status != 200 or len(body) > 4 * 1024 * 1024 or response.geturl() != url:
            raise ValueError("SkyView metadata document did not match its bounded HTTPS source")
        return body, {"status": response.status, "url": response.geturl(), "headers": dict(response.headers.items())}


def decode_gzip_document(body: bytes) -> bytes:
    return gzip.decompress(body) if body.startswith(b"\x1f\x8b") else body


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def descendants(element, name: str):
    return [child for child in element.iter() if local_name(child.tag) == name]


def parse_inventory(body: bytes, survey: str) -> tuple[list[dict], str, str]:
    decoded = decode_gzip_document(body)
    if len(decoded) > 2 * 1024 * 1024 or b"<!DOCTYPE" in decoded.upper() or b"<!ENTITY" in decoded.upper():
        raise ValueError("SkyView XML exceeded its size or safe-parse contract")
    root = ET.fromstring(decoded)
    image_sections = descendants(root, "Images")
    if not image_sections:
        raise ValueError("SkyView XML has no Images inventory")
    prefixes = [item.text.strip() for item in descendants(image_sections[0], "SpellPrefix") if item.text and item.text.strip()]
    if len(prefixes) != 1:
        raise ValueError("SkyView XML must declare exactly one Images/SpellPrefix")
    prefix = urllib.parse.urljoin(BASE, prefixes[0])
    parsed_prefix = urllib.parse.urlsplit(prefix)
    if parsed_prefix.scheme != "https" or parsed_prefix.hostname != "skyview.gsfc.nasa.gov":
        raise ValueError("SkyView SpellPrefix is not on the checked HTTPS mirror host")
    expected_prefix = urllib.parse.urlsplit(MAP_ROOT[survey])
    if parsed_prefix.path.rstrip("/") != expected_prefix.path.rstrip("/"):
        raise ValueError("SkyView SpellPrefix differs from the published native-map directory")

    rows = []
    seen = set()
    for element in descendants(image_sections[0], "Image"):
        text = " ".join("".join(element.itertext()).split())
        fields = text.split()
        spell = fields[0].split(",") if fields else []
        if len(fields) < 2 or len(spell) < 2:
            raise ValueError("SkyView Images/Image row is malformed")
        relative_path = spell[0].lstrip("/")
        if (not MAP_PATH_PATTERNS[survey].fullmatch(relative_path)
                or ".." in Path(relative_path).parts or relative_path in seen):
            raise ValueError("SkyView XML contains an unsafe or duplicate native map path")
        uri = MAP_ROOT[survey] + relative_path
        if urllib.parse.urlsplit(uri).hostname != "skyview.gsfc.nasa.gov":
            raise ValueError("SkyView map path escaped the published mirror host")
        seen.add(relative_path)
        rows.append({
            "unitId": relative_path,
            "relativePath": relative_path,
            "fileName": Path(relative_path).name,
            "cacheName": spell[1],
            "sourceImageText": text,
            "selectionFields": fields[1:],
            "uri": uri,
        })
    if len(rows) != EXPECTED_ROWS[survey]:
        raise ValueError(f"SkyView {survey.upper()} XML roster has {len(rows)} rows, expected {EXPECTED_ROWS[survey]}")
    return rows, prefix, sha256(decoded)


def end_card_offset(block: bytes) -> int | None:
    for offset in range(0, len(block) - 7, 80):
        if block[offset : offset + 8].strip() == b"END":
            return offset
    return None


def padded_header(body: bytes) -> bytes | None:
    for offset in range(0, len(body), HEADER_BLOCK_BYTES):
        block = body[offset : offset + HEADER_BLOCK_BYTES]
        if len(block) != HEADER_BLOCK_BYTES:
            break
        end_offset = end_card_offset(block)
        if end_offset is not None:
            return body[: offset + HEADER_BLOCK_BYTES]
    return None


def fetch_range(url: str, start: int, end: int, timeout: int) -> tuple[bytes, dict]:
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "identity",
        "Range": f"bytes={start}-{end}",
    })
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        raise ValueError(f"HTTP {error.code} for metadata-only byte range") from error
    with response:
        headers = dict(response.headers.items())
        content_range = header_value(response.headers, "Content-Range")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
        body = response.read(end - start + 2)
        if response.status != 206 or response.geturl() != url or not match:
            raise ValueError("SkyView map did not return the exact requested HTTP 206 range")
        actual = tuple(map(int, match.groups()))
        if actual != (start, min(end, actual[2] - 1), actual[2]) or len(body) != actual[1] - actual[0] + 1:
            raise ValueError("SkyView Content-Range or byte count differs from the metadata request")
        return body, {"status": response.status, "url": response.geturl(), "start": start, "endInclusive": actual[1],
                      "totalBytes": actual[2], "contentRange": content_range, "bytesRead": len(body),
                      "etag": header_value(response.headers, "ETag"),
                      "lastModified": header_value(response.headers, "Last-Modified"),
                      "contentEncoding": header_value(response.headers, "Content-Encoding")}


def read_fits_header(url: str, timeout: int, ranged=fetch_range) -> tuple[bytes, dict]:
    compressed = url.lower().endswith(".gz")
    receipts = []
    expected_etag = ""
    expected_modified = ""
    total_size = None
    decoded = b""
    if compressed:
        ends = []
        end = 511
        while end < MAX_GZIP_PREFIX:
            ends.append(end)
            end = (end + 1) * 2 - 1
        for end in ends:
            block, receipt = ranged(url, 0, end, timeout)
            total_size = receipt["totalBytes"]
            if total_size <= end + 1:
                end = total_size - 1
            if expected_etag and receipt["etag"] != expected_etag or expected_modified and receipt["lastModified"] != expected_modified:
                raise ValueError("SkyView map object changed between header byte ranges")
            expected_etag = expected_etag or receipt["etag"]
            expected_modified = expected_modified or receipt["lastModified"]
            if not expected_etag and not expected_modified:
                raise ValueError("SkyView map response has no stable ETag or Last-Modified identity")
            receipts.append(receipt)
            if block.startswith(b"SIMPLE  ="):
                decoded = block
            elif block.startswith(b"\x1f\x8b"):
                decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
                decoded = decompressor.decompress(block, MAX_HEADER_BYTES)
            else:
                raise ValueError("SkyView .fits.gz URI did not return a gzip FITS prefix")
            header = padded_header(decoded)
            if header is not None:
                break
            if len(block) != end + 1 or end + 1 >= total_size:
                raise ValueError("SkyView gzip FITS ended before its padded primary header")
            if end + 1 >= MAX_GZIP_PREFIX:
                break
        else:
            header = None
        if header is None:
            header = padded_header(decoded)
        if header is None:
            raise ValueError("SkyView gzip FITS primary header exceeded the metadata-only prefix limit")
    else:
        chunks = []
        for start in range(0, MAX_HEADER_BYTES, HEADER_BLOCK_BYTES):
            block, receipt = ranged(url, start, start + HEADER_BLOCK_BYTES - 1, timeout)
            if total_size is None:
                total_size = receipt["totalBytes"]
            if receipt["totalBytes"] != total_size:
                raise ValueError("SkyView map length changed between header byte ranges")
            if expected_etag and receipt["etag"] != expected_etag or expected_modified and receipt["lastModified"] != expected_modified:
                raise ValueError("SkyView map object changed between header byte ranges")
            expected_etag = expected_etag or receipt["etag"]
            expected_modified = expected_modified or receipt["lastModified"]
            if not expected_etag and not expected_modified:
                raise ValueError("SkyView map response has no stable ETag or Last-Modified identity")
            receipts.append(receipt)
            chunks.append(block)
            header = padded_header(b"".join(chunks))
            if header is not None:
                break
            if len(block) != HEADER_BLOCK_BYTES or start + len(block) >= total_size:
                raise ValueError("SkyView FITS ended before its padded primary header")
        else:
            header = None
        if header is None:
            raise ValueError("SkyView FITS primary header exceeded the metadata-only range limit")

    if len(header) > MAX_HEADER_BYTES or not header.startswith(b"SIMPLE  ="):
        raise ValueError("SkyView file does not contain a supported FITS primary header")
    try:
        parsed = fits.Header.fromstring(header.decode("ascii"), sep="")
    except Exception as error:
        raise ValueError("SkyView FITS primary header is not valid ASCII metadata") from error
    receipt = {"ranges": receipts, "fileSizeBytes": total_size, "etag": expected_etag,
               "lastModified": expected_modified, "headerBytes": len(header),
               "contentEncoding": receipts[-1]["contentEncoding"] if receipts else ""}
    return header, {**receipt, "parsedHeader": parsed}


def frame_from_header(survey: str, header: fits.Header) -> dict:
    expected = NATIVE_FRAME[survey]
    cards = header.copy()
    equinox = cards.get("EQUINOX", cards.get("EPOCH"))
    radesys = str(cards.get("RADESYS", cards.get("RADECSYS", ""))).strip().upper()
    if not radesys:
        radesys = "FK4" if survey == "wenss" else "FK5"
        cards["RADESYS"] = radesys
    expected_prefix = "FK4" if survey == "wenss" else "FK5"
    expected_equinox = 1950.0 if survey == "wenss" else 2000.0
    if not radesys.startswith(expected_prefix) or equinox is not None and abs(float(equinox) - expected_equinox) > 0.1:
        raise ValueError(f"FITS coordinate frame conflicts with the documented {expected} survey frame")
    cards["EQUINOX"] = expected_equinox
    width, height = int(cards.get("NAXIS1", 0)), int(cards.get("NAXIS2", 0))
    if width < 1 or height < 1:
        raise ValueError("FITS map has no positive two-dimensional image frame")
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        try:
            wcs = WCS(cards, fix=True, relax=True).celestial
            if not wcs.has_celestial or wcs.wcs.lng != 0 or wcs.wcs.lat != 1:
                raise ValueError("FITS header does not declare celestial RA/DEC axes in the supported order")
            edge = np.linspace(-0.5, width - 0.5, EDGE_SEGMENTS, endpoint=False)
            vertical = np.linspace(-0.5, height - 0.5, EDGE_SEGMENTS, endpoint=False)
            pixels = np.asarray(
                [(x, -0.5) for x in edge]
                + [(width - 0.5, y) for y in vertical]
                + [(x, height - 0.5) for x in edge[::-1]]
                + [(-0.5, y) for y in vertical[::-1]], dtype=float,
            )
            world = wcs.all_pix2world(pixels, 0)
        except Exception as error:
            raise ValueError("FITS primary-header WCS could not transform its image-frame edges") from error
    if world.shape != (EDGE_SEGMENTS * 4, 2) or not np.all(np.isfinite(world)) or np.any(world[:, 1] < -90) or np.any(world[:, 1] > 90):
        raise ValueError("FITS WCS produced invalid image-frame edge coordinates")
    native_frame = FK4(equinox=Time("B1950")) if survey == "wenss" else FK5(equinox=Time("J2000"))
    icrs = SkyCoord(world[:, 0] * u.deg, world[:, 1] * u.deg, frame=native_frame).icrs
    points = [[float(ra) % 360.0, float(dec)] for ra, dec in zip(icrs.ra.deg, icrs.dec.deg)]
    raw_ctype = [str(header.get("CTYPE1", "")), str(header.get("CTYPE2", ""))]
    fixed_ctype = [str(value) for value in wcs.wcs.ctype]
    raw_frequency = header.get("CRVAL3")
    raw_frequency = float(raw_frequency) if raw_frequency is not None else None
    frequency_conflict = survey == "wenss" and raw_frequency is not None and abs(raw_frequency - 325_000_000) > 32_500_000
    wcs_fixes = [str(item.message)[:240] for item in captured]
    if any("NCP" in value.upper() for value in raw_ctype) and fixed_ctype != raw_ctype:
        wcs_fixes.append(f"WCSLIB celestial projection normalization: {'/'.join(raw_ctype)} -> {'/'.join(fixed_ctype)}")
    return {
        "frameEdgeIcrs": points,
        "nativeCoordinateFrame": expected,
        "coordinateFrame": "ICRS",
        "projection": "/".join(raw_ctype),
        "fixedProjection": "/".join(fixed_ctype),
        "dimensions": [width, height],
        "rawWcs": {key: header.get(key) for key in ["CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2", "CROTA2", "EQUINOX", "EPOCH", "RADESYS", "RADECSYS", "CRVAL3", "CDELT3", "CUNIT3"] if header.get(key) is not None},
        "rawFrequencyHz": raw_frequency,
        "spectralMetadataConflict": bool(frequency_conflict),
        "wcsFixes": wcs_fixes,
    }


def capture_map(survey: str, item: dict, timeout: int, ranged=fetch_range) -> tuple[dict, dict]:
    evidence = {"unitId": item["unitId"], "status": "failed", "error": "header-not-read"}
    receipt = {"unitId": item["unitId"], "relativePath": item["relativePath"], "url": item["uri"],
               "headerStatus": "failed", "geometryStatus": "unavailable"}
    try:
        header_bytes, response = read_fits_header(item["uri"], timeout, ranged)
        header = response.pop("parsedHeader")
        header_hash = sha256(header_bytes)
        evidence = {"unitId": item["unitId"], "status": "captured", "headerBase64": __import__("base64").b64encode(header_bytes).decode("ascii"),
                    "headerSha256": header_hash, "headerBytes": len(header_bytes), "requestReceipts": response["ranges"]}
        receipt = {"unitId": item["unitId"], "relativePath": item["relativePath"], "url": item["uri"], "headerStatus": "captured",
                   "headerSha256": header_hash, "headerBytes": len(header_bytes), "fileSizeBytes": response["fileSizeBytes"],
                   "etag": response["etag"], "lastModified": response["lastModified"], "requestReceipts": response["ranges"],
                   "geometryStatus": "failed"}
        raw_frequency = header.get("CRVAL3")
        raw_frequency = float(raw_frequency) if raw_frequency is not None else None
        base_metadata = {"relativePath": item["relativePath"], "fileName": item["fileName"], "headerStatus": "captured",
                         "geometryStatus": "failed", "headerEvidenceRef": HEADER_EVIDENCE_REF, "headerSha256": header_hash,
                         "headerBytes": len(header_bytes), "fileSizeBytes": response["fileSizeBytes"],
                         "rangeRequestCount": len(response["ranges"]), "rangeProbeStatus": 206,
                         "rawFrequencyHz": raw_frequency,
                         "spectralMetadataConflict": bool(survey == "wenss" and raw_frequency is not None and abs(raw_frequency - 325_000_000) > 32_500_000),
                         "publisherBand": PUBLISHER_BAND[survey], "mirrorCountry": "US",
                         "producer": PRODUCER[survey]["name"], "producerCountry": PRODUCER[survey]["countryCode"],
                         "originalProducerStatus": PRODUCER[survey]["status"],
                         "accessSemantics": "source-listed direct whole-map FITS; no cutout or archive wrapper"}
        try:
            geometry = frame_from_header(survey, header)
        except Exception as error:
            message = str(error).replace("\n", " ")[:300] or type(error).__name__
            evidence["geometryError"] = message
            receipt["geometryError"] = message
            row = {"unitId": item["unitId"], "sRegion": None, "bands": [PUBLISHER_BAND[survey]], "filename": item["fileName"],
                   "accessUris": [{"uri": item["uri"], "fileName": item["fileName"], "band": PUBLISHER_BAND[survey],
                                   "accessType": "file", "sourceId": "skyview-gsfc-us", "countryCode": "US", "role": "reachable-mirror"}],
                   "sourceMetadata": {**base_metadata, "failure": message}}
            return row, {"evidence": evidence, "receipt": receipt}
        footprint = "POLYGON ICRS " + " ".join(f"{ra:.8f} {dec:.8f}" for ra, dec in geometry["frameEdgeIcrs"])
        base_metadata.update(geometry)
        base_metadata.update({"geometryStatus": "mapped", "headerStatus": "captured", "headerEvidenceRef": HEADER_EVIDENCE_REF,
                              "headerSha256": header_hash, "headerBytes": len(header_bytes), "fileSizeBytes": response["fileSizeBytes"],
                              "rangeRequestCount": len(response["ranges"]), "rangeProbeStatus": 206,
                              "footprint": footprint,
                              "geometrySource": "actual FITS primary-header WCS pixel-edge samples transformed to ICRS",
                              "geometryPrecision": "estimated", "validPixelMasksChecked": False,
                              "publisherBand": PUBLISHER_BAND[survey], "mirrorCountry": "US",
                              "producer": PRODUCER[survey]["name"], "producerCountry": PRODUCER[survey]["countryCode"],
                              "originalProducerStatus": PRODUCER[survey]["status"],
                              "accessSemantics": "source-listed direct whole-map FITS; no cutout or archive wrapper"})
        receipt["geometryStatus"] = "mapped"
        row = {"unitId": item["unitId"], "sRegion": footprint,
               "bands": [PUBLISHER_BAND[survey]], "filename": item["fileName"],
               "accessUris": [{"uri": item["uri"], "fileName": item["fileName"], "band": PUBLISHER_BAND[survey],
                               "accessType": "file", "sourceId": "skyview-gsfc-us", "countryCode": "US", "role": "reachable-mirror"}],
               "sourceMetadata": base_metadata}
        return row, {"evidence": evidence, "receipt": receipt}
    except Exception as error:
        message = str(error).replace("\n", " ")[:300] or type(error).__name__
        evidence["error"] = message
        receipt["error"] = message
        row = {"unitId": item["unitId"], "sRegion": None, "bands": [PUBLISHER_BAND[survey]], "filename": item["fileName"],
               "accessUris": [{"uri": item["uri"], "fileName": item["fileName"], "band": PUBLISHER_BAND[survey],
                               "accessType": "file", "sourceId": "skyview-gsfc-us", "countryCode": "US", "role": "reachable-mirror"}],
               "sourceMetadata": {"relativePath": item["relativePath"], "fileName": item["fileName"], "headerStatus": "failed", "geometryStatus": "unavailable",
                   "headerEvidenceRef": HEADER_EVIDENCE_REF, "mirrorCountry": "US", "producer": PRODUCER[survey]["name"],
                   "producerCountry": PRODUCER[survey]["countryCode"], "publisherBand": PUBLISHER_BAND[survey], "failure": message,
                   "accessSemantics": "source-listed direct whole-map FITS; no cutout or archive wrapper"}}
        return row, {"evidence": evidence, "receipt": receipt}


def capture_survey(output: Path, survey: str, workers: int, timeout: int) -> dict:
    root = output / survey
    (root / "metadata").mkdir(parents=True, exist_ok=False)
    (root / "normalized").mkdir(parents=True)
    publisher_manifest, publisher_receipt = fetch_document(SURVEY_MANIFEST_URL, timeout)
    if f"surveys/xml/{survey}.xml.gz" not in publisher_manifest.decode("utf-8", errors="replace"):
        raise ValueError("SkyView survey.manifest does not advertise the selected XML inventory")
    xml_raw, xml_response = fetch_document(XML_URL[survey], timeout)
    roster, prefix, decoded_xml_sha = parse_inventory(xml_raw, survey)
    (root / "metadata/survey.manifest").write_bytes(publisher_manifest)
    (root / f"metadata/{survey}.xml.gz").write_bytes(xml_raw)

    rows_by_index = [None] * len(roster)
    evidence_by_index = [None] * len(roster)
    receipt_by_index = [None] * len(roster)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(capture_map, survey, item, timeout): index for index, item in enumerate(roster)}
        for completed, future in enumerate(as_completed(futures), start=1):
            index = futures[future]
            row, result = future.result()
            rows_by_index[index] = row
            evidence_by_index[index] = result["evidence"]
            receipt_by_index[index] = result["receipt"]
            if completed % 100 == 0 or completed == len(roster):
                print(f"{survey}: captured headers for {completed}/{len(roster)} roster rows", flush=True)

    headers_path = root / HEADER_EVIDENCE_REF
    headers_path.parent.mkdir(parents=True, exist_ok=True)
    header_lines = "".join(json.dumps(item, separators=(",", ":"), ensure_ascii=True) + "\n" for item in evidence_by_index)
    with gzip.open(headers_path, "wb", compresslevel=6) as output_stream:
        output_stream.write(header_lines.encode("utf-8"))
    rows_path = root / "normalized/native-rows.ndjson.gz"
    row_lines = "".join(json.dumps(row, separators=(",", ":"), ensure_ascii=True) + "\n" for row in rows_by_index)
    with gzip.open(rows_path, "wb", compresslevel=6) as output_stream:
        output_stream.write(row_lines.encode("utf-8"))

    metadata_documents = [
        file_reference(root, root / "metadata/survey.manifest", SURVEY_MANIFEST_URL),
        file_reference(root, root / f"metadata/{survey}.xml.gz", XML_URL[survey]),
        file_reference(root, headers_path, f"{BASE}/surveys/{survey}/"),
    ]
    header_evidence_sha = metadata_documents[2]["sha256"]
    row_file = file_reference(root, rows_path)
    row_file["rows"] = len(rows_by_index)
    header_failures = sum(item["status"] == "failed" for item in evidence_by_index)
    geometry_failures = sum(item["geometryStatus"] != "mapped" for item in receipt_by_index)
    spectral_conflicts = sum(bool(row["sourceMetadata"].get("spectralMetadataConflict")) for row in rows_by_index)
    gaps = [
        "native-map-valid-pixel-masks-unverified",
        "skyview-us-mirror-is-the-only-reachable-whole-map-route-checked",
        "map-range-probes-do-not-verify-full-file-retrieval",
    ]
    if survey == "nvss":
        gaps.append("nvss-indexed-mirror-roster-is-intensity-only-not-all-stokes-products")
    elif survey == "sumss":
        gaps.append("sumss-sydney-original-archive-route-unavailable")
    else:
        gaps.extend(["wenss-header-coordinate-and-projection-quirks-retained", "wenss-publisher-325-mhz-vs-header-frequency-conflict"])
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "skyview-radio-maps",
        "surveyId": survey, "releaseId": RELEASE_ID[survey], "capturedAt": datetime.now(timezone.utc).isoformat(),
        "coordinateFrame": "ICRS", "nativeCoordinateFrame": NATIVE_FRAME[survey], "ordering": "NESTED",
        "queryPagesComplete": True, "inventoryComplete": False, "rowCount": len(rows_by_index),
        "scope": {"expectedRowCount": EXPECTED_ROWS[survey], "xmlRosterPath": f"metadata/{survey}.xml.gz",
                  "xmlDecodedSha256": decoded_xml_sha, "spellPrefix": prefix, "fullSurveyInventory": False,
                  "validPixelMasksChecked": False, "geometryPrecision": "estimated", "headerOnly": True,
                  "headerEvidenceRef": HEADER_EVIDENCE_REF, "nativeCoordinateFrame": NATIVE_FRAME[survey],
                  "publisherBand": PUBLISHER_BAND[survey], "producer": PRODUCER[survey]["name"],
                  "producerCountry": PRODUCER[survey]["countryCode"], "mirror": "NASA/GSFC SkyView",
                  "mirrorCountry": "US", "sourceXmlRosterComplete": True,
                  "headerSuccessCount": len(rows_by_index) - header_failures, "headerFailureCount": header_failures,
                  "geometryFailureCount": geometry_failures, "spectralConflictCount": spectral_conflicts,
                  "validPixelMasksChecked": False},
        "sourcePagination": {"queryPagesComplete": True, "xmlStatus": xml_response["status"], "xmlUrl": xml_response["url"],
                             "xmlSha256": sha256(xml_raw), "xmlRowCount": len(roster),
                             "publisherManifestSha256": sha256(publisher_manifest),
                             "headerEvidenceSha256": header_evidence_sha,
                             "headerSuccessCount": len(rows_by_index) - header_failures,
                             "headerFailureCount": header_failures, "geometryFailureCount": geometry_failures,
                             "maps": receipt_by_index},
        "metadataDocuments": metadata_documents, "rowFiles": [row_file], "gaps": gaps,
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"surveyId": survey, "sourceId": SOURCE_ID[survey], "releaseId": RELEASE_ID[survey],
            "manifest": file_reference(root, manifest_path, XML_URL[survey]), "rows": len(rows_by_index),
            "indexedCandidateRows": len(rows_by_index) - geometry_failures, "headerFailures": header_failures,
            "geometryFailures": geometry_failures,
            "spectralConflicts": spectral_conflicts, "xmlRawBytes": len(xml_raw), "xmlRawSha256": sha256(xml_raw),
            "xmlDecodedSha256": decoded_xml_sha, "inputDirectory": str(root)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--survey", choices=[*SOURCE_ID, "all"], default="all")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or not 1 <= args.timeout <= 180:
        raise SystemExit("workers must be 1..32 and timeout must be 1..180 seconds")
    args.output.mkdir(parents=True, exist_ok=False)
    surveys = list(SOURCE_ID) if args.survey == "all" else [args.survey]
    results = [capture_survey(args.output, survey, args.workers, args.timeout) for survey in surveys]
    summary = {"schemaVersion": 1, "capturedAt": datetime.now(timezone.utc).isoformat(), "metadataOnly": True,
               "pixelBytesRead": 0, "sources": results}
    (args.output / "capture-summary.json").write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
