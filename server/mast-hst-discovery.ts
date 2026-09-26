import { AdminHttpError } from "./admin.js";
import type { CoverageCellLayer } from "./coverage.js";
import { decodeNativeMoc, projectMoc, type NativeMoc } from "./native-moc.js";
import { coneForOverlapComponent, overlapForLayers } from "./overlap.js";
import { MAST_HST_DISCOVERY_POLICY, type MastHstObservationQuery, type MastHstScopeRef } from "./moc-discovery.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_NATIVE_INTERSECTION_CELLS = 65_536;
export const EUCLID_Q1_VIS_LAYER_ID = "euclid-euclid-q1-euclid-q1-vis-moc";

export interface MastHstScopeIdentity {
  name: string;
  phase: string;
  surveyId?: string;
}

export interface MastHstResolvedScope {
  ref: MastHstScopeRef;
  query: MastHstObservationQuery;
  componentId: string;
}

type PixelRange = [start: number, end: number];

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseMastHstScopeRef(value: unknown): MastHstScopeRef {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["publishedLayerId", "stagedBuildName", "order", "componentIndex"].includes(key))) {
    throw new AdminHttpError(400, "scopeRef must contain only publishedLayerId, stagedBuildName, order, and componentIndex");
  }
  if (input.publishedLayerId !== EUCLID_Q1_VIS_LAYER_ID) throw new AdminHttpError(400, "publishedLayerId must identify the current Euclid Q1 VIS layer");
  if (typeof input.stagedBuildName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.stagedBuildName)) {
    throw new AdminHttpError(400, "stagedBuildName must be a valid MOC build name");
  }
  if (!Number.isSafeInteger(input.order) || Number(input.order) < 4 || Number(input.order) > 12) {
    throw new AdminHttpError(400, "order must be an integer from 4 through 12");
  }
  if (!Number.isSafeInteger(input.componentIndex) || Number(input.componentIndex) < 0 || Number(input.componentIndex) >= 4096) {
    throw new AdminHttpError(400, "componentIndex must be a non-negative integer below 4096");
  }
  return {
    publishedLayerId: input.publishedLayerId,
    stagedBuildName: input.stagedBuildName,
    order: Number(input.order),
    componentIndex: Number(input.componentIndex),
  };
}

