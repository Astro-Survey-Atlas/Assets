#!/usr/bin/env python3
"""Stage Gaia DR3 native partition metadata for a managed Assets import.

Only the official directory listing, checksum list and documentation are read.
Scientific catalog files are never requested, decoded or saved by this script.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


PREFIX = "Gaia/gdr3/gaia_source/"
CDN = "https://cdn.gea.esac.esa.int/"
LIST_ENDPOINT = "https://gaia.eu-1.cdn77-storage.com/"
NATIVE_ORDER = 8
LAST_PIXEL = 12 * 4 ** NATIVE_ORDER - 1
EXPECTED_FILES = 3386
MAX_METADATA_BYTES = 4 * 1024 * 1024
NS = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
FILENAME = re.compile(r"GaiaSource_(\d{6})-(\d{6})\.csv\.gz")
DOCUMENTS = {
    "directory-browser.html": CDN + "?" + urllib.parse.urlencode({"prefix": PREFIX}),
    "gaia-source-md5sum.txt": CDN + PREFIX + "_MD5SUM.txt",
    "release-readme.txt": CDN + "Gaia/gdr3/_readme.txt",
    "release-disclaimer.txt": CDN + "Gaia/gdr3/_disclaimer.txt",
    "release-license.txt": CDN + "Gaia/gdr3/_license.txt",
    "release-citation.txt": CDN + "Gaia/gdr3/_citation.txt",
    "bulk-download-rules.html": "https://www.cosmos.esa.int/web/gaia-users/archive/extract-data",
    "gaia-source-datamodel.html": (
        "https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/"
        "chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html"
    ),
    "gaia-data-license.html": "https://www.cosmos.esa.int/web/gaia-users/license",
    "release-scenario.html": "https://www.cosmos.esa.int/web/gaia/release",
}
ALLOWED_METADATA_URLS = set(DOCUMENTS.values())


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save_immutable(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f"Refusing to overwrite different captured metadata: {path}")
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def metadata_url_allowed(url):
    if url in ALLOWED_METADATA_URLS:
        return True
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query, strict_parsing=True)
    return (
        parts.scheme == "https"
        and parts.netloc == "gaia.eu-1.cdn77-storage.com"
        and parts.path == "/"
        and not parts.fragment
        and set(query) <= {"prefix", "delimiter", "marker"}
        and query.get("prefix") == [PREFIX]
        and query.get("delimiter") == ["/"]
        and ("marker" not in query or (
            len(query["marker"]) == 1 and query["marker"][0].startswith(PREFIX)
        ))
    )


class MetadataRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if not metadata_url_allowed(new_url):
            raise ValueError("Redirect leaves the explicit official metadata allowlist")
        return super().redirect_request(request, response, code, message, headers, new_url)


def capture(output, ref, url, timeout):
    if not metadata_url_allowed(url):
        raise ValueError("Scientific files and undeclared endpoints are forbidden")
    opener = urllib.request.build_opener(MetadataRedirects())
    request = urllib.request.Request(url, headers={
        "User-Agent": "Astro-Survey-Atlas-Assets/1.0 metadata-only native partition collector",
        "Accept-Encoding": "identity",
    })
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200 or not metadata_url_allowed(response.url):
            raise ValueError("Official metadata request did not return an allowed HTTP 200")
        declared_size = response.headers.get("Content-Length")
        if declared_size and int(declared_size) > MAX_METADATA_BYTES:
            raise ValueError("Declared metadata length exceeds the acquisition budget")
        body = response.read(MAX_METADATA_BYTES + 1)
        if len(body) > MAX_METADATA_BYTES:
            raise ValueError("Metadata response exceeds the acquisition budget")
        headers = {
            name.lower(): response.headers[name]
            for name in ("Content-Type", "ETag", "Last-Modified", "Content-Length")
            if name in response.headers
        }
        receipt = {
            "ref": ref, "url": url, "resolvedUrl": response.url,
            "capturedAt": now(), "status": response.status,
            "sha256": sha256(body), "sizeBytes": len(body), "headers": headers,
            "deliveryClass": "evidence", "tls": "chain-hostname-and-time-verified",
        }
    if ref.endswith(".txt") and (b"<!doctype html" in body[:200].lower() or b"<html" in body[:200].lower()):
        raise ValueError("Official plain metadata URL returned the directory HTML fallback")
    save_immutable(output / ref, body)
    return body, receipt


def list_source_files(output, timeout):
    marker, previous_key = "", ""
    entries, receipts = [], []
    for page in range(1, 17):
        query = {"prefix": PREFIX, "delimiter": "/"}
        if marker:
            query["marker"] = marker
        url = LIST_ENDPOINT + "?" + urllib.parse.urlencode(query)
        ref = f"metadata/listing-{page:03}.xml"
        body, receipt = capture(output, ref, url, timeout)
        document = ET.fromstring(body)
        if document.tag != f"{{{NS['s']}}}ListBucketResult":
            raise ValueError("The official file browser did not return an S3 directory listing")
        if document.findtext("s:Prefix", "", NS) != PREFIX:
            raise ValueError("Directory listing changed its table/release prefix")
        if document.findtext("s:Marker", "", NS) != marker:
            raise ValueError("Directory listing did not preserve the requested continuation marker")
        if document.findall("s:CommonPrefixes", NS):
            raise ValueError("Unexpected nested directory in the source-table roster")
        contents = document.findall("s:Contents", NS)
        for entry in contents:
            values = {name: entry.findtext(f"s:{name}", "", NS) for name in (
                "Key", "Size", "ETag", "LastModified",
            )}
            key = values["Key"]
            if not key.startswith(PREFIX) or key <= previous_key:
                raise ValueError("Directory keys are repeated, unordered or outside the source scope")
            previous_key = key
            filename = key[len(PREFIX):]
            if filename != "_MD5SUM.txt" and not FILENAME.fullmatch(filename):
                raise ValueError(f"Unsupported source-table metadata entry: {filename}")
            if not values["Size"].isdigit() or int(values["Size"]) <= 0:
                raise ValueError("Listed file has no positive size")
            entries.append({
                "filename": filename, "key": key, "sizeBytes": int(values["Size"]),
                "sourceEtag": values["ETag"], "lastModified": values["LastModified"],
            })
        truncated = document.findtext("s:IsTruncated", "", NS)
        next_marker = document.findtext("s:NextMarker", "", NS)
        receipt.update({
            "rowCount": len(contents), "requestedMarker": marker,
            "nextMarker": next_marker, "isTruncated": truncated == "true",
        })
        receipts.append(receipt)
        print(f"Gaia DR3 metadata listing page {page}: {len(contents)} objects", flush=True)
        if truncated == "false":
            if next_marker:
                raise ValueError("Terminal listing unexpectedly declares a continuation marker")
            return entries, receipts
        if truncated != "true" or not next_marker or next_marker <= marker or next_marker != previous_key:
            raise ValueError("Truncated directory listing has no valid advancing continuation marker")
        marker = next_marker
    raise ValueError("Directory listing exceeded the metadata pagination budget")


def parse_md5(body):
    checksums = {}
    for line in body.decode("utf-8").splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{32})\s+\*?(\S+)", line)
        if not match or match[2] in checksums:
            raise ValueError("Unsupported or duplicated checksum metadata row")
        if match[2] != "_MD5SUM.txt" and not FILENAME.fullmatch(match[2]):
            raise ValueError("Checksum manifest includes a file outside the source-table scope")
        checksums[match[2]] = match[1].lower()
    # The official manifest includes a self entry, which is not a science-file
    # checksum and is not used to authenticate the downloaded manifest itself.
    checksums.pop("_MD5SUM.txt", None)
    return checksums


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def document_text(body):
    parser = PlainText()
    parser.feed(body.decode("utf-8"))
    return " ".join(" ".join(parser.parts).lower().split())


def make_snapshot(entries, documents, listing, captured_at):
    bodies = {name: body for name, body, _ in documents}
    bulk = document_text(bodies["bulk-download-rules.html"])
    model = document_text(bodies["gaia-source-datamodel.html"])
    if not all(phrase in bulk for phrase in (
        "3386 ranges of healpix level-8", "gaiasource_000000-003111.csv.gz",
    )):
        raise ValueError("Official bulk-download documentation no longer confirms the locked O8 rule")
    if not all(phrase in model for phrase in (
        "equatorial (icrs)", "nested healpix scheme at level 12",
    )):
        raise ValueError("Official source-ID model no longer confirms ICRS/NESTED source positions")
    checksums = parse_md5(bodies["gaia-source-md5sum.txt"])
    files = []
    for entry in entries:
        match = FILENAME.fullmatch(entry["filename"])
        if not match:
            continue
        first, last = int(match[1]), int(match[2])
        if not 0 <= first <= last <= LAST_PIXEL:
            raise ValueError("Listed HEALPix range is outside native order 8")
        files.append({
            **entry,
            "unitId": entry["filename"].removesuffix(".csv.gz"),
            "firstIpix": first, "lastIpix": last,
            "url": CDN + entry["key"],
            "sourceMd5": checksums.get(entry["filename"]),
        })
    if set(checksums) != {file["filename"] for file in files}:
        raise ValueError("Directory and source checksum manifest do not contain the same catalog files")
    files.sort(key=lambda file: file["firstIpix"])
    if len(files) != EXPECTED_FILES:
        raise ValueError("Source-file count differs from the official DR3 partition rule")
    if files[0]["firstIpix"] != 0 or files[-1]["lastIpix"] != LAST_PIXEL:
        raise ValueError("Native partition roster does not span the complete declared O8 range")
    if any(a["lastIpix"] + 1 != b["firstIpix"] for a, b in zip(files, files[1:])):
        raise ValueError("Native partition ranges contain overlaps or uncovered intervals")
    return {
        "schemaVersion": 1, "adapter": "gaia-healpix-range",
        "surveyId": "gaia", "releaseId": "gaia-dr3", "capturedAt": captured_at,
        "coordinateFrame": "ICRS", "ordering": "NESTED", "nativeOrder": NATIVE_ORDER,
        "unitKind": "healpix-partition", "fileRosterComplete": True,
        "scienceContentVerified": False, "estimatedPosition": True,
        "metadataDocuments": [receipt for _, _, receipt in documents] + listing,
        "listing": {
            "endpoint": LIST_ENDPOINT, "prefix": PREFIX, "pageCount": len(listing),
            "complete": True, "terminalIsTruncated": False,
        },
        "scope": {
            "table": "gaiadr3.gaia_source", "fileCount": len(files),
            "fileRosterComplete": True, "scienceContentVerified": False,
            "estimatedPosition": True,
            "firstIpix": 0, "lastIpix": LAST_PIXEL,
            "rangeCellCount": LAST_PIXEL + 1,
            "listedScienceFileBytes": sum(file["sizeBytes"] for file in files),
            "catalogContentsDownloaded": False, "sourceChecksumsVerified": False,
            "otherGaiaTablesIncluded": False,
        },
        "provenance": {
            "partitionRuleUrl": DOCUMENTS["bulk-download-rules.html"] + "#bulk_download",
            "coordinateRuleUrl": DOCUMENTS["gaia-source-datamodel.html"] + "#source_id",
            "accessPolicyUrl": DOCUMENTS["gaia-data-license.html"],
            "license": "CC BY-NC 3.0 IGO",
        },
        "gaps": [
            "The exact O8 filename interval is a native catalog partition; it does not establish object presence throughout every cell.",
            "Gaia source IDs encode approximate ICRS positions. Boundary or moving-source scientific selection must use the Archive or catalog coordinates.",
            "Listed sizes, ETags and MD5 values are source metadata. No scientific file was downloaded or checksum-verified by Assets.",
            "Only the DR3 gaia_source table roster is complete in this input, not the full multi-table Gaia data release.",
        ],
        "files": files,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory for immutable metadata capture")
    parser.add_argument("--timeout", type=float, default=40, help="Per-metadata-request timeout in seconds (1 to 60)")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be between 1 and 60 seconds")
    captured_at = now()
    args.output.mkdir(parents=True, exist_ok=True)
    if (args.output / "gaia-dr3-partitions.json").exists():
        raise ValueError("Use a new output directory; captured source snapshots are immutable")
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            name: executor.submit(capture, args.output, f"metadata/{name}", url, args.timeout)
            for name, url in DOCUMENTS.items()
        }
        entries, listing = list_source_files(args.output, args.timeout)
        documents = [(name, *future.result()) for name, future in futures.items()]
    snapshot = make_snapshot(entries, documents, listing, captured_at)
    body = json_bytes(snapshot)
    save_immutable(args.output / "gaia-dr3-partitions.json", body)
    receipt = {
        "ref": "gaia-dr3-partitions.json", "sha256": sha256(body), "sizeBytes": len(body),
        "capturedAt": captured_at, "fileCount": len(snapshot["files"]),
        "metadataTransferredBytes": sum(document[2]["sizeBytes"] for document in documents) + sum(page["sizeBytes"] for page in listing),
        "scienceBytesTransferred": 0, "deliveryClass": "evidence",
    }
    save_immutable(args.output / "acquisition-receipt.json", json_bytes(receipt))
    print(json.dumps(receipt, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
