import type { DownloadComponent, DownloadLayerEntry, DownloadPlan } from "./overlap-download.js";
import { csvCell } from "./overlap-download.js";

export interface DownloadAlternative {
  url: string;
  provider: string;
  status: string;
  country?: string;
}

/** One native-unit (or file) the user can download, with its single preferred link. */
export interface DownloadSummaryItem {
  survey: string;
  release: string;
  link: string;
  provider: string;
  alternatives: DownloadAlternative[];
}

export interface DownloadEntrypointOnly {
  survey: string;
  release: string;
  link: string;
}

export interface DownloadSummary {
  schemaVersion: 3;
  items: DownloadSummaryItem[];
  entrypointOnly: DownloadEntrypointOnly[];
}

export interface DownloadSummaryOptions {
  locale?: "zh" | "en";
  /** Provider name chosen by the user; falls back to the rule order when a unit has no such source. */
  preferredProvider?: string;
  /** Display names; ids are used when missing. */
  labels?: (surveyId: string, releaseId: string) => { survey?: string; release?: string };
}

const STATUS_RANK: Record<string, number> = { verified: 0, "source-listed": 1, "rule-derived": 2, "entrypoint-only": 3 };

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 2;
}

function regionRank(alternative: DownloadAlternative, locale: "zh" | "en"): number {
  if (locale !== "zh") return 0;
  if (alternative.country === "CN") return 0;
  return alternative.country === "US" ? 1 : 2;
}

/** Pure, deterministic: the best link for one unit. `unavailable` sources are never chosen. */
export function pickAlternative(alternatives: readonly DownloadAlternative[], options: DownloadSummaryOptions = {}): DownloadAlternative | undefined {
  const usable = alternatives.map((alternative, index) => ({ alternative, index })).filter(({ alternative }) => alternative.status !== "unavailable");
  if (!usable.length) return undefined;
  const locale = options.locale ?? "en";
  const preferred = options.preferredProvider;
  usable.sort((left, right) =>
    statusRank(left.alternative.status) - statusRank(right.alternative.status)
    || regionRank(left.alternative, locale) - regionRank(right.alternative, locale)
    || left.index - right.index);
  // An explicitly chosen provider wins over a better-verified one only if it is itself usable.
  if (preferred) {
    const chosen = usable.find(({ alternative }) => alternative.provider === preferred && statusRank(alternative.status) < 3);
    if (chosen) return chosen.alternative;
  }
  return usable[0]!.alternative;
}