export function resolveMastHstScope(input: {
  ref: MastHstScopeRef;
  publishedLayer: Pick<CoverageCellLayer, "layerId" | "surveyId" | "releaseId" | "product">;
  publishedMoc: NativeMoc;
  publishedMocSha256: string;
  stagedBuild: MastHstScopeIdentity;
  stagedMoc: NativeMoc;
  stagedMocSha256: string;
}): MastHstResolvedScope {
  const { ref } = input;
  const publishedLayer = input.publishedLayer;
  if (publishedLayer.layerId !== ref.publishedLayerId || publishedLayer.surveyId !== "euclid" || publishedLayer.releaseId !== "euclid-q1") {
    throw new AdminHttpError(409, "The selected published layer is not the current Euclid Q1 VIS product");
  }
  if (input.stagedBuild.name !== ref.stagedBuildName || input.stagedBuild.phase !== "STAGED" || input.stagedBuild.surveyId !== "hst") {
    throw new AdminHttpError(409, "The selected staged build is not a ready HST product");
  }
  if (!SHA256.test(input.publishedMocSha256) || input.publishedMoc.sha256 !== input.publishedMocSha256
    || !SHA256.test(input.stagedMocSha256) || input.stagedMoc.sha256 !== input.stagedMocSha256) {
    throw new AdminHttpError(409, "The selected MOC bytes do not match their authoritative hashes");
  }
  if (ref.order > Math.min(input.publishedMoc.maxOrder, input.stagedMoc.maxOrder)) {
    throw new AdminHttpError(409, "The requested order exceeds a selected native MOC's actual maximum order");
  }
  const intersection = intersectNativeMocs(input.publishedMoc, input.stagedMoc, ref.order);
  if (!intersection.length) throw new AdminHttpError(409, "The selected native MOCs have no intersection at the requested order");
  const overlapLayer = (layerId: string, surveyId: string, pixels: number[]): CoverageCellLayer => ({
    layerId,
    productId: layerId,
    surveyId,
    releaseId: "scope",
    product: layerId,
    color: "#000000",
    availableOrders: [ref.order],
    overviewOrder: ref.order,
    maxOrder: ref.order,
    cellCount: pixels.length,
    areaDeg2: 0,
    tileScheme: "nested",
    cells: new Map([[ref.order, pixels]]),
  });
  const overlap = overlapForLayers([
    overlapLayer(ref.publishedLayerId, "euclid", intersection),
    overlapLayer(input.stagedBuild.name, "hst", intersection),
  ], ["euclid", "hst"], ref.order);
  const component = overlap?.components[ref.componentIndex];
  if (!component) throw new AdminHttpError(409, "The requested overlap component does not exist at the selected order");
  if (component.cells.length > 4096) throw new AdminHttpError(409, "The selected component exceeds the Warehouse scope cell limit");
  const cone = coneForOverlapComponent(component);
  if (cone.radiusDeg > 10) throw new AdminHttpError(409, "The selected overlap component is too large for the bounded MAST cone query");
  return {
    ref,
    componentId: component.id,
    query: {
      coordinateFrame: "ICRS",
      cone,
      scope: {
        ordering: "NESTED",
        order: ref.order,
        cells: component.cells,
        q1MocSha256: input.publishedMocSha256,
        hstMocSha256: input.stagedMocSha256,
      },
    },
  };
}

function projectedRanges(moc: NativeMoc, order: number): PixelRange[] {
  const ranges = moc.cells.map((cell): PixelRange => {
    if (cell.order <= order) {
      const scale = 4 ** (order - cell.order);
      return [cell.pixel * scale, (cell.pixel + 1) * scale];
    }
    const pixel = Math.floor(cell.pixel / 4 ** (cell.order - order));
    return [pixel, pixel + 1];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: PixelRange[] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Intersect compact projected NUNIQ ranges before expanding only shared cells. */
function intersectNativeMocs(left: NativeMoc, right: NativeMoc, order: number): number[] {
  const leftRanges = projectedRanges(left, order);
  const rightRanges = projectedRanges(right, order);
  const pixels: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftRanges.length && rightIndex < rightRanges.length) {
    const leftRange = leftRanges[leftIndex]!;
    const rightRange = rightRanges[rightIndex]!;
    const start = Math.max(leftRange[0], rightRange[0]);
    const end = Math.min(leftRange[1], rightRange[1]);
    if (start < end) {
      if (pixels.length + end - start > MAX_NATIVE_INTERSECTION_CELLS) {
        throw new AdminHttpError(409, "The exact native MOC intersection exceeds the bounded scope computation limit");
      }
      for (let pixel = start; pixel < end; pixel += 1) pixels.push(pixel);
    }
    if (leftRange[1] <= rightRange[1]) leftIndex += 1;
    if (rightRange[1] <= leftRange[1]) rightIndex += 1;
  }
  return pixels;
}

export function decodeScopeMoc(bytes: Buffer, expectedSha256: string): NativeMoc {
  if (!SHA256.test(expectedSha256)) throw new AdminHttpError(409, "MOC record has an invalid SHA-256");
  try {
    const moc = decodeNativeMoc(bytes);
    if (moc.sha256 !== expectedSha256) throw new Error("MOC bytes do not match their record");
    return moc;
  } catch (error) {
    throw new AdminHttpError(409, `Selected native MOC is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isMastHstDiscoveryPolicy(value: unknown): value is typeof MAST_HST_DISCOVERY_POLICY {
  return value === MAST_HST_DISCOVERY_POLICY;
}
