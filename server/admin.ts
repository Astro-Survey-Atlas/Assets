import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { request as httpRequest, type IncomingMessage, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";

const API_GROUP = "/apis/atlas.zhejianglab.org/v1alpha1";
export const ASSETS_MANAGED_BY = "astro-survey-atlas-assets";
export const PUBLIC_COVERAGE_KIND = "public-coverage";
export const SUPPORTED_COVERAGE_MODES = ["fits-wcs", "fits-header-position", "catalog-radec", "nested-healpix"] as const;
export const CONNECTOR_TYPES = ["s3", "oss", "local"] as const;
export const SUPPORTED_MODALITIES = ["image", "spectrum", "cube", "catalog", "timeseries", "visibility", "event", "other"] as const;

export type CoverageMode = typeof SUPPORTED_COVERAGE_MODES[number];
export type ConnectorType = typeof CONNECTOR_TYPES[number];
export type ConnectorInputType = typeof CONNECTOR_TYPES[number];
export type TaskBackend = "job" | "flink";

export interface AdminConfig {
  enabled: boolean;
  namespace: string;
  adminToken: string;
  kubeToken: string;
  apiBaseUrl?: string;
  tokenFile: string;
  caFile: string;
  warehouseEsUrl: string;
  scannerImage: string;
  evidenceClaimName: string;
  evidenceMountPath: string;
}

interface KubernetesMetadata {
  name?: string;
  namespace?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface KubernetesResource {
  apiVersion?: string;
  kind?: string;
  metadata?: KubernetesMetadata;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
}

interface KubernetesResourceList {
  items?: KubernetesResource[];
}

export interface ConnectorInput {
  name: string;
  type: ConnectorInputType;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKey?: string;
  secretKey?: string;
  localPath?: string;
}

export interface ConnectorView {
  name: string;
  type: ConnectorType;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyConfigured?: boolean;
  pvcName?: string;
  localPath?: string;
  nodeName?: string;
  nodePath?: string;
  phase?: string;
  message?: string;
  createdAt?: string;
}

export interface CoverageTaskInput {
  name: string;
  layerId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  productId?: string;
  modality?: string;
  mode: CoverageMode;
  coverageRole: "image_extent" | "object_presence" | "footprint_extent";
  dataOrigin: "observed" | "simulated" | "catalog";
  sourceTier: "official_geometry" | "official_inventory_derived" | "third_party_moc" | "best_effort_derived" | "user_file_derived";
  sourceConnector: string;
  sourcePaths: string[];
  sinkConnector?: string;
  backend?: TaskBackend;
  fileNamePattern?: string;
  tags?: string[];
  scanShards?: number;
  allowedSuffixes?: string;
  maxOrder?: number;
  fileIndex?: string;
  coverageIndex?: string;
  objectIndex?: string;
  raColumn?: string;
  decColumn?: string;
  healpixColumn?: string;
  healpixOrderColumn?: string;
  healpixOrder?: number;
  batchId?: string;
}

export interface TaskStatusView {
  phase: string;
  reason?: string;
  backend?: string;
  runId?: string;
  discoveredFiles?: number;
  processedHdus?: number;
  coverageDocuments?: number;
  objectDocuments?: number;
  errorCount?: number;
  availableOrders?: number[];
  evidencePath?: string;
  sourceSnapshot?: { uri?: string; sha256: string; sizeBytes?: number };
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

export interface CoverageTaskRecipeView {
  mode?: string;
  outputOrder?: number;
  catalog?: Record<string, unknown>;
}

export interface CoverageTaskView {
  name: string;
  namespace?: string;
  createdAt?: string;
  layerId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  productId?: string;
  modality?: string;
  mode?: string;
  backend?: string;
  sourceConnector?: string;
  sinkConnector?: string;
  sourcePaths: string[];
  fileNamePattern?: string;
  tags: string[];
  batchId?: string;
  recipe?: CoverageTaskRecipeView;
  status: TaskStatusView;
}

export interface MocDiscoveryInput {
  surveyName: string;
  releaseHint?: string;
  productHint?: string;
}

export interface MocDiscoveryView {
  name: string;
  namespace?: string;
  createdAt?: string;
  surveyName: string;
  releaseHint?: string;
  productHint?: string;
  policyRef: string;
  status: {
    phase: string;
    jobName?: string;
    reason?: string;
    message?: string;
    evidencePath?: string;
    candidateCount?: number;
    probeCount?: number;
    lastTransitionTime?: string;
  };
}

export class AdminHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "AdminHttpError";
  }
}

export class KubernetesApiError extends Error {
  constructor(readonly statusCode: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "KubernetesApiError";
  }
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

export function loadAdminConfig(environment: NodeJS.ProcessEnv = process.env): AdminConfig {
  const host = environment.KUBERNETES_SERVICE_HOST;
  const port = environment.KUBERNETES_SERVICE_PORT_HTTPS ?? environment.KUBERNETES_SERVICE_PORT ?? "443";
  return {
    enabled: envBool(environment.ASSETS_ADMIN_ENABLED, true),
    namespace: environment.ASSETS_WAREHOUSE_NAMESPACE?.trim() || "atlas-warehouse",
    adminToken: environment.ASSETS_ADMIN_TOKEN?.trim() || "",
    kubeToken: environment.ASSETS_KUBE_TOKEN?.trim() || "",
    apiBaseUrl: environment.ASSETS_KUBE_API_URL?.trim() || (host ? `https://${host}:${port}` : undefined),
    tokenFile: environment.ASSETS_KUBE_TOKEN_FILE?.trim() || "/var/run/secrets/kubernetes.io/serviceaccount/token",
    caFile: environment.ASSETS_KUBE_CA_FILE?.trim() || "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    warehouseEsUrl: environment.ASSETS_WAREHOUSE_ES_URL?.trim() || "http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200",
    scannerImage: environment.ASSETS_WAREHOUSE_SCANNER_IMAGE?.trim()
      || "crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-atlas-scanner:0.2.0-20260826-shutdownfix1",
    evidenceClaimName: environment.ASSETS_WAREHOUSE_EVIDENCE_CLAIM?.trim() || "atlas-evidence",
    evidenceMountPath: environment.ASSETS_WAREHOUSE_EVIDENCE_MOUNT_PATH?.trim() || "/var/lib/atlas-evidence",
  };
}

function requireText(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new AdminHttpError(400, `${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new AdminHttpError(400, `${field} is too long`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new AdminHttpError(400, `${field} contains control characters`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireText(value, field, maxLength);
}

function dnsName(value: unknown, field: string): string {
  const name = requireText(value, field, 63).toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) throw new AdminHttpError(400, `${field} must be a DNS label`);
  return name;
}

function indexName(value: unknown, field: string): string {
  const name = requireText(value, field, 255).toLowerCase();
  // Elasticsearch index names permit dots, hyphens and underscores. Keep the
  // stricter lowercase/leading-alphanumeric subset used by our public indices.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new AdminHttpError(400, `${field} must be a lowercase index name`);
  return name;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  const normalized = requireText(value, field);
  if (!values.includes(normalized)) throw new AdminHttpError(400, `${field} is unsupported`);
  return normalized as T[number];
}

function safePositiveInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new AdminHttpError(400, `${field} must be an integer between 1 and ${max}`);
  return parsed;
}

function optionalPathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) throw new AdminHttpError(400, "sourcePaths must contain 1 to 256 paths");
  return value.map((item, index) => requireText(item, `sourcePaths[${index}]`, 2048));
}

function optionalTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new AdminHttpError(400, "tags must contain at most 32 entries");
  return value.map((item, index) => requireText(item, `tags[${index}]`, 64));
}

function resourcePath(namespace: string, plural: string, name?: string): string {
  const base = `${API_GROUP}/namespaces/${encodeURIComponent(namespace)}/${plural}`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function coreResourcePath(plural: string, name?: string, namespace?: string): string {
  const base = namespace
    ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/${plural}`
    : `/api/v1/${plural}`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function headerToken(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class KubernetesApi {
  private ca?: Buffer;
  private token?: string;

  constructor(private readonly config: AdminConfig) {}

  async list(plural: string, selector: string): Promise<KubernetesResource[]> {
    const query = selector ? `?labelSelector=${encodeURIComponent(selector)}` : "";
    const result = await this.request<KubernetesResourceList>("GET", `${resourcePath(this.config.namespace, plural)}${query}`);
    return Array.isArray(result.items) ? result.items : [];
  }

  async get(plural: string, name: string): Promise<KubernetesResource | null> {
    try {
      return await this.request<KubernetesResource>("GET", resourcePath(this.config.namespace, plural, name));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async create(plural: string, resource: KubernetesResource): Promise<KubernetesResource> {
    return this.request<KubernetesResource>("POST", resourcePath(this.config.namespace, plural), resource);
  }

  async createCore(plural: string, resource: KubernetesResource, namespace?: string): Promise<KubernetesResource> {
    return this.request<KubernetesResource>("POST", coreResourcePath(plural, undefined, namespace), resource);
  }

  async listCore(plural: string, selector: string, namespace?: string): Promise<KubernetesResource[]> {
    const query = selector ? `?labelSelector=${encodeURIComponent(selector)}` : "";
    const result = await this.request<KubernetesResourceList>("GET", `${coreResourcePath(plural, undefined, namespace)}${query}`);
    return Array.isArray(result.items) ? result.items : [];
  }

  async getCore(plural: string, name: string, namespace?: string): Promise<KubernetesResource | null> {
    try {
      return await this.request<KubernetesResource>("GET", coreResourcePath(plural, name, namespace));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async deleteCore(plural: string, name: string, namespace?: string): Promise<void> {
    try {
      await this.request("DELETE", coreResourcePath(plural, name, namespace));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      throw error;
    }
  }

  private async credentials(): Promise<{ token: string; ca?: Buffer }> {
    if (!this.token) {
      if (this.config.kubeToken) this.token = this.config.kubeToken;
      else {
        try { this.token = (await readFile(this.config.tokenFile, "utf8")).trim(); }
        catch { throw new AdminHttpError(503, "Kubernetes service-account token is unavailable"); }
      }
    }
    if (!this.token) throw new AdminHttpError(503, "Kubernetes service-account token is empty");
    if (!this.ca && this.config.caFile) {
      try { this.ca = await readFile(this.config.caFile); }
      catch { this.ca = undefined; }
    }
    return { token: this.token, ca: this.ca };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.config.apiBaseUrl) throw new AdminHttpError(503, "Kubernetes API is not configured");
    const target = new URL(path, this.config.apiBaseUrl.endsWith("/") ? this.config.apiBaseUrl : `${this.config.apiBaseUrl}/`);
    const credentials = await this.credentials();
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
    };
    if (encoded) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(encoded.length);
    }
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      ca: credentials.ca,
      rejectUnauthorized: target.protocol === "https:",
    } satisfies HttpsRequestOptions;
    const requestFunction = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<T>((resolve, reject) => {
      const request = requestFunction(options as HttpRequestOptions, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = undefined;
          if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
          }
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            const message = typeof parsed === "object" && parsed && "message" in parsed && typeof parsed.message === "string"
              ? parsed.message
              : `Kubernetes API request failed (${status})`;
            reject(new KubernetesApiError(status, message, parsed));
            return;
          }
          resolve(parsed as T);
        });
        response.on("error", reject);
      });
      request.setTimeout(15_000, () => request.destroy(new Error("Kubernetes API request timed out")));
      request.on("error", reject);
      if (encoded) request.write(encoded);
      request.end();
    });
  }
}

