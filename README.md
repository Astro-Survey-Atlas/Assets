# Astro Survey Atlas Assets

Independent public download service for verified Astro Survey Atlas coverage
artifacts. This repository owns its data snapshot, website, container image and
Helm chart. Assets is independently deployable and does not depend on another
project's internal API, database, image, chart or PVC. When Assets requests
coverage computation, it submits the standard `AstroDataSource` and
`AstroMetadataScanTask` resources accepted by data-warehouse.

## Published release

The authoritative inputs are:

- `src/footprints/survey-footprints.json`
- `artifacts/public-survey-footprints/provenance.json`
- `src/layers/layer-registry.json`

The release includes native FITS MOCs and source records, the Euclid Q1 DS9
geometry archive, official DESI EDR/DR1 observed-tile FITS tables, current resource-package ZIP files, the product status
ledger, calculation notes, normalized manifests and SHA-256 provenance.
The Assets-owned Core build plan in `src/layers/public-build-plan.json` also
publishes locked Euclid Q1, DESI EDR and DESI DR1 authoritative layers with
their order-8 query indexes, order-4 previews, statistics and provenance.
The layer registry reserves stable IDs for the next Euclid ERO/Q2 and Legacy
DR1–DR10 layers as `awaiting_snapshot`; those entries are metadata only until
official inputs are acquired, locked and added to the build plan.
Only files referenced by `release-manifest.json` are exposed by the anonymous
download API. Historical package archives that are not in the current catalog
remain unavailable through HTTP.

## Offline MOC Core

This repository also owns the `astro-survey-moc-core` distribution, whose
Python import package is explicitly named `astro_survey_moc_core`, and the
`astro-survey-moc-core` CLI. The Core writes deterministic IVOA FITS MOCs,
derives order-8 query indexes and order-4 previews, merges stable shard output,
and builds or validates Resource Package v3 archives. `refresh` is its only
networked command; `rebuild` (or `build --rebuild`) requires a SHA-256 locked
local snapshot.

The scientific and package contract is documented in
[`docs/moc-core-contract.md`](docs/moc-core-contract.md). The reviewed CSST
artifact is frozen and is validated in place rather than regenerated.
The Assets/data-warehouse/Atlas boundary and Assets' data-warehouse requirements
are documented in [`docs/architecture-boundary.md`](docs/architecture-boundary.md)
and [`docs/data-warehouse-requirements.md`](docs/data-warehouse-requirements.md);
machine-readable contracts live under [`contracts/`](contracts/).

```bash
python3 -m pip wheel --no-deps --no-build-isolation . -w wheelhouse
python3 -m astro_survey_moc_core.cli --version
python3 -m unittest discover -s python-tests -v
```

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
  -t crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:1.0.0-dev .

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
