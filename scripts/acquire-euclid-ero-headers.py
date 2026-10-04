#!/usr/bin/env python3
"""Stage official ERO XML and bounded FITS-header metadata for managed import.

Range requests skip scientific members' contents. Only tar headers, FITS header
cards and request receipts are saved; no image array is decoded or persisted.
"""
import argparse
import base64
import concurrent.futures
import datetime
import hashlib
from html.parser import HTMLParser
import json
import pathlib
import re
import ssl
import tarfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib

LANDING = "https://euclid.esac.esa.int/dr/ero/"
GEOMETRY = "https://sky.esa.int/esasky-tap/tap/sync"
BLOCK = 2880
MAX_HEADER = 256 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_metadata(url):
    with urllib.request.urlopen(url, timeout=40) as response:
        body = response.read(16 * 1024 * 1024 + 1)
        if response.status != 200 or len(body) > 16 * 1024 * 1024:
            raise ValueError("Official metadata exceeded the response budget")
        return body.decode("utf-8")


def landing_ids(document):
    class Links(HTMLParser):
        def __init__(self):
            super().__init__()
            self.ids = []

        def handle_starttag(self, tag, attrs):
            href = dict(attrs).get("href", "")
            url = urllib.parse.urljoin(LANDING, href)
            match = re.fullmatch(r"https://euclid\.esac\.esa\.int/dr/ero/(ERO-[A-Za-z0-9_-]+)/?", url)
            if tag == "a" and match:
                self.ids.append(match.group(1))
    links = Links()
    links.feed(document)
    return list(dict.fromkeys(links.ids))


