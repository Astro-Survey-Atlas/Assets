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

# Contributing

Astro Survey Atlas Assets is developed in the open in the
[Astro Survey Atlas organization](https://github.com/Astro-Survey-Atlas). It
uses Apache-2.0 and a review-first workflow. It is not governed by the Apache
Software Foundation or an ASF PMC.

## Before Opening A Change

1. Read [`README.md`](README.md), [`AGENTS.md`](AGENTS.md), and the relevant
   contract under [`docs/`](docs/).
2. [`HANDOFF.md`](HANDOFF.md) is maintainer session notes, not the contributor
   guide. Do not copy live endpoints from it into issues or pull requests.
3. For a behavior change, describe the user-visible contract and failure mode
   in the issue before implementing it.
4. Coverage, overlap, reverse-lookup, and Resource Package changes must follow
   [`docs/coverage-workflow.md`](docs/coverage-workflow.md).
5. Never include credentials, signed URLs, raw astronomy payloads, or local
   machine paths in a plan, evidence fixture, log, or pull request.

## Development Checks

```bash
npm ci
npm run test:node
```

`npm run test:node` is the check CI runs and the default local gate.
`npm test` also runs test:core, which needs a checkout of
[MOC-Core-SDK](https://github.com/Astro-Survey-Atlas/MOC-Core-SDK).
`npm run validate` is the full build plus tests; it likewise needs MOC-Core-SDK
and is not required for documentation or hygiene pull requests.

Add tests at the highest useful public interface. Contract changes must update
the corresponding Markdown contract under `docs/`.

## Pull Requests

Pull requests should state the problem, contract change, compatibility impact,
and tests run. Keep commits reviewable. A maintainer may request a cross-repository review from Warehouse or Workspace when
their contract is affected.

Contributors certify each commit with a DCO sign-off:

```text
Signed-off-by: Your Name <you@example.com>
```

The repository does not require a CLA today. Contributions are accepted under
Apache-2.0 when submitted for inclusion, subject to the contributor's DCO
sign-off and the project's review process.
