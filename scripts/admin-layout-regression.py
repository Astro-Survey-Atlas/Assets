"""Read-only browser regression for icon registration, action styles and metric overflow."""
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
source = (root / 'site/admin/main.ts').read_text()
registry = re.search(r'nameAttr: "data-icon-pending", icons: (\{.*?\})', source).group(1)
icons = '<i data-icon-pending="grid-3x3"></i><i data-icon-pending="upload-cloud"></i>'
button = '<button class="admin-quiet"><span>查看状态</span></button>'
phase = '<span class="task-phase task-phase-succeeded"><span>SUCCEEDED</span></span>'
metrics = ''.join(f'<span class="task-metric"><span>{label}</span><strong>123456789</strong></span>' for label in ['files', 'coverage', 'objects', 'errors', 'orders'])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/snap/chromium/current/usr/lib/chromium-browser/chrome', args=['--no-sandbox'])
    page = browser.new_page()
    errors = []
    page.on('console', lambda msg: errors.append(msg.text) if 'icon name was not found' in msg.text else None)
    page.set_content(f'{icons}<article class="resource-row moc-discovery-row"><div>Euclid</div><div class="moc-discovery-row-actions">{phase}{button}</div></article><div class="work-output-status">{phase}<div class="work-output-actions">{button}</div></div><table><tr><td>Task</td><td><div class="task-metric-list">{metrics}</div></td><td>2026-09-17 12:30</td></tr></table><div class="work-output-metrics"><div>{metrics}</div><div>{metrics}</div></div>')
    page.add_style_tag(path=str(root / 'site/admin/styles.css'))
    page.add_script_tag(path=str(root / 'node_modules/lucide/dist/umd/lucide.js'))
    page.evaluate('(registry) => { const render = new Function("lucide", "with(lucide) { return " + registry + " }"); lucide.createIcons({nameAttr:"data-icon-pending", icons:render(lucide)}); }', registry)
    failures = list(errors)
    for width in [1440, 900, 390]:
        page.set_viewport_size({'width': width, 'height': 900})
        result = page.evaluate('''() => {
          const style = s => {const e=document.querySelector(s), c=getComputedStyle(e); return [c.color,c.fontSize,c.fontFamily,c.marginTop].join('|')};
          return {sameButton:style('.moc-discovery-row-actions button span')===style('.work-output-actions button span'), samePhase:style('.moc-discovery-row-actions .task-phase span')===style('.work-output-status .task-phase span'), overflow:[...document.querySelectorAll('.task-metric-list,.work-output-metrics > div')].some(e=>e.scrollWidth>e.clientWidth+1)};
        }''')
        if not result['sameButton'] or not result['samePhase'] or result['overflow']:
            failures.append(f'{width}: {result}')
    browser.close()
    assert not failures, failures
print('PASS: icons, matching action/status typography, metric containment at 1440/900/390px')
