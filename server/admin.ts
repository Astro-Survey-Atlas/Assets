import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { request as httpRequest, type IncomingMessage, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";

const API_GROUP = "/apis/org.zhejianglab.astro.metadata/v1alpha1";
export const ASSETS_MANAGED_BY = "astro-survey-atlas-assets";
export const PUBLIC_COVERAGE_KIND = "public-coverage";
export const SUPPORTED_COVERAGE_MODES = ["fits-wcs", "catalog-radec", "nested-healpix"] as const;
export const CONNECTOR_TYPES = ["s3", "local"] as const;
const LEGACY_CONNECTOR_TYPES = ["s3", "oss", "local"] as const;

export type CoverageMode = typeof SUPPORTED_COVERAGE_MODES[number];
export type ConnectorType = typeof LEGACY_CONNECTOR_TYPES[number];
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
  bucket?: string;
  prefix?: string;
  accessKeyConfigured?: boolean;
  pvcName?: string;
  localPath?: string;
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
  batchId?: string;
}

export interface TaskStatusView {
  phase: string;
  backend?: string;
  runId?: string;
  discoveredFiles?: number;
  processedHdus?: number;
  coverageDocuments?: number;
  objectDocuments?: number;
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

export interface CoverageTaskView {
  name: string;
  namespace?: string;
  createdAt?: string;
  layerId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  mode?: string;
  backend?: string;
  sourceConnector?: string;
  sinkConnector?: string;
  sourcePaths: string[];
  fileNamePattern?: string;
  tags: string[];
  batchId?: string;
  status: TaskStatusView;
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
    namespace: environment.ASSETS_WAREHOUSE_NAMESPACE?.trim() || "warehouse",
    adminToken: environment.ASSETS_ADMIN_TOKEN?.trim() || "",
    kubeToken: environment.ASSETS_KUBE_TOKEN?.trim() || "",
    apiBaseUrl: environment.ASSETS_KUBE_API_URL?.trim() || (host ? `https://${host}:${port}` : undefined),
    tokenFile: environment.ASSETS_KUBE_TOKEN_FILE?.trim() || "/var/run/secrets/kubernetes.io/serviceaccount/token",
    caFile: environment.ASSETS_KUBE_CA_FILE?.trim() || "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
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
  const spec = resource.spec ?? {};
  const status = resource.status ?? {};
  const annotations = resource.metadata?.annotations ?? {};
  const credential = spec.credentialSecretRef;
  const mount = spec.mount;
  const localPath = typeof annotations["astro.zhejianglab.org/local-path"] === "string"
    ? annotations["astro.zhejianglab.org/local-path"]
    : undefined;
  return {
    name: resource.metadata?.name ?? "",
    type: String(spec.type ?? "") as ConnectorType,
    endpoint: typeof spec.endpoint === "string" ? spec.endpoint : undefined,
    bucket: typeof spec.bucket === "string" ? spec.bucket : undefined,
    prefix: typeof spec.prefix === "string" ? spec.prefix : undefined,
    accessKeyConfigured: Boolean(credential && typeof credential === "object" && typeof (credential as Record<string, unknown>).name === "string"),
    pvcName: mount && typeof mount === "object" && typeof (mount as Record<string, unknown>).pvcName === "string" ? (mount as Record<string, unknown>).pvcName as string : undefined,
    localPath,
    phase: typeof status.phase === "string" ? status.phase : undefined,
    message: typeof status.message === "string" ? status.message : undefined,
    createdAt: resource.metadata?.creationTimestamp,
  };
}

function statusView(status: Record<string, unknown> | undefined): TaskStatusView {
  const value = status ?? {};
  const result: TaskStatusView = { phase: typeof value.phase === "string" ? value.phase : "Pending" };
  for (const key of ["backend", "runId", "startedAt", "completedAt", "message"] as const) {
    if (typeof value[key] === "string") result[key] = value[key] as string;
  }
  for (const key of ["discoveredFiles", "processedHdus", "coverageDocuments", "objectDocuments"] as const) {
    if (typeof value[key] === "number") result[key] = value[key] as number;
  }
  return result;
}

function taskView(resource: KubernetesResource): CoverageTaskView {
  const spec = resource.spec ?? {};
  const source = spec.source && typeof spec.source === "object" ? spec.source as Record<string, unknown> : {};
  const sourceRef = source.dataSourceRef && typeof source.dataSourceRef === "object" ? source.dataSourceRef as Record<string, unknown> : {};
  const sink = spec.sink && typeof spec.sink === "object" ? spec.sink as Record<string, unknown> : undefined;
  const sinkRef = sink?.dataSourceRef && typeof sink.dataSourceRef === "object" ? sink.dataSourceRef as Record<string, unknown> : undefined;
  const properties = spec.userProperties && typeof spec.userProperties === "object" ? spec.userProperties as Record<string, unknown> : {};
  const extraEnv = spec.extraEnv && typeof spec.extraEnv === "object" ? spec.extraEnv as Record<string, unknown> : {};
  return {
    name: resource.metadata?.name ?? "",
    namespace: resource.metadata?.namespace,
    createdAt: resource.metadata?.creationTimestamp,
    layerId: typeof properties.layerId === "string" ? properties.layerId : resource.metadata?.labels?.["astro.zhejianglab.org/layer-id"],
    surveyId: typeof properties.survey === "string" ? properties.survey : undefined,
    releaseId: typeof properties.release === "string" ? properties.release : undefined,
    product: typeof properties.product === "string" ? properties.product : undefined,
    mode: typeof properties.spatialMode === "string" ? properties.spatialMode : undefined,
    backend: typeof spec.backend === "string" ? spec.backend : "job",
    sourceConnector: typeof sourceRef.name === "string" ? sourceRef.name : undefined,
    sinkConnector: typeof sinkRef?.name === "string" ? sinkRef.name : undefined,
    sourcePaths: Array.isArray(source.paths) ? source.paths.filter((path): path is string => typeof path === "string") : [],
    fileNamePattern: typeof spec.fileNamePattern === "string"
      ? spec.fileNamePattern
      : typeof properties.fileNamePattern === "string" ? properties.fileNamePattern : undefined,
    tags: Array.isArray(spec.tags) ? spec.tags.filter((tag): tag is string => typeof tag === "string") : [],
    batchId: typeof extraEnv.batchId === "string" ? extraEnv.batchId : undefined,
    status: statusView(resource.status),
  };
}

function managedResourceName(name: string, suffix: string): string {
  const maxBaseLength = 63 - suffix.length - 1;
  const base = name.slice(0, Math.max(1, maxBaseLength)).replace(/-+$/, "");
  return dnsName(`${base}-${suffix}`, "managed resource name");
}

function validateLocalPath(value: string): string {
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
  dataSource: KubernetesResource;
  secret?: KubernetesResource;
  persistentVolume?: KubernetesResource;
  persistentVolumeClaim?: KubernetesResource;
  secretName?: string;
  persistentVolumeName?: string;
  persistentVolumeClaimName?: string;
}

function connectorDetails(input: ConnectorInput, namespace: string): ConnectorResources {
  const allowedFields = new Set(["name", "type", "endpoint", "bucket", "prefix", "accessKey", "secretKey", "localPath"]);
  const unknown = Object.keys(input as unknown as Record<string, unknown>).find((key) => !allowedFields.has(key));
  if (unknown) throw new AdminHttpError(400, `${unknown} is not supported for connectors`);
  const name = dnsName(input.name, "name");
  const type = enumValue(input.type, CONNECTOR_TYPES, "type");
  const endpoint = optionalText(input.endpoint, "endpoint", 2048);
  const bucket = optionalText(input.bucket, "bucket", 255);
  const prefix = optionalText(input.prefix, "prefix", 2048);
  const accessKey = optionalText(input.accessKey, "accessKey", 512);
  const secretKey = optionalText(input.secretKey, "secretKey", 512);
  const localPath = input.localPath === undefined ? undefined : validateLocalPath(requireText(input.localPath, "localPath", 2048));
  if (prefix?.split("/").some((segment) => segment === "." || segment === "..")) throw new AdminHttpError(400, "prefix cannot contain dot segments");

  const labels = {
    "app.kubernetes.io/managed-by": ASSETS_MANAGED_BY,
    "astro.zhejianglab.org/resource-kind": "connector",
  };
  if (type === "s3") {
    if (!endpoint) throw new AdminHttpError(400, "endpoint is required for S3 / OSS connectors");
    if (!bucket) throw new AdminHttpError(400, "bucket is required for S3 / OSS connectors");
    if (!accessKey || !secretKey) throw new AdminHttpError(400, "accessKey and secretKey are required for S3 / OSS connectors");
    if (localPath) throw new AdminHttpError(400, "localPath is only valid for local connectors");
    const secretName = managedResourceName(name, "credentials");
    const spec: Record<string, unknown> = { type, endpoint, bucket, credentialSecretRef: { name: secretName } };
    if (prefix) spec.prefix = prefix;
    return {
      dataSource: { apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource", metadata: { name, namespace, labels }, spec },
      secret: { apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace, labels }, type: "Opaque", stringData: { "access-key": accessKey, "secret-key": secretKey } },
      secretName,
    };
  }

  if (endpoint || bucket || prefix || accessKey || secretKey) throw new AdminHttpError(400, "Local connectors only accept localPath");
  if (!localPath) throw new AdminHttpError(400, "localPath is required for local connectors");
  const persistentVolumeName = managedResourceName(name, "pv");
  const persistentVolumeClaimName = managedResourceName(name, "pvc");
  const dataSource: KubernetesResource = {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroDataSource",
    metadata: { name, namespace, labels, annotations: { "astro.zhejianglab.org/local-path": localPath } },
    spec: { type, mount: { pvcName: persistentVolumeClaimName } },
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
      hostPath: { path: localPath, type: "DirectoryOrCreate" },
      claimRef: { namespace, name: persistentVolumeClaimName },
    },
  };
  const persistentVolumeClaim: KubernetesResource = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: persistentVolumeClaimName, namespace, labels },
    spec: { accessModes: ["ReadWriteOnce"], storageClassName: "", volumeName: persistentVolumeName, resources: { requests: { storage: "1Ti" } } },
  };
  return { dataSource, persistentVolume, persistentVolumeClaim, persistentVolumeName, persistentVolumeClaimName };
}

