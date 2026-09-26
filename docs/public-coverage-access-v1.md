# Public Coverage Access v1

The public sky and package boundary is the reviewed release snapshot. A
Warehouse layer being `ACTIVE`, a completed scan, or a staged MOC does not make
it public. A product is public only when its current revision was reviewed under
`reviewed-release-v1` and a complete release snapshot containing its geometry,
catalog and package records was activated.

Resource Package v3 native MOCs are public and are the Workspace geometry
boundary. They declare ICRS/NESTED NUNIQ encoding, actual available orders,
overview/max order, `coverageRevision`, `indexRevision`, stable product/source
identity and an explicit geometry/access capability. Footprint JSON is only a
display projection; it must not be expanded to claim finer precision.

Public overlap previews use a bounded reverse lookup and show at most six
matching Tile/file source entries. Full tile/file reverse lookup and exports
of download-plan files (JSON/CSV source manifests) require a managed
`region:query` API Key via
`X-Assets-API-Key`. `POST /api/v1/access/unlock` accepts only that API Key and
issues a short-lived HttpOnly session for browser exports. Public MOC and
Resource Package downloads remain open so Workspace can synchronize normally.
The browser never receives the Workspace service key. Download-plan files
contain identities, spatial matches, source metadata and links, not scientific
data. Assets never fetches scientific data for users; an Assets API Key grants
no access rights at the external source. Missing links do not invalidate known
source evidence; see [export limitations](api-reference.md#csv-and-json-exports).
The drawer's “Continue browsing” action also requires the API Key and pages
through the source list without retrieving scientific files.

## Region query

`POST /api/v1/access/region-query` accepts:

```json
{
  "purpose": "fine-overlap",
  "region": {"order": 8, "cells": [163327]},
  "layerIds": ["euclid-euclid-q1-euclid-q1-vis-moc", "desi-dr1-spectra-footprint"],
  "limit": 500
}
```

The request must use concrete layer identities. The response includes the
actual order, coverage/index revisions, matched cells, capability and expiry.
It never returns a full private index. Euclid products without a source-unit
index return `entrypoint-only`/`geometry-only`; DESI products with the locked
official tile table can resolve Tile entries; this does not verify scientific
file contents or imply file-level indexing. Limits are enforced on body size,
source count, cell count, result count and expiry.

For integration checks, select a real overlap from the current published
Euclid Q1 VIS and DESI DR1 layers and record their revisions, actual common
order and cells. Counts and cell IDs depend on those versions; do not reuse
a historical fixed count or compare the order-4 preview with a finer result.
