# Warehouse reverse-lookup latency diagnosis, 2026-09-25

## Scope

This read-only diagnosis concerns one public reverse-lookup request for the
Euclid Q1 VIS layer, bound to evidence alias
`assets-batch-48e5a56db553253a456f`, using 43 order-8 cells and `limit=6` with
`tolerateUnavailable=true`. The measurements below use the same lookup scope;
ordinary-layer queries without the batch alias are not comparable.

No Assets runtime code or Elasticsearch settings were changed for this
diagnosis. The replay and observability checks below were read-only; no scan,
rescan, retry, restart, or tuning operation was performed.

## Measurements

An exact-argument Store timing took 11.7 seconds. The Elasticsearch layer
search reported `took=9266 ms`, and the file-observation search reported
`took=2285 ms`; partition and coverage searches reported 1 ms and 2 ms. The
timing record is `/tmp/assets-hst-batch-alias-same-args-timing.json` and
contains no endpoint or credentials.

A later profiled call for the same scope took 15.1 seconds. Elasticsearch
reported `took=8923 ms` for the layer search and `took=6000 ms` for file
observations. Profiled Lucene query, rewrite and collector work was about 9 ms
and 1.7 ms, respectively. The profile did not include fetch timing. This
narrows the unexplained time to work not represented by those profiled Lucene
query timings, but does not identify the cause.

A subsequent same-scope call was fast: Store time was 84.9 ms, with 6 edges,
3 files, and all 352 of 352 committed partitions. In an `_source` comparison,
the layer response was 11,000 bytes with ordinary `_source` and 9,589 bytes
with `_source:false`; observation responses were 7,597 and 5,218 bytes. Each
search reported Elasticsearch `took=1 ms`. These response-size differences do
not account for the earlier multi-second search times. The comparison and
profile summary are in `/tmp/assets-hst-source-mode-diagnostic.json`.

## Bounded live replay

The saved expanded H replay was sent three times sequentially through the
running Assets backend service using the anonymous preview path. The request
body was the saved `query` object from
`/tmp/assets-q1-desi-expanded-h-pagination.json` with `preview=true`: eight
layer IDs, order 8, and 506 cells. Its request JSON SHA-256 was
`731636d5919bb8705910c3b14131f260c5aeada3b03eb75bd1d0671004f78edd`.
The probe treated client elapsed time above 5,000 ms as the reported symptom
and kept response bodies out of the evidence.

| sequential attempt | HTTP | client elapsed | result |
| ---: | ---: | ---: | --- |
| 1 | 200 | 985 ms | below threshold |
| 2 | 200 | 5,786 ms | **threshold exceeded** |
| 3 | 200 | 347 ms | below threshold |

All three responses were available and paginated, with the same response
shape (2 preview files, 4 entrypoints, 0 coverage-evidence items, and
`hasMore=true`). The red-capable command was a Node `fetch` replay against the
local port-forward of the live Assets backend; it exits non-zero when the
HTTP status is not 200 or elapsed time exceeds 5,000 ms. Sanitized per-attempt
records (mode 0600) are:

- `/tmp/assets-q1-desi-expanded-h-latency-attempt-1.json`
- `/tmp/assets-q1-desi-expanded-h-latency-attempt-2.json`
- `/tmp/assets-q1-desi-expanded-h-latency-attempt-3.json`

This reproduces the intermittent symptom without adding concurrent lookup
load. It does not isolate whether the delay is in the Assets request path,
Warehouse Elasticsearch, or storage.

## Limits

The cluster was green and single-node, and sampled search and write queues were
empty. During the 5,786 ms request, a point-in-time ES stats sample still showed
no active search task, zero search queue, and zero search rejections; the
sample may have landed between the request's internal searches. The follow-up
snapshot showed cluster health green, zero pending cluster tasks, zero active
search tasks, no non-idle hot-thread report, Elasticsearch at 1,193 MiB of a
2 GiB cgroup, and 17m CPU. The cgroup exposes historical CPU throttling
(`nr_throttled=3405`, `throttled_usec=150034299`), but no per-request throttle
counter. The ES PVC uses `nfs-data`; no mount latency or I/O statistics were
captured during the slow request. Slow-log thresholds remain disabled.

These observations do not establish NFS, resource pressure, fetch work, CPU
throttling, or any other specific cause. They only bound the latest slow
window: the symptom is real, intermittent, and was not accompanied by an
observable queued search or cluster-health failure at the sampled instant.

## Operational status

Catalog overfetch has been fixed. Warehouse-unavailable lookup failures now
return HTTP 503 with `Retry-After` instead of appearing as empty HTTP 200
results. Those changes address separate behaviors; the latest fast lookup does
not demonstrate that the historical Elasticsearch latency spikes are fixed.

This note records diagnosis only. It does not authorize a scan retry, an index
change, migration, or publication.
