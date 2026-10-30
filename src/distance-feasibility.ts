/** Bounded research prototype. Counts describe the supplied catalogue, not survey completeness. */
import { Healpix, Pointing } from "healpixjs";

export interface DistanceReference {
  model: string;
  distanceKind: string;
  unit: string;
  zStep: number;
  zMax: number;
  distanceMpc: number[];
}
export interface DistanceObject {
  objectId: string;
  surveyId: string;
  releaseId: string;
  raDeg: number;
  decDeg: number;
  redshift: number | null;
  redshiftError: number | null;
  redshiftFrame: "barycentric" | "heliocentric" | "cmb" | "unknown";
  zcatPrimary: boolean | null;
  objtype: string | null;
  program: string | null;
  observingSurvey: string | null;
  spectype: string;
  zwarn: number;
  deltaChi2: number | null;
  sourceRow?: number;
}
export interface DistanceSample {
  schemaVersion: 1;
  dataOrigin: "desi-dr1-local";
  deliveryClass: "evidence";
  source: {
    connector: string;
    relativePath: string;
    fileRows: number;
    rowStartInclusive: number;
    rowStopExclusive: number;
    headerSha256: string;
    rowBytesSha256: string;
    skyRegionComplete: false;
  };
  objects: DistanceObject[];
}

/** Parse only the bounded adapter format; row quality remains prepareObjects' responsibility. */
export function parseDistanceSample(input: unknown): DistanceSample {
  const sample = input as DistanceSample | null;
  const source = sample?.source;
  if (sample?.schemaVersion !== 1 || sample.dataOrigin !== "desi-dr1-local" || sample.deliveryClass !== "evidence"
    || !source || source.connector !== "desi-dr1-local" || source.relativePath !== "zcatalog/v1/zall-pix-iron.fits"
    || source.skyRegionComplete !== false || ![source.fileRows, source.rowStartInclusive, source.rowStopExclusive].every(Number.isSafeInteger)
    || source.rowStartInclusive < 0 || source.rowStopExclusive > source.fileRows || source.rowStopExclusive <= source.rowStartInclusive
    || ![source.headerSha256, source.rowBytesSha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    || !Array.isArray(sample.objects) || sample.objects.length > 200_000 || sample.objects.length !== source.rowStopExclusive - source.rowStartInclusive) {
    throw Error("需要由 DESI 有界适配器生成的 evidence JSON，且行窗口及来源信息完整。");
  }
  const nullableNumber = (v: unknown) => v === null || typeof v === "number";
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  for (const [index, row] of sample.objects.entries()) {
    if (!row || typeof row.objectId !== "string" || row.surveyId !== "desi" || row.releaseId !== "dr1"
      || !nullableNumber(row.raDeg) || !nullableNumber(row.decDeg) || !nullableNumber(row.redshift) || !nullableNumber(row.redshiftError)
      || row.redshiftFrame !== "barycentric" || ![true, false, null].includes(row.zcatPrimary)
      || !nullableString(row.objtype) || !nullableString(row.program) || !nullableString(row.observingSurvey)
      || typeof row.spectype !== "string" || !Number.isSafeInteger(row.zwarn) || !nullableNumber(row.deltaChi2)
      || row.sourceRow !== source.rowStartInclusive + index) throw Error(`DESI 样本第 ${index + 1} 行格式不完整。`);
  }
  return { ...sample, objects: sample.objects.map(row => ({ ...row,
    // JSON has no NaN; preserve invalid coordinates as exclusions, not 0°.
    raDeg: row.raDeg ?? NaN, decDeg: row.decDeg ?? NaN,
  })) };
}
export interface DistancePoint extends DistanceObject {
  pixel13: number;
  distanceMpc: number;
  measurementErrorMpc: number | null;
  basis: "redshift-space-comoving";
  model: string;
  limitations: string[];
}
export interface Selection { order: number; pixels: number[] }
export interface DistanceVoxel { order: number; pixel: number; radialBin: number; count: number }
export const DISTANCE_POLICY = {
  minRedshift: 0.02, maxRedshift: 2, rawBudget: 20_000, voxelBudget: 32_768,
  qualityLabel: "DR1 Main visualization baseline: SURVEY=main, ZCAT_PRIMARY=true, OBJTYPE=TGT, ZWARN=0, PROGRAM!=other, SPECTYPE=GALAXY; not a tracer-specific cosmology sample",
  lowRedshiftLabel: "z<0.02 excluded by a conservative prototype display policy, not a physical reliability boundary",
} as const;
const hpCache = new Map<number, Healpix>();
function hp(order: number): Healpix {
  let value = hpCache.get(order);
  if (!value) { value = new Healpix(2 ** order); hpCache.set(order, value); }
  return value;
}
export function assertOrder(order: number): void {
  if (!Number.isInteger(order) || order < 0 || order > 13) throw Error("HEALPix order must be an integer in [0,13]");
}
export function pixelAt(order: number, raDeg: number, decDeg: number): number {
  assertOrder(order);
  if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90) throw Error("Invalid ICRS coordinate");
  // Same angular convention as Warehouse, including exact equatorial boundaries.
  return hp(order).ang2pix(new Pointing(null, false, (90 - decDeg) * Math.PI / 180, raDeg * Math.PI / 180));
}
export function pixelCenter(order: number, pixel: number): { raDeg: number; decDeg: number } {
  assertOrder(order);
  const v = hp(order).pix2vec(pixel);
  return { raDeg: ((Math.atan2(v.y, v.x) * 180 / Math.PI) + 360) % 360, decDeg: Math.asin(v.z) * 180 / Math.PI };
}
export function validateSelection(selection: Selection): void {
  assertOrder(selection.order);
  if (!selection.pixels.length || selection.pixels.length > 4096 || selection.pixels.some(p => !Number.isInteger(p) || p < 0 || p >= 12 * 4 ** selection.order)) throw Error("Invalid or empty bounded selection");
}
export function parentPixel(pixel13: number, order: number): number { return Math.floor(pixel13 / 4 ** (13 - order)); }

