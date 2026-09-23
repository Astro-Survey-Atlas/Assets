export interface EuclidQ1MerDataLink {
  fileName: string;
  tileId: string;
  instrument: string;
  downloadUrl: string;
  downloadProvider: "ESA SAS-DD";
  unitKind: "tile";
}

const EUCLID_Q1_MER_FILE = /^EUC_MER_BGSUB-MOSAIC-(VIS|NIR(?:-[A-Z0-9]+)*)_TILE([0-9]+)(?:[-_][^/]+)?\.fits(?:\.gz)?$/i;

/**
 * Resolve only the stable Euclid Q1 MER filename family.  The object-store
 * locator remains the source of record; this URL is an independent official
 * ESA download entrypoint for the same named file.
 */
export function resolveEuclidQ1MerFile(
  fileName: unknown,
  identity: { surveyId?: unknown; releaseId?: unknown },
): EuclidQ1MerDataLink | undefined {
  if (String(identity.surveyId ?? "").toLowerCase() !== "euclid"
    || String(identity.releaseId ?? "").toLowerCase() !== "euclid-q1"
    || typeof fileName !== "string") return undefined;
  const normalized = fileName.trim().split(/[\\/]/).at(-1) ?? "";
  const match = EUCLID_Q1_MER_FILE.exec(normalized);
  if (!match) return undefined;
  const [, instrument, tileId] = match;
  const query = new URLSearchParams({
    TAPCLIENT: "ASTROQUERY",
    RELEASE: "q1",
    FILE_NAME: normalized,
    RETRIEVAL_TYPE: "FILE",
  });
  return {
    fileName: normalized,
    tileId: tileId!,
    instrument: instrument!.toUpperCase(),
    downloadUrl: `https://eas.esac.esa.int/sas-dd/data?${query.toString()}`,
    downloadProvider: "ESA SAS-DD",
    unitKind: "tile",
  };
}
