import { locale } from "../i18n.js";

/**
 * First-visit coach marks for /atlas/. A HUD plate points at one control at a
 * time; all positions are set with style.setProperty (CSP-safe). Shown once
 * per browser (localStorage), replayable from the help panel. `?guide=0`
 * suppresses it (used by automated tests); `?guide=1` forces it.
 */

const STORAGE_KEY = "asa-atlas-guide-v1";

interface GuideStep { target: string; en: [string, string]; zh: [string, string] }

const STEPS: GuideStep[] = [
  {
    target: "#coverage-layers, #coverage-layers-toggle",
    en: ["Choose surveys", "Tick surveys, releases or single products in LAYERS. Each colour is one survey; the number on the right is its sky fraction."],
    zh: ["选择巡天", "在 LAYERS 里勾选巡天、DR 或单个产品。每种颜色代表一个巡天，右侧数字是它的天区覆盖比例。"],
  },
  {
    target: ".coverage-inspector-rail",
    en: ["Target lock", "Shows what is selected now: the HEALPix order, visible cells and the public coverage behind it. Click a cell on the sphere to inspect it."],
    zh: ["目标锁定", "显示当前选择：HEALPix 阶数、可见单元和对应的公开覆盖。点击天球上的单元可查看它的详情。"],
  },
  {
    target: ".coverage-display-order-control",
    en: ["Display order", "Switch the HEALPix order. Only orders the selected products really publish are offered; higher orders are fetched on demand."],
    zh: ["显示阶数", "切换 HEALPix 阶数。只提供所选产品实际发布的阶数；高阶数据按需加载，加载时这里会显示圆环。"],
  },
  {
    target: "#coverage-canvas",
    en: ["Common area", "Select two or more surveys and press G to see where they overlap. Drag to rotate, scroll to zoom, F focuses the selection."],
    zh: ["公共覆盖", "选中两个或以上巡天后按 G 查看重合区域。拖动旋转、滚轮缩放，按 F 聚焦当前选择。"],
  },
  {
    target: ".coverage-inspector-rail",
    en: ["Sources, not data", "Exports are source manifests (JSON/CSV) that point to the archive. Scientific data is retrieved from the archive under its access policy."],
    zh: ["来源清单而非数据", "导出的是指向原始档案的来源清单（JSON/CSV）。科学数据需按各档案的访问政策从源头获取。"],
  },
  {
    target: "#coverage-help-toggle",
    en: ["Help any time", "Shortcuts live here, and you can replay this guide from the help panel."],
    zh: ["随时查看帮助", "快捷键说明在这里，也可以从帮助面板重新播放本引导。"],
  },
];

let root: HTMLElement | null = null;
let index = 0;
let previousFocus: HTMLElement | null = null;

function visibleTarget(selector: string): HTMLElement | null {
  for (const candidate of selector.split(",")) {
    const element = document.querySelector<HTMLElement>(candidate.trim());
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && !element.closest("[hidden]")) return element;
  }
  return null;
}

function build(): HTMLElement {
  const host = document.createElement("div");
  host.className = "hud-guide";
  host.innerHTML = `
    <div class="hud-guide-focus" aria-hidden="true"></div>
    <section class="hud-guide-plate" role="dialog" aria-modal="false" aria-labelledby="hud-guide-title" aria-describedby="hud-guide-body">
      <div class="hud-guide-head"><span class="hud-guide-step"></span><button type="button" class="hud-guide-skip" data-guide="skip"></button></div>
      <h2 id="hud-guide-title"></h2>
      <p id="hud-guide-body"></p>
      <div class="hud-guide-foot">
        <span class="hud-guide-dots" aria-hidden="true"></span>
        <button type="button" class="hud-guide-back" data-guide="back"></button>
        <button type="button" class="hud-guide-next" data-guide="next"></button>
      </div>
    </section>`;
  host.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-guide]")?.dataset.guide;
    if (action === "skip") close();
    else if (action === "back") show(index - 1);
    else if (action === "next") index >= STEPS.length - 1 ? close() : show(index + 1);
  });
  document.body.append(host);
  return host;
}

