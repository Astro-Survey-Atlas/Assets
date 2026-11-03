import { Healpix } from "healpixjs";

import type { CoverageCellLayer } from "./coverage.js";
import type { NativeMoc } from "./native-moc.js";
import { expandPixelRanges, intersectPixelRanges, mocPixelRanges, rangesForCells, type PixelRange } from "./display-coverage.js";

export interface OverlapBounds {
  areaDeg2: number;
  raMin: number;
  raMax: number;
  raWraps: boolean;
  decMin: number;
  decMax: number;
}

export interface OverlapComponent {
  id: string;
  index: number;
  order: number;
  cells: number[];
  bounds: OverlapBounds;
}

export interface OverlapResult {
  schemaVersion: 1;
  surveyIds: string[];
  commonOrder: number;
  limitingLayers: Array<{ layerId: string; availableOrders: number[] }>;
  pixels: number[];
  components: OverlapComponent[];
}

/** Return only the published layers whose real cells intersect one component. */
export function layersForOverlapComponent(
  layers: readonly CoverageCellLayer[],
  result: OverlapResult,
  component: OverlapComponent,
  nativeGeometry?: ReadonlyMap<string, NativeMoc>,
): CoverageCellLayer[] {
  const componentCells = new Set(component.cells);
  return layers.filter((layer) => {
    if (!result.surveyIds.includes(layer.surveyId)) return false;
    const moc = nativeGeometry?.get(layer.layerId);
    if (moc && component.order <= moc.maxOrder) {
      const ranges = mocPixelRanges(moc, component.order);
      return component.cells.some((pixel) => containsPixel(ranges, pixel));
    }
    return layer.cells.get(component.order)?.some((cell) => componentCells.has(cell)) ?? false;
  });
}

const SIDE_NEIGHBOUR_INDICES = [0, 2, 4, 6] as const;
const healpixCache = new Map<number, Healpix>();

function healpix(order: number): Healpix {
  const nside = 2 ** order;
  let instance = healpixCache.get(nside);
  if (!instance) {
    instance = new Healpix(nside);
    healpixCache.set(nside, instance);
  }
  return instance;
}

function boundsFor(pixels: number[], order: number): OverlapBounds {
  const values: Array<{ ra: number; dec: number }> = [];
  for (const pixel of pixels) {
    for (const point of healpix(order).getBoundaries(pixel)) {
      const radius = Math.hypot(point.x, point.y, point.z) || 1;
      values.push({ ra: ((Math.atan2(point.y, point.x) * 180 / Math.PI) + 360) % 360, dec: Math.asin(point.z / radius) * 180 / Math.PI });
    }
  }
  const areaDeg2 = pixels.length * (41252.96124941927 / (12 * (2 ** order) ** 2));
  const ras = values.map((value) => value.ra).sort((left, right) => left - right);
  let raMin = ras[0] ?? 0;
  let raMax = ras[ras.length - 1] ?? 0;
  let raWraps = false;
  if (ras.length > 1) {
    let largestGap = -1;
    let gapIndex = 0;
    for (let index = 0; index < ras.length; index += 1) {
      const next = index === ras.length - 1 ? ras[0]! + 360 : ras[index + 1]!;
      const gap = next - ras[index]!;
      if (gap > largestGap) { largestGap = gap; gapIndex = index; }
    }
    const startIndex = (gapIndex + 1) % ras.length;
    raMin = ras[startIndex]!;
    raMax = ras[gapIndex]!;
    raWraps = raMin > raMax;
  }
  let decMin = 0;
  let decMax = 0;
  if (values.length) {
    decMin = values[0]!.dec;
    decMax = decMin;
    for (const value of values) {
      if (value.dec < decMin) decMin = value.dec;
      if (value.dec > decMax) decMax = value.dec;
    }
  }
  return {
    areaDeg2,
    raMin,
    raMax,
    raWraps,
    decMin,
    decMax,
  };
}

