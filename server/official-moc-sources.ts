/** Exact acquisition endpoints: admin callers select an ID, never supply URLs. */
export const SPHEREX_DR1_CUBE = "spherex-dr1-allsky-cube-moc";
export interface OfficialMocSource {
  surveyId: string; releaseId: string; releaseLabel: string; releaseKind: string; releasedYear: number;
  modality: string; mocUrl: string; recordUrl: string; identity: string; geometrySourceLabel: string;
  recordMarkers?: readonly string[]; creatorDid?: string; legacyPixelMoc?: boolean; fullSky?: boolean;
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
};
