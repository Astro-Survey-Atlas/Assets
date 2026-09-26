import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readResourcePackageManifest, readZipEntry, type ResourcePackageLayerRecord } from "./resource-package-inspection.js";
import { productId as stableProductId } from "./products.js";

export function assertReleaseContinuity(previous: readonly string[], next: readonly string[]): void {
  const missing = [...new Set(previous)].filter((id) => !next.includes(id));
  if (missing.length) throw new Error(`Release removal requires an explicit withdrawal with a reason: ${missing.join(", ")}`);
}

/** Carry immutable layers and their original precision/provenance across incremental publications. */
export async function retainedPackageLayers(root: string | undefined, surveyId: string, replaced: readonly string[]) {
  const layers: ResourcePackageLayerRecord[] = [];
  const entries = new Map<string, Buffer>();
  const provenance: Record<string, unknown>[] = [];
  const footprints: Record<string, unknown>[] = [];
  let metadata: { releases: string[]; releaseLabels: Record<string, string>; sources: Array<{ releaseId: string; label: string; url: string; authority: string }>; version: string } = { releases: [], releaseLabels: {}, sources: [], version: "3.0.0" };
  if (!root) return { layers, entries, provenance, footprints, metadata };
  const base = path.join(root, "artifacts/public-survey-footprints");
  const catalog = JSON.parse(await readFile(path.join(base, "packages/catalog.json"), "utf8"));
  const candidates = catalog.packages.filter((p: { surveyId: string; deprecated?: boolean }) => p.surveyId === surveyId && !p.deprecated);
  candidates.sort((a: { version: string }, b: { version: string }) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const previous = candidates[0];
  if (!previous) return { layers, entries, provenance, footprints, metadata };
  metadata = previous;
  const bytes = await readFile(path.join(base, "packages", `${previous.id}-${previous.version}.zip`));
  if (bytes.length !== previous.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== previous.sha256) throw new Error(`Baseline package hash mismatch: ${previous.id}`);
  const manifest = await readResourcePackageManifest(bytes);
  const retained = manifest.layers.filter((layer) => !replaced.includes(layer.layerId));
  const support = async (name: string) => {
    const record = manifest.files.find((file) => file.path === name);
    const data = await readZipEntry(bytes, name);
    if (!record || data.length !== record.sizeBytes || createHash("sha256").update(data).digest("hex") !== record.sha256) throw new Error(`Baseline support hash mismatch: ${name}`);
    return JSON.parse(data.toString());
  };
  const originalProvenance = await support("provenance.json");
  const originalFootprints = await support("footprints/survey-footprints.json");
  for (const layer of retained) {
    const data = await readZipEntry(bytes, layer.path);
    if (data.length !== layer.sizeBytes || createHash("sha256").update(data).digest("hex") !== layer.sha256) throw new Error(`Baseline MOC hash mismatch: ${layer.layerId}`);
    const source = originalProvenance.layers.find((item: { layerId: string }) => item.layerId === layer.layerId);
    if (!source) throw new Error(`Missing baseline provenance: ${layer.layerId}`);
    const sourceRecord = source as { product?: unknown; sourceId?: unknown };
    const product = typeof layer.product === "string" ? layer.product : typeof sourceRecord.product === "string" ? sourceRecord.product : undefined;
    if (!product) throw new Error(`Missing baseline product identity: ${layer.layerId}`);
    layers.push({
      ...layer,
      product,
      productId: layer.productId ?? stableProductId(layer.surveyId, layer.releaseId, product),
      ...(layer.sourceId || typeof sourceRecord.sourceId !== "string" ? {} : { sourceId: sourceRecord.sourceId }),
    });
    entries.set(layer.path, data);
    provenance.push(source);
    for (const footprint of originalFootprints.footprints.filter((item: { releaseId: string; product: string }) => item.releaseId === layer.releaseId && item.product === source.product)) {
      if (!footprints.includes(footprint)) footprints.push(footprint);
    }
  }
  return { layers, entries, provenance, footprints, metadata };
}