/** A conservative ICRS cone enclosing every cell boundary in one overlap component. */
export function coneForOverlapComponent(component: Pick<OverlapComponent, "order" | "cells" | "bounds">): { raDeg: number; decDeg: number; radiusDeg: number } {
  if (!component.cells.length) throw new Error("Cannot derive a cone for an empty overlap component");
  const span = component.bounds.raWraps
    ? 360 - component.bounds.raMin + component.bounds.raMax
    : component.bounds.raMax - component.bounds.raMin;
  const raDeg = ((component.bounds.raMin + span / 2) % 360 + 360) % 360;
  const decDeg = (component.bounds.decMin + component.bounds.decMax) / 2;
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const center = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  let radiusDeg = 0;
  for (const pixel of component.cells) {
    for (const point of healpix(component.order).getBoundaries(pixel)) {
      const length = Math.hypot(point.x, point.y, point.z) || 1;
      const dot = (center[0]! * point.x + center[1]! * point.y + center[2]! * point.z) / length;
      radiusDeg = Math.max(radiusDeg, Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
    }
  }
  return { raDeg, decDeg, radiusDeg: radiusDeg + 0.01 };
}

function connectedComponents(pixels: number[], order: number): number[][] {
  const selected = new Set(pixels);
  const result: number[][] = [];
  while (selected.size) {
    const start = selected.values().next().value as number;
    const pending = [start];
    const component: number[] = [];
    selected.delete(start);
    while (pending.length) {
      const pixel = pending.pop()!;
      component.push(pixel);
      const neighbours = healpix(order).neighbours(pixel);
      for (const index of SIDE_NEIGHBOUR_INDICES) {
        const neighbour = neighbours[index] ?? -1;
        if (neighbour >= 0 && selected.delete(neighbour)) pending.push(neighbour);
      }
    }
    result.push(component.sort((left, right) => left - right));
  }
  return result.sort((left, right) => left[0]! - right[0]!);
}

export function highestCommonOrder(layers: CoverageCellLayer[]): number | null {
  const common = commonOrders(layers);
  return common.length ? Math.max(...common) : null;
}

function commonOrders(layers: CoverageCellLayer[]): number[] {
  if (!layers.length) return [];
  const bySurvey = new Map<string, Set<number>>();
  layers.forEach((layer) => {
    const previous = bySurvey.get(layer.surveyId);
    // Taking the union of orders would drop a selected O4-only product when
    // another product supports O8. Union geometry only where both are supplied.
    const orders = new Set(previous ? layer.availableOrders.filter((order) => previous.has(order)) : layer.availableOrders);
    bySurvey.set(layer.surveyId, orders);
  });
  return [...bySurvey.values()]
    .reduce<number[]>((orders, available, index) => index === 0 ? [...available] : orders.filter((order) => available.has(order)), [])
    .sort((left, right) => left - right);
}

export class OverlapRenderBudgetError extends Error {
  constructor(readonly cellCount: number, readonly limit: number, readonly action: "zoom-or-reduce-selection" | "reduce-selection") {
    super(action === "zoom-or-reduce-selection"
      ? `The visible overlap contains ${cellCount} cells and exceeds the ${limit}-cell budget; zoom further or reduce selected products`
      : `A full connected overlap component contains more than ${limit} cells; reduce selected products to inspect it completely`);
  }
}

function unionRanges(ranges: readonly PixelRange[]): PixelRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const union: PixelRange[] = [];
  for (const range of sorted) {
    const previous = union.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else union.push({ ...range });
  }
  return union;
}

function containsPixel(ranges: readonly PixelRange[], pixel: number): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end <= pixel) low = middle + 1;
    else high = middle;
  }
  return Boolean(ranges[low] && ranges[low]!.start <= pixel);
}

function strictOverlapForLayers(
  layers: CoverageCellLayer[],
  surveyIds: string[],
  order: number,
  nativeGeometry: ReadonlyMap<string, NativeMoc>,
  maxCells: number,
  viewTiles?: { order: number; tiles: readonly number[] },
): OverlapResult | null {
  const uniqueSurveyIds = [...new Set(surveyIds)];
  if (uniqueSurveyIds.length < 2) return null;
  const selected = layers.filter((layer) => uniqueSurveyIds.includes(layer.surveyId));
  const bySurvey = new Map<string, PixelRange[]>();
  const layerRanges = new Map<string, PixelRange[]>();
  for (const surveyId of uniqueSurveyIds) {
    const surveyLayers = selected.filter((layer) => layer.surveyId === surveyId);
    if (!surveyLayers.length) return null;
    for (const layer of surveyLayers) {
      const moc = nativeGeometry.get(layer.layerId);
      if (moc && order <= moc.maxOrder) layerRanges.set(layer.layerId, mocPixelRanges(moc, order));
      else if (!moc && layer.availableOrders.includes(order)) layerRanges.set(layer.layerId, rangesForCells(layer.cells.get(order) ?? []));
      else return null;
    }
    bySurvey.set(surveyId, unionRanges(surveyLayers.flatMap((layer) => layerRanges.get(layer.layerId) ?? [])));
  }
  const surveyRanges = [...bySurvey.values()];
  let intersection = surveyRanges[0] ?? [];
  for (const ranges of surveyRanges.slice(1)) intersection = intersectPixelRanges(intersection, ranges);
  let viewRanges = intersection;
  if (viewTiles) {
    const expectedTileOrder = Math.max(0, order - 6);
    if (viewTiles.order !== expectedTileOrder || viewTiles.tiles.length > 192
      || viewTiles.tiles.some((tile) => !Number.isSafeInteger(tile) || tile < 0 || tile >= 12 * 4 ** expectedTileOrder)) return null;
    const scale = 4 ** (order - expectedTileOrder);
    const tiles = [...new Set(viewTiles.tiles)].sort((a, b) => a - b);
    const clipped: PixelRange[] = [];
    for (const tile of tiles) {
      const range = { start: tile * scale, end: (tile + 1) * scale };
      clipped.push(...intersectPixelRanges(intersection, [range]));
    }
    viewRanges = unionRanges(clipped);
  }
  const viewCellCount = viewRanges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (viewCellCount > maxCells) throw new OverlapRenderBudgetError(viewCellCount, maxCells, "zoom-or-reduce-selection");
  const pixels = expandPixelRanges(viewRanges, maxCells);
  const componentPixels: number[] = [];
  const visited = new Set<number>();
  let componentCellCount = 0;
  for (const seed of pixels) {
    if (visited.has(seed)) continue;
    const pending = [seed];
    const component: number[] = [];
    visited.add(seed);
    while (pending.length) {
      const pixel = pending.pop()!;
      component.push(pixel);
      componentCellCount += 1;
      if (componentCellCount > maxCells) throw new OverlapRenderBudgetError(componentCellCount, maxCells, "reduce-selection");
      for (const index of SIDE_NEIGHBOUR_INDICES) {
        const neighbour = healpix(order).neighbours(pixel)[index] ?? -1;
        if (neighbour >= 0 && !visited.has(neighbour) && containsPixel(intersection, neighbour)) {
          visited.add(neighbour);
          pending.push(neighbour);
        }
      }
    }
    componentPixels.push(...component.sort((left, right) => left - right));
  }
  const prepared = selected.map((layer) => {
    const ranges = layerRanges.get(layer.layerId) ?? [];
    return { ...layer, availableOrders: [order], cells: new Map([[order, componentPixels.filter((pixel) => containsPixel(ranges, pixel))]]) };
  });
  const components = componentPixels.length ? overlapForLayers(prepared, uniqueSurveyIds, order)?.components ?? [] : [];
  return {
    schemaVersion: 1,
    surveyIds: uniqueSurveyIds,
    commonOrder: order,
    limitingLayers: [],
    pixels,
    components,
  };
}

