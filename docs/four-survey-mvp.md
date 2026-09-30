# Four-survey MVP

## Scope

Euclid, DESI, Legacy Surveys and HST share one region inspection and manifest
flow. Desktop is the acceptance target. Ordinary cell inspection lists releases
and modalities only. Overlap unions selected products within a survey and
intersects survey unions, including all eleven combinations of two or more
surveys. A component click queries all of its cells within 4,096 cells / 100
square degrees; larger regions require a smaller selection.

| Owner | Persistent data | Region response |
| --- | --- | --- |
| Assets | Public coverage, native indexes, evidence, caches and snapshots | Native Tile/brick/target/observation identities, all source URIs, modality, footprint, order and precision |
| Workspace | Public geometry/metadata packages; private CSST scans, coverage and file mappings | Temporary Assets result plus deduplicated CSST immediate parent directories |

Workspace calls Assets server-side with an API Key and only public selectors.
Private identities and paths never cross into Assets. Public reverse responses
are not persisted in Workspace. Geometry remains usable without a Key; public
native lookup has no anonymous/crawler fallback. Browser JSON/CSV export is
a source manifest, never a scientific data download.

## One Real Region: Abell 2390

The existing four-survey public overlap includes order-8 NESTED cells
`202250` and `202272` near Abell 2390. Use the published geometry; do not modify
MOCs or publish a new release to create this example.

- Euclid ERO: `target` identity `ERO-Abell2390`, read from official ESA ERO
  XML and associated with ESA Sky outreach `stc_s`. Official VIS/NISP Stack
  and Catalog package URLs are retained. The outreach extent is estimated;
  it is not a verified instrument/filter footprint or Tile roster.
- DESI: DR1/EDR Tile candidates from locked completeness tables. Circular
  focal-plane geometry is estimated, not target-level spectral coverage.
- Legacy DR10: example candidate bricks `3281p177`, `3281p180`, `3282p175`,
  `3283p180`, `3284p175`; retain the official South Coadd directory/Tractor
  URI rule and unverified file-availability status.
- HST: public MAST observation metadata matched by `s_region` and the selected
  instrument/filter layer. The four-layer lookup returned 46 ACS observations,
  including `24064614`, `24077432` and `24077435`.
  This is not a complete HST inventory.

The official ERO target extent used for this association is:

```text
POLYGON ICRS 328.889286 17.5327373 328.5711216 18.1453116
327.9278751 17.8408843 328.2476865 17.2293456
```

No referenced scientific contents, headers, ranges or previews are fetched.
Only official metadata inventories and existing public geometry are read.

## Dev Verification

Assets revision 294 is available at `http://10.15.51.75:32083/atlas/`.
Workspace revision 53 is available at
`http://astro.workspace.dev.72602.space:32080/`.
These rollouts changed application code. The 603-file public bundle retains
SHA-256 `0e23aca242d542d3b7ae8d96a846d2eed1ef1eabcb4f573fadeaa493c3905d6e`.
The existing Legacy SQLite index was reused.

The minimal four-layer Abell 2390 request returned 59 native units / 79 manifest
items: one ERO target, one DESI DR1 Tile, eleven Legacy DR10 bricks and 46 HST
ACS observations. Four pages with `pageSize=25` exhausted one snapshot without
duplicate units or truncation. Missing/invalid Keys returned 401 and changing
the snapshot's region returned 409.

Selecting all products returned 78 native units at revisions 293/52.
Workspace read five pages with `pageSize=25`. At revisions 294/53 the desktop
C04 lookup returned 79 units: five ERO target/product identities, one
DESI Tile, eleven Legacy bricks and 62 HST observation/layer identities. HST
metadata is queried at runtime, so this is a measured result rather than a
frozen inventory count. Desktop browser checks confirmed the C04 JSON/CSV
export matches the displayed public list. Assets also passed
ordinary-click/no-lookup, anonymous export and API-Key unlock checks. Private
CSST verification is recorded in Workspace; private cells, paths and scan
identities must not be copied into this repository.

Workspace geometry packages are DESI 3.5.0, Euclid 3.17.0, HST 3.4.0 and
Legacy Surveys 3.1.0, all active. Existing other package selections were
preserved. Composite public source IDs have their own bounded input length;
only explicitly selected Workspace sources are read during reverse lookup.

An empty native match now retains the source index notes and an explicit
official-entrypoint note. Workspace shows surveys without returned native units
after pagination and retains clickable official entrypoints and their notes.
Archive failures remain incomplete in display and export even after all stored
pages are read. Current native Legacy DR10 lookup is limited to the locked South
release membership; its published MOC alone cannot establish a matching brick
outside that membership. Do not claim four native-survey hits for every overlap.

## Acceptance

1. Ordinary four-survey cell inspection displays release/modality metadata
   without a native lookup or live MAST request.
2. Overlap component inspection returns source-supported units from all four
   surveys, preserving multiple URIs and source policies.
3. Anonymous Assets export retains the current six-item preview and omission
   status. With a valid Key, export exhausts one immutable snapshot and the
   resulting displayed list equals the exported list. Expiry, revision, scope
   and access identity are enforced; query exhaustion is not inventory completeness.
4. Workspace uses the four geometry packages and intersects local CSST. Public
   lookup comes only from Assets; private lookup returns matched file parents.
   No-Key/invalid-Key cases preserve geometry/private results and report public
   unavailability.
5. Existing releases, scans, selections, histories and worktree edits are
   preserved. Both Dev rollouts change application code only.

## Inventory Limits

Q1 covers the locked 2,908 BGSUB rows / 352 Tiles only. ERO has no verified Tile
roster. The user-provided DESI OSS copy contains 904 scanned redrock files;
about 904 spectra archives and 12,855 coadds remain unscanned and do not represent
complete BGS/DR1. Legacy DR5-DR9 URI rules and every brick file are not fully
verified. Workspace's current Legacy package is DR10 only. HSC's existing
tract/patch adapter is outside this MVP and does not establish DAS file existence.
The existing DR10 color-imaging layer still carries the published `catalog`
modality. Correcting that metadata needs a separate reviewed publication.
Do not increase memory limits solely because the prior Legacy index cold build
approached 4 GiB; assess streaming or incremental builds before expanding inputs.
