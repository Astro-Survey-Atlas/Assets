#!/usr/bin/env python3
"""Bounded, evidence-only DESI DR1 zcatalog adapter; never a full ingestion job.

Read fixed-width row bytes using the FITS header's storage dtype. Accessing a
whole Astropy logical/string column can materialize millions of unrelated rows.
No source bytes are modified and no science file is downloaded.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from astropy.io import fits
import numpy as np

RELATIVE_PATH = "zcatalog/v1/zall-pix-iron.fits"
FIELDS = (
    "TARGETID", "TARGET_RA", "TARGET_DEC", "Z", "ZERR", "ZWARN",
    "SPECTYPE", "DELTACHI2", "SURVEY", "PROGRAM", "ZCAT_PRIMARY", "OBJTYPE",
)
FRAME_SOURCE = "https://data.desi.lbl.gov/doc/releases/dr1/"


def extract(source_root: Path, start: int, count: int) -> dict:
    if start < 0 or not 1 <= count <= 200_000:
        raise ValueError("row start must be nonnegative; max rows must be 1–200000")
    source_root = source_root.resolve(strict=True)
    source = (source_root / RELATIVE_PATH).resolve(strict=True)
    source.relative_to(source_root)
    before = source.stat()
    with fits.open(source, memmap=True, character_as_bytes=True) as hdus:
        hdu = hdus["ZCATALOG"]
        if not isinstance(hdu, fits.BinTableHDU) or hdus[0].header.get("ZCATVER", "").strip() != "v1":
            raise ValueError("expected the DR1 iron v1 ZCATALOG binary table")
        for name in FIELDS:
            col = hdu.columns[name]
            if col.bscale not in (None, 1) or col.bzero not in (None, 0) or col.dim:
                raise ValueError(f"unsupported scaling/dimensions for {name}")
        if hdu.columns["ZCAT_PRIMARY"].format != "L":
            raise ValueError("ZCAT_PRIMARY must be a FITS logical column")
        total = int(hdu.header["NAXIS2"])
        if start >= total:
            raise ValueError("row start is outside the catalogue")
        stop = min(total, start + count)
        dtype = hdu.columns.dtype.newbyteorder(">")
        width = int(hdu.header["NAXIS1"])
        if dtype.itemsize != width:
            raise ValueError("unsupported FITS row layout")
        offset = hdu.fileinfo()["datLoc"]
        with source.open("rb") as stream:
            header_bytes = stream.read(offset)
            stream.seek(offset + start * width)
            row_bytes = stream.read((stop - start) * width)
        if len(row_bytes) != (stop - start) * width:
            raise ValueError("truncated FITS row window")
        raw = np.frombuffer(row_bytes, dtype=dtype)
        objects = []
        for i, row in enumerate(raw, start):
            def string(name):
                return bytes(row[name]).decode("ascii").strip()

            def finite(name):
                value = float(row[name])
                return value if math.isfinite(value) else None

            # FITS stores L as ASCII T/F (84/70), not numeric 1/0.
            logical = int(row["ZCAT_PRIMARY"])
            objects.append({
                "objectId": str(int(row["TARGETID"])),  # Preserve 64-bit IDs in JS.
                "surveyId": "desi", "releaseId": "dr1",
                "raDeg": finite("TARGET_RA"), "decDeg": finite("TARGET_DEC"),
                "redshift": finite("Z"), "redshiftError": finite("ZERR"),
                "redshiftFrame": "barycentric",
                "zcatPrimary": True if logical == 84 else False if logical == 70 else None,
                "objtype": string("OBJTYPE"), "program": string("PROGRAM"),
                "observingSurvey": string("SURVEY"), "spectype": string("SPECTYPE"),
                "zwarn": int(row["ZWARN"]), "deltaChi2": finite("DELTACHI2"),
                "sourceRow": i,
            })
    after = source.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("source changed during extraction")
    checksum_file = source.with_name("redux_iron_zcatalog_v1.sha256sum")
    expected = None
    if checksum_file.exists():
        for line in checksum_file.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("*") == source.name:
                expected = parts[0]
                break
    return {
        "schemaVersion": 1, "dataOrigin": "desi-dr1-local", "deliveryClass": "evidence",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "connector": "desi-dr1-local", "relativePath": RELATIVE_PATH,
            "hdu": "ZCATALOG", "catalogVersion": "v1", "production": "iron",
            "fileBytes": before.st_size, "fileMtimeNs": str(before.st_mtime_ns),
            "fileRows": total, "rowStartInclusive": start, "rowStopExclusive": stop,
            "headerSha256": hashlib.sha256(header_bytes).hexdigest(),
            "rowBytesSha256": hashlib.sha256(row_bytes).hexdigest(),
            "expectedFileSha256": expected, "wholeFileSha256Verified": False,
            "sampling": "contiguous-row-window", "sampleComplete": True,
            "catalogueComplete": start == 0 and stop == total, "skyRegionComplete": False,
            "coordinateFrame": "ICRS", "redshiftFrame": "barycentric",
            "redshiftFrameBasis": FRAME_SOURCE,
        },
        "notes": [
            "A complete row window, not a complete sky region or random/statistical sample.",
            "Primary and quality flags are retained; distance preparation applies the display selection.",
            "The expected whole-file hash is an unverified local manifest assertion; row/header hashes cover the bytes read.",
            "Redshift is not an independent distance measurement; the viewer states its cosmology and limitations.",
        ],
        "objects": objects,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True, help="Connector's mounted iron directory")
    parser.add_argument("--start-row", type=int, default=0)
    parser.add_argument("--max-rows", type=int, default=32768)
    parser.add_argument("--output", type=Path, required=True, help="Evidence path outside the Git checkout")
    args = parser.parse_args()
    output = args.output.resolve()
    checkout = Path(__file__).resolve().parents[1]
    if output.is_relative_to(checkout):
        parser.error("real catalogue rows must be written outside the Git checkout")
    if output.is_relative_to(args.source_root.resolve()):
        parser.error("output must not be written into the source directory")
    result = extract(args.source_root, args.start_row, args.max_rows)
    encoded = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        stream.write(encoded)
    receipt = {"path": str(output), "sha256": hashlib.sha256(encoded).hexdigest(), "bytes": len(encoded),
               "rows": len(result["objects"]), "source": result["source"], "deliveryClass": "evidence"}
    output.with_suffix(output.suffix + ".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
