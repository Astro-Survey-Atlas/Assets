import { readFile } from "node:fs/promises";

import { PackageInspectionError, readResourcePackageManifest, type ResourcePackageManifest } from "./resource-package-inspection.js";
import { isDeniedSurvey } from "./publication-policy.js";

export interface SurveyReleaseLookup {
  id: string;
  label?: string;
  kind?: string;
  releasedYear?: number;
}

export interface SurveyLookup {
  id: string;
  name?: string;
  mission?: string;
  releases: SurveyReleaseLookup[];
}

export interface ProjectedRelease {
  id: string;
  label: string;
  kind?: string;
  releasedYear?: number;
  modalities: string[];
  layerCount: number;
}

export interface ProjectedPackageSource {
  releaseId: string;
  label: string;
  url: string;
  authority: string;
}

export interface ProjectedResourcePackage {
  id: string;
  version: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  survey: { id: string; displayName: string; mission?: string };
  facilities: string[];
  modalities: string[];
  accessModes: string[];
  sources: ProjectedPackageSource[];
  releases: ProjectedRelease[];
}

export interface ProjectionSource {
  id: string;
  version: string;
  name: string;
  surveyId: string;
  sizeBytes: number;
  sha256: string;
  facilities?: string[];
  accessModes?: string[];
  sources?: ProjectedPackageSource[];
  zipBytes: Buffer;
}

interface SurveyCatalogDocument {
  surveys?: unknown[];
}

export function surveyLookupsFromCatalog(document: unknown): Map<string, SurveyLookup> {
  const catalog = document as SurveyCatalogDocument;
  const lookups = new Map<string, SurveyLookup>();
  if (!catalog || !Array.isArray(catalog.surveys)) {
    throw new PackageInspectionError("Survey catalog must contain a surveys array");
  }
  for (const entry of catalog.surveys) {
    if (typeof entry !== "object" || entry === null) continue;
    const survey = entry as Record<string, unknown>;
    const id = survey.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const releases: SurveyReleaseLookup[] = [];
    if (Array.isArray(survey.releases)) {
      for (const release of survey.releases) {
        if (typeof release !== "object" || release === null) continue;
        const releaseRecord = release as Record<string, unknown>;
        const releaseId = releaseRecord.id;
        if (typeof releaseId !== "string" || releaseId.length === 0) continue;
        const lookup: SurveyReleaseLookup = { id: releaseId };
        if (typeof releaseRecord.label === "string") lookup.label = releaseRecord.label;
        if (typeof releaseRecord.kind === "string") lookup.kind = releaseRecord.kind;
        if (typeof releaseRecord.releasedYear === "number") lookup.releasedYear = releaseRecord.releasedYear;
        releases.push(lookup);
      }
    }
    const lookup: SurveyLookup = { id, releases };
    if (typeof survey.name === "string") lookup.name = survey.name;
    if (typeof survey.mission === "string") lookup.mission = survey.mission;
    lookups.set(id, lookup);
  }
  return lookups;
}

export async function loadSurveyLookups(catalogPath: string): Promise<Map<string, SurveyLookup>> {
  const bytes = await readFile(catalogPath, "utf8");
  return surveyLookupsFromCatalog(JSON.parse(bytes));
}

function sortedUnion(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export async function projectResourcePackage(
  source: ProjectionSource,
  surveys: ReadonlyMap<string, SurveyLookup>,
  manifest?: ResourcePackageManifest,
): Promise<ProjectedResourcePackage> {
  if (isDeniedSurvey(source.surveyId)) {
    throw new PackageInspectionError(
      `Resource package ${source.id} belongs to survey ${source.surveyId}, which is excluded from publication by policy`,
      403,
    );
  }
  const parsedManifest = manifest ?? (await readResourcePackageManifest(source.zipBytes));
  if (parsedManifest.surveyId !== source.surveyId) {
    throw new PackageInspectionError(
      `Resource package ${source.id} declares survey ${parsedManifest.surveyId} but is cataloged as ${source.surveyId}`,
    );
  }
  for (const layer of parsedManifest.layers) {
    if (isDeniedSurvey(layer.surveyId)) {
      throw new PackageInspectionError(
        `Resource package ${source.id} layer ${layer.layerId} references excluded survey ${layer.surveyId}`,
        403,
      );
    }
    if (layer.surveyId !== source.surveyId) {
      throw new PackageInspectionError(
        `Resource package ${source.id} layer ${layer.layerId} references survey ${layer.surveyId} outside the package survey ${source.surveyId}`,
      );
    }
  }
  const survey = surveys.get(source.surveyId);
  const displayName = survey?.name ?? source.name;
  const releaseMap = new Map<string, ProjectedRelease>();
  for (const layer of parsedManifest.layers) {
    let release = releaseMap.get(layer.releaseId);
    if (!release) {
      const lookup = survey?.releases.find((candidate) => candidate.id === layer.releaseId);
      release = {
        id: layer.releaseId,
        label: lookup?.label ?? layer.releaseId,
        modalities: [],
        layerCount: 0,
      };
      if (lookup?.kind) release.kind = lookup.kind;
      if (lookup?.releasedYear) release.releasedYear = lookup.releasedYear;
      releaseMap.set(layer.releaseId, release);
    }
    release.modalities.push(layer.modality);
    release.layerCount += 1;
  }
  const releases = [...releaseMap.values()]
    .map((release) => ({ ...release, modalities: sortedUnion(release.modalities) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const facilities = sortedUnion(source.facilities ?? []);
  return {
    id: source.id,
    version: source.version,
    name: source.name,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    survey: {
      id: source.surveyId,
      displayName,
      ...(survey?.mission ? { mission: survey.mission } : {}),
    },
    facilities,
    modalities: sortedUnion(releases.flatMap((release) => release.modalities)),
    accessModes: sortedUnion(source.accessModes ?? []),
    sources: (source.sources ?? []).map((sourceRecord) => ({ ...sourceRecord })),
    releases,
  };
}
