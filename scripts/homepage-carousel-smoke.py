#!/usr/bin/env python3
"""Exercise homepage tab rotation in Chromium against the built site."""

import os
import csv
import io
import json
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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


def atlas_layer_tooltip_smoke(browser, base_url: str, mock_api) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/v1/**", mock_api)
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    for survey_id in ["euclid", "gaia"]:
        page.locator(f'#coverage-survey-{survey_id} input[data-survey-id]:not([data-release-id])').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    page.wait_for_timeout(500)
    page.evaluate("document.activeElement.blur()")
    page.mouse.move(1200, 900)
    page.clock.install(time=0)
    page.clock.pause_at(100)
    euclid = page.locator("#coverage-survey-euclid .coverage-layer-toggle")
    gaia = page.locator("#coverage-survey-gaia .coverage-layer-toggle")
    tooltip = page.locator("#coverage-layer-tooltip")

    euclid.hover()
    expect(tooltip).to_be_visible()
    expect(tooltip.locator(".coverage-layer-detail-row")).to_have_count(3)
    euclid.locator("input").uncheck(force=True)
    expect(tooltip.locator(".coverage-layer-detail-row")).to_have_count(0)
    euclid.locator("input").check(force=True)
    expect(tooltip.locator(".coverage-layer-detail-row")).to_have_count(3)
    page.evaluate("document.activeElement.blur()")
    page.mouse.move(1200, 900)
    page.clock.run_for(1999)
    expect(tooltip).to_be_visible()
    page.clock.run_for(1)
    expect(tooltip).to_have_count(0)
    assert euclid.get_attribute("aria-describedby") is None

    euclid.hover()
    page.mouse.move(1200, 900)
    page.clock.run_for(1000)
    euclid.hover()
    tooltip.evaluate("element => element.dataset.retained = 'true'")
    page.clock.run_for(2000)
    expect(tooltip).to_have_attribute("data-retained", "true")
    tooltip.hover()
    page.clock.run_for(11000)
    expect(tooltip).to_be_visible()
    assert page.evaluate("document.body.dataset.layersPanel === 'open'"), "reading a card must pause roster auto-close"
    tooltip.locator(".coverage-layer-detail-list").evaluate("element => element.scrollTop = element.scrollHeight")
    page.mouse.move(1200, 900)
    page.clock.run_for(1999)
    expect(tooltip).to_be_visible()
    page.clock.run_for(1)
    expect(tooltip).to_have_count(0)

    euclid.hover()
    page.mouse.move(1200, 900)
    page.clock.run_for(1000)
    gaia.hover()
    page.clock.run_for(2000)
    expect(tooltip).to_have_attribute("data-survey-id", "gaia")
    euclid.hover()
    euclid.locator("input").focus()
    page.mouse.move(1200, 900)
    page.clock.run_for(2500)
    expect(tooltip).to_have_attribute("data-survey-id", "euclid")
    page.evaluate("document.activeElement.blur()")
    page.clock.run_for(2000)
    expect(tooltip).to_have_count(0)

    euclid.hover()
    rows = tooltip.locator(".coverage-layer-detail-row")
    names = rows.locator(".coverage-layer-detail-product").evaluate_all("elements => elements.map(e => e.getBoundingClientRect().left)")
    assert max(names) - min(names) < 1, "product columns must align across DR rows"
    assert rows.locator(".coverage-layer-detail-version").all_text_contents() == ["euclid-ero", "euclid-ero", "euclid-q1"]
    assert rows.locator(".coverage-layer-detail-orders").count() == 3
    persistent_rows = page.locator(".coverage-layer-detail-persistent[data-survey-id='euclid'] .coverage-layer-detail-row")
    expect(persistent_rows).to_have_count(3)
    assert persistent_rows.locator(".coverage-layer-detail-version").all_text_contents() == ["euclid-ero", "euclid-ero", "euclid-q1"]
    rows.locator(".coverage-layer-detail-product").first.evaluate("element => element.textContent = 'LongProductNameWithoutBreaks'.repeat(8)")
    assert tooltip.evaluate("element => element.scrollWidth <= element.clientWidth"), "long product names must wrap inside the card"
    for selector in ["[data-theme-toggle]", "[data-locale-toggle]"]:
        page.locator(selector).first.click()
        euclid.hover()
        expect(tooltip).to_be_visible()
        assert tooltip.evaluate("element => element.scrollWidth <= element.clientWidth")
    page.mouse.move(1200, 900)
    page.locator("#coverage-layer-search").fill("gaia")
    assert page.locator("#coverage-survey-euclid").evaluate("element => element.hidden"), page.locator("#coverage-layers").inner_text()
    expect(tooltip).to_have_count(0)
    page.locator("#coverage-layer-search").fill("")
    euclid.hover()
    page.locator("#hud-layers-head").click()
    expect(tooltip).to_have_count(0)
    page.locator("#hud-layers-head").click()
    euclid.hover()
    page.evaluate("document.activeElement.blur()")
    page.mouse.move(1200, 900)
    page.clock.run_for(2000)
    expect(tooltip).to_have_count(0)
    page.clock.run_for(10000)
    assert page.evaluate("document.body.dataset.layersPanel !== 'open'"), "roster auto-close must resume after reading"
    page.locator("#coverage-layers-toggle").click()
    euclid.hover()
    page.set_viewport_size({"width": 390, "height": 844})
    page.clock.run_for(100)
    expect(tooltip).to_have_count(0)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "mobile layout must not overflow"
    assert not errors, f"Tooltip browser errors: {errors}"
    page.close()


def atlas_target_lock_scroll_smoke(browser, base_url: str, mock_api) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 720})
    page.route("**/api/v1/**", mock_api)
    errors = []
    requests = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: requests.append(request.url) if "/api/v1/" in request.url else None)
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    for survey_id, layer_id in [("euclid", "euclid-euclid-ero-native"), ("gaia", "gaia-gaia-dr3-main")]:
        group = page.locator("#coverage-survey-" + survey_id)
        group.locator(".coverage-layer-name").click()
        group.locator('input[data-product-layer-id="' + layer_id + '"]').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator("#coverage-detail-content .overlap-component-detail")).to_be_visible()
    # End the initial focus/hydration before testing an unchanged cached refresh.
    page.evaluate("window.dispatchEvent(new Event('atlas:locale-change'))")
    page.wait_for_timeout(1200)
    expect(page.locator("#coverage-detail-content .overlap-spatial-unit")).to_have_count(6)
    expect(page.locator("#coverage-detail-content .hud-query-progress")).to_have_count(0)
    rail = page.locator(".coverage-inspector-rail")
    assert rail.evaluate("element => element.scrollHeight > element.clientHeight + 180"), "fixture must overflow the actual Target Lock scroller"
    rail.hover()
    page.mouse.wheel(0, 180)
    page.wait_for_function("document.querySelector('.coverage-inspector-rail').scrollTop > 100")
    before = rail.evaluate("element => element.scrollTop")
    assert page.locator("#coverage-detail-content").evaluate("element => element.scrollTop") == 0, "the inner detail is not the desktop scroll owner"
    request_count = len(requests)
    # This is a supported local refresh of cached results: there is no API response
    # to blame for the jump. Observe painted frames, not just a final restored offset.
    page.evaluate("""() => {
        const rail = document.querySelector('.coverage-inspector-rail');
        window.targetLockDetail = document.querySelector('.overlap-component-detail');
        window.targetLockProducts = document.querySelector('.overlap-products');
        window.targetLockScrollFrames = [];
        const sample = () => window.targetLockScrollFrames.push(rail.scrollTop);
        window.dispatchEvent(new Event('atlas:locale-change'));
        sample();
        requestAnimationFrame(() => { sample(); requestAnimationFrame(sample); });
    }""")
    page.wait_for_function("window.targetLockScrollFrames.length === 3")
    frames = page.evaluate("window.targetLockScrollFrames")
    assert all(abs(top - before) <= 1 for top in frames), f"cached refresh must preserve the real rail without a top flash: {before} -> {frames}"
    assert page.evaluate("window.targetLockDetail === document.querySelector('.overlap-component-detail') && window.targetLockProducts === document.querySelector('.overlap-products')"), "unchanged refresh must keep the existing reading DOM"
    assert len(requests) == request_count, "cached same-component refresh must not issue an API request"
    page.locator(".overlap-components button.is-active").evaluate("button => button.click()")
    assert page.evaluate("window.targetLockDetail === document.querySelector('.overlap-component-detail')"), "reselecting the current component must keep its detail DOM"
    assert abs(rail.evaluate("element => element.scrollTop") - before) <= 1, "same-component selection must retain rail scroll"
    # An actual language change must rebuild translated content, but not scroll to
    # the top. Bypass clicking the header so focus/Playwright scrolling is unrelated.
    page.evaluate("document.querySelector('[data-locale-toggle]').click()")
    after_locale = rail.evaluate("element => element.scrollTop")
    # Translations applied before the refresh can reflow the readout by one line.
    assert after_locale > 100 and abs(after_locale - before) <= 24, f"translated same-target rebuild must retain the reading position: {before} -> {after_locale}"
    assert page.evaluate("window.targetLockDetail !== document.querySelector('.overlap-component-detail')"), "changed language must not incorrectly skip rendering"
    assert page.locator("#coverage-detail-content .overlap-spatial-unit").count() == 6, "cached evidence must be present synchronously after a translated rebuild"
    assert page.locator("#coverage-detail-content .hud-skeleton-row").count() == 0, "cached evidence must never replace the list with skeletons"
    assert len(requests) == request_count, "translated cached rebuild must not issue API requests"
    # Every visible part of the card, including its title and padding, owns its
    # pointer events. They must not fall through to the globe controls.
    rail.evaluate("element => element.scrollTop = 0")
    box = rail.bounding_box()
    camera = page.locator("#coverage-status-camera").inner_text()
    for x, y in [(box["x"] + 10, box["y"] + 10), (box["x"] + box["width"] - 3, box["y"] + 100)]:
        assert page.evaluate("p => document.elementFromPoint(p.x, p.y)?.closest('.coverage-inspector-rail') !== null", {"x": x, "y": y}), "Target Lock surface must not hit the canvas underneath"
        page.mouse.move(x, y)
        page.mouse.wheel(0, 80)
    page.wait_for_timeout(500)
    assert page.locator("#coverage-status-camera").inner_text() == camera, "scrolling the card surface must not move the sky camera"
    # At O6 a view can change inside already-loaded tiles. Monitor actual loading
    # and completion, so a no-op camera event cannot make this assertion pass.
    slider = page.locator("#coverage-display-order")
    slider.evaluate("input => { input.value = '2'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); }")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "6")
    expect(page.locator("#coverage-detail-content .overlap-spatial-unit")).to_have_count(6)
    page.wait_for_timeout(1800)
    assert rail.evaluate("element => element.scrollTop") == 0, "a different real order is a new target even when its ID is still C01"
    rail.evaluate("element => element.scrollTop = 180")
    page.evaluate("""() => {
        window.targetLockDetail = document.querySelector('.overlap-component-detail');
        window.targetLockCachedLoading = false;
        window.targetLockCameraFrames = [];
        window.targetLockCameraSampling = true;
        const sample = () => {
            window.targetLockCameraFrames.push(document.querySelector('.coverage-inspector-rail').scrollTop);
            if (window.targetLockCameraSampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        new MutationObserver(records => {
            const states = [document.querySelector('#coverage-state').textContent,
                ...records.flatMap(record => [...record.removedNodes].map(node => node.textContent))];
            if (states.some(text => /Loading overlap|加载共同覆盖/.test(text))) window.targetLockCachedLoading = true;
        }).observe(document.querySelector('#coverage-state'), {childList:true, subtree:true});
    }""")
    request_count = len(requests)
    canvas = page.locator("#coverage-canvas").bounding_box()
    camera = page.locator("#coverage-status-camera").inner_text()
    point = {"x": canvas["x"] + canvas["width"] / 2, "y": canvas["y"] + canvas["height"] / 2}
    assert page.evaluate("p => document.elementFromPoint(p.x, p.y)?.id === 'coverage-canvas'", point), "cached-view test must actually hit the sky canvas"
    page.mouse.move(point["x"], point["y"])
    page.mouse.wheel(0, 120)
    page.wait_for_function("previous => document.querySelector('#coverage-status-camera').textContent !== previous", arg=camera)
    page.wait_for_function("window.targetLockCachedLoading", timeout=10000)
    page.wait_for_function("!/Loading overlap|加载共同覆盖/.test(document.querySelector('#coverage-state').textContent)", timeout=10000)
    assert len(requests) == request_count, f"cached O6 view refresh must not issue requests: {requests[request_count:]}"
    assert page.evaluate("window.targetLockDetail === document.querySelector('.overlap-component-detail')"), "cached O6 view refresh must preserve reading DOM"
    assert abs(rail.evaluate("element => element.scrollTop") - 180) <= 1, "cached O6 view refresh must preserve the actual rail"
    camera_frames = page.evaluate("() => { window.targetLockCameraSampling = false; return window.targetLockCameraFrames; }")
    assert camera_frames and all(abs(top - 180) <= 1 for top in camera_frames), f"cached O6 refresh must not paint a transient top flash: {camera_frames}"
    # Opening the drawer can abort a panel lookup through the shared controller.
    # Keeping its DOM must not leave an abandoned skeleton when the drawer closes.
    held_lookup = []

    def hold_first_lookup(route):
        if not held_lookup:
            held_lookup.append(route)
        else:
            mock_api(route)

    page.route("**/api/v1/coverage/reverse-lookup", hold_first_lookup)
    slider.evaluate("input => { input.value = '3'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); }")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "7")
    deadline = time.monotonic() + 10
    while not held_lookup and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert held_lookup, "fixture must hold a real pending panel evidence lookup"
    page.locator("#overlap-expand").click()
    expect(page.locator("#overlap-drawer-content .overlap-spatial-unit")).to_have_count(6)
    page.locator("#overlap-drawer-close").click()
    expect(page.locator("#coverage-detail-content .overlap-spatial-unit")).to_have_count(6)
    expect(page.locator("#coverage-detail-content .hud-skeleton-row")).to_have_count(0)
    held_lookup[0].abort()
    assert not errors, f"Target Lock browser errors: {errors}"
    page.close()


