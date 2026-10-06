#!/usr/bin/env python3
"""Package a metadata-only CDS ZTF DR7 progenitor capture for managed import."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import json
import re
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


SOURCE_ID = "ztf-dr7-cds-o3-reference-images"
SURVEY_ID = "ztf"
RELEASE_ID = "ztf-dr7"
BANDS = ("g", "r", "i")
EXPECTED_ROWS = {"g": 89292, "r": 95014, "i": 36043}
EXPECTED_UNIQUE = {"g": 65783, "r": 69959, "i": 26591}
EXPECTED_404 = {"g": 176, "r": 175, "i": 257}
USER_AGENT = "Astro-Survey-Atlas-Assets metadata evidence packager/1.0"
NAME_PATTERN = re.compile(r"^ztf_(\d{6})_z([gri])_c(0[1-9]|1[0-6])_q([1-4])_refimg$")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def write_immutable(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to replace different evidence: {path}")
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def parse_page(body: bytes, band: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for line in body.decode("utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        name = str(row.get("name", ""))
        match = NAME_PATTERN.fullmatch(name)
        ra = float(row["ra"])
        dec = float(row["dec"])
        tokens = str(row["stc"]).split()
        coordinates = [float(value) for value in tokens[2:]]
        if (not match or match.group(2) != band or not 0 <= ra < 360 or not -90 <= dec <= 90
                or tokens[:2] != ["POLYGON", "J2000"] or len(coordinates) != 8
                or any(not 0 <= value < 360 if index % 2 == 0 else not -90 <= value <= 90
                       for index, value in enumerate(coordinates))
                or not int(row["cellmem"]) > 0 or not row.get("path")):
            raise ValueError(f"Invalid ZTF DR7 progenitor record: {name}")
        rows.append({"name": name, "ra": ra, "dec": dec, "stc": " ".join(tokens),
                     "path": str(row["path"]), "corners": list(zip(coordinates[0::2], coordinates[1::2]))})
    return rows


def whole_file_uri(name: str) -> str:
    match = NAME_PATTERN.fullmatch(name)
    if not match:
        raise ValueError(f"Invalid ZTF reference-image identity: {name}")
    field, filter_code, ccd, quadrant = match.groups()
    filename = name + ".fits"
    return ("https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/"
            f"{field[:3]}/field{field}/z{filter_code}/ccd{int(ccd)}/q{quadrant}/{filename}")


def descriptor(root: Path, path: Path, ref: str, url: str) -> dict[str, object]:
    body = path.read_bytes()
    return {"ref": ref, "sha256": sha256(body), "sizeBytes": len(body), "url": url}


def package_capture(research_dir: Path, output_dir: Path) -> dict[str, object]:
    capture_dir = research_dir / "allsky-o3"
    research_path = capture_dir / "research-manifest.json"
    summary_path = capture_dir / "research-summary.json"
    research_bytes = research_path.read_bytes()
    research = json.loads(research_bytes)
    summary = json.loads(summary_path.read_text())
    if not research.get("captureComplete") or research.get("sourcePageCount") != 2304 or len(research.get("results", [])) != 2304:
        raise ValueError("Expected the complete 2,304-key CDS NESTED O3 metadata capture")
    if sha256(research_bytes) != summary.get("captureManifestSha256") or research["validation"].get("sciencePixelBytesFetched") != 0:
        raise ValueError("ZTF research-manifest hash or metadata-only boundary does not match its summary")

    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_root = output_dir / "metadata"
    normalized_root = output_dir / "normalized"
    write_immutable(metadata_root / "research-manifest.json", research_bytes)

    pending_rows: list[dict[str, object]] = []
    page_count = {band: {"ok": 0, "notFound": 0, "rows": 0} for band in BANDS}
    unique: dict[str, tuple[str, float, float]] = {}
    page_bundle_path = metadata_root / "page-evidence.ndjson.gz"
    page_bundle_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_page_bundle = page_bundle_path.with_name(page_bundle_path.name + ".tmp")
    with temporary_page_bundle.open("wb") as raw_bundle, gzip.GzipFile(filename="", mode="wb", fileobj=raw_bundle, mtime=0) as compressed:
        for page_index, result in enumerate(research["results"]):
            band_index = page_index // 768
            ipix = page_index % 768
            band = BANDS[band_index]
            expected_url = f"https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_{band}/HpxFinder/Norder3/Dir0/Npix{ipix}"
            if (result.get("band") != band or result.get("order") != 3 or result.get("ipix") != ipix
                    or result.get("url") != expected_url or result.get("finalUrl") != expected_url):
                raise ValueError("Research capture is not in canonical band/NESTED O3 key order")

            page_row: dict[str, object] = {key: value for key, value in result.items() if key != "bodyBase64"}
            page_row["bodyBase64"] = ""
            if result["status"] == 200:
                response_path = capture_dir / band / f"Npix{ipix}.jsonl"
                receipt_path = capture_dir / band / f"Npix{ipix}.receipt.json"
                response = response_path.read_bytes()
                receipt = json.loads(receipt_path.read_text())
                if (sha256(response) != result.get("sha256") or len(response) != result.get("bytes")
                        or sha256(response) != receipt.get("sha256") or receipt.get("rowCount") != result.get("rowCount")):
                    raise ValueError(f"ZTF source page changed or disagrees with its capture receipt: {band}/{ipix}")
                page_rows = parse_page(response, band)
                if len(page_rows) != result.get("rowCount"):
                    raise ValueError(f"ZTF source page row count differs from its receipt: {band}/{ipix}")
                page_row["bodyBase64"] = base64.b64encode(response).decode("ascii")
                page_count[band]["ok"] += 1
                page_count[band]["rows"] += len(page_rows)
                for row in page_rows:
                    prior = unique.get(str(row["name"]))
                    identity = (str(row["stc"]), float(row["ra"]), float(row["dec"]))
                    if prior and prior != identity:
                        raise ValueError(f"Conflicting ZTF duplicate footprint: {row['name']}")
                    unique.setdefault(str(row["name"]), identity)
                    pending_rows.append({**row, "band": band, "pageIpix": ipix,
                                         "pageUrl": expected_url, "pageSha256": result["sha256"]})
            elif result["status"] == 404:
                receipt_path = capture_dir / band / f"Npix{ipix}.receipt.json"
                receipt = json.loads(receipt_path.read_text())
                if (receipt.get("status") != 404 or result.get("rowCount", 0) != 0
                        or receipt.get("sha256") != result.get("sha256") or receipt.get("bytes") != result.get("bytes")):
                    raise ValueError(f"ZTF absent page is not backed by its 404 receipt: {band}/{ipix}")
                page_count[band]["notFound"] += 1
            else:
                raise ValueError(f"ZTF capture contains an unresolved HTTP status: {band}/{ipix}")
            compressed.write((json.dumps(page_row, sort_keys=True, separators=(",", ":")) + "\n").encode())
    if page_bundle_path.exists():
        if page_bundle_path.read_bytes() != temporary_page_bundle.read_bytes():
            temporary_page_bundle.unlink()
            raise ValueError(f"Refusing to replace different evidence: {page_bundle_path}")
        temporary_page_bundle.unlink()
    else:
        temporary_page_bundle.replace(page_bundle_path)

    if sum(x["rows"] for x in page_count.values()) != 220349 or len(unique) != 162333:
        raise ValueError("ZTF capture does not match its reviewed 220,349-row / 162,333-image summary")
    for band in BANDS:
        if (page_count[band]["rows"] != EXPECTED_ROWS[band]
                or len({name for name in unique if name.startswith("ztf_") and f"_z{band}_" in name}) != EXPECTED_UNIQUE[band]
                or page_count[band]["notFound"] != EXPECTED_404[band]):
            raise ValueError(f"ZTF {band}-band page totals do not match the reviewed capture")

    # Transform the 220k source frame vertices in vectorized batches; no pixels are opened.
    source_ras = np.asarray([coordinate[0] for row in pending_rows for coordinate in row["corners"]], dtype=float)
    source_decs = np.asarray([coordinate[1] for row in pending_rows for coordinate in row["corners"]], dtype=float)
    icrs = SkyCoord(ra=source_ras * u.deg, dec=source_decs * u.deg, frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    output_rows = normalized_root / "native-rows.ndjson.gz"
    output_rows.parent.mkdir(parents=True, exist_ok=True)
    temporary_rows = output_rows.with_name(output_rows.name + ".tmp")
    with temporary_rows.open("wb") as raw_rows, gzip.GzipFile(filename="", mode="wb", fileobj=raw_rows, mtime=0, compresslevel=1) as compressed:
        for index, row in enumerate(pending_rows):
            points = []
            for corner in range(4):
                offset = index * 4 + corner
                points.append([float(icrs.ra.deg[offset] % 360), float(icrs.dec.deg[offset])])
            footprint = "POLYGON ICRS " + " ".join(f"{ra:.10f} {dec:.10f}" for ra, dec in points)
            name = str(row["name"])
            match = NAME_PATTERN.fullmatch(name)
            assert match is not None
            band = str(row["band"])
            band_name = {"g": "G", "r": "R", "i": "I"}[band]
            filename = name + ".fits"
            page_url = str(row["pageUrl"])
            metadata = {
                "sourceName": name, "field": match.group(1), "filterCode": "z" + match.group(2),
                "ccd": int(match.group(3)), "quadrant": int(match.group(4)),
                "nativeIdentityKind": "reference-image CCD quadrant", "pageOrder": 3, "pageIpix": row["pageIpix"],
                "pageBand": band, "pageUrl": page_url, "pageResponseSha256": row["pageSha256"],
                "generatorPath": row["path"], "sourceStc": row["stc"], "sourceCenterRa": row["ra"], "sourceCenterDec": row["dec"],
                "coordinateFrame": "FK5(J2000)", "geometrySource": "CDS DR7 HpxFinder J2000 image frame transformed to ICRS",
                "geometryPrecision": "estimated", "validPixelMasksChecked": False,
                "transformation": "Astropy FK5(equinox=J2000) to ICRS", "cornersIcrs": points, "footprint": footprint,
            }
            output = {
                "unitId": name, "filename": filename, "sRegion": footprint, "bands": [band_name],
                "accessUris": [{"sourceId": "irsa-ztf-reference-images", "uri": whole_file_uri(name),
                                "fileName": filename, "accessType": "file", "band": band_name}],
                "sourceMetadata": metadata,
            }
            compressed.write((json.dumps(output, separators=(",", ":")) + "\n").encode())
    if output_rows.exists():
        if output_rows.read_bytes() != temporary_rows.read_bytes():
            temporary_rows.unlink()
            raise ValueError(f"Refusing to replace different evidence: {output_rows}")
        temporary_rows.unlink()
    else:
        temporary_rows.replace(output_rows)

    evidence_files = []
    for source_name, target_name, url in [
        ("cds-g-record.txt", "g-record.json", "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fg&get=record&fmt=json"),
        ("cds-r-record.txt", "r-record.json", "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fr&get=record&fmt=json"),
        ("cds-i-record.txt", "i-record.json", "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fi&get=record&fmt=json"),
        ("hpx-metadata.txt", "g-metadata.xml", "https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/metadata.xml"),
        ("hpx-r-metadata.txt", "r-metadata.xml", "https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_r/HpxFinder/metadata.xml"),
        ("hpx-i-metadata.txt", "i-metadata.xml", "https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_i/HpxFinder/metadata.xml"),
    ]:
        source_path = research_dir / source_name
        target_path = metadata_root / target_name
        if not source_path.is_file():
            raise ValueError(f"Required source mapping evidence is missing: {source_path}")
        write_immutable(target_path, source_path.read_bytes())
        evidence_files.append({"ref": f"metadata/{target_name}", "sha256": sha256(target_path.read_bytes()),
                               "sizeBytes": target_path.stat().st_size, "url": url})

    doc_files = [
        {"ref": "metadata/research-manifest.json", "sha256": sha256(research_bytes), "sizeBytes": len(research_bytes), "url": "https://alasky.cds.unistra.fr/ZTF/DR7/"},
        {"ref": "metadata/page-evidence.ndjson.gz", "sha256": sha256(page_bundle_path.read_bytes()), "sizeBytes": page_bundle_path.stat().st_size, "url": "https://alasky.cds.unistra.fr/ZTF/DR7/"},
        *evidence_files,
    ]
    rows_descriptor = {"ref": "normalized/native-rows.ndjson.gz", "sha256": sha256(output_rows.read_bytes()),
                       "sizeBytes": output_rows.stat().st_size, "rows": len(pending_rows)}
    manifest = {
        "schemaVersion": 1, "adapter": "cds-ztf-progenitor-o3", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": research["capturedAt"], "coordinateFrame": "ICRS", "nativeCoordinateFrame": "FK5(J2000)",
        "ordering": "NESTED", "deliveryClass": "evidence", "queryPagesComplete": True,
        "inventoryComplete": False, "rowCount": len(pending_rows), "metadataDocuments": doc_files, "rowFiles": [rows_descriptor],
        "scope": {
            "publisherProduct": "CDS/P/ZTF/DR7", "progenitorOrder": 3, "keyCount": 2304,
            "http200Pages": 1696, "http404Pages": 608, "inputRows": 220349,
            "uniqueReferenceImages": 162333, "duplicateRows": 58016,
            "historicalReleaseInventoryComplete": False, "directFileSource": "IRSA ZTF products/ref",
            "validPixelMasksChecked": False, "bands": ["g", "r", "i"],
            "fileCounts": {"G": 65783, "R": 69959, "I": 26591},
            "inputCaptureSha256": summary["captureManifestSha256"],
            "sourceSnapshotMeaning": "complete served CDS DR7 O3 progenitor metadata, not a frozen complete IRSA DR7 file inventory",
        },
        "sourcePagination": {
            "queryPagesComplete": True, "requestedKeys": 2304, "http200Pages": 1696, "http404Pages": 608,
            "failedPages": 0, "inputRows": 220349, "uniqueReferenceImages": 162333,
            "researchManifestSha256": sha256(research_bytes),
            "bandCounts": {band: {"pages": 768, "http200": 768 - EXPECTED_404[band], "http404": EXPECTED_404[band],
                                  "rows": EXPECTED_ROWS[band], "uniqueImages": EXPECTED_UNIQUE[band]} for band in BANDS},
        },
    }
    manifest_path = output_dir / "manifest.json"
    write_immutable(manifest_path, (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
    return {"manifest": str(manifest_path), "manifestSha256": sha256(manifest_path.read_bytes()),
            "rowCount": len(pending_rows), "uniqueReferenceImages": len(unique), "pageBytes": page_bundle_path.stat().st_size,
            "normalizedRowsBytes": output_rows.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-dir", type=Path, required=True, help="Directory containing the metadata-only allsky-o3 capture")
    parser.add_argument("--output", type=Path, required=True, help="New or identical immutable evidence package directory")
    args = parser.parse_args()
    print(json.dumps(package_capture(args.research_dir, args.output), sort_keys=True))


if __name__ == "__main__":
    main()
