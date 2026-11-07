/** Opening screen for the Atlas: it stays over the HUD until the survey
 * index, coverage catalog and layer overviews have arrived, so the page
 * never shows empty panels and "--" readouts while requests are in flight. */

export type BootStageId = "surveys" | "catalog" | "layers" | "scene";
type BootStageState = "wait" | "run" | "done" | "fail";

const STAGE_ORDER: BootStageId[] = ["surveys", "catalog", "layers", "scene"];
const STAGE_WEIGHT: Record<BootStageId, number> = { surveys: 0.2, catalog: 0.2, layers: 0.5, scene: 0.1 };

interface BootStage { state: BootStageState; done: number; total: number }

const stages = new Map<BootStageId, BootStage>(STAGE_ORDER.map((id) => [id, { state: "wait", done: 0, total: 0 }]));
let root: HTMLElement | null = null;
let startedAt = 0;
let clock: number | null = null;
let finished = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render(): void {
  if (!root) return;
  let progress = 0;
  for (const id of STAGE_ORDER) {
    const stage = stages.get(id)!;
    const row = root.querySelector<HTMLElement>(`[data-boot-stage="${id}"]`);
    const part = stage.state === "done" ? 1 : stage.total > 0 ? stage.done / stage.total : stage.state === "run" ? 0.15 : 0;
    progress += STAGE_WEIGHT[id] * part;
    if (!row) continue;
    row.dataset.state = stage.state;
    row.firstElementChild?.classList.toggle("hud-ring", stage.state === "run");
    const count = row.querySelector("output")!;
    count.textContent = stage.state === "done" ? "OK" : stage.state === "fail" ? "FAIL" : stage.total > 0 ? `${stage.done} / ${stage.total}` : stage.state === "run" ? "···" : "--";
  }
  const pct = Math.round(progress * 100);
  root.querySelector<HTMLElement>(".hud-boot-bar i")!.style.width = `${pct}%`;
  root.querySelector(".hud-boot-pct")!.textContent = `${String(pct).padStart(2, "0")}%`;
}

/** Mount the overlay; returns false when the page has no boot host. */
export function startHudBoot(labels: Record<BootStageId, string>, title: string): boolean {
  const host = document.getElementById("hud-boot");
  if (!host) return false;
  root = host;
  startedAt = performance.now();
  const list = el("ol", "hud-boot-stages");
  for (const id of STAGE_ORDER) {
    const row = el("li");
    row.dataset.bootStage = id;
    row.append(el("i"), el("span", undefined, labels[id]), el("output", undefined, "--"));
    list.append(row);
  }
  const head = el("div", "hud-boot-head");
  head.append(el("span", "hud-boot-spinner"), el("b", undefined, title), el("time", "hud-boot-elapsed", "0.0s"));
  const bar = el("div", "hud-boot-bar");
  bar.append(el("i"));
  const foot = el("div", "hud-boot-foot");
  foot.append(el("span", "hud-boot-pct", "00%"), el("small", "hud-boot-note"));
  host.querySelector(".hud-boot-panel")!.append(head, list, bar, foot);
  host.hidden = false;
  clock = window.setInterval(() => {
    const time = host.querySelector(".hud-boot-elapsed");
    if (time) time.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  }, 100);
  render();
  return true;
}

export function bootStage(id: BootStageId, state: BootStageState, done?: number, total?: number): void {
  if (finished) return;
  const stage = stages.get(id)!;
  stage.state = state;
  if (total != null) stage.total = total;
  if (done != null) stage.done = done;
  render();
}

/** Count one finished unit of a stage that has a known total. */
export function bootTick(id: BootStageId): void {
  if (finished) return;
  const stage = stages.get(id)!;
  stage.done = Math.min(stage.total, stage.done + 1);
  render();
}

export function bootActive(): boolean {
  return Boolean(root) && !finished;
}

/** Fade the overlay out. A failure note stays readable briefly first. */
export function finishHudBoot(note?: string): void {
  if (!root || finished) return;
  finished = true;
  if (clock != null) window.clearInterval(clock);
  const host = root;
  if (note) host.querySelector(".hud-boot-note")!.textContent = note;
  render();
  host.dataset.state = note ? "fail" : "done";
  window.setTimeout(() => {
    host.dataset.state = "leaving";
    window.setTimeout(() => { host.hidden = true; }, 520);
  }, note ? 1600 : 260);
}
