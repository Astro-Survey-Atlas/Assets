import type { DownloadPlanSpatialUnit, SourceAccessAlternative, SourceAccessStatus, SourceAccessType, SourceAccessUri } from "./evidence-store.js";

type AccessContext = { surveyId: string; releaseId: string; fileName?: string; band?: string; accessType?: SourceAccessType };

const CHECKED = {
  gaiaHead: "2026-10-04T03:38:53Z",
  irsaEro: "2026-10-04T03:39:03Z",
  irsaQ1: "2026-10-03",
  mastHead: "2026-10-04T03:41:42Z",
  galexHead: "2026-10-04T03:41:41Z",
  sdssHead: "2026-10-04T03:38:52Z",
  casdc: "2026-10-07T12:22:24Z",
  skymapperCutout: "2026-10-04T16:58:37Z",
  twomassAtlasHead: "2026-10-05",
} as const;

function alternative(uri: string, details: Omit<SourceAccessAlternative, "uri">): SourceAccessAlternative {
  return { uri, ...details };
}

function locationFor(uri: string, context: AccessContext, status: SourceAccessStatus, relationship: SourceAccessAlternative["relationship"] = "primary"): SourceAccessAlternative {
  const url = new URL(uri);
  const accessType = context.accessType ?? "file";
  if (url.hostname === "cdn.gea.esac.esa.int") return alternative(uri, {
    accessType, provider: "ESA Gaia archive CDN", providerCountryCode: "ES", providerLocation: "ESA/ESAC, Madrid, Spain",
    servingRegion: "CDN77 POP Chicago, IL, US observed; edge can vary by requester", relationship, status,
    ...(status === "source-listed" ? { note: "The exact file identity is present in the locked official Gaia DR3 file roster; science bytes were not downloaded." } : {}),
  });
  if (url.hostname === "gaia.eu-1.cdn77-storage.com") return alternative(uri, {
    accessType, provider: "CDN77 Gaia storage endpoint", servingRegion: "Unknown; the eu-1 hostname label was not treated as a verified node location", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.gaiaHead, httpStatus: 200, note: "Path-preserving alternate host returned HTTP 200 for the checked GaiaSource_048543-048681.csv.gz sample; response size and Last-Modified matched the ESA CDN alias." } : {}),
  });
  if (url.hostname === "nasa-irsa-euclid-q1.s3.us-east-1.amazonaws.com") return alternative(uri, {
    accessType, provider: "NASA/IPAC IRSA Euclid Q1 mirror", providerCountryCode: "US", providerLocation: "NASA/IPAC Infrared Science Archive",
    servingRegion: "AWS us-east-1", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.irsaQ1, note: "The mirror uses a Tile/product directory entry. Its page lists separate files; this is not asserted to be a per-file URL." } : {}),
  });
  if (url.hostname === "irsa.ipac.caltech.edu" && url.pathname.startsWith("/ibe/data/twomass/sixxcat/sixxcat/")) return alternative(uri, {
    accessType, provider: "NASA/IPAC 2MASS Infrared Science Archive", providerCountryCode: "US", providerLocation: "IPAC, Pasadena, California, US",
    servingRegion: "IRSA public archive; exact serving node not independently located", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.twomassAtlasHead, note: "The whole-Atlas-image path follows the official IBE date/hemisphere/scan/file rule; representative files were checked, but this individual URI was not." } : {}),
  });
  if (url.hostname === "irsa.ipac.caltech.edu") return alternative(uri, {
    accessType, provider: "NASA/IPAC IRSA Euclid ERO mirror", providerCountryCode: "US", providerLocation: "IPAC, Pasadena, California, US",
    servingRegion: "IRSA public archive; exact serving node not independently located", relationship, status,
    ...(status === "verified" ? { checkedAt: CHECKED.irsaEro, httpStatus: 200, note: "The target directory lists separate FITS files; the representative IC10 VIS FITS file also returned HTTP 200 to HEAD." } : {}),
  });
  if (url.hostname === "eas.esac.esa.int" || url.hostname.endsWith(".esac.esa.int")) return alternative(uri, {
    accessType, provider: "ESA Euclid Science Archive", providerCountryCode: "ES", providerLocation: "ESAC, Madrid, Spain",
    servingRegion: "Provider location; delivery edge not independently located", relationship, status,
    ...(status === "source-listed" ? { note: "This product locator is returned by the locked ESA Q1 archive metadata." } : {}),
  });
  if (url.hostname === "mast.stsci.edu") return alternative(uri, {
    accessType, provider: "MAST / Space Telescope Science Institute", providerCountryCode: "US", providerLocation: "STScI, Baltimore, Maryland, US",
    servingRegion: "MAST public product delivery; storage node not independently located", relationship, status,
    ...(url.pathname === "/api/v0.1/Download/file" ? { checkedAt: CHECKED.mastHead, httpStatus: 200, note: "A source-reported JWST MAST product URI was converted with the documented public Download/file endpoint; the checked product returned HTTP 200 to HEAD." } : {}),
  });
  if (url.hostname === "galex.stsci.edu") return alternative(uri, {
    accessType, provider: "MAST GALEX public archive", providerCountryCode: "US", providerLocation: "Space Telescope Science Institute, Baltimore, Maryland, US",
    servingRegion: "GALEX public archive; serving node not independently located", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.galexHead, httpStatus: 200, note: "The source-reported path was changed from HTTP to HTTPS; the representative file returned HTTP 200 to HEAD." } : {}),
  });
  if (url.hostname === "data.sdss.org") return alternative(uri, {
    accessType, provider: "SDSS Science Archive Server", providerCountryCode: "US", providerLocation: "SDSS public archive",
    servingRegion: "United States provider; serving node not independently located", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.sdssHead, httpStatus: 200, note: "The official DR9 frame filename rule was checked with a representative field; this individual URI may not have been tested." } : {}),
  });
  if (url.hostname === "api.skymapper.nci.org.au") return alternative(uri, {
    accessType, provider: "SkyMapper public image service (NCI Australia)", providerCountryCode: "AU", providerLocation: "National Computational Infrastructure, Australia",
    servingRegion: "Australian provider; delivery edge not independently located", relationship, status,
    ...(status === "rule-derived" ? { checkedAt: CHECKED.skymapperCutout, httpStatus: 200, note: "The documented SIAP rule returned HTTP 200 to HEAD for a representative 5-arcmin FITS cutout; this CCD's individual cutout was not checked." } : {}),
  });
  if (url.hostname === "data.desi.lbl.gov") return alternative(uri, {
    accessType, provider: "DESI public data archive", providerCountryCode: "US", providerLocation: "Lawrence Berkeley National Laboratory, California, US",
    servingRegion: "United States provider; serving node not independently located", relationship, status,
  });
  if (url.hostname === "portal.nersc.gov") return alternative(uri, {
    accessType, provider: "Legacy Surveys public data archive", providerCountryCode: "US", providerLocation: "NERSC, Berkeley, California, US",
    servingRegion: "United States provider; serving node not independently located", relationship, status,
  });
  if (url.hostname === "hsc-release.mtk.nao.ac.jp") return alternative(uri, {
    accessType, provider: "HSC SSP data access", providerCountryCode: "JP", providerLocation: "National Astronomical Observatory of Japan",
    servingRegion: "Provider location; archive node not independently located", relationship, status,
  });
  if (url.hostname === "dataportal.eso.org") return alternative(uri, {
    accessType, provider: "ESO Data Portal", providerCountryCode: "ES", providerLocation: "ESO / ESAC archive service",
    servingRegion: "Provider location; delivery edge not independently located", relationship, status,
    ...(status === "source-listed" ? { note: "This single-file URL is the ESO DataLink #this record; file availability was not verified by Assets." } : {}),
  });
  if (url.hostname === "archive.eso.org") return alternative(uri, {
    accessType, provider: "ESO Archive DataLink", providerCountryCode: "ES", providerLocation: "ESO / ESAC archive service",
    servingRegion: "Provider location; delivery edge not independently located", relationship, status,
  });
  if (url.hostname === "ds.astro.rug.astro-wise.org" && url.port === "8000") return alternative(uri, {
    accessType, provider: "KiDS DR5 source list · Astro-WISE / University of Groningen", providerCountryCode: "NL",
    providerLocation: "University of Groningen, the Netherlands", servingRegion: "Provider location; delivery node not independently located", relationship, status,
    ...(status === "source-listed" ? { note: "This exact single-file URI appears in the official KiDS DR5 wget list and was joined by filename. Astro-WISE may serve a FITS representation with different headers from ESO; it is not claimed to be a byte-identical mirror." } : {}),
  });
  return alternative(uri, { accessType, provider: "Survey source", relationship, status });
}

