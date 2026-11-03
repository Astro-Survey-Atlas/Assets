import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { aggregatePoints, comovingDistance, DISTANCE_POLICY, parentPixel, parseDistanceSample, prepareObjects, selectPoints, syntheticCatalogue,
  type DistanceReference } from "../src/distance-feasibility.js";

const root = process.cwd();
const out = path.resolve(process.argv.find(a => a.startsWith("--output="))?.slice(9) ?? "/tmp/asa-distance-feasibility-20261030");
const count = Number(process.argv.find(a => a.startsWith("--rows="))?.slice(7) ?? 60_000);
const input = process.argv.find(a => a.startsWith("--input="))?.slice(8);
const sample = input ? parseDistanceSample(JSON.parse(await readFile(input, "utf8"))) : null;
const table = JSON.parse(await readFile(path.join(root, "fixtures/distance-prototype/planck18-reference.json"), "utf8")) as DistanceReference;
const start = performance.now();
const rows = sample?.objects ?? syntheticCatalogue(count);
const prepared = prepareObjects(rows, table);
const distanceMax = comovingDistance(table.zMax, table);
const cases = [];
const parentCounts = new Map<number, number>();
for (const point of prepared.points) { const parent = parentPixel(point.pixel13, 6); parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1); }
const populations: Array<[string, number]> = sample
  ? [...parentCounts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([parent], i) => [`row-window-group-${i + 1}`, parent])
  : [["dense", 18000], ["medium", 19000], ["sparse", 20000]];
for (const [label, parent] of populations) {
  const group = prepared.points.filter(p => parentPixel(p.pixel13, 6) === parent);
  for (const selectionOrder of [4, 6, 8, 10, 12, 13]) {
    const members = new Map<number, number>();
    for (const p of group) { const key = parentPixel(p.pixel13, selectionOrder); members.set(key, (members.get(key) ?? 0) + 1); }
    const chosen = [...members].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    const selected = selectPoints(prepared.points, { order: selectionOrder, pixels: [chosen[0]] });
    for (const order of [...new Set([selectionOrder, Math.min(13, selectionOrder + 2), Math.min(13, selectionOrder + 4)])]) {
      for (const radialBins of [32, 64, 128]) {
        const t0 = performance.now();
        const voxels = aggregatePoints(selected, order, radialBins, distanceMax);
        const durationMs = performance.now() - t0;
        const sum = voxels.reduce((s, v) => s + v.count, 0);
        const width = distanceMax / radialBins;
        const errors = selected.map(p => Math.abs(p.distanceMpc - (Math.min(radialBins - 1, Math.floor(p.distanceMpc / width)) + .5) * width)).sort((a, b) => a - b);
        const histogram = new Array<number>(radialBins).fill(0);
        for (const voxel of voxels) histogram[voxel.radialBin]! += voxel.count;
        const rawHistogram = new Array<number>(radialBins).fill(0);
        for (const point of selected) rawHistogram[Math.min(radialBins - 1, Math.floor(point.distanceMpc / width))]!++;
        cases.push({ population: label, parentOrder6: parent, selectionPixel: chosen[0], selectionOrder, aggregationOrder: order, radialBins, selected: selected.length, voxelCount: voxels.length,
          countConserved: sum === selected.length, radialHistogramConserved: histogram.every((v, i) => v === rawHistogram[i]),
          aggregationMs: +durationMs.toFixed(3), payloadBytes: Buffer.byteLength(JSON.stringify(voxels)),
          binWidthMpc: +width.toFixed(4), quantizationP95Mpc: +(errors[Math.floor(errors.length * .95)] ?? 0).toFixed(4),
          measurementErrorExceedsBin: selected.filter(p => p.measurementErrorMpc !== null && p.measurementErrorMpc > width).length,
          displayBudgetExceeded: voxels.length > DISTANCE_POLICY.voxelBudget });
      }
    }
  }
}
const result = { schemaVersion: 1, dataOrigin: sample?.dataOrigin ?? "synthetic", scopeComplete: true, surveyInventoryComplete: false,
  skyRegionComplete: false, source: sample?.source ?? null,
  note: sample ? "All accepted rows in the bounded DESI row window are counted; this is not a complete sky region or statistical sample. No scientific peak/structure accuracy established."
    : "Engineering experiment only. No real DESI rows, completeness, peak accuracy or scientific structure established.",
  distanceBasis: { kind: "redshift-space-comoving", model: table.model, unit: table.unit, rawRedshiftFrame: "barycentric",
    peculiarVelocityCorrected: false, cmbFrameCorrected: false, uncertainty: "measurement propagation only; systematic distance uncertainty unknown" },
  inputRows: rows.length, accepted: prepared.accepted, excluded: prepared.excluded, elapsedMs: +(performance.now() - start).toFixed(2),
  memory: process.memoryUsage(), cases };
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "aggregation-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output: path.join(out, "aggregation-results.json"), dataOrigin: result.dataOrigin, inputRows: result.inputRows,
  accepted: result.accepted, excluded: result.excluded, cases: cases.length, countsConserved: cases.every(c => c.countConserved && c.radialHistogramConserved), elapsedMs: result.elapsedMs }));
