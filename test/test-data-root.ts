import path from "node:path";

import { projectRoot } from "../server/paths.js";

export const testDataRoot = path.resolve(process.env.ASSET_TEST_DATA_ROOT ?? process.env.ASSET_WORKTREE_ROOT ?? projectRoot);
export const testArtifactRoot = path.resolve(process.env.ASSET_TEST_ARTIFACT_ROOT ?? path.join(testDataRoot, "artifacts", "public-survey-footprints"));
export const testSourceRoot = projectRoot;
