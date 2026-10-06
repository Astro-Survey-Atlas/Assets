#!/usr/bin/env python3
"""Build an import package from captured AKARI FIS metadata, without FITS pixels."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import email.utils
import gzip
import hashlib
import html.parser
import io
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

import numpy as np
from astropy import units as u
from astropy.coordinates import FK5, ICRS, SkyCoord
from astropy.time import Time


SOURCE_ID = "akari-fis-allsky-native-images"
SOURCE_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
SURVEY_ID = "akari"
RELEASE_ID = "akari-fis"
DATASET_VERSION = "2.1"
REGION_COUNT = 1672
BANDS = ("N60", "WideS", "WideL", "N160")
BAND_KEYS = {"N60": "N60", "WideS": "WIDES", "WideL": "WIDEL", "N160": "N160"}
QUERY_COLUMNS = (
    "cntr,fname,band_name,file_type,ra,dec,equinox,naxis1,naxis2,ctype1,ctype2,"
    "crval1,crval2,crpix1,crpix2,cdelt1,cdelt2,crota2,ra1,dec1,ra2,dec2,ra3,dec3,ra4,dec4,hdu,access_estsize"
)
COUNTS_QUERY = "SELECT band_name, COUNT(*) AS n FROM akari.akari_images WHERE file_type='science' GROUP BY band_name ORDER BY band_name"
USER_AGENT = "Astro-Survey-Atlas-Assets metadata-only AKARI packager/1.0"
REGION_PATTERN = re.compile(r"^(?:l\d{3}\.\d{2}_b[+-]\d{2}\.\d{2}_ecl_6deg|ra\d{3}\.\d{2}_dec[+-]\d{2}\.\d{2}_(?:SEP|NEP)_6deg)$")


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


def captured_response(research_dir: Path, key: str, expected_url: str | None) -> tuple[bytes, dict[str, str], str]:
    receipt = json.loads((research_dir / f"{key}.json").read_text())
    body = (research_dir / f"{key}.raw").read_bytes()
    requested_url = urllib.parse.urlsplit(str(receipt.get("url", "")))
    final_url = urllib.parse.urlsplit(str(receipt.get("finalUrl", "")))
    if (receipt.get("key") != key or expected_url is not None and receipt.get("url") != expected_url
            or receipt.get("status") != 200 or receipt.get("bytes") != len(body) or receipt.get("sha256") != sha256(body)):
        raise ValueError(f"AKARI source capture receipt does not match its raw response: {key}")
    if (requested_url.scheme != "https" or not requested_url.hostname or requested_url.username or requested_url.password
            or final_url.scheme != "https" or final_url.hostname != requested_url.hostname or final_url.username or final_url.password):
        raise ValueError(f"AKARI source capture redirected outside its HTTPS publisher host: {key}")
    headers = {str(name).lower(): str(value) for name, value in receipt.get("headers", {}).items()}
    return body, headers, str(receipt["finalUrl"])


def tap_url(query: str) -> str:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "MAXREC": "2000", "QUERY": query}
    return SOURCE_URL + "?" + urllib.parse.urlencode(params)


def request(url: str, timeout: int = 120, retries: int = 3) -> tuple[bytes, int, str, dict[str, str]]:
    failure: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024:
                    raise ValueError("AKARI metadata response exceeded the evidence byte budget")
                return body, response.status, response.url, {key.lower(): value for key, value in response.headers.items()}
        except Exception as error:  # Retry transient network and upstream failures only.
            failure = error
            if getattr(error, "code", None) not in (None, 429, 500, 502, 503, 504):
                raise
            if attempt + 1 < retries:
                time.sleep(2 ** attempt)
    assert failure is not None
    raise failure


class Links(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            value = dict(attrs).get("href")
            if value:
                self.hrefs.add(value)


def parse_csv(body: bytes) -> list[dict[str, str]]:
    text = body.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if reader.fieldnames is None or "band_name" not in reader.fieldnames:
        raise ValueError("AKARI TAP result has no native image columns")
    return list(reader)


def transform_corners(row: dict[str, str]) -> tuple[list[list[float]], list[list[float]]]:
    j2000 = np.asarray([[float(row[f"ra{index}"]), float(row[f"dec{index}"])] for index in range(1, 5)], dtype=float)
    if not np.isfinite(j2000).all() or np.any(j2000[:, 0] < 0) or np.any(j2000[:, 0] >= 360) or np.any(j2000[:, 1] < -90) or np.any(j2000[:, 1] > 90):
        raise ValueError("AKARI TAP row contains invalid J2000 image-frame corners")
    sky = SkyCoord(ra=j2000[:, 0] * u.deg, dec=j2000[:, 1] * u.deg,
                   frame=FK5(equinox=Time("J2000"))).transform_to(ICRS())
    icrs = [[float(ra % 360), float(dec)] for ra, dec in zip(sky.ra.deg, sky.dec.deg)]
    return j2000.tolist(), icrs


def descriptor(root: Path, path: Path, ref: str, url: str) -> dict[str, object]:
    body = path.read_bytes()
    return {"ref": ref, "sha256": sha256(body), "sizeBytes": len(body), "url": url}


def package_capture(research_dir: Path, output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_root = output_dir / "metadata"
    normalized_root = output_dir / "normalized"
    rows_by_band: dict[str, list[dict[str, str]]] = {}
    pages = []
    metadata_documents: list[dict[str, object]] = []
    expected_regions: set[str] = set()

    def copy_capture(key: str, target_ref: str, expected_url: str | None) -> tuple[bytes, dict[str, str], str]:
        body, headers, final_url = captured_response(research_dir, key, expected_url)
        target = output_dir / target_ref
        immutable_write(target, body)
        metadata_documents.append({"ref": target_ref, "sha256": sha256(body), "sizeBytes": len(body), "url": final_url})
        receipt = json.loads((research_dir / f"{key}.json").read_text())
        receipt_body = (json.dumps({
            "schemaVersion": 1, "sourceCaptureKey": key, "requestUrl": receipt["url"],
            "finalUrl": final_url, "status": 200, "date": headers.get("date"),
            "contentType": headers.get("content-type"), "contentLength": int(headers.get("content-length", len(body))),
            "bytes": len(body), "sha256": sha256(body),
        }, sort_keys=True, indent=2) + "\n").encode()
        receipt_ref = f"metadata/receipts/{key}.json"
        receipt_path = output_dir / receipt_ref
        immutable_write(receipt_path, receipt_body)
        metadata_documents.append({"ref": receipt_ref, "sha256": sha256(receipt_body), "sizeBytes": len(receipt_body), "url": final_url})
        return body, headers, final_url

    region_url = "https://data.darts.isas.jaxa.jp/pub/akari/AKARI-FIS_Image_AllSky_Map_2.1/region_list.txt"
    region_body, _, _ = copy_capture("akariregionlist", "metadata/darts-region-list.txt", region_url)
    region_text = region_body.decode("utf-8-sig")
    for line in region_text.splitlines():
        fields = line.split()
        if fields and not fields[0].startswith("#") and REGION_PATTERN.fullmatch(fields[0]):
            expected_regions.add(fields[0])
    if len(expected_regions) != REGION_COUNT:
        raise ValueError("DARTS AKARI region list no longer contains the expected 1,672 native map regions")
    directory_membership = {}
    directory_keys = {"N60": "akariirsan60dir", "WideS": "akariirsanwidedir",
                      "WideL": "akariirsawidelldir", "N160": "akariirsan160dir"}
    for band in BANDS:
        directory_url = f"https://irsa.ipac.caltech.edu/data/AKARI/images/{band}/"
        key = directory_keys[band]
        body, _, _ = copy_capture(key, f"metadata/irsa-{band}-directory.html", directory_url)
        parser = Links()
        parser.feed(body.decode("utf-8", errors="replace"))
        listed = {Path(urllib.parse.urlsplit(link).path).name for link in parser.hrefs
                  if link.lower().endswith(f"_{band.lower()}_fixstripe.fits")}
        if len(listed) != REGION_COUNT:
            raise ValueError(f"IRSA AKARI {band} captured directory listed {len(listed)} source science FITS files; expected {REGION_COUNT}")
        directory_membership[band] = listed

    region_id_sets: dict[str, set[str]] = {}
    for band in BANDS:
        query_text = (f"SELECT {QUERY_COLUMNS} FROM akari.akari_images "
                      f"WHERE file_type='science' AND band_name='{band}' ORDER BY cntr")
        url = tap_url(query_text)
        key = f"akari-tap-science-{band}"
        body, headers, _ = copy_capture(key, f"metadata/tap-science-{band}.csv", url)
        rows = parse_csv(body)
        if len(rows) != REGION_COUNT:
            raise ValueError(f"IRSA TAP AKARI {band} returned {len(rows)} rows, expected {REGION_COUNT}")
        ref = f"metadata/tap-science-{band}.csv"
        counts = {}
        unique_rows = {}
        for row in rows:
            if "fname" not in row:
                raise ValueError(f"AKARI {band} image query has no source filename column")
            file_ref = row["fname"].strip()
            file_name = Path(file_ref).name
            file_match = re.fullmatch(r"(.+)_(N60|WideS|WideL|N160)_fixstripe\.fits", file_name)
            if (not file_match or file_ref != f"images/{band}/{file_name}" or row["band_name"] != band
                    or row["file_type"] != "science" or file_name not in directory_membership[band]
                    or int(row["hdu"]) != 0 or int(row["naxis1"]) != 1440 or int(row["naxis2"]) != 1440
                    or float(row["equinox"]) != 2000):
                raise ValueError(f"Invalid source-listed AKARI {band} science file: {file_ref}")
            region_id = file_match.group(1)
            if file_match.group(2) != band or region_id not in expected_regions or file_ref in unique_rows:
                raise ValueError(f"AKARI {band} source row has an invalid or duplicate region identity: {file_ref}")
            unique_rows[file_ref] = row
            counts[region_id] = counts.get(region_id, 0) + 1
        if set(unique_rows) != {f"images/{band}/{name}" for name in directory_membership[band]} or set(counts) != expected_regions:
            raise ValueError(f"AKARI {band} TAP rows do not match the DARTS region list and IRSA directory")
        rows_by_band[band] = rows
        region_id_sets[band] = set(counts)
        pages.append({"band": band, "ref": ref, "query": query_text, "status": 200, "queryStatus": "OK",
                      "capturedAt": headers.get("date"), "overflow": False, "rows": len(rows),
                      "sha256": sha256(body), "sizeBytes": len(body)})

    if any(region_id_sets[band] != expected_regions for band in BANDS):
        raise ValueError("AKARI per-band TAP maps do not share the exact source region set")

    # Recheck the row count after validating the frozen metadata pages.
    counts_url = tap_url(COUNTS_QUERY)
    counts_body, counts_status, counts_final, counts_headers = request(counts_url)
    if counts_status != 200 or counts_final != counts_url:
        raise ValueError("IRSA AKARI grouped science-map denominator could not be rechecked")
    counts_rows = parse_csv(counts_body)
    current_counts = {row["band_name"]: int(row["n"]) for row in counts_rows}
    if current_counts != {band: REGION_COUNT for band in BANDS}:
        raise ValueError("IRSA AKARI band denominators changed during metadata capture")
    count_ref = "metadata/tap-band-counts-after.csv"
    count_path = output_dir / count_ref
    immutable_write(count_path, counts_body)
    metadata_documents.append({"ref": count_ref, "sha256": sha256(counts_body), "sizeBytes": len(counts_body), "url": counts_final})
    count_receipt = {"query": COUNTS_QUERY, "requestUrl": counts_url, "finalUrl": counts_final, "status": counts_status,
                     "date": counts_headers.get("date"), "contentType": counts_headers.get("content-type"),
                     "contentLength": int(counts_headers.get("content-length", len(counts_body))),
                     "bytes": len(counts_body), "sha256": sha256(counts_body), "counts": current_counts}
    count_receipt_body = (json.dumps(count_receipt, sort_keys=True, indent=2) + "\n").encode()
    count_receipt_ref = "metadata/tap-band-counts-after-receipt.json"
    count_receipt_path = output_dir / count_receipt_ref
    immutable_write(count_receipt_path, count_receipt_body)
    metadata_documents.append({"ref": count_receipt_ref, "sha256": sha256(count_receipt_body), "sizeBytes": len(count_receipt_body), "url": counts_final})

    support = [
        ("akaridartsreadme", "darts-readme.txt", "https://data.darts.isas.jaxa.jp/pub/akari/AKARI-FIS_Image_AllSky_Map_2.1/ReadMe.txt"),
        ("akariirsareadme", "irsa-readme.txt", "https://irsa.ipac.caltech.edu/data/AKARI/documentation/ReadMe.txt"),
        ("akariirsatapcolumns", "tap-table-columns.vot", "https://irsa.ipac.caltech.edu/TAP/sync"),
        ("akaricds", "cds-color-record.json", "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FAKARI%2FFIS%2FColor&get=record&fmt=json"),
    ]
    for key, target_name, url in support:
        copy_capture(key, f"metadata/{target_name}", None if key == "akariirsatapcolumns" else url)

    normalized_path = normalized_root / "native-rows.ndjson.gz"
    normalized_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_rows = normalized_path.with_name(normalized_path.name + ".tmp")
    row_count = 0
    bands_summary = {}
    with temporary_rows.open("wb") as raw_rows, gzip.GzipFile(filename="", mode="wb", fileobj=raw_rows, mtime=0) as compressed:
        for band in BANDS:
            band_key = BAND_KEYS[band]
            bands_summary[band_key] = len(rows_by_band[band])
            for row in rows_by_band[band]:
                corners_j2000, corners_icrs = transform_corners(row)
                footprint = "POLYGON ICRS " + " ".join(f"{point[0]:.10f} {point[1]:.10f}" for point in corners_icrs)
                file_ref = row["fname"].strip()
                file_name = Path(file_ref).name
                region_id = re.sub(r"_(?:N60|WideS|WideL|N160)_fixstripe\.fits$", "", file_name)
                band_name = row["band_name"]
                filename = file_name
                band_code = BAND_KEYS[band_name]
                metadata = {
                    "regionId": region_id, "fileName": filename, "fileRef": file_ref,
                    "bandName": band_name, "fileType": "science", "datasetVersion": DATASET_VERSION,
                    "equinox": 2000, "coordinateFrame": "FK5(J2000)",
                    "geometrySource": "IRSA akari.akari_images four J2000 image-frame corners transformed to ICRS",
                    "geometryPrecision": "estimated", "validPixelMasksChecked": False,
                    "sourceCornersJ2000": corners_j2000, "cornersIcrs": corners_icrs, "footprint": footprint,
                    "dimensions": [int(row["naxis1"]), int(row["naxis2"])], "hdu": int(row["hdu"]),
                    "centerJ2000": [float(row["ra"]), float(row["dec"])],
                    "wcs": {key: row[key] for key in ("ctype1", "ctype2", "crval1", "crval2", "crpix1", "crpix2", "cdelt1", "cdelt2", "crota2")},
                    "accessSemantics": "source-listed individual whole science FITS; not a tar archive",
                    "availabilityEvidence": "TAP row and IRSA directory membership; individual file not probed",
                }
                output_row = {
                    "unitId": file_ref, "filename": filename, "sRegion": footprint, "bands": [band_code],
                    "accessUris": [{"sourceId": "irsa-akari-fis", "uri": f"https://irsa.ipac.caltech.edu/data/AKARI/{file_ref}",
                                    "fileName": filename, "accessType": "file", "band": band_code}],
                    "sourceMetadata": metadata,
                }
                compressed.write((json.dumps(output_row, sort_keys=True, separators=(",", ":")) + "\n").encode())
                row_count += 1
    if normalized_path.exists():
        if normalized_path.read_bytes() != temporary_rows.read_bytes():
            temporary_rows.unlink()
            raise ValueError(f"Refusing to replace different evidence: {normalized_path}")
        temporary_rows.unlink()
    else:
        temporary_rows.replace(normalized_path)
    if row_count != 4 * REGION_COUNT:
        raise ValueError("AKARI native-row export does not include all four source image bands")

    row_file = {"ref": "normalized/native-rows.ndjson.gz", "sha256": sha256(normalized_path.read_bytes()),
                "sizeBytes": normalized_path.stat().st_size, "rows": row_count}
    source_dates = [email.utils.parsedate_to_datetime(str(page["capturedAt"])) for page in pages if page.get("capturedAt")]
    if len(source_dates) != len(BANDS):
        raise ValueError("AKARI TAP source receipts are missing their HTTP capture dates")
    captured_at = max(source_dates).astimezone(dt.timezone.utc).isoformat()
    manifest = {
        "schemaVersion": 1, "adapter": "irsa-akari-fis-map", "surveyId": SURVEY_ID, "releaseId": RELEASE_ID,
        "capturedAt": captured_at, "coordinateFrame": "ICRS", "nativeCoordinateFrame": "FK5(J2000)",
        "ordering": "NESTED", "deliveryClass": "evidence", "queryPagesComplete": True,
        "inventoryComplete": True, "rowCount": row_count, "metadataDocuments": metadata_documents, "rowFiles": [row_file],
        "scope": {
            "table": "akari.akari_images", "datasetVersion": DATASET_VERSION, "regionCount": REGION_COUNT,
            "expectedRowCount": row_count, "fileType": "science", "validPixelMasksChecked": False,
            "bands": list(BANDS), "bandCounts": bands_summary,
            "nativeMapDatasetComplete": True, "allAkariObservationProductsComplete": False,
            "colorProductBands": ["N60", "WideS", "WideL"],
        },
        "sourcePagination": {
            "queryPagesComplete": True, "pages": pages, "regionListCount": REGION_COUNT,
            "directoryMembershipComplete": True, "denominatorsStable": True,
            "groupedCountAfter": {"status": counts_status, "queryStatus": "OK", "query": COUNTS_QUERY,
                                  "url": counts_final, "capturedAt": counts_headers.get("date"),
                                  "counts": current_counts, "sha256": sha256(counts_body), "sizeBytes": len(counts_body)},
        },
    }
    manifest_path = output_dir / "manifest.json"
    immutable_write(manifest_path, (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
    return {"manifest": str(manifest_path), "manifestSha256": sha256(manifest_path.read_bytes()),
            "rows": row_count, "regions": REGION_COUNT, "bandCounts": bands_summary,
            "normalizedRowsBytes": normalized_path.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-dir", type=Path, required=True, help="Directory containing captured IRSA/JAXA metadata")
    parser.add_argument("--output", type=Path, required=True, help="New or identical immutable evidence package directory")
    args = parser.parse_args()
    print(json.dumps(package_capture(args.research_dir, args.output), sort_keys=True))


if __name__ == "__main__":
    main()