function buildConnectorResource(input: ConnectorInput, namespace: string): KubernetesResource {
  return connectorDetails(input, namespace).dataSource;
}

function buildConnectorResources(input: ConnectorInput, namespace: string): ConnectorResources {
  return connectorDetails(input, namespace);
}

function buildTaskResource(input: CoverageTaskInput, namespace: string): KubernetesResource {
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
  if (input.sinkConnector) throw new AdminHttpError(400, "sinkConnector is not supported");
  const sourcePaths = optionalPathList(input.sourcePaths);
  const backend = input.backend ?? "job";
  if (backend !== "job" && backend !== "flink") throw new AdminHttpError(400, "backend must be job or flink");
  const fileNamePattern = optionalText(input.fileNamePattern, "fileNamePattern", 512);
  if (fileNamePattern && (fileNamePattern.includes("/") || /[\u0000\r\n]/.test(fileNamePattern))) throw new AdminHttpError(400, "fileNamePattern must match a basename");
  const tags = optionalTags(input.tags);
  const scanShards = safePositiveInteger(input.scanShards, "scanShards", 1, 256);
  const maxOrder = safePositiveInteger(input.maxOrder, "maxOrder", 8, 29);
  const allowedSuffixes = optionalText(input.allowedSuffixes, "allowedSuffixes", 128);
  const batchId = input.batchId ? dnsName(input.batchId, "batchId") : `${name}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const fileIndex = indexName(input.fileIndex || "astro_file_index_v1", "fileIndex");
  const coverageIndex = indexName(input.coverageIndex || "astro_coverage_index_v1", "coverageIndex");
  const objectIndex = indexName(input.objectIndex || "astro_object_index_v1", "objectIndex");
  const userProperties: Record<string, string> = {
    survey: surveyId,
    release: releaseId,
    product,
    layerId,
    spatialMode: mode,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    maxOrder: String(maxOrder),
    queryOrder: "8",
    previewOrder: "4",
    coverageRole,
    dataOrigin,
    sourceTier,
    fileIndex,
    coverageIndex,
    objectIndex,
    ...(fileNamePattern ? { fileNamePattern } : {}),
  };
  const source: Record<string, unknown> = { dataSourceRef: { name: sourceConnector }, paths: sourcePaths };
  const spec: Record<string, unknown> = {
    backend,
    source,
    handlers: mode === "fits-wcs" ? ["default", "fits", "coverage"] : ["default", "coverage"],
    tags,
    userProperties,
    pathPatterns: {},
    extraEnv: {
      batchId,
      ...(scanShards > 1 ? { scanShards: String(scanShards) } : {}),
      ...(allowedSuffixes ? { allowedSuffixes } : {}),
    },
  };
  return {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroMetadataScanTask",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": ASSETS_MANAGED_BY,
        "astro.zhejianglab.org/task-kind": PUBLIC_COVERAGE_KIND,
        "astro.zhejianglab.org/task-id": name,
        "astro.zhejianglab.org/layer-id": layerId,
        "astro.zhejianglab.org/survey-id": surveyId,
      },
    },
    spec,
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
        connectorTypes: [...CONNECTOR_TYPES],
        backends: ["job"],
      },
    };
  }

  authorize(header: string | undefined): void {
    if (!this.config.enabled) throw new AdminHttpError(404, "Assets administration is disabled");
    if (!this.config.adminToken) throw new AdminHttpError(503, "Assets admin authentication is not configured");
    if (!sameSecret(headerToken(header), this.config.adminToken)) throw new AdminHttpError(401, "Invalid Assets admin token");
  }

  async listConnectors(): Promise<ConnectorView[]> {
    const resources = await this.kube.list("astrodatasources", `app.kubernetes.io/managed-by=${ASSETS_MANAGED_BY},astro.zhejianglab.org/resource-kind=connector`);
    return resources.map(connectorView).filter((connector) => connector.type === "s3" || connector.type === "oss" || connector.type === "local").sort((a, b) => a.name.localeCompare(b.name));
  }

  async createConnector(input: ConnectorInput): Promise<ConnectorView> {
    const resources = connectorDetails(input, this.config.namespace);
    const resource = resources.dataSource;
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
      return connectorView(await this.kube.create("astrodatasources", resource));
    } catch (error) {
      await Promise.allSettled(created.reverse().map((entry) => this.kube.deleteCore(entry.plural, entry.name, entry.namespace)));
      if (error instanceof KubernetesApiError && error.statusCode === 409) throw new AdminHttpError(409, `Connector ${String(resource.metadata?.name)} already exists`);
      throw error;
    }
  }

  async listTasks(): Promise<CoverageTaskView[]> {
    const resources = await this.kube.list("astrometadatascantasks", `app.kubernetes.io/managed-by=${ASSETS_MANAGED_BY},astro.zhejianglab.org/task-kind=${PUBLIC_COVERAGE_KIND}`);
    return resources.map(taskView).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  async createTask(input: CoverageTaskInput): Promise<CoverageTaskView> {
    if (input.sinkConnector) throw new AdminHttpError(400, "sinkConnector is not supported");
    const sourceName = dnsName(input.sourceConnector, "sourceConnector");
    const source = await this.kube.get("astrodatasources", sourceName);
    if (!source) throw new AdminHttpError(400, `Source connector ${sourceName} was not found`);
    const sourceType = source.spec?.type;
    if (sourceType !== "s3" && sourceType !== "oss" && sourceType !== "local") throw new AdminHttpError(400, "Source connector must be S3 / OSS or local");
    const resource = buildTaskResource({ ...input, sourceConnector: sourceName }, this.config.namespace);
    try {
      return taskView(await this.kube.create("astrometadatascantasks", resource));
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
