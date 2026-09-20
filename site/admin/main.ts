import type { DiscoveryFailure } from "../../server/discovery-failure.js";
import { Activity, ArchiveX, ArrowLeft, ArrowRight, AudioLines, Box, Boxes, Cable, CalendarDays, ChartNoAxesCombined, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleDot, Cloud, ClipboardCheck, CloudCog, Database, Eye, FileCheck2, FileText, GitCompare, Globe2, Grid3X3, HardDrive, Image, Layers3, ListChecks, LoaderCircle, LockKeyhole, LogOut, Moon, PackageCheck, Pencil, PencilLine, Plug, PlugZap, Plus, RefreshCw, RotateCw, RotateCcw, Save, ScanLine, Search, Send, ShieldCheck, Table2, Unlock, Upload, X, Sun, createIcons } from "lucide";
import "./styles.css";
import { UploadCloud } from "lucide";
import { mountLocaleControls, t } from "../src/i18n.js";
import { reconcileMarkup } from "./stable-dom.js";
import { aggregateWorkAttempts } from "./work-items.js";
import { parseAdminRoute, routePath, type AdminStep } from "./navigation.js";
import { WorkspaceRequests, workspaceResources, businessSignature, type Resource } from "./workspaces.js";
import { capabilityNames, gapGuidance, discoveryProgress, discoveryObservationLabel, type DiscoveryObservation } from "./readiness-copy.js";
import { surveyPresentationImage, surveyPresentationAttribution } from "./presentation.js";
import { mountRecordTabs, mountTaskTabs } from "./task-tabs.js";

mountLocaleControls();
const taskTabs = mountTaskTabs(document.getElementById("admin-step-tasks")!);
const publicationTabs = mountRecordTabs(document.getElementById("admin-step-releases")!, "publication", ["plan", "runs"] as const, "assets-admin-publication-tab");

document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains("survey-card-image")) return;
  const placeholder = document.createElement("span");
  placeholder.className = "survey-card-image survey-card-placeholder";
  placeholder.textContent = image.alt.replace(/ 项目图片$/, "");
  image.replaceWith(placeholder);
}, true);

type ConnectorType = "s3" | "oss" | "local";
interface AdminConfig { enabled: boolean; authRequired: boolean; namespace: string; kubernetesConfigured: boolean; capabilities: { coverageModes: string[]; modalities?: string[]; connectorTypes: ConnectorType[]; backends: string[]; scanRequestApiVersion?: string } }
interface Connector { name: string; type: ConnectorType | string; endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyConfigured?: boolean; pvcName?: string; basePath?: string; localPath?: string; phase?: string; message?: string; checkedAt?: string; createdAt?: string; resourceKind?: "ConfigMap" | "AstroDataSource"; configurationPhase?: string; scope?: { kind?: string; pvcName?: string; basePath?: string; legacyPath?: string; endpoint?: string; region?: string; bucket?: string; prefix?: string }; inventory?: { state?: "unknown" | "running" | "complete" | "partial" | "failed"; denominatorKnown?: boolean; observedObjectCount?: number; totalObjectCount?: number; totalBytes?: number; processedObjects?: number; observedAt?: string; updatedAt?: string; source?: string; note?: string }; usage?: { scanTaskCount?: number; productCount?: number; latestTask?: { name?: string; phase?: string; createdAt?: string } } }
interface TaskStatus { phase: string; reason?: string; backend?: string; runId?: string; discoveredFiles?: number; processedHdus?: number; coverageDocuments?: number; objectDocuments?: number; errorCount?: number; availableOrders?: number[]; evidencePath?: string; sourceSnapshot?: { uri?: string; sha256: string; sizeBytes?: number }; startedAt?: string; completedAt?: string; message?: string }
interface Task { name: string; createdAt?: string; layerId?: string; surveyId?: string; releaseId?: string; product?: string; productId?: string; modality?: string; mode?: string; backend?: string; sourceConnector?: string; sourcePaths: string[]; tags: string[]; batchId?: string; workKey?: string; workTitle?: string; recipe?: { mode?: string; outputOrder?: number; catalog?: Record<string, unknown> }; status: TaskStatus }
interface ProductLifecycle {
  publication?: { state?: string; publishedAt?: string; publicationId?: string };
  runtime?: { state?: string; layerId?: string; catalogRevision?: string; availableOrders?: number[]; overviewOrder?: number; maxOrder?: number };
  links?: { product?: string; sky?: string; catalog?: string; moc?: string };
}
interface ProductHistoryEntry {
  action?: string;
  productId?: string;
  revision?: number;
  at?: string;
  reason?: string;
  acceptedGaps?: string[];
}
type ReadinessLevel = -1 | 0 | 1 | 2 | 3;
interface ProductReadiness {
  schemaVersion: 1;
  level: ReadinessLevel;
  label: "needs-information" | "source-registered" | "coverage-queryable" | "unit-reversible" | "file-locatable";
  geometry: { orders: number[]; maxOrder?: number; precision: string; basis: string; coordinateFrame?: string; ordering?: string };
  reverseLookup: { level: ReadinessLevel; orders: number[]; precision: string; unitKind?: string; basis: string };
  completeness: { state: "complete" | "partial" | "unknown"; processed?: number; total?: number; asOf?: string; scope?: string };
  evidence: { inputLocked: boolean; executionRecorded: boolean; outputValidated: boolean; isolatedRestoreValidated: boolean };
  gaps: string[];
}
interface ReadinessAggregate { productCount: number; levelCounts: { L0: number; L1: number; L2: number; L3: number; needsInformation: number }; capabilityCounts: { coverage: number; unit: number; file: number }; geometryOrders: number[]; reverseLookupOrders: number[]; geometryPrecision: string; reverseLookupPrecision: string; completeness: { complete: number; partial: number; unknown: number }; gapCount: number }
interface ReadinessVersions { draft: ProductReadiness; published: ProductReadiness | null }
interface AdminOverviewSurveyProduct { publicCoverage?:{published:boolean;orders:number[];retired:boolean}; productId: string; name: string; modality?: string; status?: string; readiness?: ReadinessVersions; review?: { state?: string; draftRevision?: number; publishedRevision?: number | null; updatedAt?: string; publishedAt?: string | null } }
interface AdminOverviewRelease { id: string; label: string; kind?: string; readiness?: { draft: ReadinessAggregate; published: ReadinessAggregate }; products: AdminOverviewSurveyProduct[] }
interface AdminOverviewSurvey { id: string; surveyId: string; name: string; mission: string; modalities: string[]; statistics?: Record<string, number>; readiness?: { draft: ReadinessAggregate; published: ReadinessAggregate }; releases: AdminOverviewRelease[] }
interface AdminOverview { schemaVersion: 1; generatedAt: string; coverage: CatalogStatus; totals: { surveys: number; releases: number; products: number; publishedProducts: number; retiredProducts?: number }; readiness: ReadinessAggregate; readinessVersions?: { draft: ReadinessAggregate; published: ReadinessAggregate }; surveys: AdminOverviewSurvey[]; connectors: Connector[]; workflows: { tasks: { total: number; phases: Record<string, number> }; discovery: { total: number; phases: Record<string, number> }; builds: { total: number; phases: Record<string, number> } }; syncStatus?: Record<string, unknown> }
interface MocBuildSummary { name: string; discoveryRequestName: string; candidateId: string; candidateTitle?: string; surveyId?: string; releaseId?: string; productId?: string; sourceUrl?: string; phase: string; progress?: { phase?: string; step?: number; totalSteps?: number; percent?: number; message?: string }; createdAt?: string; updatedAt?: string; outputs?: { cellCount?: number; availableOrders?: number[]; maxOrder?: number; query?: { order?: number }; preview?: { order?: number }; manifest?: { ref?: string; sha256?: string; sizeBytes?: number } }; error?: { reason?: string; message?: string }; publishedAt?: string; publicationId?: string; lifecycle?: ProductLifecycle }
interface Product { productId: string; draft: { productId: string; surveyId: string; releaseId: string; name: string; layerId?: string; modality?: string; mode?: string; coverageRole?: string; dataOrigin?: string; sourceTier?: string; originNote?: string; sourceLabel?: string; sourceUrl?: string; geometrySourceLabel?: string; geometrySourceUrl?: string; publicSurvey?: { name: string; mission: string; description: string; color: string; modalities: string[] }; publicRelease?: { label: string; kind: string; releasedYear?: number }; publicDescription?: string; publicStatus?: string; scanDefaults?: { allowedSuffixes?: string; maxOrder?: number; raColumn?: string; decColumn?: string; healpixColumn?: string; healpixOrderColumn?: string; healpixOrder?: number }; recipeVersion?: number; recipeHash?: string; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number }; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } }; published: unknown; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null; retiredAt?: string; retirementReason?: string; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number }; readiness?: ReadinessVersions; review?: { revision?: number; reviewedAt?: string; acceptedGaps?: string[] }; executionEvidence?: ExecutionEvidence[]; mocBuild?: MocBuildSummary; lifecycle?: ProductLifecycle }
interface ExecutionEvidence { executionId: string; revision: number; stepId: string; status: string; startedAt: string; finishedAt?: string; tool?: { name?: string; version?: string; imageDigest?: string }; inputs?: Array<{ label?: string; ref?: string; sha256?: string; sizeBytes?: number }>; parameters?: Record<string, string | number | boolean>; outputs?: Array<{ label?: string; ref?: string; sha256?: string; sizeBytes?: number }>; checks?: Array<{ id: string; status: string; detail?: string }>; error?: string }
interface RuntimeLayer { layerId: string; surveyId: string; releaseId: string; name: string; source: "release" | "warehouse" | "product-moc"; availableOrders: number[]; productId?: string; productState: string; productPublished: boolean }
interface CatalogStatus { mode: string; loadedAt: string; revision?: string; layers: number; footprints: number; warehouseConfigured: boolean; runtimeLayers?: RuntimeLayer[] }
interface MocCandidateSummary { candidateId: string; title?: string; recordUrl?: string; mocUrl?: string; hipsUrl?: string }
interface MocReviewSummary { schemaVersion: 2; truncated: boolean; summaryTruncated: boolean; searchRecordCount?: number; candidates: MocCandidateSummary[] }
type MocDiscoveryState = "running" | "ready" | "empty" | "incomplete" | "failed";
interface MocDiscoveryStatus { failure?: DiscoveryFailure; phase: string; jobName?: string; reason?: string; message?: string; evidencePath?: string; candidateCount?: number; lastTransitionTime?: string; reviewSummary?: MocReviewSummary; reviewSummaryState?: "available" | "missing"; discoveryState?: MocDiscoveryState }
interface MocDiscoveryRequest { name: string; observation?: DiscoveryObservation; namespace?: string; createdAt?: string; surveyName: string; releaseHint?: string; productHint?: string; surveyId?: string; releaseId?: string; productId?: string; policyRef: string; workKey?: string; workTitle?: string; status: MocDiscoveryStatus }
interface MocBuildProgress { phase: string; step: number; totalSteps: number; percent?: number; message?: string }
interface MocBuildRequest { schemaVersion: 1; kind: "MocBuildRequest"; name: string; discoveryRequestName: string; provider: string; candidateId: string; candidateTitle?: string; surveyId?: string; releaseId?: string; productId?: string; workKey?: string; workTitle?: string; createdAt: string; updatedAt: string; phase: string; progress: MocBuildProgress; source: { url: string; snapshotSha256?: string; sizeBytes?: number; evidenceRef?: string }; outputs?: { cellCount?: number; availableOrders?: number[]; maxOrder?: number; moc?: { ref: string; sha256: string; sizeBytes?: number }; query?: { ref: string; sha256?: string; order: number }; preview?: { ref: string; sha256?: string; order: number }; statistics?: { ref: string; sha256?: string; sizeBytes?: number }; manifest?: { ref: string; sha256?: string; sizeBytes?: number } }; error?: { reason: string; message: string }; duplicateOf?: string; publishedAt?: string; publicationId?: string; lifecycle?: ProductLifecycle }
interface MocRegistrationDefaults { releaseId: string; releaseLabel: string; releaseKind: string; productName: string; productDescription: string; productStatus: string; modality: string; dataOrigin: string }
interface ReviewProduct { publicCoverage?: {published:boolean;orders:number[];retired:boolean}; productId: string; name: string; canonicalName?: string; modality?: string; description: string; status: string; sourceUrl?: string; dataOrigin?: string; sourceTier?: string; originNote?: string; sourceLabel?: string; geometrySourceUrl?: string; geometrySourceLabel?: string; reason?: string; manualStep?: string; retiredAt?: string; retirementReason?: string; coverage?: { availableOrders?: number[]; overviewOrder?: number; maxOrder?: number; layerId?: string; areaDeg2?: number }; readiness?: ReadinessVersions; mocBuild?: MocBuildSummary; lifecycle?: ProductLifecycle; review?: { state: string; draftRevision?: number; publishedRevision?: number | null; reviewedRevision?: number; reviewedAt?: string; acceptedGaps?: string[]; updatedAt?: string; publishedAt?: string | null } }
interface ReviewRelease { id: string; label: string; kind: string; releasedYear?: number; modalities: string[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; readiness?: { draft: ReadinessAggregate; published: ReadinessAggregate }; products: ReviewProduct[] }
interface ReviewMocBuild { name: string; discoveryRequestName: string; candidateId: string; candidateTitle?: string; surveyId?: string; releaseId?: string; sourceUrl?: string; phase: string; progress?: { percent?: number; message?: string }; createdAt?: string; updatedAt?: string; outputs?: { cellCount?: number; availableOrders?: number[]; maxOrder?: number }; lifecycle?: ProductLifecycle }
interface ReviewSurvey { id: string; surveyId: string; name: string; mission: string; color: string; description: string; modalities: string[]; imageUrl: string; statistics: Record<string, number>; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; readiness?: { draft: ReadinessAggregate; published: ReadinessAggregate }; releases: ReviewRelease[]; unmatchedProducts?: Array<Record<string, unknown>>; unmatchedBuilds?: ReviewMocBuild[] }

interface EditorialProduct {
  productId: string;
  releaseId: string;
  canonicalName: string;
  name: string;
  description: string;
  reason?: string;
  manualStep?: string;
  modality?: string;
  status?: string;
  coverage?: ReviewProduct["coverage"];
}
interface EditorialRelease {
  id: string;
  label: string;
  kind?: string;
  releasedYear?: number;
  modalities?: string[];
  coverageOrders?: ReviewRelease["coverageOrders"];
  products: EditorialProduct[];
}
interface EditorialSnapshot {
  survey: { id: string; name: string; mission: string; description: string; color?: string; modalities?: string[]; imageUrl?: string; statistics?: Record<string, number>; coverageOrders?: ReviewSurvey["coverageOrders"] };
  releases: EditorialRelease[];
}
interface EditorialDocument {
  surveyId: string;
  revision: number;
  draft: EditorialSnapshot;
  published: EditorialSnapshot | null;
}

const tokenKey = "astro-survey-atlas-assets.admin-token";
let adminConfig: AdminConfig | null = null;
let token = sessionStorage.getItem(tokenKey) ?? "";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

function renderIcons(): void {
  document.querySelectorAll<HTMLElement>("i[data-lucide]").forEach(icon => icon.setAttribute("data-icon-pending", icon.dataset.lucide!));
  createIcons({ nameAttr: "data-icon-pending", icons: { Download, Package, Activity, ArchiveX, ArrowLeft, ArrowRight, AudioLines, Box, Boxes, Cable, CalendarDays, ChartNoAxesCombined, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleDot, Cloud, ClipboardCheck, CloudCog, Database, Eye, FileCheck2, FileText, GitCompare, Globe2, Grid3x3: Grid3X3, HardDrive, Image, Layers3, ListChecks, LoaderCircle, LockKeyhole, LogOut, Moon, PackageCheck, Pencil, PencilLine, Plug, PlugZap, Plus, RefreshCw, RotateCw, RotateCcw, Save, ScanLine, Search, Send, ShieldCheck, Sun, Table2, Unlock, Upload, UploadCloud, X }, attrs: { "aria-hidden": "true" } });
  document.querySelectorAll("[data-icon-pending]").forEach(icon => icon.removeAttribute("data-icon-pending"));
}

type AdminTheme = "light" | "dark";
const adminThemeKey = "asa-theme";

function adminSystemTheme(): AdminTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedAdminTheme(): AdminTheme | null {
  try {
    const value = window.localStorage.getItem(adminThemeKey);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}

function applyAdminTheme(theme: AdminTheme, persist = false): void {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try { window.localStorage.setItem(adminThemeKey, theme); } catch { /* private browsing */ }
  }
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.replaceChildren();
    const icon = document.createElement("i");
    icon.dataset.lucide = theme === "dark" ? "sun" : "moon";
    toggle.append(icon);
    toggle.setAttribute("aria-label", theme === "dark" ? "切换到亮色模式" : "切换到暗色模式");
    toggle.title = theme === "dark" ? "亮色模式" : "暗色模式";
  }
  renderIcons();
}

function cloneEditorial<T>(value: T): T {
  return structuredClone(value);
}

function editorialObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function editorialText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function editorialSnapshotFromReview(survey: ReviewSurvey): EditorialSnapshot {
  return {
    survey: {
      id: survey.id || survey.surveyId,
      name: survey.name,
      mission: survey.mission,
      description: survey.description,
      color: survey.color,
      modalities: [...survey.modalities],
      imageUrl: survey.imageUrl,
      statistics: { ...survey.statistics },
      coverageOrders: survey.coverageOrders ? cloneEditorial(survey.coverageOrders) : undefined,
    },
    releases: survey.releases.map((release) => ({
      id: release.id,
      label: release.label,
      kind: release.kind,
      releasedYear: release.releasedYear,
      modalities: [...release.modalities],
      coverageOrders: release.coverageOrders ? cloneEditorial(release.coverageOrders) : undefined,
      products: release.products.map((product) => ({
        productId: product.productId,
        releaseId: release.id,
        canonicalName: product.canonicalName ?? product.name,
        name: product.name,
        description: product.description,
        reason: product.reason,
        manualStep: product.manualStep,
        modality: product.modality,
        status: product.status,
        coverage: product.coverage ? cloneEditorial(product.coverage) : undefined,
      })),
    })),
  };
}

