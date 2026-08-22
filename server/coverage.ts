import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CoverageCellLayer {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  color: string;
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
  cellCount: number;
  areaDeg2: number;
  tileScheme: string;
  cells: Map<number, number[]>;
}

export interface CoverageCatalog {
  schemaVersion: 1;
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  tileScheme: "ipix-range-4096";
  layers: Array<Omit<CoverageCellLayer, "cells">>;
}

const identity = (surveyId: string, releaseId: string, product: string): string => `${surveyId}:${releaseId}:${product}`;
const slug = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);

function colorFor(id: string): string {
  const palette = ["#1e857b", "#376b9b", "#a66a25", "#b64b3e", "#3b8054", "#7a5a9e", "#b27b2d", "#2b7887"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

function hashCells(cells: number[]): string {
  return createHash("sha256").update(JSON.stringify(cells)).digest("hex");
}

export async function loadCoverageCatalog(root: string, manifest: { footprints: Array<{ surveyId: string; releaseId: string; product: string; nside: number; pixels: number[] }> }): Promise<CoverageCatalog & { records: Map<string, CoverageCellLayer> }> {
  const registryPath = path.join(root, "src", "layers", "layer-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; maxOrder?: number }> };
  const registryByIdentity = new Map((registry.layers ?? []).map((entry) => [identity(entry.surveyId, entry.releaseId, entry.product), entry]));
  const colors = new Map<string, string>();
  const surveyCatalog = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as { surveys?: Array<{ id: string; color: string }> };
  for (const survey of surveyCatalog.surveys ?? []) colors.set(survey.id, survey.color);
  const records = new Map<string, CoverageCellLayer>();
  for (const footprint of manifest.footprints) {
    const key = identity(footprint.surveyId, footprint.releaseId, footprint.product);
    const registered = registryByIdentity.get(key);
    const layerId = registered?.layerId ?? `${slug(footprint.surveyId)}-${slug(footprint.releaseId)}-${slug(footprint.product)}`;
    const order = Math.round(Math.log2(footprint.nside));
    const cells = new Map<number, number[]>([[order, [...new Set(footprint.pixels)].sort((a, b) => a - b)]]);
    const record: CoverageCellLayer = {
      layerId,
      productId: createHash("sha256").update(`${footprint.surveyId}\n${footprint.releaseId}\n${footprint.product}`).digest("hex").slice(0, 20),
      surveyId: footprint.surveyId,
      releaseId: footprint.releaseId,
      product: footprint.product,
      color: colors.get(footprint.surveyId) ?? colorFor(footprint.surveyId),
      availableOrders: [order],
      overviewOrder: order,
      maxOrder: registered?.maxOrder ?? order,
      cellCount: cells.get(order)!.length,
      areaDeg2: cells.get(order)!.length * (41252.96124941927 / (12 * footprint.nside * footprint.nside)),
      tileScheme: "ipix-range-4096",
      cells,
    };
    records.set(layerId, record);
  }
  // Add the higher-order query projections that are already part of the
  // release. They are optional: a layer never advertises an order without a
  // corresponding, verified projection.
  for (const record of records.values()) {
    const queryPath = path.join(root, "artifacts", "public-survey-footprints", "layers", record.layerId, "query-order8.json");
    try {
      const query = JSON.parse(await readFile(queryPath, "utf8")) as { order?: number; ordering?: string; pixels?: number[] };
      if (query.order === 8 && query.ordering === "NESTED" && Array.isArray(query.pixels) && query.pixels.length) {
        record.cells.set(8, [...new Set(query.pixels)].sort((a, b) => a - b));
        record.availableOrders = [...record.cells.keys()].sort((a, b) => a - b);
        record.maxOrder = Math.max(record.maxOrder, 8);
      }
    } catch { /* no high-order projection for this layer */ }
  }
  const layers = [...records.values()].map(({ cells: _cells, ...record }) => record);
  return { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED", tileScheme: "ipix-range-4096", layers, records };
}

export function coverageBlock(record: CoverageCellLayer, order: number, tileId: number): { layerId: string; order: number; tileId: number; cells: number[]; sha256: string } | null {
  const cells = record.cells.get(order);
  if (!cells) return null;
  const tileSize = 4096;
  const start = tileId * tileSize;
  const selected = cells.filter((cell) => cell >= start && cell < start + tileSize);
  if (!selected.length) return null;
  return { layerId: record.layerId, order, tileId, cells: selected, sha256: hashCells(selected) };
}

export function coverageTiles(record: CoverageCellLayer, order: number): number[] {
  const cells = record.cells.get(order) ?? [];
  const tileSize = 4096;
  return [...new Set(cells.map((cell) => Math.floor(cell / tileSize)))];
}
