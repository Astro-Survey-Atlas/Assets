import { Healpix, Pointing } from "healpixjs";

import { sceneDirectionToHealpixVector } from "./spherical-cell-geometry.js";

export interface CoverageViewGeometry {
  coverageViewDirection: [number, number, number];
  coverageViewRadiusRad: number;
}

export interface CoverageTileRange {
  start: number;
  end: number;
}

export interface SurveyCoverageTileRanges {
  products: readonly (readonly CoverageTileRange[])[];
}

export class CoverageViewTileBudgetError extends Error {
  constructor(readonly tileCount: number, readonly tileBudget: number) {
    super(`Overlap view requires ${tileCount} shared tiles; budget is ${tileBudget}`);
    this.name = "CoverageViewTileBudgetError";
  }
}

/** Clip supplied native-order cells, retaining a conservative boundary margin. */
export function coverageCellsInView(
  order: number,
  view: CoverageViewGeometry,
  cells: readonly number[],
  includeFarSide = true,
): number[] {
  if (order < 6 || view.coverageViewRadiusRad >= Math.PI || (includeFarSide && view.coverageViewRadiusRad >= Math.PI / 2)) return [...cells];
  const healpix = new Healpix(2 ** order);
  const [x, y, z] = view.coverageViewDirection;
  const center = sceneDirectionToHealpixVector({ x, y, z });
  const radius = Math.min(Math.PI, view.coverageViewRadiusRad + healpix.maxPixrad());
  const threshold = Math.cos(radius);
  return cells.filter((pixel) => {
    const direction = healpix.pix2vec(pixel);
    const dot = center.x * direction.x + center.y * direction.y + center.z * direction.z;
    return dot >= threshold || (includeFarSide && -dot >= threshold);
  });
}

/** Return indexed NESTED tiles whose cells can intersect the current view. */
export function coverageTilesInView(
  order: number,
  view: CoverageViewGeometry,
  ranges: readonly CoverageTileRange[],
  includeFarSide = true,
): number[] {
  if (order < 6) {
    return ranges.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, index) => start + index));
  }
  if (includeFarSide && view.coverageViewRadiusRad >= Math.PI / 2) {
    return ranges.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, index) => start + index));
  }

  const tileOrder = order - 6;
  const healpix = new Healpix(2 ** tileOrder);
  const center = { x: view.coverageViewDirection[0], y: view.coverageViewDirection[1], z: view.coverageViewDirection[2] };
  const queryRadius = Math.min(Math.PI, view.coverageViewRadiusRad + healpix.maxPixrad());
  const visible = new Set<number>();
  const directions = includeFarSide ? [center, { x: -center.x, y: -center.y, z: -center.z }] : [center];
  for (const direction of directions) {
    const query = healpix.queryDiscInclusive(
      new Pointing(sceneDirectionToHealpixVector(direction)),
      queryRadius,
      4,
    );
    let rangeIndex = 0;
    for (let index = 0; index < query.sz; index += 2) {
      const low = query.r[index]!;
      const high = query.r[index + 1]!;
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= low) rangeIndex += 1;
      for (let tile = low; tile < high; tile += 1) {
        while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= tile) rangeIndex += 1;
        if (ranges[rangeIndex] && ranges[rangeIndex]!.start <= tile) visible.add(tile);
      }
    }
  }
  return [...visible].sort((left, right) => left - right);
}

/** Return parent tiles where every selected survey has at least one product. */
export function overlapCoverageTilesInView(
  order: number,
  view: CoverageViewGeometry,
  surveys: readonly SurveyCoverageTileRanges[],
  tileBudget: number,
): number[] {
  if (!surveys.length) return [];
  let shared: Set<number> | null = null;
  for (const survey of surveys) {
    const union = new Set<number>();
    for (const ranges of survey.products) {
      coverageTilesInView(order, view, ranges, false).forEach((tile) => union.add(tile));
    }
    if (shared === null) shared = union;
    else for (const tile of shared) if (!union.has(tile)) shared.delete(tile);
    if (!shared.size) return [];
  }
  const tiles = [...(shared ?? [])].sort((left, right) => left - right);
  if (tiles.length > tileBudget) throw new CoverageViewTileBudgetError(tiles.length, tileBudget);
  return tiles;
}
