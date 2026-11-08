import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type * as Globe from "@astro-survey-atlas/sky-globe";
import type * as Server from "../src/sky-depth.js";

const packageSource = path.resolve(import.meta.dirname, "../node_modules/@astro-survey-atlas/sky-globe/src");
const ALLOWED_BARE = /^(three|three\/addons\/.+|healpixjs)$/;

test("sky-globe imports only three, healpixjs and its own modules", async () => {
  const offenders: string[] = [];
  for (const file of await readdir(packageSource)) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(path.join(packageSource, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      const ok = specifier!.startsWith("./") ? !specifier!.includes("/", 2) : ALLOWED_BARE.test(specifier!);
      if (!ok) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Compile-time: the package's copy of the sky-depth wire types must stay
// interchangeable with the server's, in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const skyDepthTypesMatch: [
  Same<Globe.SkyDepthResponse, Server.SkyDepthResponse>,
  Same<Globe.SkyDepthSourceResult, Server.SkyDepthSourceResult>,
  Same<Globe.SkyDepthVoxel, Server.SkyDepthVoxel>,
  Same<Globe.SkyDepthQuery, Server.SkyDepthQuery>,
] = [true, true, true, true];

test("sky-depth wire types match the server definition", () => {
  assert.deepEqual(skyDepthTypesMatch, [true, true, true, true]);
});
