---
name: astro-survey-atlas-coverage-workflow
description: Apply the fixed Astro Survey Atlas Assets forward MOC scan, evidence, HEALPix precision, overlap, and reverse-lookup workflow when changing survey recipes, warehouse integration, release data, or coverage APIs.
---

# Astro Survey Atlas coverage workflow

Read `AGENTS.md` and `docs/coverage-workflow.md` first.

## Required invariants

1. Inputs are a named inventory snapshot with a SHA-256 and a warehouse scan
   run. Filter and WCS/metadata errors are retained as evidence.
2. Coordinates are validated as ICRS. Cells are explicit NESTED `order/ipix`
   pairs; never infer a finer order from a preview.
3. The lock declares `availableOrders`, `overviewOrder`, `maxOrder`, recipe
   steps, implementation references and output hashes.
4. Emit MOC, query, preview, statistics, manifest and provenance. Attach source
   file IDs/URIs to coverage edges for reverse lookup.
5. Runtime uses only the configured warehouse Elasticsearch endpoint. A legacy
   ES URL may appear only as an explicit argument to a one-shot migration.
6. Overlap chooses the highest order shared by all selected layers, intersects
   cells at that order, labels connected components C01/C02, and reports the
   limiting order and precision.

## Implementation checklist

- Update the recipe lock and `src/layers/layer-registry.json`.
- Validate the evidence document against
  `contracts/coverage-evidence-v1.schema.json`.
- Export `files.parquet` and `coverage_edges.parquet` to evidence storage when
  the Parquet exporter is available; retain the original manifest as compressed
  evidence too.
- Test catalog size classification, order precision, overlap components and
  reverse lookup response limits before publishing.
