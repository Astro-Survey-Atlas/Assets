import yauzl from "yauzl";

const PACKAGE_MANIFEST_ENTRY = "resource-package.json";
const PACKAGE_SCHEMA_VERSION = 3;

export class PackageInspectionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "PackageInspectionError";
    this.statusCode = statusCode;
  }
}

export interface ResourcePackageLayerRecord {
  layerId: string;
  surveyId: string;
  releaseId: string;
  modality: string;
  coverageRole?: string;
  dataOrigin?: string;
  sourceTier?: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ResourcePackageManifest {
  schemaVersion: number;
  id: string;
  version: string;
  surveyId: string;
  layers: ResourcePackageLayerRecord[];
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

function readEntry(zipfile: yauzl.ZipFile, fileName: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // ignore close failures after errors
      }
      reject(error);
    };
    zipfile.on("error", fail);
    zipfile.on("end", () => {
      fail(new PackageInspectionError(`Resource package archive does not contain ${fileName}`));
    });
    zipfile.on("entry", (entry: yauzl.Entry) => {
      if (settled) return;
      if (entry.fileName !== fileName) {
        zipfile.readEntry();
        return;
      }
      zipfile.openReadStream(entry, (error, readStream) => {
        if (error || !readStream) {
          fail(error ?? new PackageInspectionError(`Unable to read ${fileName} from resource package archive`));
          return;
        }
        const chunks: Buffer[] = [];
        readStream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        readStream.on("error", fail);
        readStream.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
      });
    });
    zipfile.readEntry();
  });
}

export async function readZipEntry(zipBytes: Buffer, fileName: string): Promise<Buffer> {
  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(zipBytes, { lazyEntries: true, autoClose: false }, (error, archive) => {
      if (error || !archive) {
        reject(new PackageInspectionError("Resource package archive is not a readable ZIP", 400));
        return;
      }
      resolve(archive);
    });
  });
  return readEntry(zipfile, fileName);
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PackageInspectionError(`Resource package manifest field ${label} must be a non-empty string`);
  }
  return value;
}

function parseLayer(value: unknown, manifestId: string): ResourcePackageLayerRecord {
  if (typeof value !== "object" || value === null) {
    throw new PackageInspectionError(`Resource package ${manifestId} layer entries must be objects`);
  }
  const record = value as Record<string, unknown>;
  const layer: ResourcePackageLayerRecord = {
    layerId: parseString(record.layerId, "layers[].layerId"),
    surveyId: parseString(record.surveyId, "layers[].surveyId"),
    releaseId: parseString(record.releaseId, "layers[].releaseId"),
    modality: parseString(record.modality, "layers[].modality"),
    path: parseString(record.path, "layers[].path"),
    sizeBytes: record.sizeBytes as number,
    sha256: parseString(record.sha256, "layers[].sha256"),
  };
  if (!Number.isFinite(layer.sizeBytes) || layer.sizeBytes < 0) {
    throw new PackageInspectionError(`Resource package layer ${layer.layerId} has an invalid sizeBytes`);
  }
  if (typeof record.coverageRole === "string") layer.coverageRole = record.coverageRole;
  if (typeof record.dataOrigin === "string") layer.dataOrigin = record.dataOrigin;
  if (typeof record.sourceTier === "string") layer.sourceTier = record.sourceTier;
  return layer;
}

export async function readResourcePackageManifest(zipBytes: Buffer): Promise<ResourcePackageManifest> {
  const manifestBytes = await readZipEntry(zipBytes, PACKAGE_MANIFEST_ENTRY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new PackageInspectionError("Resource package manifest is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PackageInspectionError("Resource package manifest must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw new PackageInspectionError(
      `Resource package manifest schemaVersion must be ${PACKAGE_SCHEMA_VERSION} (got ${String(record.schemaVersion)})`,
    );
  }
  const id = parseString(record.id, "id");
  if (!Array.isArray(record.layers)) {
    throw new PackageInspectionError(`Resource package ${id} manifest layers must be an array`);
  }
  const layers = record.layers.map((layer) => parseLayer(layer, id));
  if (layers.length === 0) {
    throw new PackageInspectionError(`Resource package ${id} manifest must declare at least one layer`);
  }
  const files: ResourcePackageManifest["files"] = [];
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file !== "object" || file === null) {
        throw new PackageInspectionError(`Resource package ${id} file entries must be objects`);
      }
      const fileRecord = file as Record<string, unknown>;
      files.push({
        path: parseString(fileRecord.path, "files[].path"),
        sizeBytes: fileRecord.sizeBytes as number,
        sha256: parseString(fileRecord.sha256, "files[].sha256"),
      });
    }
  }
  return {
    schemaVersion: record.schemaVersion,
    id,
    version: parseString(record.version, "version"),
    surveyId: parseString(record.surveyId, "surveyId"),
    layers,
    files,
  };
}
