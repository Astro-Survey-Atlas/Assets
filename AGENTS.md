# Astro Survey Atlas Assets rules

## Session handoff

Read `HANDOFF.md` at the start of a new session for the current implementation,
verification baseline, known problems, dirty worktree, and next priorities.

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
- The CSST `input-manifest.json` is a source/evidence artifact and must not be
  added to the Git-tracked public release allowlist. Keep it in evidence
  storage and preserve its hash/reference in migration/provenance records.

## Coverage workflow

Every new survey recipe must follow `docs/coverage-workflow.md` and declare
ICRS/NESTED, available orders, input snapshot hashes, source file references,
and the exact/estimated precision of every output. Do not manufacture an order
8 cell from an order 4 overview. A reverse lookup must return the actual order
and whether the result is exact, estimated, entrypoint-only or truncated.

Read the `astro-survey-atlas-coverage-workflow` skill before changing scan,
MOC, overlap, evidence or reverse-lookup code.
