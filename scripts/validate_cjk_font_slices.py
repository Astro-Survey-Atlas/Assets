#!/usr/bin/env python3
"""Validate CJK slices against reviewed metadata, without needing full fonts.

Run with -I and fonttools/brotli from requirements/fonts.lock. Optionally pass
--source-dir to also verify historical original bytes and their complete cmaps.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS = {"Regular": 400, "Bold": 700}
CMAP_ENCODING = "sorted-6hex-lf-v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def cmap_sha256(codepoints):
    """SHA256 of sorted unique codepoints, uppercase six-digit hex + LF, ASCII."""
    return sha256("".join(f"{c:06X}\n" for c in sorted(set(codepoints))).encode("ascii"))


def read_cmap(path):
    try:
        with TTFont(path, recalcTimestamp=False) as font:
            best = set(font.getBestCmap())
            mapped = set().union(*(set(t.cmap) for t in font["cmap"].tables if t.isUnicode()))
            require(best == mapped, f"{path.name}: inconsistent Unicode cmap tables")
            return best
    except Exception as error:
        raise ValueError(f"{path.name}: cannot decode cmap: {error}") from error


def ranges(codepoints):
    cps = sorted(codepoints)
    if not cps:
        return ""
    out, start, prev = [], cps[0], cps[0]
    for c in cps[1:] + [None]:
        if c is not None and c == prev + 1:
            prev = c
            continue
        out.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        if c is not None:
            start = prev = c
    return ", ".join(out)


def parse_ranges(value):
    codepoints = set()
    for part in value.split(","):
        match = re.fullmatch(r"U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?", part.strip())
        require(match is not None, f"invalid unicode-range: {part}")
        first, last = int(match[1], 16), int(match[2] or match[1], 16)
        require(0 <= first <= last <= 0x10FFFF, f"invalid unicode-range bounds: {part}")
        require(last < 0xD800 or first > 0xDFFF, f"surrogate unicode-range: {part}")
        current = set(range(first, last + 1))
        require(not codepoints & current, f"duplicate unicode-range: {part}")
        codepoints |= current
    return codepoints


def load_manifest(root):
    manifest = json.loads((root / "fonts-src/cjk-slices.json").read_text("utf8"))
    require(manifest["schemaVersion"] == 1, "unsupported font manifest schema")
    require(manifest["cmapEncoding"] == CMAP_ENCODING, "unsupported cmap fingerprint encoding")
    require(re.fullmatch(r"[0-9a-f]{40}", manifest["sourceCommit"]), "invalid original source commit")
    require(set(manifest["weights"]) == set(WEIGHTS), "manifest must describe both weights")
    for name, source in manifest["weights"].items():
        require(source["file"] == f"NotoSansSC-{name}.woff2", f"{name}: invalid original filename")
        for field in ("bytes", "codepoints"):
            require(isinstance(source[field], int) and source[field] > 0, f"{name}: invalid {field}")
        for field in ("sha256", "cmapSha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", source[field]), f"{name}: invalid {field}")
    require(bool(manifest["slices"]), "empty slice manifest")
    return manifest


def validate_sources(manifest, source_dir):
    """Check BOTH source byte hashes before decoding or producing any output."""
    for name, source in manifest["weights"].items():
        path = source_dir / source["file"]
        data = path.read_bytes()
        require(len(data) == source["bytes"], f"{name}: source size mismatch")
        require(sha256(data) == source["sha256"], f"{name}: source SHA256 mismatch")
    cmaps = {}
    for name, source in manifest["weights"].items():
        cmap = read_cmap(source_dir / source["file"])
        require(len(cmap) == source["codepoints"], f"{name}: source cmap count mismatch")
        require(cmap_sha256(cmap) == source["cmapSha256"], f"{name}: source cmap fingerprint mismatch")
        cmaps[name] = cmap
    require(cmaps["Regular"] == cmaps["Bold"], "source weight cmaps differ")
    return cmaps


def css_faces(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    blocks = re.findall(r"@font-face\s*\{([^{}]*)\}", css)
    require(not re.sub(r"@font-face\s*\{[^{}]*\}", "", css).strip(), "unexpected font CSS content")
    faces = {}
    for block in blocks:
        declarations = {}
        for entry in block.split(";"):
            if not entry.strip():
                continue
            key, value = entry.split(":", 1)
            key, value = key.strip(), value.strip()
            require(key not in declarations, f"duplicate CSS declaration: {key}")
            declarations[key] = value
        match = re.fullmatch(r'url\("/fonts/cjk/([^"/]+)"\) format\("woff2"\)', declarations.get("src", ""))
        require(match is not None, "invalid font CSS src")
        require(match[1] not in faces, f"duplicate CSS face: {match[1]}")
        faces[match[1]] = declarations
    return faces


def validate(root, source_dir=None):
    manifest = load_manifest(root)
    if source_dir is not None:
        validate_sources(manifest, source_dir)
    faces = css_faces((root / "site/src/cjk-font-faces.css").read_text("utf8"))
    slices = manifest["slices"]
    filenames = {s["file"] for s in slices}
    require(len(filenames) == len(slices), "duplicate slice filenames")
    directory = root / "site/public/fonts/cjk"
    actual_files = {p.name for p in directory.iterdir()}
    require(actual_files == filenames,
            f"slice file inventory mismatch: missing={sorted(filenames - actual_files)}, extra={sorted(actual_files - filenames)}")
    require(set(faces) == filenames, "CSS face inventory != manifest slices")
    unions = {w: set() for w in WEIGHTS.values()}
    groups = {w: {} for w in WEIGHTS.values()}
    names = {w: name for name, w in WEIGHTS.items()}
    for s in slices:
        filename, weight, group = s["file"], s["weight"], s["slice"]
        require(weight in names, f"{filename}: invalid weight")
        require(re.fullmatch(r"latin|core|rare-[0-9]{2,}", group), f"{filename}: invalid slice group")
        require(group not in groups[weight], f"{filename}: duplicate group")
        digest = s["sha256"]
        require(re.fullmatch(r"[0-9a-f]{64}", digest), f"{filename}: invalid SHA256")
        require(filename == f"NotoSansSC-{names[weight]}.{group}.{digest[:8]}.woff2", f"{filename}: filename hash mismatch")
        data = (directory / filename).read_bytes()
        require(data[:4] == b"wOF2", f"{filename}: not WOFF2")
        require(len(data) == s["bytes"], f"{filename}: size mismatch")
        require(sha256(data) == digest, f"{filename}: SHA256 mismatch")
        real = read_cmap(directory / filename)
        declared = parse_ranges(s["unicodeRange"])
        require(real == declared, f"{filename}: unicode-range != cmap")
        require(len(real) == s["count"], f"{filename}: cmap count mismatch")
        expected_face = {
            "font-family": '"Atlas Sans CJK"',
            "src": f'url("/fonts/cjk/{filename}") format("woff2")',
            "font-style": "normal", "font-weight": str(weight), "font-display": "swap",
            "unicode-range": s["unicodeRange"],
        }
        require(faces[filename] == expected_face, f"{filename}: CSS declaration mismatch")
        if group != "latin":
            require(all(c > 0x24F for c in real), f"{filename}: non-Latin slice has Latin")
        else:
            require(all(c <= 0x24F for c in real), f"{filename}: Latin slice has non-Latin")
        require(not unions[weight] & real, f"{filename}: overlaps another slice")
        unions[weight] |= real
        groups[weight][group] = s["unicodeRange"]
    for name, weight in WEIGHTS.items():
        source = manifest["weights"][name]
        union = unions[weight]
        require(len(union) == source["codepoints"], f"{name}: union cmap count mismatch")
        require(cmap_sha256(union) == source["cmapSha256"], f"{name}: union cmap fingerprint mismatch")
        print(f"{name}: {len(union)} codepoints, original cmap fingerprint verified")
    require(groups[400] == groups[700], "Regular/Bold ranges differ")
    print(f"ok: {len(slices)} slices; hashes, sizes, cmaps, CSS and disjoint original unions verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="project tree to validate")
    parser.add_argument("--source-dir", type=Path, help="optional directory containing historical original fonts")
    args = parser.parse_args()
    try:
        validate(args.root, args.source_dir)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"CJK validation failed: {error}\n")


if __name__ == "__main__":
    main()
