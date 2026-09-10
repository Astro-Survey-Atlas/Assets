/**
 * Shared derivation rules for Resource Package catalog access metadata.
 *
 * Static rebuild (Python) and dynamic publication (TypeScript) must agree:
 * `coverageAuthorities` derive from layer source tiers, `sources[].authority`
 * identifies the upstream data authority, and `accessModes` are truthful
 * access channels for consumers — never invented archive services.
 */

export const UNIVERSAL_ACCESS_MODE = "Resource Package v3";

export const ACCESS_MODE_BY_AUTHORITY: Readonly<Record<string, string>> = {
  "CDS MOC": "CDS HiPS",
  "CDS public HiPS/MOC": "CDS HiPS",
  "DECam Legacy Survey DR5": "Legacy Survey viewer",
  "ANU SkyMapper DR4": "SkyMapper data release",
  "ESO VISTA Phase 3": "ESO Phase 3 archive",
};

export const SOURCE_TIER_AUTHORITIES: Readonly<Record<string, string>> = {
  third_party_moc: "third-party-moc",
  official_geometry: "official-geometry",
  official_table: "official-tile-table",
};

export function sourceTierAuthority(sourceTier: string): string {
  return SOURCE_TIER_AUTHORITIES[sourceTier] ?? sourceTier;
}

export function sourceAuthorityForUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "cds.unistra.fr" || host.endsWith(".cds.unistra.fr") || host === "alasky.unistra.fr" || host.endsWith(".alasky.unistra.fr") || host === "cdsarc.unistra.fr" || host.endsWith(".cdsarc.unistra.fr")) {
      return "CDS MOC";
    }
  } catch {
    // Non-URL source references fall back to the Assets publication channel.
  }
  return "Assets MOC publication";
}

export function deriveAccessModes(sources: ReadonlyArray<{ authority?: string }>, curated?: readonly string[]): string[] {
  const modes = new Set<string>(curated ?? []);
  for (const source of sources) {
    const authority = (source.authority ?? "").trim();
    if (authority) modes.add(ACCESS_MODE_BY_AUTHORITY[authority] ?? authority);
  }
  modes.add(UNIVERSAL_ACCESS_MODE);
  return [...modes].filter((mode) => mode.length > 0).sort((left, right) => left.localeCompare(right));
}
