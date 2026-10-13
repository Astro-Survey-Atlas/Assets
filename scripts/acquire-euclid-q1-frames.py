#!/usr/bin/env python3
"""Freeze released Q1 calibrated-image metadata, without reading science files.

The MER Tile roster remains separate. A calibrated frame has its own archive
identity and footprint; it must not be labelled as a MER Tile or a quadrant.
"""
import argparse
import csv
import datetime
import gzip
import hashlib
import io
import json
import time
from pathlib import Path
import urllib.parse
import urllib.request

import astropy.units as u
from astropy.coordinates import FK5, SkyCoord
from astropy.time import Time

ENDPOINT = "https://eas.esac.esa.int/tap-server/tap/sync"
COLUMNS = "calibrated_frame_oid,observation_id,pointing_id,file_name,file_path,datalabs_path,stc_s,data_set_release,instrument_name,filter_name,product_type"
SELECTOR = "data_set_release = 'Q1_R1'"


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fetch(query, proxy):
    url = ENDPOINT + "?" + urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query, "MAXREC": "10000"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy}) if proxy else urllib.request.ProxyHandler())
    for attempt in range(8):
        try:
            with opener.open(url, timeout=120) as response:
                body = response.read(16 * 1024 * 1024 + 1)
                if response.status != 200 or len(body) > 16 * 1024 * 1024:
                    raise ValueError("TAP metadata response exceeded its budget")
            rows = list(csv.DictReader(io.StringIO(body.decode("utf-8"))))
            if body.lstrip().startswith(b"<"):
                raise ValueError("TAP returned an error document instead of CSV")
            return body, rows, url
        except (OSError, TimeoutError):
            if attempt == 7:
                raise
            time.sleep(min(attempt + 1, 3))


def icrs_region(raw):
    tokens = raw.split()
    if len(tokens) < 8 or tokens[0].upper() != "POLYGON" or tokens[1].upper() not in ("ICRS", "J2000"):
        raise ValueError("Unsupported Q1 image footprint")
    numbers = [float(value) for value in tokens[2:]]
    if len(numbers) % 2 or any(not 0 <= x < 360 for x in numbers[::2]) or any(not -90 <= x <= 90 for x in numbers[1::2]):
        raise ValueError("Invalid Q1 polygon coordinates")
    points = SkyCoord(numbers[::2] * u.deg, numbers[1::2] * u.deg,
                      frame=FK5(equinox=Time("J2000")) if tokens[1].upper() == "J2000" else "icrs").icrs
    return "POLYGON ICRS " + " ".join(f"{ra:.12f} {dec:.12f}" for ra, dec in zip(points.ra.deg, points.dec.deg))


