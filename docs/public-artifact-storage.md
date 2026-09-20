# Public artifact storage and recovery

Production object storage is the authority for uploaded business data. Assets
site and backend use independent, verified local release caches. Backend owns
business state and the durable publication queue; site serves public data and
proxies authenticated admin requests. See [publication runtime and recovery](publication-runtime-split.md)
for the process/volume layout and [HANDOFF](../HANDOFF.md) for current deployment.

## Public publication

Normal product publication is incremental. After version-bound review, backend
uploads changed files under `public/objects/sha256/<sha256>`, writes an immutable
object manifest under `public/manifests/<sha256>.json`, restores and verifies the
candidate, then changes `public/current.json` with compare-and-swap. The website
independently loads and verifies the selected release. Publication is complete
only after website verification.

The current pointer is schema 3:

```json
{
  "schemaVersion": 3,
  "bundle": { "id": "<bundle-id>", "sha256": "<release-manifest-sha256>" },
  "manifestKey": "public/manifests/<object-manifest-sha256>.json",
  "manifestSha256": "<object-manifest-sha256>"
}
```

The object manifest pins every member's logical path, size and SHA-256. Unchanged
legacy members may retain a schema-2 base archive reference; this compatibility
does not require uploading a complete archive for every publication.
`release-manifest.json` remains the public file-level integrity contract.

Full `release.tar.gz` archives are export/restore artifacts. Resource-package
collection ZIPs are optional historical/distribution exports: consumers must
check whether the selected release declares `collection`. Individual package
versions have their own immutable URLs and hashes.

## Code, runtime data and private evidence

Git contains code, public metadata/recipe locks, synthetic conformance fixtures,
the pinned Core wheel and non-secret integrity references. Real private survey
inputs, coverage outputs, preview pixels and package fixtures do not belong in
Git, including CSST. They may remain in protected Assets/Workspace backend
storage and evidence storage. The public deny policy remains necessary to filter
older snapshots and prevent accidental publication.

The former tracked CSST directory, embedded survey/layer/preview entries and
private build recipes have been removed from the current source tree. They are
not required to build public packages or exercise the shared MOC algorithms.
Historical recipes/evidence must be restored to an explicit private work root,
never added back to the checkout as test data.

Input manifests, normalized scans, task snapshots and raw private inputs are
`deliveryClass: evidence`; they are excluded from initial browser requests.
An integrity reference is not permission to publish the referenced bytes.

Existing evidence is stored under the configured authority namespaces. The
repository-evidence namespace uses content-addressed objects and immutable
snapshot manifests, selected by `repo-evidence/evidence/current.json`.
`evidence-index.json` records logical paths, sizes and hashes for missing inputs.
The dated migration snapshots and receipts are historical evidence; they must
not be treated as current pointers or used to overwrite later business writes.

## Startup and serving

The code-only image contains no public release tree. Startup synchronizes the
configured authority into a verified local cache and atomically selects the
release. Periodic synchronization uses the same validation path. A complete
verified cache can serve during an authority outage; a fresh empty installation
cannot invent or fall back to source-checkout data.

Public downloads are served from the selected local release with Range, ETag
and SHA-256 support. The browser does not receive storage credentials. Site and
backend cache PVCs remain separate; SQLite queue state requires the backend's
local-path volume, not NFS. Do not remove active or historical PVCs as part of a
source cleanup.

Object-store settings come from `ASSETS_OBJECT_STORE_*` and the deployment's
existing Secret. No live endpoint, access key or secret is copied into frontend
code or Git. Use existing environment values when deploying an updated image.

## Rebuild and recovery

Offline public rebuilds need a verified data root and package staging directory;
source checkout alone is not the authority for generated output. If an intentional
source-metadata edit changes a pinned input, regenerate its local provenance
explicitly and retain the previous hash; never suppress a checksum failure.
The rebuild/package scripts do not grant review or publication authorization.

For recovery after new writes, stop backend, preserve SQLite/WAL, business state,
spool and current authority, then follow the export procedure in
[publication runtime](publication-runtime-split.md#rollback-after-new-writes).
Changing the pointer to an old archive or blindly restoring an old snapshot is
not a safe data rollback.
