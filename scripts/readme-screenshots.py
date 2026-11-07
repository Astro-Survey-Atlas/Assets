#!/usr/bin/env python3
"""Capture a candidate README hero from a running Assets site.

    ASSETS_PUBLIC_URL=http://127.0.0.1:5180 python3 scripts/readme-screenshots.py

Opens the dark atlas with DESI and Euclid at order 6. Read-only: it only opens a
public page and toggles client-side layers; it never calls a write endpoint.
Writes docs/images/home.capture.png so the committed, hand-taken home.png is
never overwritten; rename it yourself if you want to replace the hero.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = os.environ.get("ASSETS_PUBLIC_URL", "http://127.0.0.1:5180").rstrip("/")
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
VIEWPORT = {"width": 1440, "height": 900}
ATLAS_SURVEYS = ["desi", "euclid"]
HERO_ORDER_STEPS = 2  # O4 -> O6


def prime(page: Page) -> None:
    page.add_init_script(
        """try {
          localStorage.setItem('asa-theme', 'dark');
          localStorage.setItem('astro-survey-atlas.locale', 'en');
          localStorage.setItem('asa-atlas-guide-v1', 'done');
        } catch (_) {}"""
    )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / "home.capture.png"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport=VIEWPORT, color_scheme="dark")
        page = context.new_page()
        prime(page)
        page.goto(f"{BASE}/atlas/?guide=0")
        page.wait_for_selector("#coverage-scene[data-ready=true]", timeout=60000)
        page.locator("#coverage-layers-toggle").click()
        for survey in ATLAS_SURVEYS:
            toggle = page.locator(f'.coverage-survey-group[data-survey-id="{survey}"] .coverage-layer-toggle input[type="checkbox"]').first
            if toggle.count() and not toggle.is_checked():
                toggle.check()
                page.wait_for_timeout(600)
        page.locator("#coverage-layers-toggle").click()
        slider = page.locator("#coverage-display-order")
        slider.focus()
        for _ in range(HERO_ORDER_STEPS):
            slider.press("ArrowRight")
        page.evaluate("document.activeElement.blur()")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(4000)
        page.screenshot(path=str(target), animations="disabled")
        context.close()
        browser.close()
    print(f"{target.relative_to(OUT.parent.parent)}  {target.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
