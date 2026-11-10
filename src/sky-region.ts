/** Browser-safe ICRS/NESTED query selectors. No source precision is implied. */
export interface SkyRegionCell { order: number; ipix: number }
export interface SkyRegion { coordinateFrame: "ICRS"; ordering: "NESTED"; cells: SkyRegionCell[] }
export interface SkyRectangle { raStart: number; raEnd: number; decMin: number; decMax: number }
export interface NormalizedSkyRectangle extends SkyRectangle { raWidth: number; fullRa: boolean }
export interface SkyRegionOrderGroup { order: number; cells: number[] }
export interface SkyRegionCoverMetadata {
  algorithmVersion: string;
  targetBoundaryOrder: number;
  orderCounts: Record<string, number>;
  budgetLimited: boolean;
  unresolvedBoundaryLeaves: number;
  maxUnresolvedAngularRadiusDeg: number;
  rectangleAreaDeg2: number;
  coverAreaDeg2: number;
  excessAreaDeg2: number;
}

export function normalizeSkyRectangle(input: unknown): NormalizedSkyRectangle {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("rectangle is required");
  const value = input as Record<string, unknown>;
  for (const key of ["raStart", "raEnd", "decMin", "decMax"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) throw new Error(`${key} must be a finite number in degrees`);
  }
  const { raStart, raEnd, decMin, decMax } = value as unknown as SkyRectangle;
  if (raStart < 0 || raStart > 360 || raEnd < 0 || raEnd > 360) throw new Error("RA must be between 0 and 360 degrees");
  if (decMin < -90 || decMax > 90 || decMin >= decMax) throw new Error("Dec must satisfy -90 <= decMin < decMax <= 90");
  const fullRa = raStart === 0 && raEnd === 360;
  const start = raStart === 360 ? 0 : raStart;
  const end = raEnd === 360 ? 0 : raEnd;
  const raWidth = fullRa ? 360 : (end - start + 360) % 360;
  if (!raWidth) throw new Error("Rectangle RA interval has zero width; use 0 to 360 for full RA");
  return { raStart: start, raEnd: fullRa ? 360 : end, decMin, decMax, raWidth, fullRa };
}

/** Canonical disjoint leaves, packing siblings but never below O4. */
export function canonicalizeRegionCells(cells: readonly SkyRegionCell[]): SkyRegionCell[] {
  const levels = new Map<number, Set<number>>();
  for (const cell of cells) {
    if (!cell || !Number.isSafeInteger(cell.order) || cell.order < 4 || cell.order > 12
      || !Number.isSafeInteger(cell.ipix) || cell.ipix < 0 || cell.ipix >= 12 * 4 ** cell.order) throw new Error("Region cells require valid ICRS/NESTED order 4 through 12 and ipix");
    const level = levels.get(cell.order) ?? new Set<number>(); level.add(cell.ipix); levels.set(cell.order, level);
  }
  for (let order = 4; order <= 12; order++) {
    for (const ipix of levels.get(order) ?? []) {
      for (let parentOrder = 4; parentOrder < order; parentOrder++) {
        if (levels.get(parentOrder)?.has(Math.floor(ipix / 4 ** (order - parentOrder)))) { levels.get(order)!.delete(ipix); break; }
      }
    }
  }
  for (let order = 12; order > 4; order--) {
    const level = levels.get(order); if (!level) continue;
    const parents = new Set([...level].map(ipix => Math.floor(ipix / 4)));
    for (const parent of parents) {
      if (![0, 1, 2, 3].every(child => level.has(parent * 4 + child))) continue;
      for (let child = 0; child < 4; child++) level.delete(parent * 4 + child);
      const coarser = levels.get(order - 1) ?? new Set<number>(); coarser.add(parent); levels.set(order - 1, coarser);
    }
  }
  return [...levels].sort(([a], [b]) => a - b).flatMap(([order, pixels]) => [...pixels].sort((a, b) => a - b).map(ipix => ({ order, ipix })));
}

export function normalizeSkyRegion(input: unknown): SkyRegion {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("region is required");
  const region = input as Record<string, unknown>;
  if (region.coordinateFrame !== "ICRS" || region.ordering !== "NESTED" || !Array.isArray(region.cells)
    || !region.cells.length || region.cells.length > 4096) throw new Error("region requires ICRS/NESTED and 1-4096 order/ipix cells");
  return { coordinateFrame: "ICRS", ordering: "NESTED", cells: canonicalizeRegionCells(region.cells) };
}

export function groupRegionCells(cells: readonly SkyRegionCell[]): SkyRegionOrderGroup[] {
  const groups = new Map<number, number[]>();
  for (const { order, ipix } of cells) { const pixels = groups.get(order) ?? []; pixels.push(ipix); groups.set(order, pixels); }
  return [...groups].sort(([a], [b]) => a - b).map(([order, pixels]) => ({ order, cells: [...new Set(pixels)].sort((a, b) => a - b) }));
}
