import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError, AssetsAdmin, buildConnectorResource, type AdminConfig, type KubernetesResource } from "../server/admin.js";
import { ConnectorProbeStateStore } from "../server/connector-state.js";
import { ConnectorPresentationStore, parseConnectorIcon } from "../server/connector-presentation.js";
import { connectorDefaultIcon } from "../src/connector-icon.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const upload = `data:image/png;base64,${png}`;
const reference = { namespace: "warehouse", name: "mirror", uid: "resource-1" };

test("uploaded icons survive restart and authority restore; old immutable icons survive a reset", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connector-icon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let archived: unknown;
  const sink = { enqueue: async (namespace: string, state: unknown) => { assert.equal(namespace, "connector-presentation"); archived = structuredClone(state); return {} as never; } };
  const first = new ConnectorPresentationStore(root, sink);
  await first.setIcon(reference, upload);
  const second = new ConnectorPresentationStore(root);
  const url = (await second.iconUrl(reference))!;
  assert.match(url, /^\/api\/v1\/connector-icons\/[a-f0-9]{64}$/);
  const hash = url.split("/").pop()!;
  assert.deepEqual((await second.readIcon(hash))?.bytes, Buffer.from(png, "base64"));
  assert.equal((await second.readIcon(hash))?.contentType, "image/png");
  assert.equal(await second.iconUrl({ ...reference, uid: "replacement-resource" }), undefined);
  assert.doesNotMatch(await readFile(path.join(root, "connector-presentation-v1.json"), "utf8"), /endpoint|accessKey|secretKey/);
  await rm(path.join(root, "connector-presentation-v1.json"));
  const restored = new ConnectorPresentationStore(root, { ...sink, restore: async () => ({ state: archived, pointer: {} as never }) });
  assert.equal(await restored.iconUrl(reference), url);
  await restored.setIcon(reference, null);
  assert.equal(await new ConnectorPresentationStore(root).iconUrl(reference), undefined);
  assert.deepEqual((await restored.readIcon(hash))?.bytes, Buffer.from(png, "base64"), "frozen manifest URLs continue to work");
});

test("Connector icons accept safe locations and raster uploads, rejecting executable or credential-bearing input", () => {
  for (const url of ["https://example.org/icon.png", "/api/v1/connector-icons/example"]) assert.deepEqual(parseConnectorIcon(url), { url });
  assert.ok(parseConnectorIcon(upload)?.content);
  for (const value of ["javascript:alert(1)", "//other.example/icon.png", "https://user:password@example.org/icon.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,aW52YWxpZA==", `data:image/png;base64,${Buffer.alloc(65537).toString("base64")}`, { icon: "image" }]) {
    assert.throws(() => parseConnectorIcon(value), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  }
  assert.equal(connectorDefaultIcon("oss"), "cloud");
  assert.equal(connectorDefaultIcon("local"), "hard-drive");
  assert.equal(connectorDefaultIcon("unknown"), "plug");
});

const config: AdminConfig = { enabled: true, namespace: "warehouse", adminToken: "fixture", kubeToken: "fixture", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };

test("admin icon edits persist separately and preserve Connector configuration and successful probe state", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connector-icon-admin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resource = buildConnectorResource({ name: "mirror", type: "local", pvcName: "public-source", iconUrl: "https://example.org/icon.png" }, config.namespace);
  resource.metadata!.uid = reference.uid;
  const original = structuredClone(resource);
  const kube = {
    listCore: async () => [resource],
    getCore: async (plural: string, name: string) => plural === "configmaps" ? name === "mirror" ? resource : null
      : { metadata: { labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Bound" } },
  };
  const makeAdmin = () => new AssetsAdmin(config, kube as never, undefined, new ConnectorProbeStateStore(root), undefined, new ConnectorPresentationStore(root));
  const admin = makeAdmin();
  assert.equal((await admin.probeConnector("mirror")).phase, "READY");
  const changed = await admin.updateConnectorIcon("mirror", { iconUrl: upload });
  assert.match(changed.iconUrl!, /connector-icons/);
  assert.equal(changed.phase, "READY");
  assert.equal((await makeAdmin().listConnectors())[0]?.iconUrl, changed.iconUrl);
  assert.equal((await makeAdmin().probeConnector("mirror")).iconUrl, changed.iconUrl);
  assert.deepEqual(resource, original, "no Kubernetes configuration, credential or scan mutation");
  assert.equal((await admin.updateConnectorIcon("mirror", { iconUrl: null })).iconUrl, undefined);
  await assert.rejects(admin.updateConnectorIcon("missing", { iconUrl: upload }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 404);
  await assert.rejects(admin.updateConnectorIcon("mirror", { iconUrl: upload, endpoint: "https://changed.example" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});

test("Warehouse-native Connectors can customize presentation without editing their spec or status", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connector-icon-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resource: KubernetesResource = { apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource", metadata: { name: "mirror", uid: reference.uid }, spec: { type: "s3", bucket: "public" }, status: { phase: "Ready" } };
  const original = structuredClone(resource);
  const kube = { getCore: async () => null, getDataSource: async () => resource, listCore: async () => [], listDataSources: async () => [resource] };
  const admin = new AssetsAdmin(config, kube as never, undefined, undefined, undefined, new ConnectorPresentationStore(root));
  assert.equal((await admin.updateConnectorIcon("mirror", { iconUrl: "https://example.org/native.png" })).iconUrl, "https://example.org/native.png");
  assert.deepEqual(resource, original);
});
