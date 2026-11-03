#!/usr/bin/env python3
"""Verify automatic selected-cell depth on the Atlas globe and its transparent inspector."""
import argparse
import json
from io import BytesIO
from pathlib import Path
from statistics import mean
from PIL import Image
from playwright.sync_api import sync_playwright


def filtered_chroma_ratio(full_range: bytes, narrowed_range: bytes) -> float:
    before = Image.open(BytesIO(full_range)).convert('RGB')
    after = Image.open(BytesIO(narrowed_range)).convert('RGB')
    assert before.size == after.size
    width, height = before.size
    crop = (int(width * .326), int(height * .19), int(width * .667), int(height * .82))
    full_pixels = list(before.crop(crop).get_flattened_data())
    filtered_pixels = list(after.crop(crop).get_flattened_data())
    chroma = lambda pixel: max(pixel) - min(pixel)
    original = [chroma(pixel) for pixel in full_pixels if chroma(pixel) > 24]
    assert original, 'No chromatic points found in the captured sky region'
    faded = [chroma(pixel) for pixel, value in zip(filtered_pixels, full_pixels) if chroma(value) > 24]
    return mean(faded) / mean(original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5176')
    parser.add_argument('--output', type=Path, default=Path('/tmp/asa-sky-depth-20261030'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors, requests, results = [], [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda req: requests.append(req.post_data_json) if req.url.endswith('/api/v1/sky-depth') else None)

        def record(response):
            if response.url.endswith('/api/v1/sky-depth') and response.status == 200:
                data = response.json()
                assert data['query']['mode'] == 'aggregate'
                for source in data['sources']:
                    if source['voxels']:
                        assert source['points'] == []
                        represented = sum(v['count'] for v in source['voxels'])
                        assert represented == source['selectedCount']
                        results.append({'axis': data['query']['axis'], 'selectedCount': represented,
                                        'aggregatePoints': len(source['voxels']), 'snapshotSha256': source['snapshotSha256']})
        page.on('response', record)
        panel, canvas = page.locator('#coverage-depth-panel'), page.locator('#coverage-canvas')

        def ready():
            page.locator('#coverage-depth-panel[data-status="available"]').wait_for(state='visible', timeout=60000)
            assert page.locator('canvas').count() == 1
            assert page.locator('.depth-range-lower,.depth-range-upper').count() == 2
            assert page.locator('.sky-depth-controls,.sky-depth-dialog,#coverage-depth-example,.depth-inspect-button,.depth-close').count() == 0
            assert page.locator('dialog[open]').count() == 0
            assert not panel.is_hidden()

        def layout():
            value = page.locator('.coverage-inspector-rail').evaluate('''r => {
                const [readout, cell, depth] = [...r.children].map(e=>e.getBoundingClientRect());
                const p = getComputedStyle(r.querySelector('#coverage-depth-panel'));
                const cellTitle = getComputedStyle(r.querySelector('#coverage-detail-title'));
                const depthTitle = getComputedStyle(r.querySelector('#coverage-depth-title'));
                return {readoutBottom:readout.bottom,cellTop:cell.top,cellBottom:cell.bottom,depthTop:depth.top,
                    railWidth:r.clientWidth,railScrollWidth:r.scrollWidth,
                    background:p.backgroundColor,border:p.borderTopWidth,shadow:p.boxShadow,blur:p.backdropFilter,
                    cellFont:[cellTitle.fontSize,cellTitle.fontWeight],depthFont:[depthTitle.fontSize,depthTitle.fontWeight]};
            }''')
            assert value['readoutBottom'] < value['cellTop'], value
            assert value['cellBottom'] < value['depthTop'], value
            assert value['railScrollWidth'] <= value['railWidth'], value
            assert value['background'] == 'rgba(0, 0, 0, 0)', value
            assert value['border'] == '0px' and value['shadow'] == 'none' and value['blur'] == 'none', value
            assert value['cellFont'] == value['depthFont'], value
            return value

        page.goto(args.url + '/atlas/')
        page.locator('#coverage-scene[data-ready="true"]').wait_for(state='attached', timeout=60000)
        page.wait_for_timeout(300)
        assert not requests, 'No depth query until a sky cell is selected'
        assert panel.is_hidden()
        assert page.locator('#coverage-depth-example,.depth-inspect-button').count() == 0

        # The developer link selects an actual cell through the normal viewer selection callback.
        page.goto(args.url + '/atlas/?depth=desi')
        ready()
        page.wait_for_timeout(1000)
        original_url = page.url
        assert panel.get_attribute('data-mode') == 'aggregate'
        assert panel.get_attribute('data-cells') == '630'
        assert '630' in page.locator('#coverage-detail-title').inner_text()
        assert canvas.get_attribute('data-depth-represented') == '4198'
        assert int(canvas.get_attribute('data-depth-points')) == results[-1]['aggregatePoints']
        assert canvas.get_attribute('data-depth-frames') == '1'
        assert canvas.get_attribute('data-selection-volume') == 'outline', 'The white angular base outline must remain visible with depth data'
        frame_heights = json.loads(canvas.get_attribute('data-depth-frame-heights'))
        assert len(frame_heights) == 1 and 0 < frame_heights[0] <= .52
        reference_result = page.request.post(args.url + '/api/v1/sky-depth', data={
            'order': 4, 'cells': [630], 'sources': [
                {'surveyId': 'euclid', 'releaseId': 'euclid-q1'},
                {'surveyId': 'desi', 'releaseId': 'desi-dr1', 'role': 'reference'},
            ], 'axis': 'distance', 'mode': 'aggregate'}).json()
        assert reference_result['sources'][0]['status'] == 'not-connected'
        assert reference_result['sources'][1]['role'] == 'reference'
        assert reference_result['sources'][1]['label'] == 'DESI DR1 · reference depth'
        assert reference_result['sources'][1]['selectedCount'] == 4198
        page.locator('[data-locale-toggle]').first.click()
        ready()
        assert '630' in page.locator('#coverage-detail-title').inner_text(), 'Locale changes must preserve the actual selected-cell title'
        assert '纵深依据' in page.locator('.depth-axis-label').inner_text()
        desktop_layout = layout()
        assert 'uncorrected' in page.locator('.depth-method').inner_text() or '未校正本动速度' in page.locator('.depth-method').inner_text()
        sizes = page.locator('.depth-size-legend span').evaluate_all('(items)=>items.map(v=>({n:Number(v.querySelector("b").textContent),d:v.querySelector("i").getBoundingClientRect().width}))')
        for size in sizes:
            assert abs(size['d'] ** 2 / sizes[0]['d'] ** 2 - size['n'] / sizes[0]['n']) < .03
        page.screenshot(path=str(args.output / 'auto-depth-initial.png'))
        full_range_capture = canvas.screenshot()

        assert canvas.get_attribute('data-depth-range-frames') == '2'
        range_requests = len(requests)
        page.locator('.depth-range-lower').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 1000)
        page.locator('.depth-range-upper').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 2000)
        assert len(requests) == range_requests, 'Moving the range emphasis must not requery the catalog'
        assert float(canvas.get_attribute('data-depth-range-min')) == 1000
        assert float(canvas.get_attribute('data-depth-range-max')) == 2000
        assert int(canvas.get_attribute('data-depth-range-in')) > 0
        assert int(canvas.get_attribute('data-depth-range-faded')) > 0
        assert int(canvas.get_attribute('data-depth-range-in')) + int(canvas.get_attribute('data-depth-range-faded')) == int(canvas.get_attribute('data-depth-points'))
        assert canvas.get_attribute('data-depth-represented') == '4198', 'Range emphasis must not change represented counts'
        upper_handle = page.locator('.depth-range-upper')
        initial_upper = float(upper_handle.input_value())
        upper_handle.focus()
        upper_handle.press('ArrowRight')
        assert float(upper_handle.input_value()) > initial_upper, 'Range handles must support keyboard adjustment'
        upper_handle.press('ArrowLeft')
        assert float(upper_handle.input_value()) == initial_upper
        assert len(requests) == range_requests
        page.locator('.depth-range-lower').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 0)
        page.locator('.depth-range-upper').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 200)
        page.wait_for_timeout(100)
        chroma_ratio = filtered_chroma_ratio(full_range_capture, canvas.screenshot())
        assert .35 < chroma_ratio < .65, f'Out-of-range point contrast should show a 50% blend: chroma ratio {chroma_ratio:.3f}'
        page.screenshot(path=str(args.output / 'auto-depth-range-muted.png'))
        page.locator('.depth-range-upper').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 2000)
        page.locator('.depth-range-lower').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', 1000)
        assert len(requests) == range_requests
        page.screenshot(path=str(args.output / 'auto-depth-range-distance.png'))

        # Axis changes never move the camera. F remains an explicit way to inspect the depth.
        camera_before = page.locator('#coverage-status-camera').inner_text()
        page.select_option('.depth-axis', 'redshift')
        ready()
        assert canvas.get_attribute('data-depth-represented') == '4222'
        assert int(canvas.get_attribute('data-depth-points')) == results[-1]['aggregatePoints']
        assert page.locator('#coverage-status-camera').inner_text() == camera_before
        redshift_domain_min = float(page.locator('.depth-near').inner_text().split()[0])
        redshift_domain_max = float(page.locator('.depth-far').inner_text().split()[0])
        redshift_span = redshift_domain_max - redshift_domain_min
        redshift_low = redshift_domain_min + redshift_span * .25
        redshift_high = redshift_domain_min + redshift_span * .75
        range_requests = len(requests)
        page.locator('.depth-range-lower').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', redshift_low)
        page.locator('.depth-range-upper').evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}))}', redshift_high)
        assert len(requests) == range_requests
        assert abs(float(canvas.get_attribute('data-depth-range-min')) - redshift_low) < .011
        assert abs(float(canvas.get_attribute('data-depth-range-max')) - redshift_high) < .011
        assert int(canvas.get_attribute('data-depth-range-in')) + int(canvas.get_attribute('data-depth-range-faded')) == int(canvas.get_attribute('data-depth-points'))
        page.screenshot(path=str(args.output / 'auto-depth-range-redshift.png'))
        page.screenshot(path=str(args.output / 'auto-depth-redshift.png'))
        page.select_option('.depth-axis', 'distance')
        ready()
        assert float(canvas.get_attribute('data-depth-range-min')) == 1000, 'Distance range must be remembered while using redshift'
        assert float(canvas.get_attribute('data-depth-range-max')) == 2000
        page.locator('.depth-explanation summary').click()
        assert '0.02≤z≤2' in page.locator('.depth-explanation').inner_text()
        assert 'f2b19da7' in page.locator('.depth-provenance').inner_text()
        page.locator('.depth-explanation summary').click()
        page.keyboard.press('f')
        page.wait_for_timeout(1100)
        page.screenshot(path=str(args.output / 'auto-depth-focused.png'))

        # Clicking an aggregate reads its bin while preserving the selected sky cell.
        for x, y in [(720, 480), (730, 475), (710, 490), (740, 460), (700, 510), (760, 450), (690, 470)]:
            page.mouse.click(x, y)
            if page.locator('.depth-picked').is_visible():
                break
        assert page.locator('.depth-picked').is_visible(), 'On-globe aggregate picking failed'
        assert 'Mpc (Planck18)' in page.locator('.depth-picked').inner_text()
        assert panel.get_attribute('data-cells') == '630'
        page.screenshot(path=str(args.output / 'auto-depth-inspect.png'))

        # Long product titles flow above both panels, including narrow screens.
        page.locator('#coverage-selection-title').evaluate('(e)=>e.textContent="DESI · DR1 SPECTRA AND REDSHIFTS"')
        desktop_layout = layout()
        page.screenshot(path=str(args.output / 'auto-depth-long-title.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(400)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mobile_layout = layout()
        assert page.locator('#selection-queue').is_hidden(), 'Duplicate source queue must not cover the mobile inspector'
        page.locator('#coverage-depth-title').scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / 'auto-depth-mobile.png'))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.locator('.coverage-inspector-rail').evaluate('(r)=>r.scrollTop=0')

        # A request failure hides optional depth and preserves the cell inspector and sky.
        page.route('**/api/v1/sky-depth', lambda route: route.abort())
        page.select_option('.depth-axis', 'redshift')
        page.locator('#coverage-depth-panel[data-status="unavailable"]').wait_for(state='attached')
        assert panel.is_hidden()
        assert canvas.get_attribute('data-depth-points') is None
        assert page.locator('#coverage-detail-panel').is_visible()
        page.unroute('**/api/v1/sky-depth')

        # Reselect the actual visible HEALPix cell; no secondary action is required to retry.
        camera_before = page.locator('#coverage-status-camera').inner_text()
        page.mouse.click(800, 480)
        ready()
        assert page.locator('#coverage-status-camera').inner_text() == camera_before
        assert page.url == original_url
        assert page.locator('#coverage-detail-panel').is_visible()
        selected_cell = panel.get_attribute('data-cells')
        assert requests[-1]['cells'] == [int(selected_cell)]
        page.screenshot(path=str(args.output / 'auto-depth-cell-click.png'))

        # Modifier selection must still reach the underlying cell through the point cloud.
        page.keyboard.down('Control')
        page.mouse.click(800, 480)
        page.keyboard.up('Control')
        panel.wait_for(state='hidden')
        assert canvas.get_attribute('data-depth-points') is None
        page.keyboard.down('Control')
        page.mouse.click(800, 480)
        page.keyboard.up('Control')
        ready()
        assert panel.get_attribute('data-cells') == selected_cell

        # Real disconnected-source and empty responses produce neither a panel nor points.
        disconnected = page.request.post(args.url + '/api/v1/sky-depth', data={
            'order': 4, 'cells': [630], 'sources': [{'surveyId': 'gaia', 'releaseId': 'gaia-dr3'}],
            'axis': 'distance', 'mode': 'aggregate'}).json()
        page.route('**/api/v1/sky-depth', lambda route: route.fulfill(json=disconnected))
        page.select_option('.depth-axis', 'redshift')
        page.locator('#coverage-depth-panel[data-status="empty"]').wait_for(state='attached')
        assert panel.is_hidden()
        assert canvas.get_attribute('data-depth-points') is None
        assert canvas.get_attribute('data-depth-frames') is None
        assert canvas.get_attribute('data-selection-volume') == 'outline', 'Unavailable depth keeps the white base outline'
        assert page.locator('#coverage-detail-panel').is_visible()
        page.unroute('**/api/v1/sky-depth')

        # Clearing a selection cancels its in-flight request; late data must not reappear.
        held = []
        page.route('**/api/v1/sky-depth', lambda route: held.append(route))
        page.mouse.click(800, 480)
        page.locator('#coverage-depth-panel[data-status="loading"]').wait_for(state='attached')
        assert panel.is_hidden()
        page.keyboard.press('Escape')
        for route in held:
            try:
                route.fulfill(json=disconnected)
            except Exception:
                pass
        page.unroute('**/api/v1/sky-depth')
        page.wait_for_timeout(300)
        assert panel.is_hidden()
        assert canvas.get_attribute('data-depth-points') is None
        assert page.locator('#coverage-detail-panel').is_hidden()
        assert not errors, errors
        report = {'pageErrors': errors, 'initialDepthRequests': 0, 'results': results,
                  'singleCanvas': True, 'noStandalonePanelOrButtons': True, 'automaticCellClick': selected_cell,
                  'countAreaLegend': sizes, 'aggregatePicking': 'passed', 'noAutomaticCameraMove': True,
                  'desktopLayout': desktop_layout, 'mobileLayout': mobile_layout,
                  'failureHidesDepth': True, 'disconnectedHidesDepth': True, 'pendingSelectionClear': 'passed'}
        report['modifierSelection'] = 'passed'
        report['rangeEmphasis'] = {'distanceAndRedshift': 'passed', 'outsideOpacity': '50%', 'noExtraRequests': True,
                                   'rangeFrames': 2, 'axisRangesRemembered': True, 'keyboardHandles': 'passed',
                                   'visibleChromaRatio': round(chroma_ratio, 3)}
        (args.output / 'verification-auto-depth.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
        browser.close()


if __name__ == '__main__':
    main()
