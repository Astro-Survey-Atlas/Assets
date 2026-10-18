#!/usr/bin/env python3
"""Exercise homepage tab rotation in Chromium against the built site."""

import os
import json
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


def atlas_display_order_smoke(browser, base_url: str) -> None:
    layer_specs = [
        ("euclid-ero-native", "euclid", "euclid-ero", "Early Release Observations", "#d95f59"),
        ("euclid-ero-vis", "euclid", "euclid-ero", "ERO VIS", "#d95f59"),
        ("euclid-q1-vis", "euclid", "euclid-q1", "Q1 VIS", "#d95f59"),
        ("gaia-dr3-main", "gaia", "gaia-dr3", "Gaia DR3 main source presence", "#4f8fc8"),
    ]
    display_orders = list(range(4, 12))
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
            "displayOrders": lower_order_display_orders if suffix == "euclid-ero-vis" or suffix == "euclid-q1-vis" else display_orders,
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
                fulfill_json(route, {"layerId": layer_id, "order": order, "tileSize": 4096, "ranges": order_11_tiles, "totalTiles": 2, "displayRevision": display_revision})
            else:
                block_requests.append({"layerId": layer_id, "order": order, "tile": int(query.get("tile", ["0"])[0])})
                fulfill_json(route, {"layerId": layer_id, "order": order, "tileId": int(query.get("tile", ["0"])[0]), "cells": [0], "sha256": "b" * 64, "revision": f"revision-{layer_id}", "displayRevision": display_revision, "nativeMaxOrder": 11, "projection": "native-moc"})
        elif parsed.path == "/api/v1/coverage/overlap" and request.method == "POST":
            overlap_requests.append(request.post_data_json)
            fulfill_json(route, {"commonOrder": 11, "pixels": [], "components": []})
        else:
            fulfill_json(route, {})

    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.route("**/api/v1/**", mock_api)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url.rstrip("/") + "/atlas/", wait_until="domcontentloaded")
    page.locator("#coverage-layers-toggle").click()
    page.wait_for_selector("#coverage-display-order")
    assert page.locator("#coverage-display-order").input_value() == "4", "Atlas must default to O4"
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
    survey_checkbox = euclid.locator('input[data-survey-id="euclid"]:not([data-release-id])')
    assert survey_checkbox.evaluate("input => input.indeterminate"), "survey state must reflect a partial DR selection"
    survey_checkbox.check(force=True)
    assert ero_product.is_checked() and ero_native_product.is_checked() and q1_product.is_checked(), "the survey checkbox must select every DR product"
    expect(page.locator('#coverage-display-order option[value="11"]')).to_have_js_property("disabled", True)
    survey_checkbox.uncheck(force=True)
    assert not ero_product.is_checked() and not ero_native_product.is_checked() and not q1_product.is_checked(), "the survey checkbox must clear every DR product"

    euclid.locator("[data-expand-survey]").click()
    assert euclid.locator(".coverage-release-list").is_hidden(), "the expander must collapse the DR list"
    page.locator("#coverage-layer-search").fill("q1")
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == "true", "matching DR search must expand its survey"
    assert euclid.locator('input[data-product-layer-id="euclid-euclid-q1-vis"]').is_visible()
    page.locator("#coverage-layer-search").fill("")
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == "false", "clearing search must restore the previous collapsed state"

    euclid.locator(".coverage-layer-name").click()
    euclid.locator('input[data-release-id="euclid-ero"]').check(force=True)
    expect(page.locator('#coverage-display-order option[value="11"]')).to_have_js_property("disabled", True)
    ero_product.uncheck(force=True)
    gaia = page.locator("#coverage-survey-gaia")
    gaia.locator(".coverage-layer-name").click()
    gaia.locator('input[data-release-id="gaia-dr3"]').check(force=True)
    assert gaia.locator('input[data-product-layer-id="gaia-gaia-dr3-main"]').is_checked(), "release selection must update its product control"
    expanded_before_handle = euclid.locator("[data-expand-survey]").get_attribute("aria-expanded")
    euclid.locator(".coverage-layer-handle").click()
    assert euclid.locator("[data-expand-survey]").get_attribute("aria-expanded") == expanded_before_handle, "the drag handle must not toggle the DR list"
    enabled_orders = page.locator("#coverage-display-order option").evaluate_all("options => options.filter(option => !option.disabled).map(option => option.value)")
    assert "11" in enabled_orders, f"native O11 should be selectable for both products, got {enabled_orders}"
    tile_index_requests.clear()
    block_requests.clear()
    with page.expect_response(lambda response: "/api/v1/coverage/blocks/" in response.url and "order=11" in response.url and "tiles=1" in response.url, timeout=30000) as display_response:
        page.locator("#coverage-display-order").select_option("11")
    assert display_response.value.status == 200
    expect(page.locator("#coverage-state")).to_contain_text("O11", timeout=30000)
    assert {request["layerId"] for request in tile_index_requests if request["order"] == 11} == {
        "euclid-euclid-ero-native", "gaia-gaia-dr3-main"
    }, f"O11 tile indexes must be requested for both selected products, got {tile_index_requests}"
    assert block_requests and all(request["order"] == 11 for request in block_requests), f"O11 selection must fetch O11 blocks, got {block_requests}"
    assert any(request["layerId"] == "euclid-euclid-ero-native" for request in block_requests), "ERO O11 block must be drawn"
    page.evaluate("document.activeElement.blur()")
    with page.expect_response(lambda response: response.url.endswith("/api/v1/coverage/overlap"), timeout=30000) as overlap_response:
        page.keyboard.press("g")
    assert overlap_response.value.status == 200
    assert overlap_requests and overlap_requests[-1]["requestedOrder"] == 11
    assert overlap_requests[-1]["strictOrder"] is True
    assert set(overlap_requests[-1]["layerIds"]) == {"euclid-euclid-ero-native", "gaia-gaia-dr3-main"}
    assert overlap_requests[-1]["viewTiles"]["order"] == 5
    assert len(overlap_requests[-1]["viewTiles"]["tiles"]) <= 192
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "Atlas mobile layout must not overflow horizontally"
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
