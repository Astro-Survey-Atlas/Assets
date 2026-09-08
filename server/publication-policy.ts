import type { PublicAssetRecord } from "./types.js";

/**
 * Publication sensitivity policy.
 *
 * Deep module owning which surveys are excluded from every public release
 * artifact (manifest, archive, package catalog, release history, API).
 * Data for denied surveys stays in Git, evidence storage, admin and the
 * warehouse; it is only excluded at publication time.
 */

export const DENIED_SURVEY_IDS: readonly string[] = (() => {
  const raw = process.env.ASSETS_DENIED_SURVEYS ?? "csst";
  const ids = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return ids.length > 0 ? ids : ["csst"];
})();

export function isDeniedSurvey(surveyId: string | undefined | null): boolean {
  if (!surveyId) return false;
  return DENIED_SURVEY_IDS.includes(surveyId.trim().toLowerCase());
}

export function isDeniedLayerId(layerId: string | undefined | null): boolean {
  if (!layerId) return false;
  const normalized = layerId.trim().toLowerCase();
  // Layer ids and spec paths for denied surveys embed the survey id as their
  // first path/segment component (e.g. "csst-sim-w2-image-extent").
  return DENIED_SURVEY_IDS.some((surveyId) => {
    const prefix = `${surveyId}-`;
    return normalized === surveyId || normalized.startsWith(prefix);
  });
}

/**
 * Package ids embed the survey slug as a hyphen segment
 * (e.g. "public-csst-footprints-3.0.0"). Used as a serve-time,
 * fail-closed filter for history and catalog projections.
 */
export function isDeniedPackageId(packageId: string | undefined | null): boolean {
  if (!packageId) return false;
  const segments = packageId.trim().toLowerCase().split("-");
  return DENIED_SURVEY_IDS.some((surveyId) => segments.includes(surveyId));
}

function isDeniedPathFragment(value: string): boolean {
  const normalized = value.toLowerCase();
  return DENIED_SURVEY_IDS.some((surveyId) => {
    const delimited = `/${surveyId}/`;
    return (
      normalized === surveyId ||
      normalized.startsWith(`${surveyId}/`) ||
      normalized.endsWith(`/${surveyId}`) ||
      normalized.includes(delimited) ||
      normalized.includes(`${delimited.slice(0, -1)}-`)
    );
  });
}

/**
 * Relative release-tree paths of JSON control documents that must be
 * sanitized before publication when they reference denied surveys.
 * Content-addressed data files are excluded by record filtering instead.
 */
const SANITIZABLE_CONTROL_DOCUMENTS: readonly string[] = [
  "src/surveys/survey-catalog.json",
  "src/layers/layer-registry.json",
  "src/layers/public-build-plan.json",
  "src/footprints/survey-footprints.json",
  "artifacts/public-survey-footprints/normalized/survey-footprints.json",
  "artifacts/public-survey-footprints/packages/catalog.json",
];

export function isSanitizableControlDocument(relativePath: string): boolean {
  return SANITIZABLE_CONTROL_DOCUMENTS.includes(relativePath);
}

function dropDeniedFromArray(value: unknown[], surveyKey: string): unknown[] {
  return value.filter((entry) => {
    if (entry === null || typeof entry !== "object") return true;
    const surveyId = (entry as Record<string, unknown>)[surveyKey];
    return typeof surveyId === "string" ? !isDeniedSurvey(surveyId) : true;
  });
}

function dropDeniedBuilds(value: unknown[]): unknown[] {
  return value.filter((entry) => {
    if (entry === null || typeof entry !== "object") return true;
    const spec = (entry as Record<string, unknown>)["spec"];
    return typeof spec === "string" ? !isDeniedPathFragment(spec) : true;
  });
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Sanitize one control document for publication. Returns sanitized bytes when
 * the document references denied surveys and must change; returns null when
 * the document does not reference denied surveys (bytes stay untouched).
 * Throws when the input is not valid JSON.
 */
export function sanitizeReleaseControlDocument(
  relativePath: string,
  bytes: Buffer,
): Buffer | null {
  if (!isSanitizableControlDocument(relativePath)) return null;
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Cannot sanitize release control document ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document === null || typeof document !== "object") {
    throw new Error(
      `Release control document ${relativePath} must be a JSON object`,
    );
  }
  const root = document as Record<string, unknown>;
  let changed = false;

  if (relativePath === "src/layers/public-build-plan.json") {
    const builds = root["builds"];
    if (Array.isArray(builds)) {
      const sanitized = dropDeniedBuilds(builds);
      if (sanitized.length !== builds.length) changed = true;
      root["builds"] = sanitized;
    }
  } else if (relativePath === "src/footprints/survey-footprints.json" || relativePath === "artifacts/public-survey-footprints/normalized/survey-footprints.json") {
    const footprints = root["footprints"];
    if (Array.isArray(footprints)) {
      const sanitized = dropDeniedFromArray(footprints, "surveyId");
      if (sanitized.length !== footprints.length) changed = true;
      root["footprints"] = sanitized;
    }
  } else {
    for (const [key, field] of [
      ["surveys", "id"],
      ["layers", "surveyId"],
      ["packages", "surveyId"],
    ] as const) {
      const entries = root[key];
      if (Array.isArray(entries)) {
        const sanitized = dropDeniedFromArray(entries, field);
        if (sanitized.length !== entries.length) changed = true;
        root[key] = sanitized;
      }
    }
  }

  if (!changed) return null;
  return canonicalJsonBytes(root);
}

/**
 * Fail-closed guard used by builders, publisher and dynamic packaging.
 * Throws when a record, survey or layer belongs to a denied survey.
 */
export function assertRecordPublishable(record: PublicAssetRecord): void {
  if (isDeniedSurvey(record.surveyId)) {
    throw new Error(
      `Publication policy violation: record ${record.id} belongs to denied survey ${record.surveyId}`,
    );
  }
  const layerLike = /^layer-(.+)-(moc|query-order\d+|preview-order\d+|statistics|lock)$/.exec(
    record.id,
  );
  if (layerLike && isDeniedLayerId(layerLike[1]!)) {
    throw new Error(
      `Publication policy violation: record ${record.id} belongs to a denied survey layer`,
    );
  }
  if (isDeniedPathFragment(record.path)) {
    throw new Error(
      `Publication policy violation: record ${record.id} path ${record.path} references a denied survey`,
    );
  }
}
