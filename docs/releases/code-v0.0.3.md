# Astro Survey Atlas Assets 0.0.3

Released on 2026-11-03.

## Sky Atlas

- Display each survey at its real available HEALPix orders, with viewport-based
  loading and an order 4 overview. Order changes replace complete batches and
  preserve the previous view if a request fails.
- Keep survey context visible during overlap inspection. Explicit focus uses
  the selected overlap region; background loading preserves the camera.
- Load optional aggregated depth points automatically inside a selected
  HEALPix cell. Point area represents object count. A transparent DEPTH panel
  below the cell inspector explains the axis, source and selected range.
- Filter by observed redshift or estimated distance. Points outside the range
  retain their color at 50% opacity; two frames mark the range boundaries.
- Preserve a single globe, camera and canvas, with responsive inspector layout
  and coordinated clearing, selection and focus controls.

## Public pages and deployment

- Improve the homepage Warehouse layout, Releases page and publication diagram.
- Present API availability, release and native-index status in a structured
  layout. Remove the manual refresh button and introductory feature cards;
  status loads when the page opens.
- Add optional depth configuration to the Helm chart and retain independent
  site/backend image selection.
- Align package, chart and health versions at 0.0.3. Use the published
  `code-v0.0.3` container tag by default and publish the Helm chart at its
  documented OCI reference.

## Depth data and physical interpretation

The connected DESI DR1 example is a fixed, bounded catalog row window, not a
complete sky region or a random sample. Its counts must not be extrapolated to
full-survey density or completeness. Other surveys need suitable measurements
and an explicitly configured source before they can display depth.

Observed redshift and distance eligibility are evaluated separately. The
distance axis is a Planck18 line-of-sight comoving distance estimate for
applicable extragalactic redshifts. It has no peculiar-velocity or CMB-frame
correction, and its uncertainty covers the measurement term only. One Mpc is
approximately 3.26 million light-years. Radial display scaling is independent
of the angular footprint, so the display is not a volume at a uniform scale.

This version provides optional depth queries and aggregation, not a full
physical-quantity index or a cross-survey object-matching catalog. Raw source
rows remain in evidence storage. Configuration and reproducible example details
are documented in [the depth guide](../sky-depth-demo.md).

Public coverage and Resource Package archives keep their independent data
release versions. Application images contain code and deployment artifacts.
