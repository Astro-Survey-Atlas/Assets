const surveyCodes: Record<string, string> = {
  "2mass": "2M",
  act: "ACT",
  akari: "AKR",
  allwise: "WISE",
  cfhtls: "CFHT",
  decals: "DCLS",
  decaps: "DCPS",
  des: "DES",
  desi: "DESI",
  euclid: "EUC",
  fds: "FDS",
  gaia: "GAIA",
  galex: "GLX",
  "hsc-ssp": "HSC",
  hst: "HST",
  iphas: "IPH",
  jwst: "JWST",
  kids: "KiDS",
  "legacy-surveys": "LEG",
  nvss: "NVSS",
  panstarrs: "PS1",
  roman: "ROM",
  rubin: "LSST",
  sdss: "SDSS",
  skymapper: "SKY",
  spherex: "SPX",
  sumss: "SUM",
  vista: "VST",
  vphas: "VPH",
  wenss: "WNS",
  ztf: "ZTF",
};

function canonicalSurveyId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return normalized === "nancy-grace-roman-space-telescope" ? "roman" : normalized;
}

export function surveyMarkCode(id: string): string {
  const normalized = canonicalSurveyId(id);
  return surveyCodes[normalized] ?? (normalized.replace(/[^a-z0-9]/g, "").slice(0, 4).toUpperCase() || "ASA");
}

export function surveyMarkMarkup(id: string): string {
  const code = surveyMarkCode(id);
  return `<svg class="survey-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect class="survey-mark-frame" x="1" y="1" width="46" height="46" rx="8" />
    <path class="survey-mark-grid" d="M10 10h28v22H10z M19.3 10v22 M28.6 10v22 M10 21h28" />
    <path class="survey-mark-track" d="M11 29c5.2-1.1 7.8-10.2 14.5-14.1 3.5-2 7-1.5 10.5.8" />
    <circle class="survey-mark-node" cx="11" cy="29" r="1.7" />
    <circle class="survey-mark-focus" cx="36" cy="15.8" r="2.7" />
    <text class="survey-mark-code" x="24" y="41">${code}</text>
  </svg>`;
}
