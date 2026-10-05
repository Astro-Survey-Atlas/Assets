#!/usr/bin/env python3
"""Capture bounded 2MASS 6X Atlas-image metadata; never fetch image pixels."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time
from astropy.wcs import WCS


SOURCE_URL = "https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia"
SURVEY_ID = "2mass"
RELEASE_ID = "2mass-6x"
REGION_SPECS = {
    "m31": {
        "sourceId": "2mass-6x-m31-1deg-atlas-images",
        "label": "M31",
        "position": "10.6847083,41.26875",
        "expectedRows": 138,
        "expectedCoadds": 46,
        "expectedBandCounts": {"J": 46, "H": 46, "K": 46},
    },
    "lmc": {
        "sourceId": "2mass-6x-lmc-1deg-atlas-images",
        "label": "LMC",
        "position": "80.894,-69.756",
        "expectedRows": 165,
        "expectedCoadds": 55,
        "expectedBandCounts": {"J": 55, "H": 55, "K": 55},
    },
}
QUERY_TEMPLATE = "ds=sx&POS={position}&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
VOTABLE_NS = "http://www.ivoa.net/xml/VOTable/v1.3"
REQUIRED_FIELDS = {
    "download", "naxis", "scale", "crpix", "crval", "crota2", "band", "type", "dataset",
    "pixflags", "date", "hem", "scan", "image", "coadd_key",
}


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


def request_bytes(url: str, timeout: int = 90) -> tuple[bytes, str, int]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/x-votable+xml",
        "User-Agent": "Astro-Survey-Atlas-Assets metadata-only 2MASS collector/1.0",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if response.status != 200 or len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("IRSA SIA response exceeded its HTTP or metadata-size contract")
        return body, response.url, response.status


def parse_votable(body: bytes) -> tuple[list[str], list[dict[str, str]]]:
    root = ET.fromstring(body)
    info = root.find(f".//{{{VOTABLE_NS}}}INFO[@name='QUERY_STATUS']")
    if info is None or info.get("value") != "OK":
        status = info.get("value") if info is not None else "missing"
        detail = (info.text or "").strip() if info is not None else ""
        raise ValueError(f"IRSA SIA QUERY_STATUS={status}: {detail}")
    if root.find(f".//{{{VOTABLE_NS}}}INFO[@name='QUERY_STATUS'][@value='OVERFLOW']") is not None:
        raise ValueError("IRSA SIA reported an overflowed result")
    table = root.find(f".//{{{VOTABLE_NS}}}TABLE")
    if table is None:
        raise ValueError("IRSA SIA response has no VOTable table")
    fields = [field.get("name", "").strip().lower() for field in table.findall(f"{{{VOTABLE_NS}}}FIELD")]
    if not REQUIRED_FIELDS.issubset(fields) or len(fields) != len(set(fields)):
        raise ValueError("IRSA SIA response is missing required 6X image/WCS fields")
    data = table.find(f"{{{VOTABLE_NS}}}DATA/{{{VOTABLE_NS}}}TABLEDATA")
    if data is None:
        raise ValueError("IRSA SIA response is not TABLEDATA")
    rows = []
    for tr in data.findall(f"{{{VOTABLE_NS}}}TR"):
        values = [(cell.text or "").strip() for cell in tr.findall(f"{{{VOTABLE_NS}}}TD")]
        if len(values) != len(fields):
            raise ValueError("IRSA SIA row width differs from its FIELD declaration")
        rows.append(dict(zip(fields, values)))
    return fields, rows


def numeric_vector(value: str, size: int, name: str) -> list[float]:
    try:
        values = [float(item) for item in value.split()]
    except ValueError as error:
        raise ValueError(f"Invalid 2MASS {name} vector") from error
    if len(values) != size or not all(math.isfinite(item) for item in values):
        raise ValueError(f"Invalid 2MASS {name} vector")
    return values


def normalize_row(values: dict[str, str]) -> dict:
    dataset = values["dataset"].strip().lower()
    date = values["date"].strip()
    hem = values["hem"].strip().lower()
    band = values["band"].strip().upper()
    try:
        scan = int(values["scan"])
        image = int(values["image"])
        coadd_key = int(values["coadd_key"])
        naxis = [int(item) for item in values["naxis"].split()]
        crota2 = float(values["crota2"])
    except ValueError as error:
        raise ValueError("Invalid 2MASS Atlas identity or WCS value") from error
    if dataset != "sx" or not re.fullmatch(r"\d{6}", date) or hem not in {"n", "s"} or not 0 <= scan <= 999 or not 0 <= image <= 9999:
        raise ValueError("2MASS row is outside the 6X scan/image identity contract")
    if band not in {"J", "H", "K"} or values["type"].strip().upper() != "A" or values["format"].strip().lower() != "image/fits":
        raise ValueError("2MASS row is not a 6X Catalog Atlas FITS image")
    if naxis[0] != 512 or not 1 <= naxis[1] <= 1024 or coadd_key < 0 or not math.isfinite(crota2):
        raise ValueError("Unsupported 2MASS Atlas dimensions, coadd identity or rotation")

    crpix = numeric_vector(values["crpix"], 2, "CRPIX")
    crval = numeric_vector(values["crval"], 2, "CRVAL")
    scale = numeric_vector(values["scale"], 2, "scale")
    if scale[0] >= 0 or scale[1] <= 0 or abs(scale[0]) > 0.001 or abs(scale[1]) > 0.001:
        raise ValueError("Unsupported 2MASS Atlas pixel scale")

    download = urllib.parse.urlsplit(values["download"].strip())
    query = urllib.parse.parse_qs(download.query, strict_parsing=True)
    scan_text = f"{scan:03d}"
    image_text = f"{image:04d}"
    source_name = f"{band.lower()}i{scan_text}{image_text}.fits"
    if download.scheme != "https" or download.hostname != "irsa.ipac.caltech.edu" or download.path != "/cgi-bin/2MASS/IM/nph-im" \
            or query.get("ds") != ["sx"] or query.get("atdir") != ["/ti09/6x"] or query.get("dh") != [f"{date}{hem}"] \
            or query.get("scan") != [scan_text] or query.get("name") != [source_name]:
        raise ValueError("2MASS source download locator disagrees with the native image identity")

    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---SIN", "DEC--SIN"]
    wcs.wcs.crval = crval
    wcs.wcs.crpix = crpix
    wcs.wcs.cdelt = scale
    wcs.wcs.crota = [0.0, crota2]
    wcs.wcs.set()
    pixel_edges = np.asarray([[0.5, 0.5], [naxis[0] + 0.5, 0.5], [naxis[0] + 0.5, naxis[1] + 0.5], [0.5, naxis[1] + 0.5]])
    fk5_edges = wcs.all_pix2world(pixel_edges, 1)
    if not np.isfinite(fk5_edges).all():
        raise ValueError("2MASS WCS produced non-finite frame edges")
    icrs_edges = SkyCoord(ra=fk5_edges[:, 0] * u.deg, dec=fk5_edges[:, 1] * u.deg,
                          frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    polygon = "POLYGON ICRS " + " ".join(
        f"{ra:.10f} {dec:.10f}" for ra, dec in zip(icrs_edges.ra.wrap_at(360 * u.deg).deg, icrs_edges.dec.deg)
    )
    unit_id = f"{date}{hem}/s{scan_text}/{image_text}/{band}"
    file_name = source_name + ".gz"
    direct_uri = f"https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/{date}{hem}/s{scan_text}/image/{file_name}"
    return {
        "unitId": unit_id,
        "sRegion": polygon,
        "bands": [band],
        "filename": file_name,
        "accessUris": [{"uri": direct_uri, "fileName": file_name, "accessType": "file", "band": band}],
        "sourceMetadata": {
            "dataset": dataset,
            "date": date,
            "hemisphere": hem,
            "scan": scan,
            "image": image,
            "coaddKey": coadd_key,
            "band": band,
            "type": "A",
            "pixflags": values["pixflags"].strip(),
            "sourceFrame": "FK5(J2000)",
            "projection": "RA---SIN/DEC--SIN",
            "geometrySource": "2MASS SIA WCS pixel-edge transform",
            "sourceWcs": {"naxis": naxis, "scaleDegPerPixel": scale, "crpixFits": crpix, "crvalDeg": crval, "crota2Deg": crota2},
            "originalDownload": values["download"].strip(),
            "accessSemantics": "whole-Atlas-image-fits-gzip",
        },
    }


def file_reference(root: Path, path: Path, url: str) -> dict:
    body = path.read_bytes()
    return {"ref": path.relative_to(root).as_posix(), "url": url, "sha256": sha256(body), "sizeBytes": len(body)}


def acquire(output: Path, timeout: int = 90, fetch=request_bytes, region: str = "m31") -> dict:
    if region not in REGION_SPECS:
        raise ValueError(f"Unsupported 2MASS capture region: {region}")
    spec = REGION_SPECS[region]
    position = urllib.parse.quote(spec["position"], safe="")
    query = QUERY_TEMPLATE.format(position=position)
    url = SOURCE_URL + "?" + query
    body, final_url, status = fetch(url, timeout)
    fields, source_rows = parse_votable(body)
    if status != 200 or urllib.parse.urlsplit(final_url).hostname != "irsa.ipac.caltech.edu":
        raise ValueError("IRSA SIA did not return the official metadata endpoint")
    expected_rows = int(spec["expectedRows"])
    if len(source_rows) != expected_rows:
        raise ValueError(f"Locked 2MASS {spec['label']} query expected {expected_rows} rows, source returned {len(source_rows)}")
    rows = [normalize_row(row) for row in source_rows]
    if len({row["unitId"] for row in rows}) != len(rows):
        raise ValueError("2MASS SIA response contains duplicate native band-image identities")
    bands = {band: sum(row["bands"] == [band] for row in rows) for band in ("J", "H", "K")}
    coadds = {row["sourceMetadata"]["coaddKey"] for row in rows}
    if bands != spec["expectedBandCounts"] or len(coadds) != spec["expectedCoadds"]:
        raise ValueError(f"Locked 2MASS {spec['label']} query no longer has its expected J/H/K Atlas images")

    output.mkdir(parents=True, exist_ok=False)

    metadata_path = output / "metadata/sia-response.votable.xml"
    immutable_write(metadata_path, body)
    metadata_file = file_reference(output, metadata_path, final_url)
    row_path = output / f"rows/{spec['sourceId']}.ndjson.gz"
    row_bytes = "".join(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n" for row in rows).encode("utf-8")
    immutable_write(row_path, gzip.compress(row_bytes, mtime=0))
    row_file = file_reference(output, row_path, final_url)
    captured = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schemaVersion": 1,
        "adapter": "twomass-6x-atlas",
        "surveyId": SURVEY_ID,
        "releaseId": RELEASE_ID,
        "capturedAt": captured,
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "inventoryComplete": False,
        "queryPagesComplete": True,
        "rowCount": len(rows),
        "scope": {
            "dataset": "sx",
            "region": region,
            "position": spec["position"],
            "sizeDeg": 1,
            "format": "image/fits",
            "maxRecords": 1000,
            "expectedRowCount": len(rows),
            "expectedBandCounts": spec["expectedBandCounts"],
            "atlasType": "A",
            "bands": ["J", "H", "K"],
            "coaddCount": len(coadds),
            "fullReleaseInventory": False,
            "sourceCoordinateFrame": "FK5(J2000)",
            "wcsProjection": "RA---SIN/DEC--SIN",
        },
        "sourcePagination": {
            "queryPagesComplete": True,
            "pageSize": 1000,
            "expectedRowCount": len(rows),
            "pages": [{"page": 1, "query": query, "url": final_url, "status": status, "queryStatus": "OK",
                       "overflow": False, "rows": len(rows), "sha256": metadata_file["sha256"], "sizeBytes": metadata_file["sizeBytes"]}],
        },
        "metadataDocuments": [metadata_file],
        "rowFiles": [{**row_file, "rows": len(rows)}],
    }
    manifest_path = output / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--region", choices=sorted(REGION_SPECS), default="m31")
    parser.add_argument("--timeout", default=90, type=int)
    args = parser.parse_args()
    manifest = acquire(args.output, timeout=args.timeout, region=args.region)
    print(f"Captured {manifest['rowCount']} 2MASS 6X Atlas band-images across {manifest['scope']['coaddCount']} coadds; inventoryComplete=false")


if __name__ == "__main__":
    main()
