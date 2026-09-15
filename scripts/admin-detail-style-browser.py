"""Local read-only fixture checks for readiness badges and execution receipt styling."""
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    base = os.environ.get("ASSETS_ADMIN_URL", "http://127.0.0.1:4199/admin/overview")
    if urlsplit(base).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("Synthetic receipts must only run against a local server")
    shots = Path(os.environ.get("ASSETS_SCREENSHOT_DIR", "/tmp/asa-sep15-admin"))
    shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or shutil.which("chromium"))
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def products(route):
            data = route.fetch().json()
            for product in data["products"]:
                product["executionEvidence"] = [{
                    "executionId": "fixture-" + state, "revision": product["revision"], "stepId": "moc-build", "status": state,
                    "startedAt": "2026-09-14T09:26:26Z", "finishedAt": "2026-09-14T09:26:29Z", "tool": {"name": "MOC-Core-SDK"},
                    "checks": [{"id": "source-snapshot", "status": state}, {"id": "output-integrity", "status": "skipped"}],
                    "inputs": [{"label": "来源 MOC", "ref": "evidence/" + "long-path/" * 15, "sha256": "a" * 64}],
                    "outputs": [{"label": "校验结果", "ref": "output/query.json", "sha256": "b" * 64}],
                    **({"error": "示例：输出校验未通过"} if state == "failed" else {})
                } for state in ("passed", "failed", "running")]
            route.fulfill(json=data)

        page.route("**/api/v1/admin/products", products)
        page.goto(base)
        page.locator("#admin-token").fill(os.environ.get("ASSETS_ADMIN_TOKEN", "admin-smoke-token"))
        page.locator("#login-form button[type=submit]").click()
        card = page.locator('[data-survey-card="euclid"]')
        expect(card).to_be_visible()
        image = card.locator("img")
        assert image.evaluate("el => getComputedStyle(el).objectFit") == "contain"
        assert "grayscale" in image.evaluate("el => getComputedStyle(el).filter")
        card.hover()
        page.wait_for_timeout(250)
        assert image.evaluate("el => getComputedStyle(el).filter") == "none"
        card.click()
        expect(page.locator(".overview-product .product-modality svg").first).to_be_visible()
        expect(page.locator(".release-modalities .product-modality strong").first).to_be_visible()
        expect(page.locator(".publication-state.lifecycle-chip").first).to_be_visible()
        page.locator("[data-overview-product]").first.click()
        expect(page.locator(".execution-receipt")).to_have_count(3)
        receipt = page.locator(".execution-receipt").first
        expect(receipt).to_contain_text("执行版本未记录")
        expect(receipt).to_contain_text("耗时 3.0 秒")
        receipt.locator(".receipt-artifacts summary").first.click()
        expect(receipt.locator(".receipt-artifact").first).to_contain_text("a" * 64)
        receipt.scroll_into_view_if_needed()
        page.screenshot(path=str(shots / "receipts-light.png"))
        page.evaluate("document.documentElement.dataset.theme = 'dark'")
        page.screenshot(path=str(shots / "receipts-dark.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(shots / "receipts-mobile.png"))
        assert receipt.evaluate("el => el.scrollWidth <= el.clientWidth"), "receipt overflows with long references"
        assert not errors, errors
        browser.close()
    print("admin detail style browser passed: modality/badges/image/receipts/unknown-version/long-references/themes/mobile")


if __name__ == "__main__":
    main()
