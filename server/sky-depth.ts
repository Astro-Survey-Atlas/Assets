import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parentPixel, parseDistanceSample, pixelAt, prepareObjects, prepareRedshiftObjects, validateSelection,
  type DistanceReference } from "../src/distance-feasibility.js";
import type { SkyDepthExample, SkyDepthPoint, SkyDepthQuery, SkyDepthResponse, SkyDepthSourceResult } from "../src/sky-depth.js";

export class SkyDepthInputError extends Error {}
function stableRange(values: readonly number[], fallbackMax: number): [number, number] {
  let min = 0, max = fallbackMax;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  if (!(max > min)) max = min + fallbackMax;
  return [min, max];
}

export function parseSkyDepthQuery(input: unknown): SkyDepthQuery {
  const q = input as SkyDepthQuery | null;
  if (!q || !Array.isArray(q.cells) || q.cells.length > 4096 || !Array.isArray(q.sources) || !q.sources.length || q.sources.length > 16
    || !["distance", "redshift"].includes(q.axis) || !["points", "bars", "aggregate"].includes(q.mode)
    || q.sources.some(s => !s || ![s.surveyId, s.releaseId].every(v => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v))
      || (s.role !== undefined && !["survey", "reference"].includes(s.role))
      || (s.role === "reference" && !(s.surveyId === "desi" && ["desi-dr1", "dr1"].includes(s.releaseId))))) {
    throw new SkyDepthInputError("Invalid bounded sky-depth query");
  }
  try { validateSelection({ order: q.order, pixels: q.cells }); } catch { throw new SkyDepthInputError("Invalid NESTED selection"); }
  if (q.order < 4) throw new SkyDepthInputError("Sky-depth selection requires order 4–13");
  return { order: q.order, cells: [...new Set(q.cells)], sources: [...new Map(q.sources.map(s => [`${s.surveyId}:${s.releaseId}`, {
    surveyId: s.surveyId, releaseId: s.releaseId, role: s.role ?? "survey",
  }])).values()], axis: q.axis, mode: q.mode };
}

const basis: SkyDepthResponse["distanceBasis"] = { kind: "redshift-space-comoving", model: "Astropy Planck18", unit: "Mpc",
  peculiarVelocityCorrected: false, cmbFrameCorrected: false, uncertainty: "measurement-only" };

/** Reads one explicitly configured, hash-locked public DESI evidence snapshot on demand. */
export class SkyDepthStore {
  #loaded?: ReturnType<SkyDepthStore["load"]>;
  constructor(private readonly config: { evidenceRoot: string; samplePath?: string; sampleSha256?: string; referencePath: string }) {}

