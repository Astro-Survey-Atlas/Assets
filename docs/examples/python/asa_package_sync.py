#!/usr/bin/env python3
"""Astro Survey Atlas Assets — Resource Package sync client.

Standard library only (Python 3.9+). Downloads a release collection ZIP or a
pinned package version from an Assets deployment and verifies size + SHA-256
with an atomic temp-file rename.

Examples:
  # Show published releases and their packages
  python3 asa_package_sync.py --base https://astro.assets.dev.72602.space --list

  # Download the latest release collection ZIP (all packages of that release)
  python3 asa_package_sync.py --base https://astro.assets.dev.72602.space --out ./downloads

  # Download the latest release's DESI package at a pinned version
  python3 asa_package_sync.py --base https://astro.assets.dev.72602.space \
      --package public-desi-footprints@3.0.0 --out ./downloads
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

CHUNK = 1 << 20  # 1 MiB


def die(message: str, code: int = 1) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def http_get_json(base: str, path: str) -> dict:
    url = f"{base.rstrip('/')}{path}"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        die(f"GET {url} failed: HTTP {error.code} {error.reason.decode() if hasattr(error.reason, 'decode') else error.reason}")
    except urllib.error.URLError as error:
        die(f"GET {url} failed: {error.reason}")
    raise AssertionError("unreachable")


def pick_release(history: dict, release_arg: str) -> dict:
    releases = history.get("releases") or []
    if not releases:
        die("server returned no releases")
    if release_arg == "latest":
        latest_id = history.get("latestReleaseId")
        for entry in releases:
            if entry.get("releaseId") == latest_id:
                return entry
        return max(releases, key=lambda entry: entry.get("sequence", 0))
    for entry in releases:
        if entry.get("releaseId") == release_arg:
            return entry
    die(f"release not found: {release_arg}")


def pick_package(release: dict, package_arg: str) -> dict:
    if "@" in package_arg:
        package_id, _, version = package_arg.partition("@")
    else:
        package_id, version = package_arg, None
    matches = [p for p in release.get("packages", []) if p.get("id") == package_id]
    if not matches:
        available = ", ".join(sorted(p.get("id", "?") for p in release.get("packages", [])))
        die(f"package {package_id} not in release {release['releaseId']}. Available: {available}")
    if version is None:
        return max(matches, key=lambda p: p.get("version", ""))
    for package in matches:
        if package.get("version") == version:
            return package
    die(f"version {version} of {package_id} not in release {release['releaseId']}")


def download_verified(base: str, path: str, file_name: str, expected_size: int, expected_sha256: str, out_dir: str) -> str:
    url = f"{base.rstrip('/')}{path}"
    final_path = os.path.join(out_dir, file_name)
    digest = hashlib.sha256()
    received = 0
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=60) as response, tempfile.NamedTemporaryFile(
            dir=out_dir, delete=False, prefix=".part-"
        ) as temp:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                temp.write(chunk)
                digest.update(chunk)
                received += len(chunk)
            temp_path = temp.name
    except urllib.error.HTTPError as error:
        die(f"download failed: HTTP {error.code} for {url}")
    except urllib.error.URLError as error:
        die(f"download failed: {error.reason} for {url}")

    actual_sha = digest.hexdigest()
    if expected_size and received != expected_size:
        os.unlink(temp_path)
        die(f"size mismatch for {final_path}: expected {expected_size} bytes, got {received}")
    if expected_sha256 and actual_sha != expected_sha256:
        os.unlink(temp_path)
        die(f"sha256 mismatch for {final_path}: expected {expected_sha256}, got {actual_sha}")
    os.replace(temp_path, final_path)
    print(f"saved {final_path} ({received} bytes, sha256 {actual_sha[:16]}… verified)")
    return final_path


def list_releases(history: dict) -> None:
    latest_id = history.get("latestReleaseId")
    for entry in sorted(history.get("releases", []), key=lambda e: e.get("sequence", 0), reverse=True):
        marker = " [latest]" if entry.get("releaseId") == latest_id else ""
        print(f"{entry['releaseId']}{marker}")
        print(f"  sequence {entry.get('sequence')} · published {entry.get('releasedAt')} · bundle {entry.get('bundleId')}")
        collection = entry.get("collection")
        if collection:
            print(f"  collection {collection['sizeBytes']} bytes sha256 {collection['sha256'][:16]}…")
        for package in entry.get("packages", []):
            survey = package.get("survey", {}).get("displayName") or package.get("name", "?")
            print(f"  - {package['id']}@{package['version']}  {survey}  {package['sizeBytes']} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Astro Survey Atlas resource packages with hash verification.")
    parser.add_argument("--base", required=True, help="Assets base URL, e.g. https://astro.assets.dev.72602.space")
    parser.add_argument("--release", default="latest", help="Release id, or 'latest' (default)")
    parser.add_argument("--package", help="Package id or id@version; omit to download the release collection ZIP")
    parser.add_argument("--out", default=".", help="Output directory (created if missing)")
    parser.add_argument("--list", action="store_true", help="List releases and packages, download nothing")
    args = parser.parse_args()

    history = http_get_json(args.base, "/api/v1/releases")
    if args.list:
        list_releases(history)
        return

    os.makedirs(args.out, exist_ok=True)
    release = pick_release(history, args.release)
    if args.package:
        package = pick_package(release, args.package)
        download_verified(
            args.base,
            package["downloadUrl"],
            f"{package['id']}-{package['version']}.zip",
            package["sizeBytes"],
            package["sha256"],
            args.out,
        )
        return
    collection = release.get("collection")
    if not collection:
        die(f"release {release['releaseId']} has no collection archive; use --package <id>")
    download_verified(args.base, collection["downloadUrl"], collection["fileName"], collection["sizeBytes"], collection["sha256"], args.out)


if __name__ == "__main__":
    main()
