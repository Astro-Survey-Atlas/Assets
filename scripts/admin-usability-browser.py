"""Local browser regression: synthetic JWST/Roman responses, no external writes."""
import json
import os
import shutil
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    base = os.environ.get("ASSETS_ADMIN_URL", "http://127.0.0.1:4199/admin/")
    if urlsplit(base).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("This fixture test must run against a local disposable server")
    candidate = {"candidateId": "jwst-f115w", "title": "JWST NIRCam F115W", "mocUrl": "https://alasky.cds.unistra.fr/jwst/f115w/moc.fits"}
    discovery = {"name": "jwst-discovery", "surveyName": "JWST", "policyRef": "cds-public-moc-v2", "status": {"phase": "SUCCEEDED", "candidateCount": 1, "reviewSummary": {"schemaVersion": 2, "truncated": False, "summaryTruncated": False, "candidates": [candidate]}}}
    roman = {"name": "roman-waiting", "surveyName": "Nancy Grace Roman Space Telescope", "createdAt": "2026-09-14T01:40:39Z", "policyRef": "cds-public-moc-v2", "status": {"phase": "PENDING"}}
    roman["observation"] = {"state": "blocked", "checkedAt": "2026-09-14T07:00:00Z", "waitedSeconds": 240, "executor": {"health": "error", "checkedAt": "2026-09-14T07:00:00Z", "reason": "OutOfMemory", "message": "探索服务检测到内存不足。", "source": "kubernetes:atlas-system/pods/discovery-fixture"}}
    discovery_unavailable = False
    build = {"schemaVersion": 1, "kind": "MocBuildRequest", "name": "jwst-build", "discoveryRequestName": discovery["name"], "provider": "cds", "candidateId": candidate["candidateId"], "candidateTitle": candidate["title"], "surveyId": "jwst", "releaseId": "public", "phase": "STAGED", "createdAt": "2026-09-14T01:00:00Z", "updatedAt": "2026-09-14T01:01:00Z", "source": {"url": candidate["mocUrl"]}, "progress": {"step": 7, "totalSteps": 7, "percent": 100, "message": "构建完成"}, "outputs": {"availableOrders": [4, 8], "maxOrder": 8}}
    defaults = {"releaseId": "public", "releaseLabel": "JWST public coverage", "releaseKind": "release", "productName": candidate["title"], "productDescription": "Fixture coverage", "productStatus": "acquired", "modality": "infrared", "dataOrigin": "observed"}
    facts = {"surveyId": "jwst", "surveyName": "JWST", "mission": "James Webb Space Telescope", "surveyDescription": "Shared JWST survey facts", "surveyColor": "#5678ad", "surveyModalities": ["infrared"]}
    submitted = []
    discovery_polls = []
    build_polls = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=shutil.which("chromium") or shutil.which("chromium-browser"))
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def discovery_route(route):
            name = urlsplit(route.request.url).path.rsplit("/", 1)[-1]
            if name == "moc-discovery":
                discovery_polls.append(name)
                if discovery_unavailable:
                    route.fulfill(status=503, json={"error": "fixture unavailable"})
                    return
            payload = {"requests": [discovery, roman]} if name == "moc-discovery" else {"request": roman if name == roman["name"] else discovery}
            route.fulfill(json=payload)

        def builds_route(route):
            path = urlsplit(route.request.url).path
            if route.request.method == "POST":
                submitted.append(json.loads(route.request.post_data or "{}"))
                route.fulfill(status=201, json={"product": {"draft": {"name": candidate["title"]}}, "request": build})
            elif path.endswith("/moc-builds"):
                build_polls.append(path)
                build["progress"]["message"] = f"构建结果检查 {len(build_polls)}"
                route.fulfill(json={"requests": [build]})
            else:
                route.fulfill(json={"request": build, "registrationDefaults": defaults, "surveyFacts": facts})

        page.route("**/api/v1/admin/moc-discovery**", discovery_route)
        page.route("**/api/v1/admin/moc-builds**", builds_route)
        page.goto(base, wait_until="networkidle")
        page.locator("#admin-token").fill(os.environ.get("ASSETS_ADMIN_TOKEN", "admin-smoke-token"))
        page.locator("#login-form button[type=submit]").click()
        expect(page.locator("[data-survey-card]").first).to_be_visible()
        page.locator('[data-admin-step="tasks"]').click()
        expect(page.locator('[data-moc-review="roman-waiting"]')).to_be_visible()
        page.locator("#moc-discovery-create-button").click()
        page.locator("#moc-product-search").fill("Euclid")
        expect(page.locator("#moc-product-tree")).to_contain_text("ERO")
        page.locator("#moc-product-tree [data-pick-product]").nth(1).click()
        page.evaluate("window.savedTree = document.getElementById('moc-product-tree').firstChild")
        selected = page.locator("#moc-product-selection").inner_text()
        for _ in range(5):
            page.wait_for_timeout(3200)
            assert page.evaluate("window.savedTree === document.getElementById('moc-product-tree').firstChild")
            expect(page.locator("#moc-product-selection")).to_have_text(selected)
            assert "REFRESHING" not in page.locator("#admin-status").inner_text()
        assert len(discovery_polls) >= 6, "test must actually observe five background polls"
        expect(page.locator("#refresh-state")).to_contain_text("有更新")
        page.locator("#moc-product-search").fill("DESI")
        expect(page.locator("#moc-product-tree")).to_contain_text("DESI")
        expect(page.locator("#moc-product-tree")).not_to_contain_text("Euclid")
        page.locator("#moc-product-tree [data-pick-product]").nth(1).click()
        expect(page.locator("#moc-product-selection")).to_contain_text("已选择")
        page.locator("#moc-discovery-dialog-cancel").click()
        page.locator("#auto-update-toggle").click()
        expect(page.locator("#auto-update-toggle")).to_have_text("自动更新：关")
        poll_count = len(discovery_polls)
        page.wait_for_timeout(3500)
        assert len(discovery_polls) == poll_count, "pause must stop background requests"
        page.locator("#refresh-button").click()
        page.wait_for_timeout(500)
        assert len(discovery_polls) > poll_count, "manual refresh remains usable while paused"
        width = page.locator(".work-build-output").first.evaluate("el => el.getBoundingClientRect().width / el.closest('.work-output-row').getBoundingClientRect().width")
        assert width > .95, width
        page.locator('[data-moc-review="roman-waiting"]').click()
        expect(page.locator("#moc-review-state")).to_contain_text("内存不足")
        expect(page.locator("#moc-review-title")).to_contain_text("等待受阻")
        expect(page.locator("#moc-review-state")).to_contain_text("最近检查")
        expect(page.locator("#moc-review-state")).not_to_contain_text("正在执行")
        page.evaluate("window.savedCandidateSelect = document.getElementById('moc-build-candidate')")
        roman["observation"]["state"] = "delayed"
        roman["observation"]["executor"] = {"health": "unknown", "checkedAt": "2026-09-14T07:00:15Z", "message": "实例就绪"}
        page.evaluate("document.getElementById('refresh-button').click()")
        expect(page.locator("#moc-review-state")).to_contain_text("原因尚未确认")
        assert page.evaluate("window.savedCandidateSelect === document.getElementById('moc-build-candidate')")
        discovery_unavailable = True
        page.evaluate("document.getElementById('refresh-button').click()")
        expect(page.locator("#moc-review-state")).to_contain_text("状态暂不可获取")
        discovery_unavailable = False
        page.locator("#moc-review-dialog-cancel").click()
        page.locator('[data-moc-review="jwst-discovery"]').click()
        expect(page.locator("#moc-candidate-detail")).to_contain_text("已构建")
        expect(page.locator("#moc-build-candidate")).to_contain_text("F115W")
        page.locator("#candidate-existing-build").click()
        page.locator("[data-register-moc-build-detail]").click()
        expect(page.locator("#moc-product-register-dialog")).to_be_visible()
        expect(page.locator("#moc-product-register-build-facts")).to_contain_text(facts["mission"])
        assert page.locator('#moc-product-register-form input:not([type="hidden"]), #moc-product-register-form textarea, #moc-product-register-form select').count() == 0
        page.locator("#moc-product-register-form button[type=submit]").click()
        expect(page.locator("#moc-product-register-dialog")).not_to_be_visible()
        assert submitted == [{}], submitted
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator('[data-admin-step="overview"]').click()
        expect(page).to_have_url(base.split('/admin')[0] + '/admin/overview')
        page.locator('[data-survey-card]').first.click()
        expect(page).to_have_url(__import__('re').compile(r'/admin/overview/surveys/'))
        page.reload(wait_until='networkidle')
        expect(page.locator('#overview-back')).to_be_visible()
        page.go_back()
        assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "mobile overflow"
        assert not errors, errors
        browser.close()
    print("admin usability browser passed (local JWST/Roman fixtures; registration POST intercepted)")


if __name__ == "__main__":
    main()