function connectorView(resource: KubernetesResource): ConnectorView {
  const data = resource.data ?? {};
  const status = resource.status ?? {};
  const nodeName = typeof data.nodeName === "string" ? data.nodeName : undefined;
  const nodePath = typeof data.nodePath === "string" ? data.nodePath : undefined;
  return {
    name: resource.metadata?.name ?? "",
    type: String(data.type ?? "") as ConnectorType,
    endpoint: typeof data.endpoint === "string" ? data.endpoint : undefined,
    region: typeof data.region === "string" ? data.region : undefined,
    bucket: typeof data.bucket === "string" ? data.bucket : undefined,
    prefix: typeof data.prefix === "string" ? data.prefix : undefined,
    accessKeyConfigured: typeof data.credentialSecretName === "string" && data.credentialSecretName.length > 0,
    pvcName: typeof data.pvcName === "string" ? data.pvcName : undefined,
    localPath: nodeName && nodePath ? `${nodeName}:${nodePath}` : typeof data.localPath === "string" ? data.localPath : undefined,
    nodeName,
    nodePath,
    phase: typeof status.phase === "string" ? status.phase : undefined,
    message: typeof status.message === "string" ? status.message : undefined,
    createdAt: resource.metadata?.creationTimestamp,
  };
}

function statusView(status: Record<string, unknown> | undefined): TaskStatusView {
  const value = status ?? {};
  const summary = value.summary && typeof value.summary === "object" ? value.summary as Record<string, unknown> : {};
  const result: TaskStatusView = { phase: typeof value.phase === "string" ? value.phase : "Pending" };
  if (typeof value.reason === "string") result.reason = value.reason;
  for (const key of ["backend", "runId", "startedAt", "completedAt", "message"] as const) {
    if (typeof value[key] === "string") result[key] = value[key] as string;
  }
  if (typeof value.message !== "string" && typeof value.reason === "string") result.message = value.reason;
  for (const key of ["discoveredFiles", "processedHdus", "coverageDocuments", "objectDocuments"] as const) {
    const summaryKey = key === "discoveredFiles" ? "discoveredFileCount"
      : key === "processedHdus" ? "processedItemCount"
        : key === "coverageDocuments" ? "coverageRecordCount" : "objectDocumentCount";
    const count = typeof value[key] === "number" ? value[key] : summary[summaryKey];
    if (typeof count === "number") result[key] = count;
  }
  const summaryRunId = typeof summary.scanRunId === "string" ? summary.scanRunId : summary.runId;
  if (typeof summaryRunId === "string" && !result.runId) result.runId = summaryRunId;
  if (typeof summary.startedAt === "string" && !result.startedAt) result.startedAt = summary.startedAt;
  if (typeof summary.completedAt === "string" && !result.completedAt) result.completedAt = summary.completedAt;
  if (typeof summary.errors === "number" && !result.message && summary.errors > 0) result.message = `${summary.errors} scan errors retained as evidence`;
  const errorCount = typeof value.errorCount === "number" ? value.errorCount
    : typeof summary.errorCount === "number" ? summary.errorCount
      : typeof summary.errors === "number" ? summary.errors : undefined;
  if (errorCount !== undefined) result.errorCount = errorCount;
  const availableOrders = Array.isArray(value.availableOrders) ? value.availableOrders : summary.availableOrders;
  if (Array.isArray(availableOrders)) result.availableOrders = availableOrders.filter((order): order is number => typeof order === "number");
  const evidencePath = typeof value.evidencePath === "string" ? value.evidencePath : summary.evidencePath;
  if (typeof evidencePath === "string") result.evidencePath = evidencePath;
  const snapshot = value.sourceSnapshot && typeof value.sourceSnapshot === "object" ? value.sourceSnapshot
    : summary.sourceSnapshot && typeof summary.sourceSnapshot === "object" ? summary.sourceSnapshot : undefined;
  if (snapshot && !Array.isArray(snapshot)) {
    const source = snapshot as Record<string, unknown>;
    if (/^[a-f0-9]{64}$/.test(String(source.sha256 ?? ""))) {
      result.sourceSnapshot = { sha256: String(source.sha256), ...(typeof source.uri === "string" ? { uri: source.uri } : {}), ...(typeof source.sizeBytes === "number" ? { sizeBytes: source.sizeBytes } : {}) };
    }
  }
  const snapshotSha256 = typeof value.sourceSnapshotSha256 === "string" ? value.sourceSnapshotSha256 : summary.sourceSnapshotSha256;
  if (!result.sourceSnapshot && typeof snapshotSha256 === "string" && /^[a-f0-9]{64}$/.test(snapshotSha256)) result.sourceSnapshot = { sha256: snapshotSha256 };
  return result;
}

