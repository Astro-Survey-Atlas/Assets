import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { AdminHttpError } from "./admin-error.js";
import { queueStateSnapshot, type StateSnapshotSink } from "./state-snapshot.js";

export const CONNECTOR_ICON_MAX_BYTES = 64 * 1024;
const ICON_PATH = "/api/v1/connector-icons/";
interface ConnectorReference { name: string; namespace: string; uid?: string }
interface IconContent { contentType: string; base64: string }
interface PresentationState {
  schemaVersion: 1;
  connectors: Record<string, { uid?: string; iconUrl: string }>;
  icons: Record<string, IconContent>;
}

/** Icons are presentation only; no connection endpoint or credential is stored. */
export class ConnectorPresentationStore {
  #state?: PresentationState;
  #loadPromise?: Promise<PresentationState>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly sink?: StateSnapshotSink) {}

  async iconUrl(reference: ConnectorReference): Promise<string | undefined> {
    const value = (await this.load()).connectors[this.key(reference)];
    if (!value || (value.uid && value.uid !== reference.uid)) return undefined;
    return value.iconUrl;
  }

  async setIcon(reference: ConnectorReference, value: unknown): Promise<void> {
    const icon = parseConnectorIcon(value);
    const operation = this.#writeQueue.catch(() => undefined).then(async () => {
      const state = structuredClone(await this.load());
      const key = this.key(reference);
      if (!icon) delete state.connectors[key];
      else {
        let iconUrl = icon.url;
        if (icon.content) {
          const hash = createHash("sha256").update(Buffer.from(icon.content.base64, "base64")).digest("hex");
          state.icons[hash] = icon.content;
          iconUrl = `${ICON_PATH}${hash}`;
        }
        state.connectors[key] = { ...(reference.uid ? { uid: reference.uid } : {}), iconUrl: iconUrl! };
      }
      await mkdir(this.root, { recursive: true });
      const destination = path.join(this.root, "connector-presentation-v1.json");
      const temporary = `${destination}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, destination);
      this.#state = state;
      await queueStateSnapshot(this.sink, "connector-presentation", state);
    });
    this.#writeQueue = operation;
    await operation;
  }

  async readIcon(hash: string): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
    const content = (await this.load()).icons[hash];
    return content ? { bytes: Buffer.from(content.base64, "base64"), contentType: content.contentType } : undefined;
  }

  private key(reference: ConnectorReference): string { return `${reference.namespace}/${reference.name}`; }

  private async load(): Promise<PresentationState> {
    if (this.#state) return this.#state;
    if (!this.#loadPromise) this.#loadPromise = (async () => {
      let raw: unknown;
      try { raw = JSON.parse(await readFile(path.join(this.root, "connector-presentation-v1.json"), "utf8")); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        raw = (await this.sink?.restore?.("connector-presentation"))?.state;
      }
      if (raw === undefined || raw === null) return { schemaVersion: 1, connectors: {}, icons: {} };
      const state = raw as Partial<PresentationState>;
      if (state.schemaVersion !== 1 || !state.connectors || !state.icons || Array.isArray(state.connectors) || Array.isArray(state.icons)) throw new Error("Invalid Connector presentation state");
      return state as PresentationState;
    })();
    this.#state = await this.#loadPromise;
    return this.#state;
  }
}

/** Accept browser-safe URLs or a small raster upload; Assets never fetches a remote URL. */
export function parseConnectorIcon(value: unknown): { url?: string; content?: IconContent } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AdminHttpError(400, "iconUrl must be a URL, raster image data URL, or null");
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp|x-icon|vnd.microsoft.icon));base64,([A-Za-z0-9+/]+={0,2})$/.exec(text);
    if (!match || text.length > CONNECTOR_ICON_MAX_BYTES * 4 / 3 + 128) throw new AdminHttpError(400, "Upload a PNG, JPEG, WebP or ICO icon of at most 64 KiB");
    const bytes = Buffer.from(match[2]!, "base64");
    const type = match[1]!;
    const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : type === "image/webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      : bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) && bytes.length >= 6 && bytes.readUInt16LE(4) > 0;
    if (!bytes.length || bytes.length > CONNECTOR_ICON_MAX_BYTES || !valid || bytes.toString("base64") !== match[2]) throw new AdminHttpError(400, "The icon contents do not match the declared image format");
    return { content: { contentType: type, base64: match[2]! } };
  }
  if (text.length > 2048 || /[\s\\]/.test(text)) throw new AdminHttpError(400, "iconUrl must be a valid URL of at most 2048 characters");
  let url: URL;
  try { url = new URL(text, "https://assets.invalid"); }
  catch { throw new AdminHttpError(400, "Invalid iconUrl"); }
  if ((!text.startsWith("/") && !/^https?:\/\//.test(text)) || text.startsWith("//") || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AdminHttpError(400, "iconUrl must be HTTP(S) or an absolute site path without credentials");
  return { url: text };
}