def atlas_drawer_region_smoke(browser, base_url: str, mock_api, details_requests) -> None:
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.route("**/api/v1/**", mock_api)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    for survey_id, layer_id in [("euclid", "euclid-euclid-ero-native"), ("gaia", "gaia-gaia-dr3-main")]:
        group = page.locator("#coverage-survey-" + survey_id)
        group.locator(".coverage-layer-name").click()
        group.locator('input[data-product-layer-id="' + layer_id + '"]').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator("#overlap-expand")).to_be_visible()
    page.locator("#overlap-expand").click()
    expect(page.locator("#overlap-drawer-title")).to_contain_text("C01")
    page.wait_for_timeout(1200)
    tooltip = page.locator("#overlap-region-tooltip")

    def find_region(component_id):
        # Real canvas pointer events exercise both ray-picking and application
        # routing. Do not call component callbacks directly as a substitute.
        drawer_left = page.locator("#overlap-drawer").bounding_box()["x"]
        for y in range(260, 740, 45):
            for x in range(40, int(drawer_left) - 20, 40):
                if not page.evaluate("p => document.elementFromPoint(p.x, p.y)?.id === 'coverage-canvas'", {"x": x, "y": y}):
                    continue
                page.mouse.move(x, y)
                if tooltip.count() and tooltip.get_attribute("data-component-id") == component_id:
                    return {"x": x, "y": y}
        raise AssertionError(f"No real canvas hover hit for {component_id}")

    count = len(details_requests)
    first = find_region("C01")
    expect(tooltip).to_contain_text("C01 · O4 · 2 cells")
    expect(tooltip).to_contain_text("euclid-ero")
    expect(tooltip).to_contain_text("gaia-dr3")
    assert tooltip.locator('[data-modality="imaging"]').count() == 1
    assert tooltip.locator('[data-modality="catalog"]').count() == 1
    assert len(details_requests) == count, "region hover must not query details or switch selection"
    page.mouse.click(first["x"], first["y"])
    expect(page.locator("#overlap-drawer-title")).to_contain_text("C01")
    assert len(details_requests) == count, "clicking the selected region must reuse its details"
    assert "IPIX" not in page.locator("#hud-callout").inner_text(), "drawer region picking must not lock an individual HEALPix"
    page.locator("#overlap-drawer-components button").filter(has_text="C02").click()
    expect(page.locator("#overlap-drawer-title")).to_contain_text("C02")
    page.wait_for_timeout(1000)
    second = find_region("C02")
    expect(tooltip).to_contain_text("C02 · O4 · 2 cells")
    # Move away and back so a real body click, not just the drawer button, routes
    # to the expanded drawer when the selection changes.
    page.locator("#overlap-drawer-components button").filter(has_text="C01").evaluate("button => button.click()")
    page.wait_for_timeout(1000)
    second = find_region("C02")
    page.mouse.click(second["x"], second["y"])
    expect(page.locator("#overlap-drawer-title")).to_contain_text("C02")
    expect(page.locator('#overlap-drawer-components button[aria-pressed="true"]')).to_contain_text("C02")
    assert details_requests[-1]["componentId"] == "C02" and details_requests[-1]["requestedOrder"] == 4
    # Empty or non-overlap sky must not create a single-cell target or a query.
    page.wait_for_timeout(1000)
    selected_title = page.locator("#overlap-drawer-title").inner_text()
    count = len(details_requests)
    missed = False
    for x, y in [(30, 200), (400, 200), (30, 800), (400, 800)]:
        if not page.evaluate("p => document.elementFromPoint(p.x, p.y)?.id === 'coverage-canvas'", {"x": x, "y": y}):
            continue
        page.mouse.move(x, y)
        if not tooltip.count():
            page.mouse.click(x, y)
            missed = True
            break
    assert missed, "fixture must exercise an actual canvas point outside any component"
    assert page.locator("#overlap-drawer-title").inner_text() == selected_title
    assert len(details_requests) == count, "non-component click must not change the drawer or issue a query"
    assert "IPIX" not in page.locator("#hud-callout").inner_text()
    page.locator("#overlap-drawer-close").click()
    expect(tooltip).to_have_count(0)
    assert page.evaluate("document.body.dataset.overlapDrawer !== 'open'")
    # Closing the drawer restores cell inspection without leaving G mode.
    canvas = page.locator("#coverage-canvas").bounding_box()
    page.wait_for_timeout(1000)
    inspected = False
    for y in range(300, 740, 80):
        for x in range(420, 1000, 80):
            page.mouse.click(canvas["x"] + x, canvas["y"] + y)
            if "IPix" in page.locator("#coverage-detail-title").inner_text():
                inspected = True
                break
        if inspected:
            break
    assert inspected, "closing the drawer must restore real single-cell inspection in G mode"
    expect(tooltip).to_have_count(0)
    assert not errors, f"Drawer region browser errors: {errors}"
    page.close()


