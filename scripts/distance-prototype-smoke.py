#!/usr/bin/env python3
"""WebGL checks with synthetic benchmarks and optional local DESI row-window import."""
import argparse
import json
import platform
import subprocess
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path('/tmp/asa-distance-feasibility-20261030')
URL = 'http://127.0.0.1:4178/atlas/distance-prototype.html'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desi-sample', type=Path)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', '4178', '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('Vite exited')
            try:
                urllib.request.urlopen(URL, timeout=1).close()
                break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('Prototype did not start')
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={'width': 1440, 'height': 1100})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL)
            page.wait_for_function('window.distancePrototype?.getSnapshot().selectedCount > 0')
            get = lambda: page.evaluate('window.distancePrototype.getSnapshot()')
            def settled():
                page.evaluate('async () => {for(let i=0;i<3;i++) await new Promise(requestAnimationFrame);} ')
            first = get()
            assert first['selectedCount'] == 45000 and first['mode'] == 'aggregate'
            assert first['aggregationCount'] == first['selectedCount'] and first['complete']
            for order in [4, 6, 8, 10, 12, 13]:
                page.select_option('#order', str(order))
                state = get()
                assert state['complete']
                assert (state['aggregationCount'] if state['mode'] == 'aggregate' else state['displayedCount']) == state['selectedCount']
            page.select_option('#order', '6')
            page.select_option('#budget', '100000')
            for mode in ['points', 'bars', 'aggregate']:
                page.select_option('#mode', mode)
                state = get()
                assert state['mode'] == mode and state['complete']
                settled()
                page.screenshot(path=str(OUT / f'distance-{mode}-desktop.png'), full_page=True)
            page.select_option('#axis', 'redshift')
            assert get()['radialMax'] == 2
            assert '当前径向轴直接表示观测红移' in page.inner_text('#basis')
            page.select_option('#axis', 'distance')
            assert get()['radialMax'] > 5000 and not get()['peculiarVelocityCorrected']
            assert '未校正' in page.inner_text('.details') and '不是独立测量' in page.inner_text('#basis')
            page.select_option('#population', 'multi')
            assert get()['selectedCount'] == 57000
            page.select_option('#population', 'empty')
            assert get()['selectedCount'] == 0 and '不证明真实天空' in page.inner_text('#picked')
            page.select_option('#population', '18000')
            page.set_viewport_size({'width': 390, 'height': 844})
            settled()
            page.screenshot(path=str(OUT / 'distance-mobile.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.set_viewport_size({'width': 1440, 'height': 1100})
            performance = []
            for rows in ['5000', '10000', '50000', '100000']:
                page.select_option('#rows', rows)
                for mode in ['points', 'bars']:
                    page.select_option('#mode', mode)
                    timing = page.evaluate('''async () => {
                        const times = []; let previous;
                        for (let i=0;i<35;i++) {
                            window.distancePrototype.rotate();
                            const now = await new Promise(requestAnimationFrame);
                            if (previous !== undefined && i>4) times.push(now-previous);
                            previous = now;
                        }
                        times.sort((a,b)=>a-b);
                        const average = times.reduce((a,b)=>a+b,0)/times.length;
                        return {medianFrameMs:times[Math.floor(times.length/2)],p95FrameMs:times[Math.floor(times.length*.95)],averageFps:1000/average};
                    }''')
                    performance.append({'inputRows': int(rows), **get(), **timing})
            page.select_option('#mode', 'aggregate')
            settled()
            page.screenshot(path=str(OUT / 'distance-final-desktop.png'), full_page=True)
            # Query actual context diagnostics, without assuming hardware acceleration.
            gpu = page.evaluate('''() => {const gl=document.querySelector('canvas').getContext('webgl2');const d=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION)};}''')
            real_sample = None
            if args.desi_sample:
                expected_sample = json.loads(args.desi_sample.read_text())
                page.set_input_files('#sample-file', str(args.desi_sample))
                page.wait_for_function('window.distancePrototype.getSnapshot().dataOrigin === "desi-dr1-local"')
                real_sample = get()
                assert real_sample['accepted'] > 0 and real_sample['source'] == expected_sample['source']
                assert not real_sample['skyRegionComplete'] and real_sample['rowCount'] == len(expected_sample['objects'])
                assert '完整天区' in page.inner_text('#sample-message') or '完整性未验证' in page.inner_text('#sample-message')
                assert '合成' not in page.inner_text('#data-origin')
                assert page.locator('#rows').is_disabled()
                for order in [4, 6, 8, 10, 12, 13]:
                    page.select_option('#order', str(order))
                    state = get()
                    assert state['complete'] and state['selectedCount'] > 0
                    assert (state['aggregationCount'] if state['mode'] == 'aggregate' else state['displayedCount']) == state['selectedCount']
                page.select_option('#order', '6')
                for mode in ['points', 'bars', 'aggregate']:
                    page.select_option('#mode', mode)
                    settled()
                    page.screenshot(path=str(OUT / f'desi-real-{mode}.png'), full_page=True)
                page.select_option('#axis', 'redshift')
                assert get()['radialMax'] == 2
                page.select_option('#axis', 'distance')
                page.select_option('#population', 'empty')
                assert get()['selectedCount'] == 0
                page.set_input_files('#sample-file', {'name': 'invalid.json', 'mimeType': 'application/json', 'buffer': b'{}'})
                page.wait_for_function('document.querySelector("#sample-message").textContent.includes("载入失败")')
                assert get()['dataOrigin'] == 'desi-dr1-local'
                first_real_option = page.locator('#population option').first.get_attribute('value')
                page.select_option('#population', first_real_option)
                page.set_viewport_size({'width': 390, 'height': 844})
                settled()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path=str(OUT / 'desi-real-mobile.png'), full_page=True)
                page.click('#restore-synthetic')
                assert get()['dataOrigin'] == 'synthetic' and not page.locator('#rows').is_disabled()
            assert not errors, errors
            result = {'dataOrigin': 'synthetic', 'browser': browser.version, 'host': platform.platform(), 'gpu': gpu,
                      'viewport': {'width': 1440, 'height': 1100}, 'functionalChecksPassed': True, 'pageErrors': errors,
                      'performance': performance, 'desiSample': real_sample,
                      'note': 'Headless container measurement, not a user hardware FPS guarantee; performance runs use synthetic samples. Optional DESI row-window import is checked separately.'}
            (OUT / 'browser-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
            print(json.dumps({'checks': 'passed', 'output': str(OUT), 'gpu': gpu,
                              'performance': [{'rows': r['inputRows'], 'shown': r['displayedCount'], 'mode': r['mode'], 'fps': round(r['averageFps'], 1), 'updateMs': round(r['updateMs'], 1)} for r in performance]}, ensure_ascii=False))
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == '__main__':
    main()
