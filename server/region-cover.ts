import { Healpix } from "healpixjs";
import { canonicalizeRegionCells, groupRegionCells, normalizeSkyRectangle, normalizeSkyRegion, type NormalizedSkyRectangle, type SkyRegion, type SkyRegionCell, type SkyRegionCoverMetadata } from "../src/sky-region.js";
import { sha256Hex } from "./hash.js";
import { AccessError } from "./region-access.js";
import { partitionReverseCells } from "./reverse-pagination.js";

export const REGION_COVER_ALGORITHM = "icrs-rectangle-cap-v1";
const DEG = Math.PI / 180;
const SKY_AREA = 41252.96124941927;
const hp = new Map<number, Healpix>();
function healpix(order: number): Healpix { let value = hp.get(order); if (!value) { value = new Healpix(2 ** order); hp.set(order, value); } return value; }

type Classification = "outside" | "inside" | "boundary";
/** Classify a containing cap, not sampled corners. A cap's signed distance to a
 * hemisphere plane is asin(n·center); latitude is 1-Lipschitz on the sphere. */
export function classifyRectangleCell(rectangle: NormalizedSkyRectangle, cell: SkyRegionCell): Classification {
  const grid = healpix(cell.order), center = grid.pix2vec(cell.ipix), radius = grid.maxPixrad() + 1e-12;
  const dec = Math.asin(Math.max(-1, Math.min(1, center.z)));
  if (dec + radius < rectangle.decMin * DEG || dec - radius > rectangle.decMax * DEG) return "outside";
  const latitudeInside = (rectangle.decMin === -90 || dec - radius >= rectangle.decMin * DEG)
    && (rectangle.decMax === 90 || dec + radius <= rectangle.decMax * DEG);
  if (rectangle.fullRa) return latitudeInside ? "inside" : "boundary";
  const threshold = Math.sin(radius);
  let intersects = false;
  for (let offset = 0; offset < rectangle.raWidth; offset += 180) {
    const start = (rectangle.raStart + offset) * DEG;
    const end = (rectangle.raStart + Math.min(rectangle.raWidth, offset + 180)) * DEG;
    const left = -Math.sin(start) * center.x + Math.cos(start) * center.y;
    const right = Math.sin(end) * center.x - Math.cos(end) * center.y;
    if (left < -threshold || right < -threshold) continue;
    intersects = true;
    if (latitudeInside && left >= threshold && right >= threshold) return "inside";
  }
  return intersects ? "boundary" : "outside";
}

export function skyRegionHash(region: SkyRegion): string {
  return sha256Hex(JSON.stringify({ coordinateFrame: "ICRS", ordering: "NESTED", cells: canonicalizeRegionCells(region.cells) }));
}

export function coverSkyRectangle(input: unknown, boundaryOrder: unknown = 10, leafBudget = 4096): { region: SkyRegion; rectangle: NormalizedSkyRectangle; cover: SkyRegionCoverMetadata } {
  const rectangle = normalizeSkyRectangle(input);
  if (!Number.isSafeInteger(boundaryOrder) || Number(boundaryOrder) < 4 || Number(boundaryOrder) > 12) throw new Error("boundaryOrder must be an integer from 4 through 12");
  if (!Number.isSafeInteger(leafBudget) || leafBudget < 3072 || leafBudget > 4096) throw new Error("Rectangle cover leaf budget must be 3072-4096");
  const leaves = new Map<string, SkyRegionCell>();
  let frontier: SkyRegionCell[] = [];
  for (let ipix = 0; ipix < 3072; ipix++) {
    const cell = { order: 4, ipix }, state = classifyRectangleCell(rectangle, cell);
    if (state === "outside") continue;
    leaves.set(`4:${ipix}`, cell);
    if (state === "boundary") frontier.push(cell);
  }
  let budgetLimited = false;
  // Breadth-first subdivision prevents one boundary from reaching O12 while
  // another remains O4. Replacement is atomic: never discard a retained parent
  // unless every possibly intersecting child fits in the leaf budget.
  for (let order = 4; order < Number(boundaryOrder) && frontier.length; order++) {
    const next: SkyRegionCell[] = [];
    let blocked = false;
    for (const parent of frontier) {
      const children = [0, 1, 2, 3].map(child => ({ order: parent.order + 1, ipix: parent.ipix * 4 + child }))
        .map(cell => ({ cell, state: classifyRectangleCell(rectangle, cell) })).filter(child => child.state !== "outside");
      if (leaves.size - 1 + children.length > leafBudget) { budgetLimited = true; blocked = true; continue; }
      leaves.delete(`${parent.order}:${parent.ipix}`);
      for (const { cell, state } of children) {
        leaves.set(`${cell.order}:${cell.ipix}`, cell);
        if (state === "boundary") next.push(cell);
      }
    }
    // Once this level cannot fit, do not spend leftover budget making only
    // its early siblings arbitrarily finer. Actual boundary depths differ by
    // at most one refinement level at the stopping frontier.
    if (blocked) break;
    frontier = next;
  }
  const cells = canonicalizeRegionCells([...leaves.values()]);
  const unresolved = cells.filter(cell => classifyRectangleCell(rectangle, cell) === "boundary");
  const rectangleAreaDeg2 = rectangle.raWidth / 360 * (Math.sin(rectangle.decMax * DEG) - Math.sin(rectangle.decMin * DEG)) * SKY_AREA / 2;
  const coverAreaDeg2 = cells.reduce((sum, cell) => sum + SKY_AREA / (12 * 4 ** cell.order), 0);
  return { rectangle, region: { coordinateFrame: "ICRS", ordering: "NESTED", cells }, cover: {
    algorithmVersion: REGION_COVER_ALGORITHM, targetBoundaryOrder: Number(boundaryOrder),
    orderCounts: Object.fromEntries(groupRegionCells(cells).map(group => [String(group.order), group.cells.length])),
    budgetLimited, unresolvedBoundaryLeaves: unresolved.length,
    maxUnresolvedAngularRadiusDeg: unresolved.reduce((max, cell) => Math.max(max, healpix(cell.order).maxPixrad() / DEG), 0),
    rectangleAreaDeg2, coverAreaDeg2, excessAreaDeg2: Math.max(0, coverAreaDeg2 - rectangleAreaDeg2),
  } };
}