export interface DirectSurveyFile {
  uri: string;
  fileName: string;
  alternative: SourceAccessAlternative;
}

/** Resolve only archive-reported, file-shaped MAST dataURL identities. */
export function mastScienceFile(dataUrl: unknown, surveyId: string): DirectSurveyFile | undefined {
  if (typeof dataUrl !== "string" || !dataUrl.trim()) return undefined;
  const value = dataUrl.trim();
  let uri: string;
  if (/^mast:/i.test(value)) {
    const match = /^mast:(JWST|GALEX|HST)\/product\/([A-Za-z0-9._/-]+)$/i.exec(value);
    if (!match || match[2]!.split("/").some(part => !part || part === "." || part === "..")
      || !/\.(?:fits(?:\.(?:gz|bz2|fz))?|asdf)$/i.test(match[2]!)) return undefined;
    const request = new URL("https://mast.stsci.edu/api/v0.1/Download/file");
    request.searchParams.set("uri", value);
    uri = request.toString();
  } else {
    let url: URL;
    try { url = new URL(value); } catch { return undefined; }
    if (url.username || url.password || url.search || url.hash || !/\.(?:fits(?:\.(?:gz|bz2|fz))?|asdf)$/i.test(url.pathname)) return undefined;
    if (url.protocol === "http:" && surveyId === "galex" && url.hostname === "galex.stsci.edu") url.protocol = "https:";
    if (url.protocol !== "https:" || surveyId === "galex" && url.hostname !== "galex.stsci.edu") return undefined;
    uri = url.toString();
  }
  const fileName = new URL(uri).searchParams.get("uri")?.split("/").at(-1) ?? new URL(uri).pathname.split("/").at(-1) ?? "";
  if (!fileName) return undefined;
  const status: SourceAccessStatus = "rule-derived";
  return { uri, fileName, alternative: locationFor(uri, { surveyId, releaseId: "", fileName }, status) };
}

