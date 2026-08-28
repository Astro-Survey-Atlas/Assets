# Astro Survey Atlas

Astro Survey Atlas is an open infrastructure project for discovering where
public astronomical surveys cover the sky and how to reach the official data.
The `Assets` repository is the public front door: it publishes reviewed survey
metadata, ICRS/NESTED HEALPix coverage, overlap results, provenance and
versioned Resource Package v3 releases.

This repository is one part of the [Astro Survey Atlas organization](https://github.com/Astro-Survey-Atlas):

| Project | Role | Start here |
| --- | --- | --- |
| [Assets](https://github.com/Astro-Survey-Atlas/Assets) | Public survey directory, coverage maps, MOCs, overlap and release artifacts | [Live directory](https://astro.assets.dev.72602.space:32443/surveys/) |
| [Warehouse](https://github.com/Astro-Survey-Atlas/Warehouse) | Scanner, ScanPlan/ScanRequest execution, current file/coverage indices and evidence | [Warehouse README](https://github.com/Astro-Survey-Atlas/Warehouse) |
| [Workspace](https://github.com/Astro-Survey-Atlas/Workspace) | User assets, connectors, local workflows, user MOCs and private exploration | [Workspace README](https://github.com/Astro-Survey-Atlas/Workspace) |

## How the projects work together

```mermaid
flowchart TB
  U[Researchers and data users] --> A[Assets\npublic catalog and sky UI]
  A -->|public coverage task\nScanPlan v2| W[Warehouse\nscanner and current state]
  W -->|ACTIVE ast_*\nfile/coverage evidence| A
  A -->|Resource Package v3\nMOCs and provenance| X[Workspace\nuser data workspace]
  X -->|optional user ScanRequest\nnamespace-local| W
  X -->|local assets, MOCs,\nworkflows and history| X
```

The boundaries are deliberate. Assets decides what becomes a public release
and presents the result. Warehouse enumerates configured local/S3/OSS sources,
extracts file-level spatial metadata and reports the current `ast_*` index
state. Workspace keeps user data and task history in its own data plane; it
can consume verified public packages and optionally use Warehouse for a user
scan, but it never publishes user records back to Assets.

```mermaid
flowchart LR
  S[Source inventory snapshot] --> F[Filter and metadata read]
  F --> I[ICRS validation]
  I --> H[NESTED HEALPix cells]
  H --> M[MOC, preview, query blocks]
  M --> P[Manifest + SHA-256]
  P --> R[Public Resource Package v3]
  P -. audit-only .-> E[Evidence object storage]
```

Assets never treats a preview as a finer measurement. Each response reports
the real order and one of `exact`, `estimated`, `entrypoint-only` or
`truncated` precision. The online reverse lookup is bounded and reads only the
configured Warehouse endpoint (`ASSETS_WAREHOUSE_ES_URL`).

## What Assets publishes

- `GET /api/v1/surveys` and `GET /api/v1/products` for reviewed metadata and
  product dossiers.
- `GET /api/v1/coverage/catalog` and immutable coverage blocks for the sky UI.
- `POST /api/v1/coverage/overlap` and `/overlap/details` for common-order
  intersections and connected regions.
- `POST /api/v1/coverage/reverse-lookup` for bounded file, tile and download
  entrypoint matches.
- Resource Package v3 archives containing MOCs, a public footprint projection,
  provenance and a package README.

The [coverage workflow](docs/coverage-workflow.md),
[API reference](docs/api-reference.md) and [Resource Package integration guide](docs/resource-package-integration.md)
define the stable contracts. The [MOC Core contract](docs/moc-core-contract.md)
documents the existing offline `astro-survey-moc-core` implementation; the
organization does not currently promise a general-purpose online SDK.

## Public release and evidence storage

Git is the source of truth for small, reviewable release metadata: survey and
layer registries, recipe locks, schemas, catalog projections, provenance
summaries and hashes. Versioned MOCs, packages and large evidence are intended
for an object-storage release bucket. The repository currently contains the
working artifact set while this migration is designed; no artifact is deleted
as part of the design work.

See [Public artifact storage and migration](docs/public-artifact-storage.md)
for the bucket layout, immutable URL/hash contract, evidence boundary and
cutover procedure. In particular, input manifests and normalized scans remain
evidence and are never part of the browser's initial request or the public
release allowlist.

## Local development

```bash
npm ci
npm run validate
npm start
```

The service listens on `http://127.0.0.1:4180`. Set
`ASSETS_WAREHOUSE_ES_URL` when testing Warehouse-backed reverse lookup; the
static public geometry catalog remains usable without it.

The site has separate entry points for the [project overview](/github/),
[survey directory](/surveys/) and [integration/SDK status](/sdk/).

中文说明见 [README.cn.md](README.cn.md)。
