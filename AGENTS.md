# Astro Survey Atlas Assets rules

## Session handoff

Read `HANDOFF.md` at the start of a new session for the current implementation,
verification baseline, known problems, dirty worktree, and next priorities.

## Product purpose

Assets locates survey data and explains its spatial evidence and provenance.
A download plan is a downloadable JSON/CSV source manifest, not scientific data.
Keep known source identities and evidence visible even without a retrieval link;
never invent a file or link. Assets must not download scientific data on behalf
of users. Users obtain it from the source under that source's access policy.
For reverse-lookup, export or access documentation, follow
`docs/coverage-workflow.md` and distinguish manifest export from data retrieval.

## Coverage data boundary

- Assets is the public release, MOC, preview, evidence and reverse-lookup owner.
- `data-warehouse` is the execution and status owner. Assets submits standard
  scan tasks and consumes their normalized file/coverage documents.
- Runtime code may connect only to the configured warehouse Elasticsearch
  endpoint (`ASSETS_WAREHOUSE_ES_URL`). The historical ES cluster is permitted
  only as an explicit source for one-shot migration scripts.
- Never put input manifests, normalized scans or task snapshots in the browser's
  initial request. Mark them `deliveryClass: evidence` and keep them on the
  evidence PVC/object store.
- CSST private scans, inputs, outputs, previews and recipes belong to Workspace.
  Keep them out of Assets Git, backend storage, evidence archives and releases.
  Keep synthetic fixtures and public deny checks to prevent reintroduction from
  historical snapshots. Other input evidence follows the storage rules above.

## Coverage workflow

Public MOC publication requires an actual native maximum order of at least 4;
check decoded NUNIQ cells, never an upsampled preview or a requested order.

Every new survey recipe must follow `docs/coverage-workflow.md` and declare
ICRS/NESTED, available orders, input snapshot hashes, source file references,
and the exact/estimated precision of every output. Do not manufacture an order
8 cell from an order 4 overview. A reverse lookup must return the actual order
and whether the result is exact, estimated, entrypoint-only or truncated.

Read the `astro-survey-atlas-coverage-workflow` skill before changing scan,
MOC, overlap, evidence or reverse-lookup code.
