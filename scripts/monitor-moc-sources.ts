/**
 * Observe every official MOC source in the registry and report drift and failures.
 *
 *   npm run moc:monitor                      # compare against registry baselines, print summary
 *   npm run moc:monitor -- --state=PATH      # persist per-source health between runs
 *
 * Read-only toward the registry: it never edits it, builds a MOC, or publishes.
 * Exit code 0 even when sources drift or fail (that is a report, not a crash); 2 when a
 * source has failed FAILURE_ALERT_THRESHOLD runs in a row so schedulers can alert.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchPublicSource } from "../server/public-source-fetch.js";
import { runMonitor, type MonitoredSource, type MonitorState } from "../server/moc-source-monitor.js";

const root = path.resolve(import.meta.dirname, "..");
const stateArg = process.argv.find(arg => arg.startsWith("--state="))?.slice("--state=".length);
const statePath = stateArg ? path.resolve(stateArg) : undefined;

const registry = JSON.parse(await readFile(path.join(root, "src", "moc-sources", "source-registry.json"), "utf8")) as { sources: MonitoredSource[] };
const previous: MonitorState = statePath
  ? await readFile(statePath, "utf8").then(text => JSON.parse(text) as MonitorState, () => ({}))
  : {};

const fetchBytes = async (url: string) => new Uint8Array((await fetchPublicSource(url, 64 * 1024 * 1024, AbortSignal.timeout(60_000))).bytes);
const { state, summary } = await runMonitor(registry.sources, previous, fetchBytes, new Date().toISOString());

if (statePath) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.alerting.length ? 2 : 0);