export function comovingDistance(z: number, table: DistanceReference): number {
  if (table.model !== "Astropy Planck18" || table.distanceKind !== "line-of-sight-comoving" || table.unit !== "Mpc") throw Error("Unsupported distance reference");
  if (!Number.isFinite(z) || z < 0 || z > table.zMax) throw Error("Redshift outside the distance reference; no extrapolation");
  const at = z / table.zStep, i = Math.floor(at), fraction = at - i;
  const a = table.distanceMpc[i];
  if (a === undefined) throw Error("Incomplete distance reference");
  if (fraction === 0) return a;
  const b = table.distanceMpc[i + 1];
  if (b === undefined) throw Error("Incomplete distance reference");
  return a + (b - a) * fraction;
}
export function prepareObjects(rows: readonly DistanceObject[], table: DistanceReference) {
  const excluded: Record<string, number> = {};
  const reject = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const unique = new Map<string, DistanceObject>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (!row.objectId || !row.surveyId || !row.releaseId) { reject("missingIdentity"); continue; }
    if (!Number.isFinite(row.raDeg) || row.raDeg < 0 || row.raDeg >= 360 || !Number.isFinite(row.decDeg) || Math.abs(row.decDeg) > 90) { reject("invalidCoordinate"); continue; }
    if (row.redshift === null || !Number.isFinite(row.redshift)) { reject("missingRedshift"); continue; }
    if (row.redshift < DISTANCE_POLICY.minRedshift) { reject("lowOrNegativeRedshift"); continue; }
    if (row.redshift > Math.min(table.zMax, DISTANCE_POLICY.maxRedshift)) { reject("outsideModelRange"); continue; }
    if (row.observingSurvey !== "main" || row.spectype !== "GALAXY" || row.zwarn !== 0 || row.zcatPrimary !== true || row.objtype !== "TGT" || !row.program || row.program === "other") { reject("qualityOrClass"); continue; }
    if (row.redshiftFrame === "unknown" || !["barycentric", "heliocentric", "cmb"].includes(row.redshiftFrame)) { reject("unknownRedshiftFrame"); continue; }
    const key = JSON.stringify([row.surveyId, row.releaseId, row.objectId]);
    if (ambiguous.has(key)) { reject("ambiguousPrimary"); continue; }
    const prior = unique.get(key);
    if (prior) {
      if (prior.raDeg === row.raDeg && prior.decDeg === row.decDeg && prior.redshift === row.redshift && prior.redshiftError === row.redshiftError && prior.redshiftFrame === row.redshiftFrame) { reject("duplicateIdenticalPrimary"); continue; }
      // Conflicting primary rows require upstream reconciliation, never a guessed best row.
      reject("ambiguousPrimary"); reject("ambiguousPrimary"); unique.delete(key); ambiguous.add(key); continue;
    }
    unique.set(key, row);
  }
  const points: DistancePoint[] = [...unique.values()].map(row => {
    const z = row.redshift!;
    const error = row.redshiftError;
    const validError = error !== null && Number.isFinite(error) && error >= 0 && z - error >= 0 && z + error <= table.zMax;
    return {
      ...row, pixel13: pixelAt(13, row.raDeg, row.decDeg), distanceMpc: comovingDistance(z, table),
      measurementErrorMpc: validError ? (comovingDistance(z + error, table) - comovingDistance(z - error, table)) / 2 : null,
      basis: "redshift-space-comoving", model: table.model,
      limitations: ["model-inferred-not-independent-distance", "peculiar-velocity-not-corrected", "cosmology-systematics-not-in-error",
        ...(row.redshiftFrame !== "cmb" ? [`${row.redshiftFrame}-not-cmb-corrected`] : []), ...(!validError ? ["measurement-error-unavailable"] : [])],
    };
  });
  return { points, excluded, inputRows: rows.length, accepted: points.length };
}
export function selectPoints(points: readonly DistancePoint[], selection: Selection): DistancePoint[] {
  validateSelection(selection);
  const keys = new Set(selection.pixels);
  return points.filter(p => keys.has(parentPixel(p.pixel13, selection.order)));
}
export function radialBinAt(distanceMpc: number, binCount: number, distanceMax: number): number {
  if (!Number.isInteger(binCount) || binCount < 1 || !Number.isFinite(distanceMax) || distanceMax <= 0 || !Number.isFinite(distanceMpc) || distanceMpc < 0 || distanceMpc > distanceMax) throw Error("Invalid radial bin input");
  return Math.min(binCount - 1, Math.floor(distanceMpc / distanceMax * binCount));
}
export function aggregatePoints(points: readonly DistancePoint[], order: number, binCount: number, distanceMax: number): DistanceVoxel[] {
  assertOrder(order);
  const bins = new Map<string, DistanceVoxel>();
  for (const point of points) {
    const pixel = parentPixel(point.pixel13, order), radialBin = radialBinAt(point.distanceMpc, binCount, distanceMax);
    const key = `${pixel}:${radialBin}`, current = bins.get(key);
    if (current) current.count++;
    else bins.set(key, { order, pixel, radialBin, count: 1 });
  }
  return [...bins.values()];
}
export function planRepresentation(points: readonly DistancePoint[], selection: Selection, binCount: number, distanceMax: number,
  requested: "points" | "bars" | "aggregate" = "points", rawBudget: number = DISTANCE_POLICY.rawBudget, voxelBudget: number = DISTANCE_POLICY.voxelBudget) {
  validateSelection(selection);
  if (!Number.isInteger(rawBudget) || rawBudget < 1 || !Number.isInteger(voxelBudget) || voxelBudget < 1) throw Error("Invalid display budget");
  const selected = selectPoints(points, selection);
  if (requested !== "aggregate" && selected.length <= rawBudget) return { mode: requested, selected, order: null, voxels: [], reason: "within-object-budget", budgetExceeded: false };
  const orders = [...new Set([selection.order, Math.min(13, selection.order + 2), Math.min(13, selection.order + 4)])].reverse();
  for (const order of orders) {
    const voxels = aggregatePoints(selected, order, binCount, distanceMax);
    if (voxels.length <= voxelBudget) return { mode: "aggregate" as const, selected, order, voxels,
      reason: requested === "aggregate" ? "requested-aggregation" : "object-budget-use-complete-aggregation", budgetExceeded: false };
  }
  return { mode: "aggregate" as const, selected, order: null, voxels: [], reason: "voxel-budget-exceeded-narrow-selection", budgetExceeded: true };
}

/** Synthetic fixtures only. O13 centers are used to make parent membership reproducible. */
export function syntheticCatalogue(total = 60_000): DistanceObject[] {
  if (!Number.isInteger(total) || total < 1 || total > 1_000_000) throw Error("Synthetic row budget must be 1..1,000,000");
  let state = 20261030;
  const rand = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Array.from({ length: total }, (_, index) => {
    const group = index % 20 < 15 ? 0 : index % 20 < 19 ? 1 : 2;
    const parent = [18000, 19000, 20000][group]!;
    const child = Math.floor(rand() ** (group === 0 ? 2 : 1) * 4 ** 7);
    const center = pixelCenter(13, parent * 4 ** 7 + child);
    const z = .08 + (index % 3) * .28 + rand() * .045 + .015 * Math.sin(child * .001);
    return { objectId: `synthetic-${index}`, surveyId: "synthetic-desi-like", releaseId: "synthetic-20261030",
      ...center, redshift: z, redshiftError: .0001 + rand() * .00015, redshiftFrame: "barycentric", zcatPrimary: true, objtype: "TGT", program: "bright", observingSurvey: "main", spectype: "GALAXY", zwarn: 0, deltaChi2: 60 + rand() * 200 };
  });
}
