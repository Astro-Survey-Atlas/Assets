import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type RegistryEntry = {
  id: string;
  surveyId: string;
  releaseId: string;
  product: string;
  sourceKind: string;
  sourceUrl: string;
  recordUrl: string;
  mocUrl: string;
  maxOrder: number;
  overviewOrder: number;
  coverageRole: "object_presence" | "footprint_extent";
  dataOrigin: "observed" | "catalog";
  sourceTier: "third_party_moc";
  precision: "exact" | "estimated";
  licenseStatus: string;
  status: "candidate" | "awaiting_snapshot" | "acquired" | "rejected";
};

const root = path.resolve(import.meta.dirname, "..");
const registryPath = path.join(root, "src", "moc-sources", "source-registry.json");
const args = new Set(process.argv.slice(2));
const probe = args.has("--probe");
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));

function fail(message: string): never { throw new Error(message); }

function requireUrl(value: unknown, field: string, hosts: string[] = []): string {
  if (typeof value !== "string" || !value) fail(`${field} is required`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail(`${field} must be a URL`); }
  if (!(["http:", "https:"].includes(parsed.protocol))) fail(`${field} must use http or https`);
  if (hosts.length && !hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) fail(`${field} is outside its source allowlist`);
  return value;
}

function validateEntry(value: unknown, index: number): RegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`sources[${index}] must be an object`);
  const entry = value as Record<string, unknown>;
  const required = ["id", "surveyId", "releaseId", "product", "sourceKind", "sourceUrl", "recordUrl", "mocUrl", "licenseStatus"];
  for (const field of required) if (typeof entry[field] !== "string" || !entry[field]) fail(`sources[${index}].${field} is required`);
  const maxOrder = entry.maxOrder;
  const overviewOrder = entry.overviewOrder;
  if (!Number.isSafeInteger(maxOrder) || (maxOrder as number) < 0 || (maxOrder as number) > 29) fail(`sources[${index}].maxOrder is invalid`);
  if (!Number.isSafeInteger(overviewOrder) || (overviewOrder as number) < 0 || (overviewOrder as number) > (maxOrder as number)) fail(`sources[${index}].overviewOrder is invalid`);
  if (entry.sourceTier !== "third_party_moc") fail(`sources[${index}].sourceTier must be third_party_moc`);
  if (!["object_presence", "footprint_extent"].includes(String(entry.coverageRole))) fail(`sources[${index}].coverageRole is invalid`);
  if (!["observed", "catalog"].includes(String(entry.dataOrigin))) fail(`sources[${index}].dataOrigin is invalid`);
  if (!["exact", "estimated"].includes(String(entry.precision))) fail(`sources[${index}].precision is invalid`);
  if (!["candidate", "awaiting_snapshot", "acquired", "rejected"].includes(String(entry.status))) fail(`sources[${index}].status is invalid`);
  if (entry.coverageRole === "object_presence" && entry.dataOrigin !== "catalog") fail(`sources[${index}] object presence must be catalog data`);
  requireUrl(entry.sourceUrl, `sources[${index}].sourceUrl`);
  requireUrl(entry.recordUrl, `sources[${index}].recordUrl`, ["alasky.unistra.fr", "alasky.cds.unistra.fr"]);
  const mocUrl = requireUrl(entry.mocUrl, `sources[${index}].mocUrl`, ["alasky.unistra.fr", "alasky.cds.unistra.fr"]);
  const query = new URL(mocUrl).searchParams;
  if (query.get("get") !== "smoc" || query.get("fmt") !== "fits") fail(`sources[${index}].mocUrl must request FITS SMOC`);
  if (Number(query.get("order")) !== maxOrder) fail(`sources[${index}].mocUrl order must equal maxOrder`);
  return entry as unknown as RegistryEntry;
}

function cardValue(cards: string[], key: string): string | undefined {
  const card = cards.find((value) => value.slice(0, 8).trim() === key);
  if (!card || card[8] !== "=") return undefined;
  return card.slice(10).split("/", 1)[0]?.trim().replace(/^'|'$/g, "").trim();
}

