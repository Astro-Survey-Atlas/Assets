# SDSS discovery connection failure, 2026-09-20

Task: `atlas-warehouse/sdss-moc-discovery-20260920033552`.
Evidence: `moc-discovery/sdss-moc-discovery-20260920033552-moc-discovery/execution-plan.json`
on Warehouse's `atlas-evidence-smoke` PVC. The absolute path in a worker is
not a path in the Assets or Workspace evidence volumes.

The original worker reported `HttpConnectTimeoutException: HTTP connect timed out`,
one request and zero bytes. Its evidence was generated at 03:36:17 UTC. The
controller's generic DiscoveryProtocolError discarded the specific cause from
its public message, and the Assets wording misleadingly suggested a protocol mismatch.

Read-only investigation reproduced a 20-second timeout using the exact evidence
URL from a running Pod on the worker's node. DNS resolved `alasky.cds.unistra.fr`
to `130.79.128.175`. curl also failed, so this is not specific to the Java
client. One verbose attempt sent TLS ClientHello without completing the handshake.
A second cluster node also timed out against the target. In the same Pod,
`https://www.sdss.org/` and `https://cds.unistra.fr/` returned HTTP 200.

The evidence isolates the failure to the target connection path, not general
cluster internet access. It cannot distinguish source-specific blocking,
intermediate routing/filtering or the remote service. Warehouse owns execution
and operational investigation; this does not establish fault at CDS, nor establish
that SDSS DR1 has no MOC. No discovery retry or publication was performed for this
historical request. Preserve its original evidence and failed status.

New workers emit readable structured logs and bounded failure summaries. Assets
shows the executor, endpoint, phase, timing, HTTP/byte outcome and exception chain.
Legacy records explicitly state that a detailed status summary was not supplied.
