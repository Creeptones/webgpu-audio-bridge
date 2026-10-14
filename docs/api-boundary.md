# API boundary

This repository contains both the stable bridge track and active lab work. The
package boundary is intentional:

- `webgpu-audio-bridge` is the 1.0 candidate import path.
- `webgpu-audio-bridge/worklet` is the worklet helper path.
- `webgpu-audio-bridge/experimental` is the lab path.
- `webgpu-audio-bridge/experimental/core` (0.9.946) is the same lab surface
  without the optional `acorn` peer — use it from AudioWorklets, no-bundler
  module workers, and any app that does not compile JS-source JIT kernels.

The root import must not grow by accidentally re-exporting JIT, WebNN, MPMC,
SPMC, work-queue, DAG, kernel-grammar, hot-swap, or cross-schema migration APIs. Those live under
`webgpu-audio-bridge/experimental` until explicitly promoted.

The root import can still contain advanced stable building blocks. The current
1.0 candidate root is split into three practical buckets:

- Primary app surface: `Bridge`, `connect`, `mount`, `MessageChannelBridge`,
  `BridgeProducer`, `BridgeConsumer`, `BridgeInputLane`, schema constructors,
  and environment reporting.
- GPU/worklet surface: `BridgeGPUSource`, WGSL/WASM decoder codegen, and
  worklet reader/processor codegen.
- Advanced stable surface: `SpscRing`, block facades, residual quality control,
  circular lane math, trajectory evaluators, and timeline recorder/player.

Anything that introduces multi-producer scheduling, graph compilation,
runtime kernel parsing, WebNN, cross-schema migration, or God-node hot-swap
stays behind `webgpu-audio-bridge/experimental` until promotion is deliberate.

`docs/stable-api-manifest.json` is the machine-readable summary of that split.
`npm run check:api-boundary` enforces the package exports and checks that root
`src/index.ts` does not contain known experimental markers.

The same check enforces the dependency split: the stable package must not list
`acorn` in `dependencies`; the experimental JIT parser gets it through an
optional peer dependency plus this repository's `devDependencies`.

Since 0.9.946 exactly one file imports `acorn`: `src/jit/acornParser.ts`, a
side-effect module that calls `registerJsParser(acorn.parse)`. The
`/experimental` barrel imports it; `/experimental/core` does not, so the
JS-source path there rejects with `E_PARSE` until the caller registers a parser
(`registerJsParser`). `tests/JitCompiler.test.ts` pin 10 enforces the import
graph for both the root and `/experimental/core`.

`npm run check:api-snapshot` compares the checked-in public-surface snapshots in
`docs/api-snapshots/` against the built `dist/index.d.ts` and `dist/experimental/core.d.ts` files. Run `npm run build` first, then
`npm run api:snapshot` intentionally when changing exports.

Promotion rule:

- document the promotion in README and CHANGELOG;
- remove the marker from `experimentalOnlyMarkers`;
- add the API to `rootExports`;
- decide which root bucket owns the API;
- update tests before publishing.
