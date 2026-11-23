#!/usr/bin/env python3
"""Regression: in SaaS (read-only) mode the overview's "产品详情与证据" must open a visible, read-only dialog.

Root cause it guards against: #product-dialog used to live inside the hidden review panel, so in SaaS mode
(where review is disabled) the dialog was open but 0x0 and the modal layer froze the page.
Runs against a local Vite dev server with a trimmed, secret-free copy of the real admin read responses.
"""
import json, re, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 4178
URL = f"http://127.0.0.1:{PORT}"
TOKEN_KEY = re.search(r'const tokenKey = "([^"]+)"', (ROOT / "site/admin/main.ts").read_text()).group(1)
FIXTURE = json.loads((ROOT / "fixtures/admin-saas-overview.json").read_text())
WRITE_BUTTONS = ["product-dialog-review", "product-dialog-publish", "product-dialog-retire", "product-dialog-restore", "product-dialog-withdraw", "product-save-draft"]


def api(route):
    full = route.request.url
    path = full.split("/api/v1/admin", 1)[1].split("?")[0]
    if route.request.method != "GET":
        return route.fulfill(status=409, json={"error": "read-only"})
    table = {"/config": "config", "/overview": "overview", "/native-units": "nativeUnits", "/publications": "publications"}
    if path == "/products":
        return route.fulfill(json=FIXTURE["reviewSurveys" if "view=surveys" in full else "products"])
    if path in table:
        return route.fulfill(json=FIXTURE[table[path]])
    if path.endswith("/preflight"):
        return route.fulfill(json={"productId": "x", "revision": 1, "nativeOrder": {"state": "passed", "message": "ok"}})
    if path.endswith("/history"):
        return route.fulfill(json={"history": []})
    return route.fulfill(json={})


def main() -> None:
    server = subprocess.Popen([str(ROOT / "node_modules/.bin/vite"), "--host", "127.0.0.1", "--port", str(PORT), "--strictPort"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(120):
            try:
                opener.open(URL + "/admin/", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script(f"sessionStorage.setItem({json.dumps(TOKEN_KEY)}, 'fixture-token')")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/api/v1/admin/**", api)
            page.goto(URL + "/admin/overview", wait_until="domcontentloaded")
            for step in ("sources", "tasks", "review", "releases"):
                expect(page.locator(f'[data-admin-step="{step}"]')).to_be_disabled()
            # openProduct() ignores clicks until the product list has loaded; wait for it like a user would.
            expect(page.locator("#step-overview-count")).not_to_have_text("--")
            page.wait_for_load_state("networkidle")
            page.locator("[data-survey-card]").first.click()
            for index in (0, 1):
                page.locator("[data-overview-product]").nth(index).click()
                dialog = page.locator("#product-dialog")
                expect(dialog).to_be_visible(timeout=3000)
                box = dialog.bounding_box()
                assert box and box["width"] > 300 and box["height"] > 300, f"dialog must be drawn, got {box}"
                assert "/admin/overview" in page.url and "/review" not in page.url, page.url
                for button_id in WRITE_BUTTONS:
                    expect(page.locator(f"#{button_id}")).not_to_be_visible()
                expect(page.locator("#product-edit-content")).not_to_be_visible()
                page.keyboard.press("Escape")
                expect(dialog).not_to_be_visible()
                expect(page.locator("[data-overview-product]").first).to_be_visible()
            page.locator('[data-admin-step="api"]').click()
            expect(page.locator('[data-admin-panel="api"]')).to_be_visible()
            assert not errors, errors
            browser.close()
        print("SaaS read-only product detail smoke passed")
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