function taskView(resource: KubernetesResource): CoverageTaskView {
  const spec = resource.spec ?? {};
  const plan = spec.plan && typeof spec.plan === "object" ? spec.plan as Record<string, unknown> : {};
  const layer = plan.layer && typeof plan.layer === "object" ? plan.layer as Record<string, unknown> : {};
  const source = plan.source && typeof plan.source === "object" ? plan.source as Record<string, unknown> : {};
  const connector = source.connector && typeof source.connector === "object" ? source.connector as Record<string, unknown> : {};
  const location = source.location && typeof source.location === "object" ? source.location as Record<string, unknown> : {};
  const extraction = plan.extraction && typeof plan.extraction === "object" ? plan.extraction as Record<string, unknown> : {};
  const labels = resource.metadata?.labels ?? {};
  const sourcePath = typeof location.bucket === "string"
    ? `${typeof connector.type === "string" ? connector.type : "s3"}://${location.bucket}/${typeof location.prefix === "string" ? location.prefix : ""}`
    : typeof location.rootPath === "string" ? location.rootPath : undefined;
  return {
    name: resource.metadata?.name ?? "",
    namespace: resource.metadata?.namespace,
    createdAt: resource.metadata?.creationTimestamp,
    layerId: typeof layer.layerId === "string" ? layer.layerId : labels["astro.zhejianglab.org/layer-id"],
    surveyId: typeof layer.surveyId === "string" ? layer.surveyId : undefined,
    releaseId: typeof layer.releaseId === "string" ? layer.releaseId : undefined,
    product: typeof layer.productId === "string" ? layer.productId : undefined,
    productId: typeof layer.productId === "string" ? layer.productId : undefined,
    modality: typeof layer.modality === "string" ? layer.modality : undefined,
    mode: typeof extraction.mode === "string" ? extraction.mode : undefined,
    backend: "job",
    sourceConnector: labels["astro.zhejianglab.org/source-connector"],
    sourcePaths: sourcePath ? [sourcePath] : [],
    tags: [],
    batchId: typeof plan.scanRunId === "string" ? plan.scanRunId : undefined,
    recipe: {
      mode: typeof extraction.mode === "string" ? extraction.mode : undefined,
      outputOrder: typeof extraction.outputOrder === "number" ? extraction.outputOrder : undefined,
      catalog: extraction.catalog && typeof extraction.catalog === "object" && !Array.isArray(extraction.catalog) ? extraction.catalog as Record<string, unknown> : undefined,
    },
    status: statusView(resource.status),
  };
}

