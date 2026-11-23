#!/usr/bin/env python3
"""Regression: the 运营 tab works in SaaS mode (announcement list, add/edit dialog, survey multi-select, NEW settings).

Local Vite dev server + mocked admin API; no real backend, token or data is touched.
"""
import json, re, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 4179
URL = f"http://127.0.0.1:{PORT}"
TOKEN_KEY = re.search(r'const tokenKey = "([^"]+)"', (ROOT / "site/admin/main.ts").read_text()).group(1)
SURVEYS = [{"id": "euclid", "name": "Euclid"}, {"id": "roman", "name": "Nancy Grace Roman"}, {"id": "spherex", "name": "SPHEREx"}]


def main() -> None:
    state = {"promos": [], "newSettings": {"manual": [], "suppressed": []}}
    saved = []

    def api(route):
        path = route.request.url.split("/api/v1/admin", 1)[1].split("?")[0]
        if path == "/config":
            return route.fulfill(json={"enabled": True, "operationsMode": "saas", "authRequired": True, "kubernetesConfigured": False, "capabilities": {"coverageModes": [], "modalities": []}})
        if path == "/promos" and route.request.method == "GET":
            return route.fulfill(json={"schemaVersion": 2, **state, "updatedAt": "2026-11-23T00:00:00Z"})
        if path == "/promos" and route.request.method == "PUT":
            body = json.loads(route.request.post_data)
            saved.append(body)
            for index, promo in enumerate(body["promos"]):
                promo.setdefault("id", f"p{index}") if promo.get("id") else promo.update(id=f"p{index}")
            state.update(promos=body["promos"], newSettings=body["newSettings"])
            return route.fulfill(json={"schemaVersion": 2, **state, "updatedAt": "2026-11-23T00:00:00Z"})
        return route.fulfill(json={"runs": [], "products": [], "surveys": [], "connectors": []})

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
            page.route("**/api/v1/surveys", lambda route: route.fulfill(json={"surveys": SURVEYS}))
            page.goto(URL + "/admin/ops", wait_until="domcontentloaded")
            expect(page.locator('[data-admin-step="ops"]')).to_be_enabled()  # stays usable in SaaS mode
            expect(page.locator('[data-admin-step="api"]')).to_be_enabled()
            expect(page.locator("#ops-content")).to_contain_text("公告")
            assert page.locator("#api-settings-content").inner_text().find("公告") < 0, "announcements must not live on the API page"
            # add an announcement through the dialog; surveys are picked, not typed
            page.locator("#promo-add").click()
            expect(page.locator("#promo-dialog")).to_be_visible()
            expect(page.locator('#promo-dialog input[name="surveyIds"]')).to_have_count(len(SURVEYS))
            page.locator('#promo-dialog select[name="kind"]').select_option("new-survey")
            page.locator('#promo-dialog input[name="titleZh"]').fill("新收录 Roman")
            page.locator('#promo-dialog input[name="titleEn"]').fill("Roman added")
            page.locator('#promo-dialog label.ops-chip:has-text("Nancy Grace Roman")').click()
            page.locator('#promo-dialog button[type="submit"]').click()
            expect(page.locator("#promo-dialog")).not_to_be_visible()
            row = page.locator("tr[data-promo]").first
            expect(row).to_contain_text("新收录 Roman")
            expect(row).to_contain_text("Nancy Grace Roman")
            assert saved[-1]["promos"][0]["kind"] == "new-survey" and saved[-1]["promos"][0]["surveyIds"] == ["roman"], saved[-1]
            # one list, not a stack of forms: no per-promo inline form exists
            assert page.locator("form.promo-form").count() == 0 or not page.locator("form.promo-form").first.is_visible()
            # toggle off
            row.locator(".ops-switch").click()
            expect(page.locator("tr[data-promo] .ops-state").first).to_contain_text("已停用")
            assert saved[-1]["promos"][0]["enabled"] is False
            # NEW settings: manual + suppression picked from the survey list
            page.locator('#new-form label.ops-chip:has-text("SPHEREx") >> nth=0').click()
            page.locator('#new-form fieldset:nth-of-type(2) label.ops-chip:has-text("Euclid")').click()
            page.locator('#new-form button[type="submit"]').click()
            expect(page.locator("#ops-message")).to_contain_text("NEW 设置已保存")
            settings = saved[-1]["newSettings"]
            assert [flag["surveyId"] for flag in settings["manual"]] == ["spherex"] and settings["suppressed"] == ["euclid"], settings
            page.screenshot(path="/tmp/ops-tab.png")
            assert not errors, errors
            browser.close()
        print("Operations tab smoke passed")
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
