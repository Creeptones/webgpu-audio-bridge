# Roadmap

The path from where the project is today to a 1.0 stability commitment.
For the per-release history (every patch with shape + rationale), read
[`CHANGELOG.md`](./CHANGELOG.md).

## The 1.0 trigger

1.0 is a **settled-API promise**, not a feature checkpoint. Bumping
there means committing to backward compatibility going forward: no
breaking changes to the schema DSL, the `Bridge<S>` public surface, the
SAB byte protocol, or the composable primitives without a 2.0.

We will not race. From the project's [`CLAUDE.md`](./CLAUDE.md)
versioning policy:

> `0.7.0 → 0.7.1 → 0.7.2 → … → 0.7.99` is the expected patch lifetime
> for a minor cohort. Don't promote to `0.8.0` after a handful of
> patches — let the patches accumulate and use each one as a checkpoint
> to assess "are we ready for 1.0 yet?" The same applies at every
> subsequent minor.

80% of the polish toward 1.0 happens in the last 20% of the work.
Treating minor bumps as cheap promotions inflates the version number
past the actual maturity. Each patch is the checkpoint.

## Currently shipping — the 0.9.x soak cohort

The 0.8.x audit cohort closed with three pre-1.0 prune patches
(0.8.10–0.8.12) that documented and deprecated the legacy surfaces, then
the **0.9.0 breaking cut** that deleted them. The 0.9.x line is the soak
window: deep patches against the slimmed surface until the 1.0 stability
question can be answered.

| Slot | Status | Theme |
|---|---|---|
| 0.8.1 | ✅ shipped | Concurrency hardening + observability docstrings |
| 0.8.2 | ✅ shipped | `pullAll` single-trailing-notify + BigInt-free PLL publish |
| 0.8.3 | ✅ shipped | concurrent-test `emptyWaitTimeouts` flake fix |
| 0.8.4 | ✅ shipped | fast-check property pins for FrameSmoother / trajectory / PLL |
| 0.8.5 | ✅ shipped | `tests/Bridge.test.ts` 8-way feature-file split |
| 0.8.6 | ✅ shipped | Documentation polish (this file + `QUICKSTART.md` + README rework) |
| 0.8.7 | ✅ shipped | First npm publish + `webgpu-audio-bridge dev` CLI |
| 0.8.8 | queued | Wavefunction consumer migration + flagship telemetry overlay |
| 0.8.9 | queued | `examples/wavefunction-mini/` Aubry-André demo |
| 0.8.10 | ✅ shipped | `interpolationMode` union closed at 1.0 (pre-1.0 prune 1/N) |
| 0.8.11 | ✅ shipped | Deprecation-soak pass before 0.9.0 cut (pre-1.0 prune 2/N) |
| 0.8.12 | ✅ shipped | `BridgeWebNNSource` experimental-status warning sharpening (pre-1.0 prune 3/N) |
| **0.9.0** | ✅ **shipped** | **Breaking cut**: removed `Float64RingBuffer`, `legacyPhysicsControlFrameSchema`, and `underflowPolicy: 'throw'`. Migration guide in CHANGELOG. |
| 0.9.1 | ✅ shipped | Shared heap helpers — extract `newHeapTypedArray` + `buildScratchFrame` into `src/_heap.ts`, dedupe 4 facade copies. Internal-only, wire-equivalent. |
| 0.9.2 | ✅ shipped | Centralize invariant thresholds — `INVARIANT_OK_THRESHOLD` / `INVARIANT_SOFT_THRESHOLD` / `INVARIANT_SOFT_ALPHA_BASE` become single-source in `src/Bridge.ts`, imported by `BridgeConsumer.ts`. Internal-only, wire-equivalent. |
| 0.9.3 | ✅ shipped | Audit-response patch — fix `examples/minimal/worklet.js` + `bench/e2e-latency/worklet.js` SAB header view (`BigInt64Array` → `Int32Array`) to match the post-0.4 Int32-lane protocol; add `tests/readme-imports.test.ts` as a public-API drift gate. |

The closeout of the audit cohort is also the closeout of the major
gaps to 1.0: tests parallel-runnable by topic, docs surfaced as
top-level files, library on npm with a one-command dev server, a
flagship downstream consumer end-to-end, and a self-contained
example demo that doubles as a regression harness.

0.8.10 → 0.8.12 shipped out of strict numerical order — 0.8.8 + 0.8.9
are scoped externally (consumer migration + demo) and continue in
parallel; the pre-1.0 prune patches had no dependencies on either, so
they landed first as the smallest 0.8.x patches still queued. 0.9.0 is
the minor-bump anchor for the breaking cut; the slimmer surface is the
substrate for the 0.9.x soak.

## Reserved slot — 0.8.0 (MessageChannelBridge)

