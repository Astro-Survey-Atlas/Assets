import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = path.resolve(process.env.RELEASE_ASSET_OUTPUT_ROOT ?? path.join(process.cwd(), "dist", "code-assets"));
const notesPath = path.resolve(process.env.RELEASE_NOTES_PATH ?? path.join(process.cwd(), "dist", "CODE-RELEASE-NOTES.md"));
const tag = process.env.RELEASE_TAG ?? "";
const version = process.env.RELEASE_VERSION ?? "";
const commit = process.env.RELEASE_COMMIT ?? "";
const image = process.env.RELEASE_IMAGE ?? "";
const digest = process.env.RELEASE_IMAGE_DIGEST ?? "";
const mirror = process.env.RELEASE_IMAGE_MIRROR ?? "";
const chart = process.env.RELEASE_CHART ?? "";

if (!/^code-v\d+\.\d+\.\d+$/.test(tag) || tag !== `code-v${version}` || !/^[a-f0-9]{40}$/.test(commit)
  || !image || !/^sha256:[a-f0-9]{64}$/.test(digest) || !chart) {
  throw new Error("Code release requires a matching semver tag, source commit, image digest and chart reference");
}

await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, "CODE-RELEASE-INFO.json"), `${JSON.stringify({
  schemaVersion: 1,
  releaseKind: "code",
  tag,
  version,
  sourceCommit: commit,
  image: { reference: image, digest, mirror: mirror || undefined },
  chart,
  dataPackage: "published by the independent Data Package Release workflow",
}, null, 2)}\n`);

const notes = [
  `## Astro Survey Atlas Assets ${version} code release`,
  "",
  "This release contains application code and deployment artifacts. It does not read or package the public data store.",
  "",
  "### Container image",
  "",
  `- \`${image}\` @ \`${digest}\``,
  ...(mirror ? [`- \`${mirror}\` (Aliyun mirror)`] : []),
  "",
  "### Helm chart",
  "",
  "```sh",
  "helm upgrade --install astro-survey-atlas-assets \\",
  `  ${chart} \\`,
  `  --version ${version} \\`,
  "  --namespace astro-survey-atlas-assets --create-namespace \\",
  "  --values <environment-values.yaml>",
  "```",
  "",
  "Public coverage and resource package archives are versioned separately by a Data Package Release.",
  "See CODE-RELEASE-INFO.json and SHA256SUMS for source, image and asset coordinates.",
  "",
].join("\n");
await mkdir(path.dirname(notesPath), { recursive: true });
await writeFile(notesPath, notes);
