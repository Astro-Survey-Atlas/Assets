"""Read-only browser checks for the deployed admin presentation and status UI."""
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    base = os.environ.get("ASSETS_ADMIN_URL", "http://127.0.0.1:4199/admin/overview")
    screenshots = Path(os.environ.get("ASSETS_SCREENSHOT_DIR", "/tmp/asa-admin-visual"))
    screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=shutil.which("chromium") or shutil.which("chromium-browser"))
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        if urlsplit(base).hostname in ("127.0.0.1", "localhost"):
            page.route("**/api/v1/admin/connectors", lambda route: route.fulfill(json={"connectors": [
                {"name": f"fixture-{phase.lower()}", "type": "s3", "phase": phase, "endpoint": "https://storage.example", "bucket": "survey-data", "inventory": {"state": "unknown", "observedObjectCount": 1}}
                for phase in ("READY", "ERROR", "PENDING", "NOT_CHECKED")
            ]}))
        page.goto(base, wait_until="networkidle")
        page.locator("#admin-token").fill(os.environ.get("ASSETS_ADMIN_TOKEN", "admin-smoke-token"))
        page.locator("#login-form button[type=submit]").click()
        expect(page.locator("[data-survey-card]").first).to_be_visible()
        if urlsplit(base).hostname not in ("127.0.0.1", "localhost"):
            expect(page.locator("#admin-status")).not_to_contain_text("—")
        expect(page.locator(".admin-intro")).to_have_count(0)
        expect(page.locator(".admin-brand img")).to_be_visible()
        expect(page.locator("#overview-readiness-summary")).to_contain_text("L3")
        page.screenshot(path=str(screenshots / "overview-light.png"), full_page=True)
        card = page.locator('[data-survey-card="euclid"]')
        expect(card.locator(".survey-card-image")).to_be_visible()
        card_height = card.evaluate("el => el.getBoundingClientRect().height")
        assert card_height <= 150, card_height
        page.wait_for_function("() => { const el = document.querySelector('[data-survey-card=euclid] img'); return el && el.complete && el.naturalWidth > 0; }")
        card.click()
        expect(page.locator("#overview-back")).to_be_visible()
        page.locator("[data-overview-product]").first.click()
        expect(page.locator("#product-review-preflight")).to_be_visible()
        heading_size = page.locator("#product-review-preflight h4").evaluate("el => parseFloat(getComputedStyle(el).fontSize)")
        assert heading_size <= 14, heading_size
        blocking = page.locator(".preflight-item.is-blocking > svg").first
        pending = page.locator(".preflight-item.is-pending > svg").first
        if blocking.count() and pending.count():
            assert blocking.evaluate("el => getComputedStyle(el).color") != pending.evaluate("el => getComputedStyle(el).color"), "blocking and pending must have different colors"
        page.locator("#product-review-preflight").scroll_into_view_if_needed()
        page.screenshot(path=str(screenshots / "product-checks.png"))
        page.locator("#product-dialog-cancel").click()
        page.locator('[data-admin-step="sources"]').click()
        expect(page.locator(".connector-row").first).to_be_visible()
        connector = page.locator(".connector-row").first
        assert connector.locator(":scope > .connector-inventory").count() == 1
        assert connector.locator(".connector-row-copy .connector-inventory").count() == 0
        page.screenshot(path=str(screenshots / "connectors-light.png"), full_page=True)
        page.locator("#theme-toggle").click()
        page.screenshot(path=str(screenshots / "connectors-dark.png"), full_page=True)
        page.locator('[data-admin-step="overview"]').click()
        if page.locator("#overview-back").is_visible():
            page.locator("#overview-back").click()
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(screenshots / "overview-mobile.png"), full_page=True)
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "mobile overflow"
        assert not errors, errors
        browser.close()
    print(json.dumps({"passed": True, "cardHeight": card_height, "preflightHeadingSize": heading_size, "screenshots": str(screenshots)}))


if __name__ == "__main__":
    main()