export function alternativesForAccessUri(uri: string, context: AccessContext): SourceAccessAlternative[] {
  const status: SourceAccessStatus = context.surveyId === "euclid" && context.releaseId === "euclid-q1" ? "source-listed"
    : context.surveyId === "gaia" ? "source-listed"
      : context.surveyId === "kids" && context.releaseId === "kids-dr5" ? "source-listed"
      : context.surveyId === "sdss" ? "rule-derived"
        : context.surveyId === "galex" || context.surveyId === "jwst" || context.surveyId === "skymapper" || context.surveyId === "2mass" ? "rule-derived" : "source-listed";
  const items = [locationFor(uri, context, status)];
  if (context.surveyId === "gaia" && context.releaseId === "gaia-dr3") {
    const source = new URL(uri);
    if (source.hostname === "cdn.gea.esac.esa.int" && /^\/Gaia\/gdr3\/gaia_source\/[^/]+\.csv\.gz$/i.test(source.pathname)) {
      const mirror = new URL(uri); mirror.hostname = "gaia.eu-1.cdn77-storage.com";
      items.push(locationFor(mirror.toString(), context, "rule-derived", "mirror"));
    }
  }
  const q1Band = context.band?.toUpperCase()
    ?? (/MOSAIC-VIS/i.test(context.fileName ?? "") ? "VIS" : /MOSAIC-NISP[-_.]?([YJH])/i.exec(context.fileName ?? "")?.[1]?.toUpperCase());
  if (context.surveyId === "euclid" && context.releaseId === "euclid-q1" && q1Band === "VIS") {
    const tileId = context.fileName?.match(/TILE(\d+)/i)?.[1];
    if (tileId) {
      const mirror = `https://nasa-irsa-euclid-q1.s3.us-east-1.amazonaws.com/index.html#q1/MER/${tileId}/VIS/`;
      const checked = tileId === "102018211";
      items.push(locationFor(mirror, { ...context, accessType: "directory" }, checked ? "verified" : "rule-derived", "directory-entrypoint"));
      if (checked) Object.assign(items.at(-1)!, { checkedAt: "2026-10-03", httpStatus: 200, note: "The Q1 MER Tile 102018211 VIS directory was inspected and contains separate files; one sample file returned HTTP 200 to HEAD." });
    }
  }
  return items;
}

export function metadataEntrypoint(uri: string, surveyId: string, releaseId: string): SourceAccessAlternative {
  return locationFor(uri, { surveyId, releaseId, accessType: "entrypoint" }, "entrypoint-only", "metadata-entrypoint");
}