function place(): void {
  if (!root) return;
  const step = STEPS[index]!;
  const target = visibleTarget(step.target);
  const focus = root.querySelector<HTMLElement>(".hud-guide-focus")!;
  const plate = root.querySelector<HTMLElement>(".hud-guide-plate")!;
  const vw = window.innerWidth, vh = window.innerHeight;
  const plateWidth = Math.min(360, vw - 32);
  plate.style.setProperty("--guide-w", `${plateWidth}px`);
  if (!target) {
    focus.hidden = true;
    plate.style.setProperty("--guide-x", `${(vw - plateWidth) / 2}px`);
    plate.style.setProperty("--guide-y", `${Math.max(16, vh / 2 - 110)}px`);
    return;
  }
  const rect = target.getBoundingClientRect();
  // The canvas fills the screen: ring its centre instead of the whole viewport.
  const big = rect.width > vw * 0.7 && rect.height > vh * 0.7;
  const box = big
    ? { left: vw / 2 - 160, top: vh / 2 - 160, width: 320, height: 320 }
    : { left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 };
  focus.hidden = false;
  focus.classList.toggle("is-round", big);
  focus.style.setProperty("--guide-fx", `${box.left}px`);
  focus.style.setProperty("--guide-fy", `${box.top}px`);
  focus.style.setProperty("--guide-fw", `${box.width}px`);
  focus.style.setProperty("--guide-fh", `${box.height}px`);
  const plateHeight = plate.offsetHeight || 220;
  const gap = 16;
  let x: number, y: number;
  if (box.left + box.width + gap + plateWidth <= vw - 16) { x = box.left + box.width + gap; y = box.top; }
  else if (box.left - gap - plateWidth >= 16) { x = box.left - gap - plateWidth; y = box.top; }
  else {
    // Narrow screens: put the plate on whichever side (above/below) has more room
    // so it never sits on top of the highlighted control.
    x = box.left + box.width / 2 - plateWidth / 2;
    const below = vh - (box.top + box.height + gap);
    const above = box.top - gap;
    y = below >= plateHeight + 16 || below >= above ? box.top + box.height + gap : box.top - gap - plateHeight;
  }
  x = Math.min(Math.max(16, x), vw - plateWidth - 16);
  y = Math.min(Math.max(16, y), vh - plateHeight - 16);
  plate.style.setProperty("--guide-x", `${x}px`);
  plate.style.setProperty("--guide-y", `${y}px`);
}

function show(next: number): void {
  if (!root) return;
  index = Math.max(0, Math.min(STEPS.length - 1, next));
  const zh = locale() === "zh";
  const [title, body] = zh ? STEPS[index]!.zh : STEPS[index]!.en;
  root.querySelector(".hud-guide-step")!.textContent = `◆ ${zh ? "引导" : "GUIDE"} · ${String(index + 1).padStart(2, "0")} / ${String(STEPS.length).padStart(2, "0")}`;
  root.querySelector("#hud-guide-title")!.textContent = title;
  root.querySelector("#hud-guide-body")!.textContent = body;
  root.querySelector(".hud-guide-skip")!.textContent = zh ? "跳过" : "SKIP";
  const back = root.querySelector<HTMLButtonElement>(".hud-guide-back")!;
  back.textContent = zh ? "上一步" : "BACK";
  back.hidden = index === 0;
  root.querySelector(".hud-guide-next")!.textContent = index === STEPS.length - 1 ? (zh ? "开始探索" : "START") : (zh ? "下一步" : "NEXT");
  const dots = root.querySelector(".hud-guide-dots")!;
  dots.replaceChildren(...STEPS.map((_, i) => Object.assign(document.createElement("i"), { className: i === index ? "is-on" : "" })));
  place();
  requestAnimationFrame(place);
  root.querySelector<HTMLButtonElement>(".hud-guide-next")!.focus({ preventScroll: true });
}

function onKey(event: KeyboardEvent): void {
  if (!root) return;
  if (event.key === "Escape") { event.stopPropagation(); close(); }
  else if (event.key === "ArrowRight") show(index + 1);
  else if (event.key === "ArrowLeft") show(index - 1);
}

export function openAtlasGuide(): void {
  if (root) return;
  previousFocus = document.activeElement as HTMLElement | null;
  root = build();
  document.body.dataset.guide = "open";
  window.addEventListener("resize", place);
  window.addEventListener("keydown", onKey, true);
  show(0);
}

function close(): void {
  if (!root) return;
  try { localStorage.setItem(STORAGE_KEY, "done"); } catch { /* private mode */ }
  window.removeEventListener("resize", place);
  window.removeEventListener("keydown", onKey, true);
  root.remove();
  root = null;
  delete document.body.dataset.guide;
  previousFocus?.focus?.({ preventScroll: true });
}

/** Called once the atlas has finished booting. */
export function maybeStartAtlasGuide(): void {
  const flag = new URLSearchParams(location.search).get("guide");
  if (flag === "0" || navigator.webdriver && flag !== "1") return;
  let seen = false;
  try { seen = localStorage.getItem(STORAGE_KEY) === "done"; } catch { seen = true; }
  if (seen && flag !== "1") return;
  window.setTimeout(openAtlasGuide, 700);
}
