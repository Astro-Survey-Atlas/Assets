#!/usr/bin/env python3
"""Exercise the admin API-Key screen (quota field, batch generation + download) with a mocked admin API.

No real backend, token or production data is touched: every /api/v1/admin request is answered by
fixtures in this script. Runs against a local Vite dev server.
"""

import json
import re
import subprocess
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 4176
URL = f"http://127.0.0.1:{PORT}"
# The session key the admin app reads its token from; read it from source instead of duplicating it.
TOKEN_KEY = re.search(r'const tokenKey = "([^"]+)"', (ROOT / "site/admin/main.ts").read_text()).group(1)


def view(keys):
    return {
        "startedAt": "2026-11-17T00:00:00.000Z", "credentialStorageReady": True,
        "provider": {"revision": 1, "baseUrl": "https://example.org", "model": "fixture", "enabled": False, "keyConfigured": False, "updatedAt": "2026-11-17T00:00:00.000Z"},
        "scopes": ["region:query"], "keys": keys, "events": [],
        "llmUsage": {"requests": 0, "errors": 0, "inputTokens": 0, "outputTokens": 0, "unknownUsage": 0},
    }


def main() -> None:
    process = subprocess.Popen(
        [str(ROOT / "node_modules/.bin/vite"), "--host", "127.0.0.1", "--port", str(PORT), "--strictPort"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError("Vite exited before becoming ready")
            try:
                with opener.open(URL, timeout=1):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise RuntimeError("Vite did not become ready")

        created: list[dict] = []   # request bodies received by the mocked POST /keys
        keys: list[dict] = []

        def admin_api(route):
            request = route.request
            path = request.url.split("/api/v1/admin", 1)[1].split("?")[0]
            if path == "/config" and request.method == "GET":
                return route.fulfill(json={
                    "enabled": True, "operationsMode": "saas", "authRequired": True, "namespace": "fixture-namespace", "kubernetesConfigured": True,
                    "mocDiscovery": {"cdsUrl": "https://example.invalid/MocServer/query", "llmAvailable": False},
                    "publicationVerification": {"configured": False},
                    "capabilities": {"coverageModes": [], "modalities": []},
                })
            if path == "/api-management" and request.method == "GET":
                return route.fulfill(json=view(keys))
            if path == "/api-management/keys" and request.method == "POST":
                body = json.loads(request.post_data)
                created.append(body)
                index = len(created)
                keys.append({
                    "id": f"id-{index}", "name": body["name"], "prefix": f"asa_live_fixt{index:03d}", "expiresAt": body["expiresAt"],
                    "perMinute": body["perMinute"], "requests": 0, "errors": 0,
                    **({"quota": body["quota"], "quotaUsed": 0} if "quota" in body else {}),
                })
                return route.fulfill(status=201, json={"key": f"asa_live_FIXTURE{index:03d}", "id": f"id-{index}"})
            return route.fulfill(json={})

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
            context.add_init_script(f"sessionStorage.setItem({json.dumps(TOKEN_KEY)}, 'fixture-token')")
            page = context.new_page()
            errors = []
            console = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: console.append(f"{message.type}: {message.text}"[:200]) if message.type in ("error", "warning") else None)
            page.route("**/api/v1/admin/**", admin_api)
            page.goto(URL + "/admin/api", wait_until="domcontentloaded")

            single = page.locator("#api-key-form")
            try:
                expect(single).to_be_visible()
            except AssertionError:
                # Show what the page actually rendered instead of an opaque locator timeout.
                print("DIAGNOSTIC url:", page.url)
                print("DIAGNOSTIC visible text:", page.inner_text("body")[:700].replace("\n", " | "))
                print("DIAGNOSTIC console/page errors:", console[-8:], errors[-5:])
                raise
            batch = page.locator("#api-key-form")  # one merged form: count 1 = single key, count > 1 = batch
            expect(page.locator("#api-key-batch-form")).to_have_count(0)

            # 1) single key: quota left empty -> no quota sent (unlimited in total)
            single.locator('input[name="name"]').fill("research workbench")
            single.locator('button[type="submit"]').click()
            expect(page.locator("#api-key-created")).to_be_visible()
            page.locator("#api-key-created").evaluate("dialog => dialog.close()")
            assert "quota" not in created[0], created[0]

            # 2) single key with a quota -> quota sent and shown in the table
            single.locator('input[name="name"]').fill("limited buyer")
            single.locator('input[name="quota"]').fill("100")
            single.locator('button[type="submit"]').click()
            expect(page.locator("#api-key-created")).to_be_visible()
            page.locator("#api-key-created").evaluate("dialog => dialog.close()")
            assert created[1]["quota"] == 100, created[1]
            expect(page.locator("#api-settings-content table", has_text="名称 / 标识").locator("tbody")).to_contain_text("额度 0 / 100")

            # 3) batch: N keys, each with the quota, downloaded as one plaintext file, one key per line
            batch.locator('input[name="name"]').fill("发卡-100次")
            batch.locator('input[name="count"]').fill("3")
            batch.locator('input[name="quota"]').fill("100")
            batch.locator('input[name="perMinute"]').fill("10")
            batch.locator('input[name="days"]').fill("365")
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_download() as download_info:
                batch.locator('button[type="submit"]').click()
            download = download_info.value
            text = Path(download.path()).read_text()
            lines = text.strip().split("\n")
            assert lines == ["asa_live_FIXTURE003", "asa_live_FIXTURE004", "asa_live_FIXTURE005"], lines
            assert re.fullmatch(r"asa-keys-\d{4}-\d{2}-\d{2}-3\.txt", download.suggested_filename), download.suggested_filename
            batch_requests = created[2:]
            assert len(batch_requests) == 3
            assert all(r["quota"] == 100 and r["perMinute"] == 10 and r["scopes"] == ["region:query"] for r in batch_requests), batch_requests
            names = [r["name"] for r in batch_requests]
            assert all(re.fullmatch(r"发卡-100次-[0-9a-z]{4}", n) for n in names) and len(set(names)) == 3, names
            expect(page.locator("#api-settings-content table", has_text="名称 / 标识").locator("tbody")).to_contain_text(names[2])

            # 4) the plaintext is not left on the page after the download
            assert "asa_live_FIXTURE" not in page.content(), "key plaintext must not remain in the page"

            # 5) a failure in the middle still hands over the keys that were already created
            fail_after = {"n": 0}
            before = len(created)

            def flaky(route):
                if route.request.method == "POST" and route.request.url.endswith("/api-management/keys"):
                    fail_after["n"] += 1
                    if fail_after["n"] == 3:
                        return route.fulfill(status=500, json={"error": "fixture failure"})
                return admin_api(route)

            page.unroute("**/api/v1/admin/**")
            page.route("**/api/v1/admin/**", flaky)
            batch.locator('input[name="name"]').fill("partial")
            batch.locator('input[name="count"]').fill("4")
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_download() as partial_info:
                batch.locator('button[type="submit"]').click()
            partial = Path(partial_info.value.path()).read_text().strip().split("\n")
            assert len(partial) == 2, f"keys created before the failure must still be downloaded: {partial}"
            assert len(created) - before == 2, "the failing request is not recorded as created"
            expect(page.locator("#api-key-feedback")).to_contain_text("fixture failure")

            # 6) SaaS mode: every data-changing tab (sources, tasks, review, releases) is greyed out; only overview + API stay usable
            for step in ("sources", "tasks", "review", "releases"):
                expect(page.locator(f'[data-admin-step="{step}"]')).to_be_disabled()
            for step in ("overview", "api"):
                expect(page.locator(f'[data-admin-step="{step}"]')).to_be_enabled()
            page.goto(URL + "/admin/review", wait_until="domcontentloaded")
            expect(page.locator('[data-admin-step="overview"]')).to_have_attribute("aria-selected", "true")
            assert page.url.endswith("/admin/overview"), page.url

            assert not errors, errors
            browser.close()
        print("PASS: admin API keys — quota field, batch generation with one-key-per-line download, plaintext not left on page, partial-failure hand-over, SaaS menu gating")
    finally:
        process.terminate()


if __name__ == "__main__":
    main()
