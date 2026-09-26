import { decodeNativeMoc, projectMoc, sha256 } from "./native-moc.js";
import type { ResourcePackageLayerRecord } from "./resource-package-inspection.js";

export const RESOURCE_PACKAGE_HEALPIX_ORDERS = [4, 8] as const;
export type ResourcePackageHealpixOrder = (typeof RESOURCE_PACKAGE_HEALPIX_ORDERS)[number];

export interface ResourcePackageHealpixFile {
  order: ResourcePackageHealpixOrder;
  path: `healpix/order${ResourcePackageHealpixOrder}.json`;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

type CoveragePrecision = "exact" | "estimated" | "unknown";
type CoverageCompleteness = "complete" | "incomplete" | "unknown";

function precision(value: unknown): CoveragePrecision {
  return value === "exact" || value === "estimated" ? value : "unknown";
}

function completeness(value: unknown): CoverageCompleteness {
  return value === "complete" || value === "incomplete" ? value : "unknown";
}

function unionPrecision(values: readonly CoveragePrecision[]): CoveragePrecision {
  if (!values.length || values.includes("unknown")) return "unknown";
  return values.includes("estimated") ? "estimated" : "exact";
}

function unionCompleteness(values: readonly CoverageCompleteness[], omitted: number): CoverageCompleteness {
  if (omitted || values.includes("incomplete")) return "incomplete";
  if (values.length && values.every((value) => value === "complete")) return "complete";
  return "unknown";
}

/** Build fixed-order lists from the package's native MOCs, never its previews. */
export function buildResourcePackageHealpixFiles(input: {
  packageId: string;
  packageVersion: string;
  surveyId: string;
  layers: readonly ResourcePackageLayerRecord[];
  mocBytesByLayer: ReadonlyMap<string, Uint8Array>;
}): ResourcePackageHealpixFile[] {
  const decoded = new Map<string, ReturnType<typeof decodeNativeMoc>>();
  for (const layer of input.layers) {
    if (layer.surveyId !== input.surveyId) throw new Error(`Resource package layer ${layer.layerId} has a different survey ID`);
    if (!layer.productId || !layer.product) throw new Error(`Resource package layer ${layer.layerId} lacks product identity`);
    const bytes = input.mocBytesByLayer.get(layer.layerId);
    if (!bytes) throw new Error(`Resource package MOC is missing for ${layer.layerId}`);
    if (sha256(bytes) !== layer.sha256) throw new Error(`Resource package MOC checksum mismatch for ${layer.layerId}`);
    const moc = decodeNativeMoc(Buffer.from(bytes));
    if (layer.maxOrder !== undefined && layer.maxOrder !== moc.maxOrder) throw new Error(`Resource package native maximum order mismatch for ${layer.layerId}`);
    if (layer.availableOrders && (layer.availableOrders.length !== moc.availableOrders.length || layer.availableOrders.some((order, index) => order !== moc.availableOrders[index]))) {
      throw new Error(`Resource package available orders mismatch for ${layer.layerId}`);
    }
    decoded.set(layer.layerId, moc);
  }

  return RESOURCE_PACKAGE_HEALPIX_ORDERS.map((order) => {
    const listed: Array<Record<string, unknown>> = [];
    const omittedLayers: Array<{ layerId: string; reason: string }> = [];
    const cells = new Set<number>();
    const precisions: CoveragePrecision[] = [];
    const completenesses: CoverageCompleteness[] = [];

    for (const layer of [...input.layers].sort((left, right) => left.layerId.localeCompare(right.layerId))) {
      const moc = decoded.get(layer.layerId)!;
      if (moc.maxOrder < order) {
        omittedLayers.push({ layerId: layer.layerId, reason: `Native MOC maximum is O${moc.maxOrder}; no O${order} list is produced for this layer.` });
        continue;
      }
      const projection = projectMoc(moc, order);
      if (projection.truncated) throw new Error(`Resource package O${order} projection exceeded its cell limit for ${layer.layerId}`);
      const layerPrecision = precision(layer.geometryPrecision);
      const layerCompleteness = completeness(layer.completeness);
      precisions.push(layerPrecision);
      completenesses.push(layerCompleteness);
      for (const cell of projection.cells) cells.add(cell);
      listed.push({
        layerId: layer.layerId,
        surveyId: layer.surveyId,
        releaseId: layer.releaseId,
        productId: layer.productId,
        product: layer.product,
        ...(layer.sourceId ? { sourceId: layer.sourceId } : {}),
        precision: layerPrecision,
        completeness: layerCompleteness,
        cells: projection.cells,
      });
    }

    const unionCells = [...cells].sort((left, right) => left - right);
    const document = {
      schemaVersion: 1,
      surveyId: input.surveyId,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      revision: `${input.packageId}@${input.packageVersion}`,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      order,
      layers: listed,
      surveyUnion: {
        cells: unionCells,
        precision: unionPrecision(precisions),
        completeness: unionCompleteness(completenesses, omittedLayers.length),
        omittedLayers,
      },
    };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    return { order, path: `healpix/order${order}.json`, bytes, sizeBytes: bytes.length, sha256: sha256(bytes) };
  });
}
