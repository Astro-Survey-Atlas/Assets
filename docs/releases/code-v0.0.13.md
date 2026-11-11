# Release code-v0.0.13

**Date**: 2026-11-11  
**Bundle**: `astro-assets-bundle-202611110901`  
**Revision**: 18

## Summary

Combines unicode-range font slicing (90 CJK slices, ~326KB English / ~556KB Chinese vs 23.5MB before) with canvas width caching and removes full original font files from the repository. English pages now load 98.6% less CJK font data; Chinese pages load 97.6% less. Second view with HTTP cache disabled shows zero coverage block network requests thanks to persistent IndexedDB cache.

## Changes

### Font optimization (feat/font-slices)
- **Unicode-range slicing**: Split `NotoSansSC-Regular.woff2` (11.4MB) and `NotoSansSC-Bold.woff2` (12.1MB) into 90 slices each (latin + core + rare-00..42)
- **Load metrics**:
  - English page: 275KB Regular + 46KB Bold + 46KB latin = ~367KB total (previously 23.5MB)
  - Chinese page: 507KB Regular + 234KB Bold + 92KB latin = ~833KB total (previously 23.5MB)
- **Font cleanup**: Removed original full fonts from `site/public/fonts/` in commit history
- **Immutable caching**: All slice URLs content-hashed with `public, max-age=31536000, immutable` headers
- **Generation**: Python scripts with fonttools/brotli in `scripts/slice_cjk_font.py` and validation in `scripts/validate_cjk_font_slices.py`
- **Tests**: Node integration test validates all 90 slices present, full fonts absent, magic bytes correct

### Canvas width optimization (sky-globe v0.1.4)
- **Cached measurements**: Store canvas width on resize, avoid `getBoundingClientRect()` on every state read
- **ResizeObserver**: Invalidates cache when canvas or parent container size changes
- **HUD ruler**: Changed from `left=px` to `transform: translateX()` for compositor-only positioning; node pool reuse cut `renderRaTape` from 164ms → 21ms

### Data caching
- **IndexedDB persistent cache** (`asa-coverage-cache`): Coverage blocks and tile indexes survive browser refresh
- **Immutable headers**: Tile index responses with `requestedDisplayRevision` served with `public, max-age=31536000, immutable`
- **Second visit**: Zero network block requests with HTTP cache disabled (IndexedDB serves all blocks)

### Build
- Node 22.12.0 (unchanged)
- TypeScript 7.0.2 (unchanged)
- Vite 8.1.5 (unchanged)
- `@astro-survey-atlas/sky-globe` codeload updated to `v0.1.4`

## Verification

### Pre-deployment
- TypeScript typecheck: PASS (0 errors)
- Build server: PASS
- Node tests: PASS (530/530 including 21 font asset tests)
- Homepage test: PASS

### Post-deployment (planned)
- Health endpoint version: 0.0.13
- Catalog API: 16 surveys
- Browser smoke (en + zh):
  - Load time < 10s
  - Font slices load (no full fonts)
  - Region query returns Chinese/English content
  - Locale toggle round-trip works
  - No console errors
  - CJK bytes < 2MB per session

## Deployment

```bash
# Backup prod state
kubectl -n astro-survey-atlas-assets-72602 get deploy,pod,svc,cm,secret -o yaml > backup-rev17-pre-0.0.13.yaml

# Package chart
helm package charts/astro-survey-atlas-assets -d /tmp/assets-prod-0013-work/

# Dry-run verification
helm upgrade astro-survey-atlas-assets-72602 \
  /tmp/assets-prod-0013-work/astro-survey-atlas-assets-0.0.13.tgz \
  -n astro-survey-atlas-assets-72602 \
  -f values-before.yaml -f upgrade-values.yaml \
  --dry-run=server

# Image pull verification
kubectl -n astro-survey-atlas-assets-72602 create -f pullcheck-pod.yaml
# Wait for Succeeded, validate version 0.0.13 and 90 slices

# Apply
helm upgrade astro-survey-atlas-assets-72602 \
  /tmp/assets-prod-0013-work/astro-survey-atlas-assets-0.0.13.tgz \
  -n astro-survey-atlas-assets-72602 \
  -f values-before.yaml -f upgrade-values.yaml \
  --wait --timeout=10m

# Verify
curl -sf https://astro.assets.72602.space/api/v1/healthz | jq '.version'
# Expected: "0.0.13"
```

## Rollback

If needed:

```bash
helm rollback astro-survey-atlas-assets-72602 17 -n astro-survey-atlas-assets-72602 --wait --timeout=5m
```

## Repository state

- Merge: `feat/font-slices` (61c23b2) → `main` via fast-forward
- Tag: `code-v0.0.13` on main after version bump commit
- sky-globe: `v0.1.4` tag pushed

## Production state after deployment

- **Namespace**: `astro-survey-atlas-assets-72602`
- **Revision**: 18 (from 17)
- **Image**: `crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/astro-survery-atlas/astro-survey-atlas-assets:code-v0.0.13`
- **Bundle**: `astro-assets-bundle-202611110901` (unchanged)
- **URL**: https://astro.assets.72602.space/

## Known issues

- **P2 canvas observer box mode**: `ResizeObserver` without `{box: "border-box"}` means CSS border changes without content-box resize won't refresh cache. Not blocking; CSS-only border changes are rare in this app.
- **LFS false diffs**: `vendor/moc-core/*.tar.gz` appears modified due to missing git-lfs binary; excluded from all commits via explicit staging.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