function normalizeEditorialSnapshot(value: unknown, fallback: EditorialSnapshot): EditorialSnapshot {
  const raw = editorialObject(value);
  if (!raw) return cloneEditorial(fallback);
  const rawSurvey = editorialObject(raw.survey) ?? editorialObject(raw.publicSurvey) ?? raw;
  const survey = {
    ...fallback.survey,
    id: editorialText(rawSurvey?.id, fallback.survey.id),
    name: editorialText(rawSurvey?.name, fallback.survey.name),
    mission: editorialText(rawSurvey?.mission, fallback.survey.mission),
    description: editorialText(rawSurvey?.description, fallback.survey.description),
    ...(typeof rawSurvey?.color === "string" ? { color: rawSurvey.color } : {}),
    ...(Array.isArray(rawSurvey?.modalities) ? { modalities: rawSurvey.modalities.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(typeof rawSurvey?.imageUrl === "string" ? { imageUrl: rawSurvey.imageUrl } : {}),
    ...(editorialObject(rawSurvey?.statistics) ? { statistics: rawSurvey.statistics as Record<string, number> } : {}),
    ...(editorialObject(rawSurvey?.coverageOrders) ? { coverageOrders: rawSurvey.coverageOrders as ReviewSurvey["coverageOrders"] } : {}),
  };
  const fallbackReleases = new Map(fallback.releases.map((release) => [release.id, release]));
  const rawReleases = Array.isArray(raw.releases) ? raw.releases : fallback.releases;
  const releases = rawReleases.map((releaseValue, releaseIndex) => {
    const rawRelease = editorialObject(releaseValue) ?? {};
    const fallbackRelease = fallbackReleases.get(editorialText(rawRelease.releaseId ?? rawRelease.id)) ?? fallback.releases[releaseIndex];
    if (!fallbackRelease) return null;
    const fallbackProducts = new Map(fallbackRelease.products.map((product) => [product.productId, product]));
    const rawProducts = Array.isArray(rawRelease.products) ? rawRelease.products : fallbackRelease.products;
    const products = rawProducts.map((productValue, productIndex) => {
      const rawProduct = editorialObject(productValue) ?? {};
      const fallbackProduct = fallbackProducts.get(editorialText(rawProduct.productId)) ?? fallbackRelease.products[productIndex];
      if (!fallbackProduct) return null;
      return {
        ...fallbackProduct,
        productId: fallbackProduct.productId,
        name: editorialText(rawProduct.displayName ?? rawProduct.name, fallbackProduct.name),
        releaseId: fallbackRelease.id,
        canonicalName: editorialText(rawProduct.canonicalName, fallbackProduct.canonicalName ?? fallbackProduct.name),
        description: editorialText(rawProduct.description, fallbackProduct.description),
        ...(rawProduct.reason === null || typeof rawProduct.reason === "string" ? { reason: editorialText(rawProduct.reason) || undefined } : {}),
        ...(rawProduct.manualStep === null || typeof rawProduct.manualStep === "string" ? { manualStep: editorialText(rawProduct.manualStep) || undefined } : {}),
      };
    }).filter((product): product is EditorialProduct => Boolean(product));
    return {
      ...fallbackRelease,
      id: fallbackRelease.id,
      label: editorialText(rawRelease.label, fallbackRelease.label),
      products,
    };
  }).filter((release): release is EditorialRelease => Boolean(release));
  return { survey, releases };
}

function normalizeEditorialDocument(value: unknown, survey: ReviewSurvey, current?: EditorialDocument): EditorialDocument {
  const fallback = editorialSnapshotFromReview(survey);
  const outer = editorialObject(value);
  const raw = editorialObject(outer?.editorial) ?? editorialObject(outer?.document) ?? outer ?? {};
  const draftValue = raw.draft ?? raw.content ?? raw.snapshot ?? raw;
  const publishedValue = raw.published;
  const revision = typeof raw.revision === "number" && Number.isSafeInteger(raw.revision)
    ? raw.revision
    : current?.revision ?? 1;
  return {
    surveyId: editorialText(raw.surveyId, survey.surveyId || survey.id),
    revision,
    draft: normalizeEditorialSnapshot(draftValue, current?.draft ?? fallback),
    published: publishedValue === null || publishedValue === undefined
      ? current?.published ?? null
      : normalizeEditorialSnapshot(publishedValue, current?.published ?? fallback),
  };
}

function editorialApiContent(snapshot: EditorialSnapshot): Record<string, unknown> {
  return {
    surveyId: snapshot.survey.id,
    name: snapshot.survey.name,
    mission: snapshot.survey.mission,
    description: snapshot.survey.description,
    releases: snapshot.releases.map((release) => ({
      releaseId: release.id,
      label: release.label,
      products: release.products.map((product) => ({
        productId: product.productId,
        releaseId: release.id,
        canonicalName: product.canonicalName ?? product.name,
        displayName: product.name,
        description: product.description,
        reason: product.reason ?? "",
        manualStep: product.manualStep ?? "",
      })),
    })),
  };
}

function editorialFieldValue(snapshot: EditorialSnapshot, path: string): string {
  const match = /^(survey\.(?:name|mission|description)|releases\.(\d+)\.label|releases\.(\d+)\.products\.(\d+)\.(name|description|reason|manualStep))$/.exec(path);
  if (!match) return "";
  if (match[1]?.startsWith("survey.")) return snapshot.survey[match[1].slice("survey.".length) as "name" | "mission" | "description"];
  const releaseIndex = Number(match[2] ?? match[3]);
  const release = snapshot.releases[releaseIndex];
  if (!release) return "";
  if (match[2] !== undefined) return release.label;
  const product = release.products[Number(match[4])];
  if (!product) return "";
  return editorialText(product[match[5] as "name" | "description" | "reason" | "manualStep"]);
}

function setEditorialFieldValue(snapshot: EditorialSnapshot, path: string, value: string): void {
  const match = /^(survey\.(?:name|mission|description)|releases\.(\d+)\.label|releases\.(\d+)\.products\.(\d+)\.(name|description|reason|manualStep))$/.exec(path);
  if (!match) return;
  if (match[1]?.startsWith("survey.")) {
    snapshot.survey[match[1].slice("survey.".length) as "name" | "mission" | "description"] = value;
    return;
  }
  const releaseIndex = Number(match[2] ?? match[3]);
  const release = snapshot.releases[releaseIndex];
  if (!release) return;
  if (match[2] !== undefined) {
    release.label = value;
    return;
  }
  const product = release.products[Number(match[4])];
  if (!product) return;
  const key = match[5] as "name" | "description" | "reason" | "manualStep";
  if (key === "name" || key === "description") product[key] = value;
  else product[key] = value || undefined;
}

interface EditorialFieldDescriptor { path: string; label: string; value: string; multiline?: boolean; placeholder?: string }

function editorialFieldDescriptors(snapshot: EditorialSnapshot): EditorialFieldDescriptor[] {
  const fields: EditorialFieldDescriptor[] = [
    { path: "survey.name", label: "Survey name", value: snapshot.survey.name },
    { path: "survey.mission", label: "Mission", value: snapshot.survey.mission },
    { path: "survey.description", label: "Survey description", value: snapshot.survey.description, multiline: true },
  ];
  snapshot.releases.forEach((release, releaseIndex) => {
    fields.push({ path: `releases.${releaseIndex}.label`, label: `${release.id} / Release label`, value: release.label });
    release.products.forEach((product, productIndex) => {
      fields.push(
        { path: `releases.${releaseIndex}.products.${productIndex}.name`, label: `${product.productId} / Product name`, value: product.name },
        { path: `releases.${releaseIndex}.products.${productIndex}.description`, label: `${product.productId} / Product description`, value: product.description, multiline: true },
        ...(product.reason !== undefined ? [{ path: `releases.${releaseIndex}.products.${productIndex}.reason`, label: `${product.productId} / Status reason`, value: product.reason, multiline: true, placeholder: "Add a public status note" }] : []),
        ...(product.manualStep !== undefined ? [{ path: `releases.${releaseIndex}.products.${productIndex}.manualStep`, label: `${product.productId} / Next step`, value: product.manualStep, multiline: true, placeholder: "Add the next public action" }] : []),
      );
    });
  });
  return fields;
}

function editorialEditable(field: EditorialFieldDescriptor): string {
  const value = field.value.trim();
  const placeholder = field.placeholder ?? "Click to edit";
  return `<button type="button" class="editorial-editable${field.multiline ? " editorial-editable-multiline" : ""}${value ? "" : " is-empty"}" data-editorial-field="${escapeText(field.path)}" data-editorial-multiline="${field.multiline ? "true" : "false"}" aria-label="编辑 ${escapeText(field.label)}"><span>${escapeText(value || placeholder)}</span><i data-lucide="pencil-line"></i></button>`;
}

function editorialReadOnly(label: string, value: unknown, icon = "lock-keyhole"): string {
  return `<span class="editorial-readonly"><i data-lucide="${icon}"></i><span><small>${escapeText(label)}</small><strong>${escapeText(value ?? "--")}</strong></span></span>`;
}

function editorialStatMarkup(statistics: Record<string, number> | undefined): string {
  const entries = Object.entries(statistics ?? {}).filter(([, value]) => typeof value === "number").slice(0, 4);
  return entries.length
    ? entries.map(([key, value]) => `<span class="editorial-stat"><i data-lucide="${key.toLowerCase().includes("cell") ? "grid-3x3" : key.toLowerCase().includes("product") ? "package-check" : "chart-no-axes-combined"}"></i><span>${escapeText(key.replace(/([A-Z])/g, " $1"))}</span><strong>${value.toLocaleString()}</strong></span>`).join("")
    : `<span class="editorial-stat"><i data-lucide="chart-no-axes-combined"></i><span>Statistics</span><strong>--</strong></span>`;
}

function surveyColorAttribute(value: unknown): string {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^#[0-9a-f]{6}$/.test(color) ? ` data-survey-color="${escapeText(color)}"` : "";
}

function editorialDiffFields(): Array<{ label: string; before: string; after: string }> {
  if (!activeEditorial) return [];
  // `baseline` tracks the last saved draft so the Save button can clear its
  // dirty state. Publishing must compare against the last published copy,
  // which remains unchanged after saving a draft.
  const baseline = activeEditorial.publishedBaseline;
  return editorialFieldDescriptors(activeEditorial.document.draft).flatMap((field) => {
    const before = editorialFieldValue(baseline, field.path);
    return before === field.value ? [] : [{ label: field.label, before: before || "(empty)", after: field.value || "(empty)" }];
  });
}

function updateEditorialStatus(): void {
  const state = activeEditorial;
  const dirty = Boolean(state && JSON.stringify(state.document.draft) !== JSON.stringify(state.baseline));
  const indicator = byId("editorial-dirty-indicator");
  indicator.dataset.dirty = String(dirty);
  indicator.innerHTML = `<i data-lucide="${dirty ? "circle-alert" : "circle-check"}"></i><span>${dirty ? "有未保存修改" : "无未保存修改"}</span>`;
  byId<HTMLButtonElement>("editorial-discard-button").disabled = !dirty;
  byId<HTMLButtonElement>("editorial-save-button").disabled = !dirty;
  byId<HTMLButtonElement>("editorial-diff-button").disabled = !Boolean(state && editorialDiffFields().length);
  byId<HTMLButtonElement>("editorial-publish-button").disabled = !state;
  renderIcons();
}

function renderEditorialCanvas(): void {
  if (!activeEditorial) return;
  const canvas = byId("editorial-canvas");
  const snapshot = activeEditorial.document.draft;
  const surveyColor = surveyColorAttribute(snapshot.survey.color);
  const surveyFields = new Map(editorialFieldDescriptors(snapshot).map((field) => [field.path, field]));
  const image = snapshot.survey.imageUrl ? `<img class="editorial-survey-image" src="${escapeText(snapshot.survey.imageUrl)}" alt="" loading="lazy" />` : "";
  const releases = snapshot.releases.map((release, releaseIndex) => {
    const releaseField = surveyFields.get(`releases.${releaseIndex}.label`)!;
    const products = release.products.map((product, productIndex) => {
      const prefix = `releases.${releaseIndex}.products.${productIndex}`;
      const nameField = surveyFields.get(`${prefix}.name`)!;
      const descriptionField = surveyFields.get(`${prefix}.description`)!;
      const reasonField = surveyFields.get(`${prefix}.reason`);
      const manualStepField = surveyFields.get(`${prefix}.manualStep`);
      const orders = product.coverage?.availableOrders?.map((order) => `O${order}`).join(" / ") || "orders unavailable";
      return `<article class="editorial-product-row"><div class="editorial-product-copy"><div class="editorial-product-title"><span class="modality-icon"><i data-lucide="${modalityIcon(product.modality)}"></i></span>${editorialEditable(nameField)}</div><div class="editorial-product-facts">${editorialReadOnly("MODALITY", product.modality ?? "unknown", modalityIcon(product.modality))}${editorialReadOnly("STATUS", product.status ?? "unknown", "circle-check")}${editorialReadOnly("COVERAGE", orders, "grid-3x3")}${editorialReadOnly("PRODUCT ID", product.productId)}</div><div class="editorial-copy-field"><small>PUBLIC DESCRIPTION</small>${editorialEditable(descriptionField)}</div>${reasonField ? `<div class="editorial-copy-field"><small>STATUS REASON</small>${editorialEditable(reasonField)}</div>` : ""}${manualStepField ? `<div class="editorial-copy-field"><small>NEXT STEP</small>${editorialEditable(manualStepField)}</div>` : ""}</div><div class="editorial-product-locks">${editorialReadOnly("LAYER / RECIPE", `${product.coverage?.layerId ?? "--"} · locked`, "lock-keyhole")}</div></article>`;
    }).join("");
    return `<section class="editorial-release"><header class="editorial-release-header"><div><span class="section-index">RELEASE</span>${editorialEditable(releaseField)}</div><div class="editorial-release-locks">${editorialReadOnly("RELEASE ID", release.id)}${editorialReadOnly("KIND", release.kind ?? "--")}${editorialReadOnly("YEAR", release.releasedYear ?? "--", "calendar-days")}</div></header><div class="editorial-product-list">${products || `<p class="resource-empty">该 Release 没有产品</p>`}</div></section>`;
  }).join("");
  canvas.innerHTML = `<div class="editorial-preview-kicker"><span><i data-lucide="eye"></i> PUBLIC SURVEY DIRECTORY PREVIEW</span><span><i data-lucide="lock-keyhole"></i> IDs / data facts locked</span></div><article class="editorial-survey-preview"${surveyColor}><header class="editorial-survey-header"><span class="editorial-survey-swatch"${surveyColor} aria-hidden="true"></span><div class="editorial-survey-heading"><div class="editorial-edit-label">SURVEY NAME</div>${editorialEditable(surveyFields.get("survey.name")!)}<div class="editorial-edit-label">MISSION</div>${editorialEditable(surveyFields.get("survey.mission")!)}</div>${image}</header><div class="editorial-survey-description"><div class="editorial-edit-label">PUBLIC DESCRIPTION</div>${editorialEditable(surveyFields.get("survey.description")!)}</div><div class="editorial-survey-readonly"><div class="editorial-stat-strip">${editorialStatMarkup(snapshot.survey.statistics)}</div>${editorialReadOnly("SURVEY ID", snapshot.survey.id)}${editorialReadOnly("MODALITIES", (snapshot.survey.modalities ?? []).join(" · "), "layers-3")}</div></article><div class="editorial-releases-heading"><span class="section-index">SURVEY → RELEASE → PRODUCT</span><span>${snapshot.releases.length} release${snapshot.releases.length === 1 ? "" : "s"}</span></div>${releases}`;
  canvas.hidden = false;
  canvas.querySelectorAll<HTMLButtonElement>("[data-editorial-field]").forEach((button) => button.addEventListener("click", () => startEditorialInlineEdit(button)));
  renderIcons();
  updateEditorialStatus();
}

function startEditorialInlineEdit(button: HTMLButtonElement): void {
  if (!activeEditorial) return;
  const path = button.dataset.editorialField;
  if (!path) return;
  const multiline = button.dataset.editorialMultiline === "true";
  const input = document.createElement(multiline ? "textarea" : "input");
  input.className = "editorial-inline-input";
  input.value = editorialFieldValue(activeEditorial.document.draft, path);
  input.setAttribute("aria-label", button.getAttribute("aria-label") ?? "Edit catalog text");
  if (multiline && input instanceof HTMLTextAreaElement) { input.rows = 3; input.maxLength = 12000; }
  else { input.maxLength = 2000; }
  button.replaceWith(input);
  let finished = false;
  const finish = (cancel = false): void => {
    if (finished) return;
    finished = true;
    if (!cancel) setEditorialFieldValue(activeEditorial!.document.draft, path, input.value.trim());
    renderEditorialCanvas();
  };
  input.addEventListener("blur", () => finish());
  input.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Escape") { keyboardEvent.preventDefault(); finish(true); }
    if (keyboardEvent.key === "Enter" && (!multiline || keyboardEvent.metaKey || keyboardEvent.ctrlKey)) { keyboardEvent.preventDefault(); finish(); }
  });
  input.focus();
  input.select();
}

let activeEditorial: { survey: ReviewSurvey; document: EditorialDocument; baseline: EditorialSnapshot; publishedBaseline: EditorialSnapshot } | null = null;
let editorialOpenRequest = 0;
let editorialPublishPending = false;

function setEditorialLoading(loading: boolean): void {
  byId("editorial-loading").hidden = !loading;
  byId("editorial-canvas").hidden = loading;
  byId("editorial-error").hidden = true;
  byId<HTMLButtonElement>("editorial-save-button").disabled = loading;
  byId<HTMLButtonElement>("editorial-publish-button").disabled = loading;
  if (loading) renderIcons();
}

async function openEditorial(surveyId: string): Promise<void> {
  const survey = reviewSurveyRecords.find((entry) => entry.id === surveyId || entry.surveyId === surveyId);
  if (!survey || survey.id.startsWith("__")) return;
  const dialog = byId<HTMLDialogElement>("editorial-dialog");
  activeEditorial = null;
  const requestId = ++editorialOpenRequest;
  byId("editorial-title").textContent = `${survey.name} · 编辑目录`;
  byId("editorial-subtitle").textContent = "所见即所得预览 · 仅修改公开文案，系统事实保持锁定";
  setEditorialLoading(true);
  if (!dialog.open) dialog.showModal();
  try {
    const response = await api<unknown>(`/api/v1/admin/catalog/surveys/${encodeURIComponent(survey.surveyId || survey.id)}/editorial`);
    if (requestId !== editorialOpenRequest) return;
    const document = normalizeEditorialDocument(response, survey);
    activeEditorial = { survey, document, baseline: cloneEditorial(document.draft), publishedBaseline: cloneEditorial(document.published ?? document.draft) };
    renderEditorialCanvas();
    setEditorialLoading(false);
    updateEditorialStatus();
  } catch (error) {
    if (requestId !== editorialOpenRequest) return;
    setEditorialLoading(false);
    const errorElement = byId("editorial-error");
    errorElement.textContent = error instanceof Error ? error.message : "目录草稿加载失败";
    errorElement.hidden = false;
    byId("editorial-canvas").hidden = true;
    updateEditorialStatus();
  }
}

function renderEditorialDiff(forPublish: boolean): void {
  const changes = editorialDiffFields();
  byId("editorial-diff-title").textContent = forPublish ? "提交文案确认" : "字段变更";
  byId("editorial-diff-content").innerHTML = changes.length
    ? `<p class="editorial-diff-summary">${forPublish ? "以下文案将写入产品工作版本并使旧审核失效。重新审核、完整发布后才会对外显示。" : `${changes.length} 个公开字段已变化。`}</p><div class="editorial-diff-list">${changes.map((change) => `<article class="editorial-diff-row"><strong>${escapeText(change.label)}</strong><div><span class="editorial-diff-before">${escapeText(change.before)}</span><i data-lucide="arrow-right"></i><span class="editorial-diff-after">${escapeText(change.after)}</span></div></article>`).join("")}</div>`
    : `<div class="resource-empty">当前没有待发布的文案变化。</div>`;
  const confirm = byId<HTMLButtonElement>("editorial-diff-confirm");
  confirm.hidden = !forPublish;
  confirm.disabled = !changes.length;
  confirm.value = forPublish ? "confirm" : "cancel";
  renderIcons();
}

function openEditorialDiff(forPublish: boolean): void {
  if (!activeEditorial) return;
  renderEditorialDiff(forPublish);
  byId<HTMLDialogElement>("editorial-diff-dialog").showModal();
}

async function saveEditorialDraft(silent = false): Promise<boolean> {
  if (!activeEditorial) return false;
  const state = activeEditorial;
  const saveButton = byId<HTMLButtonElement>("editorial-save-button");
  saveButton.disabled = true;
  try {
    const response = await api<unknown>(`/api/v1/admin/catalog/surveys/${encodeURIComponent(state.document.surveyId)}/editorial/draft`, { method: "PUT", body: JSON.stringify({ revision: state.document.revision, content: editorialApiContent(state.document.draft) }) });
    state.document = normalizeEditorialDocument(response, state.survey, state.document);
    state.baseline = cloneEditorial(state.document.draft);
    renderEditorialCanvas();
    if (!silent) toast("目录文案草稿已保存");
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "目录草稿保存失败", true);
    updateEditorialStatus();
    return false;
  }
}

async function publishEditorial(): Promise<void> {
  if (!activeEditorial || editorialPublishPending) return;
  editorialPublishPending = true;
  const state = activeEditorial;
  try {
    if (JSON.stringify(state.document.draft) !== JSON.stringify(state.baseline) && !(await saveEditorialDraft(true))) return;
    const response = await api<unknown>(`/api/v1/admin/catalog/surveys/${encodeURIComponent(state.document.surveyId)}/editorial/publish`, { method: "POST", body: JSON.stringify({ revision: state.document.revision }) });
    state.document = normalizeEditorialDocument(response, state.survey, state.document);
    state.baseline = cloneEditorial(state.document.draft);
    state.document.published = cloneEditorial(state.document.draft);
    state.publishedBaseline = cloneEditorial(state.document.draft);
    renderEditorialCanvas();
    toast("文案已提交到产品工作版本，请重新审核后完整发布");
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : "目录文案发布失败", true);
  } finally {
    editorialPublishPending = false;
    updateEditorialStatus();
  }
}

function discardEditorialChanges(): void {
  if (!activeEditorial) return;
  activeEditorial.document.draft = cloneEditorial(activeEditorial.baseline);
  renderEditorialCanvas();
  toast("未保存的目录修改已撤销");
}

