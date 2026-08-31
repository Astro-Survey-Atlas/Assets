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

# Third-Party Notices

This file is a human-readable summary of third-party runtime and development
components declared in `package.json`. It is not a replacement for each
component's own license text. Licenses below were verified on 2026-08-31
against the published package metadata and upstream license files.

| Component | Use | License |
| --- | --- | --- |
| `@aws-sdk/client-s3` | S3-compatible publication adapter | Apache-2.0 |
| `three` | Site 3D / sky rendering | MIT |
| `lucide` | Site icons | ISC |
| `typescript` | TypeScript compiler (dev) | Apache-2.0 |
| `vite` | Site build (dev) | MIT |
| `tsx` | TypeScript execution for scripts and tests (dev) | MIT |
| `pngjs` | PNG generation / validation (dev) | MIT |
| `@types/node`, `@types/pngjs`, `@types/three` | TypeScript type packages (dev) | MIT |
| `healpixjs` | HEALPix pixelization in Node | **Not OSI-approved.** Dual commercial / non-commercial source-available license (Fabrizio Giordano). See [healpixjs LICENSE.md](https://github.com/fab77/healpixjs/blob/master/LICENSE.md). |

## Category X: healpixjs

`healpixjs` is **not** an OSI-approved open-source license. Assets therefore
cannot honestly ship an Apache-only combined distribution while this
dependency remains. Maintainers must either:

1. Replace `healpixjs` with the organization-owned [MOC-Core-SDK](https://github.com/Astro-Survey-Atlas/MOC-Core-SDK) (or another Apache-2.0 / OSI-approved equivalent), or
2. Obtain a commercial license from the copyright holder before publishing a combined distribution that includes `healpixjs`.

Until one of those happens, treat `healpixjs` as Category X: it blocks an
Apache-only redistribution of the combined work. Do not assume the
non-commercial source-available terms cover production, SaaS, or binary
redistribution.

This notice does not invent additional licenses for undeclared transitive
packages. Review `package-lock.json` and each package's own license file
before a public combined release.