def atlas_rectangle_query_smoke(browser, base_url: str, mock_api) -> None:
    """Drive the real region form/drawing/export UI with synthetic API evidence."""
    page = browser.new_page(viewport={"width": 1600, "height": 1000}, accept_downloads=True)
    errors, reverse_requests, overlap_requests, held = [], [], [], []
    unlocked = False
    held_starts, held_cursors = set(), set()
    matching_regions = [{"order": 4, "cells": [190]}, {"order": 10, "cells": [190]}]

    def response_for(body):
        rectangle = body["rectangle"]
        start = rectangle["raStart"]
        snapshot = f"region-snapshot-{start}"
        second_page = bool(body.get("cursor"))
        preview = body.get("preview", False)
        region = {"coordinateFrame": "ICRS", "ordering": "NESTED", "hash": f"region-hash-{start}",
                  "cells": [{"order": 4, "ipix": 190}, {"order": 10, "ipix": 190}], "rectangle": rectangle,
                  "cover": {"algorithmVersion": "browser-fixture-v1", "targetBoundaryOrder": body.get("boundaryOrder", 10),
                            "orderCounts": {"4": 1, "10": 1}, "budgetLimited": True, "unresolvedBoundaryLeaves": 1,
                            "maxUnresolvedAngularRadiusDeg": 3.5, "rectangleAreaDeg2": 200, "coverAreaDeg2": 204, "excessAreaDeg2": 4}}
        identity = "region-b" if second_page else "region-a"
        unit = {"layerId": body["layerIds"][0], "productId": "region-product", "surveyId": "euclid", "releaseId": "euclid-ero",
                "product": "Synthetic region evidence", "modality": "imaging", "unitKind": "target", "unitId": f"{identity}-{start}",
                "matchingRegions": matching_regions, "precision": "estimated", "accessUri": f"https://example.test/{identity}.fits",
                "accessUris": [{"uri": f"https://example.test/{identity}.fits"}], "memberCompleteness": "unit-candidate", "matchingEvidenceScope": "batch"}
        sources = [{"layerId": layer_id, "surveyId": "gaia" if layer_id.startswith("gaia-") else "euclid", "releaseId": "fixture-release",
                    "product": "Frozen selected product", "matchingRegions": matching_regions, "geometryPrecision": "estimated", "completeness": "incomplete",
                    "sourceUnitSummary": {"unitKind": "target", "matchedUnitCount": 1, "truncated": False}, "sourceUrl": "https://example.test/archive/"}
                   for layer_id in body["layerIds"]]
        response = {"schemaVersion": 2, "available": True, "precision": "estimated", "truncated": not second_page,
                    "requested": {"layerIds": body["layerIds"], "rectangle": rectangle, "region": region}, "sources": sources,
                    "edges": [], "sourceFiles": [], "notes": ["Synthetic conservative candidate evidence, not inventory completeness"],
                    "nativeUnitIndexRevision": "fixture-native-revision", "querySnapshot": {"id": snapshot, "expiresAt": "2099-01-01T00:00:00Z",
                    "queryExhausted": second_page, "inventoryComplete": False},
                    "downloadPlan": {"schemaVersion": 1, "spatialUnits": [unit], "files": [], "entrypoints": [], "truncated": not second_page, "warnings": []}}
        if preview:
            response["preview"] = {"limit": 6, "shown": 1, "omitted": 1, "hasMore": True}
        else:
            response["page"] = {"pageSize": 100, "shown": 1, "omitted": 0 if second_page else 1, "hasMore": not second_page}
            if not second_page:
                response["page"]["nextCursor"] = f"cursor-{start}"
        return response

    def region_api(route):
        nonlocal unlocked
        request = route.request
        path = urlparse(request.url).path
        if path == "/api/v1/access/unlock":
            assert request.headers.get("x-assets-api-key") == "synthetic-region-key"
            unlocked = True
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"expiresAt": "2099-01-01T00:00:00Z"}))
        elif path == "/api/v1/coverage/reverse-lookup":
            body = request.post_data_json
            reverse_requests.append(body)
            assert "rectangle" in body and "order" not in body and "cells" not in body, body
            assert body.get("preview") or unlocked, "full fixture queries must follow the real unlock dialog"
            response = response_for(body)
            if body["rectangle"]["raStart"] in held_starts or body.get("cursor") in held_cursors:
                held.append((route, response))
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(response))
        else:
            if path.startswith("/api/v1/coverage/overlap"):
                overlap_requests.append(path)
            mock_api(route)

    page.route("**/api/v1/**", region_api)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    group = page.locator("#coverage-survey-euclid")
    group.locator(".coverage-layer-name").click()
    group.locator('input[data-product-layer-id="euclid-euclid-ero-native"]').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    page.locator("#coverage-layers-toggle").click()
    page.wait_for_timeout(700)
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("e")
    panel = page.locator("#coverage-region-panel")
    expect(panel).to_be_visible()
    expect(page.locator("#coverage-region-draw")).to_have_attribute("aria-pressed", "true")
    assert not reverse_requests, "E without selected cells opens drawing without an inspection or a lookup"
    assert "IPix" not in page.locator("#coverage-detail-title").inner_text()

    # Actual canvas events, not callbacks: drawing must not rotate the camera.
    pose = page.locator("#coverage-status-camera").inner_text()
    points = [(650, 490), (750, 560)]
    assert all(page.evaluate("p => document.elementFromPoint(...p)?.id === 'coverage-canvas'", point) for point in points)
    page.mouse.move(*points[0]); page.mouse.down(); page.mouse.move(*points[1], steps=12); page.mouse.up()
    expect(page.locator("#coverage-region-draw")).to_have_attribute("aria-pressed", "false")
    for field in ["region-ra-start", "region-ra-end", "region-dec-min", "region-dec-max"]:
        assert page.locator("#" + field).input_value(), f"drawing must populate {field}"
    assert page.locator("#coverage-status-camera").inner_text() == pose, "rectangle drawing must suspend orbit navigation"
    page.mouse.move(*points[0]); page.mouse.down(); page.mouse.move(700, 510, steps=8); page.mouse.up()
    page.wait_for_function("pose => document.querySelector('#coverage-status-camera').textContent !== pose", arg=pose)
    page.locator("#coverage-region-draw").click()
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Escape")
    expect(page.locator("#coverage-region-draw")).to_have_attribute("aria-pressed", "false")
    page.locator("#coverage-region-close").click()
    expect(panel).to_be_hidden()
    page.locator("#coverage-region-toggle").click()

    def submit(start, end=10):
        for field, value in {"region-ra-start": start, "region-ra-end": end, "region-dec-min": -5, "region-dec-max": 5}.items():
            page.locator("#" + field).fill(str(value))
        page.locator("#coverage-region-query").click()

    page.locator("#region-ra-start").focus()
    page.keyboard.press("e")
    assert page.locator("#coverage-region-draw").get_attribute("aria-pressed") == "false", "input-focused E must not start drawing"
    assert not reverse_requests
    submit(350)
    expect(page.locator("#coverage-region-results .overlap-spatial-unit")).to_have_count(1)
    assert reverse_requests[-1]["layerIds"] == ["euclid-euclid-ero-native"], "query scope is exactly the checked product, not all DRs"
    expect(page.locator("#coverage-region-query-meta")).to_contain_text("O4 / O10")
    expect(page.locator("#coverage-region-query-meta")).to_contain_text("Cell budget reached")
    expect(page.locator("#coverage-region-query-meta")).to_contain_text("Anonymous preview")
    expect(page.locator("#coverage-region-status")).to_contain_text("preview is not a full manifest")

    def download(format):
        with page.expect_download() as download_event:
            page.locator(f'#coverage-region-results button[data-export-format="{format}"]').click()
        result = download_event.value
        content = Path(result.path()).read_text(encoding="utf-8-sig")
        return result.suggested_filename, json.loads(content) if format == "json" else list(csv.DictReader(io.StringIO(content)))

    json_name, preview = download("json")
    csv_name, preview_rows = download("csv")
    assert json_name == "atlas-region-preview.json" and csv_name == "atlas-region-preview.csv"
    assert preview["schemaVersion"] == 2 and preview["preview"]["limit"] == 6
    native = next(row for row in preview_rows if row["item_kind"] == "spatial-unit")
    assert native["tile_id"] == preview["downloadPlan"]["spatialUnits"][0]["unitId"]
    assert json.loads(native["matching_regions"]) == preview["downloadPlan"]["spatialUnits"][0]["matchingRegions"]
    assert json.loads(native["query_region"]) == preview["requested"]["region"]
    assert native["order"] == "" and native["region_budget_limited"] == "true"
    assert len([row for row in preview_rows if row["item_kind"] == "source-status"]) == 1

    actions = page.locator("#coverage-region-results > .coverage-region-actions button")
    actions.first.click()
    expect(page.locator(".download-unlock-dialog")).to_be_visible()
    page.locator("#unlock-api-key").fill("synthetic-region-key")
    page.locator(".unlock-btn-submit").click()
    expect(page.locator(".download-unlock-dialog")).to_have_count(0)
    expect(page.locator("#coverage-region-query-meta")).to_contain_text("Native units loaded")
    first_authorized = next(body for body in reverse_requests if not body.get("preview"))
    assert first_authorized.get("querySnapshotId") == preview["querySnapshot"]["id"], "unlock must upgrade the same frozen preview snapshot"
    json_name, manifest = download("json")
    csv_name, manifest_rows = download("csv")
    assert json_name == "atlas-region-manifest.json" and csv_name == "atlas-region-manifest.csv"
    assert manifest["querySnapshot"]["id"] == preview["querySnapshot"]["id"]
    assert manifest["page"]["hasMore"] is False and manifest["querySnapshot"]["inventoryComplete"] is False
    assert len(manifest["downloadPlan"]["spatialUnits"]) == 2, "authorized export must drain the root snapshot cursor"
    assert {row["tile_id"] for row in manifest_rows if row["item_kind"] == "spatial-unit"} == {unit["unitId"] for unit in manifest["downloadPlan"]["spatialUnits"]}
    assert any(body.get("cursor") == "cursor-350" for body in reverse_requests)
    assert not any("synthetic-region-key" in json.dumps(body) for body in reverse_requests), "API key is not retained in query payloads"

    # A different target cancels an in-flight query; its late response is ignored.
    held_starts.add(351)
    submit(351)
    page.wait_for_function("() => document.querySelector('#coverage-region-results .hud-query-progress') !== null")
    for _ in range(40):
        if held:
            break
        page.wait_for_timeout(50)
    assert held, "fixture must hold an actual sent region query"
    submit(352)
    expect(page.locator("#coverage-region-results .overlap-spatial-unit-title")).to_contain_text("region-a-352")
    old_route, old_response = held.pop()
    old_route.fulfill(status=200, content_type="application/json", body=json.dumps(old_response))
    page.wait_for_timeout(100)
    assert "region-a-351" not in page.locator("#coverage-region-results").inner_text(), "stale response must not replace the new region target"
    held_starts.add(353)
    submit(353)
    for _ in range(40):
        if held:
            break
        page.wait_for_timeout(50)
    assert held
    page.locator("#coverage-region-cancel").click()
    expect(page.locator("#coverage-region-status")).to_contain_text("Cancelled")
    old_route, old_response = held.pop()
    old_route.fulfill(status=200, content_type="application/json", body=json.dumps(old_response))
    page.wait_for_timeout(100)
    assert "region-a-353" not in page.locator("#coverage-region-results").inner_text()

    # Two surveys target the same region independently, without overlap discovery.
    page.locator("#coverage-region-close").click()
    page.locator("#coverage-layers-toggle").click()
    gaia = page.locator("#coverage-survey-gaia")
    gaia.locator(".coverage-layer-name").click()
    gaia.locator('input[data-product-layer-id="gaia-gaia-dr3-main"]').check(force=True)
    page.locator("#coverage-layers-toggle").click()
    page.locator("#coverage-region-toggle").click()
    submit(354)
    expect(page.locator("#coverage-region-results .overlap-spatial-unit-title")).to_contain_text("region-a-354")
    assert set(reverse_requests[-1]["layerIds"]) == {"euclid-euclid-ero-native", "gaia-gaia-dr3-main"}
    assert "gaia-dr3" in page.locator("#coverage-region-layers").text_content()

    # Cancelling an actual cursor drain must not finish or download a partial file.
    held_cursors.add("cursor-354")
    downloads = []
    page.on("download", lambda event: downloads.append(event.suggested_filename))
    page.locator('#coverage-region-results button[data-export-format="json"]').click()
    for _ in range(40):
        if held:
            break
        page.wait_for_timeout(50)
    assert held, "full export must reach its held continuation cursor"
    page.locator("#coverage-region-results > .coverage-region-actions button").filter(has_text="Cancel export").click()
    expect(page.locator("#coverage-region-status")).to_contain_text("Cancelled")
    old_route, old_response = held.pop()
    old_route.fulfill(status=200, content_type="application/json", body=json.dumps(old_response))
    page.wait_for_timeout(150)
    assert not downloads, "cancelled full manifest cursor drain must not download a partial plan"
    expect(page.locator('#coverage-region-results button[data-export-format="json"]')).to_be_enabled()
    screenshot_root = os.environ.get("ASSETS_ATLAS_SCREENSHOT_DIR")
    if screenshot_root:
        page.screenshot(path=str(Path(screenshot_root) / "atlas-region-query.png"))
    assert not overlap_requests, f"ordinary rectangle queries must not request overlap/details: {overlap_requests}"
    assert not errors, f"Region query browser errors: {errors}"
    print("Rectangle region browser smoke passed (synthetic API/unlock fixtures; not real authorization verification)")
    page.close()


