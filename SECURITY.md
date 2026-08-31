<!--
Copyright 2026 Astro Survey Atlas contributors.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Security Policy

## Supported Versions

Only the latest tagged release and the current default branch receive security
fixes. Published Resource Package artifacts should be rebuilt from a supported
release rather than patched in place.

## Reporting A Vulnerability

Do not open a public issue for an undisclosed vulnerability. Use the private
security reporting channel configured on the
[Assets repository](https://github.com/Astro-Survey-Atlas/Assets/security)
or email [aaron@72602.space](mailto:aaron@72602.space). Include affected
version, reproduction steps, impact, and a suggested
mitigation when available.

The maintainers acknowledge reports within five business days, coordinate a
fix and advisory, and credit reporters unless they request anonymity. Do not
include credentials, cluster addresses, private source URLs, signed URLs, or raw astronomy data in a report.

[`HANDOFF.md`](HANDOFF.md) is maintainer session notes. Do not copy live endpoints, credentials, or cluster details from it into issues, pull requests, or security reports.

## Operational Security

- Keep object-storage and Warehouse credentials in Kubernetes Secrets or an
  external secret manager; never put values in catalogs, provenance, or
  Resource Package README files.
- Treat evidence, source inventories, and unpublished coverage inputs as
  potentially sensitive operational data. They are not part of the public
  release allowlist.
