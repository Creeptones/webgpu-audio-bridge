# API boundary

This repository contains both the stable bridge track and active lab work. The
package boundary is intentional:

- `webgpu-audio-bridge` is the 1.0 candidate import path.
- `webgpu-audio-bridge/worklet` is the worklet helper path.
- `webgpu-audio-bridge/experimental` is the lab path.

The root import must not grow by accidentally re-exporting JIT, WebNN, MPMC,
SPMC, work-queue, DAG, or kernel-grammar APIs. Those live under
`webgpu-audio-bridge/experimental` until explicitly promoted.

`docs/stable-api-manifest.json` is the machine-readable summary of that split.
`npm run check:api-boundary` enforces the package exports and checks that root
`src/index.ts` does not contain known experimental markers.

Promotion rule:

- document the promotion in README and CHANGELOG;
- remove the marker from `experimentalOnlyMarkers`;
- add the API to `rootExports`;
- update tests before publishing.
