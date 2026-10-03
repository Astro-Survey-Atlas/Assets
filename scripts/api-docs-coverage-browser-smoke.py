"""Read-only browser regression for the paged coverage response in Swagger UI."""
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


base = os.environ.get("ASSETS_PUBLIC_URL", "http://127.0.0.1:4199").rstrip("/")
errors = []
coverage_responses = []

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or "/snap/bin/chromium",
        args=["--no-sandbox"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on(
        "response",
        lambda response: coverage_responses.append(response.url)
        if "/api/v1/coverage?" in response.url else None,
    )

    page.goto(base + "/api-docs/", wait_until="networkidle", timeout=30000)
    operation = page.locator(".opblock").filter(has_text="/api/v1/coverage").first
    operation.locator(".opblock-summary").click()
    defaults = operation.locator("input").evaluate_all("elements => elements.map(element => element.value)")
    assert "10" in defaults, f"Swagger pageSize default missing: {defaults}"

    operation.locator(".try-out__btn").click()
    operation.locator(".execute").click()
    page.wait_for_function(
        "() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v1/coverage?pageSize=10'))",
        timeout=10000,
    )
    page.wait_for_timeout(500)

    requested = next((url for url in coverage_responses if "/api/v1/coverage?" in url), None)
    assert requested, f"No paginated coverage request observed: {coverage_responses}"
    assert parse_qs(urlparse(requested).query).get("pageSize") == ["10"], requested

    response_text = operation.locator(".responses-wrapper").inner_text()
    assert "Response body" in response_text, "Swagger did not render a response body"
    assert "Could not render" not in response_text, response_text[:1000]
    assert not any("Maximum call stack size exceeded" in error for error in errors), errors
    assert not errors, errors

    browser.close()

print("PASS: Swagger sends pageSize=10 and renders the coverage JSON without browser errors")
