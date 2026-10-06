#!/usr/bin/env python3
"""Capture the two Rubin First Look publisher image metadata ranges only."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from astropy.wcs import WCS


SOURCE_ID = "rubin-firstlook-public-images"
SURVEY_ID = "rubin"
RELEASE_ID = "rubin-firstlook"
SOURCE_URL = "https://noirlab.edu/public/images/noirlab2521a/"
RECORD_URL = "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FRubin%2FFirstLook&get=record&fmt=json"
RECORD_SHA256 = "93e62dc483ef4234617575788ab239482461b525cc532357e9586fb067c3f8f4"
IMAGE_ROOT = "https://storage.noirlab.edu/media/archives/images/original/"
GEOMETRY_SOURCE = "NOIRLab publisher BigTIFF IFD and AVM XMP range; AVM Position quality"
IMAGES = {
    "noirlab2521a": {
        "fileName": "noirlab2521a.tif", "sizeBytes": 15_142_805_372,
        "xmpRange": (524, 26_612), "xmpSha256": "2434a33aab3fa183b284cb332b503b9d9bfe53f7acc48cec13e58e6df92c1d04",
        "dimensions": [97_943, 51_536],
        "referenceValue": [186.368524202294, 6.930215747979968],
        "referencePixel": [48_971.5, 25_768.0],
        "scale": [-5.55399208524905e-5, 5.55399208524905e-5], "rotation": 48.96,
    },
    "noirlab2521b": {
        "fileName": "noirlab2521b.tif", "sizeBytes": 25_956_028_716,
        "xmpRange": (524, 20_743), "xmpSha256": "9bc9699803579fb8b2fb0a6ca3c1ad13f9ac6e368c65d42f7c06d5c6173f8930",
        "dimensions": [84_000, 51_500],
        "referenceValue": [271.6317360235022, -23.762469026534358],
        "referencePixel": [42_000.0, 25_750.0],
        "scale": [-5.553994996501517e-5, 5.553994996501517e-5], "rotation": -12.0,
    },
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


def request(url: str, *, method: str = "GET", byte_range: tuple[int, int] | None = None) -> tuple[bytes, int, dict[str, str]]:
    headers = {"User-Agent": "Astro-Survey-Atlas-Assets metadata-only Rubin collector/1.0"}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read(128 * 1024 + 1)
            if len(body) > 128 * 1024:
                raise ValueError("Rubin First Look metadata response exceeded its 128 KiB budget")
            return body, response.status, {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as error:
        raise ValueError(f"Rubin First Look metadata request returned HTTP {error.code}: {url}") from error


def local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def parse_sequence(root: ET.Element, property_name: str) -> list[float]:
    short_name = property_name.removeprefix("Spatial.")
    element = next((item for item in root.iter()
                    if local_name(item.tag) in {property_name, short_name}), None)
    if element is None:
        raise ValueError(f"Rubin AVM XMP is missing {property_name}")
    values = [float((child.text or "").strip()) for child in element.iter() if local_name(child.tag) == "li"]
    if len(values) != 2 or not all(math.isfinite(value) for value in values):
        raise ValueError(f"Rubin AVM XMP has invalid {property_name}")
    return values


def parse_avm(xmp: bytes) -> dict:
    root = ET.fromstring(xmp)
    attrs = {local_name(key): value.strip() for element in root.iter() for key, value in element.attrib.items()}
    def attribute(name: str) -> str:
        return attrs.get(f"Spatial.{name}", attrs.get(name, ""))

    return {
        "coordinateFrame": attribute("CoordinateFrame"),
        "equinox": attribute("Equinox"),
        "projection": attribute("CoordsystemProjection"),
        "quality": attribute("Quality"),
        "rotation": float(attribute("Rotation")),
        "referenceValue": parse_sequence(root, "Spatial.ReferenceValue"),
        "referenceDimension": parse_sequence(root, "Spatial.ReferenceDimension"),
        "referencePixel": parse_sequence(root, "Spatial.ReferencePixel"),
        "scale": parse_sequence(root, "Spatial.Scale"),
    }


def _entry_value(entry: bytes) -> tuple[int, int, int, int]:
    tag, field_type = struct.unpack("<HH", entry[:4])
    count = struct.unpack("<Q", entry[4:12])[0]
    value_offset = struct.unpack("<Q", entry[12:20])[0]
    return tag, field_type, count, value_offset


def parse_big_tiff_header(header: bytes, count_bytes: bytes, entries: bytes, expected_size: int) -> dict:
    if len(header) != 16 or header[:8] != b"II+\x00\x08\x00\x00\x00" or len(count_bytes) != 8:
        raise ValueError("Rubin publisher file is not the expected little-endian BigTIFF")
    first_ifd = struct.unpack("<Q", header[8:16])[0]
    entry_count = struct.unpack("<Q", count_bytes)[0]
    if first_ifd != 16 or entry_count != 22 or len(entries) != entry_count * 20:
        raise ValueError("Rubin publisher BigTIFF has an unexpected first IFD layout")
    tags = {_entry_value(entries[index * 20:(index + 1) * 20])[0]: _entry_value(entries[index * 20:(index + 1) * 20])
            for index in range(entry_count)}

    def scalar(tag: int) -> int:
        if tag not in tags:
            raise ValueError(f"Rubin BigTIFF IFD is missing tag {tag}")
        _, field_type, count, raw = tags[tag]
        if count != 1:
            raise ValueError(f"Rubin BigTIFF IFD tag {tag} is not a scalar")
        if field_type == 3:
            return raw & 0xFFFF
        if field_type == 4:
            return raw & 0xFFFFFFFF
        if field_type == 16:
            return raw
        raise ValueError(f"Rubin BigTIFF IFD tag {tag} has an unsupported integer type")

    xmp_tag = tags.get(700)
    if not xmp_tag or xmp_tag[1] != 1:
        raise ValueError("Rubin BigTIFF IFD is missing its XMP byte range")
    return {"width": scalar(256), "height": scalar(257), "xmpOffset": xmp_tag[3], "xmpLength": xmp_tag[2],
            "fileSizeBytes": expected_size}


def frame_polygon(avm: dict) -> str:
    rotation = math.radians(avm["rotation"])
    sx, sy = avm["scale"]
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = np.asarray(avm["referencePixel"], dtype=float)
    wcs.wcs.crval = np.asarray(avm["referenceValue"], dtype=float)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.cd = np.asarray([[sx * math.cos(rotation), -sy * math.sin(rotation)],
                             [sx * math.sin(rotation), sy * math.cos(rotation)]], dtype=float)
    width, height = avm["referenceDimension"]
    edge_pixels = np.asarray([[0.5, 0.5], [width + 0.5, 0.5], [width + 0.5, height + 0.5], [0.5, height + 0.5]])
    sky = wcs.all_pix2world(edge_pixels, 1)
    vertices = [[float(ra % 360.0), float(dec)] for ra, dec in sky]
    if not np.all(np.isfinite(sky)) or any(not (0 <= ra < 360 and -90 <= dec <= 90) for ra, dec in vertices):
        raise ValueError("Rubin AVM TAN corners are outside the ICRS sphere")
    return "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in vertices)


def range_capture(output: Path, image_id: str, url: str, start: int, end_inclusive: int, file_size: int) -> dict:
    body, status, headers = request(url, byte_range=(start, end_inclusive))
    expected_range = f"bytes {start}-{end_inclusive}/{file_size}"
    if status != 206 or headers.get("content-range") != expected_range or len(body) != end_inclusive - start + 1:
        raise ValueError(f"Rubin publisher did not honor metadata-only Range {expected_range}")
    name = f"metadata/{image_id}-range-{start}-{end_inclusive}.bin"
    immutable_write(output / name, body)
    return {"start": start, "endInclusive": end_inclusive, "status": status, "contentRange": headers["content-range"],
            "bytesRead": len(body), "ref": name, "sha256": sha256(body)}


def close_pair(actual: list[float], expected: list[float], tolerance: float = 1e-12) -> bool:
    return len(actual) == len(expected) and all(abs(left - right) <= tolerance for left, right in zip(actual, expected))


def capture(output: Path) -> dict:
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite capture directory: {output}")
    output.mkdir(parents=True, exist_ok=False)
    (output / "metadata").mkdir()
    (output / "normalized").mkdir()

    record, status, _ = request(RECORD_URL)
    if status != 200 or sha256(record) != RECORD_SHA256:
        raise ValueError("Rubin First Look CDS provenance record differs from the locked source record")
    try:
        record_doc = json.loads(record)
    except json.JSONDecodeError as error:
        raise ValueError("Rubin First Look CDS provenance record is not JSON") from error
    record_text = json.dumps(record_doc, ensure_ascii=False).lower()
    if any(item["fileName"].lower() not in record_text for item in IMAGES.values()):
        raise ValueError("Rubin First Look CDS source record does not name both expected publisher images")
    record_ref = "metadata/cds-rubin-firstlook-record.json"
    immutable_write(output / record_ref, record)

    metadata_images = []
    rows = []
    metadata_documents = [{"ref": record_ref, "sha256": sha256(record), "sizeBytes": len(record), "url": RECORD_URL}]
    for image_id, expected in IMAGES.items():
        file_name = expected["fileName"]
        url = IMAGE_ROOT + file_name
        _, head_status, head_headers = request(url, method="HEAD")
        if head_status != 200 or int(head_headers.get("content-length", "-1")) != expected["sizeBytes"]:
            raise ValueError(f"Rubin publisher image HEAD differs from the locked source file: {file_name}")

        ranges = []
        ranges.append(range_capture(output, image_id, url, 0, 7, expected["sizeBytes"]))
        ranges.append(range_capture(output, image_id, url, 8, 15, expected["sizeBytes"]))
        ranges.append(range_capture(output, image_id, url, 16, 23, expected["sizeBytes"]))
        ranges.append(range_capture(output, image_id, url, 24, 463, expected["sizeBytes"]))
        header_bytes = {item["start"]: (output / item["ref"]).read_bytes() for item in ranges}
        ifd = parse_big_tiff_header(header_bytes[0] + header_bytes[8], header_bytes[16], header_bytes[24], expected["sizeBytes"])
        xmp_start, xmp_end = expected["xmpRange"]
        if ifd["xmpOffset"] != xmp_start or ifd["xmpLength"] != xmp_end - xmp_start + 1:
            raise ValueError(f"Rubin publisher IFD XMP range differs from the locked metadata range: {file_name}")
        xmp = range_capture(output, image_id, url, xmp_start, xmp_end, expected["sizeBytes"])
        ranges.append(xmp)
        xmp_body = (output / xmp["ref"]).read_bytes()
        avm = parse_avm(xmp_body)
        if (xmp["sha256"] != expected["xmpSha256"]
                or ifd["width"] != expected["dimensions"][0]
                or ifd["height"] != expected["dimensions"][1]
                or avm["coordinateFrame"] != "ICRS"
                or avm["equinox"] != "J2000"
                or avm["projection"] != "TAN"
                or avm["quality"] != "Position"
                or avm["referenceDimension"] != expected["dimensions"]
                or not close_pair(avm["referenceValue"], expected["referenceValue"])
                or not close_pair(avm["referencePixel"], expected["referencePixel"])
                or not close_pair(avm["scale"], expected["scale"])
                or abs(avm["rotation"] - expected["rotation"]) > 1e-10):
            raise ValueError(f"Rubin publisher AVM does not match the locked image metadata: {file_name}")
        footprint = frame_polygon(avm)
        xmp_ref = xmp["ref"]
        metadata_documents.extend({"ref": item["ref"], "sha256": item["sha256"], "sizeBytes": item["bytesRead"], "url": url}
                                  for item in ranges)
        image_capture = {
            "imageId": image_id, "fileName": file_name, "imageUrl": url, "fileSizeBytes": expected["sizeBytes"],
            "headStatus": head_status, "width": ifd["width"], "height": ifd["height"], "xmpRef": xmp_ref,
            "xmpSha256": xmp["sha256"], "ranges": ranges, "avm": avm,
            "coordinateFrame": avm["coordinateFrame"], "equinox": avm["equinox"], "projection": avm["projection"],
            "quality": avm["quality"], "footprint": footprint, "pixelPayloadRead": False,
        }
        metadata_images.append(image_capture)
        row_metadata = {
            "imageId": image_id, "fileSizeBytes": expected["sizeBytes"], "xmpRef": xmp_ref,
            "xmpSha256": xmp["sha256"], "captureRef": "metadata/rubin-firstlook-capture.json",
            "coordinateFrame": avm["coordinateFrame"], "equinox": avm["equinox"], "projection": avm["projection"],
            "quality": avm["quality"], "geometrySource": GEOMETRY_SOURCE, "footprint": footprint,
            "accessAvailability": "public", "avm": avm,
        }
        rows.append({
            "unitId": image_id, "filename": file_name, "sRegion": footprint, "bands": ["RGB"],
            "accessUris": [{"sourceId": "noirlab-publisher", "uri": url, "fileName": file_name,
                            "accessType": "file", "band": "RGB"}],
            "sourceMetadata": row_metadata,
        })

    capture_doc = {"schemaVersion": 1, "pixelPayloadRead": False, "images": metadata_images}
    capture_ref = "metadata/rubin-firstlook-capture.json"
    capture_bytes = (json.dumps(capture_doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    immutable_write(output / capture_ref, capture_bytes)
    metadata_documents.append({"ref": capture_ref, "sha256": sha256(capture_bytes), "sizeBytes": len(capture_bytes), "url": SOURCE_URL})

    rows_path = output / "normalized/native-rows.ndjson.gz"
    row_bytes = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n" for row in rows).encode()
    immutable_write(rows_path, gzip.compress(row_bytes, mtime=0))
    row_doc = {"ref": "normalized/native-rows.ndjson.gz", "sha256": sha256(rows_path.read_bytes()),
               "sizeBytes": rows_path.stat().st_size, "url": SOURCE_URL, "rows": len(rows)}

    captured = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1, "deliveryClass": "evidence", "adapter": "rubin-firstlook-avm",
        "surveyId": SURVEY_ID, "releaseId": RELEASE_ID, "capturedAt": captured,
        "coordinateFrame": "ICRS", "nativeCoordinateFrame": "ICRS", "ordering": "NESTED",
        "inventoryComplete": False, "queryPagesComplete": True, "rowCount": len(rows),
        "scope": {"expectedImageCount": len(IMAGES), "fullScientificInventory": False, "outreachImagesOnly": True,
                  "geometryPrecision": "estimated", "validPixelMasksChecked": False, "publisherRecordSha256": RECORD_SHA256,
                  "pixelPayloadRead": False},
        "sourcePagination": {"queryPagesComplete": True, "kind": "fixed publisher source record", "expectedRows": len(IMAGES)},
        "metadataDocuments": metadata_documents,
        "rowFiles": [row_doc],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    immutable_write(output / "manifest.json", manifest_bytes)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = capture(args.output)
    print(f"Captured {manifest['rowCount']} Rubin First Look outreach image frames; TIFF pixels were not read; inventoryComplete=false")


if __name__ == "__main__":
    main()
