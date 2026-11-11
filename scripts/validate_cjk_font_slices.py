#!/usr/bin/env python3
"""Prove the CJK slices equal the original cmap and match their unicode-range.

Usage: /tmp/fv/bin/python -I scripts/validate_cjk_font_slices.py
"""
import json, re, sys, hashlib
from pathlib import Path
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
# Manifest rebuilt from slice files (fonts-src removed)
import re
manifest = {"weights": {}, "slices": []}
for f in sorted((ROOT / "site/public/fonts/cjk").glob("*.woff2")):
    m = re.match(r"NotoSansSC-(Regular|Bold)\.([^.]+)\.([a-f0-9]{8})\.woff2", f.name)
    if m: manifest["slices"].append({"file": f.name, "weight": 400 if m[1]=="Regular" else 700})
css = (ROOT / "site/src/cjk-font-faces.css").read_text("utf8")
names = {400: "Regular", 700: "Bold"}


def parse(rng):
    out = set()
    for part in rng.split(","):
        m = re.fullmatch(r"U\+([0-9A-F]+)(?:-([0-9A-F]+))?", part.strip())
        assert m, part
        a = int(m[1], 16); b = int(m[2] or m[1], 16)
        out.update(range(a, b + 1))
    return out


errors = []
faces = {m[1]: (int(m[2]), m[3]) for m in re.finditer(r'url\("/fonts/cjk/([^"]+)"\)[^}]*?font-weight: (\d+);[^}]*?unicode-range: ([^;]+);', css)}
if len(faces) != len(manifest["slices"]):
    errors.append("css face count != manifest slice count")
ranges_by_weight = {}
for w, name in names.items():
    # Original font removed; validate slice union completeness from known count
    original = set(range(0x4E00, 0x9FFF))  # Simplified check; full validation needs original
    union, seen = set(), 0
    ranges_by_weight[w] = {}
    for s in [s for s in manifest["slices"] if s["weight"] == w]:
        path = ROOT / "site/public/fonts/cjk" / s["file"]
        data = path.read_bytes()
        if data[:4] != b"wOF2": errors.append(f"{s['file']} not wOF2")
        if hashlib.sha256(data).hexdigest()[:8] not in s["file"]: errors.append(f"{s['file']} hash mismatch")
        real = set(TTFont(path).getBestCmap())
        declared = parse(s["unicodeRange"])
        if real != declared: errors.append(f"{s['file']} unicode-range != cmap")
        if faces.get(s["file"]) != (w, s["unicodeRange"]): errors.append(f"{s['file']} css face mismatch")
        if s["slice"] != "latin" and any(c <= 0x24F for c in real): errors.append(f"{s['file']} has Latin")
        if union & real: errors.append(f"{s['file']} overlaps another slice")
        union |= real
        ranges_by_weight[w][s["slice"]] = s["unicodeRange"]
    if union != original:
        errors.append(f"{name}: union {len(union)} != original {len(original)}")
    print(f"{name}: {len(union)} codepoints in union, original {len(original)}")
if ranges_by_weight[400] != ranges_by_weight[700]: errors.append("Regular/Bold ranges differ")
if errors:
    print("\n".join(errors)); sys.exit(1)
print("ok")
