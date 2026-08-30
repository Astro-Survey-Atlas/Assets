# Warehouse MOC Discovery

Status: implemented and verified on 2026-08-30. The live Warehouse Operator and
discovery worker use the `cds-public-moc-v2` CDS MocServer filter API.

Warehouse owns the namespaced `MocDiscoveryRequest` CRD, its evidence-only Job,
RBAC, and bounded status projection. The worker performs one allowlisted search;
it does not download candidate MOCs, run probes, write `ast_*`, create a
`CoverageLayer`, or publish coverage. The verified JWST request returned 16
candidates and 10 accepted spatial MOCs in the later source-validation record;
discovery itself only returned candidates. Empty candidate results and malformed
or empty upstream bodies remain distinct evidence states.

The policy reads at most 51 search records and keeps at most the first 50 in
`status.reviewSummary`. The extra record is a sentinel that makes
`truncated=true` reliable without putting an unbounded result set in a CRD or
browser payload. `reviewSummary` is schema version 2 and contains
`truncated`, `summaryTruncated`, optional `searchRecordCount`, and candidate
records with public IDs and URLs. A valid summary with an empty candidate array
is a reviewable zero-result search; a missing summary means the request is not
ready for review. Existing v1 CRs and evidence are read-only historical records,
not a compatibility path for v2.

Assets submits and reads discovery, presents the bounded candidate summary, and
creates an independent Assets-owned `MocBuildRequest` after an operator selects
a candidate. The build downloads and locks the source snapshot, invokes
MOC-Core-SDK, and writes outputs/evidence through
`QUEUED → FETCHING → SNAPSHOT_LOCKED → VALIDATING → BUILDING → PROJECTING → BUNDLING → STAGED`.
It is independent of `ScanRequest → Warehouse scanner → ast_*` and never changes
that connector scanning workflow. Product publication is a separate explicit
step: only a staged build associated with the product is copied to the content
volume and registered in the public Assets catalog after file/size/SHA-256
verification.

The eight reviewed entries in `src/moc-sources/source-registry.json` remain
reviewed fixtures. No discovery candidate is promoted automatically; source
terms, product copy, and publication remain explicit Assets admin decisions.
