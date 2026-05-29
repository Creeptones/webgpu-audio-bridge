# Underflow telemetry + quality-degradation hook — handoff note (0.9.51)

**Status**: **✅ shipped (0.9.51).** Implemented per this spec, **Option 1**
(derive the controller signal from the existing `flow_scale` lane — zero new
wire). What shipped: `BridgeBlockConsumer` telemetry getters (`underflowRate`,
`lastSuccessfulPullTime`, `elapsedSeconds`) + `sampleRate`/`underflowWindowMs`
constructor opts; the standalone `ResidualQualityController` + `ResidualQualityHint`;
pins in `tests/BridgeBlockConsumer.test.ts` (30–33) + new
`tests/ResidualQualityController.test.ts` (9 pins); and
`bench/graceful-degradation.bench.ts` (Node sim, `npm run bench:graceful-degradation`)
as the §8-table evidence — controller on ≈0% underflow vs off ≈21%, `effectiveN`
16→~13 (transient floor ~10) and recovering. No new SAB header lane; patch bump.
The browser demo (§7) was **not** built — the Node sim covers the quantitative
claim verifiably; a runnable browser `examples/adaptive-residual/` remains the
documented follow-up. Gaps #8 + #12 marked ✅ in `hybrid-residual-comparison.md`.
**Author**: maintainer + Claude (2026-05-29 handoff; shipped same day).
**Scope**: `src/` public-API additions (telemetry getters + a producer-side quality
hint) + an example + a bench + docs. **Target: patch bump `0.9.50 → 0.9.51`** —
which is only achievable if we do **NOT** add a new SAB header lane (see §3, the
load-bearing decision). 
**Closes**: **Gap #12** ("Subscribe-to-underflow callback") and **Gap #8**
("Stall-aware quality degradation — reverse `flow_scale`") from
[`hybrid-residual-comparison.md`](./hybrid-residual-comparison.md), now unblocked:
Gap #8's stated dependency ("hybrid residual becomes stereo and measurable") is
satisfied — stereo shipped 0.9.48, the comparator bench shipped 0.9.50.

---

## 1. The one-paragraph ask

Once hybrid residual is stereo (0.9.48) and measurable (0.9.50), the next win is
**graceful degradation**: under sustained GPU underflow the residual should
*thin before it glitches*. Two halves:

1. **Consumer-side underflow telemetry** (observability): keep the existing
   `underflowSamples()` / `framesConsumed()`, add `underflowRate(windowMs)` and
   `lastSuccessfulPullTime()`. **No `setInterval` inside the worklet** — the role
   lattice already treats timers + blocking calls as non-worklet-safe, so any
   *subscription* lives worker-side and the worklet side is **polling getters only**.
2. **Producer-side quality hint**: a `ResidualQualityHint = { underflowRate,
   suggestedQualityScale }` the GPU worker reads to voluntarily reduce harmonic
   count / residual block complexity / workgroup count / oversampling / (later)
   neural-inference size. `suggestedQualityScale: 1.0` = normal, `0.5` = simplified.

The degradation story: **the sound thins before it glitches.**

---

## 2. What already exists (investigation findings — cite these, don't re-derive)

### 2.1 `BridgeBlockConsumer` telemetry surface (`src/BridgeBlockConsumer.ts`)

Role-agnostic class; runs **inside** the AudioWorklet `process()`. Current public
telemetry (all `(): number`, all heap-side counters, no SAB, no allocation):

- `framesConsumed()` — successful ring pulls since construction / last `reset()`.
- `underflowSamples()` — cumulative per-channel-window samples written via the
  underflow path (zero-fill for `process()`; left-untouched-but-still-counted for
  `processAdd` / `processAddChannel` / `processAddStereo`).
- `remainingInFrame()` — samples left in the checked-out frame.
- `reset()` — discards the in-flight frame + cursor and **zeros both counters**.

