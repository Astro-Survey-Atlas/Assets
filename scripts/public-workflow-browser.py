"""Read-only public UI checks; API fixtures keep publication state untouched."""
import os
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('ASSETS_PUBLIC_URL', 'http://127.0.0.1:4199')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/snap/chromium/current/usr/lib/chromium-browser/chrome', args=['--no-sandbox'])
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    surveys = {'surveys': [{'id': 'euclid', 'name': 'Euclid', 'modalities': ['imaging', 'spectroscopy'], 'releases': [{'products': [{'modality': 'imaging', 'coverage': {'maxOrder': 11}}]}], 'statistics': {'publicProducts': 1, 'acquired': 1}}]}
    mode = ['normal']
    def catalog(route):
        page.wait_for_timeout(250)
        if mode[0] == 'error': route.fulfill(status=503, json={'error': 'fixture'})
        else: route.fulfill(json=surveys if mode[0] == 'normal' else {'surveys': []})
    page.route('**/api/v1/surveys', catalog)
    page.route('**/api/v1/releases', lambda r: r.fulfill(json={'schemaVersion': 1, 'releases': []}))
    page.route('**/api/v1/assets/**', lambda r: r.fulfill(body='Example fixture'))
    page.goto(base + '/')
    icons = page.locator('.snapshot-modalities svg')
    expect(icons).to_have_count(2)
    assert icons.first.bounding_box()['width'] > 0
    name = page.locator('.snapshot-heading strong').first.bounding_box()
    icon = icons.first.bounding_box()
    assert icon['x'] >= name['x'] + name['width']
    assert abs((icon['y'] + icon['height']/2) - (name['y'] + name['height']/2)) < 2
    expect(page.locator('.snapshot-modalities i')).to_have_count(0)
    for _ in range(3):
        page.locator('[data-locale-toggle]').click()
        expect(icons).to_have_count(2)
    for state in ['empty', 'error']:
        mode[0] = state
        page.reload()
        expect(page.locator('.snapshot-empty')).to_be_visible()
        expect(icons).to_have_count(0)
    for lang in ['en', 'zh']:
        page.evaluate('(lang) => localStorage.setItem("astro-survey-atlas.locale", lang)', lang)
        for theme in ['light', 'dark']:
            page.goto(base + '/releases/')
            page.evaluate('(theme) => document.documentElement.dataset.theme = theme', theme)
            details = page.locator('#release-workflow')
            expect(details.locator('.release-flow-sources')).to_be_visible()
            expect(details.locator('summary')).to_have_count(0)
            expect(details.locator('a[href="https://alasky.cds.unistra.fr/MocServer/query"]')).to_be_visible()
            expect(details.locator('.release-flow-source > h3')).to_have_count(2)
            expect(details).to_contain_text('尚未启用' if lang == 'zh' else 'not enabled')
            for width in [1440, 900, 390]:
                page.set_viewport_size({'width': width, 'height': 1100})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (lang, theme, width)
                assert details.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                page.screenshot(path=f'/dev/shm/release-flow-{lang}-{theme}-{width}.png', full_page=True)

    assert not errors, errors
    browser.close()
print('PASS: delayed modality SVGs, locale refresh, empty/error states, always-visible peer source paths and CDS link, EN/ZH, light/dark, 1440/900/390px')
