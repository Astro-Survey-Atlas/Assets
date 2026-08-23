import { Healpix } from "healpixjs";

import type { CoverageCellLayer } from "./coverage.js";

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
  return {
    areaDeg2,
    raMin,
    raMax,
    raWraps,
    decMin: values.length ? Math.min(...values.map((value) => value.dec)) : 0,
    decMax: values.length ? Math.max(...values.map((value) => value.dec)) : 0,
  };
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
  if (!layers.length) return null;
  const bySurvey = new Map<string, Set<number>>();
  layers.forEach((layer) => {
    const orders = bySurvey.get(layer.surveyId) ?? new Set<number>();
    layer.availableOrders.forEach((order) => orders.add(order));
    bySurvey.set(layer.surveyId, orders);
  });
  const common = [...bySurvey.values()].reduce<number[]>((orders, available, index) => index === 0 ? [...available] : orders.filter((order) => available.has(order)), []);
  return common.length ? Math.max(...common) : null;
}

function commonOrders(layers: CoverageCellLayer[]): number[] {
  if (!layers.length) return [];
  const bySurvey = new Map<string, Set<number>>();
  layers.forEach((layer) => {
    const orders = bySurvey.get(layer.surveyId) ?? new Set<number>();
    layer.availableOrders.forEach((order) => orders.add(order));
    bySurvey.set(layer.surveyId, orders);
  });
  return [...bySurvey.values()]
    .reduce<number[]>((orders, available, index) => index === 0 ? [...available] : orders.filter((order) => available.has(order)), [])
    .sort((left, right) => left - right);
}

export function overlapForLayers(layers: CoverageCellLayer[], surveyIds: string[], requestedOrder?: number): OverlapResult | null {
  const uniqueSurveyIds = [...new Set(surveyIds)];
  const selected = layers.filter((layer) => uniqueSurveyIds.includes(layer.surveyId));
  if (uniqueSurveyIds.length < 2 || selected.length < 2) return null;
  const availableCommonOrders = commonOrders(selected);
  if (!availableCommonOrders.length) return null;
  const eligibleOrders = requestedOrder == null ? availableCommonOrders : availableCommonOrders.filter((candidate) => candidate <= requestedOrder);
  if (!eligibleOrders.length) return null;
  const order = Math.max(...eligibleOrders);
  const bySurvey = new Map<string, Set<number>>();
  selected.forEach((layer) => {
    const cells = bySurvey.get(layer.surveyId) ?? new Set<number>();
    layer.cells.get(order)?.forEach((pixel) => cells.add(pixel));
    bySurvey.set(layer.surveyId, cells);
  });
  const sets = uniqueSurveyIds.map((surveyId) => bySurvey.get(surveyId) ?? new Set<number>());
  if (sets.some((set) => !set.size)) return { schemaVersion: 1, surveyIds, commonOrder: order, limitingLayers: selected.filter((layer) => !layer.availableOrders.includes(order)).map((layer) => ({ layerId: layer.layerId, availableOrders: layer.availableOrders })), pixels: [], components: [] };
  const [first, ...rest] = sets;
  const pixels = [...first!].filter((pixel) => rest.every((set) => set.has(pixel))).sort((left, right) => left - right);
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
