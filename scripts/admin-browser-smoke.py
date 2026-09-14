#!/usr/bin/env python3
"""Run a small browser-level control-room smoke test.

This intentionally lives outside the Node test suite: the deployment image does
not need a browser, while operators can run the same check against a dev or
staging URL with the locally installed Playwright browser.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("ASSETS_ADMIN_URL", "http://127.0.0.1:4180/admin/"))
    parser.add_argument("--token", default=os.environ.get("ASSETS_ADMIN_TOKEN", ""))
    parser.add_argument("--screenshot-dir", type=Path)
    parser.add_argument("--executable-path", default=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"))
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--allow-control-plane-unavailable",
        action="store_true",
        help="Allow a 5xx overview response when only the static UI is being checked.",
    )
    parser.add_argument(
        "--workflow",
        action="store_true",
        help="Exercise the read-only overview -> product detail -> gap action -> publication detail path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.token:
        raise SystemExit("--token or ASSETS_ADMIN_TOKEN is required")
    if args.screenshot_dir:
        args.screenshot_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        executable = args.executable_path or shutil.which("chromium") or shutil.which("chromium-browser")
        launch_options = {"headless": not args.headed}
        if executable:
            launch_options["executable_path"] = executable
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(f"console:{message.type}:{message.text}") if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(f"pageerror:{error}"))
        page.goto(args.url, wait_until="networkidle")
        page.locator("#admin-token").fill(args.token)
        page.locator("#login-form button[type=submit]").click()
        page.locator("#admin-workspace").wait_for(state="visible")

        for step in ("overview", "sources", "tasks", "review", "releases"):
            tab = page.locator(f'[data-admin-step="{step}"]')
            tab.click()
            page.locator(f'[data-admin-panel="{step}"]').wait_for(state="visible")
            if args.screenshot_dir:
                page.screenshot(path=str(args.screenshot_dir / f"admin-{step}.png"), full_page=True)

        if args.workflow:
            # This path deliberately stops before any mutating action. It
            # verifies that readiness gaps and publication evidence are
            # reachable from the same product/workflow context.
            page.locator('[data-admin-step="overview"]').click()
            survey_card = page.locator("[data-survey-card]").first
            if survey_card.count():
                if page.locator("[data-overview-product]").count():
                    raise SystemExit("initial overview must show survey cards, not the full product list")
                survey_card.click()
            product_link = page.locator("[data-overview-product]").first
            if product_link.count():
                product_link.click()
                page.locator("#product-dialog").wait_for(state="visible")
                page.locator("#product-history").wait_for(state="visible")
                if page.locator('#product-form textarea[name="flowNodes"]').is_visible():
                    raise SystemExit("product details must not require editing raw flow JSON")
                if page.locator("#product-edit-content").get_attribute("open") is not None:
                    raise SystemExit("product details must open in read mode")
                gap_action = page.locator("[data-readiness-action]").first
                if gap_action.count():
                    target_step = gap_action.get_attribute("data-readiness-action")
                    if target_step == "scan":
                        target_step = "tasks"
                    gap_action.click()
                    if target_step:
                        page.locator(f'[data-admin-panel="{target_step}"]').wait_for(state="visible")
                    task_cancel = page.locator("#task-dialog-cancel")
                    if task_cancel.is_visible():
                        task_cancel.click()
                    if page.locator("#product-dialog").is_visible():
                        page.locator("#product-dialog-cancel").click()
                    if page.locator("#moc-discovery-dialog").is_visible():
                        search = page.locator("#moc-product-search")
                        search.fill("no-such-survey-product-123")
                        if "没有匹配产品" not in page.locator("#moc-product-tree").inner_text():
                            raise SystemExit("discovery product search did not filter the tree")
                        search.fill("")
                        page.locator("#moc-discovery-dialog-cancel").click()

            page.locator('[data-admin-step="releases"]').click()
            run_detail = page.locator("[data-publication-run]").first
            if run_detail.count():
                run_detail.click()
                page.locator("#publication-run-dialog").wait_for(state="visible")
                page.locator("#publication-run-close").click()

        if page.evaluate("document.documentElement.scrollWidth > window.innerWidth"):
            raise SystemExit("admin page has horizontal overflow")

        api_result = page.evaluate(
            """
            async (adminToken) => {
              const response = await fetch('/api/v1/admin/overview', {
                headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' }
              });
              return { status: response.status, body: await response.text() };
            }
            """,
            args.token,
        )
        if api_result["status"] >= 500 and not args.allow_control_plane_unavailable:
            raise SystemExit(f"admin overview returned HTTP {api_result['status']}")
        if api_result["status"] < 500:
            if api_result["status"] != 200:
                raise SystemExit(f"admin overview returned HTTP {api_result['status']}")
            if '"schemaVersion":1' not in api_result["body"]:
                raise SystemExit("admin overview response is missing schemaVersion=1")

        browser.close()
        if console_errors and not args.allow_control_plane_unavailable:
            raise SystemExit("browser errors:\n" + "\n".join(console_errors))
    print(f"admin browser smoke passed: {args.url}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PlaywrightTimeoutError as error:
        raise SystemExit(f"browser smoke timed out: {error}") from error