/** Providers present in the given plans, for the "preferred source" selector. */
export function collectProviders(plans: readonly DownloadPlan[]): string[] {
  const names = new Set<string>();
  for (const plan of plans) {
    for (const unit of plan.spatialUnits ?? []) {
      for (const entry of unit.accessUris ?? []) for (const alternative of entry.alternatives ?? []) if (alternative.provider) names.add(alternative.provider);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function unitAlternatives(unit: NonNullable<DownloadPlan["spatialUnits"]>[number]): DownloadAlternative[][] {
  const entries = unit.accessUris?.length ? unit.accessUris
    : unit.accessUri ? [{ uri: unit.accessUri, alternatives: undefined }] : [];
  return entries.map((entry) => {
    const alternatives = entry.alternatives?.length ? entry.alternatives : [{ uri: entry.uri, provider: "Survey source", status: "source-listed" as const, providerCountryCode: undefined }];
    return alternatives.map((alternative) => ({
      url: alternative.uri, provider: alternative.provider, status: alternative.status, country: alternative.providerCountryCode,
    }));
  });
}

/**
 * Collapse the download plans of one or more overlap components into the minimal list a user needs:
 * survey, release and one link per native-unit. Layers with no file-level index are reported once as
 * "official entrypoint only" so the user is not told there is no data.
 */
export function buildDownloadSummary(
  entries: Array<{ component: DownloadComponent; plan: DownloadPlan }>,
  resolveLayer: (layerId: string | undefined) => DownloadLayerEntry & { sourceUrl?: string },
  options: DownloadSummaryOptions = {},
): DownloadSummary {
  const names = (surveyId: string, releaseId: string) => {
    const label = options.labels?.(surveyId, releaseId) ?? {};
    return { survey: label.survey || surveyId, release: label.release || releaseId };
  };
  const byLink = new Map<string, DownloadSummaryItem>();
  const indexedReleases = new Set<string>();
  const entrypointOnly = new Map<string, DownloadEntrypointOnly>();
  const addItem = (surveyId: string, releaseId: string, alternatives: DownloadAlternative[]): void => {
    const pick = pickAlternative(alternatives, options);
    if (!pick?.url) return;
    indexedReleases.add(`${surveyId}\n${releaseId}`);
    const existing = byLink.get(pick.url);
    if (existing) {
      for (const alternative of alternatives) if (!existing.alternatives.some((known) => known.url === alternative.url)) existing.alternatives.push(alternative);
      return;
    }
    byLink.set(pick.url, { ...names(surveyId, releaseId), link: pick.url, provider: pick.provider, alternatives: [...alternatives] });
  };

  for (const { component, plan } of entries) {
    for (const unit of plan.spatialUnits ?? []) {
      for (const alternatives of unitAlternatives(unit)) addItem(unit.surveyId, unit.releaseId, alternatives);
    }
    for (const file of plan.files) {
      const url = file.downloadUrl ?? file.sourceUri;
      if (!url) continue;
      const layer = resolveLayer(file.matchingCoverage[0]?.layerId);
      addItem(layer.surveyId, layer.releaseId, [{ url, provider: file.downloadProvider ?? "Survey source", status: file.downloadable ? "verified" : "source-listed" }]);
    }
    const layerIds = new Set<string>([...(component.requested?.layerIds ?? []), ...plan.entrypoints.flatMap((entry) => entry.layerId ? [entry.layerId] : [])]);
    for (const layerId of layerIds) {
      const layer = resolveLayer(layerId);
      const url = plan.entrypoints.find((entry) => entry.layerId === layerId && entry.kind === "official-release")?.url
        ?? plan.entrypoints.find((entry) => entry.layerId === layerId && entry.purpose === "data-access")?.url
        ?? layer.sourceUrl;
      if (!url || !layer.surveyId) continue;
      const key = `${layer.surveyId}\n${layer.releaseId}`;
      if (!entrypointOnly.has(key)) entrypointOnly.set(key, { ...names(layer.surveyId, layer.releaseId), link: url });
    }
  }

  const sort = <T extends { survey: string; release: string }>(rows: T[]) => rows.sort((left, right) => left.survey.localeCompare(right.survey) || left.release.localeCompare(right.release));
  return {
    schemaVersion: 3,
    items: sort([...byLink.values()]),
    entrypointOnly: sort([...entrypointOnly].filter(([key]) => !indexedReleases.has(key)).map(([, row]) => row)),
  };
}

const NOTE = {
  zh: "此天区可能有数据，本站暂无文件索引；标注“仅官方入口”的行只给出官方数据入口。",
  en: "This sky area may have data, but this site has no file index for it; rows marked “official entrypoint only” give the official data entry point.",
};
const HEADER = { zh: ["巡天", "DR", "链接"], en: ["survey", "release", "link"] };
const ENTRYPOINT_SUFFIX = { zh: "（仅官方入口）", en: " (official entrypoint only)" };

export function downloadSummaryCsv(summary: DownloadSummary, locale: "zh" | "en" = "en"): string {
  const rows = [
    ...summary.items.map((item) => [item.survey, item.release, item.link]),
    ...summary.entrypointOnly.map((item) => [item.survey, `${item.release}${ENTRYPOINT_SUFFIX[locale]}`, item.link]),
  ];
  const lines = rows.length ? [HEADER[locale], ...rows].map((row) => row.map(csvCell).join(",")) : [];
  if (summary.entrypointOnly.length) lines.unshift(`# ${NOTE[locale]}`);
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

export function downloadSummaryJson(summary: DownloadSummary, locale: "zh" | "en" = "en"): Record<string, unknown> {
  return {
    schemaVersion: 3,
    items: summary.items.map((item) => ({
      survey: item.survey, release: item.release, link: item.link,
      alternatives: item.alternatives.map((alternative) => alternative.url).filter((url) => url !== item.link),
    })),
    entrypointOnly: summary.entrypointOnly,
    ...(summary.entrypointOnly.length ? { note: NOTE[locale] } : {}),
  };
}