function cardInteger(cards: string[], key: string, fallback = 0): number {
  const value = Number.parseInt(cardValue(cards, key) ?? "", 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

function fitsHeaders(bytes: Uint8Array): string[][] {
  const headers: string[][] = [];
  let offset = 0;
  for (let hdu = 0; hdu < 64 && offset + 80 <= bytes.length; hdu += 1) {
    const cards: string[] = [];
    let endOffset = -1;
    for (let cursor = offset; cursor + 80 <= bytes.length; cursor += 80) {
      const card = Buffer.from(bytes.slice(cursor, cursor + 80)).toString("ascii");
      cards.push(card);
      if (card.slice(0, 8).trim() === "END") { endOffset = cursor + 80; break; }
    }
    if (endOffset < 0) fail("FITS header is missing an END card");
    headers.push(cards);
    const headerBytes = Math.ceil((endOffset - offset) / 2880) * 2880;
    const extension = cardValue(cards, "XTENSION");
    const naxis = cardInteger(cards, "NAXIS");
    const pcount = Math.max(0, cardInteger(cards, "PCOUNT"));
    const gcount = Math.max(1, cardInteger(cards, "GCOUNT", 1));
    let dataBytes = 0;
    if (extension === "BINTABLE" || extension === "TABLE") {
      dataBytes = (Math.max(0, cardInteger(cards, "NAXIS1")) * Math.max(0, cardInteger(cards, "NAXIS2")) + pcount) * gcount;
    } else if (naxis > 0) {
      let elements = 1;
      for (let axis = 1; axis <= naxis; axis += 1) elements *= Math.max(0, cardInteger(cards, `NAXIS${axis}`));
      dataBytes = Math.ceil(Math.abs(cardInteger(cards, "BITPIX")) * elements / 8) * gcount + pcount;
    }
    offset += headerBytes + Math.ceil(dataBytes / 2880) * 2880;
    if (offset >= bytes.length) break;
  }
  return headers;
}

function validateFits(bytes: Uint8Array, entry: RegistryEntry): { mocOrder?: number; ordering?: string; coordinateSystem?: string; uniqColumn: boolean } {
  const cards = fitsHeaders(bytes).flat();
  const ordering = cardValue(cards, "ORDERING");
  const coordinateSystem = cardValue(cards, "COORDSYS");
  const mocOrder = Number(cardValue(cards, "MOCORDER"));
  const uniqColumn = cards.some((card) => /^TTYPE\d+$/.test(card.slice(0, 8).trim()) && cardValue([card], card.slice(0, 8).trim()) === "UNIQ");
  if (ordering !== "NUNIQ") fail(`${entry.id}: FITS MOC ordering is not NUNIQ`);
  if (coordinateSystem !== "C") fail(`${entry.id}: FITS MOC COORDSYS is not C/ICRS`);
  if (!Number.isSafeInteger(mocOrder) || mocOrder < 0 || mocOrder > entry.maxOrder) fail(`${entry.id}: FITS MOCORDER exceeds locked maxOrder`);
  if (!uniqColumn) fail(`${entry.id}: FITS MOC does not contain a UNIQ column`);
  return { mocOrder, ordering, coordinateSystem, uniqColumn };
}

async function fetchWithRetry(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "astro-survey-atlas-assets-moc-registry/1" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const registry = JSON.parse(await readFile(registryPath, "utf8")) as { schemaVersion?: number; coordinateFrame?: string; ordering?: string; sources?: unknown[] };
if (registry.schemaVersion !== 1 || registry.coordinateFrame !== "ICRS" || registry.ordering !== "NESTED" || !Array.isArray(registry.sources)) fail("source registry header is invalid");
const entries = registry.sources.map(validateEntry);
if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail("source registry IDs must be unique");

const report: Array<Record<string, unknown>> = [];
for (const entry of entries) {
  const item: Record<string, unknown> = { id: entry.id, status: entry.status, mocUrl: entry.mocUrl, maxOrder: entry.maxOrder };
  if (probe && entry.status !== "rejected") {
    const record = await fetchWithRetry(entry.recordUrl);
    const moc = await fetchWithRetry(entry.mocUrl);
    const fits = validateFits(moc, entry);
    item.recordSha256 = createHash("sha256").update(record).digest("hex");
    item.sourceSnapshotSha256 = createHash("sha256").update(moc).digest("hex");
    item.sourceSnapshotSizeBytes = moc.byteLength;
    item.validation = fits;
  }
  report.push(item);
}

if (outputArg) {
  const output = path.resolve(root, outputArg.slice("--output=".length));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), entries: report }, null, 2)}\n`, "utf8");
}
console.log(`${probe ? "Probed" : "Validated"} ${entries.length} MOC source registry entries${outputArg ? ` -> ${outputArg.slice("--output=".length)}` : ""}`);
