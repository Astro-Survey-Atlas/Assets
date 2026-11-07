#!/usr/bin/env python3
"""Capture the README screenshots from a running Assets site.

    ASSETS_PUBLIC_URL=http://127.0.0.1:5180 python3 scripts/readme-screenshots.py

Writes docs/images/ (captured at 2x, stored 1600 px wide; needs Pillow).
Read-only: it only opens public pages and toggles client-side layers; it never
calls a write endpoint.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = os.environ.get("ASSETS_PUBLIC_URL", "http://127.0.0.1:5180").rstrip("/")
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
VIEWPORT = {"width": 1440, "height": 900}
# Surveys that make a clear overlap picture on the atlas (all public layers).
ATLAS_SURVEYS = ["euclid", "desi", "legacy-surveys"]
README_WIDTH = 1600
PHOTO_SHOTS = {"home", "atlas", "atlas-overlap"}


def prime(page: Page, theme: str, locale: str = "en") -> None:
    page.add_init_script(
        f"""try {{
          localStorage.setItem('asa-theme', '{theme}');
          localStorage.setItem('astro-survey-atlas.locale', '{locale}');
          localStorage.setItem('asa-atlas-guide-v1', 'done');
        }} catch (_) {{}}"""
    )


def settle(page: Page, ms: int = 1200) -> None:
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)


def shoot(page: Page, name: str) -> Path:
    """Capture at 2x, then store at README width.

    Glow-heavy WebGL views (home, atlas) are saved as JPEG; flat UI pages as
    palette-quantised PNG. Both stay well under 400 KiB.
    """
    from PIL import Image

    OUT.mkdir(parents=True, exist_ok=True)
    raw = OUT / f".{name}.raw.png"
    page.screenshot(path=str(raw), animations="disabled")
    with Image.open(raw) as image:
        rgb = image.convert("RGB")
        rgb = rgb.resize((README_WIDTH, round(rgb.height * README_WIDTH / rgb.width)), Image.Resampling.LANCZOS)
        if name in PHOTO_SHOTS:
            target = OUT / f"{name}.jpg"
            rgb.save(target, quality=84, optimize=True, progressive=True, subsampling=0)
        else:
            target = OUT / f"{name}.png"
            rgb.quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(target, optimize=True)
    raw.unlink()
    return target


def atlas(page: Page) -> list[Path]:
    page.goto(f"{BASE}/atlas/?guide=0")
    page.wait_for_selector("#coverage-canvas", state="visible")
    settle(page, 2500)
    page.locator("#coverage-layers-toggle").click()
    page.wait_for_selector("#coverage-layers:not([hidden])")
    for survey in ATLAS_SURVEYS:
        toggle = page.locator(f'.coverage-survey-group[data-survey-id="{survey}"] .coverage-layer-toggle input[type="checkbox"]').first
        if toggle.count() and not toggle.is_checked():
            toggle.scroll_into_view_if_needed()
            toggle.check()
            page.wait_for_timeout(600)
    # Back to the compact roster so the sphere stays the subject.
    page.locator("#coverage-layers-toggle").click()
    settle(page, 3000)
    atlas_shot = shoot(page, "atlas")
    # Overlap view: G toggles common-area mode once two or more surveys are selected.
    page.locator("#coverage-canvas").click(position={"x": 40, "y": VIEWPORT["height"] - 40})
    page.keyboard.press("g")
    settle(page, 3000)
    overlap = shoot(page, "atlas-overlap")
    return [atlas_shot, overlap]


def main() -> int:
    written: list[Path] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for theme in ("dark", "light"):
            context = browser.new_context(viewport=VIEWPORT, device_scale_factor=2, color_scheme=theme)
            page = context.new_page()
            prime(page, theme)
            if theme == "dark":
                page.goto(f"{BASE}/")
                settle(page, 2500)
                written.append(shoot(page, "home"))
                written += atlas(page)
                page.goto(f"{BASE}/surveys/")
                settle(page)
                written.append(shoot(page, "surveys"))
            else:
                page.goto(f"{BASE}/releases/")
                settle(page)
                written.append(shoot(page, "releases-light"))
            context.close()
        browser.close()
    for path in written:
        print(f"{path.relative_to(OUT.parent.parent)}  {path.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