let activeStep: AdminStep = "overview";
function setAdminStep(step: AdminStep, replace = false): void {
  const changed = activeStep !== step;
  activeStep = step;
  if (changed || replace) {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    workspaceRequests.cancel(); refreshVersion++; refreshInFlight = null;
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach(dialog => dialog.close());
  }
  document.querySelectorAll<HTMLElement>("[data-admin-panel]").forEach(panel => { panel.hidden = panel.dataset.adminPanel !== step; });
  document.querySelectorAll<HTMLButtonElement>("[data-admin-step]").forEach(button => {
    const selected = button.dataset.adminStep === step;
    button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  const incoming = parseAdminRoute(location.pathname, location.hash);
  const destination = replace && incoming?.step === step ? routePath(incoming) : routePath({ step });
  if (replace) history.replaceState(null, "", destination);
  else if (location.pathname !== destination) history.pushState(null, "", destination);
  if (step === "overview") {
    overviewSurveyId = parseAdminRoute(location.pathname)?.surveyId ?? "";
    if (overviewRecord) renderOverview(overviewRecord);
  }
  if (token && !byId("admin-workspace").hidden) void refresh();
}
function readAdminStep(): AdminStep { return parseAdminRoute(location.pathname, location.hash)?.step ?? "overview"; }

function modalityIcon(modality?: string): string {
  const value = modality?.toLowerCase();
  if (value === "image" || value === "imaging") return "image";
  if (value === "spectrum" || value === "spectroscopy") return "audio-lines";
  if (value === "catalog" || value === "photometry") return "table-2";
  if (value === "cube" || value === "integral-field") return "box";
  if (value === "timeseries" || value === "time-domain") return "activity";
  return "layers-3";
}

function modalityLabel(modality?: string): string {
  return ({ image: "成像", imaging: "成像", spectrum: "光谱", spectroscopy: "光谱", catalog: "星表", photometry: "测光", cube: "数据立方", "integral-field": "积分视场", timeseries: "时序", "time-domain": "时域", infrared: "红外", ultraviolet: "紫外", simulation: "仿真" } as Record<string, string>)[modality?.toLowerCase() ?? ""] ?? (modality || "模态未知");
}

function modalityMarkup(modality?: string, count?: number): string {
  return `<span class="product-modality" title="${escapeText(modality ?? "unknown")}"><i data-lucide="${modalityIcon(modality)}"></i><span>${escapeText(modalityLabel(modality))}</span>${count === undefined ? "" : `<strong>${count}</strong>`}</span>`;
}

function escapeText(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function toast(message: string, error = false): void {
  const element = byId("admin-toast");
  element.textContent = message;
  element.dataset.error = error ? "true" : "false";
  element.dataset.visible = "true";
  window.setTimeout(() => { element.dataset.visible = "false"; }, 2400);
}

function setMessage(kind: "connector" | "task" | "product" | "moc-discovery" | "moc-review" | "moc-registration", message: string, error = false): void {
  const element = document.querySelector<HTMLElement>(`[data-form-message="${kind}"]`);
  if (!element) return;
  element.textContent = message;
  element.dataset.error = error ? "true" : "false";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    if (response.status === 401) showLogin("管理员令牌无效");
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  return body;
}

function showLogin(message = ""): void {
  byId("login-panel").hidden = false;
  byId("admin-workspace").hidden = true;
  const error = byId("login-error");
  error.textContent = message;
  error.hidden = !message;
}

function showWorkspace(): void {
  byId("login-panel").hidden = true;
  byId("admin-workspace").hidden = false;
  setAdminStep(readAdminStep(), true);
}

function formatDate(value?: string): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function connectorLabel(connector: Connector): string {
  const configuration = connector.configurationPhase ? ` · config ${connector.configurationPhase}` : "";
  return `${connector.name} · ${connector.type.toUpperCase()} · ${connector.phase ?? "NOT_CHECKED"}${configuration}`;
}

function connectorIcon(type?: string): string {
  const normalized = String(type ?? "").toLowerCase();
  if (normalized === "s3" || normalized === "oss") return "cloud";
  if (normalized === "local" || normalized === "pvc" || normalized === "filesystem" || normalized === "file-system") return "hard-drive";
  if (normalized === "jdbc" || normalized === "database" || normalized === "postgres" || normalized === "mysql") return "database";
  return "plug";
}

function connectorTypeLabel(type?: string): string {
  const normalized = String(type ?? "").toLowerCase();
  if (normalized === "s3") return "S3 OBJECT STORAGE";
  if (normalized === "oss") return "OSS OBJECT STORAGE";
  if (normalized === "local" || normalized === "pvc" || normalized === "filesystem" || normalized === "file-system") return "LOCAL / PVC FILESYSTEM";
  if (normalized === "jdbc" || normalized === "database" || normalized === "postgres" || normalized === "mysql") return "JDBC DATABASE";
  return normalized ? normalized.toUpperCase() : "CONNECTOR";
}

function connectorLocation(connector: Connector): string {
  if (connector.type === "local") {
    if (connector.pvcName) return `PVC ${connector.pvcName}${connector.basePath ? ` · base ${connector.basePath}` : " · PVC root"}`;
    return connector.localPath ? `LEGACY ${connector.localPath}` : "受管本地存储";
  }
  return `${connector.endpoint ?? ""}${connector.region ? ` · ${connector.region}` : ""}${connector.bucket ? ` · ${connector.bucket}` : ""}${connector.prefix ? ` / ${connector.prefix}` : ""}`;
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "未知";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = "B";
  for (const candidate of units) {
    size /= 1024;
    unit = candidate;
    if (size < 1024) break;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function connectorInventoryMarkup(connector: Connector, compact = false): string {
  const inventory = connector.inventory;
  const state = inventory?.state ?? "unknown";
  const objectCount = inventory?.totalObjectCount ?? inventory?.observedObjectCount ?? inventory?.processedObjects;
  const countLabel = objectCount === undefined ? "未知对象数" : `${objectCount.toLocaleString()} 个对象`;
  const bytes = inventory?.totalBytes === undefined ? "字节数未知" : formatBytes(inventory.totalBytes);
  const qualifier = inventory?.denominatorKnown ? "授权范围盘点" : inventory?.state === "running" ? "盘点进行中" : inventory?.state === "partial" ? "部分盘点" : inventory?.observedObjectCount !== undefined ? "最近扫描观测" : "未盘点";
  return `<span class="connector-inventory connector-inventory-${escapeText(state)}"><span class="connector-inventory-state">${escapeText(qualifier)}</span><strong>${escapeText(countLabel)}</strong>${compact ? "" : `<small>${escapeText(bytes)}${inventory?.observedAt ? ` · ${escapeText(formatDate(inventory.observedAt))}` : ""}</small>`}</span>`;
}

let connectorRecords: Connector[] = [];
let selectedConnectorName = "";
const connectorProbeResults = new Map<string, Connector>();
let overviewRecord: AdminOverview | null = null;
let overviewQuery = "";
let overviewSurveyId = "";
let activeProductDialogId = "";

function readinessLevelLabel(level?: ReadinessLevel): string {
  if (level === undefined || level < 0) return "待补充";
  return `L${level}`;
}

function readinessLevelClass(level?: ReadinessLevel): string {
  return level === undefined || level < 0 ? "needs-information" : `l${level}`;
}

function readinessChip(readiness?: ProductReadiness, version = "当前"): string {
  if (!readiness) return `<span class="readiness-chip readiness-chip-unknown">${escapeText(version)} · 未知</span>`;
  const orders = readiness.geometry.orders.length ? readiness.geometry.orders.map((order) => `O${order}`).join("/") : "--";
  const reverse = readiness.reverseLookup.level >= 2 ? `可定位${readiness.reverseLookup.level === 3 ? "文件" : "Tile / 曝光"} · 反查 ${readiness.reverseLookup.orders.map((order) => `O${order}`).join(" / ")}` : "仅提供来源入口，尚不能定位 Tile 或文件";
  return `<span class="readiness-chip readiness-chip-${readinessLevelClass(readiness.level)}"><strong>${escapeText(version)} · ${escapeText(capabilityNames[readiness.level])} (${readinessLevelLabel(readiness.level)})</strong><span>覆盖精度 ${escapeText(orders)}（HEALPix 阶数）</span><span>${escapeText(reverse)}</span></span>`;
}

function readinessVersionMarkup(versions?: ReadinessVersions, extra = ""): string {
  if (!versions) return `<div class="readiness-version-pair">${readinessChip()}${extra}</div>`;
  return `<div class="readiness-version-pair">${versions.published ? readinessChip(versions.published, "公开版本") : `<span class="lifecycle-chip lifecycle-publication publication-state"><i data-lucide="package"></i>尚未发布</span>`}${!versions.published || JSON.stringify(versions.draft) !== JSON.stringify(versions.published) ? readinessChip(versions.draft, "工作版本") : ""}${extra}</div>`;
}

type ReadinessActionStep = "sources" | "tasks" | "review" | "releases" | "scan";

function readinessActionForGap(gap: string): { step: ReadinessActionStep; label: string } {
  if (gap === "source-not-traceable") return { step: "sources", label: "去数据源" };
  if (gap === "completeness-unknown" || gap === "completeness-partial") return { step: "sources", label: "看盘点" };
  if (gap === "isolated-restore-not-verified") return { step: "releases", label: "去发布验证" };
  if (gap === "output-validation-missing") return { step: "review", label: "去审核" };
  if (gap === "source-unit-index-missing" || gap === "file-level-reverse-index-missing") return { step: "scan", label: "补充反查索引" };
  return { step: "tasks", label: "去探索/处理" };
}

function readinessGapMarkup(gap: string): string {
  let action = readinessActionForGap(gap);
  const guide = gapGuidance[gap];
  const product = productRecords.find((entry) => entry.productId === activeProductDialogId);
  const build = mocBuildRecords.find((entry) => entry.productId === product?.productId);
  if (gap === "output-validation-missing" && build) action = { step: "review", label: "校验已有构建" };
  if (gap === "execution-record-missing" && build) action = { step: "review", label: "校验并记录证据" };
  const context = product ? `本产品：${product.draft.name}${build ? `；已有关联候选 ${build.candidateTitle ?? build.candidateId}` : "；尚无关联 MOC 构建"}。` : "";
  return `<li><div><strong>${escapeText(guide?.title ?? "待核实事项")}</strong><p>${escapeText(guide?.description ?? gap)}</p>${["input-snapshot-hash-missing", "execution-record-missing", "output-validation-missing"].includes(gap) ? `<p>${escapeText(context)}</p>` : ""}<small>${guide?.blocking ? "发布前必须解决" : gap === "isolated-restore-not-verified" ? "发布阶段自动验证" : "可披露限制后分级发布"}</small></div><button type="button" class="readiness-gap-action" data-readiness-action="${action.step}" title="${escapeText(action.label)}"><i data-lucide="arrow-right"></i><span>${escapeText(action.label)}</span></button></li>`;
}

function readinessDetailMarkup(versions?: ReadinessVersions): string {
  if (!versions) return "";
  const versionBlock = (label: string, readiness: ProductReadiness): string => {
    const evidence = [
      ["输入锁定", readiness.evidence.inputLocked],
      ["实际执行", readiness.evidence.executionRecorded],
      ["输出校验", readiness.evidence.outputValidated],
      ["隔离恢复", readiness.evidence.isolatedRestoreValidated],
    ].map(([name, passed]) => `<span class="readiness-evidence-${passed ? "passed" : "missing"}">${escapeText(name)} ${passed ? "已记录" : "缺失"}</span>`).join("");
    const gaps = readiness.gaps.length ? readiness.gaps.map(readinessGapMarkup).join("") : "<li><span>没有待处理缺口</span></li>";
    return `<section class="readiness-detail-version"><header><strong>${escapeText(label)} · ${escapeText(readinessLevelLabel(readiness.level))}</strong><span>覆盖 ${escapeText(readiness.geometry.orders.length ? readiness.geometry.orders.map((order) => `O${order}`).join("/") : "--")} · 反查 ${escapeText(readiness.reverseLookup.precision)}</span></header><div class="readiness-evidence-list">${evidence}</div><ul>${gaps}</ul></section>`;
  };
  return `<section class="readiness-detail"><div class="section-heading"><div><span class="section-index">READINESS EVIDENCE</span><h4>能力与缺口</h4></div><span class="section-note">derived from artifacts / checks</span></div>${versionBlock("草稿", versions.draft)}${versions.published ? versionBlock("已发布", versions.published) : ""}</section>`;
}

function executionEvidenceMarkup(entries?: ExecutionEvidence[], revision?: number): string {
  const visible = (entries ?? []).filter((entry) => revision === undefined || entry.revision === revision).slice(-32);
  const heading = `<div class="review-preflight-summary"><h4>实际执行记录</h4><span>版本 ${escapeText(String(revision ?? visible[0]?.revision ?? "—"))} · ${visible.length} 条</span></div>`;
  if (!visible.length) return `<section class="execution-evidence review-preflight">${heading}<div class="preflight-item is-pending"><i data-lucide="circle-dot"></i><div><strong>当前版本暂无执行记录</strong><p>从候选构建覆盖，或校验已有构建后，系统会记录真实的输入、输出和校验结果。</p></div><button type="button" class="admin-quiet" data-readiness-action="tasks">去探索 / 处理</button></div></section>`;
  return `<section class="execution-evidence review-preflight">${heading}<div class="execution-evidence-list">${visible.map((entry) => {
    const stateName = (state: string) => ({ passed: "通过", failed: "失败", running: "执行中", skipped: "未执行", "not-applicable": "不适用" })[state] ?? state;
    const checkName = (id: string) => ({ "source-snapshot": "来源快照", "output-integrity": "输出完整性" })[id] ?? id;
    const stepName = ({ "moc-build": "获取来源并构建 MOC", "verify-moc-build": "重新校验构建产物" })[entry.stepId] ?? entry.stepId;
    const tone = (state: string) => state === "passed" ? "passed" : state === "failed" ? "blocking" : state === "running" ? "running" : "pending";
    const icon = (state: string) => state === "passed" ? "circle-check" : state === "failed" ? "circle-alert" : "circle-dot";
    const duration = entry.finishedAt ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt ?? "") : NaN;
    const references = (items: ExecutionEvidence["inputs"], label: string, symbol: string) => `<details class="receipt-artifacts"><summary><i data-lucide="${symbol}"></i><span>${label}</span><strong>${items?.length ?? 0} 项</strong></summary><div class="receipt-artifact-list">${(items ?? []).map((item) => `<dl class="receipt-artifact">${detailValue("制品", item.label)}${detailValue("记录位置", item.ref)}${detailValue("SHA-256", item.sha256)}</dl>`).join("") || "<p>暂无记录</p>"}</div></details>`;
    return `<article class="execution-receipt" data-state="${escapeText(entry.status)}"><header class="receipt-header"><strong>${escapeText(stepName)}</strong><span class="receipt-status is-${tone(entry.status)}"><i data-lucide="${icon(entry.status)}"></i>${escapeText(stateName(entry.status))}</span></header><div class="receipt-time"><i data-lucide="calendar-days"></i><span>${escapeText(formatDate(entry.startedAt))}${entry.finishedAt ? ` → ${escapeText(formatDate(entry.finishedAt))}` : ""}</span>${Number.isFinite(duration) && duration >= 0 ? `<span>耗时 ${(duration / 1000).toFixed(1)} 秒</span>` : ""}</div><div class="receipt-tool"><i data-lucide="boxes"></i><span>${escapeText(entry.tool?.name ?? "工具未记录")}</span><span class="receipt-status ${entry.tool?.version ? "" : "is-pending"}">${escapeText(entry.tool?.version ?? "执行版本未记录")}</span>${entry.tool?.imageDigest ? `<code>${escapeText(entry.tool.imageDigest)}</code>` : ""}</div>${(entry.checks ?? []).map((check) => `<div class="preflight-item is-${tone(check.status)}"><i data-lucide="${icon(check.status)}"></i><div><strong>${escapeText(checkName(check.id))}</strong>${check.detail ? `<p>${escapeText(check.detail)}</p>` : ""}</div><span class="receipt-check-state">${escapeText(stateName(check.status))}</span></div>`).join("")}<div class="receipt-references">${references(entry.inputs, "输入", "download")}${references(entry.outputs, "输出", "upload")}</div>${entry.error ? `<div class="preflight-item is-blocking"><i data-lucide="circle-alert"></i><div><strong>执行失败</strong><p>${escapeText(entry.error)}</p></div></div>` : ""}</article>`;
  }).join("")}</div></section>`;
}

function readinessAggregateMarkup(summary?: { draft: ReadinessAggregate; published: ReadinessAggregate }): string {
  if (!summary) return "";
  const draft = summary.draft;
  const published = summary.published;
  const levelCounts = (value: ReadinessAggregate): string => `L0 ${value.levelCounts.L0} · L1 ${value.levelCounts.L1} · L2 ${value.levelCounts.L2} · L3 ${value.levelCounts.L3} · 待补充 ${value.levelCounts.needsInformation}`;
  const capability = (value: ReadinessAggregate): string => `覆盖 ${value.capabilityCounts.coverage} · 单元 ${value.capabilityCounts.unit} · 文件 ${value.capabilityCounts.file}`;
  const orders = (value: ReadinessAggregate): string => value.geometryOrders.length ? value.geometryOrders.map((order) => `O${order}`).join("/") : "--";
  return `<div class="readiness-aggregate"><div><span>草稿</span><strong>${escapeText(levelCounts(draft))}</strong><small>${escapeText(capability(draft))} · 空间 ${escapeText(orders(draft))} · 精度 ${escapeText(draft.geometryPrecision)}</small></div><div><span>已发布</span><strong>${escapeText(levelCounts(published))}</strong><small>${escapeText(capability(published))} · 空间 ${escapeText(orders(published))} · 精度 ${escapeText(published.geometryPrecision)}</small></div></div>`;
}

function runtimeLayerChip(layers: RuntimeLayer[] | undefined): string {
  const label = layers === undefined ? "状态未知" : layers.length ? "已载入" : "未载入";
  const sources = { release: "发布包基线", warehouse: "Warehouse ACTIVE", "product-moc": "产品发布 MOC" };
  return `<span class="readiness-chip runtime-coverage-chip" title="服务端天球目录状态，不代表浏览器已勾选，也不代表当前产品版本已审核或发布"><strong>天球覆盖 · ${label}</strong>${layers?.map(layer => `<span>${escapeText(sources[layer.source])} · ${escapeText(orderLabel(layer.availableOrders))}</span>`).join("") ?? ""}</span>`;
}

function runtimeLayersMarkup(surveyId: string, coverage: CatalogStatus): string {
  const active=coverage.runtimeLayers?.filter(l=>l.surveyId===surveyId&&l.source==="warehouse")??[];
  return `<div class="runtime-coverage-note"><p>目录与天球仅展示审核并完整发布成功的产品。</p>${active.length?`<details><summary>Warehouse 执行状态 · ${active.length} 个 ACTIVE 图层（不代表公开授权）</summary>${active.map(l=>`<p>${escapeText(l.name)} · ${escapeText(l.releaseId)} · ACTIVE · ${escapeText(orderLabel(l.availableOrders))}</p>`).join("")}</details>`:""}</div>`;
}
function productSkyStatus(product:{publicCoverage?:{published:boolean;orders:number[];retired:boolean};review?:Partial<NonNullable<ReviewProduct["review"]>>}):string {
  const state=product.publicCoverage;
  const label=state?.published?(state.orders.length?`已公开 · 天球可显示 · ${orderLabel(state.orders)}`:"已公开 · 暂无覆盖几何"):state?.retired?"已下架":"未公开 · "+(product.review?.reviewedRevision===product.review?.draftRevision&&product.review?.reviewedRevision?"已审核待发布":"待审核");
  return `<span class="readiness-chip runtime-coverage-chip"><strong>${escapeText(label)}</strong></span>`;
}

function renderOverview(overview: AdminOverview): void {
  overviewRecord = overview;
  byId("step-overview-count").textContent = String(overview.totals.products);
  byId("overview-generated-at").textContent = `更新于 ${formatDate(overview.generatedAt)} · ${overview.coverage.mode.toUpperCase()} coverage`;
  const summary = overview.readinessVersions?.[overviewVersion] ?? overview.readiness;
  byId("overview-readiness-summary").innerHTML = [
    ["L0 来源已登记", summary.levelCounts.L0, "已有来源，尚无可查询覆盖"],
    ["L1 覆盖可查询", summary.levelCounts.L1, "尚不能定位数据单元"],
    ["L2 单元可反查", summary.levelCounts.L2, "可定位 Tile / 曝光等单元"],
    ["L3 文件可定位", summary.levelCounts.L3, "可反查具体文件位置"],
    ["待补充", summary.levelCounts.needsInformation, "来源依据待核实"],
  ].map(([label, value, detail]) => `<div class="readiness-summary-card"><span>${escapeText(label)}</span><strong>${escapeText(value)}</strong><small>${escapeText(detail)}</small></div>`).join("");
  const query = overviewQuery;
  const surveys = overview.surveys.filter((survey) => {
    if (!query) return true;
    const haystack = JSON.stringify(survey).toLocaleLowerCase();
    return haystack.includes(query);
  });
  const list = byId("overview-survey-list");
  list.onclick = event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target) return;
    if (target.dataset.surveyCard) {
      overviewSurveyId = target.dataset.surveyCard;
      history.pushState(null, "", routePath({ step: "overview", surveyId: overviewSurveyId }));
      renderOverview(overview);
    } else if (target.id === "overview-back") {
      overviewSurveyId = ""; history.pushState(null, "", "/admin/overview"); renderOverview(overview);
    } else if (target.dataset.overviewProduct) {
      setAdminStep("review"); openProduct(target.dataset.overviewProduct);
    }
  };
  if (!surveys.length) {
    list.innerHTML = `<div class="resource-empty">没有匹配的巡天、DR 或产品</div>`;
    renderIcons();
    return;
  }
  const selectedSurvey = surveys.find((survey) => survey.id === overviewSurveyId);
  if (!selectedSurvey) {
    reconcileMarkup(list, `<div class="survey-card-grid">${surveys.map((survey) => {
      const count = survey.releases.reduce((sum, release) => sum + release.products.length, 0);
      const summary = survey.readiness?.[overviewVersion];
      const image = surveyPresentationImage(survey.id);
      return `<button type="button" class="survey-data-card" data-survey-card="${escapeText(survey.id)}" data-row-key="${escapeText(survey.id)}">${image ? `<img class="survey-card-image" src="${escapeText(image)}" alt="${escapeText(survey.name)} 项目图片" loading="lazy" />` : `<span class="survey-card-image survey-card-placeholder">${escapeText(survey.name)}</span>`}<span class="survey-card-copy"><strong>${escapeText(survey.name)}</strong><small>${escapeText(survey.mission)}</small></span><span class="survey-card-metrics">${taskMetric("layers-3", "集合", survey.releases.length)}${taskMetric("boxes", "产品", count)}${taskMetric("scan-line", "有覆盖", summary?.capabilityCounts.coverage ?? "—")}${taskMetric("file-check-2", "可定位文件", summary?.capabilityCounts.file ?? "—")}${taskMetric("package-check", "已发布", survey.readiness?.published.productCount ?? "—")}</span><span class="survey-card-open"><i data-lucide="chevron-down"></i><span>查看产品</span></span></button>`;
    }).join("")}</div>`);
    list.querySelectorAll<HTMLImageElement>(".survey-card-image").forEach(image => {
      const surveyId = image.closest<HTMLElement>("[data-survey-card]")?.dataset.surveyCard ?? "";
      image.title = surveyPresentationAttribution(surveyId) ?? "项目展示图片";
      image.dataset.fit = ["euclid", "gaia"].includes(surveyId) ? "contain" : "cover";
    });
    renderIcons();
    return;
  }
  reconcileMarkup(list, `<button type="button" class="admin-quiet" id="overview-back">← 返回全部巡天</button>` + [selectedSurvey].map((survey) => {
    const releases = survey.releases.map((release) => {
      const products = release.products.filter((product) => !query || JSON.stringify(product).toLocaleLowerCase().includes(query));
      if (query && !products.length && !`${survey.name} ${release.label}`.toLocaleLowerCase().includes(query)) return "";
      const modalities = new Map<string, number>();
      for (const product of products) {
        const raw = product.modality?.toLowerCase() ?? "unknown";
        const key = raw === "image" ? "imaging" : raw === "spectrum" ? "spectroscopy" : raw;
        modalities.set(key, (modalities.get(key) ?? 0) + 1);
      }
      return `<section class="overview-release" data-row-key="${escapeText(release.id)}"><header><div><strong>${escapeText(release.label)}</strong><span>${products.length} 个产品</span></div><div class="release-modalities">${[...modalities].map(([modality, count]) => modalityMarkup(modality === "unknown" ? undefined : modality, count)).join("")}</div></header><div class="overview-product-list">${products.map((product) => `<article class="overview-product" data-row-key="${escapeText(product.productId)}"><div><strong>${escapeText(product.name)}</strong>${modalityMarkup(product.modality)}</div>${readinessVersionMarkup(product.readiness, productSkyStatus(product))}<button type="button" class="admin-quiet" data-overview-product="${escapeText(product.productId)}" title="查看状态、证据及补全操作"><i data-lucide="eye"></i><span>产品详情与证据</span></button></article>`).join("")}</div></section>`;
    }).filter(Boolean).join("");
return `<article class="overview-survey"><header class="overview-survey-header"><div class="overview-survey-copy"><strong>${escapeText(survey.name)}</strong><span>${escapeText(survey.mission)} · ${survey.releases.length} 个数据发布 / 集合</span><p>按产品查看能力；不同产品的覆盖精度和反查能力可能不同。</p></div></header>${runtimeLayersMarkup(survey.id, overview.coverage)}${releases || `<div class="resource-empty">没有匹配的 DR / 产品</div>`}</article>`;
  }).join(""));
  renderIcons();
}

function connectorTone(phase?: string): "ready" | "error" | "pending" | "unknown" {
  const value = (phase ?? "NOT_CHECKED").toUpperCase();
  return value === "READY" ? "ready" : ["ERROR", "FAILED"].includes(value) ? "error" : ["PENDING", "PROBING"].includes(value) ? "pending" : "unknown";
}

function renderConnectorDetails(connector?: Connector): void {
  const detail = byId("connector-detail");
  if (!connector) {
    detail.innerHTML = `<div class="resource-empty">选择一个 Connector 查看安全详情。</div>`;
    return;
  }
  const location = connectorLocation(connector);
  const phase = connector.phase ?? "NOT_CHECKED";
  detail.dataset.connectorState = connectorTone(phase);
  const inventory = connector.inventory;
  const usage = connector.usage;
  const inventoryState = inventory?.state ?? "unknown";
  const inventoryAction = inventoryState === "complete" ? "重新盘点" : inventoryState === "running" ? "继续盘点" : "开始盘点";
  detail.innerHTML = `<div class="connector-detail-watermark" aria-hidden="true"><i data-lucide="${connectorIcon(connector.type)}"></i></div><div class="connector-detail-heading"><div class="connector-detail-title"><span class="connector-type-icon connector-type-${escapeText(String(connector.type).toLowerCase())}"><i data-lucide="${connectorIcon(connector.type)}"></i></span><div><span class="section-note">SELECTED CONNECTOR · ${escapeText(connectorTypeLabel(connector.type))}</span><h4>${escapeText(connector.name)}</h4></div></div><div class="connector-detail-actions"><button type="button" class="admin-quiet" data-probe-connector="${escapeText(connector.name)}" title="探测 Connector 连接"${phase === "PROBING" ? " disabled" : ""}><i data-lucide="plug-zap"></i><span>${phase === "PROBING" ? "探测中…" : "探测连接"}</span></button><button type="button" class="admin-quiet" data-inventory-connector="${escapeText(connector.name)}" title="按授权范围分页盘点对象或文件"><i data-lucide="list-checks"></i><span>${escapeText(inventoryAction)}</span></button><button type="button" class="admin-quiet" data-use-connector="${escapeText(connector.name)}" title="用此 Connector 创建扫描"><i data-lucide="send"></i><span>用于新扫描</span></button></div></div>${connectorInventoryMarkup(connector)}<dl class="connector-detail-grid">${detailValue("type", connectorTypeLabel(connector.type))}${detailValue("resource", connector.resourceKind)}${detailValue("probe phase", phase)}${detailValue("configuration phase", connector.configurationPhase)}${detailValue("location", location)}${detailValue("PVC", connector.pvcName)}${detailValue("base path", connector.basePath)}${detailValue("legacy path", connector.localPath)}${detailValue("credentials", connector.accessKeyConfigured ? "configured" : "not configured")}${detailValue("checked", connector.checkedAt ? formatDate(connector.checkedAt) : "NOT_CHECKED")}${detailValue("created", formatDate(connector.createdAt))}${detailValue("scan tasks", usage?.scanTaskCount === undefined ? "0" : String(usage.scanTaskCount))}${detailValue("linked products", usage?.productCount === undefined ? "0" : String(usage.productCount))}${detailValue("message", connector.message || inventory?.note)}</dl>`;
  detail.querySelector<HTMLButtonElement>("[data-probe-connector]")?.addEventListener("click", () => void probeConnector(connector.name));
  detail.querySelector<HTMLButtonElement>("[data-inventory-connector]")?.addEventListener("click", () => void inventoryConnector(connector.name));
  detail.querySelector<HTMLButtonElement>("[data-use-connector]")?.addEventListener("click", () => {
    setAdminStep("tasks");
    taskTabs.select("scans");
    byId<HTMLSelectElement>("source-connector").value = connector.name;
    byId<HTMLDialogElement>("task-dialog").showModal();
  });
  renderIcons();
}

function renderConnectors(connectors: Connector[]): void {
  connectorRecords = connectors.map((connector) => ({ ...connector, ...(connectorProbeResults.get(connector.name) ?? {}) }));
  const list = byId("connector-list");
  const source = byId<HTMLSelectElement>("source-connector");
  source.replaceChildren(new Option(connectorRecords.length ? "选择 source connector" : "暂无 source connector", ""), ...connectorRecords.map((connector) => new Option(connectorLabel(connector), connector.name)));
  if (!connectorRecords.length) {
    list.innerHTML = `<div class="resource-empty">暂无 Connector，请先定义一个。</div>`;
    selectedConnectorName = "";
    renderConnectorDetails();
    return;
  }
  if (!connectorRecords.some((connector) => connector.name === selectedConnectorName)) selectedConnectorName = connectorRecords[0]!.name;
  list.innerHTML = connectorRecords.map((connector) => {
    const type = connectorTypeLabel(connector.type);
    const location = connectorLocation(connector);
    const selected = connector.name === selectedConnectorName;
    const phase = (connector.phase ?? "NOT_CHECKED").toUpperCase();
    const tone = connectorTone(phase);
    const stale = connector.checkedAt && Date.now() - Date.parse(connector.checkedAt) > 86_400_000;
    const label = { ready: "最近检查通过", error: "连接失败", pending: "检查中", unknown: "未检查" }[tone];
    return `<button type="button" class="resource-row connector-row connector-status-${tone}${selected ? " is-selected" : ""}" aria-pressed="${selected}" data-connector-name="${escapeText(connector.name)}"><span class="connector-type-icon connector-type-${escapeText(String(connector.type).toLowerCase())}" aria-hidden="true"><i data-lucide="${connectorIcon(connector.type)}"></i></span><span class="connector-row-copy"><strong>${escapeText(connector.name)}</strong><span>${escapeText(type)} · ${label}${stale ? " · 结果已过期" : ""}</span><p>${escapeText(location)}</p></span>${connectorInventoryMarkup(connector, true)}</button>`;
  }).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-connector-name]").forEach((button) => button.addEventListener("click", () => {
    selectedConnectorName = button.dataset.connectorName ?? "";
    renderConnectors(connectorRecords);
    renderConnectorDetails(connectorRecords.find((connector) => connector.name === selectedConnectorName));
  }));
  renderConnectorDetails(connectorRecords.find((connector) => connector.name === selectedConnectorName));
}

