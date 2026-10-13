#!/usr/bin/env python3
"""Exercise homepage tab rotation in Chromium against the built site."""

import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get("ASSETS_HOMEPAGE_TEST_URL", "http://127.0.0.1:4173/")


def wait_for_site(process: subprocess.Popen[bytes]) -> None:
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError("Vite preview exited before becoming ready")
        try:
            with urllib.request.urlopen(URL, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.25)
    raise RuntimeError(f"Vite preview did not become ready at {URL}")


def selected_tab(page) -> str | None:
    return page.locator('[role="tab"][aria-selected="true"]').get_attribute("data-home-tab")


def main() -> None:
    process = subprocess.Popen(
        [str(ROOT / "node_modules/.bin/vite"), "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_site(process)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.clock.install()
            page.goto(URL, wait_until="domcontentloaded")
            tablist = page.locator('[role="tablist"]')
            expect(tablist).to_be_visible()
            expect(page.locator('[data-home-tab="overlap"]')).to_have_attribute("aria-selected", "true")
            assert selected_tab(page) == "overlap"

            root = page.locator("html")
            original_theme = root.get_attribute("data-theme")
            page.locator("[data-theme-toggle]").click()
            expect(root).not_to_have_attribute("data-theme", original_theme)
            page.locator("[data-theme-toggle]").click()
            expect(root).to_have_attribute("data-theme", original_theme)

            locale_toggle = page.locator("[data-locale-toggle]").first
            original_language = page.locator("html").get_attribute("lang")
            original_summary = page.locator("#workflow-title").inner_text()
            original_rotation_label = page.locator("[data-home-autoplay]").get_attribute("aria-label")
            locale_toggle.click()
            assert page.locator("html").get_attribute("lang") != original_language
            assert page.locator("#workflow-title").inner_text() != original_summary
            assert page.locator("[data-home-autoplay]").get_attribute("aria-label") != original_rotation_label
            locale_toggle.click()
            assert page.locator("html").get_attribute("lang") == original_language

            page.clock.run_for(5000)
            assert selected_tab(page) == "sources", "default rotation should advance after five seconds"
            assert page.locator("#workflow-panel").get_attribute("aria-live") is None

            workflow = page.locator(".home-workflow")
            workflow.hover()
            page.clock.run_for(6500)
            assert selected_tab(page) == "sources", "hover should suspend rotation"
            page.mouse.move(2, 2)
            page.clock.run_for(5000)
            assert selected_tab(page) == "coverage", "leaving hover should restart the five-second interval"

            page.locator('[data-home-tab="sources"]').click()
            page.mouse.move(2, 2)
            page.clock.run_for(4500)
            assert selected_tab(page) == "sources", "manual selection should reset the rotation interval"
            page.clock.run_for(500)
            assert selected_tab(page) == "coverage"

            rotation = page.locator("[data-home-autoplay]")
            rotation.click()
            expect(rotation).to_have_attribute("aria-pressed", "true")
            expect(rotation).to_have_attribute("aria-label", "Resume rotation")
            expect(rotation.locator("[data-i18n]")).to_have_text("Resume rotation")
            page.mouse.move(2, 2)
            page.clock.run_for(6000)
            assert selected_tab(page) == "coverage", "pause should stop rotation"
            rotation.click()
            expect(rotation).to_have_attribute("aria-pressed", "false")
            expect(rotation).to_have_attribute("aria-label", "Pause rotation")
            expect(rotation.locator("[data-i18n]")).to_have_text("Pause rotation")
            page.mouse.move(2, 2)
            page.clock.run_for(5000)
            assert selected_tab(page) == "overlap", "resume should restart the interval"

            for _ in range(40):
                page.keyboard.press("Tab")
                if page.locator("[data-home-tab]:focus-visible").count():
                    break
            assert page.locator("[data-home-tab]:focus-visible").count(), "keyboard focus should reach the tabs"
            focused_before = selected_tab(page)
            page.clock.run_for(6000)
            assert selected_tab(page) == focused_before, "keyboard focus should suspend rotation"
            page.evaluate("document.activeElement.blur()")
            page.clock.run_for(5000)
            assert selected_tab(page) != focused_before, "leaving keyboard focus should restart rotation"

            hidden_before = selected_tab(page)
            page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))")
            page.clock.run_for(6000)
            assert selected_tab(page) == hidden_before, "a hidden page should suspend rotation"
            page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))")
            page.clock.run_for(5000)
            assert selected_tab(page) != hidden_before, "a visible page should restart rotation"

            reduced = browser.new_page(viewport={"width": 390, "height": 844})
            reduced.emulate_media(reduced_motion="reduce")
            reduced.clock.install()
            reduced.goto(URL, wait_until="domcontentloaded")
            expect(reduced.locator('[data-home-tab="overlap"]')).to_have_attribute("aria-selected", "true")
            reduced.clock.run_for(6000)
            assert selected_tab(reduced) == "overlap", "rotation must stay disabled when reduced motion is preferred"
            prefers_reduced_motion = reduced.evaluate("window.matchMedia('(prefers-reduced-motion: reduce)').matches")
            assert prefers_reduced_motion
            reduced.locator("[data-home-autoplay]").click()
            assert reduced.locator("[data-home-autoplay]").get_attribute("aria-label") == "Pause rotation"
            assert reduced.locator("[data-home-autoplay]").get_attribute("aria-pressed") == "false", (
                "explicit resume must override reduced motion; "
                f"reducedMotion={prefers_reduced_motion}, "
                f"pressed={reduced.locator('[data-home-autoplay]').get_attribute('aria-pressed')}"
            )
            reduced.locator(".site-header").hover()
            reduced.evaluate("document.activeElement.blur()")
            reduced.clock.run_for(5000)
            assert selected_tab(reduced) == "sources", (
                "a user should be able to resume rotation explicitly; "
                f"selected={selected_tab(reduced)}, "
                f"pressed={reduced.locator('[data-home-autoplay]').get_attribute('aria-pressed')}, "
                f"focusVisible={reduced.locator(':focus-visible').count()}"
            )
            assert reduced.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "mobile layout should not scroll horizontally"
            reduced.close()
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    main()
