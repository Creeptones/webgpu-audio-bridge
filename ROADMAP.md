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

**Cadence reset at 0.9.31** (user-directed): the patch number jumped
from 0.9.3 → 0.9.31, leaving 68 patch slots between 0.9.31 and 0.9.99
for the rest of the 0.9.x soak. The original cohort plan's `0.9.4` →
`0.9.7` items don't disappear — they shift right into the new envelope
under different numbers. The cadence reset is a versioning signal to
future readers (and to ourselves) that 1.0 isn't around the corner;
the 0.9.x line is the substrate for everything that lands before the
stability promise.

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
| **0.9.31** | ✅ shipped | `SpscRing.drainNoNotify` public promotion + **cadence reset to 0.9.31**: the next 68 slots (0.9.31 → 0.9.99) carry the 0.9.x soak through to 1.0. The previously-planned `0.9.4 → 0.9.7` patches all shift right into the new envelope. `BridgeInputLane.pullAll` is now a one-line forwarder; the underscore-prefixed `_pullNoNotify` / `_notifyReadAdvance` stay internal but the headline drain primitive is now first-class on the public `SpscRing` surface. Wire-equivalent. |
| 0.9.32 | ✅ shipped | `BridgeGPUSource.onError(err, kind: 'transient' \| 'fatal')` opt-in callback for device-lost handling. Best-effort `'fatal'` classification via `device.lost` subscription; `'transient'` is the default fallback. Default behavior unchanged when omitted. Also fixes a latent rejection-path state-machine bug (the slot now routes to drop-and-recycle instead of calling `getMappedRange` / `unmap` against a never-mapped buffer). Wire-equivalent. |
| 0.9.33 | ✅ shipped | Browser CI matrix gating — `.github/workflows/browser.yml` runs `[chromium, firefox, webkit]` with `fail-fast: false`; `continue-on-error: true` removed. `tests/browser/playwright.config.ts` ships three projects with per-engine autoplay configuration. README §Browser support matrix marks all three "tested in CI". Foundation for the 0.9.35 e2e audio spec. Wire-equivalent. |
| 0.9.34 | ✅ shipped | Worklet error-recovery test pins — new `tests/Bridge.recovery.test.ts` (3 pins, ~330 LOC) documents bridge state across producer disappearance, consumer crash + SAB-state survival, and 5-second frame famine (PLL drift extrapolation + smoother prev resilience). Pure observation patch; pins silent invariants the library has been relying on without explicit documentation. 22 Node suites green (was 21). Wire-equivalent. |
| 0.9.35 | ✅ shipped | `BridgeConsumer.telemetry()` symmetry with `Bridge<S>.telemetry()` — closes the composable-surface telemetry gap. New `BridgeConsumer.telemetry()` returns the same `TelemetrySnapshot` shape; `pll: null` opt-out reports `false` / `0` for the five PLL-side fields. Also wires a `_softFrames` counter on `BridgeConsumer` (was missing pre-0.9.35; surfaced by the absence of `telemetry()`). `tests/BridgeFacades.test.ts` grows to 5 pins with `facade-telemetry-symmetry` as the field-for-field drift gate. Wire-equivalent; purely additive public-API. |
| 0.9.36 | ✅ shipped | Audit-response hygiene patch — `CITATION.cff` `version` field reconciled (`0.7.0` → `0.9.36`; stale `"TBD"`-DOI entries trimmed), README §Browser support matrix refreshed for WebGPU Baseline (Firefox 141+ Windows / 145+ macOS Apple Silicon, Safari 26+ macOS Tahoe / iOS 26 / iPadOS 26 / visionOS 26, Chrome Android 148+), and `### Two transport tiers (0.7.0)` heading + paragraph rewritten so the 0.7.0 framing-pivot release is not confused with the 0.8.0 reserved Standard-mode ship date. `package.json` `description` updated to match. First patch in the audit-response mini-cohort (tasks #1, #5, #9 in the in-flight task list). Wire-equivalent; documentation only. |
| 0.9.37 | ✅ shipped | Audit-response README readability patch — three new front-loaded README subsections that make the project's shape readable on a 30-second skim: `### Status & maturity` (version + tests + distribution + release-artifact policy + maintainership) under the title block; `### Is this the right tool for your problem?` (8-row decision table pointing TOWARD or AWAY from this library, with linked alternatives for each AWAY case) in `## The problem this solves`; and `### Overload policy: freshness over completeness` in `## BridgeGPUSource` naming the drop-on-full design choice + alternatives explicitly. The existing `### Overflow policies (0.6.12)` section gains a cross-link blockquote. Lands tasks #2 (release-artifact policy doc note in lieu of back-tagging missing GitHub releases), #3, #4, #6 from the audit-response task list. Wire-equivalent; documentation only. |
| 0.9.38 | ✅ shipped | Audit-response maintenance & operational status patch — new `## Maintenance & operational status` README section between Prior art and Acknowledgments, addressing the audit's bus-factor concern head-on. Five subsections: **Bus factor** (named openly as 1; no organization backing); **Scope discipline** (six bulleted non-goals: synthesis engine / scheduling layer / audio-graph / auto-detection / general IPC / WebGPU framework, with cross-links to alternatives); **Hand-off readiness** (six artifacts that make forking survivable: header comments, 22 test suites, concurrent SPSC stress, cross-engine CI, bench budget, zero deps, MIT); **What "abandoned" actually looks like** (honest failure-mode walkthrough — npm/Zenodo versions keep working, browser matrix drifts first, CVE-class bugs are the real risk); **Contributing** (test-pin / wire-compat-note / bench-gate / versioning-policy bar for landing changes). Title-page Status & maturity bullet shrinks to a one-liner pointing at the new section. Lands task #10 from the audit-response task list. Wire-equivalent; documentation only. |
| 0.9.39 | ✅ shipped | Audit-response Standard mode (`MessageChannelBridge<S>`) design note — new `docs/standard-mode-design.md` (~500 lines) covering the audit's "ship Standard mode" recommendation as **design analysis, not implementation**. Walks the decision space across three independent axes (API shape: full parity vs transport-only vs separate-name adapter; versioning slot: retro-fill 0.8.0 vs 0.10.0 vs 0.9.x patch — note recommends 0.10.0; MVP scope: minimal vs control-plane-complete vs full transport parity) with pro/con tables, LOC + effort estimates, decision criteria, and explicit ship / don't-ship next-steps playbooks. **Recommendation**: shape (b) transport-only parity at MVP1 scope, versioned as 0.10.0. Existing ROADMAP "Reserved slot — 0.8.0" subsection rewritten with a status callout linking the new doc. README's transport-tier section updated to link the design note. Lands task #11 from the audit-response task list. Wire-equivalent; documentation only. |
| 0.9.40 | ✅ shipped | **Standard mode shipped** — `MessageChannelBridge<S>` lands as MVP1 (shape (b) transport-only parity from the 0.9.39 design note). New `src/MessageChannelBridge.ts` (~390 LOC) implements the `MessageChannel` + transferable-`ArrayBuffer` sibling to `Bridge<S>`: schema-driven `push` / `pull` / `scratchFrame` / `describeLayout`, static `allocate(capacity) → { port1, port2, capacity }` factory, drop-oldest overflow hard-coded for MVP1, schemas with `.withInvariant(...)` rejected at construction with `TypeError`. New `tests/MessageChannelBridge.test.ts` (9 pins, ~360 LOC): construction validation, allocate factory, scratchFrame shape, describeLayout symmetry with `Bridge<S>`, all-scalar round-trip bit-exact (every FieldKind), array-field round-trip bit-exact, capacity respect under burst (drop-oldest keeps freshest), empty-pull semantics + available() accuracy, close() lifecycle. 23 Node test suites green (was 22). The design note's 0.10.0 recommendation was over-cautious — a new additive class with no wire-format change and no breaking-API change is CLAUDE.md's "patch by default" category. README §Two transport tiers rewritten as "both shipped"; new §Standard mode quick start; browser support matrix Standard row flipped from "reserved" to "shipped"; decision-table row for no-COOP/COEP environments now points TO this library instead of recommending users wait. ROADMAP reserved-slot section retitled as "shipped at 0.9.40". `docs/standard-mode-design.md` status updated with a shipped-note postscript. Lands the implementation half of task #11 (task #13 captures the implementation work specifically). Wire-equivalent; purely additive public-API. |
| 0.9.41 | ✅ shipped | **Hybrid residual-on-carrier pattern** — new `BridgeBlockConsumer.processAdd(out, gain?, count?)` additive sibling of `process()`. Sums `gain * sample[i]` into `out[i]` instead of overwriting, enabling the hybrid pattern: AudioWorklet generates a cheap CPU carrier (sawtooth at slider-controlled fundamental, sub-quantum latency by construction) into `out`, then folds the GPU-computed residual (harmonic partials, granular layer — anything that benefits from GPU parallelism) on top. Perceptual latency is the carrier's (~2.7 ms @ 128 samples), not the block-mode mapAsync floor (~85 ms at D=4, B=1024). Strictly more glitch-tolerant than `process`: when the ring runs dry mid-call, `processAdd` leaves the unfilled tail UNTOUCHED — the caller's carrier survives the GPU outage. New `examples/hybrid-residual/` (CPU sawtooth + GPU 16-partial residual + stall toggle UI). New `bench/hybrid-residual/` (programmable stall sequence + RMS continuity ratio measurement: ~95-100% hybrid vs ~0% replace). 8 new test pins (`tests/BridgeBlockConsumer.test.ts` #14-#21) covering ramp continuity, gain scaling, hybrid underflow preservation, mid-quantum underflow, telemetry parity, gain=0 cursor advance, bounds/finiteness, and process/processAdd cursor interop. Per-quantum hot-path cost: process replace 100 ns / processAdd g=1 300 ns / processAdd g≠1 300 ns (~0.0075% of 2.67 ms quantum budget at 48 kHz). Wire-equivalent; additive public-API. |
| 0.9.42 | ✅ shipped | Hybrid residual-on-carrier comparison + gap analysis — new `docs/hybrid-residual-comparison.md` (~700 lines) covering the 0.9.41 pattern's comparative claim ("marked upgrade vs alternative GPU-accelerated browser audio approaches") and a 15-item gap roadmap. **Six alternatives characterized**: pure CPU AudioWorklet, GPU compute → AudioBufferSourceNode, pure GPU block mode (our pre-0.9.41), Faust / Emscripten WASM DSP, Tone.js + custom GPU side channel, OfflineAudioContext + GPU pre-render. Each scored across 7 axes (interactive latency / spectral richness / glitch tolerance / browser deployment / implementation cost / polyphonic capability / maturity). **Three distinctive claims for hybrid**: (1) perceptual CPU/GPU split (not technical) using psychoacoustic asymmetry between pitch and spectral envelope perception; (2) strict glitch-tolerance superiority via additive composition (carrier survives GPU stalls — proven via bench/hybrid-residual's continuity ratio ~95-100% vs ~0% replace); (3) one-method-call composition (3-line worklet change, no new class/schema/protocol). **Quantitative comparison** table with measured per-quantum cost (200 ns hybrid-mode tax = 0.0075% of budget), stall-window RMS ratio, latency-floor matrix across all 7 approaches. **15-item gap analysis** (stereo, polyphony, sample-accurate carrier params via BridgeInputLane, sample-accurate residual gain envelope, crossfade-on-stall, predictive carrier, 3-tier hybrid, stall-aware quality degradation, latency-compensated sync, multi-resolution residual, comparator bench harness, subscribe-to-underflow, envelope-follows-carrier, cross-browser stall continuity, long-tail latency under load) each with cost/complexity/dependency estimates. Closes with three high-leverage gaps recommended to address first (comparator bench / stereo / sample-accurate carrier params). README §Hybrid residual mode gains a link to the new doc. Lands task #14 from the in-flight audit-response task list. Wire-equivalent; documentation only. |
| 0.9.43 | ✅ shipped | `LLM_BUNDLE.md` regeneration script + bundle refresh to 0.9.42 — closes the hand-maintained-bundle drift problem permanently. Previously the file was a checked-in concatenation that had silently drifted to 0.6.4 / 2026-05-26 (seven patches plus the entire audit-response cohort behind). New `scripts/regenerate-llm-bundle.mjs` (~240 LOC, zero deps) assembles the bundle on demand from canonical sources: full inline for headline docs + public-API source files; header-only extract for the seven extracted machinery files (SpscRing / FrameSmoother / ConsumerClockRecovery / AdaptiveFlowController / BridgeConsumer / BridgeProducer / BridgeWebNNSource — whose protocol-math headers are sufficient context); recent-only filter for CHANGELOG (0.9.36+; full history stays in the repo). Wired into `package.json` as `npm run llm-bundle`. `LLM_BUNDLE.md` is now a `.gitignore`d build artifact (regenerate locally after `git pull`). First run produces a 12,360-line / 641 KB bundle reflecting all surfaces shipped through 0.9.42 — Standard mode, hybrid residual pattern, both design notes, bus-factor disclaimer, decision table, WebGPU-Baseline browser matrix. README §Status & maturity gains a final bullet pointing LLM auditors at the bundle + the generator. CLAUDE.md §What lives where gains three new file inventory entries (`docs/standard-mode-design.md`, `docs/hybrid-residual-comparison.md`, `LLM_BUNDLE.md`). Lands task #12 from the audit-response task list. Wire-equivalent; new dev tooling + documentation only. |
| 0.9.44 | ✅ shipped | **Frontier "King-track" cohort** — the wire-equivalent half of the 10/10 roadmap. Three additive public modules: `predictiveExtrapolateInto` (`src/predictiveExtrapolation.ts`, confidence-bounded forward extrapolation past the newest frame, clamped/blended-to-hold as PLL uncertainty grows); `TimelineRecorder`/`TimelinePlayer` (`src/TimelineRecorder.ts`, deterministic schema-tagged record + bit-identical faster-than-real-time offline bounce); `emitWorkletReader` (`src/emitWorkletReader.ts`, schema→zero-import monomorphized `DataView` reader source string). Two correctness artifacts: `formal/SpscRing.tla` (TLA+/PlusCal model, invariants `NoTornRead`/`NoOverwrite`/`WakeLiveness`, signed-wrap `Int32` counters) + `docs/spsc-happens-before-proof.md` (lane-by-lane written proof grounded at `SpscRing.ts` line refs). Four new test suites (predict pins 81–89, timeline, codegen, interleaving fuzzer enumerating 48k+ states) — 27 Node suites green. Two design-only specs held for maintainer sign-off (touch the public generic surface): phantom-typed `Bridge<S,Role>` RT-safety lattice + one-call `connect()` topology. Wire-equivalent; purely additive public-API. |
| 0.9.45 | ✅ shipped | **`Bridge<S,Role>` RT-safety lattice** (frontier track ship 2/2). Phantom `Role` parameter on the canonical `Bridge` (option c — the maintainer overrode the spec's hedged option b since the breaking-arity concern is moot at zero users; stays a `0.9.x` patch, not `0.10.0`). On the `"worklet"` brand the audio-thread-illegal methods are **structurally absent** (compile error): `waitForData` / `waitForSpace` (`Atomics.wait` — `TypeError` on main thread / render-quantum stall in `process()`) and `subscribeTelemetry` (`setInterval`, absent in the worklet scope). Allocating Axis-2 helpers (`scratchFrame` / `telemetry`) stay present. Built as `BridgeImpl<S>` + a conditional `type Bridge` alias + a retyped `const` constructor so the methods are genuinely absent (not `never`); required phantom `unique symbol` brand makes the roles nominally distinct. New root exports `forWorklet` / `forWorker` + `BridgeRole` / `DefaultRole`. Brand is zero-runtime-cost. New `tests/Bridge.roles.test.ts` (runtime pins 90–94 + `@ts-expect-error` type-level pins). Source-compatible (`DefaultRole = "worker"` keeps `Bridge<S>` unchanged); wire-equivalent. 28 Node suites green. |

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

## Standard mode (`MessageChannelBridge<S>`) — shipped at 0.9.40

> **Status (2026-05-28):** shipped as **patch 0.9.40**, MVP1 scope
> (transport-only parity). The design note at
> [`docs/standard-mode-design.md`](./docs/standard-mode-design.md)
> originally recommended a 0.10.0 minor bump; the maintainer overrode
> that recommendation on the basis that a new additive public class
> with no wire-format change and no breaking-API change is squarely
> in CLAUDE.md's "patch by default" category. The 0.10.0
> recommendation was over-cautious. Shipping as 0.9.40 keeps the 0.9.x
> soak cohort intact and treats Standard mode as one more
> additive-API improvement among the patches accumulating toward 1.0.

Standard mode is the **Turbo sibling** for environments where
cross-origin isolation can't be deployed. Same schema DSL, same
`Bridge`-style frame API surface (`push` / `pull` / `scratchFrame` /
`describeLayout`), transport swapped from `SharedArrayBuffer` +
`Atomics` to `MessageChannel` + transferable `ArrayBuffer`.
Measured round-trip latency floor 5–50 ms. Right for prototyping
before COOP/COEP is configured, control-plane updates in unisolated
embeds, telemetry channels, anything non-audio-critical. **Not for
audio rate.**

MVP1 deliberately excludes `pullLatest`, overflow `policy` options,
PLL clock recovery, frame smoothing, invariant classification, and
adaptive flow-scale — all reserved for MVP2+ work if real demand
surfaces. Schemas built with `.withInvariant(...)` are rejected at
construction with a `TypeError`. See the design note for the
exclusion rationale and the full MVP1 / MVP2 / Full transport parity
scope-cut analysis.

## Beyond the cohort (speculative, `0.9.32+`)

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
