# Shared connectors and scan batches

A connector describes access to a source. A batch adds product-specific scan
rules beneath that source; users do not need another connector for every band.
Assets validates the selected products and submits one `ScanBatchRequest`.
Warehouse discovers direct child directories, freezes the complete finite
roster, and schedules bounded child scans. Assets does not enumerate Tiles or
create their child requests itself.

The integration is deployed in dev. The Euclid Q1 MER batch uses one connector,
four VIS/NISP H/J/Y rules and a frozen roster of 352 Tile partitions per rule.
Warehouse schedules the child scans; Assets serves committed results while
the remaining partitions run. Consult `HANDOFF.md` for current progress and
verification evidence: successful execution of this roster is not complete Q1.

Workspace consumes Assets' public reverse-lookup results, including committed
scan scopes, file observations and coverage-only provenance. It does not submit
this public batch or need copies of its connector credentials. Workspace's
private scan workflow remains separate. The Warehouse Workspace caller test
currently verifies its local-volume fixture; it does not establish remote
connector validation.

## Submission and progress

The admin scan tab provides a multi-rule batch form. The authenticated endpoints
are `POST/GET /api/v1/admin/scan-batches` and
`GET /api/v1/admin/scan-batches/:name`.

Each submission has one `sourceConnector`, exactly one `sourcePaths` root,
`partitioning: {mode: "direct-child-prefixes", scopeId, maxPartitions}`,
`maxConcurrent`, and up to 32 rules. Each rule selects a `productId` and has a
unique name and product layer, `relativePrefix`, optional filename glob
`includePattern`, suffixes and extraction settings. Empty `relativePrefix`
means the discovered Tile root; traversal and absolute paths are rejected.
The source must stay inside the connector's configured root.

The root may also be one exact object key when the source is a single catalog
file rather than a directory. Warehouse freezes that key as a one-partition
roster; every rule must then use an empty `relativePrefix`. This form is used
for large DESI catalogs such as `exposures-iron.fits`, so the scan still goes
through the normal Assets to Warehouse request and retains the object URI,
source snapshot and evidence. It does not imply that neighboring files or the
full survey release have been scanned.

Assets assigns each product a stable Warehouse evidence layer named
`assets-batch-<product-token>`. That internal ID is derived from `productId`,
not the batch request name, and stays separate from the public layer ID. Reverse
lookup maps evidence from both IDs back to the public product while retaining
the actual evidence layer on each match. A product's evidence layer has one
fixed partition scope: Warehouse must reject a later submission that attempts
to change that scope rather than silently replacing its frozen roster.

For `catalog-radec`, a rule may select a FITS table with `hduName` or the
zero-based `hduIndex` (including 0), but not both. An HDU selector requires the
exact declaration `coordinateFrame: "ICRS"`. A rule may also declare only
`coordinateFrame: "ICRS"` for CSV coordinates; omitting all three fields keeps
the existing CSV behavior. Other scan modes reject these fields, and Assets
does not infer an HDU from a filename suffix.

A rule's `scanMode` describes scientific-file parsing (`fits-wcs`,
`fits-header-position`, `catalog-radec`, or `nested-healpix`). It is separate from
the product's coverage recipe: a `native-moc` product may add a `fits-wcs` scan
without changing its published MOC. If omitted, only an already executable
product scan mode can be reused. Coordinates for multi-target spectra must come
from actual targets, not one FITS header center. Parser support for the real
input format must be verified before submission.

Batch evidence role follows the parser's scientific target. `catalog-radec`
records target positions, so Assets derives `object_presence` (Warehouse
`occupancy`) even when the selected public product has a `footprint_extent`
recipe sourced from a Tile MOC. This derived role applies only to the batch
evidence plan and does not rewrite the public draft or MOC recipe. `fits-wcs`
and `nested-healpix` retain the selected product's existing role semantics.

For the configured Euclid Q1 MER connector, the root is the MER directory and
its direct children are Tiles. Rules should select only the intended
BGSUB-MOSAIC VIS and NIR H/J/Y scientific images. Background models, PSF, RMS,
FLAG and ground-based products must not be silently included. Filename patterns
and relative directories still need verification through the system against
the frozen input roster; this document is not an inventory snapshot.

Discovery that is empty, truncated or failed does not start children. Increasing
`maxPartitions` explicitly changes the permitted bound; it is not a request to
silently scan only the first N directories. Batch success means successful
execution of that frozen scope, not complete Q1 coverage or valid pixels at
every position. Failed children are not automatically replayed.

## Reading committed evidence

`ast_layer_index_v1` retains ordinary single-scan layers. Batch logical layers
have `layer_mode=PARTITIONED`, `state=PARTITIONED`, `active_scope_id`,
`scope_snapshot_sha256` and `expected_partition_count`. The initial batch scope
cannot silently replace an existing ordinary scan or a different fixed scope.
Existing single-scan evidence remains intact; an explicit, tested transition
is required before reusing such a logical layer for batches.

Within the selected scope, `ast_partition_index_v1` has a `SCOPE` lock and
per-partition manifests. Readers validate version, scope hash and expected
count, then read only each `ACTIVE` manifest's `active_layer_id`. A failed or
pending candidate is not a committed result. Candidate layer documents carry
`layer_mode=CANDIDATE` and are excluded from public logical-layer discovery.

Partitioned file metadata comes from `ast_file_observation_index_v1`, joined by
candidate layer plus file ID and checked against the committed scan run. Its
ID is SHA-256 of `candidateLayerId + "\n" + fileId`. There is no fallback to
mutable global file metadata. Ordinary scans continue to use
`ast_file_index_v1`. Missing metadata does not erase a retained coverage edge
or source URI.

Reverse lookup exposes `scanScopes` with the frozen identity and
`committedPartitions/expectedPartitions`. `completeness=complete` there means
only that every partition in that frozen roster is committed; it does not mean
the roster contains every source object or that the product's scientific
coverage is complete. File matches retain scan run and input snapshot identity;
`files[].observations` preserves differing committed records of the same file.
Conflicting size/name/time/locator values are not presented as one unqualified
file summary. JSON source manifests retain these fields; CSV adds
`file_observations` and `scan_scopes`. Public previews and API Key pagination
continue to follow the existing access policy.

The browser receives bounded summaries, never the frozen roster, credentials,
raw input manifests or task evidence archives. Assets still exports only source
manifests and does not retrieve scientific data on behalf of users.