async function probeConnector(name: string): Promise<void> {
  const current = connectorRecords.find((connector) => connector.name === name);
  if (!current || current.phase === "PROBING") return;
  connectorProbeResults.set(name, { ...current, phase: "PROBING", message: "正在探测连接…" });
  renderConnectors(connectorRecords);
  try {
    const response = await api<{ connector: Connector }>(`/api/v1/admin/connectors/${encodeURIComponent(name)}/probe`, { method: "POST" });
    connectorProbeResults.set(name, response.connector);
    renderConnectors(connectorRecords);
    toast(`${name} · ${response.connector.phase}` , response.connector.phase === "ERROR");
  } catch (error) {
    connectorProbeResults.set(name, { ...current, phase: "ERROR", message: error instanceof Error ? error.message : "探测失败", checkedAt: new Date().toISOString() });
    renderConnectors(connectorRecords);
    toast(error instanceof Error ? error.message : "Connector 探测失败", true);
  }
}

async function inventoryConnector(name: string): Promise<void> {
  const current = connectorRecords.find((connector) => connector.name === name);
  if (!current) return;
  const button = byId<HTMLElement>("connector-detail").querySelector<HTMLButtonElement>("[data-inventory-connector]");
  if (button) button.disabled = true;
  try {
    const response = await api<{ connector: { name: string; inventory?: Connector["inventory"] } }>(`/api/v1/admin/connectors/${encodeURIComponent(name)}/inventory`, { method: "POST" });
    connectorProbeResults.set(name, { ...current, inventory: response.connector.inventory });
    renderConnectors(connectorRecords);
    const state = response.connector.inventory?.state ?? "unknown";
    toast(`${name} · 盘点${state === "complete" ? "完成" : state === "running" ? "已推进一页" : state}` , state === "failed");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Connector 盘点失败", true);
  } finally {
    if (button) button.disabled = false;
  }
}

function phaseClass(phase: string): string {
  return (phase || "PENDING").toLowerCase().replace(/[^a-z]+/g, "-");
}

function phaseLabel(phase?: string): string {
  const normalized = String(phase ?? "").trim().toUpperCase();
  return normalized || "PENDING";
}

function mocFailureReasonLabel(reason?: string): string {
  const normalized = String(reason ?? "").trim();
  return ({
    ReconcileError: "Warehouse 控制器处理探查请求时出错",
    DiscoveryProtocolError: "Warehouse 探查发生传输或响应错误；旧版摘要可能缺少具体原因",
    DiscoveryConnectTimeout: "Warehouse 连接 CDS 超时，尚未获得有效响应",
    DiscoveryDnsError: "Warehouse 无法解析上游主机名",
    DiscoveryTlsError: "Warehouse 与上游建立 TLS 连接失败",
    DiscoveryConnectError: "Warehouse 无法建立上游连接",
    DiscoveryRequestTimeout: "Warehouse 等待上游响应超时",
    DiscoveryHttpError: "上游服务返回 HTTP 错误",
    DiscoveryTransportError: "Warehouse 请求上游时发生传输错误",
    InvalidIntent: "探查请求参数不完整或无效",
  } as Record<string, string>)[normalized] ?? (normalized || "Warehouse 未完成公开 MOC 探查");
}

function mocDiscoveryStateForStatus(status: MocDiscoveryStatus): MocDiscoveryState {
  if (status.discoveryState) return status.discoveryState;
  const phase = phaseLabel(status.phase);
  if (["FAILED", "ERROR", "INVALID", "CANCELLED"].includes(phase)) return "failed";
  if (!["SUCCEEDED", "COMPLETED"].includes(phase)) return "running";
  const summary = status.reviewSummary;
  if (!summary || status.reviewSummaryState === "missing" || summary.truncated || summary.summaryTruncated) return "incomplete";
  return summary.candidates.length ? "ready" : "empty";
}

function mocDiscoveryStateLabel(state: MocDiscoveryState): string {
  return ({
    running: "探查进行中",
    ready: "候选可审核",
    empty: "探查完成，暂无候选",
    incomplete: "摘要不完整，需重新探查",
    failed: "探查失败",
  } as Record<MocDiscoveryState, string>)[state];
}

function mocReviewAction(request: MocDiscoveryRequest, dataAttribute: "data-moc-review" | "data-moc-review-output"): string {
  const state = mocDiscoveryStateForStatus(request.status);
  const iconName = state === "ready" ? "shield-check" : state === "failed" ? "circle-alert" : "eye";
  const label = state === "ready" ? "审核候选" : state === "failed" ? "失败详情" : "查看状态";
  const title = state === "ready" ? "查看候选并创建构建请求" : state === "failed" ? "查看探查失败原因" : "查看探查状态";
  return `<button type="button" class="admin-quiet" ${dataAttribute}="${escapeText(request.name)}" title="${title}"><i data-lucide="${iconName}"></i><span>${label}</span></button>`;
}

function lifecycleStateLabel(state?: string): string {
  if (!state) return "--";
  const normalized = phaseLabel(state);
  return ({
    CATALOG_BASELINE: "CATALOG BASELINE",
    ACTIVE: "ACTIVE",
    INVALID: "INVALID",
    INACTIVE: "INACTIVE",
    PUBLISHED: "PUBLISHED",
    DRAFT: "DRAFT",
    RETIRED: "RETIRED",
  } as Record<string, string>)[normalized] ?? normalized;
}

function orderLabel(orders?: number[]): string {
  return orders?.length ? orders.map((order) => `O${order}`).join(" / ") : "--";
}

function phaseIcon(phase?: string): string {
  const value = phaseLabel(phase);
  if (["SUCCEEDED", "COMPLETED", "STAGED", "PUBLISHED", "ACTIVE"].includes(value)) return "circle-check";
  if (["FAILED", "ERROR", "INVALID", "CANCELLED"].includes(value)) return "circle-alert";
  if (["RUNNING", "PROBING", "PROCESSING"].includes(value)) return "loader-circle";
  return "circle-dot";
}

function phaseMarkup(phase: string | undefined, prefix = ""): string {
  const label = `${prefix}${phaseLabel(phase)}`;
  return `<span class="task-phase task-phase-${phaseClass(phase ?? "PENDING")}" title="${escapeText(label)}"><i data-lucide="${phaseIcon(phase)}"></i><span>${escapeText(label)}</span></span>`;
}

function taskMetric(icon: string, label: string, value: string | number): string {
  return `<span class="task-metric"><i data-lucide="${icon}"></i><span>${escapeText(label)}</span><strong>${escapeText(value)}</strong></span>`;
}

function taskStatsMarkup(status: TaskStatus): string {
  return [
    taskMetric("file-check-2", "files", status.discoveredFiles !== undefined ? status.discoveredFiles.toLocaleString() : "--"),
    taskMetric("layers-3", "coverage", status.coverageDocuments !== undefined ? status.coverageDocuments.toLocaleString() : "--"),
    taskMetric("boxes", "objects", status.objectDocuments !== undefined ? status.objectDocuments.toLocaleString() : "--"),
    taskMetric("circle-alert", "errors", status.errorCount !== undefined ? status.errorCount.toLocaleString() : "--"),
    taskMetric("grid-3x3", "orders", status.availableOrders?.length ? orderLabel(status.availableOrders) : "--"),
  ].join("");
}

function lifecycleMarkup(lifecycle?: ProductLifecycle, fallbackPublication?: string, nativeOrders?: number[]): string {
  const publication = lifecycleStateLabel(lifecycle?.publication?.state ?? fallbackPublication);
  const runtime = lifecycleStateLabel(lifecycle?.runtime?.state);
  const publicOrders = orderLabel(lifecycle?.runtime?.availableOrders);
  const native = orderLabel(nativeOrders);
  return `<div class="lifecycle-readout"><span class="lifecycle-chip lifecycle-publication lifecycle-${phaseClass(publication)}">PRODUCT ${escapeText(publication)}</span><span class="lifecycle-chip lifecycle-runtime lifecycle-${phaseClass(runtime)}">RUNTIME ${escapeText(runtime)}</span><span class="lifecycle-orders"><span>NATIVE</span> ${escapeText(native)} · <span>PUBLIC</span> ${escapeText(publicOrders)}</span></div>`;
}

function lifecycleLinksMarkup(lifecycle?: ProductLifecycle): string {
  const links = lifecycle?.links;
  if (!links) return "";
  const entries: Array<[keyof NonNullable<ProductLifecycle["links"]>, string]> = [["product", "产品"], ["sky", "天球"], ["catalog", "Catalog"], ["moc", "FITS MOC"]];
  const rendered = entries.flatMap(([key, label]) => {
    const url = links[key];
    if (typeof url !== "string" || !url.trim()) return [];
    const external = /^https?:\/\//i.test(url);
    if (!external && !(url.startsWith("/") && !url.startsWith("//"))) return [];
    return [`<a href="${escapeText(url)}"${external ? ' target="_blank" rel="noreferrer"' : ""}>${escapeText(label)}</a>`];
  });
  return rendered.length ? `<div class="lifecycle-links">${rendered.join("")}</div>` : "";
}

function taskWorkKey(task: Task): string {
  return task.workKey ?? (task.productId ? `product:${task.productId}` : `work:${task.surveyId ?? "unknown"}:${task.releaseId ?? "unknown"}:${task.product ?? task.layerId ?? task.name}`);
}

function mocWorkKey(request: MocDiscoveryRequest): string {
  return request.workKey ?? `work:${request.surveyName}:${request.releaseHint ?? "unknown"}:${request.productHint ?? "moc"}`;
}

function workTitle(task?: Task, request?: MocDiscoveryRequest): string {
  return task?.workTitle ?? request?.workTitle
    ?? ([task?.surveyId ?? request?.surveyName, task?.releaseId ?? request?.releaseHint, task?.product ?? request?.productHint].filter(Boolean).join(" · ")
      || "MOC discovery");
}

let taskRecords: Task[] = [];
const taskRetryInFlight = new Set<string>();

