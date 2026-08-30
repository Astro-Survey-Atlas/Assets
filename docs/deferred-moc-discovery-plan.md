# Deferred Warehouse MOC Discovery

Status: implemented and verified on 2026-08-30; the live Operator and discovery
worker are deployed with the CDS MOCServer filter API.

The implementation is intentionally outside the Assets runtime boundary.
Assets does not execute discovery or own the Operator. Warehouse owns the CRD,
worker, RBAC and deployment; the bounded JWST verification request returned 16
candidates and 10 accepted spatial probes. Empty or malformed upstream bodies
are retained as protocol evidence and are not reported as a valid empty query.

When resumed, Warehouse will own a typed `MocDiscoveryRequest` for `search` and
`probe` against the allowlisted CDS MocServer. Its Operator and a dedicated
`moc-discovery-cli` will perform bounded HTTP/FITS validation and write full
records, MOCs, headers, hashes, and errors to Warehouse evidence. Discovery
must never write `ast_*`, create a `CoverageLayer`, or publish coverage.

Assets will only submit and read that request, expose bounded results on the
Admin task workspace, and perform scientific review. Candidate approval is a
versioned `ready-for-build` record keyed by provider, candidate ID, and source
snapshot SHA-256; it does not edit Git, build, or publish automatically.

The existing eight entries in `src/moc-sources/source-registry.json` remain
reviewed fixtures. No new public MOC candidate is promoted automatically;
candidate approval remains an explicit Admin review.