Private state: `_underflowSamples`, `_framesConsumed`, `cursor`, `hasFrame`,
`holdSample`. The four consumption methods (`process`, `processAdd`,
`processAddChannel`, `processAddStereo` → shared `_mixWindow`) each do
`bridge.pull(this.frame)` and, on failure, `this._underflowSamples += remaining`
then bail; on success `this._framesConsumed++`. **The new instrumentation must
hook every one of these paths** (factor a `_recordPull()` / `_advance(count)`
helper, or add the two lines at each pull-success + each method tail).

### 2.2 The role lattice (`src/Bridge.ts` ~1649–1732, `tests/Bridge.roles.test.ts`)

A phantom-type brand (`declare const ROLE_BRAND: unique symbol`) gives
`Bridge<S, "worklet">` vs `Bridge<S, "worker">`. The worklet type is
`Omit<BridgeImpl<S>, "waitForData" | "waitForSpace" | "subscribeTelemetry">` —
i.e. the three **non-worklet-safe** methods are *structurally absent* from the
worklet handle. `subscribeTelemetry` is excluded **because it uses `setInterval`**
(`src/Bridge.ts` ~1503–1523: `setInterval(() => cb(this.telemetry()), 1000/hz)`),
and `setInterval` does not exist in `AudioWorkletGlobalScope`. `tests/Bridge.roles.test.ts`
pins this with `@ts-expect-error` on `worklet.subscribeTelemetry(...)` so
`npm run typecheck` fails if the timer API ever leaks onto the worklet surface.