export function overlapForLayers(
  layers: CoverageCellLayer[],
  surveyIds: string[],
  requestedOrder?: number,
  options: { strictOrder?: boolean; nativeGeometry?: ReadonlyMap<string, NativeMoc>; maxCells?: number; viewTiles?: { order: number; tiles: readonly number[] } } = {},
): OverlapResult | null {
  if (options.strictOrder && requestedOrder !== undefined) {
    return strictOverlapForLayers(layers, surveyIds, requestedOrder, options.nativeGeometry ?? new Map(), options.maxCells ?? 32_768, options.viewTiles);
  }
  const uniqueSurveyIds = [...new Set(surveyIds)];
  const selected = layers.filter((layer) => uniqueSurveyIds.includes(layer.surveyId));
  if (uniqueSurveyIds.length < 2 || selected.length < 2) return null;
  const availableCommonOrders = commonOrders(selected);
  if (!availableCommonOrders.length) return null;
  const eligibleOrders = requestedOrder == null ? availableCommonOrders : availableCommonOrders.filter((candidate) => candidate <= requestedOrder);
  if (!eligibleOrders.length) return null;
  // Prefer the finest common order, but do not report an empty high-order
  // intersection when a lower, explicitly published order has real overlap.
  // This is a coarser-order fallback only; no finer cells are manufactured.
  for (const order of [...eligibleOrders].sort((left, right) => right - left)) {
    const bySurvey = new Map<string, Set<number>>();
    selected.forEach((layer) => {
      const cells = bySurvey.get(layer.surveyId) ?? new Set<number>();
      layer.cells.get(order)?.forEach((pixel) => cells.add(pixel));
      bySurvey.set(layer.surveyId, cells);
    });
    const sets = uniqueSurveyIds.map((surveyId) => bySurvey.get(surveyId) ?? new Set<number>());
    if (sets.some((set) => !set.size)) continue;
    const [first, ...rest] = sets;
    const pixels = [...first!].filter((pixel) => rest.every((set) => set.has(pixel))).sort((left, right) => left - right);
    if (!pixels.length) continue;
    const components = connectedComponents(pixels, order).map((cells, index) => ({ id: `C${String(index + 1).padStart(2, "0")}`, index, order, cells, bounds: boundsFor(cells, order) }));
    return {
      schemaVersion: 1,
      surveyIds: uniqueSurveyIds,
      commonOrder: order,
      limitingLayers: selected.filter((layer) => !layer.availableOrders.includes(order)).map((layer) => ({ layerId: layer.layerId, availableOrders: layer.availableOrders })),
      pixels,
      components,
    };
  }
  const order = Math.max(...eligibleOrders);
  return {
    schemaVersion: 1,
    surveyIds: uniqueSurveyIds,
    commonOrder: order,
    limitingLayers: selected.filter((layer) => !layer.availableOrders.includes(order)).map((layer) => ({ layerId: layer.layerId, availableOrders: layer.availableOrders })),
    pixels: [],
    components: [],
  };
}
