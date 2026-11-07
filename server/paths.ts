import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
export const projectRoot = path.basename(moduleRoot) === "dist" ? path.dirname(moduleRoot) : moduleRoot;
export const artifactRoot = path.join(projectRoot, "artifacts", "public-survey-footprints");
export const releaseManifestPath = path.join(artifactRoot, "release-manifest.json");