function mocDiscoveryView(resource: KubernetesResource): MocDiscoveryView {
  const spec = resource.spec ?? {};
  const query = spec.query && typeof spec.query === "object" ? spec.query as Record<string, unknown> : {};
  const rawStatus = resource.status ?? {};
  const status = rawStatus.status && typeof rawStatus.status === "object" && !Array.isArray(rawStatus.status)
    ? rawStatus.status as Record<string, unknown>
    : rawStatus;
  const value = (key: string): string | undefined => typeof status[key] === "string" ? status[key] as string : undefined;
  const number = (key: string): number | undefined => typeof status[key] === "number" ? status[key] as number : undefined;
  return {
    name: resource.metadata?.name ?? "",
    namespace: resource.metadata?.namespace,
    createdAt: resource.metadata?.creationTimestamp,
    surveyName: typeof query.surveyName === "string" ? query.surveyName : "",
    ...(typeof query.releaseHint === "string" ? { releaseHint: query.releaseHint } : {}),
    ...(typeof query.productHint === "string" ? { productHint: query.productHint } : {}),
    policyRef: typeof spec.policyRef === "string" ? spec.policyRef : "",
    status: {
      phase: value("phase") ?? "PENDING",
      ...(value("jobName") ? { jobName: value("jobName") } : {}),
      ...(value("reason") ? { reason: value("reason") } : {}),
      ...(value("message") ? { message: value("message") } : {}),
      ...(value("evidencePath") ? { evidencePath: value("evidencePath") } : {}),
      ...(number("candidateCount") !== undefined ? { candidateCount: number("candidateCount") } : {}),
      ...(number("probeCount") !== undefined ? { probeCount: number("probeCount") } : {}),
      ...(value("lastTransitionTime") ? { lastTransitionTime: value("lastTransitionTime") } : {}),
    },
  };
}

function discoveryText(value: unknown, field: string, maxLength = 200): string {
  return requireText(value, field, maxLength);
}

function discoveryOptionalText(value: unknown, field: string, maxLength = 200): string | undefined {
  return optionalText(value, field, maxLength);
}

function buildMocDiscoveryResource(input: MocDiscoveryInput, namespace: string): KubernetesResource {
  const surveyName = discoveryText(input.surveyName, "surveyName");
  const releaseHint = discoveryOptionalText(input.releaseHint, "releaseHint");
  const productHint = discoveryOptionalText(input.productHint, "productHint");
  const base = `${productSlug(surveyName)}-moc-discovery`;
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const name = dnsName(`${base.slice(0, Math.max(1, 63 - suffix.length - 1))}-${suffix}`, "name");
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": ASSETS_MANAGED_BY,
        "astro.zhejianglab.org/resource-kind": "moc-discovery",
        "astro.zhejianglab.org/task-kind": "public-moc-discovery",
      },
    },
    spec: {
      query: { surveyName, ...(releaseHint ? { releaseHint } : {}), ...(productHint ? { productHint } : {}) },
      policyRef: "cds-public-moc-v1",
    },
  };
}

function managedResourceName(name: string, suffix: string): string {
  const maxBaseLength = 63 - suffix.length - 1;
  const base = name.slice(0, Math.max(1, maxBaseLength)).replace(/-+$/, "");
  return dnsName(`${base}-${suffix}`, "managed resource name");
}

function validateLocalLocation(value: string): { nodeName: string; nodePath: string; location: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(":", separator + 1) >= 0) {
    throw new AdminHttpError(400, "localPath must use nodeName:/absolute/path format");
  }
  const nodeName = value.slice(0, separator).trim().toLowerCase();
  if (nodeName.length > 253 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/.test(nodeName)) {
    throw new AdminHttpError(400, "localPath nodeName must be a Kubernetes DNS name");
  }
  const nodePath = value.slice(separator + 1);
  if (!nodePath.startsWith("/") || nodePath === "/") throw new AdminHttpError(400, "localPath must contain an absolute non-root path");
  if (nodePath.split("/").some((segment) => segment === "." || segment === "..")) throw new AdminHttpError(400, "localPath cannot contain dot segments");
  const normalized = path.posix.normalize(nodePath);
  const root = process.env.ASSETS_LOCAL_PATH_ROOT?.trim();
  if (root) {
    const normalizedRoot = path.posix.normalize(root);
    const relative = path.posix.relative(normalizedRoot, normalized);
    if (relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new AdminHttpError(400, "localPath is outside the configured host-path root");
  }
  return { nodeName, nodePath: normalized, location: `${nodeName}:${normalized}` };
}

function validateLocalPath(value: string): string {
  return validateLocalLocation(value).location;
}

/* Legacy absolute paths are intentionally rejected for new connectors. */
function validateLegacyLocalPath(value: string): string {
  if (!value.startsWith("/") || value === "/") throw new AdminHttpError(400, "localPath must be an absolute non-root path");
  if (value.split("/").some((segment) => segment === "." || segment === "..")) throw new AdminHttpError(400, "localPath cannot contain dot segments");
  const normalized = path.posix.normalize(value);
  const root = process.env.ASSETS_LOCAL_PATH_ROOT?.trim();
  if (root) {
    const normalizedRoot = path.posix.normalize(root);
    const relative = path.posix.relative(normalizedRoot, normalized);
    if (relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new AdminHttpError(400, "localPath is outside the configured host-path root");
  }
  return normalized;
}

interface ConnectorResources {
  configMap: KubernetesResource;
  secret?: KubernetesResource;
  persistentVolume?: KubernetesResource;
  persistentVolumeClaim?: KubernetesResource;
  secretName?: string;
  persistentVolumeName?: string;
  persistentVolumeClaimName?: string;
}

interface ConnectorDefinition {
  name: string;
  type: ConnectorType;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  localPath?: string;
  nodeName?: string;
  nodePath?: string;
  pvcName?: string;
  credentialSecretName?: string;
}

function validateEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.hostname.toLowerCase().endsWith(".warehouse.svc.cluster.local")) {
      throw new AdminHttpError(400, "legacy warehouse namespace endpoints are not supported");
    }
    if (!(["http:", "https:"].includes(endpoint.protocol)) || !endpoint.hostname) throw new Error("invalid endpoint");
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(400, "endpoint must be an http or https URL");
  }
  return value;
}