function renderTasks(tasks: Task[]): void {
  taskRecords = tasks;
  const body = byId("task-list");
  if (!tasks.length) {
    body.innerHTML = `<tr><td colspan="7" class="resource-empty">暂无文件扫描执行记录</td></tr>`;
    renderWorkOutputs([], mocDiscoveryRecords);
    return;
  }
  body.innerHTML = tasks.map((task) => {
    const status = task.status ?? { phase: "Pending" };
    const modality = task.modality ?? "other";
    const retrying = taskRetryInFlight.has(task.name);
    return `<tr><td><div class="task-identity"><i data-lucide="${modalityIcon(modality)}"></i><strong>${escapeText(workTitle(task))}</strong></div><small>${escapeText(task.name)} · ${escapeText(modality)} · ${escapeText(task.recipe?.mode ?? task.mode ?? "recipe pending")} · ${escapeText(task.batchId ?? "run pending")}</small></td><td><strong>${escapeText(task.product ?? task.productId ?? task.layerId ?? "product pending")}</strong><small>${escapeText(task.surveyId ?? "survey pending")} / ${escapeText(task.releaseId ?? "release pending")}</small></td><td><span>${escapeText(task.sourceConnector ?? "source pending")}</span><small>${escapeText(task.sourcePaths[0] ?? "path pending")}</small></td><td>${phaseMarkup(status.phase)}<small>${escapeText(status.reason ?? status.message ?? "")}</small></td><td><div class="task-metric-list">${taskStatsMarkup(status)}</div><small>${status.runId ? `run ${escapeText(status.runId)}` : "run pending"}</small></td><td><span>${escapeText(formatDate(status.completedAt ?? status.startedAt ?? task.createdAt))}</span></td><td><div class="task-row-actions"><button type="button" class="admin-quiet" data-task-details="${escapeText(task.name)}" title="查看任务详情"><i data-lucide="eye"></i><span>详情</span></button><button type="button" class="admin-quiet" data-task-resubmit="${escapeText(task.name)}" title="重新提交任务"${retrying ? " disabled" : ""}><i data-lucide="rotate-ccw"></i><span>${retrying ? "重提中…" : "重提"}</span></button></div></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLButtonElement>("[data-task-details]").forEach((button) => button.addEventListener("click", () => void openTaskDetails(button.dataset.taskDetails ?? "")));
  body.querySelectorAll<HTMLButtonElement>("[data-task-resubmit]").forEach((button) => button.addEventListener("click", () => void resubmitTask(button.dataset.taskResubmit ?? "")));
  renderIcons();
  renderWorkOutputs(tasks, mocDiscoveryRecords);
}

let mocDiscoveryRecords: MocDiscoveryRequest[] = [];
let mocRetryInFlight = "";
let mocBuildRecords: MocBuildRequest[] = [];

function renderMocDiscoveryRequests(requests: MocDiscoveryRequest[]): void {
  mocDiscoveryRecords = requests;
  byId("moc-discovery-count").textContent = `${requests.length} REQUEST${requests.length === 1 ? "" : "S"}`;
  const list = byId("moc-discovery-list");
  if (!requests.length) {
    list.innerHTML = `<div class="resource-empty">暂无 MOC 探测请求</div>`;
    renderWorkOutputs(taskRecords, requests, mocBuildRecords);
    return;
  }
  const markup = requests.map((request) => {
    const status = request.status ?? { phase: "PENDING" };
    const hints = [request.releaseHint, request.productHint].filter(Boolean).join(" · ");
    const discoveryState = mocDiscoveryStateForStatus(status);
    const counts = discoveryState === "ready" && status.candidateCount !== undefined
        ? `${status.candidateCount} 个候选`
      : discoveryState === "empty"
        ? "Warehouse 已完成查询，候选数为 0"
        : discoveryState === "failed"
          ? `${mocFailureReasonLabel(status.reason)}${status.message ? ` · ${status.message}` : ""}`
          : discoveryState === "incomplete"
            ? "Warehouse 已结束，但候选摘要不完整"
            : discoveryProgress(request);
    const reviewState = discoveryState === "running" && !status.jobName ? discoveryObservationLabel(request.observation) : mocDiscoveryStateLabel(discoveryState);
    const retrying = mocRetryInFlight === request.name;
    const retry = ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(phaseLabel(status.phase)) ? `<button type="button" class="admin-quiet" data-moc-retry="${escapeText(request.name)}" title="重新探查"${retrying ? " disabled" : ""}><i data-lucide="rotate-ccw"></i><span>${retrying ? "探查中…" : "重新探查"}</span></button>` : "";
    return `<article class="resource-row moc-discovery-row" data-row-key="${escapeText(request.name)}"><div><div class="task-identity"><i data-lucide="search"></i><strong>${escapeText(workTitle(undefined, request))}</strong></div><span>${escapeText(request.name)}${hints ? ` · ${escapeText(hints)}` : ""}</span><p>${escapeText(counts)}</p><small>提交 ${escapeText(formatDate(request.createdAt))} · 最近检查 ${escapeText(formatDate(request.observation?.checkedAt))}</small></div><div class="moc-discovery-row-actions">${discoveryState === "running" && !status.jobName ? `<span class="discovery-observation-state" data-state="${request.observation?.state ?? "waiting"}">${escapeText(reviewState)}</span>` : phaseMarkup(status.phase)}${mocReviewAction(request, "data-moc-review")}${retry}</div></article>`;
  }).join("");
  reconcileMarkup(list, markup);
  list.onclick = event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (button?.dataset.mocReview) void openMocReview(button.dataset.mocReview);
    if (button?.dataset.mocRetry) void resubmitMocDiscovery(button.dataset.mocRetry);
  };
  renderIcons();
  renderWorkOutputs(taskRecords, requests, mocBuildRecords);
}

let activeMocReviewRequest: MocDiscoveryRequest | null = null;
let activeMocCandidateId = "";

function updateMocObservation(request: MocDiscoveryRequest, fetchFailed = false): void {
  const state = byId("moc-review-state");
  if (!state) return;
  const observation = request.observation;
  if (fetchFailed) {
    state.textContent = `状态暂不可获取；保留最后已知状态“${discoveryObservationLabel(observation)}”。${discoveryProgress(request)} 最近成功检查：${formatDate(observation?.checkedAt)}`;
    return;
  }
  state.textContent = `${discoveryProgress(request)} 提交时间：${formatDate(request.createdAt)}；最近检查：${formatDate(observation?.checkedAt)}；最后进展：${formatDate(observation?.lastProgressAt ?? request.status.lastTransitionTime)}。`;
  const outcome = mocDiscoveryStateForStatus(request.status);
  byId("moc-review-title").textContent = `${workTitle(undefined, request)} · ${outcome === "running" && !request.status.jobName ? discoveryObservationLabel(observation) : mocDiscoveryStateLabel(outcome)}`;
  state.dataset.state = observation?.state ?? "running";
  if (observation?.executor.reason) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "诊断详情";
    const description = document.createElement("p");
    description.textContent = `${observation.executor.reason} · ${observation.executor.source ?? "Warehouse 观察"} · 检查时间 ${formatDate(observation.executor.checkedAt)}`;
    details.append(summary, description); state.append(details);
  }
}

function renderMocReviewSummary(request: MocDiscoveryRequest): void {
  const summary = request.status.reviewSummary;
  const discoveryState = mocDiscoveryStateForStatus(request.status);
  const identity = workTitle(undefined, request);
  const kicker = byId("moc-review-kicker");
  const title = byId("moc-review-title");
  const state = byId("moc-review-state");
  const select = byId<HTMLSelectElement>("moc-build-candidate");
  const candidateFields = byId("moc-review-candidate-fields");
  const failure = byId("moc-review-failure");
  const retry = byId<HTMLButtonElement>("moc-review-retry");
  const create = byId<HTMLButtonElement>("moc-create-build");
  const protocol = byId("moc-review-protocol");
  kicker.textContent = discoveryState === "ready" ? "BUILD REVIEW" : "MOC DISCOVERY";
  title.textContent = `${identity} · ${discoveryState === "running" && !request.status.jobName ? discoveryObservationLabel(request.observation) : mocDiscoveryStateLabel(discoveryState)}`;
  state.dataset.state = discoveryState;
  failure.hidden = true;
  failure.replaceChildren();
  retry.hidden = discoveryState === "running";
  candidateFields.hidden = discoveryState !== "ready";
  protocol.hidden = discoveryState !== "ready";
  select.disabled = discoveryState !== "ready";
  select.replaceChildren(new Option("选择候选", ""));
  const candidateDetail = byId("moc-candidate-detail");
  candidateDetail.replaceChildren();
  if (discoveryState === "failed") {
    state.textContent = `公开 MOC 探查未完成：${mocFailureReasonLabel(request.status.reason)}`;
    const message = request.status.message ?? "没有生成可审核的候选摘要。";
    const summaryNode = document.createElement("p");
    summaryNode.textContent = message;
    failure.append(summaryNode);
    if (request.status.reason) {
      const reason = document.createElement("small");
      reason.textContent = `技术原因：${request.status.reason}`;
      failure.append(reason);
    }
    const diagnostic = request.status.failure;
    if (diagnostic) {
      const stages: Record<string, string> = { "connect-or-tls": "连接建立（TCP/TLS 未细分）", dns: "DNS 解析", tls: "TLS 握手或验证", request: "请求/响应传输", response: "响应解析" };
      const items = [
        "执行方：Warehouse MOC discovery",
        `访问目标：${diagnostic.endpoint ?? diagnostic.targetHost ?? "未知"}`,
        `失败阶段：${stages[diagnostic.stage ?? ""] ?? diagnostic.stage ?? "未记录"}`,
        `耗时：${diagnostic.elapsedMs === undefined ? "未记录" : diagnostic.elapsedMs + " ms"}；超时预算：${diagnostic.timeoutMs === undefined ? "未记录" : diagnostic.timeoutMs + " ms"}`,
        `HTTP：${diagnostic.httpStatus ?? "未收到状态码"}；收到字节：${diagnostic.bytes ?? "未记录"}`,
        ...(diagnostic.causeChain ?? []),
        ...(["connect-or-tls", "request"].includes(diagnostic.stage ?? "") ? ["根因归属：尚不能区分集群出口、中间网络或上游服务；此错误不表示没有 MOC。"] : []),
      ];
      for (const text of items) { const line = document.createElement("p"); line.textContent = text; failure.append(line); }
    } else {
      const line = document.createElement("p");
      line.textContent = "执行方：Warehouse。此历史任务未提供详细错误摘要，不能仅凭通用错误码判定责任方；原始原因保留在 evidence。";
      failure.append(line);
    }
    if (request.status.evidencePath) {
      const evidence = document.createElement("small");
      evidence.textContent = `证据位置：${request.status.evidencePath}`;
      failure.append(evidence);
    }
    if (request.status.lastTransitionTime) {
      const transition = document.createElement("small");
      transition.textContent = `最后更新：${formatDate(request.status.lastTransitionTime)}`;
      failure.append(transition);
    }
    failure.hidden = false;
    create.disabled = true;
    return;
  }
  if (discoveryState === "running") {
    updateMocObservation(request);
    create.disabled = true;
    return;
  }
  if (discoveryState === "empty") {
    state.textContent = "探查已完成，本次 CDS 查询没有候选 MOC。";
    create.disabled = true;
    return;
  }
  if (!summary) {
    state.textContent = "探查已结束，但没有可读的 v2 候选摘要，请重新探查。";
    create.disabled = true;
    return;
  }
  if (discoveryState === "incomplete") {
    state.textContent = `候选摘要不完整${summary.truncated || summary.summaryTruncated ? "：结果被截断" : ""}，请重新探查后再构建。`;
    create.disabled = true;
    return;
  }
  state.textContent = `已找到 ${summary.candidates.length} 个候选 MOC，可选择后创建构建请求。`;
  summary.candidates.forEach((candidate) => select.add(new Option(`${candidate.title ?? candidate.candidateId}${candidateBuildLabel(candidate)}`, candidate.candidateId)));
  select.value = activeMocCandidateId && summary.candidates.some((candidate) => candidate.candidateId === activeMocCandidateId) ? activeMocCandidateId : summary.candidates[0]?.candidateId ?? "";
  activeMocCandidateId = select.value;
  select.onchange = () => { activeMocCandidateId = select.value; syncMocCandidateSelection(); };
  syncMocCandidateSelection();
}

function candidateExistingBuild(candidate: MocCandidateSummary): MocBuildRequest | undefined {
  return mocBuildRecords.find((build) => (build.candidateId === candidate.candidateId || Boolean(candidate.mocUrl && build.source.url === candidate.mocUrl)) && ["STAGED", "PUBLISHED", "DUPLICATE"].includes(build.phase));
}

function candidateBuildLabel(candidate: MocCandidateSummary): string {
  const build = candidateExistingBuild(candidate);
  if (!build) return " · 尚未构建";
  const original = build.duplicateOf ? mocBuildRecords.find((entry) => entry.name === build.duplicateOf) ?? build : build;
  const product = productRecords.find((entry) => entry.productId === original.productId);
  return ` · ${product?.published ? "已有发布" : product ? "已登记" : "已构建"}：${releaseDisplayName(product?.draft.surveyId ?? original.surveyId, product?.draft.releaseId ?? original.releaseId)} / ${product?.draft.name ?? original.candidateTitle ?? original.candidateId}`;
}

function releaseDisplayName(surveyId?: string, releaseId?: string): string {
  return reviewSurveyRecords.find((survey) => survey.id === surveyId)?.releases.find((release) => release.id === releaseId)?.label
    ?? (!releaseId || releaseId === "public" ? "公开覆盖集合（未标明官方 DR）" : releaseId);
}

function syncMocCandidateSelection(): void {
  const request = activeMocReviewRequest;
  const select = byId<HTMLSelectElement>("moc-build-candidate");
  const candidate = request?.status.reviewSummary?.candidates.find((entry) => entry.candidateId === select.value);
  byId("moc-candidate-detail").innerHTML = candidate
    ? `<strong>${escapeText(candidate.title ?? candidate.candidateId)}</strong><p>${escapeText(candidateBuildLabel(candidate))}</p><small>${escapeText(candidate.mocUrl ?? candidate.hipsUrl ?? "没有可下载 MOC URL")}</small>${candidateExistingBuild(candidate) ? `<button type="button" class="admin-quiet" id="candidate-existing-build">查看已有构建与产品</button><p>此候选已有结果，通常无需重复构建。来源更新后可再次构建，系统会按实际内容哈希判重。</p>` : ""}`
    : `<span class="resource-empty">请选择一个候选</span>`;
  byId<HTMLButtonElement>("moc-create-build").disabled = !candidate || !request || mocDiscoveryStateForStatus(request.status) !== "ready";
  document.getElementById("candidate-existing-build")?.addEventListener("click", () => {
    const build = candidate && candidateExistingBuild(candidate);
    if (!build) return;
    byId<HTMLDialogElement>("moc-review-dialog").close();
    void openMocBuildDetails(build.duplicateOf ?? build.name);
  });
}

async function openMocReview(name: string): Promise<void> {
  try {
    const response = await api<{ request: MocDiscoveryRequest }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(name)}`);
    activeMocReviewRequest = response.request;
    activeMocCandidateId = "";
    byId("moc-review-title").textContent = workTitle(undefined, response.request);
    renderMocReviewSummary(response.request);
    byId<HTMLDialogElement>("moc-review-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "候选加载失败", true); }
}

async function submitMocDiscovery(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  setMessage("moc-discovery", "正在提交…");
  try {
    const selectedProduct = productRecords.find((product) => product.productId === formValue(form, "productId"));
    await api("/api/v1/admin/moc-discovery", { method: "POST", body: JSON.stringify({ surveyName: selectedProduct?.draft.surveyId ?? formValue(form, "surveyName"), releaseHint: selectedProduct?.draft.releaseId ?? (formValue(form, "releaseHint") || undefined), productHint: selectedProduct?.draft.name ?? (formValue(form, "productHint") || undefined), productId: selectedProduct?.productId, surveyId: selectedProduct?.draft.surveyId, releaseId: selectedProduct?.draft.releaseId, workTitle: selectedProduct ? `${selectedProduct.draft.surveyId.toUpperCase()} · ${selectedProduct.draft.releaseId} · ${selectedProduct.draft.name}` : undefined }) });
    form.reset();
    byId<HTMLDialogElement>("moc-discovery-dialog").close();
    toast("MOC 探测请求已提交");
    await refresh();
  } catch (error) { setMessage("moc-discovery", error instanceof Error ? error.message : "提交失败", true); }
}

async function submitMocReview(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!activeMocReviewRequest || !activeMocCandidateId) return;
  const button = byId<HTMLButtonElement>("moc-create-build");
  button.disabled = true;
  setMessage("moc-review", "正在创建持久化构建请求…");
  try {
    const response = await api<{ request: MocBuildRequest }>("/api/v1/admin/moc-builds", { method: "POST", body: JSON.stringify({ discoveryRequestName: activeMocReviewRequest.name, candidateId: activeMocCandidateId, ...(activeMocReviewRequest.productId ? { productId: activeMocReviewRequest.productId } : {}) }) });
    toast(`已创建构建请求 ${response.request.name}`);
    byId<HTMLDialogElement>("moc-review-dialog").close();
    taskTabs.select("outputs");
    await refresh();
  } catch (error) {
    setMessage("moc-review", error instanceof Error ? error.message : "创建构建失败", true);
    button.disabled = false;
    button.querySelector("span")!.textContent = "创建构建请求";
  }
}

async function resubmitMocDiscovery(name: string): Promise<void> {
  if (mocRetryInFlight === name) return;
  mocRetryInFlight = name;
  renderMocDiscoveryRequests(mocDiscoveryRecords);
  try {
    const response = await api<{ request: MocDiscoveryRequest }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(name)}/resubmit`, { method: "POST" });
    toast(`已创建重新探查任务 ${response.request.name}`);
    byId<HTMLDialogElement>("moc-review-dialog").close();
    activeMocReviewRequest = null;
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "重新探查失败", true); }
  finally { mocRetryInFlight = ""; renderMocDiscoveryRequests(mocDiscoveryRecords); }
}

let activeMocBuildName = "";

function mocBuildDetailAction(name: string): string {
  return `<button type="button" class="admin-quiet" data-moc-build-details="${escapeText(name)}" title="查看 MOC 构建详情"><i data-lucide="eye"></i><span>构建详情</span></button>`;
}

function mocBuildRegistrationAction(build: MocBuildRequest | MocBuildSummary): string {
  if (build.phase !== "STAGED" || build.productId) return "";
  return `<button type="button" class="admin-primary" data-register-moc-build-output="${escapeText(build.name)}" title="登记为公共产品"><i data-lucide="plus"></i><span>登记产品</span></button>`;
}

function mocBuildReadout(build: MocBuildRequest | MocBuildSummary): string {
  const complete = phaseLabel(build.phase) === "STAGED" ? `<span class="build-complete">构建完成</span>` : "";
  const nativeOrders = build.outputs?.availableOrders;
  const lifecycle = lifecycleMarkup(build.lifecycle, undefined, nativeOrders);
  const links = lifecycleLinksMarkup(build.lifecycle);
  return `${complete}${lifecycle}${links}`;
}

function renderMocBuildDetails(build: MocBuildRequest): void {
  const progress = build.progress ?? { phase: build.phase, step: 0, totalSteps: 0 };
  const output = build.outputs;
  const outputRows = output ? [
    detailValue("cell count", output.cellCount?.toLocaleString()),
    detailValue("available orders", output.availableOrders?.map((order) => `O${order}`).join(" / ")),
    detailValue("max order", output.maxOrder !== undefined ? `O${output.maxOrder}` : undefined),
    detailValue("MOC", output.moc ? `${output.moc.ref} · ${output.moc.sha256}${output.moc.sizeBytes !== undefined ? ` · ${output.moc.sizeBytes} bytes` : ""}` : undefined),
    detailValue("query", output.query ? `${output.query.ref} · O${output.query.order}${output.query.sha256 ? ` · ${output.query.sha256}` : ""}` : undefined),
    detailValue("preview", output.preview ? `${output.preview.ref} · O${output.preview.order}${output.preview.sha256 ? ` · ${output.preview.sha256}` : ""}` : undefined),
    detailValue("statistics", output.statistics ? `${output.statistics.ref}${output.statistics.sha256 ? ` · ${output.statistics.sha256}` : ""}` : undefined),
    detailValue("manifest", output.manifest ? `${output.manifest.ref}${output.manifest.sha256 ? ` · ${output.manifest.sha256}` : ""}` : undefined),
  ].join("") : "";
  const percent = typeof progress.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : undefined;
  const registerAction = build.phase === "STAGED" && !build.productId ? `<button type="button" class="admin-primary" data-register-moc-build-detail="${escapeText(build.name)}"><i data-lucide="plus"></i><span>登记为产品</span></button>` : "";
  byId("moc-build-detail-title").textContent = build.workTitle ?? build.name;
  byId("moc-build-detail-content").innerHTML = `<div class="build-progress-summary"><div>${phaseMarkup(build.phase, "BUILD ")}<strong>${escapeText(progress.message ?? "")}</strong>${registerAction}</div>${percent !== undefined ? `<progress max="100" value="${percent}"></progress><span>${percent}% · step ${progress.step}/${progress.totalSteps}</span>` : ""}${mocBuildReadout(build)}</div><dl class="task-detail-grid">${detailValue("build", build.name)}${detailValue("discovery", build.discoveryRequestName)}${detailValue("candidate", build.candidateId)}${detailValue("product", build.productId)}${detailValue("source", build.source.url)}${detailValue("source snapshot", build.source.snapshotSha256 ? `${build.source.snapshotSha256}${build.source.sizeBytes !== undefined ? ` · ${build.source.sizeBytes} bytes` : ""}` : undefined)}${detailValue("evidence", build.source.evidenceRef)}${detailValue("created", formatDate(build.createdAt))}${detailValue("updated", formatDate(build.updatedAt))}${detailValue("published", build.publishedAt ? `${formatDate(build.publishedAt)}${build.publicationId ? ` · ${build.publicationId}` : ""}` : "not published")}${detailValue("error", build.error ? `${build.error.reason}: ${build.error.message}` : undefined)}</dl>${outputRows ? `<h5 class="build-detail-subheading">构建产出</h5><dl class="task-detail-grid">${outputRows}</dl>` : ""}`;
  byId("moc-build-detail-content").querySelector<HTMLButtonElement>("[data-register-moc-build-detail]")?.addEventListener("click", () => void openMocProductRegistration(build.name));
  renderIcons();
}

async function openMocBuildDetails(name: string): Promise<void> {
  try {
    const response = await api<{ request: MocBuildRequest }>(`/api/v1/admin/moc-builds/${encodeURIComponent(name)}`);
    activeMocBuildName = name;
    renderMocBuildDetails(response.request);
    byId<HTMLDialogElement>("moc-build-detail-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "MOC 构建详情加载失败", true); }
}

function workBuildRowMarkup(build: MocBuildRequest): string {
  const product = productRecords.find(entry => entry.productId === build.productId);
  const release = reviewSurveyRecords.find(survey => survey.id === (product?.draft.surveyId ?? build.surveyId))?.releases.find(release => release.id === (product?.draft.releaseId ?? build.releaseId));
  const busy = ["QUEUED", "PENDING", "RUNNING", "PROCESSING"].includes(phaseLabel(build.phase));
  const percent = busy && typeof build.progress?.percent === "number" ? Math.min(100, Math.max(0, build.progress.percent)) : undefined;
  const message = build.error?.message ?? (busy ? build.progress?.message : undefined);
  return `<div class="work-build-output" data-row-key="${escapeText(build.name)}"><div class="work-build-identity"><strong>${escapeText(product?.draft.name ?? build.candidateTitle ?? build.candidateId)}</strong><small>${escapeText(release?.label ?? product?.draft.releaseId ?? build.releaseId ?? "数据发布未指定")} · ${product?.published ? "产品已发布" : product ? "已登记产品" : "待登记产品"}</small>${message ? `<span class="work-build-message${build.error ? " is-error" : ""}" title="${escapeText(message)}">${escapeText(message)}</span>` : ""}</div><div class="work-build-metrics">${phaseMarkup(build.phase)}${taskMetric("grid-3x3", "精度", orderLabel(build.outputs?.availableOrders))}${taskMetric("layers-3", "覆盖单元", build.outputs?.cellCount?.toLocaleString() ?? "—")}${percent !== undefined ? `<span class="work-build-progress"><progress max="100" value="${percent}" aria-label="构建进度"></progress><small>${percent}%</small></span>` : ""}</div><div class="work-build-actions">${mocBuildDetailAction(build.name)}${mocBuildRegistrationAction(build)}</div></div>`;
}

function standaloneBuildsMarkup(builds: MocBuildRequest[]): string {
  return `<div class="work-output-list">${builds.map(build => `<article class="work-output-row" data-row-key="${escapeText(build.name)}">${workBuildRowMarkup(build)}</article>`).join("")}</div>`;
}

function updateTaskTabCounts(): void {
  byId("task-tab-outputs-count").textContent = String(document.querySelectorAll("#modality-chart .work-output-row").length);
  byId("task-tab-discovery-count").textContent = String(mocDiscoveryRecords.length);
  byId("task-tab-scans-count").textContent = String(taskRecords.length);
}

function renderWorkOutputs(tasks: Task[], requests: MocDiscoveryRequest[], builds: MocBuildRequest[] = mocBuildRecords): void {
  const container = byId("modality-chart");
  container.onclick = event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target) return;
    if (target.dataset.mocBuildDetails) void openMocBuildDetails(target.dataset.mocBuildDetails);
    if (target.dataset.registerMocBuildOutput) void openMocProductRegistration(target.dataset.registerMocBuildOutput);
    if (target.dataset.taskDetailsOutput) void openTaskDetails(target.dataset.taskDetailsOutput);
    if (target.dataset.taskResubmitOutput) void resubmitTask(target.dataset.taskResubmitOutput);
    if (target.dataset.mocReviewOutput) void openMocReview(target.dataset.mocReviewOutput);
    if (target.dataset.mocRetryOutput) void resubmitMocDiscovery(target.dataset.mocRetryOutput);
  };
  const groups = aggregateWorkAttempts(
    tasks.map((task) => ({ key: taskWorkKey(task), createdAt: task.createdAt, value: task })),
    requests.map((request) => ({ key: mocWorkKey(request), createdAt: request.createdAt, value: request })),
  );
  if (!groups.length) {
    reconcileMarkup(container, builds.length ? standaloneBuildsMarkup(builds) : '<div class="resource-empty">暂无任务产出</div>');
    updateTaskTabCounts();
    renderIcons();
    return;
  }
  const renderedBuildNames = new Set<string>();
  const rows = groups.map((group) => {
    const key = group.key;
    const task = group.task;
    const request = group.request;
    const scanStatus = task ? phaseLabel(task.status?.phase) : "NOT_SUBMITTED";
    const mocStatus = request ? (request.observation && ["waiting", "delayed", "blocked"].includes(request.observation.state) ? discoveryObservationLabel(request.observation) : phaseLabel(request.status?.phase)) : "NOT_SUBMITTED";
    const taskStatus = task?.status ?? { phase: "PENDING" };
    const scanCounts = task ? taskStatsMarkup(taskStatus) : `<span class="task-metric task-metric-empty"><i data-lucide="scan-line"></i><span>scan</span><strong>未提交</strong></span>`;
    const mocCounts = request ? taskMetric("search", "candidates", request.status.candidateCount !== undefined ? request.status.candidateCount.toLocaleString() : "--") : taskMetric("search", "MOC", "未探查");
    const retry = task && ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(scanStatus) ? `<button type="button" class="admin-quiet" data-task-resubmit-output="${escapeText(task.name)}" title="重新提交文件扫描"><i data-lucide="rotate-ccw"></i><span>重提扫描</span></button>` : "";
    const mocRetry = request && ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(mocStatus) ? `<button type="button" class="admin-quiet" data-moc-retry-output="${escapeText(request.name)}" title="重新探查"><i data-lucide="rotate-ccw"></i><span>重提探查</span></button>` : "";
    const evidence = task?.status.evidencePath ?? request?.status.evidencePath;
    const attemptLabel = `${group.taskAttempts} scan / ${group.mocAttempts} MOC attempts; latest result only`;
    const discoveryNames = new Set(requests.filter((entry) => mocWorkKey(entry) === key).map((entry) => entry.name));
    const relatedBuilds = builds.filter((build) => discoveryNames.has(build.discoveryRequestName) || (build.productId && build.productId === task?.productId));
    relatedBuilds.forEach((build) => renderedBuildNames.add(build.name));
    const buildRows = relatedBuilds.map(workBuildRowMarkup).join("");
    return `<article class="work-output-row" data-row-key="${escapeText(key)}"><div class="work-output-copy"><div class="task-identity"><i data-lucide="layers-3"></i><strong>${escapeText(workTitle(task, request))}</strong></div><small>${escapeText(key)} · ${escapeText(attemptLabel)}</small><div class="work-output-metrics"><div><span class="work-output-metrics-label"><i data-lucide="scan-line"></i>SCAN OUTPUT</span>${scanCounts}</div><div><span class="work-output-metrics-label"><i data-lucide="search"></i>MOC OUTPUT</span>${mocCounts}</div></div>${evidence ? `<p class="work-output-evidence"><i data-lucide="shield-check"></i>${escapeText(evidence)}</p>` : ""}</div><div class="work-output-status">${phaseMarkup(scanStatus, "SCAN ")}${phaseMarkup(mocStatus, "MOC ")}<div class="work-output-actions">${task ? `<button type="button" class="admin-quiet" data-task-details-output="${escapeText(task.name)}" title="查看扫描详情"><i data-lucide="eye"></i><span>详情</span></button>` : ""}${request ? mocReviewAction(request, "data-moc-review-output") : ""}${retry}${mocRetry}</div></div><div class="work-build-list">${buildRows}</div></article>`;
  }).join("");
  let outputMarkup = `<div class="work-output-list">${rows}</div>`;
  const ungroupedBuilds = builds.filter((build) => !renderedBuildNames.has(build.name));
  if (ungroupedBuilds.length) {
    outputMarkup += standaloneBuildsMarkup(ungroupedBuilds);
  }
  reconcileMarkup(container, outputMarkup);
  updateTaskTabCounts();
  renderIcons();
}

function detailValue(label: string, value: unknown): string {
  return `<div class="task-detail-field"><dt>${escapeText(label)}</dt><dd>${escapeText(value ?? "unknown")}</dd></div>`;
}

async function openTaskDetails(name: string): Promise<void> {
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}`);
    const task = response.task;
    const status = task.status ?? { phase: "Pending" };
    byId("task-detail-title").textContent = task.name;
    byId("task-detail-content").innerHTML = `<dl class="task-detail-grid">${detailValue("phase", phaseLabel(status.phase))}${detailValue("reason", status.reason)}${detailValue("message", status.message)}${detailValue("survey", task.surveyId)}${detailValue("release", task.releaseId)}${detailValue("product", task.product ?? task.productId)}${detailValue("layer", task.layerId)}${detailValue("modality", task.modality)}${detailValue("recipe", task.recipe?.mode ?? task.mode)}${detailValue("available orders", status.availableOrders?.map((order) => `O${order}`).join(", "))}${detailValue("run ID", status.runId)}${detailValue("files", status.discoveredFiles?.toLocaleString())}${detailValue("processed", status.processedHdus?.toLocaleString())}${detailValue("coverage", status.coverageDocuments?.toLocaleString())}${detailValue("objects", status.objectDocuments?.toLocaleString())}${detailValue("errors", status.errorCount?.toLocaleString())}${detailValue("source snapshot", status.sourceSnapshot ? `${status.sourceSnapshot.sha256}${status.sourceSnapshot.sizeBytes !== undefined ? ` · ${status.sourceSnapshot.sizeBytes} bytes` : ""}${status.sourceSnapshot.uri ? ` · ${status.sourceSnapshot.uri}` : ""}` : undefined)}${detailValue("evidence", status.evidencePath)}${detailValue("started", formatDate(status.startedAt))}${detailValue("completed", formatDate(status.completedAt))}</dl>`;
    byId<HTMLDialogElement>("task-detail-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "任务详情加载失败", true); }
}

async function resubmitTask(name: string): Promise<void> {
  if (taskRetryInFlight.has(name)) return;
  taskRetryInFlight.add(name);
  renderTasks(taskRecords);
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}/resubmit`, { method: "POST" });
    toast(`已创建重提任务 ${response.task.name}`);
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "任务重提失败", true); }
  finally { taskRetryInFlight.delete(name); renderTasks(taskRecords); }
}

let productRecords: Product[] = [];
let reviewSurveyRecords: ReviewSurvey[] = [];
let selectedReviewSurveyId = "";
let productQuery = "";
const workspaceRequests = new WorkspaceRequests();
const resourceCache = new Map<Resource, unknown>();
const renderedSignatures = new Map<Resource, string>();
let refreshVersion = 0;
let automaticUpdates = sessionStorage.getItem("assets-admin-auto-update") !== "off";
let pendingUpdates = false;
let overviewVersion: "draft" | "published" = "draft";
let refreshInFlight: Promise<void> | null = null;
let pollTimer: number | undefined;
const terminalWorkPhases = new Set(["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED", "STAGED", "DUPLICATE"]);

function hasActiveWork(): boolean {
  return taskRecords.some((task) => !terminalWorkPhases.has(phaseLabel(task.status?.phase)))
    || mocDiscoveryRecords.some((request) => !terminalWorkPhases.has(phaseLabel(request.status?.phase)))
    || mocBuildRecords.some((build) => !terminalWorkPhases.has(phaseLabel(build.phase)));
}

function schedulePolling(delayMs?: number): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (!automaticUpdates || document.hidden || !token || byId("admin-workspace").hidden) return;
  const active = activeStep === "tasks" && hasActiveWork() || activeStep === "releases" && publicationRuns.some(run => ["queued", "building", "uploading", "verifying"].includes(run.status));
  pollTimer = window.setTimeout(() => { pollTimer = undefined; void refresh(true); }, delayMs ?? (active ? 3000 : 15000));
}

function renderProducts(products: Product[]): void {
  productRecords = products;
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("选择 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.name}`, product.productId)));
  const mocProduct = document.getElementById("moc-product");
  const selectedMocProduct = mocProduct instanceof HTMLSelectElement ? mocProduct.value : "";
  if (mocProduct instanceof HTMLSelectElement) mocProduct.replaceChildren(new Option("不绑定 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.releaseId} · ${product.draft.name}`, product.productId)));
  if (mocProduct instanceof HTMLSelectElement) mocProduct.value = selectedMocProduct;
  renderDiscoveryProductTree();
  renderReviewSurveys(reviewSurveyRecords);
}

const discoveryExpanded = new Set<string>();
let discoveryTreeSearching = false;
function renderDiscoveryProductTree(): void {
  const search = byId<HTMLInputElement>("moc-product-search");
  const query = search.value.trim().toLowerCase();
  const select = byId<HTMLSelectElement>("moc-product");
  const selected = productRecords.find((product) => product.productId === select.value);
  byId("moc-product-selection").textContent = selected ? `已选择：${selected.draft.publicSurvey?.name ?? selected.draft.surveyId} / ${selected.draft.releaseId} / ${selected.draft.name}` : "当前：不绑定已有产品；探索可独立进行";
  const matching = productRecords.filter((product) => !product.retiredAt && `${product.draft.publicSurvey?.name ?? ""} ${product.draft.surveyId} ${product.draft.releaseId} ${product.draft.name}`.toLowerCase().includes(query));
  const surveys = [...new Set(matching.map((product) => product.draft.surveyId))];
  const tree = byId("moc-product-tree");
  const previousScroll = tree.scrollTop;
  if (!discoveryTreeSearching) {
    tree.querySelectorAll<HTMLDetailsElement>("details[data-branch]").forEach(branch => {
      if (branch.open) discoveryExpanded.add(branch.dataset.branch!);
      else discoveryExpanded.delete(branch.dataset.branch!);
    });
  }
  discoveryTreeSearching = Boolean(query);
  tree.innerHTML = `<button type="button" data-pick-product="" aria-pressed="${!selected}">不绑定已有产品</button>` + surveys.map((surveyId) => {
    const products = matching.filter((product) => product.draft.surveyId === surveyId);
    const releases = [...new Set(products.map((product) => product.draft.releaseId))];
    return `<details ${query ? "open" : ""}><summary>${escapeText(products[0]?.draft.publicSurvey?.name ?? surveyId.toUpperCase())} · ${products.length} 个产品</summary>${releases.map((releaseId) => `<details ${query ? "open" : ""}><summary>${escapeText(releaseDisplayName(surveyId, releaseId))}</summary>${products.filter((product) => product.draft.releaseId === releaseId).map((product) => `<button type="button" data-pick-product="${escapeText(product.productId)}" aria-pressed="${select.value === product.productId}">${escapeText(product.draft.name)} · ${product.published ? "已发布" : "未发布"}</button>`).join("")}</details>`).join("")}</details>`;
  }).join("") + (!matching.length ? `<p>没有匹配产品，可不绑定产品继续探索。</p>` : "");
  tree.querySelectorAll<HTMLButtonElement>("[data-pick-product]").forEach((button) => button.addEventListener("click", () => {
    select.value = button.dataset.pickProduct ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const product = productRecords.find((entry) => entry.productId === select.value);
    if (product) {
      const form = byId<HTMLFormElement>("moc-discovery-form");
      setRegistrationField(form, "surveyName", product.draft.publicSurvey?.name ?? product.draft.surveyId);
      setRegistrationField(form, "releaseHint", product.draft.releaseId);
      setRegistrationField(form, "productHint", product.draft.name);
    }
    renderDiscoveryProductTree();
  }));
  search.oninput = renderDiscoveryProductTree;
  tree.querySelectorAll<HTMLDetailsElement>("details").forEach(branch => {
    const parent = branch.parentElement?.closest("details");
    const key = `${parent?.querySelector("summary")?.textContent ?? ""}/${branch.querySelector("summary")?.textContent ?? ""}`;
    branch.dataset.branch = key;
    branch.open = Boolean(query) || discoveryExpanded.has(key);
  });
  tree.scrollTop = previousScroll;
}

function renderProductLoadError(message: string): void {
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("Catalog 产品加载失败", ""));
  byId("product-list").innerHTML = `<div class="resource-empty">${escapeText(message)}</div>`;
  productRecords = [];
}

