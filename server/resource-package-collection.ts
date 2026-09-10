import { createHash } from "node:crypto";

import yazl from "yazl";

import type { ProjectedResourcePackage } from "./resource-package-projection.js";
import { isDeniedSurvey } from "./publication-policy.js";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

export interface CollectionPackageInput {
  downloadName: string;
  zipBytes: Buffer;
  projection: ProjectedResourcePackage;
}

export interface ResourcePackageCollectionInput {
  releaseId: string;
  sequence: number;
  bundleId: string;
  releasedAt: string;
  notes?: string;
  catalogBytes: Buffer;
  packages: CollectionPackageInput[];
}

export interface ResourcePackageCollectionOutput {
  fileName: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

export interface CollectionDescriptor {
  schemaVersion: 1;
  releaseId: string;
  sequence: number;
  bundleId: string;
  releasedAt: string;
  notes?: string;
  packages: Array<ProjectedResourcePackage & { archivePath: string; downloadUrl: string }>;
}

function packageVersionDownloadUrl(id: string, version: string): string {
  return `/api/v1/resource-packages/${id}/versions/${version}/download`;
}

export async function buildResourcePackageCollection(
  input: ResourcePackageCollectionInput,
): Promise<ResourcePackageCollectionOutput> {
  for (const pkg of input.packages) {
    if (isDeniedSurvey(pkg.projection.survey.id)) {
      throw new Error(
        `Release collection cannot include packages for excluded survey ${pkg.projection.survey.id}`,
      );
    }
  }
  const descriptor: CollectionDescriptor = {
    schemaVersion: 1,
    releaseId: input.releaseId,
    sequence: input.sequence,
    bundleId: input.bundleId,
    releasedAt: input.releasedAt,
    ...(input.notes ? { notes: input.notes } : {}),
    packages: input.packages
      .slice()
      .sort((a, b) => a.projection.id.localeCompare(b.projection.id))
      .map((pkg) => ({
        ...pkg.projection,
        archivePath: `packages/${pkg.downloadName}`,
        downloadUrl: packageVersionDownloadUrl(pkg.projection.id, pkg.projection.version),
      })),
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  const zipFile = new yazl.ZipFile();
  zipFile.addBuffer(input.catalogBytes, "catalog.json", {
    mtime: ZIP_EPOCH,
    mode: 0o100644,
    compress: true,
    forceDosTimestamp: true,
  });
  zipFile.addBuffer(descriptorBytes, "collection.json", {
    mtime: ZIP_EPOCH,
    mode: 0o100644,
    compress: true,
    forceDosTimestamp: true,
  });
  for (const pkg of input.packages.slice().sort((a, b) => a.downloadName.localeCompare(b.downloadName))) {
    zipFile.addBuffer(pkg.zipBytes, `packages/${pkg.downloadName}`, {
      mtime: ZIP_EPOCH,
      mode: 0o100644,
      compress: false,
      forceDosTimestamp: true,
    });
  }
  zipFile.end();
  const bytes = await collectZipOutput(zipFile);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    fileName: `${input.releaseId}-resource-packages.zip`,
    bytes,
    sizeBytes: bytes.byteLength,
    sha256,
  };
}

function collectZipOutput(zipFile: yazl.ZipFile): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zipFile.outputStream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    zipFile.outputStream.on("error", reject);
    zipFile.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