export interface ReverseRegionSelector {
  kind: "cells" | "rectangle" | "region";
  region?: SkyRegion & { hash: string; rectangle?: NormalizedSkyRectangle; cover?: SkyRegionCoverMetadata };
  rectangle?: NormalizedSkyRectangle;
  batches: Array<{ order: number; cells: number[] }>;
  fingerprintSelector: unknown;
  requested: Record<string, unknown>;
}

/** Selectors are exclusive, including partial legacy selectors. */
export function normalizeReverseSelector(body: Record<string, unknown>): ReverseRegionSelector {
  try {
    const count = Number(body.rectangle !== undefined) + Number(body.region !== undefined) + Number(body.order !== undefined || body.cells !== undefined);
    if (count !== 1) throw new Error("Provide exactly one of order/cells, rectangle, or region");
    if (body.boundaryOrder !== undefined && body.rectangle === undefined) throw new Error("boundaryOrder is only valid with rectangle");
    if (body.rectangle !== undefined || body.region !== undefined) {
      const kind = body.rectangle !== undefined ? "rectangle" : "region";
      const result = kind === "rectangle" ? coverSkyRectangle(body.rectangle, body.boundaryOrder) : { region: normalizeSkyRegion(body.region) };
      const region = { ...result.region, hash: skyRegionHash(result.region), ...("rectangle" in result ? { rectangle: result.rectangle, cover: result.cover } : {}) };
      const batches = groupRegionCells(region.cells).flatMap(group => partitionReverseCells(group.order, group.cells).map(cells => ({ order: group.order, cells })));
      return { kind, region, ...("rectangle" in result ? { rectangle: result.rectangle } : {}), batches,
        fingerprintSelector: { kind, hash: region.hash, ...("rectangle" in result ? { rectangle: result.rectangle, algorithmVersion: result.cover.algorithmVersion, boundaryOrder: result.cover.targetBoundaryOrder } : {}) },
        requested: { layerIds: body.layerIds, region, ...("rectangle" in result ? { rectangle: result.rectangle, inputRectangle: body.rectangle } : {}) } };
    }
    if (!Number.isSafeInteger(body.order) || Number(body.order) < 0 || Number(body.order) > 13 || !Array.isArray(body.cells)) throw new Error("order and cells are required");
    if (body.cells.length > 4096) throw new Error("A reverse lookup may contain at most 4096 cells");
    const order = Number(body.order);
    const cells = [...new Set(body.cells as number[])].sort((a, b) => a - b);
    return { kind: "cells", batches: partitionReverseCells(order, cells).map(cells => ({ order, cells })), fingerprintSelector: { order, cells }, requested: { layerIds: body.layerIds, order, cells } };
  } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(400, error instanceof Error ? error.message : "Invalid region selector"); }
}
