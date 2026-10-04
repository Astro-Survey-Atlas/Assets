#!/usr/bin/env python3
"""Acquire SDSS DR9 field definitions, never science images or object catalogs.

The fixed upstream window_flist FITS is a native-field metadata table. The
normalization preserves its original coordinates and quality arrays, and writes
bounded gzip NDJSON batches for a managed metadata import. This script does not
register a snapshot, build an index, or activate a version.

Requires numpy and astropy. Usage:
  python3 scripts/acquire-sdss-native-fields.py --output <evidence-directory>
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request

import numpy as np
from astropy.io import fits


SOURCE_URL = "https://data.sdss.org/sas/dr9/env/PHOTO_RESOLVE/window_flist.fits"
FRAME_ROOT = "https://data.sdss.org/sas/dr9/boss/photoObj/frames"
BANDS = ("u", "g", "r", "i", "z")
DOCUMENTS = (
    (
        "window-flist-datamodel.html",
        "https://data.sdss.org/datamodel/files/PHOTO_RESOLVE/window_flist.html",
    ),
    ("dr9-resolve.html", "https://www.sdss3.org/dr9/algorithms/resolve.php"),
    ("dr9-astrometry.html", "https://www.sdss3.org/dr9/algorithms/astrometry.php"),
    ("dr9-images.html", "https://www.sdss3.org/dr9/imaging/images.php"),
    (
        "frame-datamodel.html",
        "https://data.sdss.org/datamodel/files/BOSS_PHOTOOBJ/frames/RERUN/RUN/CAMCOL/frame.html",
    ),
    (
        "dr9-image-status.html",
        "https://www.sdss3.org/dr9/algorithms/bitmask_image_status.php",
    ),
    (
        "dr9-calib-status.html",
        "https://www.sdss3.org/dr9/algorithms/bitmask_calib_status.php",
    ),
    ("dr9-frame-runs-301.html", f"{FRAME_ROOT}/301/"),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def acquire(path: Path, url: str, max_bytes: int) -> dict:
    """Reuse only a hashed receipt, otherwise capture the fixed metadata URL."""
    receipt_path = path.with_name(f"{path.name}.receipt.json")
    if path.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if (
            receipt.get("sourceUrl") == url
            and receipt.get("sizeBytes") == path.stat().st_size
            and receipt.get("sha256") == sha256_file(path)
        ):
            return receipt
        raise ValueError(f"Existing metadata/receipt mismatch: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Astro-Survey-Atlas-Assets/1.0 (metadata only)"},
    )
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 200:
            raise ValueError(f"Expected a complete metadata response: {response.status}")
        headers = dict(response.headers)
        content_length = response.headers.get("Content-Length")
        if content_length is not None and int(content_length) > max_bytes:
            raise ValueError(f"Metadata exceeds the bounded size: {url}")
        with temporary.open("wb") as target:
            for data in iter(lambda: response.read(1024 * 1024), b""):
                size += len(data)
                if size > max_bytes:
                    raise ValueError(f"Metadata exceeds the bounded size: {url}")
                target.write(data)
                digest.update(data)
        if content_length is not None and size != int(content_length):
            raise ValueError(f"Metadata response is incomplete: {url}")
        resolved_url = response.geturl()
    temporary.replace(path)
    receipt = {
        "schemaVersion": 1,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": url,
        "resolvedUrl": resolved_url,
        "status": 200,
        "headers": headers,
        "sizeBytes": size,
        "sha256": digest.hexdigest(),
        "scope": "Official native-field metadata or documentation only",
        "deliveryClass": "evidence",
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def great_circle_to_icrs(mu, nu, node, incl):
    """Apply the source's DR9 J2000 catalog mean-place rotation.

    These SDSS equatorial field-window coordinates are used as approximate ICRS
    geometry, not as a claim of per-band WCS accuracy or valid-pixel coverage.
    """
    longitude = np.deg2rad(mu - node)
    latitude = np.deg2rad(nu)
    inclination = np.deg2rad(incl)
    x = np.cos(longitude) * np.cos(latitude)
    y = (
        np.sin(longitude) * np.cos(latitude) * np.cos(inclination)
        - np.sin(latitude) * np.sin(inclination)
    )
    z = (
        np.sin(longitude) * np.cos(latitude) * np.sin(inclination)
        + np.sin(latitude) * np.cos(inclination)
    )
    return (np.rad2deg(np.arctan2(y, x)) + node) % 360, np.rad2deg(
        np.arcsin(np.clip(z, -1, 1))
    )


def metadata_reference(root: Path, path: Path, url: str) -> dict:
    return {
        "ref": path.relative_to(root).as_posix(),
        "url": url,
        "sha256": sha256_file(path),
        "sizeBytes": path.stat().st_size,
    }


def normalize(root: Path, batch_size: int) -> dict:
    source_path = root / "window_flist.fits"
    source_receipt = root / "window_flist.fits.receipt.json"
    # The first diagnostic collection used this receipt name. Reuse its bytes
    # only after acquire() verifies both SHA and size.
    original_receipt = root / "window_flist.receipt.json"
    if original_receipt.exists() and not source_receipt.exists():
        source_receipt.write_bytes(original_receipt.read_bytes())
    acquisition = acquire(source_path, SOURCE_URL, 512 * 1024 * 1024)
    metadata_documents = [metadata_reference(root, source_path, SOURCE_URL)]
    metadata_documents.append(metadata_reference(root, source_receipt, SOURCE_URL))
    for filename, url in DOCUMENTS:
        path = root / "source-documents" / filename
        acquire(path, url, 2 * 1024 * 1024)
        metadata_documents.append(metadata_reference(root, path, url))
        metadata_documents.append(
            metadata_reference(root, path.with_name(f"{path.name}.receipt.json"), url)
        )
    runs_html = (root / "source-documents/dr9-frame-runs-301.html").read_text()
    frame_runs = set(int(run) for run in re.findall(r'href="([0-9]+)/"', runs_html))
    if not frame_runs:
        raise ValueError("The official DR9 frame run-directory roster is empty")
    raw_counts = {}
    exclusions = Counter()
    row_files = []
    selected_count = 0
    batch = []
    seen = set()

    def save_batch() -> None:
        if not batch:
            return
        path = root / "rows" / f"fields-{len(row_files) + 1:04d}.ndjson.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.tmp")
        with temporary.open("wb") as output:
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as stream:
                for record in batch:
                    stream.write(
                        (json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
                        .encode("utf-8")
                    )
        temporary.replace(path)
        row_files.append(
            {
                "ref": path.relative_to(root).as_posix(),
                "sha256": sha256_file(path),
                "sizeBytes": path.stat().st_size,
                "rows": len(batch),
            }
        )
        print(f"Wrote {path.name}: {len(batch):,} field metadata records", flush=True)
        batch.clear()

    with fits.open(source_path, memmap=True, checksum=True) as hdul:
        if len(hdul) != 2 or hdul[1].header["XTENSION"] != "BINTABLE":
            raise ValueError("Expected the official metadata-only field table")
        table = hdul[1].data
        required = (
            "RUN", "RERUN", "CAMCOL", "FIELD", "RA", "DEC", "NODE", "INCL",
            "MU_START", "MU_END", "NU_START", "NU_END", "PHOTO_STATUS",
            "IMAGE_STATUS", "CALIB_STATUS", "PSP_STATUS", "SCORE", "MJD",
        )
        if not all(name in table.columns.names for name in required):
            raise ValueError("Native-field metadata columns changed")
        raw_counts = {
            "totalRows": len(table),
            "reruns": dict(Counter(str(value).strip() for value in table["RERUN"])),
            "photoStatus": dict(Counter(str(int(value)) for value in table["PHOTO_STATUS"])),
            "officialFrameRuns301": len(frame_runs),
        }
        # Vectorize only a small table slice; keep normalization memory bounded.
        for start in range(0, len(table), 4096):
            part = table[start : start + 4096]
            corners_mu = np.column_stack(
                (part["MU_START"], part["MU_END"], part["MU_END"], part["MU_START"])
            )
            corners_nu = np.column_stack(
                (part["NU_START"], part["NU_START"], part["NU_END"], part["NU_END"])
            )
            ra, dec = great_circle_to_icrs(
                corners_mu, corners_nu, part["NODE"][:, None], part["INCL"][:, None]
            )
            center_ra, center_dec = great_circle_to_icrs(
                (part["MU_START"] + part["MU_END"]) / 2,
                (part["NU_START"] + part["NU_END"]) / 2,
                part["NODE"], part["INCL"],
            )
            for offset, row in enumerate(part):
                run = int(row["RUN"])
                rerun = str(row["RERUN"]).strip()
                camcol = int(row["CAMCOL"])
                field = int(row["FIELD"])
                if rerun != "301":
                    exclusions[f"rerun-{rerun}-outside-dr9-corrected-frame-scope"] += 1
                    continue
                if run not in frame_runs:
                    exclusions["run-not-in-official-dr9-frame-directory"] += 1
                    continue
                if int(row["PHOTO_STATUS"]) != 0:
                    exclusions[f"photo-status-{int(row['PHOTO_STATUS'])}"] += 1
                    continue
                coordinates = (
                    "RA", "DEC", "NODE", "INCL", "MU_START", "MU_END", "NU_START", "NU_END"
                )
                if (
                    not all(np.isfinite(row[name]) for name in coordinates)
                    or not 0 < row["MU_END"] - row["MU_START"] < 2
                    or not 0 < row["NU_END"] - row["NU_START"] < 2
                    or not -90 <= row["DEC"] <= 90
                    or not np.all(np.isfinite(ra[offset]))
                    or not np.all(np.isfinite(dec[offset]))
                ):
                    exclusions["invalid-field-window-geometry"] += 1
                    continue
                unit_id = f"{run}/{rerun}/{camcol}/{field}"
                if unit_id in seen:
                    raise ValueError(f"Duplicate original field identity: {unit_id}")
                seen.add(unit_id)
                polygon = "POLYGON ICRS " + " ".join(
                    f"{float(x):.12f} {float(y):.12f}" for x, y in zip(ra[offset], dec[offset])
                )
                access_uris = []
                for band in BANDS:
                    filename = f"frame-{band}-{run:06d}-{camcol}-{field:04d}.fits.bz2"
                    access_uris.append(
                        {
                            "band": band,
                            "uri": f"{FRAME_ROOT}/{rerun}/{run}/{camcol}/{filename}",
                            "filename": filename,
                            "availability": "unverified",
                            "resolution": "documented-rule",
                        }
                    )
                batch.append(
                    {
                        "unitId": unit_id,
                        "unitKind": "field",
                        "sRegion": polygon,
                        "center": {"ra": float(center_ra[offset]), "dec": float(center_dec[offset])},
                        "bands": list(BANDS),
                        "accessUris": access_uris,
                        "precision": "estimated",
                        "sourceMetadata": {
                            "windowRowIndex": start + offset,
                            "run": run, "rerun": rerun, "camcol": camcol, "field": field,
                            "originalCenter": {"ra": float(row["RA"]), "dec": float(row["DEC"])},
                            "coordinateSourceFrame": "SDSS J2000 catalog mean place",
                            "geometryKind": "official-trimmed-field-window",
                            "greatCircle": {
                                "node": float(row["NODE"]), "incl": float(row["INCL"]),
                                "muStart": float(row["MU_START"]), "muEnd": float(row["MU_END"]),
                                "nuStart": float(row["NU_START"]), "nuEnd": float(row["NU_END"]),
                            },
                            "mjd": int(row["MJD"]),
                            "photoStatus": int(row["PHOTO_STATUS"]),
                            "pspStatus": [int(value) for value in row["PSP_STATUS"]],
                            "imageStatus": [int(value) for value in row["IMAGE_STATUS"]],
                            "calibStatus": [int(value) for value in row["CALIB_STATUS"]],
                            "score": float(row["SCORE"]),
                            "bandOrder": list(BANDS),
                        },
                    }
                )
                selected_count += 1
                if len(batch) == batch_size:
                    save_batch()
        save_batch()
    assert selected_count + sum(exclusions.values()) == raw_counts["totalRows"]
    manifest = {
        "schemaVersion": 1,
        "adapter": "sdss-field",
        "surveyId": "sdss",
        "releaseId": "sdss-dr09",
        "sourceUnitKind": "field",
        "frame": "ICRS",
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "availableOrders": [4, 8],
        "overviewOrder": 4,
        "maxOrder": 8,
        "precision": "estimated",
        "capturedAt": acquisition["capturedAt"],
        "normalizedAt": datetime.now(timezone.utc).isoformat(),
        "metadataDocuments": metadata_documents,
        "rowFiles": row_files,
        "rowCount": selected_count,
        "queryPagesComplete": True,
        "inventoryComplete": False,
        "scope": (
            "Complete capture of the official DR9 window_flist metadata; normalized native fields "
            "are rerun301, PHOTO_STATUS=0, and their run appears in the DR9 frames/301 directory. "
            "Other rows stay in the original metadata and exclusion counters. Geometry is the "
            "official field-window rectangle trimmed 64 pixels on each image edge, converted "
            "from source J2000 great-circle coordinates to approximate ICRS polygons; "
            "it is not an individual band's full WCS, valid pixels, or primary-only survey area. "
            "All five documented bands preserve original per-band quality flags. Their frame "
            "URIs follow the official path rule and remain unverified individually. "
            "Zero CALIB_STATUS values do not establish photometric quality or file existence."
        ),
        "rawCounts": raw_counts,
        "excludedRows": dict(exclusions),
        "gaps": [
            "sdss-dr9-trimmed-field-window-estimated-geometry",
            "sdss-dr9-frame-uris-not-individually-verified",
            "sdss-dr9-nonnormal-and-rerun157-fields-not-mapped",
        ],
        "sourceUrl": SOURCE_URL,
        "documentationUrls": [url for _, url in DOCUMENTS],
        "implementation": "scripts/acquire-sdss-native-fields.py",
        "deliveryClass": "evidence",
        "scienceDataDownloaded": False,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=100000)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 100000:
        parser.error("--batch-size must be between 1 and 100000")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = normalize(args.output, args.batch_size)
    print(
        json.dumps(
            {
                "manifest": str(args.output / "manifest.json"),
                "sha256": sha256_file(args.output / "manifest.json"),
                "rowCount": manifest["rowCount"],
                "excludedRows": manifest["excludedRows"],
                "rowFiles": len(manifest["rowFiles"]),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