def atlas_display_order_smoke(browser, base_url: str) -> None:
    screenshot_root = os.environ.get("ASSETS_ATLAS_SCREENSHOT_DIR")
    if screenshot_root:
        Path(screenshot_root).mkdir(parents=True, exist_ok=True)
    layer_specs = [
        ("euclid-ero-native", "euclid", "euclid-ero", "Early Release Observations", "#d95f59"),
        ("euclid-ero-vis", "euclid", "euclid-ero", "ERO VIS", "#d95f59"),
        ("euclid-q1-vis", "euclid", "euclid-q1", "Q1 VIS", "#d95f59"),
        ("gaia-dr3-main", "gaia", "gaia-dr3", "Gaia DR3 main source presence", "#4f8fc8"),
    ]
    display_orders = [*range(4, 10), 11]
    native_display_orders = list(range(4, 12))
    lower_order_display_orders = list(range(4, 11))
    layers = []
    surveys_by_id = {}
    display_revisions = {}
    tile_index_requests = []
    block_requests = []
    order_11_tiles = [{"start": 2267, "end": 2268}, {"start": 8984, "end": 8985}]
    for index, (suffix, survey_id, release_id, product_name, color) in enumerate(layer_specs):
        layer_id = f"{survey_id}-{suffix}"
        product_id = f"{layer_id}-product"
        display_revision = f"display-revision-{index}"
        display_revisions[layer_id] = display_revision
        layers.append({
            "layerId": layer_id,
            "productId": product_id,
            "surveyId": survey_id,
            "releaseId": release_id,
            "product": product_name,
            "modality": "imaging" if survey_id == "euclid" else "catalog",
            "color": color,
            "availableOrders": [4],
            "displayOrders": lower_order_display_orders if suffix == "euclid-ero-vis" or suffix == "euclid-q1-vis" else native_display_orders if suffix == "euclid-ero-native" else display_orders,
            "displayRevision": display_revision,
            "nativeMaxOrder": 10 if suffix == "euclid-ero-vis" or suffix == "euclid-q1-vis" else 11,
            "overviewOrder": 4,
            "maxOrder": 10 if suffix == "euclid-ero-vis" or suffix == "euclid-q1-vis" else 11,
            "cellCount": 1,
            "areaDeg2": 1,
            "tileScheme": "ipix-range-4096",
            "tileIdsByOrder": {"4": [0]},
            "revision": f"revision-{index}",
        })
        product = {
            "name": product_name,
            "modality": "imaging" if survey_id == "euclid" else "catalog",
            "description": product_name,
            "status": "acquired",
            "sourceUrl": "https://example.org/",
            "productId": product_id,
            "coverage": {"layerId": layer_id, "availableOrders": [4], "overviewOrder": 4, "maxOrder": 10 if suffix == "euclid-ero-vis" or suffix == "euclid-q1-vis" else 11},
        }
        survey = surveys_by_id.get(survey_id)
        if survey is None:
            survey = {
                "id": survey_id,
                "name": survey_id.upper(),
                "mission": survey_id.upper(),
                "color": color,
                "description": product_name,
                "modalities": [],
                "releases": [],
                "imageUrl": "",
                "statistics": {"publicProducts": 0, "acquired": 0, "overviewOnly": 0, "awaitingGeometry": 0, "notApplicable": 0, "footprintCells": 0},
                "assets": [],
            }
            surveys_by_id[survey_id] = survey
        survey["modalities"] = sorted(set(survey["modalities"]) | {product["modality"]})
        release = next((entry for entry in survey["releases"] if entry["id"] == release_id), None)
        if release is None:
            release = {"id": release_id, "label": release_id, "kind": "survey", "modalities": [product["modality"]], "products": []}
            survey["releases"].append(release)
        release["products"].append(product)
        survey["statistics"]["publicProducts"] += 1
        survey["statistics"]["acquired"] += 1
        survey["statistics"]["footprintCells"] += 1

    catalog = {"schemaVersion": 2, "coordinateFrame": "ICRS", "ordering": "NESTED", "tileScheme": "ipix-range-4096", "revision": "atlas-display-smoke", "layers": layers}
    survey_index = {"schemaVersion": 1, "generatedAt": "2026-10-15T00:00:00Z", "surveys": list(surveys_by_id.values()), "sharedAssets": []}
    asset_catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-10-15T00:00:00Z",
        "bundle": {"id": "atlas-display-smoke", "sha256": "a" * 64},
        "statistics": {"releases": 3, "acquired": 4, "rawMocFiles": 4, "packages": 0, "totalBytes": 0},
        "files": [],
    }
    overlap_requests = []
    details_requests = []
    oversized_order_five_index = False
    held_display_orders = set()
    held_display_routes = []
    overlap_has_components = False
    held_overlap_orders = set()
    held_overlap_routes = []
    context_fixture = False
    wide_context_fixture = False
    target_lock_fixture = False
    drawer_region_fixture = False

    def overlap_component(order):
        component = {"id": "C01", "order": order, "cells": [0], "bounds": {"areaDeg2": 1, "raMin": 44, "raMax": 46, "decMin": 0, "decMax": 2}}
        if target_lock_fixture:
            component["evidenceLookup"] = {"endpoint": "/api/v1/coverage/reverse-lookup", "layerIds": ["euclid-euclid-ero-native", "gaia-gaia-dr3-main"], "order": order, "precision": "estimated", "deferred": False}
        return component

    def drawer_components(order):
        # Synthetic neighboring pairs with real, explicit NESTED identities.
        sources = [{"surveyId": "euclid", "releaseId": "euclid-ero", "product": "Synthetic regional image", "modality": "imaging"}, {"surveyId": "gaia", "releaseId": "gaia-dr3", "product": "Synthetic regional catalog", "modality": "catalog"}]
        return [{"id": component_id, "order": order, "cells": cells, "bounds": {"areaDeg2": 2, "raMin": 0, "raMax": 90, "decMin": 0, "decMax": 90}, "surveys": sources} for component_id, cells in [("C01", [0, 1]), ("C02", [4, 5])]]

    def fulfill_json(route, value, status: int = 200) -> None:
        route.fulfill(status=status, content_type="application/json", body=json.dumps(value))

    def mock_api(route) -> None:
        request = route.request
        parsed = urlparse(request.url)
        if parsed.path == "/api/v1/assets":
            fulfill_json(route, asset_catalog)
        elif parsed.path == "/api/v1/surveys":
            fulfill_json(route, survey_index)
        elif parsed.path == "/api/v1/coverage/catalog":
            fulfill_json(route, catalog)
        elif parsed.path.startswith("/api/v1/coverage/blocks/"):
            layer_id = parsed.path.rsplit("/", 1)[-1]
            query = parse_qs(parsed.query)
            order = int(query["order"][0])
            display_revision = display_revisions[layer_id]
            if query.get("tiles") == ["1"]:
                tile_index_requests.append({"layerId": layer_id, "order": order})
                ranges = [{"start": 0, "end": 100}] if oversized_order_five_index and order == 5 else order_11_tiles if order == 11 else [{"start": 0, "end": 1}]
                if wide_context_fixture and layer_id.startswith("gaia-") and order >= 6:
                    ranges = [{"start": 0, "end": 12 * 4 ** (order - 6)}]
                fulfill_json(route, {"layerId": layer_id, "order": order, "tileSize": 4096, "ranges": ranges, "totalTiles": sum(entry["end"] - entry["start"] for entry in ranges), "displayRevision": display_revision})
            else:
                block_requests.append({"layerId": layer_id, "order": order, "tile": int(query.get("tile", ["0"])[0])})
                cells = [0, 1 if layer_id.startswith("euclid-") else 2] if context_fixture else [0]
                if wide_context_fixture and layer_id.startswith("gaia-") and order == 8:
                    start = int(query.get("tile", ["0"])[0]) * 4096
                    cells = list(range(start, start + 4096))
                block = {"layerId": layer_id, "order": order, "tileId": int(query.get("tile", ["0"])[0]), "cells": cells, "sha256": "b" * 64, "revision": f"revision-{layer_id}", "displayRevision": display_revision, "nativeMaxOrder": 11, "projection": "native-moc"}
                if order in held_display_orders:
                    held_display_routes.append((route, block))
                else:
                    fulfill_json(route, block)
        elif parsed.path == "/api/v1/coverage/overlap" and request.method == "POST":
            body = request.post_data_json
            overlap_requests.append(body)
            order = body["requestedOrder"]
            result = {"commonOrder": order, "pixels": [0] if overlap_has_components else [], "components": [overlap_component(order)] if overlap_has_components else []}
            if drawer_region_fixture:
                components = drawer_components(order)
                result = {"commonOrder": order, "pixels": [cell for component in components for cell in component["cells"]], "components": components}
            if order in held_overlap_orders:
                held_overlap_routes.append((route, result))
            else:
                fulfill_json(route, result)
        elif parsed.path == "/api/v1/coverage/overlap/details":
            order = request.post_data_json["requestedOrder"]
            details_requests.append(request.post_data_json)
            component = next((entry for entry in drawer_components(order) if entry["id"] == request.post_data_json["componentId"]), overlap_component(order)) if drawer_region_fixture else overlap_component(order)
            fulfill_json(route, {"schemaVersion": 1, "component": component, "publicSources": [], "assetsEvidence": [], "warehouseEvidence": [], "method": {"summary": "Browser test fixture"}, "reverseLookup": {"endpoint": "/api/v1/coverage/reverse-lookup", "layerIds": [], "order": order, "precision": "estimated", "deferred": False}})
        elif parsed.path == "/api/v1/coverage/reverse-lookup":
            if target_lock_fixture:
                order = request.post_data_json["order"]
                units = [{"layerId": "euclid-euclid-ero-native", "productId": "euclid-euclid-ero-native-product", "surveyId": "euclid", "releaseId": "euclid-ero", "product": "Synthetic scroll fixture", "unitKind": "field", "unitId": f"scroll-field-{index}", "order": order, "nside": 2 ** order, "matchingCells": [0], "precision": "estimated"} for index in range(6)]
                fulfill_json(route, {"available": True, "precision": "estimated", "truncated": False, "edges": [], "files": [], "downloadPlan": {"schemaVersion": 1, "spatialUnits": units, "files": [], "entrypoints": [], "truncated": False, "warnings": []}})
            else:
                fulfill_json(route, {"available": False, "precision": "estimated", "truncated": False, "edges": [], "files": []})
        else:
            fulfill_json(route, {})

    atlas_rectangle_query_smoke(browser, base_url, mock_api)
    atlas_layer_tooltip_smoke(browser, base_url, mock_api)
    overlap_has_components = True
    target_lock_fixture = True
    atlas_target_lock_scroll_smoke(browser, base_url, mock_api)
    target_lock_fixture = False
    drawer_region_fixture = True
    atlas_drawer_region_smoke(browser, base_url, mock_api, details_requests)
    drawer_region_fixture = False
    overlap_has_components = False
    overlap_requests.clear()
    details_requests.clear()
    tile_index_requests.clear()
    block_requests.clear()

    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.add_init_script("""(() => {
        window.atlasWebglContexts = 0;
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
            if (this.id === 'coverage-canvas' && kind.startsWith('webgl')) window.atlasWebglContexts++;
            return getContext.call(this, kind, ...args);
        };
    })();""")
    page.route("**/api/v1/**", mock_api)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    slider = page.locator("#coverage-display-order")
    assert slider.evaluate("input => input.closest('.coverage-tools') !== null"), "display-order slider must live with the sky tools"
    assert page.locator("#coverage-layers #coverage-display-order").count() == 0, "display order must not be inside the survey list"
    expect(slider).to_be_disabled()
    expect(page.locator("#coverage-display-order-value")).to_have_text("O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O4")
    order_label = page.locator('label[for="coverage-display-order"]')
    locale_toggle = page.locator("[data-locale-toggle]").first
    locale_toggle.click()
    expect(order_label).to_have_text("显示阶数")
    expect(slider).to_have_attribute("aria-label", "显示阶数")
    locale_toggle.click()
    expect(order_label).to_have_text("Display order")
    control = page.locator(".coverage-display-order-control")
    assert control.bounding_box()["height"] == page.locator("#coverage-reset").bounding_box()["height"], "order control and adjacent buttons must have the same height"
    dark_surface = control.evaluate("element => getComputedStyle(element).backgroundColor")
    theme_toggle = page.locator("[data-theme-toggle]").first
    theme_toggle.click()
    light_surface = control.evaluate("element => getComputedStyle(element).backgroundColor")
    assert light_surface != dark_surface, "display-order control must follow the active theme"
    theme_toggle.click()
    page.locator("#coverage-layers-toggle").click()
    euclid = page.locator("#coverage-survey-euclid")
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == "false", "DR list must start collapsed"
    assert euclid.locator(".coverage-release-list").is_hidden(), "DR rows must be hidden until expanded"
    euclid.locator(".coverage-layer-name").click()
    assert euclid.locator(".coverage-release-list").is_visible(), "clicking the survey row must expand its DR list"
    release_input = euclid.locator('input[data-release-id="euclid-ero"]')
    release_input.check(force=True)
    ero_product = euclid.locator('input[data-product-layer-id="euclid-euclid-ero-vis"]')
    ero_native_product = euclid.locator('input[data-product-layer-id="euclid-euclid-ero-native"]')
    q1_product = euclid.locator('input[data-product-layer-id="euclid-euclid-q1-vis"]')
    assert ero_product.is_checked() and ero_native_product.is_checked() and not q1_product.is_checked(), "a DR checkbox must select only that release"
    expect(slider).to_have_attribute("aria-valuetext", "O4")
    expect(page.locator("#coverage-display-order-value")).to_have_text("O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O10")
    survey_checkbox = euclid.locator('input[data-survey-id="euclid"]:not([data-release-id])')
    assert survey_checkbox.evaluate("input => input.indeterminate"), "survey state must reflect a partial DR selection"
    survey_checkbox.check(force=True)
    assert ero_product.is_checked() and ero_native_product.is_checked() and q1_product.is_checked(), "the survey checkbox must select every DR product"
    survey_checkbox.uncheck(force=True)
    assert not ero_product.is_checked() and not ero_native_product.is_checked() and not q1_product.is_checked(), "the survey checkbox must clear every DR product"
    expect(slider).to_be_disabled()

    euclid.locator("[data-expand-survey]").click()
    assert euclid.locator(".coverage-release-list").is_hidden(), "the expander must collapse the DR list"
    page.locator("#coverage-layer-search").fill("q1")
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == "true", "matching DR search must expand its survey"
    assert euclid.locator('input[data-product-layer-id="euclid-euclid-q1-vis"]').is_visible()
    page.locator("#coverage-layer-search").fill("")
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == "false", "clearing search must restore the previous collapsed state"

    euclid.locator(".coverage-layer-name").click()
    euclid.locator('input[data-release-id="euclid-ero"]').check(force=True)
    expect(slider).to_have_attribute("aria-valuetext", "O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O10")
    tile_index_requests.clear()
    block_requests.clear()
    ero_product.uncheck(force=True)
    expect(slider).to_have_attribute("aria-valuetext", "O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O11")
    gaia = page.locator("#coverage-survey-gaia")
    gaia.locator(".coverage-layer-name").click()
    gaia.locator('input[data-release-id="gaia-dr3"]').check(force=True)
    assert gaia.locator('input[data-product-layer-id="gaia-gaia-dr3-main"]').is_checked(), "release selection must update its product control"
    expect(slider).to_have_attribute("aria-valuetext", "O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O11")
    assert tile_index_requests == [], f"O4 display should not fetch high-order tile indexes, got {tile_index_requests}"
    slider.focus()
    expanded_before_handle = euclid.locator("[data-expand-survey]").get_attribute("aria-expanded")
    euclid.locator(".coverage-layer-handle").click()
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == expanded_before_handle, "the drag handle must not toggle the DR list"
    expect(slider).to_have_attribute("aria-valuetext", "O4")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O11")
    tile_index_requests.clear()
    block_requests.clear()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    context_count = page.evaluate("window.atlasWebglContexts")
    held_display_orders.add(8)
    for _ in range(4):
        slider.press("ArrowRight")
    expect(slider).to_have_attribute("aria-valuetext", "O8")
    page.wait_for_timeout(700)
    assert tile_index_requests and all(request["order"] == 8 for request in tile_index_requests), f"rapid O4 to O8 adjustment must request only O8, got {tile_index_requests}"
    assert len(held_display_routes) == 2, "wait for both selected products' complete batches"
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    assert page.evaluate("window.atlasWebglContexts") == context_count, "loading a new order must keep the current renderer and coverage"
    for route, block in held_display_routes[:-1]:
        fulfill_json(route, block)
    page.wait_for_timeout(100)
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    fulfill_json(*held_display_routes[-1])
    held_display_routes.clear()
    held_display_orders.clear()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O8")
    assert page.evaluate("window.atlasWebglContexts") == context_count, "committing a complete order must reuse the renderer"

    held_display_orders.update({6, 7})
    slider.press("ArrowLeft")
    slider.press("ArrowLeft")
    page.wait_for_timeout(700)
    assert len([block for _, block in held_display_routes if block["order"] == 6]) == 2
    slider.press("ArrowRight")
    page.wait_for_timeout(700)
    assert len([block for _, block in held_display_routes if block["order"] == 7]) == 2
    for route, block in held_display_routes:
        if block["order"] == 7:
            fulfill_json(route, block)
    expect(page.locator("#coverage-status-nside")).to_contain_text("O7")
    for route, block in held_display_routes:
        if block["order"] == 6:
            fulfill_json(route, block)
    held_display_routes.clear()
    held_display_orders.clear()
    page.wait_for_timeout(100)
    expect(page.locator("#coverage-status-nside")).to_contain_text("O7")
    expect(page.locator("#coverage-state")).to_contain_text("O7")

    slider.press("Home")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    tile_index_requests.clear()
    block_requests.clear()
    box = slider.bounding_box()
    left, right = box["x"] + 8, box["x"] + box["width"] - 8
    y = box["y"] + box["height"] / 2
    page.mouse.move(left, y)
    page.mouse.down()
    for index in range(1, 5):
        page.mouse.move(left + (right - left) * index / 6, y, steps=3)
        page.wait_for_timeout(100)
    assert not tile_index_requests and not block_requests, "pointer dragging must only preview, even when held between steps"
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    page.mouse.up()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O8")
    assert not tile_index_requests and not block_requests, "returning to cached O8 should reuse its complete blocks"
    slider.press("Home")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    with page.expect_response(lambda response: "/api/v1/coverage/blocks/" in response.url and "order=11" in response.url and "tiles=1" in response.url, timeout=30000) as maximum_display_response:
        slider.press("End")
    assert maximum_display_response.value.status == 200
    expect(slider).to_have_attribute("aria-valuetext", "O11")
    expect(page.locator("#coverage-state")).to_contain_text("O11", timeout=30000)
    assert {request["layerId"] for request in tile_index_requests if request["order"] == 11} == {
        "euclid-euclid-ero-native", "gaia-gaia-dr3-main"
    }, f"O11 slider selection must request both selected product indexes, got {tile_index_requests}"
    assert block_requests and all(request["order"] == 11 for request in block_requests), f"O11 slider selection must fetch O11 blocks, got {block_requests}"
    tile_index_requests.clear()
    block_requests.clear()
    with page.expect_response(lambda response: "/api/v1/coverage/blocks/" in response.url and "order=9" in response.url and "tiles=1" in response.url, timeout=30000) as manual_display_response:
        slider.press("ArrowLeft")
    assert manual_display_response.value.status == 200
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    expect(page.locator("#coverage-state")).to_contain_text("O9", timeout=30000)
    assert block_requests and all(request["order"] == 9 for request in block_requests), f"manual O9 slider value must fetch O9 blocks, got {block_requests}"
    locale_toggle.click()
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    locale_toggle.click()
    expect(slider).to_have_attribute("aria-valuetext", "O9")

    oversized_order_five_index = True
    tile_index_requests.clear()
    block_requests.clear()
    slider.press("Home")
    with page.expect_response(lambda response: "/api/v1/coverage/blocks/" in response.url and "order=5" in response.url and "tiles=1" in response.url, timeout=30000) as budget_index_response:
        slider.press("ArrowRight")
    assert budget_index_response.value.status == 200
    expect(slider).to_have_attribute("aria-valuetext", "O5")
    expect(page.locator("#coverage-state")).to_contain_text("192", timeout=30000)
    budget_message = page.locator("#coverage-state").inner_text()
    assert "200" in budget_message and ("selected layers" in budget_message or "所有选中图层" in budget_message), f"budget warning should explain the aggregate block count, got {budget_message!r}"
    assert tile_index_requests and all(request["order"] == 5 for request in tile_index_requests), f"O5 budget check must request the selected products' real tile indexes, got {tile_index_requests}"
    assert not block_requests, f"over-budget coverage must not draw partial product blocks, got {block_requests}"
    expect(page.locator("#coverage-status-nside")).to_contain_text("O9")

    oversized_order_five_index = False
    slider.press("End")
    expect(slider).to_have_attribute("aria-valuetext", "O11")
    expect(page.locator("#coverage-state")).to_contain_text("O11", timeout=30000)
    slider.press("ArrowLeft")
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    expect(page.locator("#coverage-state")).to_contain_text("O9", timeout=30000)

    if page.locator("#coverage-layers").is_hidden():
        page.locator("#coverage-layers-toggle").click()
    expect(euclid.locator(".coverage-release-list")).to_be_visible()
    euclid.locator('input[data-release-id="euclid-q1"]').check()
    expect(page.locator("#coverage-display-order-max")).to_have_text("O9")
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    q1_product.uncheck()
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    expect(page.locator("#coverage-display-order-max")).to_have_text("O11")
    page.evaluate("document.activeElement.blur()")
    with page.expect_response(lambda response: response.url.endswith("/api/v1/coverage/overlap"), timeout=30000) as overlap_response:
        page.keyboard.press("g")
    assert overlap_response.value.status == 200
    assert overlap_requests and overlap_requests[-1]["requestedOrder"] == 9
    assert overlap_requests[-1]["strictOrder"] is True
    assert set(overlap_requests[-1]["layerIds"]) == {"euclid-euclid-ero-native", "gaia-gaia-dr3-main"}
    assert overlap_requests[-1]["viewTiles"]["order"] == 3
    assert len(overlap_requests[-1]["viewTiles"]["tiles"]) <= 192
    # G keeps the survey coverage at the selected display order.
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "9")
    expect(order_label).to_have_text("Overlap order")
    block_requests.clear()
    with page.expect_response(lambda response: response.url.endswith("/api/v1/coverage/overlap"), timeout=30000) as manual_overlap_response:
        slider.press("ArrowLeft")
    assert manual_overlap_response.value.status == 200
    assert overlap_requests[-1]["requestedOrder"] == 8, "manual slider changes must update strict overlap order"
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    slider.press("Home")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    overlap_has_components = True
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator("#overlap-expand")).to_be_visible()
    page.locator("#overlap-expand").click()
    expect(page.locator("#overlap-drawer")).to_be_visible()
    assert slider.evaluate("input => input.closest('#overlap-drawer-tools') !== null"), "the same order control must move into the open overlap drawer"
    page.wait_for_timeout(1200)
    assert len(details_requests) == 1, f"opening the drawer must request the component details once, got {details_requests}"
    # An unchanged refresh (same surveys, layers, view and component) must neither re-request
    # the details nor swap the drawer content for a loading skeleton.
    drawer_content = page.locator("#overlap-drawer-content")
    drawer_content.evaluate("node => { window.drawerLoadingSeen = false; new MutationObserver(() => { if (node.querySelector('.overlap-drawer-loading')) window.drawerLoadingSeen = true; }).observe(node, { childList: true, subtree: true }); }")
    page.evaluate("document.activeElement.blur()")
    page.mouse.wheel(0, -1)
    page.wait_for_timeout(1500)
    assert len(details_requests) == 1, f"an unchanged overlap refresh must not re-request the details, got {len(details_requests)}"
    assert not page.evaluate("window.drawerLoadingSeen"), "an unchanged overlap refresh must not flash the drawer loading state"
    overlap_requests.clear()
    block_requests.clear()
    held_overlap_orders.add(8)
    camera_before_order_change = page.locator("#coverage-status-camera").inner_text()
    box = slider.bounding_box()
    left, right = box["x"] + 8, box["x"] + box["width"] - 8
    y = box["y"] + box["height"] / 2
    page.mouse.move(left, y)
    page.mouse.down()
    page.mouse.move(left + (right - left) * 4 / 6, y, steps=16)
    assert not overlap_requests, "drawer pointer dragging must only preview the target order"
    page.mouse.up()
    deadline = time.monotonic() + 10
    while not held_overlap_routes and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert [body["requestedOrder"] for body in overlap_requests] == [8], f"drawer slider must request only the final overlap order, got {overlap_requests}"
    assert len(held_overlap_routes) == 1
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    expect(page.locator("#overlap-drawer-display-state")).to_contain_text("O8")
    fulfill_json(*held_overlap_routes.pop())
    held_overlap_orders.clear()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O8")
    expect(page.locator("#overlap-drawer-title")).to_contain_text("O8")
    expect(slider).to_be_focused()
    page.wait_for_timeout(1000)
    assert len(overlap_requests) == 1, "refreshing overlap order must not focus the camera and trigger another query"
    assert page.locator("#coverage-status-camera").inner_text() == camera_before_order_change, "order changes must preserve the focused camera"
    assert all(request["order"] == 8 for request in block_requests), f"an overlap order change may only load coverage at that order, got {block_requests}"
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "8")
    expect(page.locator("#overlap-drawer-display-state")).to_contain_text("OVERVIEW O8")
    if screenshot_root:
        page.screenshot(path=str(Path(screenshot_root) / "atlas-drawer-desktop.png"))
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "Atlas mobile layout must not overflow horizontally"
    assert page.locator("#coverage-display-order").is_visible(), "display-order slider must remain visible on mobile"
    slider_box = slider.bounding_box()
    assert slider_box and slider_box["x"] >= 0 and slider_box["x"] + slider_box["width"] <= 390, f"mobile display-order slider must fit the viewport, got {slider_box}"
    assert slider.evaluate("input => document.elementFromPoint(input.getBoundingClientRect().x + 20, input.getBoundingClientRect().y + 5) === input"), "the mobile drawer slider must be reachable above its content"
    slider.press("ArrowLeft")
    expect(page.locator("#overlap-drawer-title")).to_contain_text("O7")
    mobile_menu = page.locator("[data-mobile-menu-toggle]")
    mobile_menu.click()
    theme_toggle.click()
    locale_toggle.click()
    mobile_menu.click()
    expect(order_label).to_have_text("重合阶数")
    expect(slider).to_have_attribute("aria-label", "重合阶数")
    assert page.locator("#overlap-drawer").is_visible()
    if screenshot_root:
        page.screenshot(path=str(Path(screenshot_root) / "atlas-drawer-mobile.png"))
    page.locator("#overlap-drawer-close").click()
    assert slider.evaluate("input => input.closest('.coverage-tools') !== null"), "closing the drawer must return the control to the sky toolbar"
    expect(slider).to_have_attribute("aria-valuetext", "O7")
    assert not errors, f"Atlas browser errors: {errors}"
    page.close()

    # When the high-order source view exceeds its budget, G keeps the coverage
    # already drawn. Only the strict intersection uses the chosen order.
    wide_context_fixture = True
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.route("**/api/v1/**", mock_api)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    for survey_id, layer_id in [("euclid", "euclid-euclid-ero-native"), ("gaia", "gaia-gaia-dr3-main")]:
        group = page.locator("#coverage-survey-" + survey_id)
        group.locator(".coverage-layer-name").click()
        group.locator('input[data-product-layer-id="' + layer_id + '"]').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    slider = page.locator("#coverage-display-order")
    for _ in range(4):
        slider.press("ArrowRight")
    expect(page.locator("#coverage-state")).to_contain_text(re.compile(r"192|65,536"), timeout=30000)
    block_requests.clear()
    overlap_requests.clear()
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator("#coverage-state")).to_contain_text("COMMON ORDER O8", timeout=30000)
    expect(page.locator("#overlap-expand")).to_be_visible(timeout=30000)
    expect(page.locator("#coverage-status-nside")).to_contain_text("O8")
    assert [body["requestedOrder"] for body in overlap_requests] == [8], overlap_requests
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    assert all(request["order"] == 8 for request in block_requests), f"Entering G may only retry the selected order, got {block_requests}"
    assert not errors, f"Atlas browser errors: {errors}"
    page.close()
    wide_context_fixture = False

    # A delayed intersection must retain the previous verified overlap and the
    # coverage already drawn until both commit together at the new order.
    context_fixture = True
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.route("**/api/v1/**", mock_api)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    expect(page.locator("#coverage-scene")).to_have_attribute("data-ready", "true")
    page.locator("#coverage-layers-toggle").click()
    for survey_id, layer_id in [("euclid", "euclid-euclid-ero-native"), ("gaia", "gaia-gaia-dr3-main")]:
        group = page.locator("#coverage-survey-" + survey_id)
        group.locator(".coverage-layer-name").click()
        group.locator('input[data-product-layer-id="' + layer_id + '"]').check(force=True)
    expect(page.locator("#coverage-state")).to_contain_text("O4")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator("#overlap-expand")).to_be_visible()
    page.wait_for_timeout(1200)
    block_requests.clear()
    overlap_requests.clear()
    held_overlap_orders.add(6)
    slider = page.locator("#coverage-display-order")
    # This case isolates response ordering. Keyboard debounce is covered above;
    # select O6 in one event turn so software WebGL cannot delay two key calls.
    slider.evaluate("""input => {
        input.value = '2';
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
    }""")
    deadline = time.monotonic() + 10
    while not held_overlap_routes and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert [body["requestedOrder"] for body in overlap_requests] == [6], {
        "overlap": overlap_requests, "blocks": block_requests,
        "order": slider.get_attribute("aria-valuetext"), "state": page.locator("#coverage-state").inner_text(),
    }
    assert all(request["order"] == 6 for request in block_requests), f"G may only load coverage at the selected order, got {block_requests}"
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    fulfill_json(*held_overlap_routes.pop())
    held_overlap_orders.clear()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O6")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "6")
    block_requests.clear()
    page.wait_for_timeout(1000)
    assert len(overlap_requests) == 1, "committing the complete G-mode batch must not refocus or repeat the query"
    canvas = page.locator("#coverage-canvas").bounding_box()
    page.mouse.move(canvas["x"] + 100, canvas["y"] + canvas["height"] / 2)
    page.mouse.wheel(0, 1000)
    page.wait_for_timeout(1000)
    far = float(page.locator("#coverage-status-camera").inner_text().split(" / ")[0])
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("f")
    deadline = time.monotonic() + 10
    near = far
    while near >= far * 0.95 and time.monotonic() < deadline:
        page.wait_for_timeout(50)
        near = float(page.locator("#coverage-status-camera").inner_text().split(" / ")[0])
    assert near < far * 0.95, f"F must advance the camera in G mode, got {far} -> {near}"
    assert not block_requests, "Camera focus in G must reuse the cached coverage blocks"
    if screenshot_root:
        page.screenshot(path=str(Path(screenshot_root) / "atlas-overlap-o6.png"))
    overlap_has_components = False
    slider.press("ArrowRight")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O7")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "7")
    assert all(request["order"] == 7 for request in block_requests), f"an empty finer intersection still draws coverage at the selected order, got {block_requests}"
    page.wait_for_timeout(800)
    block_requests.clear()
    camera_before_exit = page.locator("#coverage-status-camera").inner_text()
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator('label[for="coverage-display-order"]')).to_have_text("Display order")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "7")
    page.wait_for_timeout(1000)
    assert not block_requests, f"Leaving G must keep the coverage already drawn, got {block_requests}"
    assert page.locator("#coverage-status-camera").inner_text() == camera_before_exit, "Leaving G must not move the camera"
    assert not errors, f"Atlas browser errors: {errors}"
    page.close()


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
            assert selected_tab(reduced) == "sources", "rotation should stay enabled when reduced motion is preferred"
            prefers_reduced_motion = reduced.evaluate("window.matchMedia('(prefers-reduced-motion: reduce)').matches")
            assert prefers_reduced_motion
            assert reduced.locator(".home-summary-copy").evaluate("element => parseFloat(getComputedStyle(element).transitionDuration)") <= 0.001, "reduced motion should disable workflow transitions"
            rotation = reduced.locator("[data-home-autoplay]")
            assert rotation.get_attribute("aria-pressed") == "false", "rotation should start enabled under reduced motion"
            reduced.locator("[data-home-autoplay]").click()
            assert rotation.get_attribute("aria-label") == "Resume rotation"
            assert rotation.get_attribute("aria-pressed") == "true"
            reduced.locator(".site-header").hover()
            reduced.evaluate("document.activeElement.blur()")
            reduced.clock.run_for(6000)
            assert selected_tab(reduced) == "sources", "the pause control should stop rotation with reduced motion enabled"
            rotation.click()
            assert rotation.get_attribute("aria-label") == "Pause rotation"
            assert rotation.get_attribute("aria-pressed") == "false"
            reduced.locator(".site-header").hover()
            reduced.evaluate("document.activeElement.blur()")
            reduced.clock.run_for(5000)
            assert selected_tab(reduced) == "coverage", (
                "a user should be able to resume rotation with reduced motion enabled; "
                f"selected={selected_tab(reduced)}, "
                f"pressed={reduced.locator('[data-home-autoplay]').get_attribute('aria-pressed')}, "
                f"focusVisible={reduced.locator(':focus-visible').count()}"
            )
            assert reduced.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "mobile layout should not scroll horizontally"
            reduced.close()
            atlas_display_order_smoke(browser, URL)
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