  private async load() {
    if (!this.config.samplePath || !this.config.sampleSha256 || !/^[a-f0-9]{64}$/.test(this.config.sampleSha256)) throw Error("Snapshot not configured");
    const [root, file] = await Promise.all([realpath(this.config.evidenceRoot), realpath(this.config.samplePath)]);
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Snapshot outside evidence root");
    if ((await stat(file)).size > 32 * 1024 ** 2) throw Error("Snapshot exceeds bounded input size");
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== this.config.sampleSha256) throw Error("Snapshot digest mismatch");
    const sample = parseDistanceSample(JSON.parse(bytes.toString("utf8")));
    const reference = JSON.parse(await readFile(this.config.referencePath, "utf8")) as DistanceReference;
    const redshift = prepareRedshiftObjects(sample.objects).points;
    const distance = prepareObjects(sample.objects, reference).points;
    return { sample, hash, raw: sample.objects.map(row => ({ ...row, pixel13: Number.isFinite(row.raDeg) && Number.isFinite(row.decDeg)
      && row.raDeg >= 0 && row.raDeg < 360 && Math.abs(row.decDeg) <= 90 ? pixelAt(13, row.raDeg, row.decDeg) : null })),
      redshift, distance, ranges: { redshift: stableRange(redshift.map(point => point.redshift), .02),
        distance: stableRange(distance.map(point => point.distanceMpc), 100) } };
  }
  private data() {
    return this.#loaded ??= this.load().catch(error => { this.#loaded = undefined; throw error; });
  }

  async example(): Promise<SkyDepthExample> {
    if (!this.config.samplePath) return { available: false, message: "No distance evidence snapshot is connected" };
    try {
      const data = await this.data();
      const counts = new Map<number, number>();
      for (const p of data.distance) { const pixel = parentPixel(p.pixel13, 4); counts.set(pixel, (counts.get(pixel) ?? 0) + 1); }
      const cell = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      return cell === undefined ? { available: false, message: "No suitable distance measurements in this snapshot" }
        : { available: true, selection: { order: 4, cells: [cell], sources: [{ surveyId: "desi", releaseId: "desi-dr1" }] } };
    } catch { return { available: false, message: "Distance evidence is temporarily unavailable" }; }
  }

  async query(input: unknown): Promise<SkyDepthResponse> {
    const query = parseSkyDepthQuery(input); // Validate before file I/O.
    const selected = new Set(query.cells);
    const inSelection = (p: { pixel13: number }) => selected.has(parentPixel(p.pixel13, query.order));
    const sources = await Promise.all(query.sources.map(async source => {
      const role = source.role ?? "survey";
      const result: SkyDepthSourceResult = { ...source, role, label: role === "reference" ? "DESI DR1 · reference depth" : `${source.surveyId.toUpperCase()} · ${source.releaseId}`, status: "not-connected",
        selectedCount: 0, mode: query.mode, points: [], voxels: [] };
      // Explicit release binding: a DR1 snapshot must never satisfy an EDR query.
      if (source.surveyId !== "desi" || !["desi-dr1", "dr1"].includes(source.releaseId) || !this.config.samplePath) return result;
      try {
        const data = await this.data();
        const raw = data.raw.filter(p => p.pixel13 !== null && inSelection({ pixel13: p.pixel13 }));
        const redshift = data.redshift.filter(inSelection), distance = data.distance.filter(inSelection);
        const distances = new Map(distance.map(p => [p.objectId, p]));
        const rows = query.axis === "distance" ? distance : redshift;
        Object.assign(result, { snapshotSha256: data.hash, selectedInputRows: raw.length, redshiftCount: redshift.length, distanceCount: distance.length,
          scope: { kind: "row-window", rowStartInclusive: data.sample.source.rowStartInclusive, rowStopExclusive: data.sample.source.rowStopExclusive,
            catalogueRows: data.sample.source.fileRows, skyRegionComplete: false }, selectedCount: rows.length,
          status: distance.length ? "available" : redshift.length ? "redshift-only" : raw.length ? "no-measurements" : "empty" });
        if (!rows.length) return result;
        const points: SkyDepthPoint[] = rows.map(p => {
          const d = distances.get(p.objectId);
          return { objectId: p.objectId, raDeg: p.raDeg, decDeg: p.decDeg, redshift: p.redshift!, redshiftError: p.redshiftError !== null && Number.isFinite(p.redshiftError) && p.redshiftError >= 0 ? p.redshiftError : null,
            redshiftFrame: p.redshiftFrame, distanceMpc: d?.distanceMpc ?? null, measurementErrorMpc: d?.measurementErrorMpc ?? null, sourceRow: p.sourceRow };
        });
        const radial = points.map(p => query.axis === "distance" ? p.distanceMpc! : p.redshift);
        const [min, max] = data.ranges[query.axis];
        result.radialRange = [min, max];
        const extents = new Map<number, { radialMax: number; count: number }>();
        rows.forEach((point, index) => {
          const pixel = parentPixel(point.pixel13, query.order), value = radial[index]!;
          const extent = extents.get(pixel);
          if (extent) { extent.radialMax = Math.max(extent.radialMax, value); extent.count++; }
          else extents.set(pixel, { radialMax: value, count: 1 });
        });
        result.cellExtents = [...extents].map(([pixel, extent]) => ({ order: query.order, pixel, ...extent })).sort((a, b) => a.pixel - b.pixel);
        const budget = query.mode === "bars" ? 4000 : 20000;
        if (query.mode !== "aggregate" && points.length <= budget) { result.points = points; return result; }
        result.mode = "aggregate";
        const orders = [...new Set([Math.min(13, query.order + 4), Math.min(13, query.order + 2), query.order])];
        for (const order of orders) {
          const voxels = new Map<string, { pixel: number; bin: number; count: number; sum: number }>();
          rows.forEach((p, index) => {
            const pixel = parentPixel(p.pixel13, order), bin = Math.max(0, Math.min(63, Math.floor((radial[index]! - min) / (max - min) * 64)));
            const key = `${pixel}:${bin}`, v = voxels.get(key);
            if (v) { v.count++; v.sum += radial[index]!; } else voxels.set(key, { pixel, bin, count: 1, sum: radial[index]! });
          });
          if (voxels.size > 32768) continue;
          result.aggregationOrder = order;
          result.voxels = [...voxels.values()].map(v => ({ order, pixel: v.pixel, radialMin: min + v.bin / 64 * (max - min), radialMax: min + (v.bin + 1) / 64 * (max - min), radialMean: v.sum / v.count, count: v.count }));
          return result;
        }
        result.status = "unavailable"; result.message = "Display budget exceeded; select a smaller sky region";
        return result;
      } catch {
        return { ...result, status: "unavailable" as const, message: "Distance evidence is temporarily unavailable" };
      }
    }));
    return { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED", query, sources, distanceBasis: basis };
  }
}