0.8.0 is reserved for `MessageChannelBridge<S>` — the **Standard
mode** sibling to Turbo. Same schema DSL, same frame API, transport
swapped to `MessageChannel` + transferable `ArrayBuffer`. Latency
floor 5–50 ms (measured). Right for prototyping before COOP/COEP is
configured, control-plane updates in unisolated embeds, telemetry
channels, anything non-audio-critical. **Not for audio rate.**

The minor-bump anchor that ships whenever the wire-format change is
ready. Timing is flexible relative to 0.8.6–0.8.9.

## Beyond the cohort (speculative, `0.9.1+`)

Surfaced as a parking lot; none of these is planned in detail yet.
For the structured path to 1.0 — including the 0.9.x polish patches +
the soak gate — see the internal pre-1.0 cohort plan.

- **`BridgeReader<S>` / typed consumer view** — the inverse of
  `BridgeGPUSource`. A receiver-side helper that owns the
  destructured-frame surface so a consumer doesn't manage scratch
  frames manually.
- **WebNN MLTensor zero-copy follow-up** — `writeTarget: 'tensor'`
  on `BridgeWebNNSource`. Scaffolded in 0.7.16/0.7.17; needs the
  W3C WebNN tensor surface to expose a writable mapping before the
  implementation can land.
- **Cache-line padding pass on `SpscRing`** — perf only.
  False-sharing-style padding between `write_index` and `read_index`
  lanes. Needs bench delta evidence on real cross-core traffic before
  it's worth the LOC.
- **Second reference consumer surface** — a Worker → main-thread
  visualization path next to the AudioWorklet path. Exercises the
  bridge under a different real consumer pattern.

## Beyond 1.0

- **Topology variants** — MPSC (multiple producers → one consumer)
  and SPMC (one producer → multiple consumers). SPSC stays the
  canonical case.
- **Lane-width variants** — `f16` / quantized lanes for control buses
  where `f64` is overkill; ~4× bandwidth savings on mobile / Apple
  Silicon.
- **`Int32` wrapping-index variant** for use cases that want
  Adenot-grade push/pull speed and can tolerate a bounded session
  length.
- **Zero-copy GPU producer path** — let the GPU write directly into
  the SAB-backed buffer via `mappedAtCreation` / `mapShared`
  semantics, avoiding the CPU memcpy. 0.7.15 shipped the
  forward-compat scaffolding (`WriteTarget` strategy +
  `webgpuZeroCopy` capability sniff); the actual
  `SharedMemoryWriteTarget` lands the day a browser exposes the W3C
  shared-memory readback interface (tracked alongside
  [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432)).

## Shipped pre-0.8

The full per-release history with rationale, wire-compat notes, tests,
and bench numbers lives in [`CHANGELOG.md`](./CHANGELOG.md). Headline
milestones:

- **0.7.17** — WebNN MLTensor source (experimental subpath).
- **0.7.16** — WebNN tensor capability sniff.
- **0.7.15** — Zero-copy `WriteTarget` scaffold (see capability flag
  on `EnvironmentReport`).
- **0.7.13 / 0.7.14** — Audio-rate mode (`BridgeBlockConsumer`).
- **0.7.4** — Hermite smoother (`pullHermiteLatest`).
- **0.7.3** — `subscribeTelemetry` + soft/stall counters +
  `BridgeGPUSource.inFlightCount` / `lastReadbackUs`.
- **0.7.2** — Drop-oldest race-free by construction (CAS-commit pull).
- **0.7.1** — `getEnvironmentReport()` — platform feature reflection.
- **0.7.0** — Framing pivot: Turbo mode + Standard mode names.
- **0.6.19** — `BridgeInputLane` + fast-lane pattern.
- **0.6.18** — `BridgeGPUSource` — the GPU readback helper.
- **0.6.13** — Observability dashboards on `telemetry()`.
- **0.6.12** — Backpressure policies (reject / drop-newest /
  drop-oldest / block).
- **0.6.10** — Composable consumer / producer primitives exported.
- **0.6.2 / 0.6.3 / 0.6.5** — Phase-locked loop (Pillars 2–3 of
  phase-locked extrapolation).
- **0.6.1** — Trajectory arrays (Pillar 1).
- **0.6.0** — Schema invariants (`.withInvariant`).
- **0.5.0** — Adaptive backpressure (CFL-style `flowScaleHint`).
- **0.4.0** — Int32 wrap counters (ringbuf.js-class atomic floor).
- **0.3.0** — Schema-driven frames (`Bridge<Schema>`).

Pre-0.3 the project shipped under the frozen
[`Float64RingBuffer`](./src/Float64RingBuffer.ts) name — that class is
retained at the v0.1.x byte format for vendor users; removal is
scheduled no earlier than 2.0.

## Contributing

Issues and PRs welcome at
<https://github.com/Creeptones/webgpu-audio-bridge>. New work should
fit the cohort that's in flight (currently 0.8.x audit / polish);
disruptive proposals are welcomed but get parked until the cohort
closes.
