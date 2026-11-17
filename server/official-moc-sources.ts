/** Exact acquisition endpoints: admin callers select an ID, never supply URLs. */
export const SPHEREX_DR1_CUBE = "spherex-dr1-allsky-cube-moc";
export interface OfficialMocSource {
  surveyId: string; releaseId: string; releaseLabel: string; releaseKind: string; releasedYear: number;
  modality: string; mocUrl: string; recordUrl: string; identity: string; geometrySourceLabel: string;
  recordMarkers?: readonly string[]; creatorDid?: string; legacyPixelMoc?: boolean; fullSky?: boolean;
  /** Pinned copy of the record (gzip, repo-relative). IRSA moved this 5 MB file to another host that the production node cannot download in time, so it is read locally and still verified against the lock's sha256. */
  recordFile?: string;
  /** Pinned copy of the MOC itself (gzip, repo-relative), for sources the production node cannot download reliably. Verified against the lock's size and sha256 exactly like a download. */
  mocFile?: string;
}
const irsa = "https://irsa.ipac.caltech.edu";
const euclidRecord = `${irsa}/applications/euclid/firefly-6d0a2922a94699f98f89.js`;
function euclid(field: "wide" | "deep"): OfficialMocSource {
  const label = field === "wide" ? "Wide" : "Deep";
  const filename = `euclid_dr1_${field}.moc.moc.fits`;
  return {
    surveyId: "euclid", releaseId: "euclid-dr1-foundation", releaseLabel: "DR1-Foundation",
    releaseKind: "public_release", releasedYear: 2026, modality: "imaging",
    mocUrl: `${irsa}/data/MOC/${filename}`, recordUrl: euclidRecord,
    identity: `IRSA/Euclid/DR1-Foundation/${label}-Tiles`, geometrySourceLabel: `Official IRSA DR1 ${label} Tiles MOC`,
    recordMarkers: [filename, `Euclid DR1 ${label} Tiles Coverage`], legacyPixelMoc: true,
    recordFile: "src/layers/records/irsa-euclid-firefly-f688792ffd62.js.gz",
    ...(field === "wide" ? { mocFile: "src/layers/records/irsa-euclid-dr1-wide-moc-bb89812addb7.fits.gz" } : {}),
  };
}
export const OFFICIAL_MOC_SOURCES: Readonly<Record<string, OfficialMocSource>> = {
  [SPHEREX_DR1_CUBE]: {
    surveyId: "spherex", releaseId: "spherex-dr1", releaseLabel: "SPHEREx DR1",
    releaseKind: "public_release", releasedYear: 2026, modality: "infrared",
    mocUrl: `${irsa}/data/hips/SPHEREx/spherex_allsky_cube/Moc.fits`,
    recordUrl: `${irsa}/data/hips/SPHEREx/spherex_allsky_cube/properties`,
    identity: "ivo://IPAC/P/SPHEREx/DR1/cube", creatorDid: "ivo://IPAC/P/SPHEREx/DR1/cube",
    geometrySourceLabel: "Official IRSA DR1 Cube HiPS MOC", fullSky: true,
  },
  "euclid-dr1-foundation-wide-tiles-moc": euclid("wide"),
  "euclid-dr1-foundation-deep-tiles-moc": euclid("deep"),
  // Euclid Quick Release 2 (Q2): the IRSA EGBS overview page is the pinned record because
  // IRSA serves no per-MOC landing page; its dataset DOI ties the record to this release.
  "euclid-q2-galactic-bulge-moc": {
    surveyId: "euclid", releaseId: "euclid-q2", releaseLabel: "Q2",
    releaseKind: "quick_release", releasedYear: 2026, modality: "imaging",
    mocUrl: `${irsa}/data/MOC/euclid_q2.moc.fits`,
    recordUrl: `${irsa}/data/Euclid/docs/overview_q2.html`,
    identity: "IRSA/Euclid/Q2/Galactic-Bulge", geometrySourceLabel: "Official IRSA Euclid Q2 EGBS MOC",
    recordMarkers: ["Euclid Galactic Bulge Survey", "10.26131/IRSA661"], legacyPixelMoc: true,
    recordFile: "src/layers/records/irsa-euclid-q2-overview-4aa7ad90fb0f.html.gz",
    mocFile: "src/layers/records/irsa-euclid-q2-moc-cda131a7b1e7.fits.gz",
  },
};
