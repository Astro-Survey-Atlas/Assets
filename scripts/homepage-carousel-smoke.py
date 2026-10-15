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
        ("euclid-ero-vis", "euclid", "euclid-ero", "ERO VIS", "#d95f59"),
        ("gaia-dr3-main", "gaia", "gaia-dr3", "Gaia DR3 main source presence", "#4f8fc8"),
    ]
    display_orders = list(range(4, 11))
    layers = []
    surveys = []
    display_revisions = {}
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
            "displayOrders": display_orders,
            "displayRevision": display_revision,
            "nativeMaxOrder": 10,
            "overviewOrder": 4,
            "maxOrder": 10,
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
            "coverage": {"layerId": layer_id, "availableOrders": [4], "overviewOrder": 4, "maxOrder": 10},
        }
        surveys.append({
            "id": survey_id,
            "name": survey_id.upper(),
            "mission": survey_id.upper(),
            "color": color,
            "description": product_name,
            "modalities": [product["modality"]],
            "releases": [{"id": release_id, "label": release_id, "kind": "survey", "modalities": [product["modality"]], "products": [product]}],
            "imageUrl": "",
            "statistics": {"publicProducts": 1, "acquired": 1, "overviewOnly": 0, "awaitingGeometry": 0, "notApplicable": 0, "footprintCells": 1},
            "assets": [],
        })

    catalog = {"schemaVersion": 2, "coordinateFrame": "ICRS", "ordering": "NESTED", "tileScheme": "ipix-range-4096", "revision": "atlas-display-smoke", "layers": layers}
    survey_index = {"schemaVersion": 1, "generatedAt": "2026-10-15T00:00:00Z", "surveys": surveys, "sharedAssets": []}
    asset_catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-10-15T00:00:00Z",
        "bundle": {"id": "atlas-display-smoke", "sha256": "a" * 64},
        "statistics": {"releases": 2, "acquired": 2, "rawMocFiles": 2, "packages": 0, "totalBytes": 0},
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
                fulfill_json(route, {"layerId": layer_id, "order": order, "tileSize": 4096, "ranges": [{"start": 0, "end": 1}], "totalTiles": 1, "displayRevision": display_revision})
            else:
                fulfill_json(route, {"layerId": layer_id, "order": order, "tileId": int(query.get("tile", ["0"])[0]), "cells": [0], "sha256": "b" * 64, "revision": f"revision-{layer_id}", "displayRevision": display_revision, "nativeMaxOrder": 10, "projection": "native-moc"})
        elif parsed.path == "/api/v1/coverage/overlap" and request.method == "POST":
            overlap_requests.append(request.post_data_json)
            fulfill_json(route, {"commonOrder": 10, "pixels": [], "components": []})
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
    for suffix, survey_id, _, _, _ in layer_specs:
        layer_id = f"{survey_id}-{suffix}"
        page.locator(f'input[data-product-layer-id="{layer_id}"]').check(force=True)
    enabled_orders = page.locator("#coverage-display-order option").evaluate_all("options => options.filter(option => !option.disabled).map(option => option.value)")
    assert "10" in enabled_orders, f"native O10 should be selectable for both products, got {enabled_orders}"
    with page.expect_response(lambda response: "/api/v1/coverage/blocks/" in response.url and "order=10" in response.url, timeout=30000) as display_response:
        page.locator("#coverage-display-order").select_option("10")
    assert display_response.value.status == 200
    page.evaluate("document.activeElement.blur()")
    with page.expect_response(lambda response: response.url.endswith("/api/v1/coverage/overlap"), timeout=30000) as overlap_response:
        page.keyboard.press("g")
    assert overlap_response.value.status == 200
    assert overlap_requests and overlap_requests[-1]["requestedOrder"] == 10
    assert overlap_requests[-1]["strictOrder"] is True
    assert set(overlap_requests[-1]["layerIds"]) == {f"{layer[1]}-{layer[0]}" for layer in layer_specs}
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