function connectorDefinition(resource: KubernetesResource): ConnectorDefinition {
  const data = resource.data ?? {};
  const type = String(data.type ?? "") as ConnectorType;
  return {
    name: resource.metadata?.name ?? "",
    type,
    endpoint: data.endpoint,
    region: data.region,
    bucket: data.bucket,
    prefix: data.prefix,
    localPath: data.localPath,
    nodeName: data.nodeName,
    nodePath: data.nodePath,
    pvcName: data.pvcName,
    credentialSecretName: data.credentialSecretName,
  };
}

function buildSourceConnectorPlan(connector: ConnectorDefinition): Record<string, unknown> {
  if (connector.type !== "s3" && connector.type !== "oss" && connector.type !== "local") {
    throw new AdminHttpError(400, "Source connector has an unsupported type");
  }
  if (connector.endpoint) validateEndpoint(connector.endpoint);
  if (connector.type !== "local" && !connector.endpoint) {
    throw new AdminHttpError(400, "source connector endpoint is missing");
  }
  if (connector.type !== "local" && !connector.bucket) {
    throw new AdminHttpError(400, "source connector bucket is missing");
  }
  return {
    type: connector.type,
    ...(connector.endpoint ? { endpoint: connector.endpoint } : {}),
    ...(connector.region ? { region: connector.region } : {}),
    credentialRef: connector.credentialSecretName ? {
      accessKeyEnv: "ATLAS_SOURCE_ACCESS_KEY",
      secretKeyEnv: "ATLAS_SOURCE_SECRET_KEY",
    } : {},
  };
}

function connectorDetails(input: ConnectorInput, namespace: string): ConnectorResources {
  const allowedFields = new Set(["name", "type", "endpoint", "region", "bucket", "prefix", "accessKey", "secretKey", "localPath"]);
  const unknown = Object.keys(input as unknown as Record<string, unknown>).find((key) => !allowedFields.has(key));
  if (unknown) throw new AdminHttpError(400, `${unknown} is not supported for connectors`);
  const name = dnsName(input.name, "name");
  const type = enumValue(input.type, CONNECTOR_TYPES, "type");
  const endpoint = optionalText(input.endpoint, "endpoint", 2048);
  if (endpoint) validateEndpoint(endpoint);
  const region = optionalText(input.region, "region", 128);
  const bucket = optionalText(input.bucket, "bucket", 255);
  const prefix = optionalText(input.prefix, "prefix", 2048);
  const accessKey = optionalText(input.accessKey, "accessKey", 512);
  const secretKey = optionalText(input.secretKey, "secretKey", 512);
  const localLocation = input.localPath === undefined ? undefined : validateLocalLocation(requireText(input.localPath, "localPath", 2048));
  if (prefix?.split("/").some((segment) => segment === "." || segment === "..")) throw new AdminHttpError(400, "prefix cannot contain dot segments");

  const labels = {
    "app.kubernetes.io/managed-by": ASSETS_MANAGED_BY,
    "astro.zhejianglab.org/resource-kind": "connector",
  };
  if (type === "s3" || type === "oss") {
    if (!endpoint) throw new AdminHttpError(400, "endpoint is required for S3 / OSS connectors");
    if (!bucket) throw new AdminHttpError(400, "bucket is required for S3 / OSS connectors");
    if (!accessKey || !secretKey) throw new AdminHttpError(400, "accessKey and secretKey are required for S3 / OSS connectors");
    if (localLocation) throw new AdminHttpError(400, "localPath is only valid for local connectors");
    const secretName = managedResourceName(name, "credentials");
    const data: Record<string, string> = {
      type,
      endpoint,
      bucket,
      ...(region ? { region } : {}),
      ...(prefix ? { prefix } : {}),
      credentialSecretName: secretName,
      accessKeyKey: "accessKey",
      secretKeyKey: "secretKey",
    };
    return {
      configMap: { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace, labels }, data },
      secret: { apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace, labels }, type: "Opaque", stringData: { accessKey, secretKey } },
      secretName,
    };
  }

  if (endpoint || region || bucket || prefix || accessKey || secretKey) throw new AdminHttpError(400, "Local connectors only accept localPath");
  if (!localLocation) throw new AdminHttpError(400, "localPath is required for local connectors");
  const persistentVolumeName = managedResourceName(name, "pv");
  const persistentVolumeClaimName = managedResourceName(name, "pvc");
  const configMap: KubernetesResource = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace, labels },
    data: {
      type,
      localPath: localLocation.location,
      nodeName: localLocation.nodeName,
      nodePath: localLocation.nodePath,
      pvcName: persistentVolumeClaimName,
    },
  };
  const persistentVolume: KubernetesResource = {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: persistentVolumeName, labels },
    spec: {
      capacity: { storage: "1Ti" },
      accessModes: ["ReadWriteOnce"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "",
      hostPath: { path: localLocation.nodePath, type: "DirectoryOrCreate" },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [localLocation.nodeName] }] }],
        },
      },
      claimRef: { namespace, name: persistentVolumeClaimName },
    },
  };
  const persistentVolumeClaim: KubernetesResource = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: persistentVolumeClaimName, namespace, labels },
    spec: { accessModes: ["ReadWriteOnce"], storageClassName: "", volumeName: persistentVolumeName, resources: { requests: { storage: "1Ti" } } },
  };
  return { configMap, persistentVolume, persistentVolumeClaim, persistentVolumeName, persistentVolumeClaimName };
}

function buildConnectorResource(input: ConnectorInput, namespace: string): KubernetesResource {
  return connectorDetails(input, namespace).configMap;
}

function buildConnectorResources(input: ConnectorInput, namespace: string): ConnectorResources {
  return connectorDetails(input, namespace);
}

function productSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return slug || "product";
}