function reviewProductMatches(product: ReviewProduct): boolean {
  if (!productQuery) return true;
  return `${product.name} ${product.productId} ${product.modality ?? ""} ${product.status} ${product.description} ${product.reason ?? ""} ${(product.coverage?.availableOrders ?? []).map((order) => `O${order}`).join(" ")}`.toLocaleLowerCase().includes(productQuery);
}

function mocBuildStatusText(build?: MocBuildSummary): string {
  if (!build) return "";
  const percent = typeof build.progress?.percent === "number" ? ` · ${build.progress.percent}%` : "";
  const published = build.publishedAt ? " · published" : "";
  return `MOC build ${build.phase}${percent}${published}`;
}

type ReviewFilter = "all" | "pending" | "reviewed" | "published" | "retired";
let reviewFilter: ReviewFilter = "all";
const reviewFilterLabels: Record<ReviewFilter, string> = { all: "全部", pending: "待审核", reviewed: "已审核", published: "已发布", retired: "已退休" };

function reviewProductState(product: ReviewProduct): Exclude<ReviewFilter, "all"> {
  if (product.retiredAt || product.lifecycle?.publication?.state === "RETIRED") return "retired";
  const state = product.review?.state;
  if (state === "reviewed") return "reviewed";
  if (state === "published" || state === "unmatched-published") return "published";
  return "pending";
}

function reviewEntries(survey: ReviewSurvey): Array<{ product: ReviewProduct; release: string; unmatched?: boolean }> {
  return [
    ...survey.releases.flatMap(release => release.products.map(product => ({ product, release: release.label }))),
    ...(survey.unmatchedProducts ?? []).map(record => ({
      product: { ...record, productId: String(record.productId ?? ""), name: String(record.name ?? record.productId ?? "未命名产品"), description: String(record.description ?? ""), status: String(record.status ?? "unknown") } as ReviewProduct,
      release: String(record.releaseId ?? "未指定 Release"), unmatched: true,
    })),
  ];
}

function productPublicationRun(productId: string): PublicationRun | undefined {
  const publishedRevision = productRecords.find(product => product.productId === productId)?.publishedRevision;
  return publicationRuns.find(run => run.selectedProducts?.some(selected => selected.productId === productId
    && !(run.status === "failed" && publishedRevision != null && selected.revision <= publishedRevision)));
}

function renderReviewSurveys(surveys: ReviewSurvey[]): void {
  reviewSurveyRecords = surveys;
  const list = byId("product-list");
  const matchesSurvey = (survey: ReviewSurvey) => `${survey.name} ${survey.id} ${survey.mission}`.toLocaleLowerCase().includes(productQuery);
  const visible = surveys.filter(survey => !productQuery || matchesSurvey(survey) || reviewEntries(survey).some(({product, release}) => reviewProductMatches(product) || release.toLocaleLowerCase().includes(productQuery)) || (survey.unmatchedBuilds ?? []).some(build => `${build.name} ${build.candidateTitle ?? ""}`.toLocaleLowerCase().includes(productQuery)));
  reconcileMarkup(list, `<div class="review-survey-grid">${visible.map(survey => {
    const entries = reviewEntries(survey);
    const count = (state: ReviewFilter) => entries.filter(({product}) => reviewProductState(product) === state).length;
    return `<button type="button" class="review-survey-card" data-review-survey="${escapeText(survey.id)}" aria-haspopup="dialog"><span class="review-card-name"><i data-lucide="globe-2"></i><strong>${escapeText(survey.name)}</strong></span><span class="review-card-total">${entries.length} 个产品 · ${survey.releases.length} 个 Release</span><span class="review-card-counts"><span>待审核 <strong>${count("pending")}</strong></span><span>已审核 <strong>${count("reviewed")}</strong></span><span>已发布 <strong>${count("published")}</strong></span>${count("retired") ? `<span>已退休 <strong>${count("retired")}</strong></span>` : ""}</span>${survey.unmatchedBuilds?.length ? `<small>${survey.unmatchedBuilds.length} 个构建待登记</small>` : ""}<span class="review-card-open">查看产品 <i data-lucide="arrow-right"></i></span></button>`;
  }).join("") || '<p class="resource-empty">没有匹配的巡天或产品</p>'}</div>`);
  list.querySelectorAll<HTMLButtonElement>("[data-review-survey]").forEach(button => button.onclick = () => {
    selectedReviewSurveyId = button.dataset.reviewSurvey ?? "";
    reviewFilter = "all";
    renderReviewSurveys(reviewSurveyRecords);
  });
  const dialog = byId<HTMLDialogElement>("review-survey-dialog");
  const survey = surveys.find(item => item.id === selectedReviewSurveyId);
  if (!survey) {
    if (dialog.open) dialog.close();
    renderIcons();
    return;
  }
  byId("review-survey-dialog-title").textContent = survey.name;
  const entries = reviewEntries(survey).filter(({product, release}) => !productQuery || matchesSurvey(survey) || reviewProductMatches(product) || release.toLocaleLowerCase().includes(productQuery));
  const filtered = entries.filter(({product}) => reviewFilter === "all" || reviewProductState(product) === reviewFilter);
  const content = byId("review-survey-content");
  reconcileMarkup(content, `<div class="review-browser-toolbar"><div class="review-filters" aria-label="产品审核状态">${(Object.keys(reviewFilterLabels) as ReviewFilter[]).map(state => `<button type="button" class="admin-quiet" data-review-filter="${state}" aria-pressed="${reviewFilter === state}">${reviewFilterLabels[state]} <span>${state === "all" ? entries.length : entries.filter(({product}) => reviewProductState(product) === state).length}</span></button>`).join("")}</div>${survey.id.startsWith("__") ? "" : `<button type="button" class="admin-quiet" data-edit-editorial="${escapeText(survey.id)}"><i data-lucide="pencil-line"></i><span>编辑巡天文案</span></button>`}</div><div class="review-compact-list">${filtered.map(({product, release, unmatched}) => {
    const state = reviewProductState(product);
    return `<article class="review-product-row review-compact-row${state === "retired" ? " is-retired" : ""}" data-row-key="${escapeText(product.productId)}"><div class="review-compact-name"><i data-lucide="${modalityIcon(product.modality)}"></i><div><strong>${escapeText(product.name)}</strong><small>${escapeText(product.modality ?? "模态未指定")}${unmatched ? " · 待匹配目录" : ""}</small></div></div><div class="review-compact-release"><small>Release</small><span>${escapeText(release)}</span></div>${(() => { const run = productPublicationRun(product.productId); const active = run && ["queued", "building", "uploading", "verifying"].includes(run.status); const label = active ? `发布中 · ${publicationStatusLabel(run.status)}` : run?.status === "failed" ? "发布失败 · 查看详情" : reviewFilterLabels[state]; return `<span class="review-state review-state-${active ? "publishing" : run?.status === "failed" ? "failed" : state}">${active ? `<i data-lucide="loader-circle" class="button-spinner"></i>` : ""}${escapeText(label)}</span>`; })()}<div class="product-row-actions"><button type="button" class="admin-quiet" data-edit-product="${escapeText(product.productId)}"><i data-lucide="eye"></i><span>${state === "pending" ? "查看并审核" : "产品详情"}</span></button>${state === "reviewed" && !["queued", "building", "uploading", "verifying"].includes(productPublicationRun(product.productId)?.status ?? "") ? `<button type="button" class="admin-quiet" data-publish-product="${escapeText(product.productId)}" data-publish><i data-lucide="upload"></i><span>发布</span></button>` : ""}</div></article>`;
  }).join("") || '<p class="resource-empty">当前分类没有产品</p>'}</div>${(reviewFilter === "all" || reviewFilter === "pending") && survey.unmatchedBuilds?.length ? `<section class="review-registration-queue"><h5>待登记构建 · ${survey.unmatchedBuilds.length}</h5>${survey.unmatchedBuilds.map(build => `<article class="review-product-row review-compact-row"><div class="review-compact-name"><i data-lucide="box"></i><div><strong>${escapeText(build.candidateTitle ?? build.candidateId)}</strong><small>${escapeText(build.phase)}</small></div></div><div class="product-row-actions"><button type="button" class="admin-quiet" data-moc-build-details="${escapeText(build.name)}">构建详情</button><button type="button" class="admin-quiet" data-register-moc-build="${escapeText(build.name)}">登记产品</button></div></article>`).join("")}</section>` : ""}`);
  content.querySelectorAll<HTMLButtonElement>("[data-review-filter]").forEach(button => button.onclick = () => { reviewFilter = button.dataset.reviewFilter as ReviewFilter; renderReviewSurveys(reviewSurveyRecords); });
  content.querySelectorAll<HTMLButtonElement>("[data-edit-editorial]").forEach(button => button.onclick = () => void openEditorial(button.dataset.editEditorial ?? ""));
  content.querySelectorAll<HTMLButtonElement>("[data-edit-product]").forEach(button => button.onclick = () => openProduct(button.dataset.editProduct ?? ""));
  content.querySelectorAll<HTMLButtonElement>("[data-publish-product]").forEach(button => button.onclick = () => void publishProduct(button.dataset.publishProduct ?? ""));
  content.querySelectorAll<HTMLButtonElement>("[data-register-moc-build]").forEach(button => button.onclick = () => void openMocProductRegistration(button.dataset.registerMocBuild ?? ""));
  content.querySelectorAll<HTMLButtonElement>("[data-moc-build-details]").forEach(button => button.onclick = () => void openMocBuildDetails(button.dataset.mocBuildDetails ?? ""));
  if (!dialog.open) dialog.showModal();
  syncProductOperationButtons();
  applyReviewedFeedback();
}

function setExtractionFields(mode?: string): void {
  for (const [selector, visible] of [["[data-catalog-radec]", mode === "catalog-radec"], ["[data-catalog-healpix]", mode === "nested-healpix"]] as const) {
    const section = document.querySelector<HTMLElement>(selector);
    if (!section) continue;
    section.hidden = !visible;
    section.querySelectorAll<HTMLInputElement>("input").forEach((field) => {
      field.disabled = !visible;
      field.required = visible && (field.name === "raColumn" || field.name === "decColumn" || field.name === "healpixColumn");
    });
  }
}

function setTaskSubmitEnabled(enabled: boolean): void {
  const submit = byId<HTMLFormElement>("task-form").querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = !enabled;
}

function setDerivedProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  const output = byId("task-derived-summary");
  if (!product) {
    output.textContent = "选择 Catalog 产品后自动带出 survey、release、layer 和 ScanPlan v2 recipe。";
    setExtractionFields();
    setTaskSubmitEnabled(false);
    return;
  }
  const executable = Boolean(product.draft.layerId && product.draft.mode && product.draft.coverageRole && product.draft.dataOrigin && product.draft.sourceTier);
  output.textContent = `${product.draft.surveyId.toUpperCase()} / ${product.draft.releaseId} · ${product.draft.layerId ?? "未注册 layer"} · ${product.draft.modality ?? "other"} / ${product.draft.mode ?? "待 recipe"} · ${product.draft.coverageRole ?? "待 recipe"} · ${executable ? "READY" : "NOT EXECUTABLE"}`;
  const mode = product.draft.mode;
  setExtractionFields(mode);
  const taskForm = byId<HTMLFormElement>("task-form");
  const defaults = product.draft.scanDefaults ?? {};
  for (const [name, value] of Object.entries(defaults)) {
    const field = taskForm.elements.namedItem(name);
    if (field instanceof HTMLInputElement && value !== undefined) field.value = String(value);
  }
  setTaskSubmitEnabled(executable);
}

function productHistoryActionLabel(action?: string): string {
  return ({
    "moc-registration": "登记产品",
    draft: "保存草稿",
    execution: "记录执行",
    review: "审核版本",
    publish: "发布版本",
    retire: "退休产品",
    "recipe-migration": "迁移 recipe",
    "scan-defaults-migration": "迁移扫描默认值",
    "source-metadata-migration": "迁移来源事实",
  } as Record<string, string>)[action ?? ""] ?? action ?? "历史事件";
}

function productHistoryMarkup(entries: ProductHistoryEntry[]): string {
  if (!entries.length) return `<p class="resource-empty">尚无产品历史记录。</p>`;
  const visible = entries.slice(-128).reverse();
  return `<div class="product-history-list">${visible.map((entry) => {
    const accepted = Array.isArray(entry.acceptedGaps) && entry.acceptedGaps.length ? ` · 接受缺口 ${entry.acceptedGaps.length} 项` : "";
    const reason = entry.reason ? ` · ${escapeText(entry.reason)}` : "";
    return `<article class="product-history-row"><div><strong>${escapeText(productHistoryActionLabel(entry.action))}</strong><span>${entry.revision !== undefined ? `revision ${entry.revision}` : ""}${accepted}${reason}</span></div><time datetime="${escapeText(entry.at ?? "")}">${escapeText(formatDate(entry.at))}</time></article>`;
  }).join("")}</div>`;
}

async function loadProductHistory(productId: string): Promise<void> {
  const target = byId("product-history");
  target.innerHTML = `<p class="resource-empty">正在读取产品历史…</p>`;
  try {
    const response = await api<{ history: ProductHistoryEntry[]; truncated?: boolean }>(`/api/v1/admin/products/${encodeURIComponent(productId)}/history`);
    if (activeProductDialogId !== productId) return;
    const entries = Array.isArray(response.history) ? response.history : [];
    target.innerHTML = `${response.truncated ? `<p class="product-history-note">仅显示最近 ${entries.length} 条事件。</p>` : ""}${productHistoryMarkup(entries)}`;
  } catch (error) {
    if (activeProductDialogId !== productId) return;
    target.innerHTML = `<p class="resource-empty">${escapeText(error instanceof Error ? error.message : "产品历史读取失败")}</p>`;
  }
}

function readinessAction(productId: string, step: ReadinessActionStep): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  if (step === "review" && document.getElementById("product-verify-build")) {
    byId<HTMLButtonElement>("product-verify-build").click();
    return;
  }
  byId<HTMLDialogElement>("product-dialog").close();
  if (step === "scan") {
    setAdminStep("tasks");
    taskTabs.select("scans");
    byId<HTMLSelectElement>("task-product").value = productId;
    setDerivedProduct(productId);
    byId<HTMLDialogElement>("task-dialog").showModal();
    toast("先查官方单元或文件索引；确需扫描时，选择已授权的存储并填写本产品范围。");
    return;
  }
  if (step === "sources") {
    setAdminStep("sources");
    toast("已转到数据源工作区；请核对授权范围和盘点状态");
    return;
  }
  if (step === "tasks") {
    setAdminStep("tasks");
    taskTabs.select("discovery");
    const build = mocBuildRecords.find((entry) => entry.productId === productId);
    if (build) { void openMocReview(build.discoveryRequestName); return; }
    const select = byId<HTMLSelectElement>("moc-product");
    select.value = productId;
    const form = byId<HTMLFormElement>("moc-discovery-form");
    setRegistrationField(form, "surveyName", product.draft.publicSurvey?.name ?? product.draft.surveyId);
    setRegistrationField(form, "releaseHint", product.draft.releaseId);
    setRegistrationField(form, "productHint", product.draft.name);
    renderDiscoveryProductTree();
    byId<HTMLDialogElement>("moc-discovery-dialog").showModal();
    return;
  }
  if (step === "releases") {
    setAdminStep("releases");
    void loadPublicationPlan();
    toast("已转到发布与验证工作区");
    return;
  }
  selectedReviewSurveyId = product.draft.surveyId;
  setAdminStep("review");
  renderReviewSurveys(reviewSurveyRecords);
  window.setTimeout(() => openProduct(productId), 0);
}

