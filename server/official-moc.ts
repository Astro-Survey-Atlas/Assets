import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AdminHttpError } from "./admin.js";
import { assertPublicCoverageMoc } from "./coverage-policy.js";
import { decodeNativeMoc, isFullSkyMoc, sha256 } from "./native-moc.js";
import { fetchPublicSource } from "./public-source-fetch.js";
import type { ProductStore } from "./products.js";
import type { MocBuildService, MocBuildStore, MocBuildOutputFile } from "./moc-build.js";

import { OFFICIAL_MOC_SOURCES } from "./official-moc-sources.js";

/** Acquire only the registered public metadata, then enter the existing staged
 * build workflow. Review/public release activation remain separate operations. */
export async function stageOfficialMoc(options: {
  sourceRoot: string; evidenceRoot: string; products: ProductStore;
  builds: MocBuildStore; buildService: MocBuildService;
  fetchBytes?: (url: string) => Promise<Buffer>;
}, body: Record<string, unknown>) {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
  const descriptor = Object.hasOwn(OFFICIAL_MOC_SOURCES, sourceId) ? OFFICIAL_MOC_SOURCES[sourceId] : undefined;
  if (Object.keys(body).some(key => key !== "sourceId") || !descriptor) {
    throw new AdminHttpError(400, "Select a registered official MOC sourceId");
  }
  const identity = descriptor.identity;
  const recipeBytes = await readFile(path.join(options.sourceRoot, `src/layers/recipes/${sourceId}.lock.json`));
  const lock = JSON.parse(recipeBytes.toString());
  const acquire = options.fetchBytes ?? (async (url: string) => {
    return (await fetchPublicSource(url, 8 * 1024 * 1024, AbortSignal.timeout(30_000))).bytes;
  });
  const [source, properties] = await Promise.all([acquire(descriptor.mocUrl), acquire(descriptor.recordUrl)]);
  if (source.length !== lock.snapshot.sizeBytes || sha256(source) !== lock.snapshot.sha256
    || sha256(properties) !== lock.recipe.sourceRecordSha256) throw new Error("IRSA metadata differs from the locked snapshot; review the new source before updating its lock");
  const recordText = properties.toString();
  if (descriptor.creatorDid && !recordText.split(/\r?\n/).some(line => /^creator_did\s*=/.test(line) && line.split("=").slice(1).join("=").trim() === descriptor.creatorDid)) {
    throw new Error("Official record does not identify the selected HiPS product");
  }
  if (descriptor.recordMarkers?.some(marker => !recordText.includes(marker))) throw new Error("Official record does not identify the selected archive MOC");
  if (lock.surveyId !== descriptor.surveyId || lock.releaseId !== descriptor.releaseId
    || lock.recipe.sourceMocUrl !== descriptor.mocUrl || lock.recipe.sourceRecordUrl !== descriptor.recordUrl) throw new Error("Recipe identity does not match the registered source");
  const original = decodeNativeMoc(source);
  assertPublicCoverageMoc(original);
  if (original.maxOrder !== lock.maxOrder || (descriptor.fullSky && !isFullSkyMoc(original))) throw new Error("Official MOC differs from its locked native geometry");
  const parent = path.join(options.evidenceRoot, "moc-build");
  await mkdir(parent, { recursive: true });
  const name = `${sourceId}-${randomUUID().slice(0, 8)}`;
  const target = path.join(parent, name);
  const recordFilename = descriptor.creatorDid ? "properties" : "source-record.js";
  await mkdir(target);
  await writeFile(path.join(target, "source.fits"), source);
  await writeFile(path.join(target, recordFilename), properties);
  await writeFile(path.join(target, "recipe.lock.json"), recipeBytes);
  if (!descriptor.legacyPixelMoc) {
    const validation = await options.buildService.runner.validate(path.join(target, "source.fits"));
    if (validation.valid !== true) throw new Error("SDK rejected the official source MOC");
  }
  await options.buildService.runner.build(path.join(target, "source.fits"), target, { maxOrder: lock.maxOrder, queryOrder: lock.queryOrder, previewOrder: lock.previewOrder });
  const normalized = decodeNativeMoc(await readFile(path.join(target, "moc.fits")));
  if (normalized.revision !== original.revision || normalized.maxOrder !== original.maxOrder) throw new Error("SDK normalization changed the locked geometry");
  const file = async (filename: string): Promise<MocBuildOutputFile & { sha256: string; sizeBytes: number }> => {
    const bytes = await readFile(path.join(target, filename));
    return { ref: path.relative(options.evidenceRoot, path.join(target, filename)), sha256: sha256(bytes), sizeBytes: bytes.length };
  };
  for (const [kind, filename] of [["moc", "moc.fits"], ["query", `query-order${lock.queryOrder}.json`], ["preview", `preview-order${lock.previewOrder}.json`]] as const) {
    const expected = lock.expectedOutputs?.[kind];
    if (expected) {
      const actual = await file(filename);
      if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) throw new Error(`Normalized ${kind} differs from its locked output`);
    }
  }
  const sourceEvidence = {
    evidenceKind: "published-moc" as const, sourceIdentity: identity,
    sourceSnapshotSha256: sha256(source), precision: "estimated" as const,
    completeness: "unknown" as const, scienceFileScan: "not-scanned" as const,
    summary: lock.recipe.precisionJustification as string,
  };
  const catalog = JSON.parse(await readFile(path.join(options.sourceRoot, "src/surveys/survey-catalog.json"), "utf8"));
  const survey = catalog.surveys.find((entry: { id: string }) => entry.id === descriptor.surveyId);
  const product = await options.products.createMocProduct({
    surveyId: descriptor.surveyId, surveyName: survey.name, mission: survey.mission, surveyDescription: survey.description,
    surveyColor: survey.color, surveyModalities: [descriptor.modality], releaseId: descriptor.releaseId, releaseLabel: descriptor.releaseLabel,
    releaseKind: descriptor.releaseKind, releasedYear: descriptor.releasedYear, productName: lock.product,
    productDescription: sourceEvidence.summary, modality: descriptor.modality, sourceUrl: lock.sourceUrl,
    geometrySourceUrl: descriptor.mocUrl, geometrySourceLabel: descriptor.geometrySourceLabel,
    sourceTier: "official_geometry", coverageEvidence: sourceEvidence,
  });
  const updated = await options.products.updateDraft(product.productId, {
    ...product.draft, name: lock.product, sourceTier: "official_geometry", dataOrigin: "observed",
    modality: descriptor.modality, sourceUrl: lock.sourceUrl, geometrySourceUrl: descriptor.mocUrl,
    geometrySourceLabel: descriptor.geometrySourceLabel, layerId: sourceId, mode: "native-moc", coverageRole: "footprint_extent",
    coverageEvidence: sourceEvidence, publicDescription: sourceEvidence.summary,
    publicSurvey: { name: survey.name, mission: survey.mission, description: survey.description, color: survey.color, modalities: [descriptor.modality] },
    publicRelease: { label: descriptor.releaseLabel, kind: descriptor.releaseKind, releasedYear: descriptor.releasedYear },
  }, product.revision);
  const outputs = { moc: await file("moc.fits"), query: { ...await file(`query-order${lock.queryOrder}.json`), order: lock.queryOrder },
    preview: { ...await file(`preview-order${lock.previewOrder}.json`), order: lock.previewOrder }, statistics: await file("statistics.json"),
    cellCount: normalized.cells.length, availableOrders: normalized.availableOrders, maxOrder: normalized.maxOrder };
  const provenance = { schemaVersion: 1, sourceId: identity, sourceUrl: descriptor.mocUrl,
    source: await file("source.fits"), properties: await file(recordFilename), recipe: await file("recipe.lock.json"),
    outputs, coverageRevision: normalized.revision, sourceEvidence };
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(provenance, null, 2) + "\n");
  const request = await options.builds.createVerifiedEvidenceBuild({
    name, layerId: sourceId, candidateId: identity, candidateTitle: lock.product,
    surveyId: descriptor.surveyId, releaseId: descriptor.releaseId, productId: product.productId,
    source: { url: descriptor.mocUrl, snapshotSha256: sha256(source), sizeBytes: source.length,
      evidenceRef: (await file("source.fits")).ref, sourceEvidence,
      evidenceInputs: [{ label: "Official source record", ...await file(recordFilename) }, { label: "Recipe lock", ...await file("recipe.lock.json") }] },
    outputs: { ...outputs, manifest: await file("manifest.json") },
  });
  await options.buildService.verifyOutputs(name);
  return { request, product: updated };
}
