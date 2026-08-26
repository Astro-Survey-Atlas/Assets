# Deferred Warehouse MOC Discovery

Status: paused on 2026-08-26 while Warehouse runs its long task.

This work is intentionally outside the current Assets rollout. Do not modify
the Warehouse repository, its CRD, Operator, worker, RBAC, Jobs, or live
resources until the owner explicitly says the long task has finished.

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
reviewed fixtures. No new public MOC candidate is promoted during this pause.
