"""Read-only browser checks for the survey-first review workspace."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('ASSETS_ADMIN_URL', 'http://127.0.0.1:4199')
token = os.environ.get('ASSETS_ADMIN_TOKEN', 'admin-smoke-token')
shots = Path('/dev/shm/asa-review-layout')
shots.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/snap/chromium/current/usr/lib/chromium-browser/chrome', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/admin/review')
    page.locator('#admin-token').fill(token)
    page.locator('#login-form button[type=submit]').click()
    card = page.locator('[data-review-survey="euclid"]')
    expect(card).to_be_visible()
    expect(page.locator('.review-product-row')).to_have_count(0)
    page.screenshot(path=str(shots / 'surveys.png'))
    card.click()
    dialog = page.locator('#review-survey-dialog')
    expect(dialog).to_be_visible()
    expect(page.locator('#review-survey-dialog-title')).to_have_text('Euclid')
    rows = dialog.locator('.review-compact-list .review-product-row')
    assert rows.count() > 0
    assert dialog.locator('.readiness-version-pair,.lifecycle-readout').count() == 0
    for state in ['pending', 'reviewed', 'published', 'retired', 'all']:
        button = dialog.locator('[data-review-filter="' + state + '"]')
        count = int(button.locator('span').inner_text())
        button.click()
        expect(rows).to_have_count(count)
        if state != 'all':
            expect(dialog.locator('.review-compact-list .review-state-' + state)).to_have_count(count)
    for width in [1440, 900, 390]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), width
        assert rows.evaluate_all('(els) => els.every(el => el.scrollWidth <= el.clientWidth + 1)'), width
        if width == 1440:
            assert rows.first.bounding_box()['height'] < 100
        page.screenshot(path=str(shots / f'products-{width}.png'))
    dialog.locator('[data-edit-product]').first.click()
    expect(page.locator('#product-dialog')).to_be_visible()
    page.locator('#product-dialog-cancel').click()
    expect(dialog).to_be_visible()
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(page.locator('.review-product-row')).to_have_count(0)
    expect(card).to_be_focused()
    page.wait_for_timeout(16000)
    expect(dialog).not_to_be_visible()
    page.locator('#product-search').fill('Euclid')
    expect(page.locator('[data-review-survey]')).to_have_count(1)
    card.click()
    expect(rows).not_to_have_count(0)
    assert not errors, errors
    browser.close()
print('PASS: survey-first review, state counts/filters, compact rows, 1440/900/390px, product details, Escape/focus, polling, search')
