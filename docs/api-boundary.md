# API boundary

This repository contains both the stable bridge track and active lab work. The
package boundary is intentional:

- `webgpu-audio-bridge` is the 1.0 candidate import path.
- `webgpu-audio-bridge/worklet` is the worklet helper path.
- `webgpu-audio-bridge/experimental` is the lab path.

The root import must not grow by accidentally re-exporting JIT, WebNN, MPMC,
SPMC, work-queue, DAG, kernel-grammar, hot-swap, or cross-schema migration APIs. Those live under
`webgpu-audio-bridge/experimental` until explicitly promoted.

`docs/stable-api-manifest.json` is the machine-readable summary of that split.
`npm run check:api-boundary` enforces the package exports and checks that root
`src/index.ts` does not contain known experimental markers.

The same check enforces the dependency split: the stable package must not list
`acorn` in `dependencies`; the experimental JIT parser gets it through an
optional peer dependency plus this repository's `devDependencies`.

`npm run check:api-snapshot` compares the checked-in public-surface snapshots in
`docs/api-snapshots/` against the built `dist/index.d.ts` and `dist/experimental/index.d.ts` files. Run `npm run build` first, then
`npm run api:snapshot` intentionally when changing exports.

Promotion rule:

- document the promotion in README and CHANGELOG;
- remove the marker from `experimentalOnlyMarkers`;
- add the API to `rootExports`;
- update tests before publishing.
