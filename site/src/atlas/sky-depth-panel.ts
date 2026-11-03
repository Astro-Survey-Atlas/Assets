import type { AtlasCoverageGlobe } from "../atlas-coverage-globe.js";
import type { SkyDepthAxis, SkyDepthQuery, SkyDepthResponse, SkyDepthSourceResult } from "../../../src/sky-depth.js";
import type { SkyDepthAggregate } from "./sky-depth-layer.js";
import { locale } from "../i18n.js";
import "./sky-depth.css";

export type SkyDepthSelection = Pick<SkyDepthQuery, "order" | "cells" | "sources">;
export interface SkyDepthControls {
  close(): void;
  updateSelection(selection: SkyDepthSelection, retry?: boolean): void;
  focus(): boolean;
}
const copy = (en: string, zh: string) => locale() === "zh" ? zh : en;
const key = (s: SkyDepthSelection) => JSON.stringify([s.order, [...s.cells].sort((a,b)=>a-b), s.sources.map(v=>`${v.surveyId}:${v.releaseId}:${v.role ?? "survey"}`).sort()]);
const formatAxisValue = (value: number, axis: SkyDepthAxis) => value.toFixed(axis === "distance" ? 0 : 2);

/** Selected-cell evidence flows below the inspector; it never owns a camera or overlay. */
export function openSkyDepth(initial: SkyDepthSelection, globe: AtlasCoverageGlobe, panel: HTMLElement): SkyDepthControls {
  let selection = initial, selectionKey = key(initial), controller: AbortController | null = null;
  let revision = 0, disposed = false, hasPoints = false;
  const ranges = new Map<SkyDepthAxis, [number, number]>();
  let currentDomain: [number, number] | null = null;
  let currentAxis: SkyDepthAxis = "distance";
  panel.hidden = true;
  panel.innerHTML = `
    <strong id="coverage-depth-title" class="coverage-inspector-title">DEPTH</strong>
    <p class="depth-selection-note" hidden></p>
    <p class="depth-reference-note" hidden>${copy("DESI DR1 is a coordinate-based reference for this cell, not a measurement of the selected survey's objects. No object cross-match is performed.", "DESI DR1 仅按天区坐标作为该区块的参考，不代表所选巡天中的天体测量；未进行天体交叉匹配。")}</p>
    <dl class="depth-facts"><dt>${copy("GALAXIES", "星系数量")}</dt><dd class="depth-count"></dd><dt>${copy("AGGREGATES", "聚合点")}</dt><dd class="depth-count-note"></dd><dt>${copy("CELLS WITH DEPTH", "有纵深数据区块")}</dt><dd class="depth-cell-count"></dd></dl>
    <label class="depth-axis-label"><span>${copy("DEPTH AXIS", "纵深依据")}</span><select class="depth-axis"><option value="distance">${copy("Inferred comoving distance / Mpc", "推算共动距离 / Mpc")}</option><option value="redshift">${copy("Observed redshift / z", "观测红移 / z")}</option></select></label>
    <div class="depth-range-control">
      <div class="depth-range-heading"><span>${copy("EMPHASIS RANGE", "强调范围")}</span><output class="depth-range-selection"></output></div>
      <div class="depth-range-slider">
        <div class="depth-range-track" aria-hidden="true"><i class="depth-range-muted-left"></i><i class="depth-range-muted-right"></i></div>
        <input class="depth-range-lower" type="range" aria-label="${copy("Minimum highlighted value", "高亮范围下界")}" />
        <input class="depth-range-upper" type="range" aria-label="${copy("Maximum highlighted value", "高亮范围上界")}" />
      </div>
      <div class="depth-range-domain"><span class="depth-near"></span><span class="depth-far"></span></div>
    </div>
    <div class="depth-size-legend"></div><p class="depth-size-note">${copy("Disc area ∝ galaxy count", "圆点面积 ∝ 星系数量")}</p>
    <p class="depth-method"></p><p class="depth-picked" aria-live="polite" hidden></p>
    <details class="depth-explanation"><summary>${copy("Sources and distance basis", "来源与距离依据")}</summary><div class="depth-sources"></div>
    <p>${copy("Planck18 line-of-sight comoving distance inferred from DESI galaxy redshift. Barycentric frame; no peculiar-velocity or CMB correction. Systematics are unknown; this is not an independently measured distance.", "依据 DESI 星系红移，按 Planck18 推算视线共动距离。保留太阳系质心参考系，未校正本动速度或 CMB 参考系，系统误差未知；不是独立测量的真实距离。")}</p>
    <p>${copy("Mpc (megaparsec) is a standard astronomical length unit: 1 Mpc ≈ 3.26 million light-years. Planck18 specifies the cosmology used to infer this comoving distance from redshift.", "Mpc（兆秒差距）是通用天文长度单位：1 Mpc 约 326 万光年。Planck18 指定的是由红移推算共动距离所用的宇宙学模型。")}</p>
    <p>${copy("Main primary galaxies, OBJTYPE=TGT, ZWARN=0, PROGRAM≠other. Distance uses 0.02≤z≤2 as a display policy, not a reliability guarantee; z mode retains other suitable measured redshifts.", "展示 Main 主测量星系，要求 OBJTYPE=TGT、ZWARN=0、PROGRAM≠other。距离模式用 0.02≤z≤2 作展示筛选，不是可靠性保证；z 模式保留其他有效红移。")}</p>
    <p>${copy("Each selected cell rises only to its maximum eligible measurement. All cells and HEALPix orders share the source-wide radial scale. Empty cells keep the white base outline without an invented height. Points are aggregate-bin centres, not individual objects or a metric volume; disc area is proportional to count.", "每个选中区块只升到该区块适用测量的最大值。所有区块与 HEALPix 阶数共用来源全局径向刻度。空区块保留白色底面轮廓，不虚构高度。光点是聚合箱中心，不代表单个天体或等比例宇宙体积；圆点面积与数量成正比。")}</p><p class="depth-provenance"></p></details>
    <p class="depth-scope"></p>`;
  const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const formatWithUnit = (value: number, axis: SkyDepthAxis) => `${formatAxisValue(value, axis)} ${axis === "distance" ? "Mpc" : "z"}`;
  function applyRange(lower: number, upper: number, changed: "lower" | "upper" | "domain") {
    if (!currentDomain) return;
    const domainMin = currentDomain[0], domainMax = currentDomain[1], span = domainMax - domainMin;
    const lowerInput = find<HTMLInputElement>(".depth-range-lower"), upperInput = find<HTMLInputElement>(".depth-range-upper");
    const preferredStep = currentAxis === "distance" ? 1 : .01;
    const minGap = Math.min(preferredStep, span);
    let low = Math.max(domainMin, Math.min(domainMax, Math.min(lower, upper)));
    let high = Math.max(domainMin, Math.min(domainMax, Math.max(lower, upper)));
    if (span > 0 && high - low < minGap) {
      if (changed === "lower") low = Math.max(domainMin, high - minGap);
      else high = Math.min(domainMax, low + minGap);
      if (high - low < minGap) low = Math.max(domainMin, high - minGap);
    }
    lowerInput.value = String(low);
    upperInput.value = String(high);
    lowerInput.setAttribute("aria-valuetext", formatWithUnit(low, currentAxis));
    upperInput.setAttribute("aria-valuetext", formatWithUnit(high, currentAxis));
    const output = find<HTMLOutputElement>(".depth-range-selection");
    output.textContent = `${formatWithUnit(low, currentAxis)} – ${formatWithUnit(high, currentAxis)}`;
    const slider = find<HTMLElement>(".depth-range-slider");
    const start = span > 0 ? (low - domainMin) / span * 100 : 0;
    const end = span > 0 ? (high - domainMin) / span * 100 : 100;
    slider.style.setProperty("--range-start", `${start}%`);
    slider.style.setProperty("--range-end", `${end}%`);
    ranges.set(currentAxis, [low, high]);
    const result = globe.setSkyDepthRange([low, high]);
    if (result) {
      panel.dataset.rangeMin = String(result.range[0]);
      panel.dataset.rangeMax = String(result.range[1]);
      panel.dataset.rangeIn = String(result.inRange);
      panel.dataset.rangeFaded = String(result.faded);
    }
  }
  function configureRange(domain: [number, number], axis: SkyDepthAxis) {
    currentDomain = domain;
    currentAxis = axis;
    const lowInput = find<HTMLInputElement>(".depth-range-lower"), highInput = find<HTMLInputElement>(".depth-range-upper");
    const span = domain[1] - domain[0];
    const step = Math.min(axis === "distance" ? 1 : .01, span || 1);
    for (const input of [lowInput, highInput]) {
      input.min = String(domain[0]);
      input.max = String(domain[1]);
      input.step = String(step);
      input.disabled = span <= 0;
    }
    find(".depth-near").textContent = formatWithUnit(domain[0], axis);
    find(".depth-far").textContent = formatWithUnit(domain[1], axis);
    const remembered = ranges.get(axis) ?? domain;
    applyRange(remembered[0], remembered[1], "domain");
  }
  const statuses: Record<SkyDepthSourceResult["status"], () => string> = {
    available: () => copy("Distance evidence available", "有距离依据"), "redshift-only": () => copy("Only redshift available", "仅红移可用"),
    empty: () => copy("No objects in this sample and region", "当前样本在选区内没有对象"), "no-measurements": () => copy("No suitable measurements", "没有适用测量"),
    "not-connected": () => copy("Depth evidence not connected", "纵深资料尚未接入"), unavailable: () => copy("Temporarily unavailable", "暂时无法读取"),
  };
  function clear(status: string) {
    hasPoints = false;
    panel.hidden = true;
    panel.dataset.status = status;
    panel.dataset.points = "0";
    panel.dataset.selectedCount = "0";
    globe.setSkyDepth(null);
  }
  function inspect(item: SkyDepthAggregate) {
    const v = item.voxel, unit = find<HTMLSelectElement>(".depth-axis").value === "distance" ? "Mpc (Planck18)" : "z";
    const picked = find(".depth-picked");
    picked.textContent = `${item.source.label} · ${v.count} ${copy("galaxies", "个星系")}\nO${v.order} / ${v.pixel} · ${v.radialMin.toFixed(3)}–${v.radialMax.toFixed(3)} ${unit}`;
    picked.hidden = false;
  }
  function render(result: SkyDepthResponse) {
    if (!result.sources.some(source => source.voxels.some(voxel => voxel.count > 0))) {
      clear(result.sources.some(source => source.status === "unavailable") ? "unavailable" : "empty");
      return;
    }
    const layout = globe.setSkyDepth(result, inspect);
    if (!layout?.items.length) { clear("empty"); return; }
    const count = layout.items.reduce((sum, item) => sum + item.voxel.count, 0);
    hasPoints = true;
    panel.dataset.points = String(layout.items.length);
    panel.dataset.selectedCount = String(count);
    panel.dataset.axis = result.query.axis;
    panel.dataset.mode = "aggregate";
    panel.dataset.status = "available";
    find(".depth-count").textContent = count.toLocaleString();
    const orders = [...new Set(result.sources.filter(s=>s.voxels.length).map(s=>`O${s.aggregationOrder}`))].join(" / ");
    find(".depth-count-note").textContent = `${layout.items.length.toLocaleString()} · ${orders} × 64`;
    find(".depth-cell-count").textContent = `${layout.frames.length} / ${result.query.cells.length}`;
    find<HTMLElement>(".depth-reference-note").hidden = !result.sources.some(source => source.role === "reference" && source.voxels.length > 0);
    const isDistance = result.query.axis === "distance";
    configureRange(layout.range, result.query.axis);
    find(".depth-method").textContent = isDistance ? copy("Planck18 estimate · peculiar velocities uncorrected · cell max / shared scale", "Planck18 推算 · 未校正本动速度 · 区块最大值 / 共用刻度") : copy("Measured z · cell max / shared scale", "测量红移 z · 区块最大值 / 共用刻度");
    const sizes = [...new Set([1, Math.max(1, Math.round(layout.maxCount / 3)), layout.maxCount])];
    find(".depth-size-legend").replaceChildren(...sizes.map(n => {
      const label = document.createElement("span"), dot = document.createElement("i"), value = document.createElement("b");
      const diameter = layout.baseDiameter * Math.sqrt(n);
      dot.style.width = dot.style.height = `${diameter}px`;
      value.textContent = String(n); label.append(dot, value); return label;
    }));
    find(".depth-sources").replaceChildren(...result.sources.map(s=> {
      const p = document.createElement("p"); p.textContent = `${s.label} · ${statuses[s.status]()}`; return p;
    }));
    const source = result.sources.find(s=>s.scope), scope = source?.scope;
    find(".depth-provenance").textContent = scope ? `iron v1 / zall-pix-iron.fits\n[${scope.rowStartInclusive}, ${scope.rowStopExclusive})\nSHA-256 ${source?.snapshotSha256}` : "";
    find(".depth-scope").textContent = scope ? copy("DESI DR1 row-window sample · sky completeness unverified; no points does not mean empty sky.", "DESI DR1 行窗口样本 · 天区完整性未验证；没有点不代表真实天空为空。") : "";
    panel.hidden = false;
  }
  async function load() {
    const request = ++revision;
    controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    clear("loading");
    find(".depth-picked").hidden = true;
    panel.dataset.order = String(selection.order);
    panel.dataset.cells = selection.cells.join(",");
    find(".depth-selection-note").hidden = selection.cells.length === 1;
    find(".depth-selection-note").textContent = `HEALPix O${selection.order} · ${selection.cells.length} ${copy("selected cells", "个选中区块")}`;
    try {
      const response = await fetch("/api/v1/sky-depth", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...selection, mode: "aggregate", axis: find<HTMLSelectElement>(".depth-axis").value }) });
      if (!response.ok) throw Error("Depth unavailable");
      const result = await response.json() as SkyDepthResponse;
      if (signal.aborted || disposed || request !== revision) return;
      if (result.query.axis === "distance" && result.sources.some(s=>s.status === "redshift-only") && !result.sources.some(s=>s.distanceCount)) {
        find<HTMLSelectElement>(".depth-axis").value = "redshift"; void load(); return;
      }
      render(result);
    } catch {
      if (!signal.aborted && !disposed && request === revision) clear("unavailable");
    }
  }
  function close() {
    if (disposed) return;
    disposed = true; revision++; controller?.abort(); clear("idle"); panel.replaceChildren();
  }
  find<HTMLInputElement>(".depth-range-lower").addEventListener("input", event => {
    const lower = Number((event.currentTarget as HTMLInputElement).value);
    applyRange(lower, Number(find<HTMLInputElement>(".depth-range-upper").value), "lower");
  });
  find<HTMLInputElement>(".depth-range-upper").addEventListener("input", event => {
    const upper = Number((event.currentTarget as HTMLInputElement).value);
    applyRange(Number(find<HTMLInputElement>(".depth-range-lower").value), upper, "upper");
  });
  find(".depth-axis").addEventListener("change", ()=>void load());
  void load();
  return {
    close,
    updateSelection(next, retry = false) {
      const nextKey = key(next);
      if (disposed || nextKey === selectionKey && (!retry || panel.dataset.status === "available" || panel.dataset.status === "loading")) return;
      selection = next; selectionKey = nextKey; void load();
    },
    focus() { if (hasPoints) globe.focusSkyDepth(); return hasPoints; },
  };
}