export function verifiedDirectoryAlternative(uri: string, provider: string, providerCountryCode: string,
  providerLocation: string, checkedAt: string, note: string): SourceAccessAlternative {
  return alternative(uri, { accessType: "directory", provider, providerCountryCode, providerLocation,
    servingRegion: "Public directory; exact serving node not independently located", relationship: "primary",
    status: "verified", checkedAt, httpStatus: 200, note });
}

export function casdcProviderStatuses(surveyId: string, releaseId: string): SourceAccessAlternative[] {
  const dataset = surveyId === "gaia" && releaseId === "gaia-dr3" ? "Gaia"
    : surveyId === "galex" && releaseId.startsWith("galex-") ? "GALEX"
      : surveyId === "euclid" && releaseId === "euclid-q1" ? "Euclid-Q1" : undefined;
  if (!dataset) return [];
  const root = "https://casdc.china-vo.org/mirror/";
  const common = { provider: "CASDC mirror catalog · NAOC/CASDC", providerCountryCode: "CN", providerLocation: "National Astronomical Observatories of China / CASDC", servingRegion: "Download node location unknown" };
  return [
    alternative(root, { ...common, accessType: "entrypoint", relationship: "regional-repository", status: "entrypoint-only", checkedAt: CHECKED.casdc, httpStatus: 200,
      note: "The mirror index is reachable and lists this survey; the target directory is checked separately below." }),
    alternative(new URL(`${dataset}/`, root).toString(), { ...common, accessType: "directory", relationship: "regional-repository", status: "verified", checkedAt: CHECKED.casdc, httpStatus: 200,
      note: "The target directory returned HTTP 200 and exposed a directory listing. Individual file URLs and scientific bytes were not checked." }),
  ];
}

export function withSurveyProviderStatuses(unit: DownloadPlanSpatialUnit): DownloadPlanSpatialUnit {
  const statuses = casdcProviderStatuses(unit.surveyId, unit.releaseId);
  if (!statuses.length) return unit;
  const sourceMetadata = unit.sourceMetadata ?? {};
  const old = Array.isArray(sourceMetadata.providerStatuses) ? sourceMetadata.providerStatuses as SourceAccessAlternative[] : [];
  const providerStatuses = new Map([...old, ...statuses].map(item => [`${item.provider}:${item.uri}`, item]));
  return { ...unit, sourceMetadata: { ...sourceMetadata, providerStatuses: [...providerStatuses.values()] } };
}

export function mergeSourceAccessUris(...lists: Array<SourceAccessUri[] | undefined>): SourceAccessUri[] {
  const entries = new Map<string, SourceAccessUri>();
  for (const entry of lists.flatMap(list => list ?? [])) {
    const key = `${entry.fileName ?? entry.uri}:${entry.band ?? ""}:${entry.accessType ?? ""}`;
    const old = entries.get(key);
    if (!old) { entries.set(key, entry); continue; }
    const alternatives = new Map([...(old.alternatives ?? []), ...(entry.alternatives ?? [])].map(item => [`${item.provider}:${item.uri}`, item]));
    entries.set(key, { ...old, ...entry, uri: old.uri,
      ...(alternatives.size ? { alternatives: [...alternatives.values()] } : {}) });
  }
  return [...entries.values()];
}

export function mergeSourceMetadata(
  previous: DownloadPlanSpatialUnit["sourceMetadata"], next: DownloadPlanSpatialUnit["sourceMetadata"],
): DownloadPlanSpatialUnit["sourceMetadata"] {
  if (!previous && !next) return undefined;
  const merged: Record<string, unknown> = { ...previous, ...next };
  for (const key of ["entrypoints", "providerStatuses", "records", "archivePackageUris"] as const) {
    const items = [...(Array.isArray(previous?.[key]) ? previous[key] as unknown[] : []), ...(Array.isArray(next?.[key]) ? next[key] as unknown[] : [])];
    if (items.length) merged[key] = [...new Map(items.map(item => [typeof item === "string" ? item : JSON.stringify(item), item])).values()];
  }
  return merged as DownloadPlanSpatialUnit["sourceMetadata"];
}

export function accessTypeLabel(type: SourceAccessType): string {
  return type === "file" ? "file" : type === "directory" ? "directory" : "source entrypoint";
}