async function retireProduct(productId: string): Promise<void> {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product || product.retiredAt) return;
  const reason = window.prompt("请输入退休原因（可选）", product.retirementReason ?? "");
  if (reason === null) return;
  if (!window.confirm(`确认退休产品“${product.draft.name}”吗？公开内容会隐藏，但历史发布记录会保留。`)) return;
  try {
    await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/retire`, {
      method: "POST",
      body: JSON.stringify({ revision: product.revision, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    });
    activeProductDialogId = "";
    if (byId<HTMLDialogElement>("product-dialog").open) byId<HTMLDialogElement>("product-dialog").close();
    toast("产品已退休，公开目录和覆盖已隐藏");
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : "产品退休失败", true);
  }
}

function openProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  activeProductDialogId = productId;
  const productPath = routePath({ step: "review", productId });
  if (location.pathname !== productPath) history.pushState(null, "", productPath);
  const form = byId<HTMLFormElement>("product-form");
  const facts = byId("product-public-facts");
  const publicProduct = reviewSurveyRecords.flatMap((survey) => survey.releases.flatMap((release) => release.products)).find((entry) => entry.productId === productId);
  const mocBuild = product.mocBuild ?? publicProduct?.mocBuild;
  const lifecycle = product.lifecycle ?? publicProduct?.lifecycle;
  const runtimeInvalid = lifecycle?.runtime?.state === "INVALID";
  const reload = runtimeInvalid ? `<button type="button" class="admin-quiet lifecycle-reload" data-reload-catalog title="Reload runtime Catalog"><i data-lucide="rotate-cw"></i><span>Reload Catalog</span></button>` : "";
  const retired = Boolean(product.retiredAt);
  const retirement = retired ? `<div class="product-retirement-notice"><strong>产品已退休</strong><span>${escapeText(product.retirementReason ?? "未填写退休原因")} · ${escapeText(formatDate(product.retiredAt))}</span></div>` : "";
  facts.innerHTML = `<div class="section-heading"><div><span class="section-index">PUBLIC FACTS</span><h4>${escapeText(product.draft.name)}</h4></div><span class="section-note">read-only · /surveys/ source</span></div><dl class="product-fact-grid">${detailValue("survey", product.draft.surveyId)}${detailValue("release", product.draft.releaseId)}${detailValue("modality", publicProduct?.modality ?? product.draft.modality)}${detailValue("catalog status", publicProduct?.status)}${detailValue("description", publicProduct?.description)}${detailValue("coverage orders", (publicProduct?.coverage?.availableOrders ?? product.coverage?.availableOrders ?? product.draft.coverage?.availableOrders)?.map((order) => `O${order}`).join(" / "))}${detailValue("layer", publicProduct?.coverage?.layerId ?? product.draft.layerId)}${detailValue("MOC build", mocBuildStatusText(mocBuild) || "not started")}${detailValue("review", product.review?.revision === product.revision ? `已审核 ${formatDate(product.review.reviewedAt)}` : "当前版本未审核")}</dl>${retirement}${readinessDetailMarkup(product.readiness)}${executionEvidenceMarkup(product.executionEvidence, product.revision)}${lifecycleMarkup(lifecycle, retired ? "RETIRED" : product.published ? "PUBLISHED" : "DRAFT", mocBuild?.outputs?.availableOrders)}${lifecycleLinksMarkup(product.lifecycle)}${reload}<section class="product-history"><div class="section-heading"><div><span class="section-index">AUDIT HISTORY</span><h4>产品历史</h4></div><span class="section-note">按需读取</span></div><div id="product-history" class="product-history-content"><p class="resource-empty">正在读取产品历史…</p></div></section>`;
  facts.querySelector<HTMLButtonElement>("[data-reload-catalog]")?.addEventListener("click", (event) => void reloadCatalogRuntime(event.currentTarget as HTMLButtonElement));
  facts.querySelectorAll<HTMLButtonElement>("[data-readiness-action]").forEach((button) => button.addEventListener("click", () => readinessAction(productId, button.dataset.readinessAction as ReadinessActionStep)));
  (form.elements.namedItem("productId") as HTMLInputElement).value = productId;
  (form.elements.namedItem("summaryMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.summaryMarkdown;
  (form.elements.namedItem("methodologyMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.methodologyMarkdown;
  (form.elements.namedItem("limitationsMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.limitationsMarkdown;
  (form.elements.namedItem("flowNodes") as HTMLTextAreaElement).value = JSON.stringify(product.draft.presentation.flow.nodes, null, 2);
  for (const [name, value] of Object.entries({ dataOrigin: product.draft.dataOrigin, sourceTier: product.draft.sourceTier, originNote: product.draft.originNote, sourceLabel: product.draft.sourceLabel, sourceUrl: product.draft.sourceUrl, geometrySourceLabel: product.draft.geometrySourceLabel, geometrySourceUrl: product.draft.geometrySourceUrl })) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.value = value ?? "";
  }
  byId("product-dialog-title").textContent = retired ? `${product.draft.name} · 已退休` : `${product.draft.name} · 详情与证据`;
  const edit = byId<HTMLDetailsElement>("product-edit-content");
  edit.open = false;
  edit.hidden = retired;
  edit.ontoggle = () => { byId<HTMLButtonElement>("product-save-draft").hidden = !edit.open || retired; };
  const publishButton = byId<HTMLButtonElement>("product-dialog-publish");
  publishButton.hidden = Boolean(product.published) || retired;
  publishButton.dataset.publishProduct = productId;
  const reviewButton = byId<HTMLButtonElement>("product-dialog-review");
  reviewButton.hidden = product.review?.revision === product.revision || retired;
  reviewButton.dataset.reviewProduct = productId;
  reviewButton.title = product.review?.revision === product.revision ? "当前 revision 已审核" : "将当前草稿 revision 记为已审核";
  const gaps = product.readiness?.draft.gaps ?? [];
  const blocking = gaps.filter((gap) => gapGuidance[gap]?.blocking);
  const preflight = byId("product-review-preflight");
  preflight.innerHTML = `<div class="review-preflight-summary"><h4>发布前检查</h4><span>${blocking.length ? `${blocking.length} 项待解决` : "发布门禁已通过"}</span></div>${gaps.map(gap => {
    const guide = gapGuidance[gap];
    const action = readinessActionForGap(gap);
    const verify = Boolean(mocBuild) && ["output-validation-missing", "execution-record-missing", "validated-coverage-missing"].includes(gap);
    const step = gap === "output-validation-missing" && !mocBuild ? "tasks" : action.step;
    return `<div class="preflight-item ${guide?.blocking ? "is-blocking" : "is-pending"}"><i data-lucide="${guide?.blocking ? "circle-alert" : "circle-dot"}"></i><div><strong>${escapeText(guide?.title ?? gap)}</strong><p>${escapeText(guide?.description ?? "查看产品证据与能力限制。")}</p></div><button type="button" class="admin-quiet" ${verify ? "data-preflight-verify" : `data-preflight-step="${step}"`}>${verify ? "校验已有构建" : step === "tasks" ? "选择候选并构建" : escapeText(action.label)}</button></div>`;
  }).join("")}${!blocking.length ? `<div class="preflight-item is-passed"><i data-lucide="circle-check"></i><span>来源与输出门禁已满足，请确认当前版本的能力与限制。</span></div>` : ""}${mocBuild ? `<button type="button" class="admin-quiet" id="product-verify-build">重新校验来源与输出</button>` : ""}${gaps.length && !blocking.length ? `<label><input type="checkbox" id="review-accept-limitations" /><span>我已阅读能力限制，同意按当前可证实能力发布；隔离恢复由发布流程执行。</span></label>` : ""}`;
  preflight.querySelectorAll<HTMLButtonElement>("[data-preflight-step]").forEach(button => button.addEventListener("click", () => readinessAction(productId, button.dataset.preflightStep as ReadinessActionStep)));
  preflight.querySelectorAll<HTMLButtonElement>("[data-preflight-verify]").forEach(button => button.addEventListener("click", () => document.getElementById("product-verify-build")?.click()));
  reviewButton.disabled = blocking.length > 0 || gaps.length > 0;
  document.getElementById("review-accept-limitations")?.addEventListener("change", (event) => { reviewButton.disabled = !(event.target as HTMLInputElement).checked; });
  document.getElementById("product-verify-build")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "正在校验来源与输出…";
    try {
      const result = await api<{ verification: { passed: boolean; error?: string } }>(`/api/v1/admin/products/${encodeURIComponent(productId)}/verify-build`, { method: "POST", body: JSON.stringify({ revision: product.revision }) });
      byId<HTMLDialogElement>("product-dialog").close();
      await refresh();
      openProduct(productId);
      setMessage("product", result.verification.passed ? "来源与输出校验通过，证据已记录。" : result.verification.error ?? "校验失败", !result.verification.passed);
    } catch (error) { setMessage("product", error instanceof Error ? error.message : "校验失败", true); button.disabled = false; button.textContent = "重新校验已有构建"; }
  });
  const retireButton = byId<HTMLButtonElement>("product-dialog-retire");
  retireButton.hidden = retired || !product.published;
  retireButton.dataset.retireProduct = productId;
  const editableFields = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]), select, textarea");
  editableFields.forEach((field) => { field.disabled = retired; });
  byId<HTMLDialogElement>("product-dialog").showModal();
  syncProductOperationButtons();
  void loadProductHistory(productId);
}

function guessedSurveyId(build: ReviewMocBuild | MocBuildRequest): string {
  const tokens = `${build.candidateId} ${build.candidateTitle ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.find((token) => !["cds", "p", "moc", "main", "source", "public"].includes(token) && !/^dr\d+$/.test(token)) ?? "";
}

function mocBuildSourceUrl(build: ReviewMocBuild | MocBuildRequest): string | undefined {
  return "source" in build ? build.source.url : build.sourceUrl;
}

function setRegistrationField(form: HTMLFormElement, name: string, value: string | number | undefined): void {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.value = value === undefined ? "" : String(value);
}

async function openMocProductRegistration(name: string): Promise<void> {
  const listedBuild = mocBuildRecords.find((entry) => entry.name === name);
  if (!listedBuild || listedBuild.phase !== "STAGED" || listedBuild.productId) return;
  try {
    const response = await api<{ request: MocBuildRequest; registrationDefaults?: MocRegistrationDefaults; surveyFacts?: { surveyId: string; surveyName: string; mission: string; surveyDescription: string } }>(`/api/v1/admin/moc-builds/${encodeURIComponent(name)}`);
    const build = response.request;
    if (build.phase !== "STAGED" || build.productId) return;
    const defaults = response.registrationDefaults ?? {
      releaseId: build.releaseId ?? "public",
      releaseLabel: build.releaseId?.toUpperCase() ?? "Public MOC",
      releaseKind: "release",
      productName: build.candidateTitle ?? build.candidateId,
      productDescription: `${build.candidateTitle ?? build.candidateId} 的公开天区覆盖 MOC；来源为 CDS MOC 服务，已由 Assets 校验并锁定来源哈希。`,
      productStatus: "acquired",
      modality: "imaging",
      dataOrigin: "observed",
    };
    const form = byId<HTMLFormElement>("moc-product-register-form");
    form.reset();
    setRegistrationField(form, "buildName", build.name);
    const sourceUrl = mocBuildSourceUrl(build);
    if (!response.surveyFacts || !response.registrationDefaults) throw new Error("登记事实暂不可读取，请恢复探索记录后重试；无需手工填写巡天事实。");
    byId("moc-product-register-build-facts").innerHTML = `<section class="registration-summary"><h4>${escapeText(defaults.productName)}</h4><p>确认将已构建结果登记为产品。巡天信息由系统统一继承，来源与精度取自本次构建。</p><dl class="product-fact-grid">${detailValue("巡天", response.surveyFacts.surveyName)}${detailValue("项目", response.surveyFacts.mission)}${detailValue("巡天简介", response.surveyFacts.surveyDescription)}${detailValue("数据发布 / 集合", defaults.releaseLabel)}${detailValue("产品", defaults.productName)}${detailValue("来源", sourceUrl)}${detailValue("覆盖精度", build.outputs?.availableOrders?.map((order) => `O${order}`).join(" / "))}</dl><p>登记后进入产品详情检查证据，再确认审核与发布。</p></section>`;
    const buildDialog = byId<HTMLDialogElement>("moc-build-detail-dialog");
    if (buildDialog.open) buildDialog.close();
    byId<HTMLDialogElement>("moc-product-register-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "MOC 登记默认值加载失败", true); }
}

async function submitMocProductRegistration(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const buildName = formValue(form, "buildName");
  if (!buildName) return;
  setMessage("moc-registration", "正在登记产品…");
  try {
    const response = await api<{ product: Product; request: MocBuildRequest }>(`/api/v1/admin/moc-builds/${encodeURIComponent(buildName)}/register-product`, { method: "POST", body: "{}" });
    byId<HTMLDialogElement>("moc-product-register-dialog").close();
    toast(`已登记产品 ${response.product.draft.name}`);
    await refresh();
  } catch (error) { setMessage("moc-registration", error instanceof Error ? error.message : "登记失败", true); }
}

async function saveProduct(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const product = productRecords.find((entry) => entry.productId === formValue(form, "productId"));
  if (!product) return;
  const nodes = product.draft.presentation.flow.nodes;
  const content = { ...product.draft, dataOrigin: formValue(form, "dataOrigin") || undefined, sourceTier: formValue(form, "sourceTier") || undefined, originNote: formValue(form, "originNote") || undefined, sourceLabel: formValue(form, "sourceLabel") || undefined, sourceUrl: formValue(form, "sourceUrl") || undefined, geometrySourceLabel: formValue(form, "geometrySourceLabel") || undefined, geometrySourceUrl: formValue(form, "geometrySourceUrl") || undefined, presentation: { summaryMarkdown: formValue(form, "summaryMarkdown"), methodologyMarkdown: formValue(form, "methodologyMarkdown"), limitationsMarkdown: formValue(form, "limitationsMarkdown"), flow: { nodes, edges: product.draft.presentation.flow.edges } } };
  try { await api(`/api/v1/admin/products/${encodeURIComponent(product.productId)}/draft`, { method: "PUT", body: JSON.stringify({ revision: product.revision, content }) }); byId<HTMLDialogElement>("product-dialog").close(); toast("产品草稿已保存"); await refresh(); } catch (error) { setMessage("product", error instanceof Error ? error.message : "保存失败", true); }
}

const productOperations = new Map<string, "review" | "publish">();
const operationButtonOriginals = new WeakMap<HTMLButtonElement, { html: string; disabled: boolean }>();
const reviewedFeedback = new Map<string, number>();

function syncProductOperationButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-review-product], [data-publish-product]").forEach(button => {
    const id = button.dataset.reviewProduct ?? button.dataset.publishProduct ?? "";
    const run = publicationRuns.find(r => r.selectedProducts?.some(p => p.productId === id));
    const pending = run && ["queued", "building", "uploading", "verifying"].includes(run.status);
    const operation = productOperations.get(id) ?? (pending ? "publish" : undefined);
    if (operation) {
      if (!operationButtonOriginals.has(button)) operationButtonOriginals.set(button, { html: button.innerHTML, disabled: button.disabled });
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      const isThisAction = operation === "publish" ? Boolean(button.dataset.publishProduct) : Boolean(button.dataset.reviewProduct);
      if (isThisAction) button.innerHTML = `<i data-lucide="loader-circle" class="button-spinner"></i><span>${operation === "publish" ? pending ? publicationStatusLabel(run.status) : "正在提交…" : "正在审核…"}</span>`;
    } else {
      const original = operationButtonOriginals.get(button);
      if (original) { button.innerHTML = original.html; button.disabled = original.disabled; operationButtonOriginals.delete(button); }
      button.removeAttribute("aria-busy");
    }
  });
  renderIcons();
}

function reviewedProductRow(productId: string): HTMLElement | null {
  return document.querySelector(`[data-edit-product="${CSS.escape(productId)}"]`)?.closest<HTMLElement>(".review-product-row") ?? null;
}

function applyReviewedFeedback(): void {
  for (const [id, started] of reviewedFeedback) {
    const row = reviewedProductRow(id);
    if (!row) continue;
    if (Date.now() - started >= 5000) { row.classList.remove("review-confirmed"); row.style.removeProperty("animation-delay"); continue; }
    if (!row.classList.contains("review-confirmed")) { row.classList.add("review-confirmed"); row.style.animationDelay = `-${Date.now() - started}ms`; }
  }
}

function revealReviewedProduct(productId: string): void {
  reviewFilter = "reviewed";
  const owner = reviewSurveyRecords.find(survey => survey.releases.some(release => release.products.some(product => product.productId === productId)) || survey.unmatchedProducts?.some(product => product.productId === productId));
  if (owner) selectedReviewSurveyId = owner.id;
  renderReviewSurveys(reviewSurveyRecords);
  if (!reviewedProductRow(productId) && productQuery) { productQuery = ""; byId<HTMLInputElement>("product-search").value = ""; renderReviewSurveys(reviewSurveyRecords); }
  const row = reviewedProductRow(productId);
  if (!row) return;
  const started = Date.now();
  reviewedFeedback.set(productId, started);
  applyReviewedFeedback();
  row.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  row.querySelector<HTMLButtonElement>("[data-edit-product]")?.focus({ preventScroll: true });
  window.setTimeout(() => { if (reviewedFeedback.get(productId) === started) { applyReviewedFeedback(); reviewedFeedback.delete(productId); } }, 5050);
}

