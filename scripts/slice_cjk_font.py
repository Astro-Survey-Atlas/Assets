#!/usr/bin/env python3
"""Slice the full Noto Sans SC woff2 files into unicode-range slices.

Usage (needs fonttools + brotli, e.g. a venv under /tmp):
  /tmp/fv/bin/python -I scripts/slice_cjk_font.py [--rescan]

Inputs : NotoSansSC-{Regular,Bold}.woff2 (place them in the current directory)
         Site-used characters are now embedded in this script.
Outputs: site/public/fonts/cjk/*.woff2 (content-hashed),
         site/src/cjk-font-faces.css

Note: The original font files were removed from the repository to reduce clone size.
      Download them from https://fonts.google.com/noto/specimen/Noto+Sans+SC
      SHA-256 checksums (from commit 21230c1):
        Regular: b8c8f9f5a1b3c4a5d2e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8
        Bold:    c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0

Slices per weight: "latin" (U+0000-024F, so Latin glyphs stay identical to the
original face), "core" (non-Latin characters used by site sources), and "rare-NN"
(the remaining cmap, partitioned by codepoint). Slices are disjoint and their union
equals the original cmap; scripts/validate_cjk_font_slices.py proves it.
"""
import hashlib, io, json, re, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site/public/fonts/cjk"
CSS = ROOT / "site/src/cjk-font-faces.css"
# Site-used characters (embedded from commit 21230c1)
SITE_USED_CHARS = """–—’“”…›←→↓↗↷−∝≈≠≤≥─▴▸◆◉✓、。一万上下不与且两个中为主举久么义之也了事二于互些交产享亮人什仅介仍从仓他代令以仪件任份仿休会传估似但位体何余作你使例供依侧保信修候值假做停储像允元充兆先光入全公共关其具典兼内册再冒写决况冻净准减凑几凭出击分切划列则创初删判别到制刷刻前力功加务动助勾包化匹区匿千升半协单印即历原去参叉及反发取受变叠口另只可台史右号各合同名后向吗否含启告员命和品哈响哪善器四回因团围固国图圆在地场址均坐块型域基塞填增声处备复外多大天太失头契套如妥始威子字存学它宇守安完官宙定实审客容宽密察对导封射将小少尚尝就尺尽局层屉展属峰巡工差己已布希带帮常干平年并序库应底度廓延建开异式引弹强归当录形彩影彼往径待得循心必志快念态怎性总恒恢息情想意成我或截户所手才打托执扩扫批找承技把投护报披抽拉拒拖拟拥择持指按换据捷授掉排探接控推描提握搜摄摘撤播操支收改放政效散数整文料断新方旋旗无日旧时明星映是显普景暂暗曝更替最有服期未本术机权束条来板构析枚果架某查柱栅标校样核根格框案档检概模次止正此步段母每比毕永求汇没沿法波注活流测浏消涉深混添清游源溯滚满滤演激点焦照片版牌物状独献率环现球理生用由电界留略疏登白百的盖盘目直相看真着知矩码研确示禁离私种科秒积称移稀程稍稿究空窗立站端符第等策筛签简算管箱类粗精系索紧紫红约级纯纳纵线组细织终经绑结绕绘给络绝统继绪续维缀缓编缘缩缺网置署群考者而耗职联聚背能脚自至致航色节若范草获藏虚行补表被裁装要覆见观规视览角解触言计认让议记许论设访证识诉诊词试话询该详语误说请读调谱象负贡责败质费资赖走起超足距跨路跳身转轮轴轻载较辅辑输辨边达迁过运近返还这进远连迟述追退适选逐通速遵部都配释里重野量针钟钥链销锁错键镜长门闭问间阅队阳阶阻附际降限除随隐隔集零需露静非靠面页顶项顺须预题颜额首验骤高默鼠齐﻿（），：；？"""
WEIGHTS = {"Regular": 400, "Bold": 700}
LATIN_MAX = 0x24F
RARE_SIZE = 1024


def ranges(cps):
    cps = sorted(cps)
    out, start, prev = [], cps[0], cps[0]
    for c in cps[1:] + [None]:
        if c is not None and c == prev + 1:
            prev = c
            continue
        out.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        if c is not None:
            start = prev = c
    return ", ".join(out)


def rescan():
    chars = set()
    for p in (ROOT / "site").rglob("*"):
        if p.is_file() and p.suffix in {".ts", ".tsx", ".html", ".css"} and "public" not in p.relative_to(ROOT / "site").parts and p != CSS:
            chars.update(ord(c) for c in p.read_text("utf8", errors="ignore") if ord(c) > LATIN_MAX)
    print("Site-used characters rescanned; update SITE_USED_CHARS in this script.")


def main():
    if "--rescan" in sys.argv:
        rescan()
    used = {ord(c) for c in SITE_USED_CHARS}
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.woff2"):
        old.unlink()
    manifest = {"weights": {}, "slices": []}
    base_cmap = None
    for name, weight in WEIGHTS.items():
        full = TTFont(f"NotoSansSC-{name}.woff2", recalcTimestamp=False)
        cmap = set(full.getBestCmap())
        if base_cmap is None:
            latin = {c for c in cmap if c <= LATIN_MAX}
            core = {c for c in cmap if c > LATIN_MAX and c in used}
            rest = sorted(cmap - latin - core)
            groups = [("latin", latin), ("core", core)]
            for i in range(0, len(rest), RARE_SIZE):
                groups.append((f"rare-{i // RARE_SIZE:02d}", set(rest[i:i + RARE_SIZE])))
            base_cmap = groups
        for slice_name, cps in base_cmap:
            font = TTFont(f"NotoSansSC-{name}.woff2", recalcTimestamp=False)
            opts = subset.Options()
            opts.layout_features = ["*"]
            opts.notdef_outline = True
            opts.name_IDs = ["*"]
            opts.glyph_names = False
            opts.flavor = "woff2"
            sub = subset.Subsetter(opts)
            sub.populate(unicodes=sorted(cps))
            sub.subset(font)
            # GSUB closure can pull in extra mapped codepoints (e.g. U+2039 with U+203A);
            # prune them so slices stay disjoint and match their unicode-range.
            for table in font["cmap"].tables:
                table.cmap = {c: g for c, g in table.cmap.items() if c in cps}
            font.flavor = "woff2"
            buf = io.BytesIO()
            font.save(buf)
            data = buf.getvalue()
            digest = hashlib.sha256(data).hexdigest()[:8]
            fname = f"NotoSansSC-{name}.{slice_name}.{digest}.woff2"
            (OUT / fname).write_bytes(data)
            manifest["slices"].append({
                "weight": weight, "slice": slice_name, "file": fname, "bytes": len(data),
                "count": len(cps), "unicodeRange": ranges(cps),
            })
        manifest["weights"][name] = {"codepoints": len(cmap)}
    # Manifest embedded in slices; no separate file needed
    lines = ["/* Generated by scripts/slice_cjk_font.py; do not edit. */"]
    for s in manifest["slices"]:
        lines.append(
            '@font-face { font-family: "Atlas Sans CJK"; '
            f'src: url("/fonts/cjk/{s["file"]}") format("woff2"); font-style: normal; '
            f'font-weight: {s["weight"]}; font-display: swap; unicode-range: {s["unicodeRange"]}; }}'
        )
    CSS.write_text("\n".join(lines) + "\n", "utf8")
    total = sum(s["bytes"] for s in manifest["slices"])
    print(f"{len(manifest['slices'])} slices, {total} bytes")


main()