**Implication for this feature**: `BridgeBlockConsumer` is role-agnostic and lives
in the worklet, so its new methods must be **pure polling getters** — no timer, no
`Atomics.wait`. Any *subscription* (the "subscribe-to-underflow" half of Gap #12)
must be expressed as `bridge.subscribeTelemetry` on a **worker-role** bridge, OR
as a poll the worker runs against a snapshot. Do not add a worklet-side subscribe.

### 2.3 Existing telemetry snapshot + subscription

`Bridge.telemetry(): TelemetrySnapshot` (`src/Bridge.ts` ~1416) is a frozen
21-field read (worklet-safe): includes `flowScale`, `available`, `capacity`,
`droppedFrames`, `lastEmptyWaitNs`, `maxOccupancyEverSeen`, … `BridgeConsumer`
mirrors it. `subscribeTelemetry(cb, { hzCap })` (worker-only, timer-based) is the
existing subscription pattern — **reuse its shape**, don't reinvent. The new
consumer fields could be surfaced either by extending `TelemetrySnapshot` (a
return-type change — see §5 versioning) or by a dedicated
`BridgeBlockConsumer.snapshot()` that the worker polls.

### 2.4 Worklet time sources

Inside `AudioWorkletGlobalScope`: `currentTime` (seconds, playback clock, advances
in 128-sample quanta), `sampleRate` (global), `currentFrame`. **`performance.now()`
is NOT reliably exposed** (confirmed empirically in the 0.9.50 comparator capture —
it was absent in Chrome 148's worklet scope, which forced the path-A cap onto a
main-thread proxy). So `lastSuccessfulPullTime()` must NOT depend on
`performance.now()`. Use the consumer's own emitted-sample count ÷ `sampleRate`
(an exact, monotonic, worklet-safe audio-domain clock) — see §4.

---

## 3. ⭐ The load-bearing decision: NO new SAB header lane (keep it a patch)

`src/SpscRing.ts` (header ~50–73, lane constants ~257–264) defines **8 Int32
header lanes, ALL active**:

```
lane 0 write_index   lane 1 read_index   lane 2 flow_scale (Q16.16, 0.5..2.0)
lane 3 torn_frame    lane 4 PLL off lo    lane 5 PLL off hi
lane 6 PLL drift     lane 7 PLL status
```

There are **zero free header lanes**. Per CLAUDE.md, **adding a 9th lane is a
wire-format change → a *minor* bump (`0.10.0`), not a patch.** Each prior lane
addition (flow_scale @0.5.0, torn_frame @0.6.0, PLL @0.6.16) took a minor bump.

Therefore, to ship as **0.9.51 (patch)** the producer-side quality hint must be
carried **without touching the Bridge wire format**. Three options, ranked:

- **Option 1 — derive the hint producer-side from the already-published
  `flow_scale` (RECOMMENDED for the first ship; zero new wire).**
  `flow_scale` already IS the consumer→producer backpressure channel:
  `AdaptiveFlowController` (`src/AdaptiveFlowController.ts`) runs a PI controller
  on ring occupancy (`err = occupancy − 0.5`, `Kp=0.5`, `Ki=0.05`, clamp
  `[0.5,2.0]`) and publishes to lane 2 every successful pull; the producer reads
  `bridge.flowScaleHint()` (`src/Bridge.ts` ~1379, `SpscRing` ~1633:
  `(Atomics.load(indices, FLOW_SCALE_LANE) | 0) / 65536`). When the consumer is
  **starved** (ring near-empty / underflowing), occupancy → 0, `err → −0.5`, and
  `flow_scale` saturates **toward 2.0 ("speed up")**. A producer can legitimately
  honor "speed up" by **simplifying** (cheaper blocks compute faster) rather than
  ticking faster. So: `suggestedQualityScale = map(sustained flowScaleHint)`,
  derived entirely from existing published state. **No new lane, no consumer wire
  change → patch-safe.** Caveat: the hint's `underflowRate` is then an *inferred*
  proxy (from `flow_scale` saturation), not the consumer's true measured rate.

- **Option 2 — a dedicated quality back-channel SAB, separate from the Bridge
  header (patch-safe, more faithful; the natural follow-up).**
  Mirror the `BridgeInputLane` pattern (the comparator/hybrid demos already run a
  *second* SAB for the reverse direction). A tiny 1–2-lane SAB carries the
  consumer's **true** `underflowRate` (Q16.16): the worklet `Atomics.store`s it
  each report (worklet-safe — exactly what `flow_scale` already does), the worker
  `Atomics.load`s it. This does **not** change the Bridge protocol's byte layout,
  so it stays a patch. More plumbing than Option 1, but the producer acts on the
  consumer's real measured underflow instead of an occupancy proxy.

- **Option 3 — a 9th Bridge header lane (DEFERRED; minor bump, NOT 0.9.51).**
  Cleanest integration (the hint rides the same SAB as everything else), but it is
  a wire-format change. Park it for a future `0.10.0` "wire-format cohort" if
  Options 1/2 prove insufficient. **Do not do this under the 0.9.51 banner.**

**Recommendation**: ship **Option 1** as 0.9.51 (smallest, patch-safe, fully
demonstrates the "thins before it glitches" story via the existing `flow_scale`),
and write the README/handoff so **Option 2** is the documented next step if the
inferred `underflowRate` proves too coarse. Flag Option 3 as a `0.10.0` candidate.

---

## 4. Proposed API

### 4.1 Consumer-side (worklet, polling getters) — `BridgeBlockConsumer<S>`

```ts
// New constructor option — the worklet has `sampleRate` in scope and passes it.
new BridgeBlockConsumer(bridge, {
  underflowPolicy: "zero-fill",
  sampleRate,                 // NEW (optional): enables ms-based windows/times.
  underflowWindowMs: 1000,    // NEW (optional): max history retained (default 1000).
});

// Existing (unchanged): underflowSamples(), framesConsumed(), remainingInFrame(), reset()

// NEW — all pure heap-side polling getters, allocation-free, worklet-safe:

/** Fraction in [0,1] of per-channel window samples written via the underflow
 *  path over the last `windowMs`. Backed by a fixed-size circular history of
 *  per-call (cumulativeSamples, cumulativeUnderflow) marks stamped each
 *  process()/processAdd* call — NO timer; the cadence is the audio quantum.
 *  Requires `sampleRate` at construction (else throws / falls back to
 *  globalThis.sampleRate if present). windowMs is clamped to underflowWindowMs. */
underflowRate(windowMs: number): number;

/** The consumer's audio-domain time, in SECONDS, of the most recent successful
 *  ring pull: cumulativeSamplesEmittedAtThatPull / sampleRate. Monotonic from
 *  construction/reset; resets to 0 on reset(); NOT wall-clock (the worklet has
 *  no reliable wall clock — see §2.4). Pair with `elapsedSeconds()` to get
 *  staleness = now − lastSuccessfulPullTime. */
lastSuccessfulPullTime(): number;

/** Optional convenience: the consumer's audio-domain "now" (cumulative emitted
 *  samples / sampleRate). `elapsedSeconds() − lastSuccessfulPullTime()` is the
 *  stall age, the value Gap #5's crossfade-on-stall would also want. */
elapsedSeconds(): number;
```

Implementation sketch (allocation-free, worklet-safe):
- Track `_samplesEmitted` (advance by `count` at the tail of every consumption
  method, in the **same per-channel-window unit** `underflowSamples()` uses).
- On every successful `bridge.pull`, set `_lastPullAtSample = _samplesEmitted + written`.
- Stamp a circular history of `(samplesEmitted, underflowSamples)` marks once per
  `process*()` call (preallocate two `Float64Array`s sized for
  `underflowWindowMs * sampleRate/1000 / minQuantum`, e.g. a few hundred slots).
  `underflowRate(windowMs)` scans back to the mark `≥ windowMs` ago and returns
  `Δunderflow / Δsamples` (0 if `Δsamples === 0`).
- `reset()` zeros all the new state too.

### 4.2 Producer-side (worker) — quality hint

```ts
export type ResidualQualityHint = {
  /** [0,1]. Option 1: inferred from sustained flow_scale saturation.
   *  Option 2: the consumer's true measured rate from the back-channel SAB. */
  underflowRate: number;
  /** 1.0 = full quality; 0.5 = simplified residual. Producer maps this to its
   *  own knobs (harmonic count, workgroup count, oversampling, …). */
  suggestedQualityScale: number;
};

// Option 1 home: a helper on the producer side that reads existing published
// state. Either a method on BridgeBlockProducer, or a small standalone
// controller class (preferred — testable in isolation, mirrors
// AdaptiveFlowController):

class ResidualQualityController {
  constructor(opts?: {
    highWatermark?: number;   // flow_scale above this (sustained) → degrade. default ~1.6
    lowWatermark?: number;    // flow_scale below this (sustained) → recover.  default ~1.15
    minScale?: number;        // floor for suggestedQualityScale. default 0.5
    rampPerTick?: number;     // max change per tick (hysteresis/anti-flap). default ~0.05
  });
  /** Feed the current flow_scale (Option 1) or measured underflowRate (Option 2)
   *  each producer tick; returns the smoothed hint. Hysteresis + bounded ramp
   *  prevent the "timbre breathing" you'd get from reacting per-block. */
  tick(signal: number): ResidualQualityHint;
}
```

**Hysteresis is mandatory**, not optional polish: a raw per-block reaction makes
the timbre pump audibly. Mirror `AdaptiveFlowController`'s discipline — high/low
watermarks (deadband) + a bounded per-tick ramp so quality glides between 1.0 and
0.5 over ~100–300 ms rather than snapping. This is the difference between "thins
gracefully" and "chatters."

### 4.3 How the producer responds (the example)

The GPU worker (`examples/hybrid-residual/worker.js` or a new
`examples/adaptive-residual/`) calls `controller.tick(bridge.flowScaleHint())`
each tick and maps `suggestedQualityScale` to its concrete lever — for the
existing residual kernel that is **`nPartials`** (already a uniform; the comparator's
`worker.gpu.js` even has a `setPartials` message):
`effectiveN = Math.max(2, Math.round(nPartials * suggestedQualityScale))`.
Document the other levers (workgroup count, oversampling, texture res, neural
inference size) as future knobs the same hint drives.

---

## 5. Versioning + wire-compat (the patch gate)

- **Patch `0.9.50 → 0.9.51`** is correct **iff**: (a) no new SAB header lane
  (§3 — use Option 1 or 2), and (b) no breaking public-API change.
- Additive surface = patch-safe: new `BridgeBlockConsumer` getters, the optional
  `sampleRate`/`underflowWindowMs` constructor opts, the new
  `ResidualQualityController` + `ResidualQualityHint` export.
- **Watch the one return-type trap**: if you surface the new consumer fields by
  *adding fields to `TelemetrySnapshot`*, that is arguably a return-type change.
  Safer: a separate `BridgeBlockConsumer.snapshot()` object, or just the discrete
  getters. Keep `TelemetrySnapshot` frozen as-is unless you deliberately decide a
  field addition is non-breaking (additive readonly fields usually are, but
  decide consciously and note it in the CHANGELOG).
- If a session concludes the inferred-rate (Option 1) is too coarse and wants the
  back-channel SAB (Option 2), that is **still a patch** (separate SAB, not the
  Bridge header). Only Option 3 (9th lane) forces a minor bump — and if you reach
  for it, **stop and ship as `0.10.0`**, updating the lane table + the
  wire-format-cohort notes.

---

## 6. Tests / gates (CLAUDE.md mandatory before the bump)

```
npm run typecheck   # tsc --noEmit, clean (incl. role-lattice @ts-expect-error pins)
npm test            # all suites green
npm run bench       # push/pull/pullLatest median within ~1.20 µs baseline
```

New pins (append, numbered, with header comments — existing style):

- **`tests/BridgeBlockConsumer.test.ts`**: drive a bridge with a scripted pull /
  starve pattern and assert:
  - `underflowRate(windowMs)` ≈ known fraction over a synthetic window (and 0
    when no underflow, and clamps at `underflowWindowMs`).
  - `lastSuccessfulPullTime()` advances on a successful pull, *stalls* across an
    underflow run, and `elapsedSeconds() − lastSuccessfulPullTime()` grows by the
    expected sample count ÷ sampleRate.
  - `reset()` zeros the new state.
  - works identically across `process` / `processAdd` / `processAddStereo`
    (instrument-every-path regression guard).
- **New `tests/ResidualQualityController.test.ts`** (mirror
  `AdaptiveFlowController`'s test shape): feed a flow_scale ramp and assert the
  hint degrades past the high watermark, recovers past the low watermark, honors
  `minScale`, and never moves more than `rampPerTick` per call (hysteresis pin).
- **Role-lattice guard**: confirm the new consumer getters need NO timer (they're
  on the role-agnostic `BridgeBlockConsumer`, so no `Bridge` lattice change) and
  that no `setInterval` is introduced anywhere in `src/` (grep guard in the test
  header, or rely on the existing `Bridge.roles` `@ts-expect-error` pins staying
  intact).

The `Bridge.properties` / `Bridge.observability` suites are the known
timing/float-sensitive ones — re-run once if they flake under load; treat as real
only if reproducible in isolation.

---

## 7. Demo + bench (show "thins before it glitches")

- **Example**: extend `examples/hybrid-residual/` (or new
  `examples/adaptive-residual/`) — a "GPU load" slider induces sustained producer
  slowdown; without the controller the residual zero-fills/underflows (audible
  thinning + the `underflowSamples` counter climbs); with the controller on, the
  worker drops `nPartials` via the hint and underflow clears — the timbre thins
  but never glitches. Surface `underflowRate` + `suggestedQualityScale` live.
- **Bench**: a small page (or extend `bench/audio-pipeline-comparator/`) that
  ramps GPU load and plots `underflowRate` vs `suggestedQualityScale` vs
  `underflowSamples` — showing the controller keeps measured underflow near zero
  by trading partial count. This is the quantitative "graceful degradation"
  evidence, the analogue of what the comparator did for the hybrid claim.

---

## 8. Predicted shape (sanity targets)

| Condition | flow_scale | suggestedQualityScale | effective nPartials | underflowRate |
|---|---|---|---|---|
| GPU keeping up | ~1.0 | 1.0 | full (e.g. 16) | ~0 |
| GPU mildly behind | ~1.4 | ~0.8 | ~13 | small, falling |
| GPU badly behind | →2.0 (sat) | →0.5 (floor) | ~8 | clamps near 0 once degraded |
| Recovered | back to ~1.0 | ramps back to 1.0 | back to full | ~0 |

The controller should make `underflowRate` *transient* — it spikes, the quality
drops, the spike clears. Large sustained `underflowRate` *with* the controller
active = the GPU can't sustain even the minimum-quality residual (legitimately
report it; that's the floor, not a bug).

---

## 9. Scope decisions + open questions for the implementer

1. **Option 1 vs 2 for the first ship.** Recommend Option 1 (derive from
   `flow_scale`, zero new wire). Only reach for Option 2 (back-channel SAB) if a
   spike test shows the occupancy-derived proxy lags the true underflow too much
   to drive smooth degradation. **Never Option 3 under 0.9.51.**
2. **Where the producer hint lives.** Prefer a standalone
   `ResidualQualityController` class (testable in isolation, mirrors
   `AdaptiveFlowController`) over a method buried on `BridgeBlockProducer`.
3. **`sampleRate` plumbing.** Pass it via the constructor opt (the worklet has it
   in scope). Decide the fallback when omitted: read `globalThis.sampleRate` if
   present, else make `underflowRate`/`lastSuccessfulPullTime` throw a clear
   "construct with { sampleRate } to use ms-based telemetry" error rather than
   returning NaN.
4. **History sizing.** The circular history for `underflowRate` must be
   preallocated (no per-call allocation on the audio thread). Size it for
   `underflowWindowMs`; document the cap and clamp `windowMs` to it.
5. **Subscription stays worker-side.** Do not add a worklet subscribe. If a
   "subscribe-to-underflow" callback is wanted, express it as the worker polling
   `consumer.snapshot()` / diffing `bridge.subscribeTelemetry` snapshots — same as
   the Bridge Inspector pattern. The role lattice will reject a worklet timer at
   typecheck; keep it that way.
6. **Don't break `TelemetrySnapshot`.** Surface new consumer fields via discrete
   getters or a separate `snapshot()`, not by mutating the frozen 21-field
   `TelemetrySnapshot` return type unless you consciously rule the addition
   non-breaking (and say so in the CHANGELOG).

---

## 10. Reuse map (do not reinvent)

| Need | Reuse from |
|------|-----------|
| Consumer→producer backpressure channel | `flow_scale` lane 2 + `Bridge.flowScaleHint()` (`src/Bridge.ts` ~1379) |
| PI controller w/ anti-windup + clamps (template for the quality controller) | `src/AdaptiveFlowController.ts` (`tick`, `Kp/Ki`, `FLOW_SCALE_INT_LIMIT`, Q16.16 encode) |
| Worklet-safe time (no `performance.now`) | `currentTime`/`sampleRate` + the comparator's `frameCounter/sampleRate` idiom (`bench/audio-pipeline-comparator/worklet.cpu.js`) |
| Reverse-direction SAB channel (Option 2) | `BridgeInputLane` + the comparator/hybrid input-lane SAB plumbing |
| Producer lever already present | `nPartials` uniform + `{type:"setPartials"}` in `bench/audio-pipeline-comparator/worker.gpu.js` and `examples/hybrid-residual/worker.js` |
| Telemetry snapshot + subscription shape | `Bridge.telemetry()` / `subscribeTelemetry()` (`src/Bridge.ts` ~1416–1523) |
| Underflow counters to build on | `BridgeBlockConsumer.underflowSamples()` / `framesConsumed()` / `reset()` |
| Stall age (composes with Gap #5 crossfade-on-stall) | the new `elapsedSeconds() − lastSuccessfulPullTime()` |

---

## 11. CHANGELOG / docs checklist (at ship)

- `CHANGELOG.md` `[0.9.51]` block: `### Added` (telemetry getters + quality
  controller + example/bench), `### Why` (graceful degradation: thins before it
  glitches), `### Wire compatibility` (**state plainly: zero — derived from the
  existing `flow_scale` lane / a separate back-channel SAB; NO new header lane**),
  `### Tests`, `### Documentation`.
- Mark **Gap #8** and **Gap #12** ✅ shipped (0.9.51) in
  `hybrid-residual-comparison.md` (mirror the Gap #1/#3/#11 "✅ shipped" formatting),
  and note the no-new-lane decision so the Gap #8 "new lane → minor bump" caveat
  is resolved on the record.
- README: a "Graceful degradation" subsection under the Hybrid section + the new
  example/bench run lines.
- This note → mark shipped.
```