function warehouseModality(value: string | undefined, mode: CoverageMode): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["image", "imaging", "photometry", "infrared", "ultraviolet"].includes(normalized)) return "image";
  if (["spectrum", "spectroscopy"].includes(normalized)) return "spectrum";
  if (normalized === "catalog" || mode === "catalog-radec" || mode === "nested-healpix") return "catalog";
  if (["cube", "timeseries", "visibility", "event"].includes(normalized)) return normalized;
  return "other";
}

function warehouseCoverageRole(value: CoverageTaskInput["coverageRole"]): "footprint" | "occupancy" {
  return value === "object_presence" ? "occupancy" : "footprint";
}

function objectLocation(inputPath: string, connector: ConnectorDefinition): { bucket: string; prefix?: string } {
  const value = inputPath.trim();
  const uri = /^(s3|oss):\/\/([^/]+)(?:\/(.*))?$/.exec(value);
  const bucket = uri?.[2] ?? connector.bucket;
  if (!bucket) throw new AdminHttpError(400, "object connector bucket is required");
  if (uri && connector.bucket && uri[2] !== connector.bucket) throw new AdminHttpError(400, "source path bucket differs from connector bucket");
  const prefix = uri
    ? (uri[3] || connector.prefix)
    : (value ? value.replace(/^\/+/, "") : connector.prefix);
  if (prefix?.split("/").some((segment) => segment === "." || segment === "..")) throw new AdminHttpError(400, "source path cannot contain dot segments");
  return { bucket, ...(prefix ? { prefix } : {}) };
}