def normalize(row, page_ref, page_sha):
    oid, observation = row["calibrated_frame_oid"], row["observation_id"]
    filename, instrument = row["file_name"], row["instrument_name"]
    band = {"VIS": "VIS", "NIR_Y": "Y", "NIR_J": "J", "NIR_H": "H"}.get(row["filter_name"])
    if not oid.isdigit() or not observation.isdigit() or row["data_set_release"] != "Q1_R1" or band is None:
        raise ValueError("Unrelated Q1 calibrated image")
    if instrument not in ("VIS", "NISP") or not filename.startswith("EUC_") or not filename.endswith(".fits"):
        raise ValueError("Invalid archive image identity")
    return {"unitId": "Q1_R1:calibrated-frame:" + oid, "filename": filename, "instrument": instrument,
            "bands": [band], "sRegion": icrs_region(row["stc_s"]), "accessUris": [],
            "sourceMetadata": {**row, "nativeCoordinateFrame": row["stc_s"].split()[1], "coordinateFrame": "ICRS",
                               "metadataRef": page_ref, "metadataSha256": page_sha,
                               "entrypoint": "https://eas.esac.esa.int/", "geometryPrecision": "estimated",
                               "scienceFileScan": "not-scanned", "validPixelMasksChecked": False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--proxy", default="")
    args = parser.parse_args()
    root = args.output
    (root / "metadata").mkdir(parents=True, exist_ok=True)
    (root / "normalized").mkdir(exist_ok=True)
    documents, pages, normalized = [], [], []
    count_query = f"SELECT COUNT(*) AS total FROM q1.calibrated_frame WHERE {SELECTOR}"
    count_dest = root / "metadata/count.csv"
    if count_dest.exists():
        count_body = count_dest.read_bytes()
        count_rows = list(csv.DictReader(io.StringIO(count_body.decode())))
        count_url = ENDPOINT + "?" + urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": count_query, "MAXREC": "10000"})
    else:
        count_body, count_rows, count_url = fetch(count_query, args.proxy)
    total = int(count_rows[0]["total"])
    if not 0 < total < 100000:
        raise ValueError("Q1 source inventory exceeds the supported metadata scope")
    (root / "metadata/count.csv").write_bytes(count_body)
    documents.append({"ref": "metadata/count.csv", "sha256": sha(count_body), "sizeBytes": len(count_body), "url": count_url})
    last = -1
    for page in range(1, 1000):
        query = f"SELECT TOP 500 {COLUMNS} FROM q1.calibrated_frame WHERE {SELECTOR} AND calibrated_frame_oid > {last} ORDER BY calibrated_frame_oid"
        ref = f"metadata/page-{page:03d}.csv"
        dest = root / ref
        if dest.exists():
            body = dest.read_bytes()
            rows = list(csv.DictReader(io.StringIO(body.decode())))
            url = ENDPOINT + "?" + urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query, "MAXREC": "10000"})
        else:
            body, rows, url = fetch(query, args.proxy)
            dest.write_bytes(body)
        documents.append({"ref": ref, "sha256": sha(body), "sizeBytes": len(body), "url": url})
        ids = [int(row["calibrated_frame_oid"]) for row in rows]
        if ids != sorted(set(ids)) or ids and ids[0] <= last or len(rows) > 500:
            raise ValueError("Q1 keyset page is duplicated or unordered")
        pages.append({"page": page, "query": query, "status": 200, "rows": len(rows), "after": last, "ref": ref, "sha256": sha(body)})
        normalized.extend(normalize(row, ref, sha(body)) for row in rows)
        print(json.dumps({"page": page, "rows": len(rows), "accumulated": len(normalized), "expected": total}), flush=True)
        if not ids:
            break
        last = ids[-1]
    else:
        raise ValueError("Q1 pagination did not terminate")
    if len(normalized) != total:
        raise ValueError("Q1 capture does not match the declared source count; keep pages and retry")
    row_body = gzip.compress(("\n".join(json.dumps(row, separators=(",", ":")) for row in normalized) + "\n").encode(), mtime=0)
    (root / "normalized/frames.ndjson.gz").write_bytes(row_body)
    manifest = {"schemaVersion": 1, "deliveryClass": "evidence", "adapter": "euclid-image-metadata", "sourceId": "euclid-q1-calibrated-frames",
                "surveyId": "euclid", "releaseId": "euclid-q1", "coordinateFrame": "ICRS", "ordering": "NESTED",
                "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "inventoryComplete": False, "queryPagesComplete": True,
                "rowCount": total, "metadataDocuments": documents,
                "rowFiles": [{"ref": "normalized/frames.ndjson.gz", "rows": total, "sha256": sha(row_body), "sizeBytes": len(row_body)}],
                "sourcePagination": {"expectedRowCount": total, "queryPagesComplete": True, "pages": pages},
                "scope": {"release": "Q1_R1", "table": "q1.calibrated_frame", "geometryPrecision": "estimated", "scienceFileScan": "not-scanned", "validPixelMasksChecked": False},
                "gaps": ["euclid-q1-calibrated-frame-bounds-estimated", "euclid-q1-valid-pixel-masks-unverified", "euclid-q1-calibrated-file-access-entrypoint-only"]}
    data = (json.dumps(manifest, indent=2) + "\n").encode()
    (root / "manifest.json").write_bytes(data)
    print(json.dumps({"rows": total, "sha256": sha(data), "manifest": str(root / "manifest.json")}), flush=True)


if __name__ == "__main__":
    main()
