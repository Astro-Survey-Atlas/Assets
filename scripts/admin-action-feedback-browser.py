"""Local intercepted review/publish regression; never publishes real products."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect


async def main():
    base = os.environ.get("ASSETS_ADMIN_URL", "http://127.0.0.1:4199")
    if urlsplit(base).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("Action fixtures must run on a local disposable server")
    shots = Path(os.environ.get("ASSETS_SCREENSHOT_DIR", "/dev/shm/asa-action-feedback"))
    shots.mkdir(parents=True, exist_ok=True)
    reviewed = set()
    publish_calls = []
    release_publish = asyncio.Event()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "/snap/chromium/current/usr/lib/chromium-browser/chrome"))
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        async def route_products(route):
            data = await (await route.fetch()).json()
            for product in data["products"]:
                product["published"] = None
                product["review"] = {"revision": product["revision"]} if product["productId"] in reviewed else None
                product["readiness"]["draft"]["gaps"] = ["completeness-unknown"]
            await route.fulfill(json=data)

        async def route_surveys(route):
            data = await (await route.fetch()).json()
            for survey in data["surveys"]:
                for release in survey["releases"]:
                    for product in release["products"]:
                        product["review"] = {"state": "reviewed" if product["productId"] in reviewed else "draft"}
            await route.fulfill(json=data)

        async def route_review(route):
            reviewed.add(urlsplit(route.request.url).path.split("/")[-2])
            await asyncio.sleep(.2)
            await route.fulfill(json={"ok": True})

        async def route_publish(route):
            publish_calls.append(route.request.url)
            await release_publish.wait()
            await route.fulfill(status=503 if len(publish_calls) == 1 else 200, json={"error": "模拟发布失败，可重试"} if len(publish_calls) == 1 else {"ok": True})

        await page.route("**/api/v1/admin/products", route_products)
        await page.route("**/api/v1/admin/products?view=surveys", route_surveys)
        await page.route("**/api/v1/admin/connectors", lambda route: route.fulfill(json={"connectors": [{"name": "assets-atlas-minio-current-smoke-with-a-long-connector-name", "type": "s3", "phase": "READY", "endpoint": "https://storage.example", "bucket": "public"}]}))
        await page.route("**/api/v1/admin/products/*/review", route_review)
        await page.route("**/api/v1/admin/products/*/publish", route_publish)
        await page.goto(base + "/admin/overview")
        await page.locator("#admin-token").fill(os.environ.get("ASSETS_ADMIN_TOKEN", "admin-smoke-token"))
        await page.locator("#login-form button[type=submit]").click()
        await page.locator('[data-survey-card="euclid"]').click()
        await page.locator('[data-overview-product]').first.click()
        checkbox = page.locator("#review-accept-limitations")
        await expect(checkbox).to_be_visible()
        cb = await checkbox.bounding_box()
        text = await checkbox.locator("xpath=following-sibling::span").bounding_box()
        assert abs(cb["y"] - text["y"]) <= 4, (cb, text)
        cancel = await page.locator("#product-dialog-cancel").bounding_box()
        assert cancel["width"] < 130, cancel
        await checkbox.check()
        await page.locator("#product-dialog-review").click()
        await expect(page.locator("#product-dialog")).not_to_be_visible()
        row = page.locator(".review-product-row.review-confirmed")
        await expect(row).to_have_count(1)
        await expect(row).to_be_in_viewport()
        await page.screenshot(path=str(shots / "review-highlight.png"))
        await expect(row).to_have_count(0, timeout=7000)
        product_id = next(iter(reviewed))
        await page.locator(f'[data-edit-product="{product_id}"]').click()
        button = page.locator("#product-dialog-publish")
        await button.click()
        await expect(button).to_be_disabled()
        await expect(button).to_have_attribute("aria-busy", "true")
        await expect(button.locator(".button-spinner")).to_be_visible()
        await button.evaluate("el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))")
        await asyncio.sleep(.2)
        assert len(publish_calls) == 1, publish_calls
        await page.screenshot(path=str(shots / "publish-pending.png"))
        release_publish.set()
        await expect(button).to_be_enabled()
        await expect(button.locator(".button-spinner")).to_have_count(0)
        await expect(page.locator("#product-dialog")).to_be_visible()
        await button.click()
        await expect(page.locator("#product-dialog")).not_to_be_visible()
        assert len(publish_calls) == 2
        await page.locator('[data-admin-step="sources"]').click()
        await page.set_viewport_size({"width": 390, "height": 844})
        await expect(page.locator(".connector-detail-title .connector-type-icon")).to_be_visible()
        icon = await page.locator(".connector-detail-title .connector-type-icon").bounding_box()
        assert abs(icon["width"] - icon["height"]) < 1, icon
        buttons = await page.locator(".connector-detail-actions button").all()
        rects = [await item.bounding_box() for item in buttons]
        assert len(rects) == 3 and all(abs(r["width"] - r["height"]) < 1 for r in rects), rects
        assert max(r["y"] for r in rects) - min(r["y"] for r in rects) < 1, rects
        assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")
        await page.screenshot(path=str(shots / "connector-mobile.png"), full_page=True)
        assert not errors, errors
        await browser.close()
    print("action feedback passed: aligned consent, compact cancel, located review highlight, pending spinner, duplicate guard, failure/retry")


asyncio.run(main())
