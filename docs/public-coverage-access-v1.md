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

Scientific downloads, tile/file reverse lookup and download plans require the
Assets download session (`POST /api/v1/access/unlock`, password configured by
`ASSETS_DOWNLOAD_PASSWORD`, development default `123`) or a server-to-server
`X-Assets-API-Key`. Public MOC and Resource Package downloads remain open so
Workspace can synchronize normally. The browser never receives the Workspace
API key.

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
official tile table may return `tile-resolved` after the tile resolver is
enabled. Limits are enforced on body size, source count, cell count, result
count and expiry.

For the fixed integration case, the current package MOCs have 501 common O8
cells for Euclid Q1 VIS and DESI DR1. Use `order=8,cells=[163327]` and compare
the returned revisions and cells; never compare the order-4 preview.
