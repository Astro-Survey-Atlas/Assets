#!/usr/bin/env python3
"""Exercise homepage tab rotation in Chromium against the built site."""

import os
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
    oversized_order_five_index = False
    held_display_orders = set()
    held_display_routes = []
    overlap_has_components = False
    held_overlap_orders = set()
    held_overlap_routes = []
    context_fixture = False
    wide_context_fixture = False

    def overlap_component(order):
        return {"id": "C01", "order": order, "cells": [0], "bounds": {"areaDeg2": 1, "raMin": 44, "raMax": 46, "decMin": 0, "decMax": 2}}

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
            if order in held_overlap_orders:
                held_overlap_routes.append((route, result))
            else:
                fulfill_json(route, result)
        elif parsed.path == "/api/v1/coverage/overlap/details":
            order = request.post_data_json["requestedOrder"]
            fulfill_json(route, {"schemaVersion": 1, "component": overlap_component(order), "publicSources": [], "assetsEvidence": [], "warehouseEvidence": [], "method": {"summary": "Browser test fixture"}, "reverseLookup": {"endpoint": "/api/v1/coverage/reverse-lookup", "layerIds": [], "order": order, "precision": "estimated", "deferred": False}})
        elif parsed.path == "/api/v1/coverage/reverse-lookup":
            fulfill_json(route, {"available": False, "precision": "estimated", "truncated": False, "edges": [], "files": []})
        else:
            fulfill_json(route, {})

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

    euclid.locator('input[data-release-id="euclid-q1"]').check(force=True)
    expect(page.locator("#coverage-display-order-max")).to_have_text("O9")
    expect(slider).to_have_attribute("aria-valuetext", "O9")
    q1_product.uncheck(force=True)
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
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
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
    page.wait_for_timeout(700)
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
    assert not block_requests, "changing overlap order must reuse the O4 background without high-order source requests"
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    expect(page.locator("#overlap-drawer-display-state")).to_contain_text("OVERVIEW O4")
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

    # G keeps an O4 background even if the regular high-order source view
    # exceeds its budget. Only the strict intersection uses the chosen order.
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
    assert not block_requests, "Entering G must reuse the O4 overview rather than request high-order source coverage"
    assert not errors, f"Atlas browser errors: {errors}"
    page.close()
    wide_context_fixture = False

    # A delayed intersection must retain the previous verified overlap and
    # the complete O4 background; source coverage never follows the slider.
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
    assert not block_requests, "G must keep the O4 source coverage when only the intersection order changes"
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O4")
    fulfill_json(*held_overlap_routes.pop())
    held_overlap_orders.clear()
    expect(page.locator("#coverage-status-nside")).to_contain_text("O6")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    page.wait_for_timeout(1000)
    assert len(overlap_requests) == 1, "committing the complete G-mode batch must not refocus or repeat the query"
    canvas = page.locator("#coverage-canvas").bounding_box()
    page.mouse.move(canvas["x"] + 100, canvas["y"] + canvas["height"] / 2)
    page.mouse.wheel(0, 1000)
    page.wait_for_timeout(1000)
    far = float(page.locator("#coverage-status-camera").inner_text().split(" / ")[0])
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("f")
    page.wait_for_timeout(1000)
    near = float(page.locator("#coverage-status-camera").inner_text().split(" / ")[0])
    assert near < far * 0.95, f"F must advance the camera in G mode, got {far} -> {near}"
    assert not block_requests, "Camera focus in G must not request finer source coverage"
    if screenshot_root:
        page.screenshot(path=str(Path(screenshot_root) / "atlas-overlap-o6-o4-overview.png"))
    overlap_has_components = False
    slider.press("ArrowRight")
    expect(page.locator("#coverage-status-nside")).to_contain_text("O7")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "4")
    assert not block_requests, "An empty finer intersection must retain the O4 source overview"
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("g")
    expect(page.locator('label[for="coverage-display-order"]')).to_have_text("Display order")
    expect(page.locator("#coverage-status-nside")).to_have_attribute("data-source-order", "7")
    assert block_requests and all(request["order"] == 7 for request in block_requests), "Leaving G restores normal display at the selected order"
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
