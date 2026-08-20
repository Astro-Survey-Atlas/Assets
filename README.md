# Astro Survey Atlas Assets

Independent public download service for verified Astro Survey Atlas coverage
artifacts. This repository owns its data snapshot, website, container image and
Helm chart. It has no runtime dependency on `astro-data-workspace` and does not
share that project's image, chart or PVC.

## Published release

The authoritative inputs are:

- `src/footprints/survey-footprints.json`
- `artifacts/public-survey-footprints/provenance.json`

The release includes native FITS MOCs and source records, the Euclid Q1 DS9
geometry archive, official DESI EDR/DR1 observed-tile FITS tables, current resource-package ZIP files, the product status
ledger, calculation notes, normalized manifests and SHA-256 provenance.
Only files referenced by `release-manifest.json` are exposed by the anonymous
download API. Historical package archives that are not in the current catalog
remain unavailable through HTTP.

## Local development

```bash
npm ci
npm run build
npm test
npm start
```

The site listens on `http://127.0.0.1:4180` by default. For split development,
run `npm run dev` and `npm run dev:site`; Vite proxies API requests to port
`4180`.

The maintained public API contract is in
[`docs/api-reference.md`](docs/api-reference.md). Update it together with the
route implementation and HTTP tests whenever an API changes. It covers the
catalog, survey and coverage indexes, downloads, online previews, byte ranges,
checksums and security boundaries.

## Release validation

`npm run assets:build` validates the source provenance, every native FITS MOC,
Euclid geometry, current package archive and supporting record. It then writes
the closed download allowlist and renders `site/public/coverage-overview.png`
from the real NSIDE 16 footprint manifest.

The container repeats catalog verification at startup. The Helm init container
copies a verified release into a versioned PVC directory and atomically moves
the `current` symlink only after the copied data passes the same checks.

## Container and Helm

```bash
podman build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:0.1.0-20260818123137 .

helm lint charts/astro-survey-atlas-assets
helm upgrade --install astro-survey-atlas-assets \
  charts/astro-survey-atlas-assets \
  --namespace astro-survey-atlas-assets \
  --create-namespace \
  -f deploy/k3s-values.yaml
```

The K3s values reserve NodePort `32083`, use the `nfs-data` storage class and
publish `astro.assets.dev.72602.space` through the nginx Ingress.
DNS for that host remains an external prerequisite; NodePort access works
independently at `http://10.15.51.75:32083/` on the current cluster node.
