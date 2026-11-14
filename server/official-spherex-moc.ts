import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AdminHttpError } from "./admin.js";
import { assertPublicCoverageMoc } from "./coverage-policy.js";
import { decodeNativeMoc, isFullSkyMoc, sha256 } from "./native-moc.js";
import { fetchPublicSource } from "./public-source-fetch.js";
import type { ProductStore } from "./products.js";
import type { MocBuildService, MocBuildStore, MocBuildOutputFile } from "./moc-build.js";

export const SPHEREX_DR1_CUBE = "spherex-dr1-allsky-cube-moc";
const base = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/";
const identity = "ivo://IPAC/P/SPHEREx/DR1/cube";

/** Acquire only the registered public metadata, then enter the existing staged
 * build workflow. Review/public release activation remain separate operations. */
export async function stageSpherexDr1Moc(options: {
  sourceRoot: string; evidenceRoot: string; products: ProductStore;
  builds: MocBuildStore; buildService: MocBuildService;
  fetchBytes?: (url: string) => Promise<Buffer>;
}, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => key !== "sourceId") || body.sourceId !== SPHEREX_DR1_CUBE) {
    throw new AdminHttpError(400, "Select the registered SPHEREx DR1 Cube sourceId");
  }
  const recipeBytes = await readFile(path.join(options.sourceRoot, `src/layers/recipes/${SPHEREX_DR1_CUBE}.lock.json`));
  const lock = JSON.parse(recipeBytes.toString());
  const acquire = options.fetchBytes ?? (async (url: string) => {
    return (await fetchPublicSource(url, 1024 * 1024, AbortSignal.timeout(30_000))).bytes;
  });
  const [source, properties] = await Promise.all([acquire(`${base}Moc.fits`), acquire(`${base}properties`)]);
  if (source.length !== lock.snapshot.sizeBytes || sha256(source) !== lock.snapshot.sha256
    || sha256(properties) !== lock.recipe.sourceRecordSha256) throw new Error("IRSA metadata differs from the locked snapshot; review the new source before updating its lock");
  if (!properties.toString().split(/\r?\n/).some(line => /^creator_did\s*=/.test(line) && line.split("=").slice(1).join("=").trim() === identity)) throw new Error("IRSA properties do not identify the DR1 Cube");
  const original = decodeNativeMoc(source);
  assertPublicCoverageMoc(original);
  if (original.maxOrder !== 0 || !isFullSkyMoc(original)) throw new Error("Locked DR1 Cube MOC is not the expected complete sky");
  const parent = path.join(options.evidenceRoot, "moc-build");
  await mkdir(parent, { recursive: true });
  const name = `spherex-dr1-cube-${randomUUID().slice(0, 8)}`;
  const target = path.join(parent, name);
  await mkdir(target);
  await writeFile(path.join(target, "source.fits"), source);
  await writeFile(path.join(target, "properties"), properties);
  await writeFile(path.join(target, "recipe.lock.json"), recipeBytes);
  const validation = await options.buildService.runner.validate(path.join(target, "source.fits"));
  if (validation.valid !== true) throw new Error("SDK rejected the official source MOC");
  await options.buildService.runner.build(path.join(target, "source.fits"), target, { maxOrder: 0, queryOrder: 0, previewOrder: 0 });
  const normalized = decodeNativeMoc(await readFile(path.join(target, "moc.fits")));
  if (normalized.revision !== original.revision || normalized.maxOrder !== 0) throw new Error("SDK normalization changed the locked geometry");
  const file = async (filename: string): Promise<MocBuildOutputFile & { sha256: string; sizeBytes: number }> => {
    const bytes = await readFile(path.join(target, filename));
    return { ref: path.relative(options.evidenceRoot, path.join(target, filename)), sha256: sha256(bytes), sizeBytes: bytes.length };
  };
  const sourceEvidence = {
    evidenceKind: "published-moc" as const, sourceIdentity: identity,
    sourceSnapshotSha256: sha256(source), precision: "estimated" as const,
    completeness: "unknown" as const, scienceFileScan: "not-scanned" as const,
    summary: lock.recipe.precisionJustification as string,
  };
  const catalog = JSON.parse(await readFile(path.join(options.sourceRoot, "src/surveys/survey-catalog.json"), "utf8"));
  const survey = catalog.surveys.find((entry: { id: string }) => entry.id === "spherex");
  const product = await options.products.createMocProduct({
    surveyId: "spherex", surveyName: survey.name, mission: survey.mission, surveyDescription: survey.description,
    surveyColor: survey.color, surveyModalities: ["infrared"], releaseId: "spherex-dr1", releaseLabel: "SPHEREx DR1",
    releaseKind: "public_release", releasedYear: 2026, productName: lock.product,
    productDescription: sourceEvidence.summary, modality: "infrared", sourceUrl: lock.sourceUrl,
    geometrySourceUrl: `${base}Moc.fits`, geometrySourceLabel: "Official IRSA DR1 Cube HiPS MOC",
    sourceTier: "official_geometry", coverageEvidence: sourceEvidence,
  });
  const updated = await options.products.updateDraft(product.productId, {
    ...product.draft, name: lock.product, sourceTier: "official_geometry", dataOrigin: "observed",
    modality: "infrared", sourceUrl: lock.sourceUrl, geometrySourceUrl: `${base}Moc.fits`,
    geometrySourceLabel: "Official IRSA DR1 Cube HiPS MOC", layerId: SPHEREX_DR1_CUBE, mode: "native-moc", coverageRole: "footprint_extent",
    coverageEvidence: sourceEvidence, publicDescription: sourceEvidence.summary,
    publicSurvey: { name: survey.name, mission: survey.mission, description: survey.description, color: survey.color, modalities: ["infrared"] },
    publicRelease: { label: "SPHEREx DR1", kind: "public_release", releasedYear: 2026 },
  }, product.revision);
  const outputs = { moc: await file("moc.fits"), query: { ...await file("query-order0.json"), order: 0 },
    preview: { ...await file("preview-order0.json"), order: 0 }, statistics: await file("statistics.json"),
    cellCount: normalized.cells.length, availableOrders: normalized.availableOrders, maxOrder: normalized.maxOrder };
  const provenance = { schemaVersion: 1, sourceId: identity, sourceUrl: `${base}Moc.fits`,
    source: await file("source.fits"), properties: await file("properties"), recipe: await file("recipe.lock.json"),
    outputs, coverageRevision: normalized.revision, sourceEvidence };
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(provenance, null, 2) + "\n");
  const request = await options.builds.createVerifiedEvidenceBuild({
    name, layerId: SPHEREX_DR1_CUBE, candidateId: identity, candidateTitle: lock.product,
    surveyId: "spherex", releaseId: "spherex-dr1", productId: product.productId,
    source: { url: `${base}Moc.fits`, snapshotSha256: sha256(source), sizeBytes: source.length,
      evidenceRef: (await file("source.fits")).ref, sourceEvidence,
      evidenceInputs: [{ label: "IRSA HiPS properties", ...await file("properties") }, { label: "Recipe lock", ...await file("recipe.lock.json") }] },
    outputs: { ...outputs, manifest: await file("manifest.json") },
  });
  await options.buildService.verifyOutputs(name);
  return { request, product: updated };
}
