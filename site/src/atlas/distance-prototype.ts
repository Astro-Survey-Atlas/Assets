/** Development-only feasibility route; intentionally absent from production build inputs. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Healpix } from "healpixjs";
import referenceJson from "../../../fixtures/distance-prototype/planck18-reference.json";
import { aggregatePoints, comovingDistance, parentPixel, parseDistanceSample, pixelCenter, planRepresentation, prepareObjects, selectPoints,
  syntheticCatalogue, type DistanceReference, type DistanceSample, type DistanceVoxel, type Selection } from "../../../src/distance-feasibility.js";
import "./distance-prototype.css";

const table: DistanceReference = referenceJson;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => el<HTMLSelectElement>(id).value;
const canvas = el<HTMLCanvasElement>("sky");
const scene = new THREE.Scene(); scene.background = new THREE.Color("#040b16");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
const camera = new THREE.PerspectiveCamera(40, 1, .00005, 30);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.minDistance = .0001; controls.maxDistance = 8;
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshBasicMaterial({ color: 0x0b1928 })); scene.add(sphere);
const dataGroup = new THREE.Group(); scene.add(dataGroup);
const axisGroup = new THREE.Group(); scene.add(axisGroup);
const maxDistance = comovingDistance(2, table);
const displayDepth = .40;
const direction = (ra: number, dec: number) => {
  const a = ra * Math.PI / 180, d = dec * Math.PI / 180;
  return new THREE.Vector3(-Math.cos(d) * Math.sin(a), Math.sin(d), -Math.cos(d) * Math.cos(a));
};
function fromHealpix(v: { x: number; y: number; z: number }) { return new THREE.Vector3(-v.y, v.z, -v.x); }
const rawBasis = el("basis").textContent!;
let prepared = prepareObjects(syntheticCatalogue(60_000), table);
let lastRows = 60_000;
let importedSample: DistanceSample | null = null;
let importRevision = 0;
let realParents: number[] = [];
const syntheticPopulations = el("population").innerHTML;
let selection: Selection = { order: 6, pixels: [18000] };
let snapshot: Record<string, unknown> = {};
let rawPicked = prepared.points;
let voxelPicked: DistanceVoxel[] = [];
let cloud: THREE.Points | null = null;
let barMesh: THREE.LineSegments | null = null;
let updateMs = 0;
const textureCanvas = document.createElement("canvas"); textureCanvas.width = textureCanvas.height = 32;
const ctx = textureCanvas.getContext("2d")!;
const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
gradient.addColorStop(0, "rgba(255,255,255,1)"); gradient.addColorStop(.18, "rgba(255,255,255,1)");
gradient.addColorStop(.4, "rgba(255,255,255,.28)"); gradient.addColorStop(1, "rgba(255,255,255,0)");
ctx.fillStyle = gradient; ctx.fillRect(0, 0, 32, 32);
const sprite = new THREE.CanvasTexture(textureCanvas);
function clear(group: THREE.Group) {
  for (const item of [...group.children]) {
    group.remove(item);
    if (item instanceof THREE.Mesh || item instanceof THREE.Points || item instanceof THREE.LineSegments) {
      item.geometry.dispose();
      for (const material of Array.isArray(item.material) ? item.material : [item.material]) material.dispose();
    }
  }
}
function chooseSelection(): Selection {
  const order = Number(value("order"));
  const population = value("population");
  if (population === "empty") {
    const occupied = new Set(prepared.points.map(p => parentPixel(p.pixel13, order)));
    let pixel = 0; while (occupied.has(pixel) && pixel < 12 * 4 ** order - 1) pixel++;
    return { order, pixels: [pixel] };
  }
  const parents = population === "multi" ? (importedSample ? realParents.slice(0, 2) : [18000, 19000]) : [Number(population)];
  const pixels = parents.map(parent => {
    const counts = new Map<number, number>();
    for (const p of prepared.points) {
      if (parentPixel(p.pixel13, 6) !== parent) continue;
      const pixel = parentPixel(p.pixel13, order); counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  }).filter((pixel): pixel is number => pixel !== undefined);
  return { order, pixels: pixels.length ? [...new Set(pixels)] : [0] };
}
function rebuild() {
  const started = performance.now();
  const rows = Number(value("rows"));
  if (!importedSample && rows !== lastRows) { prepared = prepareObjects(syntheticCatalogue(rows), table); lastRows = rows; }
  selection = chooseSelection();
  const mode = value("mode") as "points" | "bars" | "aggregate", bins = Number(value("bins"));
  const axis = value("axis"), radialMax = axis === "distance" ? maxDistance : 2;
  // Redshift mode uses raw z for radial bins and positions; distance remains explicit metadata.
  const coordinates = axis === "distance" ? prepared.points : prepared.points.map(p => ({ ...p, distanceMpc: p.redshift! }));
  const result = planRepresentation(coordinates, selection, bins, radialMax, mode, Number(value("budget")));
  let voxels = result.voxels;
  let order = result.order;
  if (result.mode === "aggregate" && value("aggregation") !== "auto") {
    order = Math.min(13, selection.order + Number(value("aggregation")));
    voxels = aggregatePoints(result.selected, order, bins, radialMax);
  }
  const overflow = result.budgetExceeded || voxels.length > 32_768;
  const displayMode = result.mode;
  rawPicked = selectPoints(prepared.points, selection); voxelPicked = overflow ? [] : voxels;
  clear(dataGroup); clear(axisGroup); cloud = null; barMesh = null;
  const healpix = new Healpix(2 ** selection.order);
  const outlines: number[] = [];
  let center = new THREE.Vector3();
  for (const pixel of selection.pixels) {
    const boundary = healpix.getBoundaries(pixel).map(v => fromHealpix(v).multiplyScalar(1.001));
    for (let i = 0; i < 4; i++) outlines.push(...boundary[i]!.toArray(), ...boundary[(i + 1) % 4]!.toArray());
    center.add(fromHealpix(healpix.pix2vec(pixel)));
  }
  center.normalize();
  const outlineGeometry = new THREE.BufferGeometry(); outlineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(outlines, 3));
  dataGroup.add(new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: 0x36dcf2, transparent: true, opacity: .9 })));
  const positions: number[] = [], colors: number[] = [], lines: number[] = [], lineColors: number[] = [];
  const push = (ra: number, dec: number, radial: number, count: number) => {
    const dir = direction(ra, dec), r = 1.004 + displayDepth * radial / radialMax;
    const position = dir.clone().multiplyScalar(r);
    const color = new THREE.Color().setHSL(.11 + radial / radialMax * .43, .9, .6);
    if (displayMode === "aggregate") color.multiplyScalar(Math.min(1, .35 + Math.log2(count + 1) * .16));
    positions.push(...position.toArray()); colors.push(...color.toArray());
    if (displayMode === "bars") { lines.push(...dir.multiplyScalar(1.004).toArray(), ...position.toArray()); lineColors.push(...color.toArray(), ...color.toArray()); }
  };
  if (!overflow) {
    if (displayMode === "aggregate") {
      for (const voxel of voxels) { const c = pixelCenter(voxel.order, voxel.pixel); push(c.raDeg, c.decDeg, (voxel.radialBin + .5) / bins * radialMax, voxel.count); }
    } else for (const p of result.selected) push(p.raDeg, p.decDeg, p.distanceMpc, 1);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  cloud = new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors: true, size: .0018, map: sprite,
    transparent: true, opacity: .95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  dataGroup.add(cloud);
  if (lines.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
    barMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending })); dataGroup.add(barMesh);
  }
  const tangent = new THREE.Vector3().crossVectors(center, new THREE.Vector3(0, 1, 0)).normalize();
  if (!tangent.length()) tangent.set(1, 0, 0);
  controls.target.copy(center).multiplyScalar(1.004 + displayDepth * .25);
  camera.position.copy(center).multiplyScalar(1.004 + displayDepth * .25 + .22).addScaledVector(tangent, .35).addScaledVector(new THREE.Vector3(0, 1, 0), .16);
  controls.update();
  updateMs = performance.now() - started;
  el("status").textContent = `选区 O${selection.order} [${selection.pixels.join(", ")}] · 有效星系 ${result.selected.length.toLocaleString()} · ${overflow ? "超出完整显示预算，请缩小选区或调粗聚合" : displayMode === "aggregate" ? `O${order} 聚合 / ${voxels.length.toLocaleString()} 个非空统计单元` : `${displayMode === "points" ? "散点" : "细柱"} ${result.selected.length.toLocaleString()} 个`} · 更新 ${updateMs.toFixed(0)} ms`;
  const frames = [...new Set(rawPicked.map(p => p.redshiftFrame))].join(", ");
  el("precision").textContent = `选区 O${selection.order}；${displayMode === "aggregate" ? `聚合 O${order}；${bins} 个径向箱；箱宽 ${(radialMax / bins).toFixed(axis === "distance" ? 1 : 4)} ${axis === "distance" ? "Mpc" : "z"}。` : "逐天体角位置，无角向或径向分箱。"} ${overflow ? "完整数据超预算，本次未绘制部分结果。" : importedSample ? "完整显示导入样本内的有效对象；行窗口不代表完整天区，不能据此统计巡天面密度。" : "未抽样，计数针对完整合成样本。"} 参考系：${frames || "无有效样本"}。`;
  el("basis").textContent = axis === "distance" ? rawBasis : "当前径向轴直接表示观测红移 z，无距离单位。点击数据仍可查看按 Planck18 推算的共动距离及其限制。";
  el("axis-label").textContent = axis === "distance" ? `径向：红移推算的共动距离 / Mpc · 固定 0–${maxDistance.toFixed(0)} Mpc 显示尺度` : "径向：观测红移 z · 固定 0–2 显示尺度";
  el("picked").textContent = result.selected.length ? "点击发光点或柱端，查看原始红移和距离依据。" : "这个样区没有有效样本；这不证明真实天空没有天体。";
  snapshot = { dataOrigin: importedSample?.dataOrigin ?? "synthetic", rowCount: importedSample?.objects.length ?? rows,
    accepted: prepared.accepted, excluded: prepared.excluded, source: importedSample?.source ?? null, skyRegionComplete: false,
    selection, mode: displayMode, requestedMode: mode, selectedCount: result.selected.length,
    displayedCount: positions.length / 3, aggregationOrder: order, bins: displayMode === "aggregate" ? bins : null, axis, radialMax, budgetExceeded: overflow,
    complete: !overflow, aggregationCount: voxels.reduce((sum, v) => sum + v.count, 0), updateMs,
    distanceBasis: "redshift-space-comoving", model: table.model, peculiarVelocityCorrected: false, cmbFrameCorrected: false };
}
for (const input of document.querySelectorAll("select")) input.addEventListener("change", () => {
  // Default budgets are conservative; explicit larger budgets remain available for experiments.
  if (input.id === "mode" && value("budget") === "20000" && value("mode") === "bars") el<HTMLSelectElement>("budget").value = "4000";
  rebuild();
});
el<HTMLInputElement>("sample-file").addEventListener("change", async event => {
  const revision = ++importRevision;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 32 * 1024 ** 2) throw Error("原型样本限 32 MiB，请用适配器缩小行窗口。");
    const sample = parseDistanceSample(JSON.parse(await file.text()));
    if (revision !== importRevision) return;
    const next = prepareObjects(sample.objects, table);
    const counts = new Map<number, number>();
    for (const p of next.points) { const parent = parentPixel(p.pixel13, 6); counts.set(parent, (counts.get(parent) ?? 0) + 1); }
    realParents = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([parent]) => parent);
    const population = el<HTMLSelectElement>("population"); population.replaceChildren();
    for (const parent of realParents) population.add(new Option(`O6 ${parent} · ${counts.get(parent)} 个有效星系`, String(parent)));
    if (realParents.length > 1) population.add(new Option("两个实际样区", "multi"));
    population.add(new Option("无有效样本区块", "empty"));
    importedSample = sample; prepared = next;
    el<HTMLSelectElement>("rows").disabled = true;
    el("data-origin").textContent = `DESI DR1 · 本地观测目录样本 · 输入 ${sample.objects.length.toLocaleString()} 行 / 有效星系 ${next.accepted.toLocaleString()}`;
    el("sample-message").textContent = `已载入红移总表第 ${sample.source.rowStartInclusive.toLocaleString()}–${(sample.source.rowStopExclusive - 1).toLocaleString()} 行（从 0 计数）。这是一段行窗口，所选天区的完整性未验证。`;
    rebuild();
  } catch (error) {
    if (revision === importRevision) el("sample-message").textContent = `载入失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
el("restore-synthetic").addEventListener("click", () => {
  importRevision++; importedSample = null; realParents = [];
  el("population").innerHTML = syntheticPopulations;
  el<HTMLInputElement>("sample-file").value = "";
  el<HTMLSelectElement>("rows").disabled = false;
  lastRows = Number(value("rows")); prepared = prepareObjects(syntheticCatalogue(lastRows), table);
  el("data-origin").textContent = "合成星系样本 · ICRS / NESTED · 数据仅存在浏览器内存";
  el("sample-message").textContent = "";
  rebuild();
});
const raycaster = new THREE.Raycaster(); raycaster.params.Points = { threshold: .0012 };
canvas.addEventListener("click", event => {
  if (!cloud) return;
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
  const hit = raycaster.intersectObject(cloud)[0];
  if (hit?.index === undefined) return;
  if (snapshot.mode === "aggregate") {
    const voxel = voxelPicked[hit.index]!;
    const min = voxel.radialBin / Number(snapshot.bins) * Number(snapshot.radialMax), max = (voxel.radialBin + 1) / Number(snapshot.bins) * Number(snapshot.radialMax);
    el("picked").textContent = `聚合体元 O${voxel.order} / ${voxel.pixel}：${voxel.count} 个星系；径向范围 ${min.toFixed(3)}–${max.toFixed(3)} ${snapshot.axis === "distance" ? "Mpc（Planck18 推算）" : "z（观测红移）"}。误差需看成员，不能从箱宽推断。`;
  } else {
    const p = rawPicked[hit.index]!;
    el("picked").textContent = `${p.objectId}：z=${p.redshift!.toFixed(5)}，谱线测量误差 ${p.redshiftError}；${p.redshiftFrame}。Planck18 推算共动距离 ${p.distanceMpc.toFixed(2)} Mpc；仅红移测量误差传播 ±${p.measurementErrorMpc?.toFixed(2) ?? "未知"} Mpc。未校正本动速度 / CMB 参考系，系统误差未知。${importedSample ? `DESI DR1 目录第 ${p.sourceRow} 行。` : "合成记录。"}`;
  }
});
function resize() { const rect = canvas.getBoundingClientRect(); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); renderer.setSize(rect.width, rect.height, false); }
new ResizeObserver(resize).observe(canvas);
let previous = 0;
const frameTimes: number[] = [];
function animate(now: number) { requestAnimationFrame(animate); if (previous) { frameTimes.push(now - previous); if (frameTimes.length > 120) frameTimes.shift(); } previous = now; controls.update(); renderer.render(scene, camera); }
requestAnimationFrame(animate);
Object.assign(window, { distancePrototype: {
  getSnapshot: () => ({ ...snapshot, canvasPixels: [canvas.width, canvas.height], renderer: renderer.info.render, frameTimes: [...frameTimes] }),
  getPositions: () => { const a = cloud?.geometry.getAttribute("position"); return a ? Array.from(a.array).slice(0, 300) : []; },
  rotate: () => { camera.position.applyAxisAngle(controls.target.clone().normalize(), .003); },
} });
rebuild(); resize();
