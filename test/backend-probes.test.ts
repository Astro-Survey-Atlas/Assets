import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backendTemplate = new URL("../charts/astro-survey-atlas-assets/templates/backend.yaml", import.meta.url);

function probeBlock(template: string, name: "readiness" | "liveness"): string {
  const lines = template.split(/\r?\n/);
  const start = lines.findIndex(line => line === `          ${name}Probe:`);
  assert.notEqual(start, -1, `backend ${name} probe is present`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const indentation = line.match(/^ */)?.[0].length ?? 0;
    if (line.trim() && indentation <= 10) break;
    block.push(line);
  }
  return block.join("\n");
}

test("backend readiness checks HTTP while liveness only checks the listening port", async () => {
  const template = await readFile(backendTemplate, "utf8");
  const readiness = probeBlock(template, "readiness");
  const liveness = probeBlock(template, "liveness");

  assert.match(readiness, /^\s+httpGet:/m);
  assert.match(liveness, /^\s+tcpSocket:/m);
  assert.doesNotMatch(liveness, /^\s+httpGet:/m);
});