function buildTaskResource(
  input: CoverageTaskInput,
  namespace: string,
  connector: ConnectorDefinition = {
    name: input.sourceConnector,
    type: "oss",
    endpoint: "https://object.example.invalid",
    bucket: "example",
  },
  config: AdminConfig = loadAdminConfig(),
): KubernetesResource {
  const name = dnsName(input.name, "name");
  const layerId = dnsName(input.layerId, "layerId");
  const surveyId = dnsName(input.surveyId, "surveyId");
  const releaseId = requireText(input.releaseId, "releaseId", 160);
  const product = requireText(input.product, "product", 255);
  const mode = enumValue(input.mode, SUPPORTED_COVERAGE_MODES, "mode");
  const coverageRole = enumValue(input.coverageRole, ["image_extent", "object_presence", "footprint_extent"] as const, "coverageRole");
  const dataOrigin = enumValue(input.dataOrigin, ["observed", "simulated", "catalog"] as const, "dataOrigin");
  const sourceTier = enumValue(input.sourceTier, ["official_geometry", "official_inventory_derived", "third_party_moc", "best_effort_derived", "user_file_derived"] as const, "sourceTier");
  const sourceConnector = dnsName(input.sourceConnector, "sourceConnector");
  if (input.sinkConnector) throw new AdminHttpError(400, "sinkConnector is not supported; the Warehouse endpoint is configured by Assets");
  const sourcePaths = optionalPathList(input.sourcePaths);
  if (sourcePaths.length !== 1) throw new AdminHttpError(400, "ScanPlan v2 binds one ScanRequest to exactly one source prefix or file");
  const backend = input.backend ?? "job";
  if (backend !== "job") throw new AdminHttpError(400, "the new Warehouse control plane supports Job scans only");
  const fileNamePattern = optionalText(input.fileNamePattern, "fileNamePattern", 512);
  if (fileNamePattern) throw new AdminHttpError(400, "fileNamePattern is not part of ScanPlan v2; narrow the source prefix or suffix filter");
  const tags = optionalTags(input.tags);
  if (tags.length) throw new AdminHttpError(400, "tags are not part of ScanPlan v2");
  const scanShards = safePositiveInteger(input.scanShards, "scanShards", 1, 256);
  if (scanShards > 1) throw new AdminHttpError(400, "scanShards is not part of ScanPlan v2; submit one bounded ScanRequest");
  const maxOrder = safePositiveInteger(input.maxOrder, "maxOrder", 8, 12);
  const allowedSuffixes = optionalText(input.allowedSuffixes, "allowedSuffixes", 128);
  const batchId = input.batchId ? dnsName(input.batchId, "batchId") : `${name}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  if (input.objectIndex !== undefined) throw new AdminHttpError(400, "objectIndex is not part of ScanPlan v2");
  const fileIndex = indexName(input.fileIndex || "ast_file_index_v1", "fileIndex");
  const coverageIndex = indexName(input.coverageIndex || "ast_coverage_index_v1", "coverageIndex");
  if (fileIndex !== "ast_file_index_v1" || coverageIndex !== "ast_coverage_index_v1") throw new AdminHttpError(400, "Warehouse v2 uses the fixed ast_* index contract");
  const sourceConnectorPlan = buildSourceConnectorPlan(connector);

  const extractionMode = mode === "nested-healpix" ? "catalog-healpix" : mode;
  const catalog: Record<string, unknown> = {};
  if (extractionMode === "catalog-radec") {
    catalog.raColumn = requireText(input.raColumn, "raColumn", 128);
    catalog.decColumn = requireText(input.decColumn, "decColumn", 128);
  }
  if (extractionMode === "catalog-healpix") {
    catalog.healpixColumn = requireText(input.healpixColumn, "healpixColumn", 128);
    const hasFixedOrder = input.healpixOrder !== undefined;
    const hasOrderColumn = Boolean(input.healpixOrderColumn);
    if (hasFixedOrder === hasOrderColumn) throw new AdminHttpError(400, "catalog-healpix requires exactly one healpixOrder or healpixOrderColumn");
    if (hasFixedOrder) catalog.healpixOrder = safePositiveInteger(input.healpixOrder, "healpixOrder", 8, 29);
    else catalog.healpixOrderColumn = requireText(input.healpixOrderColumn, "healpixOrderColumn", 128);
  }

  const location = connector.type === "local"
    ? { rootPath: "/data" }
    : objectLocation(sourcePaths[0]!, connector);
  const plan = {
    version: 2,
    scanRunId: batchId,
    layer: {
      layerId,
      surveyId,
      releaseId,
      productId: input.productId ? dnsName(input.productId, "productId") : productSlug(product),
      modality: warehouseModality(input.modality, mode),
      coverageRole: warehouseCoverageRole(coverageRole),
    },
    source: { connector: sourceConnectorPlan, location },
    filters: { includeSuffixes: allowedSuffixes ? allowedSuffixes.split(/[\s,]+/).filter(Boolean) : [] },
    extraction: { mode: extractionMode, ...(extractionMode === "catalog-healpix" ? {} : { outputOrder: maxOrder }), catalog },
    sink: { connector: { type: "elasticsearch", endpoint: config.warehouseEsUrl, credentialRef: {} } },
    evidence: { outputPath: `${config.evidenceMountPath.replace(/\/+$/, "")}/${batchId}` },
  };
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "ScanRequest",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": ASSETS_MANAGED_BY,
        "atlas.zhejianglab.org/track-caller": "assets",
        "atlas.zhejianglab.org/track-task-kind": PUBLIC_COVERAGE_KIND,
        "astro.zhejianglab.org/task-kind": PUBLIC_COVERAGE_KIND,
        "astro.zhejianglab.org/task-id": name,
        "astro.zhejianglab.org/layer-id": layerId,
        "astro.zhejianglab.org/survey-id": surveyId,
        "astro.zhejianglab.org/source-connector": sourceConnector,
      },
    },
    spec: {
      scanner: {
        image: config.scannerImage,
        backoffLimit: 1,
        activeDeadlineSeconds: 86_400,
        ttlSecondsAfterFinished: 86_400,
        evidence: { claimName: config.evidenceClaimName, mountPath: config.evidenceMountPath },
      },
      credentials: connector.credentialSecretName ? {
        source: { secretName: connector.credentialSecretName, accessKeyKey: "accessKey", secretKeyKey: "secretKey" },
      } : {},
      plan,
    },
  };
}

export class AssetsAdmin {
  readonly config: AdminConfig;
  private readonly kube: KubernetesApi;

  constructor(config: AdminConfig = loadAdminConfig(), kube = new KubernetesApi(config)) {
    this.config = config;
    this.kube = kube;
  }

  publicConfig(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      authRequired: true,
      namespace: this.config.namespace,
      kubernetesConfigured: Boolean(this.config.apiBaseUrl),
      capabilities: {
        coverageModes: [...SUPPORTED_COVERAGE_MODES],
        modalities: [...SUPPORTED_MODALITIES],
        connectorTypes: [...CONNECTOR_TYPES],
        backends: ["job"],
        scanRequestApiVersion: "atlas.zhejianglab.org/v1alpha1",
        mocDiscovery: { provider: "cds", policyRef: "cds-public-moc-v1" },
      },
    };
  }

  authorize(header: string | undefined): void {
    if (!this.config.enabled) throw new AdminHttpError(404, "Assets administration is disabled");
    if (!this.config.adminToken) throw new AdminHttpError(503, "Assets admin authentication is not configured");
    if (!sameSecret(headerToken(header), this.config.adminToken)) throw new AdminHttpError(401, "Invalid Assets admin token");
  }

  async listConnectors(): Promise<ConnectorView[]> {
    const resources = await this.kube.listCore("configmaps", `app.kubernetes.io/managed-by=${ASSETS_MANAGED_BY},astro.zhejianglab.org/resource-kind=connector`, this.config.namespace);
    return resources.map(connectorView).filter((connector) => CONNECTOR_TYPES.includes(connector.type)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createConnector(input: ConnectorInput): Promise<ConnectorView> {
    const resources = connectorDetails(input, this.config.namespace);
    const resource = resources.configMap;
    const created: Array<{ plural: string; name: string; namespace?: string }> = [];
    try {
      if (resources.secret && resources.secretName) {
        await this.kube.createCore("secrets", resources.secret, this.config.namespace);
        created.push({ plural: "secrets", name: resources.secretName, namespace: this.config.namespace });
      }
      if (resources.persistentVolume && resources.persistentVolumeName) {
        await this.kube.createCore("persistentvolumes", resources.persistentVolume);
        created.push({ plural: "persistentvolumes", name: resources.persistentVolumeName });
      }
      if (resources.persistentVolumeClaim && resources.persistentVolumeClaimName) {
        await this.kube.createCore("persistentvolumeclaims", resources.persistentVolumeClaim, this.config.namespace);
        created.push({ plural: "persistentvolumeclaims", name: resources.persistentVolumeClaimName, namespace: this.config.namespace });
      }
      return connectorView(await this.kube.createCore("configmaps", resource, this.config.namespace));
    } catch (error) {
      await Promise.allSettled(created.reverse().map((entry) => this.kube.deleteCore(entry.plural, entry.name, entry.namespace)));
      if (error instanceof KubernetesApiError && error.statusCode === 409) throw new AdminHttpError(409, `Connector ${String(resource.metadata?.name)} already exists`);
      throw error;
    }
  }

  async listTasks(): Promise<CoverageTaskView[]> {
    const resources = await this.kube.list("scanrequests", `app.kubernetes.io/managed-by=${ASSETS_MANAGED_BY},astro.zhejianglab.org/task-kind=${PUBLIC_COVERAGE_KIND}`);
    return resources.map(taskView).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  async listMocDiscoveryRequests(): Promise<MocDiscoveryView[]> {
    const resources = await this.kube.list("mocdiscoveryrequests", "app.kubernetes.io/managed-by=" + ASSETS_MANAGED_BY + ",astro.zhejianglab.org/resource-kind=moc-discovery");
    return resources.map(mocDiscoveryView).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  async getMocDiscoveryRequest(name: string): Promise<MocDiscoveryView> {
    const normalized = dnsName(name, "MOC discovery request name");
    const resource = await this.kube.get("mocdiscoveryrequests", normalized);
    if (!resource || resource.metadata?.labels?.["app.kubernetes.io/managed-by"] !== ASSETS_MANAGED_BY
      || resource.metadata?.labels?.["astro.zhejianglab.org/resource-kind"] !== "moc-discovery") {
      throw new AdminHttpError(404, `MOC discovery request ${normalized} was not found`);
    }
    return mocDiscoveryView(resource);
  }

  async createMocDiscoveryRequest(input: MocDiscoveryInput): Promise<MocDiscoveryView> {
    const resource = buildMocDiscoveryResource(input, this.config.namespace);
    try {
      return mocDiscoveryView(await this.kube.create("mocdiscoveryrequests", resource));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409) {
        throw new AdminHttpError(409, `MOC discovery request ${String(resource.metadata?.name)} already exists`);
      }
      throw error;
    }
  }

  async getTask(name: string): Promise<CoverageTaskView> {
    const normalized = dnsName(name, "task name");
    const resource = await this.kube.get("scanrequests", normalized);
    if (!resource || resource.metadata?.labels?.["app.kubernetes.io/managed-by"] !== ASSETS_MANAGED_BY
      || resource.metadata?.labels?.["astro.zhejianglab.org/task-kind"] !== PUBLIC_COVERAGE_KIND) {
      throw new AdminHttpError(404, `Coverage task ${normalized} was not found`);
    }
    return taskView(resource);
  }

  async resubmitTask(name: string): Promise<CoverageTaskView> {
    const normalized = dnsName(name, "task name");
    const resource = await this.kube.get("scanrequests", normalized);
    if (!resource || resource.metadata?.labels?.["app.kubernetes.io/managed-by"] !== ASSETS_MANAGED_BY
      || resource.metadata?.labels?.["astro.zhejianglab.org/task-kind"] !== PUBLIC_COVERAGE_KIND) {
      throw new AdminHttpError(404, `Coverage task ${normalized} was not found`);
    }
    const originalSpec = resource.spec ?? {};
    const originalPlan = originalSpec.plan && typeof originalSpec.plan === "object" ? originalSpec.plan as Record<string, unknown> : {};
    const sourceLabel = resource.metadata?.labels?.["astro.zhejianglab.org/source-connector"];
    if (!sourceLabel) throw new AdminHttpError(400, `Coverage task ${normalized} has no source connector label`);
    const sourceName = dnsName(sourceLabel, "sourceConnector");
    const source = await this.kube.getCore("configmaps", sourceName, this.config.namespace);
    if (!source) throw new AdminHttpError(400, `Source connector ${sourceName} was not found`);
    const sourceType = source.data?.type;
    if (sourceType !== "s3" && sourceType !== "oss") {
      throw new AdminHttpError(400, "Source connector must be S3 / OSS for Warehouse ScanRequest resubmission");
    }
    const definition = connectorDefinition(source);
    if (!definition.credentialSecretName) throw new AdminHttpError(400, `Source connector ${sourceName} has no credential Secret reference`);
    const credentialSecret = await this.kube.getCore("secrets", definition.credentialSecretName, this.config.namespace);
    if (!credentialSecret) throw new AdminHttpError(400, `Source connector ${sourceName} credential Secret is missing`);
    const originalSource = originalPlan.source && typeof originalPlan.source === "object"
      ? originalPlan.source as Record<string, unknown> : {};
    const refreshedSpec = structuredClone(originalSpec);
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const retryName = dnsName(`${normalized.slice(0, 45)}-retry-${timestamp}`, "retry task name");
    const retryRunId = retryName;
    const evidence = originalPlan.evidence && typeof originalPlan.evidence === "object" ? originalPlan.evidence as Record<string, unknown> : {};
    refreshedSpec.credentials = {
      source: { secretName: definition.credentialSecretName, accessKeyKey: "accessKey", secretKeyKey: "secretKey" },
    };
    refreshedSpec.plan = {
      ...structuredClone(originalPlan),
      source: { ...structuredClone(originalSource), connector: buildSourceConnectorPlan(definition) },
      scanRunId: retryRunId,
      evidence: { ...structuredClone(evidence), outputPath: `${this.config.evidenceMountPath.replace(/\/+$/, "")}/${retryRunId}` },
    };
    const retryResource: KubernetesResource = {
      apiVersion: resource.apiVersion ?? "atlas.zhejianglab.org/v1alpha1",
      kind: resource.kind ?? "ScanRequest",
      metadata: {
        name: retryName,
        namespace: resource.metadata?.namespace ?? this.config.namespace,
        labels: {
          ...(resource.metadata?.labels ?? {}),
          "astro.zhejianglab.org/task-id": retryName,
          "astro.zhejianglab.org/retry-of": normalized,
        },
      },
      spec: refreshedSpec,
    };
    try {
      return taskView(await this.kube.create("scanrequests", retryResource));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409) throw new AdminHttpError(409, `Coverage task ${retryName} already exists`);
      throw error;
    }
  }

  async createTask(input: CoverageTaskInput): Promise<CoverageTaskView> {
    if (input.sinkConnector) throw new AdminHttpError(400, "sinkConnector is not supported");
    const sourceName = dnsName(input.sourceConnector, "sourceConnector");
    const source = await this.kube.getCore("configmaps", sourceName, this.config.namespace);
    if (!source) throw new AdminHttpError(400, `Source connector ${sourceName} was not found`);
    const sourceType = source.data?.type;
    if (sourceType !== "s3" && sourceType !== "oss" && sourceType !== "local") throw new AdminHttpError(400, "Source connector must be S3 / OSS or local");
    if (sourceType === "local") throw new AdminHttpError(400, "local connectors are registered for inventory, but Warehouse ScanRequest currently supports remote object stores only");
    const definition = connectorDefinition(source);
    if (!definition.credentialSecretName) throw new AdminHttpError(400, `Source connector ${sourceName} has no credential Secret reference`);
    const credentialSecret = await this.kube.getCore("secrets", definition.credentialSecretName, this.config.namespace);
    if (!credentialSecret) throw new AdminHttpError(400, `Source connector ${sourceName} credential Secret is missing`);
    const resource = buildTaskResource({ ...input, sourceConnector: sourceName }, this.config.namespace, definition, this.config);
    try {
      return taskView(await this.kube.create("scanrequests", resource));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409) throw new AdminHttpError(409, `Coverage task ${String(resource.metadata?.name)} already exists`);
      throw error;
    }
  }
}

export function adminFromRequest(request: IncomingMessage): string | undefined {
  return request.headers.authorization;
}

export { buildConnectorResource, buildConnectorResources, buildTaskResource, connectorView, taskView };