class PackageHeaders:
    def __init__(self, target, url, output, allow_expired):
        self.target, self.url, self.output = target, url, output
        self.size = None
        self.etag = self.modified = None
        self.ranges = []
        self.context = ssl.create_default_context()
        if allow_expired:
            # OpenSSL X509_V_FLAG_NO_CHECK_TIME. Chain and hostname verification
            # remain enabled, scoped to this metadata collector's CDN requests.
            self.context.verify_flags |= 0x200000
        self.tls = "chain-and-hostname-verified" + ("; certificate-time-check-disabled" if allow_expired else "")

    def read_range(self, start, length):
        if length < 1 or length > 64 * 1024:
            raise ValueError("Invalid metadata byte-range budget")
        request = urllib.request.Request(self.url, headers={
            "Range": f"bytes={start}-{start + length - 1}", "Accept-Encoding": "identity",
            **({"If-Match": self.etag} if self.etag else {}),
        })
        with urllib.request.urlopen(request, context=self.context, timeout=40) as response:
            expected = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
            if response.status != 206 or response.url != self.url or not expected:
                raise ValueError("CDN must honor the exact metadata Range; full packages are refused")
            first, last, total = map(int, expected.groups())
            if first != start or last != start + length - 1 or (self.size is not None and total != self.size):
                raise ValueError("Package byte range or version changed during capture")
            etag, modified = response.headers.get("ETag"), response.headers.get("Last-Modified")
            if self.size is not None and (etag != self.etag or modified != self.modified):
                raise ValueError("Package validators changed during capture")
            self.size, self.etag, self.modified = total, etag, modified
            data = response.read(length + 1)
            if len(data) != length:
                raise ValueError("Incomplete metadata range")
        self.ranges.append({"start": start, "end": last, "sizeBytes": length, "sha256": sha(data)})
        return data

    def fits_header(self, offset, member):
        compressed = member.name.lower().endswith(".gz")
        inflater = zlib.decompressobj(31) if compressed else None
        header, used = bytearray(), 0
        while used < min(member.size, 64 * 1024):
            length = min(512 if compressed else BLOCK, member.size - used)
            data = self.read_range(offset + used, length)
            used += length
            # Stop decompression at each FITS header block before deciding
            # whether to advance. Never decode past the padded END block.
            pending = data
            while pending:
                header.extend(inflater.decompress(pending, BLOCK - len(header) % BLOCK) if inflater else pending)
                pending = inflater.unconsumed_tail if inflater else b""
                if len(header) % BLOCK == 0:
                    for position in range(max(0, len(header) - BLOCK), len(header), 80):
                        if header[position:position + 8] == b"END     ":
                            return bytes(header), used
                if len(header) >= MAX_HEADER:
                    raise ValueError("FITS header exceeds metadata budget")
        raise ValueError("No complete FITS header in bounded prefix")

    def capture(self):
        offset, roster, images = 0, [], []
        for _ in range(96):
            raw = self.read_range(offset, 512)
            if raw == bytes(512):
                break
            member = tarfile.TarInfo.frombuf(raw, "utf-8", "strict")
            if member.type in (tarfile.GNUTYPE_LONGNAME, tarfile.XHDTYPE, tarfile.XGLTYPE):
                raise ValueError("Unsupported extended tar header; retain evidence and add an explicit adapter")
            if member.size < 0 or offset + 512 + member.size > self.size:
                raise ValueError("Invalid tar member extent")
            roster.append({"name": member.name, "sizeBytes": member.size, "tarOffset": offset,
                           "tarHeaderBase64": base64.b64encode(raw).decode(), "tarHeaderSha256": sha(raw)})
            science = re.fullmatch(r"(?:.*/)?Euclid-(VIS|NISP-(Y|J|H|Chi2))-" + re.escape(self.target)
                                  + r"-Flattened\.DR3\.fits(?:\.gz)?", member.name, re.I)
            if member.isfile() and science:
                header, prefix_bytes = self.fits_header(offset + 512, member)
                images.append({"targetId": self.target, "packageUrl": self.url, "memberName": member.name,
                               "instrument": "VIS" if science.group(1).upper() == "VIS" else "NISP",
                               "filter": "VIS" if science.group(1).upper() == "VIS" else science.group(2).upper(),
                               "tarOffset": offset, "tarHeaderBase64": base64.b64encode(raw).decode(),
                               "header": header.decode("ascii"), "headerSha256": sha(header),
                               "compressedPrefixBytes": prefix_bytes})
            offset += 512 + ((member.size + 511) // 512) * 512
        else:
            raise ValueError("ERO package member roster exceeded metadata budget")
        if not images:
            raise ValueError("Package has no identity-verified flattened science-image header")
        receipt = {"targetId": self.target, "packageUrl": self.url, "capturedAt": now(), "tls": self.tls,
                   "packageSizeBytes": self.size, "etag": self.etag, "lastModified": self.modified,
                   "ranges": self.ranges, "members": roster, "fitsHeaders": images,
                   "precision": "estimated", "scope": "Image frame WCS only; no valid-pixel mask or scientific payload"}
        (self.output / (self.target + "-" + images[0]["instrument"] + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"target": self.target, "instrument": images[0]["instrument"], "frames": len(images),
                          "members": len(roster), "metadataRangeBytes": sum(x["sizeBytes"] for x in self.ranges)}), flush=True)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--allow-expired-certificate", action="store_true",
                        help="Record a CDN certificate-time exception; still verify its chain and hostname")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    landing = read_metadata(LANDING)
    ids = landing_ids(landing)
    if not ids or len(ids) > 100:
        raise ValueError("Official ERO landing does not identify a bounded target inventory")
    products, packages = [], []
    for target in ids:
        document = read_metadata(urllib.parse.urljoin(LANDING, target))
        tree = ET.fromstring(document)
        if tree.findtext("./dataitem/name") != target:
            raise ValueError("Official XML target identity disagrees")
        products.append({"id": target, "xml": document})
        urls = list(dict.fromkeys(node.attrib["href"] for node in tree.iter("a")
                                 if re.fullmatch(r"https://cdn\.euclid\.esac\.esa\.int/Stack/Euclid-(?:VIS|NISP)-Stack-"
                                                 + re.escape(target) + r"\.DR3\.tar", node.attrib.get("href", ""))))
        if len(urls) != 2:
            raise ValueError("Target must explicitly publish both instrument package URLs")
        packages.extend((target, url) for url in urls)
    query = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json",
                                   "QUERY": "SELECT TOP 200 id,object_name,title,stc_s FROM images.euclid_outreach"})
    geometry = read_metadata(GEOMETRY + "?" + query)
    snapshot = {"schemaVersion": 2, "kind": "euclid-ero-target-metadata", "capturedAt": now(),
                "sourceUrl": LANDING, "geometrySourceUrl": GEOMETRY, "landing": landing,
                "geometry": geometry, "products": products, "packageHeaders": []}
    # Keep staged XML even if one capture fails. Nothing is imported implicitly.
    (args.output / "xml-outreach-staging.json").write_text(json.dumps(snapshot) + "\n")
    def capture(pair):
        target, url = pair
        return PackageHeaders(target, url, args.output, args.allow_expired_certificate).capture()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        snapshot["packageHeaders"] = list(executor.map(capture, packages))
    snapshot["capturedAt"] = now()
    dest = args.output / "euclid-ero-target-metadata.json"
    data = (json.dumps(snapshot, ensure_ascii=False) + "\n").encode()
    dest.write_bytes(data)
    print(json.dumps({"path": str(dest), "targets": len(ids), "packages": len(packages),
                      "headers": sum(len(x["fitsHeaders"]) for x in snapshot["packageHeaders"]),
                      "sha256": sha(data), "sizeBytes": len(data)}), flush=True)


if __name__ == "__main__":
    main()