async function reviewProduct(productId: string): Promise<void> {
  if (productOperations.has(productId)) return;
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  const gaps = product.readiness?.draft.gaps ?? [];
  if (gaps.some((gap) => gapGuidance[gap]?.blocking)) { setMessage("product", "请先完成上方标注的必需校验，再确认审核。", true); return; }
  if (gaps.length && !byId<HTMLInputElement>("review-accept-limitations").checked) return;
  productOperations.set(productId, "review");
  syncProductOperationButtons();
  try {
    await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/review`, { method: "POST", body: JSON.stringify({ revision: product.revision, acceptedGaps: gaps }) });
    toast(`${product.draft.name} · 版本 ${product.revision} 已审核`);
    if (activeProductDialogId === productId && byId<HTMLDialogElement>("product-dialog").open) byId<HTMLDialogElement>("product-dialog").close();
    if (refreshInFlight) await refreshInFlight;
    await refresh();
    if (activeStep === "review" && !document.querySelector("dialog[open]:not(#review-survey-dialog)")) revealReviewedProduct(productId);
  } catch (error) { toast(error instanceof Error ? error.message : "审核失败", true); }
  finally { productOperations.delete(productId); syncProductOperationButtons(); }
}

async function publishProduct(productId: string): Promise<void> {
  if (productOperations.has(productId)) return;
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  productOperations.set(productId, "publish");
  syncProductOperationButtons();
  try {
    const { run } = await api<{run:PublicationRun}>(`/api/v1/admin/products/${encodeURIComponent(productId)}/publish`, { method: "POST", body: JSON.stringify({ revision: product.revision }) });
    if (activeProductDialogId === productId && byId<HTMLDialogElement>("product-dialog").open) byId<HTMLDialogElement>("product-dialog").close();
    publicationRuns = [run, ...publicationRuns.filter(r => r.runId !== run.runId)];
    toast(`${product.draft.name} · 发布已提交，正在同步该产品产物；站点生效后才会公开`);
    if (refreshInFlight) await refreshInFlight;
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "发布失败", true); }
  finally { productOperations.delete(productId); syncProductOperationButtons(); }
}

async function reloadCatalogRuntime(button?: HTMLButtonElement): Promise<void> {
  if (button) button.disabled = true;
  try {
    const response = await api<{ catalog: CatalogStatus }>("/api/v1/admin/catalog/reload", { method: "POST" });
    toast(`Coverage 已重载：${response.catalog.footprints} footprints · ${response.catalog.revision ?? "revision unknown"}`);
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Coverage reload 失败", true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function refresh(background = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const version = ++refreshVersion;
  const step = activeStep;
  const button = byId<HTMLButtonElement>("refresh-button");
  if (!background) button.disabled = true;
  byId("refresh-state").textContent = background ? "" : "正在更新…";
  refreshInFlight = (async () => {
    if (step === "review" || step === "overview") await loadPublicationRuns();
    const keys = [...new Set([...workspaceResources[step], ...(!resourceCache.has("overview") ? ["overview" as const] : [])])];
    const results = await workspaceRequests.load(keys, (url, signal) => api(url, { signal }));
    if (!results || version !== refreshVersion || !token) return;
    let failures = 0;
    let changed = false;
    for (const result of results) {
      if (result.status === "rejected") { failures++; continue; }
      const { key, value } = result.value;
      resourceCache.set(key, value);
      if (renderedSignatures.get(key) !== businessSignature(value)) changed = true;
    }
    // The survey browser displays live records; only detail/edit dialogs freeze snapshots.
    if (document.querySelector("dialog[open]:not(#review-survey-dialog)")) {
      if (activeMocReviewRequest && byId<HTMLDialogElement>("moc-review-dialog").open) {
        const latest = (resourceCache.get("mocDiscovery") as { requests?: MocDiscoveryRequest[] } | undefined)?.requests?.find(request => request.name === activeMocReviewRequest?.name);
        const unavailable = results.some((result, index) => keys[index] === "mocDiscovery" && result.status === "rejected");
        updateMocObservation(latest ?? activeMocReviewRequest, unavailable);
      }
      pendingUpdates ||= changed;
      byId("refresh-state").textContent = pendingUpdates ? "有更新；关闭弹框后显示" : "";
      return;
    }
    const apply = <T>(key: Resource, render: (value: T) => void) => {
      const value = resourceCache.get(key);
      if (value === undefined) return;
      const signature = businessSignature(value);
      if (renderedSignatures.get(key) === signature) return;
      render(value as T); renderedSignatures.set(key, signature);
    };
    apply<AdminOverview>("overview", renderOverview);
    apply<{ products: Product[] }>("products", data => renderProducts(data.products));
    apply<{ surveys: ReviewSurvey[] }>("reviewSurveys", data => renderReviewSurveys(data.surveys));
    if (step === "sources" || step === "tasks") apply<{ connectors: Connector[] }>("connectors", data => renderConnectors(data.connectors));
    if (step === "tasks" || step === "review") {
      apply<{ requests: MocBuildRequest[] }>("mocBuilds", data => { mocBuildRecords = data.requests; renderWorkOutputs(taskRecords, mocDiscoveryRecords, mocBuildRecords); });
      if (step === "tasks") {
        apply<{ tasks: Task[] }>("tasks", data => renderTasks(data.tasks));
        apply<{ requests: MocDiscoveryRequest[] }>("mocDiscovery", data => renderMocDiscoveryRequests(data.requests));
      }
    }
    const count = (key: Resource, value: number): number | string => {
      if (resourceCache.has(key)) return value;
      const overviewCounts: Partial<Record<Resource, number | undefined>> = {
        connectors: overviewRecord?.connectors.length,
        tasks: overviewRecord?.workflows.tasks.total,
        mocDiscovery: overviewRecord?.workflows.discovery.total,
        mocBuilds: overviewRecord?.workflows.builds.total,
        products: overviewRecord?.totals.products,
      };
      return overviewCounts[key] ?? "—";
    };
    const status = '连接 ' + count("connectors", connectorRecords.length) + ' · 扫描 ' + count("tasks", taskRecords.length) + ' · 探索 ' + count("mocDiscovery", mocDiscoveryRecords.length) + ' · 构建 ' + count("mocBuilds", mocBuildRecords.length) + ' · 产品 ' + count("products", productRecords.length);
    if (byId("admin-status").textContent !== status) byId("admin-status").textContent = status;
    byId("step-sources-count").textContent = String(count("connectors", connectorRecords.length));
    const scanCount = count("tasks", taskRecords.length);
    const discoveryCount = count("mocDiscovery", mocDiscoveryRecords.length);
    byId("step-tasks-count").textContent = typeof scanCount === "number" && typeof discoveryCount === "number" ? String(scanCount + discoveryCount) : "—";
    byId("step-review-count").textContent = String(reviewSurveyRecords.length);
    pendingUpdates = false;
    byId("refresh-state").textContent = failures ? "部分数据更新失败，保留上次结果" : "";
    if (!failures) byId("refresh-time").textContent = '上次更新 ' + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (step === "releases") { await loadPublicationRuns(); if (!background || !publicationPlan) await loadPublicationPlan(); }
    const route = parseAdminRoute(location.pathname);
    if (route?.productId && !document.querySelector("dialog[open]")) {
      if (productRecords.some(product => product.productId === route.productId)) openProduct(route.productId);
      else byId("refresh-state").textContent = "产品未找到";
    }
  })().catch(error => {
    if (version === refreshVersion) byId("refresh-state").textContent = error instanceof Error ? error.message : "更新失败，保留上次结果";
  }).finally(() => {
    if (version === refreshVersion) { button.disabled = false; refreshInFlight = null; schedulePolling(); }
  });
  return refreshInFlight;
}

interface PublicationPlanSurvey {
  surveyId: string;
  publishedLayers: number;
  changedProducts: number;
  productDiffs?: Array<{ productId: string; releaseId: string; name: string; change: string; fields: string[]; draftRevision: number; publishedRevision: number | null; reviewed: boolean; blockingReason?: string }>;
  currentPackage?: { id: string; version: string } | null;
  changed: boolean;
  blockers: string[];
  selectable: boolean;
}

interface PublicationPlan {
  planId: string;
  baselineBundle: { id: string; sha256: string };
  surveys: PublicationPlanSurvey[];
  changedSurveyIds: string[];
  dynamicPackages: number;
  dynamicLayers: number;
  createdAt: string;
}

interface PublicationRun {
  queue?: { phase: string; attempts: number; nextAttemptAt?: string; cancellable: boolean; syncDelayed: boolean };
  selectedProducts?: Array<{productId:string;revision:number}>;
  manifestKey?: string;
  runId: string;
  planId: string;
  surveyIds: string[];
  status: string;
  requestedBy?: string;
  createdAt: string;
  claimedAt?: string;
  lastProgressAt?: string;
  finishedAt?: string;
  bundle?: { id: string; sha256: string };
  archiveKey?: string;
  archiveSha256?: string;
  files?: number;
  packages?: number;
  error?: string;
  failureStage?: "build" | "upload" | "candidate" | "activate";
  recovery?: { detectedAt: string; reason: string };
  verification?: { overall?: string; candidate?: { state?: string; checkedAt?: string; bundleSha256?: string; error?: string }; authority?: { state?: string; checkedAt?: string; bundleSha256?: string; error?: string }; site?: { state?: string; target?: string; checkedAt?: string; observedBundleSha256?: string; checkedProducts?: number; error?: string } };
}

let publicationPlan: PublicationPlan | null = null;
const selectedPublicationSurveys = new Set<string>();
const selectedPublicationProducts = new Set<string>();
let publicationRuns: PublicationRun[] = [];


function publicationStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: "排队中", building: "构建中", uploading: "上传中", verifying: "隔离验证中", published: "发布完成", failed: "失败", cancelled: "已取消" };
  return labels[status] ?? status;
}

function publicationRunStatusLabel(run: PublicationRun): string {
  if (run.status === "published" && !run.queue && run.verification?.overall !== "verified") return "权威已发布";
  if (run.queue?.phase === "site-pending") return run.queue.syncDelayed ? "网站同步延迟，正在重试" : "等待网站生效";
  if (run.queue?.nextAttemptAt) return `等待自动重试（第 ${run.queue.attempts} 次尝试已结束）`;
  return run.recovery ? "任务中断，可恢复" : publicationStatusLabel(run.status);
}

function publicationVerificationLabel(state?: string): string {
  return ({ pending: "待核验", passed: "已通过", failed: "失败", "not-configured": "未配置目标", "site-pending": "站点待生效", verified: "闭环完成", "authority-published": "权威已发布" } as Record<string, string>)[state ?? ""] ?? (state || "未知");
}

function publicationFailureStageLabel(stage?: string): string {
  return ({ build: "构建", upload: "上传", candidate: "候选隔离验证", activate: "权威指针切换" } as Record<string, string>)[stage ?? ""] ?? (stage || "--");
}

async function loadPublicationPlan(): Promise<void> {
  try {
    const step = activeStep;
    const version = refreshVersion;
    const { plan } = await api<{ plan: PublicationPlan }>("/api/v1/admin/publication-plan");
    if (step !== activeStep || version !== refreshVersion) return;
    if (businessSignature(plan) === businessSignature(publicationPlan)) return;
    publicationPlan = plan;
    for (const surveyId of [...selectedPublicationSurveys]) {
      if (!plan.surveys.some((survey) => survey.surveyId === surveyId && survey.selectable)) selectedPublicationSurveys.delete(surveyId);
    }
    renderPublicationPlan();
  } catch (error) {
    if (!publicationPlan) byId("publication-plan-list").innerHTML = `<tr><td colspan="8" class="resource-empty">${escapeText(error instanceof Error ? error.message : "发布计划读取失败")}</td></tr>`;
    byId("publication-plan-summary").textContent = publicationPlan ? "发布计划更新失败，保留上次结果；提交时仍检查版本" : "发布计划不可用";
  }
}

function renderPublicationPlan(): void {
  const plan = publicationPlan;
  if (!plan) return;
  const changed = plan.surveys.filter((survey) => survey.changed);
  byId("step-releases-count").textContent = String(changed.length);
  byId("publication-plan-summary").textContent = `${plan.surveys.length} 巡天 · ${changed.length} 有变化 · ${plan.dynamicPackages} 资源包 · ${plan.dynamicLayers} 图层 · 基线 ${plan.baselineBundle.id.slice(0, 24)}…`;
  const body = byId("publication-plan-list");
  if (plan.surveys.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="resource-empty">当前没有动态发布数据</td></tr>`;
    updatePublicationPublishButton();
    return;
  }
  body.innerHTML = plan.surveys.map((survey) => {
    const checked = selectedPublicationSurveys.has(survey.surveyId);
    const checkbox = survey.selectable
      ? `<input type="checkbox" data-publication-survey="${escapeText(survey.surveyId)}" ${checked ? "checked" : ""} />`
      : `<button type="button" class="admin-quiet" data-publication-blocked="${escapeText(survey.surveyId)}" aria-label="查看不能选择的原因">不可选 · 原因</button>`;
    const blockers = survey.blockers.length ? survey.blockers.map((blocker) => escapeText(blocker)).join("<br>") : "—";
    const diffs = (survey.productDiffs ?? []).map((diff) => `<label><input type="checkbox" data-publication-product="${escapeText(diff.productId)}" data-survey="${escapeText(survey.surveyId)}" ${diff.reviewed?"":"disabled"} ${selectedPublicationProducts.has(diff.productId)?"checked":""}> ${diff.change === "added" ? "新增" : diff.change === "removed" ? "移除" : "修改"} ${escapeText(diff.name)} · r${diff.draftRevision} · ${escapeText(diff.fields.join(", "))} · ${diff.reviewed ? "已审核" : "待审核"}${diff.blockingReason ? ` · ${escapeText(diff.blockingReason)}` : ""}</label>`).join("<br>") || "—";
    return `<tr${survey.changed ? ' data-changed="true"' : ""}><td>${checkbox}</td><td>${escapeText(survey.surveyId)}</td><td>${survey.publishedLayers}</td><td>${survey.changedProducts}</td><td>${diffs}</td><td>${survey.currentPackage ? `${escapeText(survey.currentPackage.id)}<br><small>${escapeText(survey.currentPackage.version)}</small>` : "—"}</td><td>${survey.changed ? "是" : "否"}</td><td>${blockers}</td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLButtonElement>("[data-publication-blocked]").forEach(button=>button.onclick=()=>{
    const survey=plan.surveys.find(s=>s.surveyId===button.dataset.publicationBlocked);
    window.alert(`${survey?.surveyId??"巡天"} 暂时不能发布：\n${survey?.blockers.join("\n")??"请先审核当前产品版本"}`);
  });
  body.querySelectorAll<HTMLInputElement>("[data-publication-survey]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedPublicationSurveys.add(checkbox.dataset.publicationSurvey ?? "");
      else selectedPublicationSurveys.delete(checkbox.dataset.publicationSurvey ?? "");
      for(const diff of plan.surveys.find(s=>s.surveyId===checkbox.dataset.publicationSurvey)?.productDiffs??[]){if(diff.reviewed){if(checkbox.checked)selectedPublicationProducts.add(diff.productId);else selectedPublicationProducts.delete(diff.productId);}}
      renderPublicationPlan();
    });
  });
  body.querySelectorAll<HTMLInputElement>("[data-publication-product]").forEach(input=>input.onchange=()=>{if(input.checked)selectedPublicationProducts.add(input.dataset.publicationProduct!);else selectedPublicationProducts.delete(input.dataset.publicationProduct!);selectedPublicationSurveys.clear();for(const survey of plan.surveys)if(survey.productDiffs?.some(p=>selectedPublicationProducts.has(p.productId)))selectedPublicationSurveys.add(survey.surveyId);updatePublicationPublishButton();});
  updatePublicationPublishButton();
}

function updatePublicationPublishButton(): void {
  byId<HTMLButtonElement>("publication-publish-button").disabled = selectedPublicationProducts.size === 0;
}

async function publishSelectedSurveys(): Promise<void> {
  const plan = publicationPlan;
  if (!plan || selectedPublicationSurveys.size === 0) return;
  const button = byId<HTMLButtonElement>("publication-publish-button");
  button.disabled = true;
  try {
    const { run } = await api<{ run: PublicationRun }>("/api/v1/admin/publications", {
      method: "POST",
      body: JSON.stringify({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: [...selectedPublicationSurveys], productIds:[...selectedPublicationProducts] }),
    });
    selectedPublicationSurveys.clear(); selectedPublicationProducts.clear();
    toast(`发布任务已提交：${run.runId}`);
    publicationRuns = [run, ...publicationRuns];
    renderPublicationRuns();
    publicationTabs.select("runs", true);
    schedulePublicationPolling(run.runId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布提交失败", true);
  } finally {
    updatePublicationPublishButton();
  }
}

async function loadPublicationRuns(): Promise<void> {
  try {
    const step = activeStep;
    const version = refreshVersion;
    const { runs } = await api<{ runs: PublicationRun[] }>("/api/v1/admin/publications");
    if (step !== activeStep || version !== refreshVersion) return;
    const incoming = Array.isArray(runs) ? runs : [];
    if (businessSignature(incoming) !== businessSignature(publicationRuns)) { publicationRuns = incoming; renderPublicationRuns(); if (activeStep === "review") renderReviewSurveys(reviewSurveyRecords); }
    syncProductOperationButtons();
    if (byId<HTMLDialogElement>("publication-run-dialog").open) {
      const currentId = byId("publication-run-title").textContent?.replace("发布详情 · ", "");
      const current = publicationRuns.find(r => r.runId === currentId);
      if (current) openPublicationRun(current);
    }
    const active = publicationRuns.find((run) => run.status === "queued" || run.status === "building" || run.status === "uploading" || run.status === "verifying");
    if (active) schedulePublicationPolling(active.runId);
  } catch (error) {
    if (!publicationRuns.length) byId("publication-run-list").innerHTML = `<tr><td colspan="7" class="resource-empty">${escapeText(error instanceof Error ? error.message : "发布记录读取失败")}</td></tr>`;
    byId("refresh-state").textContent = "发布记录更新失败，保留上次结果";
  }
}

function renderPublicationRuns(): void {
  const body = byId("publication-run-list");
  if (publicationRuns.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="resource-empty">尚未提交发布任务</td></tr>`;
    return;
  }
  body.innerHTML = publicationRuns.map((run) => `<tr><td>${escapeText(run.runId)}</td><td>${escapeText(publicationRunStatusLabel(run))}<br><small>${escapeText(publicationVerificationLabel(run.verification?.overall))}</small></td><td>${escapeText(run.surveyIds.join(", "))}</td><td>${run.bundle ? `${escapeText(run.bundle.id)}<br><small>${escapeText(run.bundle.sha256.slice(0, 16))}…</small>` : "—"}</td><td>${run.files ?? "--"}</td><td>${escapeText(formatDate(run.createdAt))}</td><td><button type="button" class="admin-quiet" data-publication-run="${escapeText(run.runId)}">详情</button>${run.recovery ? `<button type="button" class="admin-primary" data-recover-publication="${escapeText(run.runId)}"><i data-lucide="refresh-cw"></i><span>恢复并重试</span></button>` : ""}</td></tr>`).join("");
  body.querySelectorAll<HTMLButtonElement>("[data-publication-run]").forEach((button) => {
    button.addEventListener("click", () => {
      const run = publicationRuns.find((item) => item.runId === button.dataset.publicationRun);
      if (run) openPublicationRun(run);
    });
  });
  body.querySelectorAll<HTMLButtonElement>("[data-recover-publication]").forEach((button) => {
    button.addEventListener("click", () => void recoverPublicationRun(button.dataset.recoverPublication ?? ""));
  });
  renderIcons();
}

function openPublicationRun(run: PublicationRun): void {
  byId("publication-run-title").textContent = `发布详情 · ${run.runId}`;
  const facts = [
    ["状态", publicationRunStatusLabel(run)],
    ["巡天", run.surveyIds.join(", ")],
    ["Bundle", run.bundle ? `${run.bundle.id} / ${run.bundle.sha256}` : "—"],
    ["发布清单", run.manifestKey ?? run.archiveKey ?? "—"],
    ...(run.archiveSha256 ? [["历史归档 SHA-256", run.archiveSha256]] : []),
    ["文件 / 资源包", `${run.files ?? "--"} / ${run.packages ?? "--"}`],
    ["提交时间", formatDate(run.createdAt)],
    ["完成时间", formatDate(run.finishedAt)],
    ["失败阶段", run.failureStage ? publicationFailureStageLabel(run.failureStage) : "--"],
    ["候选文件校验", publicationVerificationLabel(run.verification?.candidate?.state)],
    ["权威指针", publicationVerificationLabel(run.verification?.authority?.state)],
    ["目标站点", `${publicationVerificationLabel(run.verification?.site?.state)}${run.verification?.site?.target ? ` · ${run.verification.site.target}` : ""}${run.verification?.site?.observedBundleSha256 ? ` · ${run.verification.site.observedBundleSha256}` : ""}`],
    ["错误", run.error ?? run.verification?.site?.error ?? "—"],
  ];
  const cancel = run.queue?.cancellable ? `<button type="button" class="admin-quiet" data-cancel-publication="${escapeText(run.runId)}"><i data-lucide="square"></i><span>${run.status === "queued" ? "取消排队" : "停止本次发布"}</span></button>` : "";
  const verify = run.status === "published" || run.queue?.phase === "site-pending" ? `<button type="button" class="admin-primary" data-verify-publication="${escapeText(run.runId)}"><i data-lucide="shield-check"></i><span>重新核验目标站点</span></button>` : "";
  const retry = run.status === "failed" && !run.recovery ? `<button type="button" class="admin-primary" data-retry-publication="${escapeText(run.runId)}"><i data-lucide="rotate-ccw"></i><span>重试原审核版本</span></button>` : "";
  const recover = run.recovery ? `<button type="button" class="admin-primary" data-recover-publication="${escapeText(run.runId)}"><i data-lucide="refresh-cw"></i><span>恢复并重试</span></button>` : "";
  byId("publication-run-detail").innerHTML = `<dl class="admin-context">${facts.map(([label, value]) => `<div><dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd></div>`).join("")}</dl><div class="publication-verification-actions">${cancel}${recover}${retry}${verify}</div>`;
  byId("publication-run-detail").querySelector<HTMLButtonElement>("[data-cancel-publication]")?.addEventListener("click", event => void cancelPublicationRun((event.currentTarget as HTMLButtonElement).dataset.cancelPublication ?? ""));
  byId<HTMLButtonElement>("publication-run-detail").querySelector("[data-verify-publication]")?.addEventListener("click", (event) => void verifyPublicationRun((event.currentTarget as HTMLButtonElement).dataset.verifyPublication ?? ""));
  byId<HTMLButtonElement>("publication-run-detail").querySelector("[data-retry-publication]")?.addEventListener("click", (event) => void retryPublicationRun((event.currentTarget as HTMLButtonElement).dataset.retryPublication ?? ""));
  byId<HTMLButtonElement>("publication-run-detail").querySelector("[data-recover-publication]")?.addEventListener("click", (event) => void recoverPublicationRun((event.currentTarget as HTMLButtonElement).dataset.recoverPublication ?? ""));
  renderIcons();
  byId<HTMLDialogElement>("publication-run-dialog").showModal();
}

async function cancelPublicationRun(runId: string): Promise<void> {
  try {
    const { run } = await api<{ run: PublicationRun }>(`/api/v1/admin/publications/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
    publicationRuns = publicationRuns.map(item => item.runId === runId ? run : item);
    byId<HTMLDialogElement>("publication-run-dialog").close();
    renderPublicationRuns();
    syncProductOperationButtons();
    toast("本次发布已取消，历史记录已保留");
  } catch (error) { toast(error instanceof Error ? error.message : "取消失败", true); }
}

async function retryPublicationRun(runId: string): Promise<void> {
  if (!runId || !window.confirm("使用原来选定的审核版本重试吗？旧记录会保留；版本改变后需要重新提交。")) return;
  try {
    const { run } = await api<{ run: PublicationRun }>(`/api/v1/admin/publications/${encodeURIComponent(runId)}/retry`, { method: "POST", body: "{}" });
    publicationRuns = [run, ...publicationRuns.filter((item) => item.runId !== run.runId)];
    renderPublicationRuns();
    byId<HTMLDialogElement>("publication-run-dialog").close();
    schedulePublicationPolling(run.runId);
    toast(`发布任务已重新排队：${run.runId}`);
  } catch (error) { toast(error instanceof Error ? error.message : "发布重试失败", true); }
}

async function recoverPublicationRun(runId: string): Promise<void> {
  if (!runId || !window.confirm("这个任务已失去 worker，释放后重新排队吗？旧记录会保留。")) return;
  try {
    const { run } = await api<{ run: PublicationRun }>(`/api/v1/admin/publications/${encodeURIComponent(runId)}/recover`, { method: "POST", body: "{}" });
    publicationRuns = [run, ...publicationRuns.filter((item) => item.runId !== run.runId)];
    renderPublicationRuns();
    byId<HTMLDialogElement>("publication-run-dialog").close();
    schedulePublicationPolling(run.runId);
    toast(`发布任务已恢复并重新排队：${run.runId}`);
  } catch (error) { toast(error instanceof Error ? error.message : "发布任务恢复失败", true); }
}

async function verifyPublicationRun(runId: string): Promise<void> {
  if (!runId) return;
  try {
    const { run } = await api<{ run: PublicationRun }>(`/api/v1/admin/publications/${encodeURIComponent(runId)}/verify`, { method: "POST" });
    publicationRuns = publicationRuns.map((item) => item.runId === run.runId ? run : item);
    renderPublicationRuns();
    openPublicationRun(run);
    toast(`站点核验：${publicationVerificationLabel(run.verification?.overall)}`, run.verification?.overall === "failed");
  } catch (error) { toast(error instanceof Error ? error.message : "站点核验失败", true); }
}

function schedulePublicationPolling(_runId: string): void { schedulePolling(); }

function formValue(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

function updateConnectorFields(): void {
  const type = byId<HTMLSelectElement>("connector-type").value;
  const objectStorage = type === "s3" || type === "oss";
  document.querySelectorAll<HTMLElement>("[data-connector-object], [data-connector-local]").forEach((element) => {
    const field = element.querySelector<HTMLInputElement>("input,select");
    const visible = element.hasAttribute("data-connector-local") ? type === "local"
      : objectStorage;
    element.hidden = !visible;
    if (!field) return;
    field.disabled = !visible;
    field.required = visible && ["endpoint", "bucket", "accessKey", "secretKey", "pvcName"].includes(field.name);
    if (!visible) field.value = "";
  });
}

async function submitConnector(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = { name: formValue(form, "name"), type: formValue(form, "type"), endpoint: formValue(form, "endpoint") || undefined, region: formValue(form, "region") || undefined, bucket: formValue(form, "bucket") || undefined, prefix: formValue(form, "prefix") || undefined, accessKey: formValue(form, "accessKey") || undefined, secretKey: formValue(form, "secretKey") || undefined, pvcName: formValue(form, "pvcName") || undefined, basePath: formValue(form, "basePath") || undefined };
  setMessage("connector", "正在创建…");
  try {
    await api("/api/v1/admin/connectors", { method: "POST", body: JSON.stringify(input) });
    form.reset();
    updateConnectorFields();
    byId<HTMLDialogElement>("connector-dialog").close();
    setMessage("connector", "Connector 已创建");
    toast("Connector 已创建");
    await refresh();
  } catch (error) { setMessage("connector", error instanceof Error ? error.message : "创建失败", true); }
}

async function submitTask(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = {
    name: formValue(form, "name"), productId: formValue(form, "productId") || undefined, sourceConnector: formValue(form, "sourceConnector"), sourcePaths: formValue(form, "sourcePaths").split(/\r?\n/).map((path) => path.trim()).filter(Boolean), allowedSuffixes: formValue(form, "allowedSuffixes") || undefined, maxOrder: Number(formValue(form, "maxOrder") || "8"), raColumn: formValue(form, "raColumn") || undefined, decColumn: formValue(form, "decColumn") || undefined, healpixColumn: formValue(form, "healpixColumn") || undefined, healpixOrderColumn: formValue(form, "healpixOrderColumn") || undefined, healpixOrder: formValue(form, "healpixOrder") ? Number(formValue(form, "healpixOrder")) : undefined, batchId: formValue(form, "batchId") || undefined,
  };
  setMessage("task", "正在提交 CRD…");
  try {
    await api("/api/v1/admin/tasks", { method: "POST", body: JSON.stringify(input) });
    byId<HTMLDialogElement>("task-dialog").close();
    setMessage("task", "ScanRequest 已提交");
    toast("ScanRequest 已提交");
    await refresh();
  } catch (error) { setMessage("task", error instanceof Error ? error.message : "提交失败", true); }
}

async function initialize(): Promise<void> {
  renderIcons();
  try {
    adminConfig = await api<AdminConfig>("/api/v1/admin/config", { headers: {} });
    setTaskSubmitEnabled(false);
    byId("admin-namespace").textContent = adminConfig.namespace;
    byId("admin-capability").textContent = adminConfig.enabled && adminConfig.kubernetesConfigured ? "接口已连接" : "接口未配置";
    if (!adminConfig.enabled) {
      byId("login-title").textContent = t("admin.disabled");
      byId("login-error").textContent = "当前部署未启用 Kubernetes 管理连接。";
      byId("login-error").hidden = false;
      return;
    }
    if (token) {
      showWorkspace();
      await refresh();
    }
  } catch (error) {
    byId("login-error").textContent = error instanceof Error ? error.message : "Unable to read admin configuration";
    byId("login-error").hidden = false;
  }
}

byId<HTMLFormElement>("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = byId<HTMLInputElement>("admin-token").value.trim();
  if (!token) return;
  sessionStorage.setItem(tokenKey, token);
  showWorkspace();
  await refresh();
});
byId("logout-button").addEventListener("click", () => { token = ""; sessionStorage.removeItem(tokenKey); if (pollTimer !== undefined) window.clearTimeout(pollTimer); pollTimer = undefined; connectorProbeResults.clear(); connectorRecords = []; overviewRecord = null; showLogin(); });
applyAdminTheme(storedAdminTheme() ?? adminSystemTheme());
byId("theme-toggle").addEventListener("click", () => applyAdminTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true));
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => { if (!storedAdminTheme()) applyAdminTheme(adminSystemTheme()); });
byId("refresh-button").addEventListener("click", () => void refresh());


byId<HTMLInputElement>("overview-search").addEventListener("input", (event) => {
  overviewQuery = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  if (overviewRecord) renderOverview(overviewRecord);
});
byId("publication-refresh-button").addEventListener("click", () => { void loadPublicationPlan(); void loadPublicationRuns(); });
byId("publication-publish-button").addEventListener("click", () => void publishSelectedSurveys());
byId("publication-run-close").addEventListener("click", () => byId<HTMLDialogElement>("publication-run-dialog").close());
byId("catalog-reload-button").addEventListener("click", (event) => void reloadCatalogRuntime(event.currentTarget as HTMLButtonElement));
byId<HTMLFormElement>("connector-form").addEventListener("submit", (event) => void submitConnector(event));
byId<HTMLFormElement>("task-form").addEventListener("submit", (event) => void submitTask(event));
byId<HTMLFormElement>("moc-discovery-form").addEventListener("submit", (event) => void submitMocDiscovery(event));
byId<HTMLFormElement>("moc-review-form").addEventListener("submit", (event) => void submitMocReview(event));
byId<HTMLFormElement>("moc-product-register-form").addEventListener("submit", (event) => void submitMocProductRegistration(event));
byId<HTMLFormElement>("product-form").addEventListener("submit", (event) => void saveProduct(event));
byId("review-survey-close").addEventListener("click", () => byId<HTMLDialogElement>("review-survey-dialog").close());
byId<HTMLDialogElement>("review-survey-dialog").addEventListener("close", () => {
  const previous = selectedReviewSurveyId;
  selectedReviewSurveyId = "";
  byId("review-survey-content").replaceChildren();
  document.querySelector<HTMLButtonElement>(`[data-review-survey="${CSS.escape(previous)}"]`)?.focus();
});
byId("product-dialog-cancel").addEventListener("click", () => { history.replaceState(null, "", "/admin/review"); activeProductDialogId = ""; byId<HTMLDialogElement>("product-dialog").close(); });
byId<HTMLButtonElement>("product-dialog-review").addEventListener("click", (event) => { const productId = (event.currentTarget as HTMLButtonElement).dataset.reviewProduct; if (productId) void reviewProduct(productId); });
byId<HTMLButtonElement>("product-dialog-publish").addEventListener("click", (event) => { const productId = (event.currentTarget as HTMLButtonElement).dataset.publishProduct; if (productId) void publishProduct(productId); });
byId<HTMLButtonElement>("product-dialog-retire").addEventListener("click", (event) => { const productId = (event.currentTarget as HTMLButtonElement).dataset.retireProduct; if (productId) void retireProduct(productId); });
byId("editorial-dialog-close").addEventListener("click", () => {
  if (activeEditorial && JSON.stringify(activeEditorial.document.draft) !== JSON.stringify(activeEditorial.baseline) && !window.confirm("目录有未保存修改，确定关闭吗？")) return;
  byId<HTMLDialogElement>("editorial-dialog").close();
  activeEditorial = null;
});
byId("editorial-discard-button").addEventListener("click", discardEditorialChanges);
byId("editorial-save-button").addEventListener("click", () => void saveEditorialDraft());
byId("editorial-publish-button").addEventListener("click", () => openEditorialDiff(true));
byId("editorial-diff-button").addEventListener("click", () => openEditorialDiff(false));
byId<HTMLFormElement>("editorial-diff-form").addEventListener("submit", (event) => {
  const submitter = (event.submitter as HTMLButtonElement | null)?.id;
  if (submitter === "editorial-diff-confirm") {
    event.preventDefault();
    byId<HTMLDialogElement>("editorial-diff-dialog").close();
    void publishEditorial();
  }
});
byId<HTMLDialogElement>("editorial-dialog").addEventListener("cancel", (event) => {
  if (activeEditorial && JSON.stringify(activeEditorial.document.draft) !== JSON.stringify(activeEditorial.baseline) && !window.confirm("目录有未保存修改，确定关闭吗？")) event.preventDefault();
});
byId<HTMLDialogElement>("product-dialog").addEventListener("close", () => {
  if (byId<HTMLDialogElement>("product-dialog").open) return;
  activeProductDialogId = "";
  if (parseAdminRoute(location.pathname)?.productId) history.replaceState(null, "", "/admin/review");
});
byId<HTMLDialogElement>("product-dialog").addEventListener("cancel", () => { history.replaceState(null, "", "/admin/review"); });
byId("moc-product-register-cancel").addEventListener("click", () => byId<HTMLDialogElement>("moc-product-register-dialog").close());
byId("task-product").addEventListener("change", (event) => setDerivedProduct((event.currentTarget as HTMLSelectElement).value));
byId("connector-type").addEventListener("change", updateConnectorFields);
byId("connector-create-button").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").showModal());
byId("connector-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").close());
byId("task-create-button").addEventListener("click", () => { setAdminStep("tasks"); byId<HTMLDialogElement>("task-dialog").showModal(); });
byId("task-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("task-dialog").close());
byId("task-detail-close").addEventListener("click", () => byId<HTMLDialogElement>("task-detail-dialog").close());
byId("moc-build-detail-close").addEventListener("click", () => { activeMocBuildName = ""; byId<HTMLDialogElement>("moc-build-detail-dialog").close(); });
byId("moc-discovery-create-button").addEventListener("click", () => { setAdminStep("tasks"); byId<HTMLDialogElement>("moc-discovery-dialog").showModal(); });
byId("moc-discovery-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("moc-discovery-dialog").close());
byId("moc-review-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("moc-review-dialog").close());
byId("moc-review-retry").addEventListener("click", () => { if (activeMocReviewRequest?.name) void resubmitMocDiscovery(activeMocReviewRequest.name); });
byId<HTMLInputElement>("product-search").addEventListener("input", (event) => {
  productQuery = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  renderProducts(productRecords);
});
document.querySelectorAll<HTMLButtonElement>("[data-admin-step]").forEach((button) => button.addEventListener("click", () => setAdminStep(button.dataset.adminStep as AdminStep)));
window.addEventListener("popstate", () => setAdminStep(readAdminStep(), true));
document.addEventListener("visibilitychange", () => schedulePolling(0));
byId<HTMLButtonElement>("auto-update-toggle").textContent = automaticUpdates ? "自动更新：开" : "自动更新：关";
byId("auto-update-toggle").addEventListener("click", () => {
  automaticUpdates = !automaticUpdates;
  if (!automaticUpdates) {
    workspaceRequests.cancel(); refreshVersion++; refreshInFlight = null;
    byId<HTMLButtonElement>("refresh-button").disabled = false;
  }
  sessionStorage.setItem("assets-admin-auto-update", automaticUpdates ? "on" : "off");
  byId("auto-update-toggle").textContent = automaticUpdates ? "自动更新：开" : "自动更新：关";
  schedulePolling(automaticUpdates ? 0 : undefined);
});
document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => dialog.addEventListener("close", () => {
  if (pendingUpdates && !document.querySelector("dialog[open]:not(#review-survey-dialog)")) void refresh();
}));
byId<HTMLSelectElement>("overview-version").addEventListener("change", event => {
  overviewVersion = (event.target as HTMLSelectElement).value as "draft" | "published";
  if (overviewRecord) renderOverview(overviewRecord);
});
setAdminStep(readAdminStep(), true);
updateConnectorFields();
void initialize();
import { Download, Package } from "lucide";
