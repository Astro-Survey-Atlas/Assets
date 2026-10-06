#!/usr/bin/env python3
"""Normalize the pinned IPHAS DR2 image-pipeline metadata table, without image pixels."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import shutil

import numpy as np
from astropy.io import fits


SOURCE_ID = "iphas-dr2-pipeline-images"
SURVEY_ID = "iphas"
RELEASE_ID = "iphas-dr2"
UPSTREAM_COMMIT = "e2e47c6964df6bb5fe9909e317ef18f0913698db"
SOURCE_URL = ("https://raw.githubusercontent.com/barentsen/iphas-dr2/" + UPSTREAM_COMMIT
              + "/scripts/release-preparation/iphas-images-pipeline.fits")
EXPECTED_SHA256 = "7cae94bb03e1fb3d43a9af49e164df88e8087d4c7fe6527e10fe066af825465d"
EXPECTED_SIZE = 63_570_240
EXPECTED_ROWS = 268_185
EXPECTED_DR2_ROWS = 169_392
EXPECTED_UNIQUE = 169_380
EXPECTED_DUPLICATES = 12
EXPECTED_BANDS = {"halpha": 56_464, "r": 56_464, "i": 56_464}
GEOMETRY_SOURCE = "pinned IPHAS DR2 author pipeline table, four CCD corners, ZPN frame"
AUTHOR_FILES = {
    "images.py": "94dec500e5a9e77e294b730ac83a69a36aad04b8e770588fe20f03a5d07c77b8",
    "augment-image-metadata.py": "e9142f6e8e0c1043c93fb4bfbb4ef3ac93e25f7575d6c2b4bec4215e7e511425",
}


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def text(value: object) -> str:
    if isinstance(value, bytes):
        value = value.decode("ascii", "strict")
    return str(value).replace("\x00", "").strip()


def number(value: object, label: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"IPHAS pipeline has a non-finite {label}")
    return parsed


def normalize_ra(value: float) -> float:
    return value % 360.0


def normalized_record(record: object) -> tuple[dict, str]:
    filename = text(record["filename"])
    match = re.fullmatch(r"r(\d{6})-([1-4])\.fits\.fz", filename)
    run = int(record["run"])
    ccd = int(record["ccd"])
    if not match or run != int(match.group(1)) or ccd != int(match.group(2)):
        raise ValueError("IPHAS pipeline row does not match its native run/CCD filename")

    in_dr2_text = text(record["in_dr2"]).lower()
    if in_dr2_text not in {"true", "false"}:
        raise ValueError("IPHAS pipeline in_dr2 flag is not boolean text")
    in_dr2 = in_dr2_text == "true"
    band = text(record["band"]).lower()
    if band not in EXPECTED_BANDS:
        raise ValueError(f"IPHAS pipeline row has an unsupported band: {band}")

    center_ra = normalize_ra(number(record["ra"], "RA"))
    center_dec = number(record["dec"], "Dec")
    ra_min = number(record["ra_min"], "RA minimum")
    ra_max = number(record["ra_max"], "RA maximum")
    dec_min = number(record["dec_min"], "Dec minimum")
    dec_max = number(record["dec_max"], "Dec maximum")
    if not (0 <= center_ra < 360 and -90 <= center_dec <= 90 and 0 <= ra_min < 360
            and ra_min < ra_max and ra_max - ra_min < 5 and -90 <= dec_min < dec_max <= 90):
        raise ValueError("IPHAS pipeline row has invalid four-corner image bounds")

    corners = [[normalize_ra(ra_min), dec_min], [normalize_ra(ra_max), dec_min],
               [normalize_ra(ra_max), dec_max], [normalize_ra(ra_min), dec_max]]
    footprint = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in corners)
    uri = f"http://www.iphas.org/data/images/{filename[:4]}/{filename}"
    metadata = {
        "run": run,
        "ccd": ccd,
        "inDr2": in_dr2,
        "band": band.upper() if band == "r" or band == "i" else "HALPHA",
        "sourceFilename": filename,
        "raCenter": center_ra,
        "decCenter": center_dec,
        "raMin": ra_min,
        "raMax": ra_max,
        "decMin": dec_min,
        "decMax": dec_max,
        "coordinateFrame": "ICRS",
        "projection": "ZPN",
        "geometrySource": GEOMETRY_SOURCE,
        "footprint": footprint,
        "accessAvailability": "unverified",
    }
    row = {
        "unitId": f"{run}/{ccd}",
        "filename": filename,
        "sRegion": footprint,
        "bands": [metadata["band"]],
        "accessUris": [{"sourceId": "iphas-publisher", "uri": uri, "fileName": filename,
                        "accessType": "file", "band": metadata["band"]}],
        "sourceMetadata": metadata,
    }
    return row, band


def document(path: Path, root: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "sha256": sha256(body), "sizeBytes": len(body), "url": url}


def immutable_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to replace different evidence: {path}")
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def acquire(pipeline: Path, output: Path) -> dict:
    raw = pipeline.read_bytes()
    if len(raw) != EXPECTED_SIZE or sha256(raw) != EXPECTED_SHA256:
        raise ValueError("IPHAS pipeline metadata differs from its pinned repository blob")
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite capture directory: {output}")

    with fits.open(pipeline, memmap=True) as hdus:
        if len(hdus) != 2 or hdus[0].data is not None or hdus[1].header.get("NAXIS2") != EXPECTED_ROWS:
            raise ValueError("IPHAS pinned pipeline file has an unexpected HDU/row layout")
        table = hdus[1].data
        required = {"filename", "run", "ccd", "in_dr2", "band", "ra", "dec", "ra_min", "ra_max", "dec_min", "dec_max"}
        if not required.issubset({name.lower() for name in hdus[1].columns.names}):
            raise ValueError("IPHAS pipeline table is missing native image metadata columns")
        if len(table) != EXPECTED_ROWS:
            raise ValueError("IPHAS pipeline table row count changed")

        rows: list[dict] = []
        band_counts: dict[str, int] = {}
        dr2_rows = 0
        unique_rows: dict[str, str] = {}
        duplicate_rows = 0
        for record in table:
            row, raw_band = normalized_record(record)
            band_counts[raw_band] = band_counts.get(raw_band, 0) + int(row["sourceMetadata"]["inDr2"])
            if row["sourceMetadata"]["inDr2"]:
                dr2_rows += 1
                key = f"{row['unitId']}/{row['bands'][0]}"
                digest = sha256(json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
                prior = unique_rows.get(key)
                if prior is not None:
                    if prior != digest:
                        raise ValueError("IPHAS duplicate run/CCD/band rows disagree")
                    duplicate_rows += 1
                else:
                    unique_rows[key] = digest
            rows.append(row)

    if band_counts != EXPECTED_BANDS or dr2_rows != EXPECTED_DR2_ROWS or len(unique_rows) != EXPECTED_UNIQUE or duplicate_rows != EXPECTED_DUPLICATES:
        raise ValueError("IPHAS DR2 recalibration membership or duplicate denominator changed")

    output.mkdir(parents=True, exist_ok=False)
    metadata = output / "metadata"
    normalized = output / "normalized"
    metadata.mkdir(parents=True)
    normalized.mkdir(parents=True)
    pipeline_copy = metadata / "iphas-images-pipeline.fits"
    immutable_write(pipeline_copy, raw)
    metadata_docs = [document(pipeline_copy, output, SOURCE_URL)]
    for name, expected_hash in AUTHOR_FILES.items():
        source_file = pipeline.parent / name
        body = source_file.read_bytes()
        if sha256(body) != expected_hash:
            raise ValueError(f"Pinned IPHAS author rule changed: {name}")
        dest = metadata / name
        immutable_write(dest, body)
        metadata_docs.append(document(dest, output,
            f"https://raw.githubusercontent.com/barentsen/iphas-dr2/{UPSTREAM_COMMIT}/scripts/release-preparation/{name}"))

    row_bytes = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in rows).encode()
    rows_path = normalized / "native-rows.ndjson.gz"
    immutable_write(rows_path, gzip.compress(row_bytes, mtime=0))
    row_doc = document(rows_path, output, SOURCE_URL)
    captured = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1,
        "deliveryClass": "evidence",
        "adapter": "iphas-dr2-pipeline",
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "capturedAt": captured,
        "coordinateFrame": "ICRS",
        "nativeCoordinateFrame": "ICRS",
        "ordering": "NESTED",
        "inventoryComplete": False,
        "queryPagesComplete": True,
        "rowCount": EXPECTED_ROWS,
        "scope": {
            "upstreamGitCommit": UPSTREAM_COMMIT,
            "expectedRows": EXPECTED_ROWS,
            "expectedDr2RecalibrationRows": EXPECTED_DR2_ROWS,
            "expectedUniqueRunCcdBands": EXPECTED_UNIQUE,
            "expectedDuplicateRunCcdBands": EXPECTED_DUPLICATES,
            "bandCounts": EXPECTED_BANDS,
            "finalQcReconciled": False,
            "fullReleaseInventory": False,
            "geometrySource": GEOMETRY_SOURCE,
            "geometryPrecision": "estimated",
            "imageAvailabilityVerified": False,
            "corruptRun376022RowsInDr2": 0,
        },
        "sourcePagination": {"queryPagesComplete": True, "kind": "one pinned upstream FITS metadata table", "rows": EXPECTED_ROWS},
        "metadataDocuments": metadata_docs,
        "rowFiles": [{**row_doc, "rows": EXPECTED_ROWS}],
    }
    immutable_write(output / "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode())
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = acquire(args.pipeline, args.output)
    print(f"Captured {manifest['rowCount']} IPHAS pipeline metadata rows; {manifest['scope']['expectedDr2RecalibrationRows']} recalibration rows, {manifest['scope']['expectedUniqueRunCcdBands']} unique run/CCD/band identities; inventoryComplete=false")


if __name__ == "__main__":
    main()
