# Changelog

All notable changes to this project will be documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning policy (post-0.6.0)**: future improvements default to **patch bumps** (`0.6.x`) rather than minor bumps. Many additional improvements are planned before 1.0; we want the version number to reflect actual maturity, not feature count. Minor bumps (`0.7.0` etc.) are reserved for wire-format changes, breaking public-API changes, or batched-patch promotion. The 0.7.x cohort (and every subsequent minor) is expected to go deep — `0.7.0 → 0.7.99` is the planned patch envelope before `0.8.0` is considered. See [`CLAUDE.md`](./CLAUDE.md) for the full policy.

## [0.7.4] — 2026-05-27

### Added — Hermite cubic reconstruction (Track 1 of the King roadmap)

Two-frame C¹-continuous cubic Hermite interpolation as a new
consumer-side reconstruction strategy alongside the existing
single-frame Taylor extrapolation. The reconstructed signal has
no first-derivative step at frame boundaries, so the 60 Hz
"zipper" harmonics the Taylor path leaves on slowly-varying
envelopes drop into the noise floor.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`evaluateHermiteTrajectoryInto(flatPrev, flatCurr, spec, t, segmentSeconds, out)`**
  — new pure function in `src/trajectory.ts` alongside
  `evaluateTrajectoryInto`. Standard cubic Hermite basis on
  local parameter `t ∈ [0, 1]`:
  ```
  h00(t) =  2t³ − 3t² + 1
  h10(t) =       t³ − 2t² + t
  h01(t) = −2t³ + 3t²
  h11(t) =       t³ − t²
  p(t)   = h00·P0 + h10·M0 + h01·P1 + h11·M1
  ```
  where (P0, P1) are positions at the two endpoints and
  (M0, M1) are velocities scaled by `segmentSeconds` to act
  as local-`t` tangents. Allocation-free; the six basis
  coefficients are resolved once per call and the inner loop
  is six multiplies + three adds per sample. f64 and f32
  overloads. Requires `spec.order >= 2`; throws on order=1
  (no endpoint velocities available). Acceleration is ignored
  on the cubic path — a quintic Hermite variant that consumes
  (p, v, a) at both endpoints is a future patch.

- **`Bridge.evaluateHermiteInto(prevFrame, currFrame, t, segmentSeconds, outFrame)`**
  — new public method on `Bridge<S>`. Walks every field of
  the schema like `evaluateInto` does, but routes trajectory
  fields through the Hermite evaluator. Non-trajectory arrays
  and scalars pass through from `currFrame` (the latest
  state). Heap-only; no SAB access; no internal state.

- **`TrajectoryArrayOptions.interpolationMode`** — new optional
  field on `f{32,64}TrajectoryArray(n, opts)`. Accepts
  `'taylor'` (default; bit-exact equal to 0.7.3 behavior) or
  `'hermite'`. Pure schema metadata — the SAB bytes are
  identical for both modes, so a producer that tags
  `interpolationMode: 'hermite'` interoperates byte-for-byte
  with a 0.7.3 consumer using `evaluateInto`. Validated at
  schema construction; `'hermite'` requires `order >= 2`.

- **`TrajectoryInterpolationMode`** type — `'taylor' | 'hermite'`,
  exported alongside the existing `TrajectoryOverflowFallback`.

### Added — `require:` condition on the package `exports` field

Small enabler surfaced during the Phase C wavefunction-twin
migration: `tsx` running in CJS mode (the website's default
test-runner context) couldn't resolve `webgpu-audio-bridge`
because the `exports` field only had `import` and `types`
conditions. Adding `"require": "./dist/index.js"` lets Node
22+'s `--experimental-require-module` path consume the same
ESM dist file from a CJS host. No behavior change for ESM
consumers.

### Why

Hermite is the highest-payoff-per-unit-risk patch in the
King roadmap's five tracks: lowest-risk additive change with
the most audible win. The 60 Hz step-and-hold artifacts that
remain on the Taylor path are particularly audible on slow
envelopes (the same regime control signals run in — frequency
LFOs, parameter sweeps), and the Hermite path's sinc⁴-shaped
error envelope (vs Taylor's sinc²) dispatches them by 6-42 dB
at the 60 Hz harmonics in the standard phase-lock test setup.
The `require:` addition fell out naturally from getting the
website twin to actually consume the bridge — without it the
migration's parity test wouldn't run from the standard tsx
test runner.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout unchanged;
trajectory frames are byte-identical whether the consumer
runs Taylor or Hermite. A 0.7.3 producer interoperates
bit-for-bit with a 0.7.4 consumer that uses Hermite, and
vice-versa. The new `interpolationMode` field on
`TrajectoryArrayOptions` is optional with `'taylor'` default;
omitting it gives 0.7.3-identical behavior.

### Tests

- New `tests/Bridge.phaseLock.test.ts` pin
  (`hermite-vs-taylor-fft`) runs the same 60 Hz producer /
  48 kHz consumer / 16 384-sample FFT setup as the existing
  Taylor pin, then A/B's Taylor vs Hermite reconstruction
  bin-by-bin. Asserts Hermite is at least 6 dB quieter than
  Taylor at every harmonic of 60 Hz in the audible range
  (60, 120, 180, 240, 300, 360, 420, 480 Hz). Measured:
  Hermite suppresses each harmonic 6-42 dB below Taylor; the
  60 Hz fundamental drops to −84 dB below the signal bin
  (vs Taylor's −44 dB).
- Schema construction guard: `interpolationMode: 'hermite'`
  with `order: 1` throws at field construction with a clear
  error pointing at the missing endpoint velocities.
- Direct-evaluator guard: `evaluateHermiteTrajectoryInto`
  throws on `order < 1` and on non-finite `t` /
  `segmentSeconds`, mirroring the schema guard for
  bridge-bypassing callers.
- Existing 0.7.3 suites (Bridge, BridgeFacades, BridgeInputLane,
  schema, environment, Bridge.phaseLock Taylor pin, the two
  1 M-frame concurrent stress runs, Float64RingBuffer legacy
  suite) all green — purely additive change.

### Documentation

- `src/trajectory.ts` carries a new file-section header
  documenting the cubic-Hermite basis, the `segmentSeconds`
  tangent-scaling math, and the order-1 / order-3 boundary
  conditions. The existing Taylor section is unchanged.
- `src/Bridge.ts` `evaluateHermiteInto` docstring names the
  PLL-derived `segmentSeconds` as the natural time source
  (`(currStampNs − prevStampNs) * 1e-9`), pointing the
  reader at the existing PLL surface for clock recovery.
- README untouched in this patch — the headline README
  rewrite for "Track 1 Hermite reconstruction" lands in a
  follow-up alongside the website-twin demo cut (the user-
  visible "before vs after" listening test).

## [0.7.3] — 2026-05-27

### Added — observability hooks for downstream inspectors

Three small, wire-compatible additions that make the Bridge legible
to a downstream "Bridge Inspector" UI. All additive; no SAB byte
changes; no public-API breaks. Bench medians unchanged at ~1.20 μs.

**Patch 1 — `bridge.subscribeTelemetry(cb, opts?)`.** A live
observable stream over the existing `telemetry()` snapshot. Each
call to `subscribeTelemetry` installs its own `setInterval` at
`1000 / hzCap` ms invoking the listener with a fresh frozen
snapshot per tick. Returns an idempotent `Unsubscribe` handle that
stops the interval and removes the listener.

  ```ts
  const unsub = bridge.subscribeTelemetry((snap) => {
    if (snap.tornFrames !== lastTorn) flashChyron('tear');
    lastTorn = snap.tornFrames;
  }, { hzCap: 30 });
  // later in component teardown:
  unsub();
  ```

  - `hzCap` default `60` (≈ rAF cadence); clamped to `[1, 240]`.
    Non-finite values fall back to 60 then clamp.
  - Threading: `setInterval` is available in browser main thread,
    DedicatedWorker, SharedWorker, and Node. **Not** legal inside
    `AudioWorkletGlobalScope.process()` — inspector calls
    `subscribe` on the UI thread, not the audio thread.
  - No fan-out from a shared interval (each subscribe is its own
    interval; subscribers are cheap by design).
  - No automatic cleanup: Bridge has no `dispose()`. Subscription
    survives until the consumer calls the returned `Unsubscribe`
    or the surrounding execution context tears down.

**Patch 2 — telemetry() counters: `softFrames` + `stallRecoveries`.**
Two new fields on the `TelemetrySnapshot` return type. Both are
heap-side (per-instance, consumer-thread-only) — SAB header lanes
0-7 are all in use, and expanding `RING_HEADER_BYTES` would be a
wire-format change. For cross-process aggregation, post-message
the snapshot across at a sampled cadence (the `subscribeTelemetry`
subscription is the intended hook).

  - **`softFrames`** — cumulative count of soft-classified
    invariant deviations on this Bridge instance. Increments
    inside `_invariantHandleRaw` and `_invariantHandleSmoothed`
    when the classifier returns `kind: "soft"`. Disjoint from
    `tornFrames` (the existing hard-classification counter). Zero
    on schemas without `.withInvariant(...)`. Wraps mod 2^32 via
    the `| 0` idiom.
  - **`stallRecoveries`** — cumulative count of PLL outlier-gate
    transitions from "currently rejecting outliers" back to clean
    observation. One increment per recovery event (NOT per normal
    observation after recovery). Two transition paths counted:
    single-spike streak that ends with a clean observation, and
    sustained-step streak that exceeds `outlierConsecutiveLimit`
    and gets admitted. Disjoint from `pllOutliersRejected` (the
    existing per-observation reject counter) — that's edges-out,
    this is edges-back.

  Inspector pattern: subscribe to telemetry, diff successive
  snapshots' counters, render an event per delta (`softFrames`
  delta = soft classification fired; `tornFrames` delta = hard
  fallback fired; `stallRecoveries` delta = stall caught).

**Patch 3 — `BridgeGPUSource.inFlightCount()` + `lastReadbackUs()`.**
Two new introspection methods on the GPU-source helper:

  - **`inFlightCount()`** — naming-parity alias for the existing
    `inFlight()` (count of staging buffers in some non-idle state,
    typically 0 - `stagingBufferCount`). Both methods identical;
    the new name is the canonical public API for the in-page
    Bridge Inspector pattern that pairs with `subscribeTelemetry()`.
  - **`lastReadbackUs()`** — wall-time microseconds for the most
    recently completed mapAsync → decode → push cycle. Timestamped
    at `flushPending` start (`performance.now()`) and read at
    `pollCompleted` finish; the difference is the full cycle.
    Returns `0` before the first completion; fractional
    microseconds thereafter. Heap-only, consumer-thread.

  Inspector use case: render the GPU readback round-trip
  characteristic on-page. Typical Chrome on Windows: 5-15 ms
  (5000-15000 μs); driver- and adapter-dependent. Surfaces the
  `mapAsync` cost the README's "What's actually faster (and what
  isn't)" section discusses.

### Why

The downstream consumer is the **Wavefunction synth** at
`../NewProject/website` — the team is building a real-time
Bridge Inspector panel that visualises the library's novel
primitives (PLL recovery, trajectory smoothing, invariant
classifier, GPU staging ring). The primitives all exist; what
was missing was observation hooks. Without `subscribeTelemetry`
the inspector had to roll its own `setInterval(() =>
bridge.telemetry(), 16)`; without the new counters the soft
classifier was invisible (it's the most common invariant event
in practice — torn frames are rare); without GPU-source
introspection the staging-ring was opaque.

This patch is the surface upgrade that turns the bridge from a
working primitive into one that DevTools / inspector / dashboard
consumers can introspect at the cadence they need. The
disjoint-from-environment-report contract is preserved: ring
runtime vs platform environment.

### Wire compatibility

- **No SAB changes.** Bit-exact protocol with 0.7.2.
- **No public-API break.** Every existing method works
  unchanged. The `TelemetrySnapshot` interface extracted from the
  inline return type at `telemetry()` is structurally identical
  to the 0.7.2 inline shape PLUS two new heap-side numeric
  fields — additive widening.
- **Additive exports only.** New top-level types:
  `TelemetrySnapshot`, `TelemetryListener`, `TelemetryUnsubscribe`,
  `SubscribeTelemetryOptions`. New methods: `Bridge.subscribeTelemetry`,
  `BridgeGPUSource.inFlightCount`, `BridgeGPUSource.lastReadbackUs`.
  No removals; no renames.
- Bench medians unchanged at ~1.20 μs across push / pull /
  pullLatest. The counter increments live off the hot path
  (`_softFrames` increments only on invariant deviation —
  control-rate cadence; `stallRecoveries` increments only on
  PLL outlier-gate transitions — sub-Hz cadence; the GPU-source
  `performance.now()` capture lives at flush/poll boundaries,
  not the per-quantum pull hot path).

### Tests

`tests/Bridge.test.ts` gains 7 new pins (now 90 total):

- **#84 subscribeTelemetry cadence** — listener fires ≈ `hz` times
  per second; counted callbacks over 200ms at 60Hz must land
  within ±2 of expected.
- **#85 subscribeTelemetry snapshot shape** — listener receives a
  frozen object whose fields match `bridge.telemetry()` exactly,
  including the new 0.7.3 `softFrames` and `stallRecoveries`
  numeric fields.
- **#86 subscribeTelemetry unsubscribe** — calling the handle
  stops callbacks; double-call is a no-op.
- **#87 subscribeTelemetry hzCap clamping** — `hzCap = 0 / -5 /
  999 / NaN / Infinity` all produce working subscriptions
  without throwing.
- **#88 softFrames counter** — increments only on soft-classified
  pulls (mid-band invariant deviation), not on `ok` pulls or
  hard-fallback pulls. Verified via the same engineered-deviation
  technique as pin #37.
- **#89 stallRecoveries counter** — one increment per outlier-gate
  transition. Verified across both transition paths (single-spike
  → clean resumption + sustained-step → admission); subsequent
  clean observations after recovery do NOT re-increment.
- **#90 BridgeGPUSource introspection** — `inFlightCount()` ===
  `inFlight()`; `lastReadbackUs()` is 0 before the first cycle,
  > 0 after, and tracks the most recent cycle (not the first).
  Safe to call after `destroy()`.

All 9 tsx-script suites green; bench medians at 1.20 μs.

### Documentation

- `src/Bridge.ts`: full JSDoc on the new `TelemetrySnapshot` /
  `TelemetryListener` / `TelemetryUnsubscribe` /
  `SubscribeTelemetryOptions` types; method JSDoc on
  `subscribeTelemetry` documents cadence, threading, no-dispose
  contract, intended use case.
- `src/ConsumerClockRecovery.ts`: `stallRecoveries` getter
  carries the per-event vs per-observation distinction relative
  to `outliersRejected`.
- `src/BridgeGPUSource.ts`: `inFlightCount` documents the
  naming-parity alias; `lastReadbackUs` documents the
  flush→poll timing and typical numbers.
- `README.md`: telemetry-fields table gains `softFrames` and
  `stallRecoveries` rows; new §Live telemetry subscription
  subsection under §Observability dashboards; BridgeGPUSource
  diagnostics section gains the two new methods. Roadmap →
  Shipped gets a new 0.7.3 bullet above the 0.7.2 entry.

## [0.7.2] — 2026-05-27

### Hardened — drop-oldest is race-free by construction

The 0.6.12 `policy: 'drop-oldest'` shipped with a documented race
window: under multi-thread use, a consumer mid-pull on a slot the
producer's `_dropOldest` was simultaneously stealing could observe
torn payload bytes (the producer's new write overlapping the
consumer's read). The 0.6.12 mitigation was "pair drop-oldest with
`.withInvariant(...)`" — the invariant classifier surfaces the
torn read as a hard error and falls back to last-known-good. That
worked but pushed correctness onto the user.

**0.7.2 closes the race in the protocol itself.** The consumer's
`pull` / `pullLatest` paths under `policy === 'drop-oldest'` now
use a CAS-commit pattern (`_pullOverrunAware` /
`_pullLatestOverrunAware`):

1. Capture `R0 = Atomics.load(READ_IDX_LANE)` and
   `W = Atomics.load(WRITE_IDX_LANE)`. The plain index read used in
   the reject hot path becomes an `Atomics.load` because the
   producer is now also a writer of `read_index`.
2. Read the payload (scalars + arrays + invariant) into `out` from
   slot `R0 & mask`.
3. `Atomics.compareExchange(READ_IDX_LANE, R0, R0 + 1)` to commit
   the read (or `Atomics.compareExchange(READ_IDX_LANE, R0, W)` for
   `pullLatest`'s drain-to-newest variant). On CAS success → no one
   advanced `read_index` between our capture and our commit, so the
   bytes we read correspond to the slot we accounted for: return
   success. On CAS failure → the producer's `_dropOldest`
   overran us mid-read; discard the (potentially torn) `out` and
   retry the whole loop with fresh `R0` / `W`.

Bounded retries. Under SPSC, only the producer can advance
`read_index` other than us. Each producer advance is paired with a
slot eviction that opens space, so the loop terminates within
~`capacity` iterations even under adversarial racing.

`.withInvariant(...)` pairing is no longer required for correctness
under drop-oldest — the invariant lane remains useful for cross-IPC
bit-rot detection (separate concern; see §Cross-IPC bit-rot
detection), but the drop-oldest race itself no longer needs it as
a defense.

### Why

A correctness gate on the 1.0 readiness checklist: drop-oldest
should be safe by construction, not by user vigilance. The 0.6.12
documentation explicitly told users "pair with `.withInvariant(...)`
to detect + recover these via the existing torn-frame classifier"
— effectively an admission that drop-oldest alone was insufficient.
Closing the race in the consumer-side pull means a user picking
drop-oldest for "freshness wins" semantics gets exactly that, with
no protocol footgun.

Cost: the overrun-aware pull pays one extra Atomics op per call
vs the reject hot path (plain index read → `Atomics.load`; plain
`Atomics.store` → `compareExchange`). The dispatch is a single
boolean check on `this._needsOverrunAware` at the top of `pull` /
`pullLatest`; V8 constant-folds the branch per-instance, so the
reject / drop-newest / block fast paths are byte-identical to
0.7.1. Bench medians on the reject path stay at ~1.20 μs across
push / pull / pullLatest — verified by `npm run bench`.

### Wire compatibility

- **No SAB changes.** Bit-exact protocol with 0.7.1.
- **No public-API break.** Constructor signature unchanged;
  `policy: 'drop-oldest'` already shipped at 0.6.12.
- **No exported symbol changes.** The new behavior is purely a
  consumer-side hot-path swap that the construct-time boolean
  dispatches into.
- The shipped `_dropOldest` producer-side mechanic is unchanged
  (CAS-advance on full, bounded retry, heap drop counter); the
  patch only adds the matching consumer-side CAS-commit.

### Tests

Two new single-threaded pins in `tests/Bridge.test.ts` (now 83
pins total):

- **#82 drop-oldest CAS-commit pull — bit-exact equivalence with
  reject.** Two Bridges on independent SABs, same schema, same N
  pushes (N < capacity, no overflow → no race). Pulls from the
  drop-oldest bridge (now running `_pullOverrunAware`) and the
  reject bridge must produce bit-exact frames, equal sequence,
  equal telemetry. Guards against regression of the new code path
  on the no-race happy path.
- **#83 drop-oldest pullLatest with skipped > 0.** Fills the ring,
  pushes past capacity under drop-oldest so the producer evicts
  the original oldest frames; consumer's `pullLatest` then drains
  to newest in one CAS-commit step. Asserts newest seq bit-exact,
  `skipped` count reflects the in-ring older drain (not the
  producer-side drops, which are separately accounted), and
  telemetry counters update correctly.

One new cross-thread sub-suite in `tests/Bridge.concurrent.test.ts`:

- **`bridge-concurrent-drop-oldest-stress`** — 250k-frame stress
  under aggressive contention. A new inline-eval worker mirrors
  `SpscRing._dropOldest` (CAS-advance with bounded retry +
  capacity recheck). The main-thread consumer is deliberately
  throttled (`setImmediate` per pull chunk) so the ring saturates
  and the drop branch fires repeatedly. Typical run: ~250k pushed,
  ~9k consumed, ~241k dropped, ~600 producer-side CAS retries,
  ~3k consumer-observed seq gaps, ~85ms wall time. Pins:
    1. `consumed + dropped === pushed === 250_000` (no frame
       lost-track).
    2. Every consumed frame bit-exact against the producer recipe
       at its seq — the correctness pin for CAS-commit. Any torn
       read slipping through trips the bit-exact assertion
       immediately.
    3. `totalSkippedBySeq === producer.dropped` exactly (the
       consumer's observed seq gaps account for every producer
       eviction).
    4. `producer.dropped > 0` (the run actually exercised the
       race window — sanity that the throttle is working).
    5. `tornFrames === 0` on the no-invariant schema (CAS-commit
       caught every overrun; no need for the `.withInvariant`
       pathway).

All 9 tsx-script suites green; bench medians at 1.20 μs across
push / pull / pullLatest.

### Documentation

- `src/SpscRing.ts`:
    - `BackpressurePolicy.'drop-oldest'` JSDoc updated to reflect
      the closed race window — the "pair with `.withInvariant`"
      paragraph is replaced with the CAS-commit explanation.
    - `_dropOldest` private method JSDoc updated similarly.
    - New `_pullOverrunAware` and `_pullLatestOverrunAware`
      methods carry full JSDoc on the CAS-commit pattern,
      bounded-retry argument, and the correctness pin reference.
    - New `_needsOverrunAware` private field documented as a
      construct-time boolean cache, with the V8
      constant-folding rationale.
- `README.md`:
    - §Overflow policies (0.6.12) gains a 0.7.2 callout noting
      drop-oldest is now race-free without `.withInvariant`; the
      invariant pairing is now framed as useful for cross-IPC
      bit-rot detection only (separate concern).
    - Roadmap → Shipped gets a new 0.7.2 bullet above the 0.7.1
      entry.

## [0.7.1] — 2026-05-26

### Added — `getEnvironmentReport()` core

The 0.7.x onboarding cohort's first additive API: a synchronous,
side-effect-free reflection of `globalThis` that answers "can this
page run Turbo mode, Standard mode, or neither?" and emits a frozen
list of actionable fixes for whatever is missing. The function
lives in a new file `src/environment.ts` and is exported from
`src/index.ts` under a new `// ── Environment diagnostics (0.7.1) ──`
section header.

Shape (top-level, frozen):

- `crossOriginIsolated`, `sharedArrayBuffer`, `atomics`,
  `atomicsWaitAsync`, `audioWorklet`, `audioContext`, `webgpu`,
  `webMidi`, `userActivation`, `secureContext` — boolean feature
  flags, one per detected capability.
- `suggestedMode: 'turbo' | 'standard' | 'unsupported'` — derived
  deterministically: `turbo` iff `crossOriginIsolated && SAB &&
  Atomics && audioWorklet`; `standard` iff `audioWorklet && !SAB`;
  `unsupported` iff `!audioWorklet`.
- `estimatedLatencyFloorMs: { input, output, total }` — static
  lookup keyed on `suggestedMode`. Numbers seeded from the README
  §Honest input → audible breakdown (~1.3 ms quantum-boundary,
  ~5-8 ms output buffer + DAC). Standard-mode `input` bumps to
  10 ms to model the MessageChannel hop. Informational, never
  measured.
- `fixes: ReadonlyArray<EnvironmentFix>` — frozen array of frozen
  `{ id, severity: 'blocker' | 'degraded' | 'info', summary,
  docUrl }` objects. Stable `id` for overlay/CLI keying;
  `summary` is human-readable; `docUrl` is a README anchor or
  external spec link. Severity rules: `blocker` reserved for
  truly-no-transport states; `degraded` for "Turbo unavailable,
  Standard works"; `info` for non-blocking environmental notes.
- `userAgent` — raw `navigator.userAgent` string, captured for
  bug-report copy/paste only. Never parsed; no browser sniffing.

Hard constraints honored in the implementation:

- **Pure reflection.** `typeof globalThis.X`, `'X' in
  Constructor.prototype`, `nav?.gpu?.requestAdapter`. Never calls
  `navigator.requestMIDIAccess()` (prompt), never instantiates
  `new AudioContext()` (resource), never `fetch`es, never sniffs
  the UA string.
- **Frozen, JSON-serializable.** `Object.isFrozen(report) ===
  true`, `Object.isFrozen(report.fixes) === true`, and every
  nested fix + the `estimatedLatencyFloorMs` object are also
  frozen. `JSON.parse(JSON.stringify(report))` round-trips
  cleanly — the 0.7.4 dev-CLI HTTP probe and 0.7.2 overlay
  widget can transport it as plain JSON.
- **No platform sniffing.** Feature detection only; no UA
  regex; `userAgent` field exists for human triage, not branch
  control.
- **Disjoint from `Bridge<S>.telemetry()`.** No field-name
  overlap; no method on either returns the other. Ring runtime
  vs platform environment — different questions, different
  lifetimes. Architectural decision #5 from the cohort plan,
  enforced by file layout (a separate module under
  `src/environment.ts` with no Bridge dependency) and by review.

### Why

The 0.7.0 framing pivot reframed the library's surface as Turbo
mode (the canonical primary path) + Standard mode (the explicit
second tier coming in 0.8.x). The new framing is only useful if
the library can tell a user **which tier they're in right now,
and what to fix to get to a better one**. `getEnvironmentReport()`
is the foundation API that the next four onboarding-cohort
patches build on:

- 0.7.2 — `mountEnvironmentOverlay()` vanilla DOM widget renders
  the report inline on the page.
- 0.7.3 — the shared CLI server core uses it to inject a
  probe response.
- 0.7.4 — the `npx webgpu-audio-bridge dev` CLI prints it in the
  terminal.
- 0.7.8 — the golden-matrix test patches `globalThis` per
  browser-support-matrix cell and asserts the emitted
  `fixes[]` content stays actionable.

The patch is deliberately scoped down to "just the API" — the
overlay, CLI, and golden-matrix tests are separate patches in
the cohort, each with their own gate. This keeps each release
boundary small and reviewable.

### Wire compatibility

- **No SAB changes.** Bit-exact protocol with 0.7.0.
- **No public-API break.** Every `Bridge<S>` / `BridgeProducer`
  / `BridgeConsumer` / `BridgeInputLane` / `BridgeGPUSource`
  method works unchanged. `Bridge.telemetry()` is unchanged.
- **Additive exports only.** New top-level exports:
  `getEnvironmentReport`, `EnvironmentReport`,
  `EnvironmentFix`, `EstimatedLatencyFloorMs`. No removals,
  no renames.
- Bench medians unchanged at ~1.30 μs — the new function is
  off any hot path (it's intended to be called once on page
  load, never per quantum).

### Tests

New file `tests/environment.test.ts` adds a 12-pin standalone
tsx-script suite (no test framework, mirrors the
`tests/BridgeInputLane.test.ts` style):

1. Vanilla / bare-globalThis shape → `unsupported`.
2. Each prerequisite-present cell flips its matching field
   (SAB / Atomics / Atomics.waitAsync / AudioContext +
   audioWorklet on prototype / crossOriginIsolated /
   isSecureContext / navigator.gpu / navigator.requestMIDIAccess
   / navigator.userActivation).
3. All four Turbo prerequisites present → `'turbo'`, latency
   floor `{ 1.3, 6, 7.3 }`.
4. `audioWorklet` true + SAB false → `'standard'`, latency
   floor `{ 10, 6, 16 }`.
5. `audioWorklet` false short-circuits to `'unsupported'` with
   a single `missing-audio-worklet` blocker fix (no other
   fixes muddy the message).
6. Every fix has a non-empty summary and a parseable docUrl.
7. Frozen-object invariant: report, fixes array, every fix,
   and the latency-floor sub-object all `Object.isFrozen`.
8. Every fix severity ∈ `{'blocker', 'degraded', 'info'}`.
9. Static latency-floor lookups distinct per mode and ordered
   `turbo < standard`, `unsupported === 0`.
10. JSON round-trip: `JSON.parse(JSON.stringify(report))`
    preserves every field shape.
11. Pure reflection: installing a throwing
    `navigator.requestMIDIAccess` and a throwing
    `AudioContext` constructor proves neither is invoked.
12. `enable-coop-coep` fix severity downgrade — `'degraded'`
    in Standard mode, absent altogether when
    `crossOriginIsolated === true`.

Added to both `npm test` and `npm run test:unit` script
chains in `package.json`. The full suite (now 9 tsx-script
suites including the existing 8) runs green; bench unchanged
at ~1.30 μs medians.

### Documentation

- `src/environment.ts` module header documents the disjoint
  contract with `Bridge.telemetry()`, the "feature detection
  only — no UA sniffing, no side effects" stance, and the
  JSDoc on every exported interface field.
- `src/index.ts` gets a new `// ── Environment diagnostics
  (0.7.1) ──` section header with a 6-line preamble.
- `README.md`'s Roadmap → Shipped gets a new `0.7.1` bullet
  above the existing `0.7.0` entry.
- Public README integration (overlay-rendered report, CLI
  usage examples, browser-support-matrix-as-derived-from-fixes
  table) is deferred to 0.7.2 / 0.7.4 / 0.7.8 respectively —
  each patch lands its own README surface so the consumer-facing
  story stays coherent with the shipped surface.

## [0.7.0] — 2026-05-26

### Reframed — Turbo mode / Standard mode (the framing pivot)

The library acquires a two-tier transport framing. **Turbo mode**
(`Bridge<S>` + SAB + Atomics) is the canonical primary path — the
entire 0.6.x feature surface lives there. **Standard mode**
(`MessageChannelBridge<S>`, 0.8.x) is a deliberate explicit
second tier with documented worse latency (5-50 ms typical)
sharing the same schema DSL.

Concrete edits in this release:

- New §Two transport tiers subsection under §The problem this
  solves, introducing the framing and pre-announcing
  `MessageChannelBridge<S>` for 0.8.x.
- New top-level §Browser support matrix table immediately
  after §The macro/micro pattern. Columns: Chrome / Firefox /
  Safari / iOS Safari. Rows: `crossOriginIsolated`, SAB,
  `Atomics.wait`, `Atomics.waitAsync`, AudioWorklet, WebGPU,
  WebMIDI, Turbo mode, Standard mode. Honest cell-level
  caveats footnoted.
- §Setting up SAB renames to §Enabling Turbo mode. Same
  COOP/COEP recipe, but the prose reframes the headers as
  "one-time setup for the fast tier" rather than "deployment
  restriction." Adds forward-references to the 0.7.1+ dev CLI
  and 0.7.5+ deployment recipes.
- §What this is, and what it isn't gains an uncompromising
  preamble paragraph: **"This is, and remains, an SAB-first
  library. The library will never auto-detect the user's
  environment and silently pick a transport for them."** Triple
  anchored alongside the §Two transport tiers framing and the
  forthcoming §FAQ entry.
- `package.json` description rewrites from "Schema-driven
  lock-free SPSC SharedArrayBuffer ring..." to "Schema-driven
  control-rate-to-audio-rate bridge for the browser. Turbo
  mode (SAB + Atomics, sub-microsecond) and Standard mode
  (MessageChannel, 5-50ms — 0.8.x) share one schema DSL and
  one frame API." The SAB ring is now described as the
  *implementation* of Turbo mode, not the headline claim.
- `CITATION.cff` title updates to match. The library name
  `webgpu-audio-bridge` is unchanged; the Zenodo concept DOI
  is unchanged. A new version DOI for 0.7.0 will mint at
  Zenodo deposit time.

### Why

The library is technically inside the frontier on the SAB path
— what remains for 1.0 is **adoption friction**, not feature
gaps. A reader who sees "Schema-driven lock-free SPSC
SharedArrayBuffer ring..." evaluates "this requires special
hosting" in 8 seconds and bounces. The reframing converts
that into "this library has a Turbo mode and a Standard
mode" — a feature comparison the reader engages with rather
than a deal-breaker they reject.

Critically the SAB-first stance is unchanged. The reframing
is honest: Turbo mode is what the library is for; Standard
mode is the explicit second tier for prototyping,
unisolated embeds, and control-plane updates where 5-50 ms
latency is genuinely acceptable. The library will never
auto-detect and silently fall back — that contract is
documented in three places (§Two transport tiers,
§What this is and what it isn't, forthcoming §FAQ in
0.7.9).

0.7.0 is the first release in the **onboarding cohort**
(paths 2, 3, 4, 8 from the strategic roadmap). 0.7.x will
go deep: dev CLI (0.7.1+), environment diagnostics
(0.7.1-0.7.2), deployment recipes for 8+ hosts (0.7.5),
FAQ + Troubleshooting (0.7.9), recipe round-trip
verification against real deployments (0.7.10). The cohort
gate at 0.7.12 will reassess 1.0 readiness with the
deliverables visible.

### Wire compatibility

- **No SAB changes.** Bit-exact protocol with 0.6.19.
- **No public-API change.** Every `Bridge<S>` /
  `BridgeProducer` / `BridgeConsumer` / `BridgeInputLane` /
  `BridgeGPUSource` method works unchanged.
- **No exported symbol additions or removals.**
- The minor bump (`0.6.19 → 0.7.0`) is purely a coherent
  release moment — the third CLAUDE.md minor-bump trigger
  ("deliberate batched-patch promotion"). The README's
  top-level voice + the package elevator pitch + the
  citation title all shift in lockstep; that's the public
  face of the library changing shape, which is the
  promotion criterion.

### Tests

No new tests. The framing pivot is pure prose. All 8
existing suites green; bench medians unchanged at 1.20 μs.

### Documentation

- `README.md`: new §Two transport tiers subsection (under
  §The problem this solves), new top-level §Browser support
  matrix table, §Setting up SAB → §Enabling Turbo mode
  rename + rewrite, §What this is and what it isn't preamble
  paragraph. ~250 LOC of README diff.
- `package.json`: `description` field rewritten.
- `CITATION.cff`: `title` field rewritten; `version` bumped
  to 0.7.0; `date-released` updated; new version DOI
  placeholder added.

## [0.6.19] — 2026-05-26

### Added — `BridgeInputLane<S>` + fast-lane pattern

A new consumer-side facade for the **input lane** pattern that reaches
pro-audio tracking latency (~3–6 ms input-to-audible on tuned hardware)
by carving gestural input off the GPU macro path.

```ts
import { SpscRing, BridgeInputLane } from "webgpu-audio-bridge";

// Main thread (producer side):
const ring = new SpscRing(sab, capacity, InputEventSchema);
const lane = new BridgeInputLane(ring);
const ev   = lane.scratchFrame();
midiInput.onmidimessage = (e) => {
  ev.tInputNs   = BigInt(Math.floor(performance.now() * 1e6));
  ev.eventType  = e.data[0] >> 4;
  ev.noteOrCc   = e.data[1];
  ev.velocityI  = e.data[2];
  ev.value      = e.data[2] / 127;
  lane.push(ev);                   // ~1 µs synchronous SAB write
};

// AudioWorklet (consumer side):
const lane = new BridgeInputLane(ring);
const eventBuf = lane.scratchEventBuffer(32);
process(_inputs, outputs) {
  const count = lane.pullAll(eventBuf);
  for (let i = 0; i < count; i++) applyEvent(eventBuf[i]);
  // ... per-sample synth ...
  return true;
}
```

The facade exposes both sides of the ring on one class (mirroring
`Bridge<S>`):

- **Producer side** — `push`, `beginPush` / `commitPush` / `abortPush`,
  `scratchFrame`, `flowScaleHint`.
- **Consumer side** — `pullAll(eventBuf, maxCount?) → number`,
  `scratchEventBuffer(n)`. Drains every unread frame in FIFO order
  into the caller's pre-allocated buffer; frames beyond
  `eventBuf.length` or `maxCount` stay in the ring for the next call.

A new `examples/fast-lane/` end-to-end demo shows the full architecture:
- A slow macro envelope worker (CPU stub of the GPU path; ~60 Hz).
- An input lane fed by computer keyboard, on-screen keys, and WebMIDI.
- An AudioWorklet that pulls macro state via `pullLatest`, drains
  events via the inlined SAB protocol equivalent of `pullAll`, places
  events at their sub-sample offset, and synthesizes a polyphonic
  saw + 1-pole LPF voice graph.

Run with `npm run dev:fast-lane` (http://localhost:5174).

### Why

`BridgeGPUSource` (0.6.18) makes the GPU → AudioWorklet path
deliverable at typical web-audio latency (~15–25 ms). The remaining
gap — pro-audio tracking latency (<5 ms) — is **not** solvable on the
GPU path even with future WebGPU spec evolution (the audio output
buffer alone is 5–8 ms; the audio quantum boundary is another 0–3 ms).

The fast-lane pattern solves it architecturally instead: recognize
that there are TWO kinds of information feeding the synth — slow
macro state (15–30 ms latency is fine) and discrete gestural input
(<5 ms target) — and route them through TWO bridges. The macro path
is unchanged from `BridgeGPUSource`'s contract; the input path runs
~1 µs main-thread → SAB → next-quantum worklet, leaving only the
output buffer (5–8 ms, or 3–5 ms with `latencyHint: 'interactive'`)
and the quantum boundary as the floor.

Naming `BridgeInputLane` and shipping a worked example makes the
pattern citable. Without it, every project ends up rediscovering the
"two SABs, drain-everything `pullAll` on one of them" trick.

### Wire compatibility

- **No SAB changes.** `BridgeInputLane` is a thin facade over the
  existing `SpscRing<S>` SAB protocol. A `BridgeInputLane` peer
  interoperates bit-for-bit with `Bridge<S>` / `BridgeProducer` /
  `BridgeConsumer` peers over the same SAB.
- **No public-API break.** One new class export
  (`BridgeInputLane`) from `src/index.ts`. The four existing
  facade exports and `Bridge<S>` itself are unchanged.
- **Bench unchanged.** The facade is not on the existing bench
  path (`push` / `pull` / `pullLatest` medians stay at 1.20 μs).
  `pullAll` is a `ring.pull` loop, so each consumed frame
  contributes the same ~1 μs cost as a standalone `pull`.

### Tests

One new test file `tests/BridgeInputLane.test.ts` with 9 pins:

1. **Construction + scratch shapes.** Lane surfaces ring / schema /
   capacity; `scratchFrame` produces typed initialized fields;
   `scratchEventBuffer(n)` returns `n` distinct frame views.
2. **Empty pullAll** returns 0 and leaves the buffer untouched.
3. **Single push** drains 1; `available()` agrees pre/post; bigint
   fields exact, f32 within epsilon.
4. **N pushes** drain in FIFO order; second pullAll returns 0.
5. **pullAll respects `eventBuf.length` cap** — overflow stays in
   the ring and surfaces on the next call.
6. **pullAll respects explicit `maxCount` cap** independent of
   buffer length; maxCount=0 is a no-op; maxCount > buf.length
   clamps to buf.length.
7. **Cross-facade interop** — a `BridgeProducer` peer pushes,
   `BridgeInputLane.pullAll` drains; reverse direction
   `BridgeInputLane.push` → `BridgeConsumer.pull` also works.
8. **scratchEventBuffer validation** — rejects non-positive /
   non-integer / NaN.
9. **pullAll validation** — rejects non-array; sparse-slot
   undefined slot throws on first reach.

The test is added to `npm test` and `npm run test:unit`. Run as
`npx tsx tests/BridgeInputLane.test.ts`. All 8 suites green;
bench medians unchanged.

### Documentation

- New `src/BridgeInputLane.ts` with a self-contained file header
  covering the pattern, the wire-compat contract, the API shape,
  and the notify-cost note.
- `src/index.ts` widens the export surface by one class
  (`BridgeInputLane`).
- `README.md` gains a new top-level §Achieving pro-audio tracking
  latency section with the dual-bridge architecture diagram, the
  per-stage latency table, the canonical InputSchema shapes,
  the sub-sample event placement code, and a use-case table.
  §See it running and §BridgeGPUSource gain short paragraphs
  pointing at the fast-lane demo and the new path.
- New `examples/fast-lane/` directory with `index.html` /
  `main.js` / `worker.js` / `worklet.js` / `schema.js` /
  `serve.mjs`. Mirrors the structure of `examples/minimal/` so
  the diff between the two demos is the architectural delta
  (one bridge → two bridges) and nothing else.

## [0.6.18] — 2026-05-26

### Added — `BridgeGPUSource` — the headline GPU readback helper

The named feature the library has been advertising since 0.3.0. Closes
the loop from "compute pass on the GPU writes a storage buffer" to
"AudioWorklet pulls the result via `Bridge<S>.pullLatest`" by automating
the boilerplate every WebGPU-audio project re-implements:

```ts
import { Bridge, BridgeGPUSource, physicsControlFrameSchema } from
  "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(1000);
const { sab, capacity } = Bridge.allocate(16, schema);
const bridge = new Bridge(sab, capacity, schema);

const source = new BridgeGPUSource(
  device,             // GPUDevice from navigator.gpu.requestAdapter().requestDevice()
  bridge,
  (mappedBytes, frame) => {
    // Decoder: read mapped staging-buffer bytes into the SAB-backed
    // frame view. Allocation-free; mutations land directly in the SAB.
    const view = new DataView(mappedBytes);
    frame.seq = view.getBigUint64(0, true);
    frame.tMacroNs = view.getBigUint64(8, true);
    frame.vMax = view.getFloat64(16, true);
    frame.jMax = view.getFloat64(24, true);
    frame.vEff.set(new Float64Array(mappedBytes, 32, 1000));
    frame.jEff.set(new Float64Array(mappedBytes, 32 + 8000, 1000));
  },
);

// Per control-rate tick:
const encoder = device.createCommandEncoder();
// ... encode the compute dispatch ...
source.scheduleReadback(myStorageBuffer, encoder);
device.queue.submit([encoder.finish()]);
source.flushPending();
source.pollCompleted();
```

The helper manages:

- **Staging-buffer ring** (default 3 buffers) sized to the schema's
  `frameByteSize`. Allows 2 readbacks in flight while a third is
  being decoded.
- **`copyBufferToBuffer` encoding** — `scheduleReadback` writes the
  copy command into the user's command encoder and reserves a free
  staging buffer.
- **`mapAsync` orchestration** — `flushPending` starts the async
  maps after the user's `device.queue.submit()`. A `.then` handler
  flips an internal flag so `pollCompleted` can synchronously
  check completion without blocking.
- **Decoder dispatch** — `pollCompleted` invokes the user-provided
  decoder against the mapped `ArrayBuffer` with a
  `BridgeProducer.beginPush()` slot as the output frame, so the
  decoder writes directly into the SAB. After the decoder returns,
  the helper calls `commitPush` and unmaps the staging buffer.
- **Back-pressure indicator** — `scheduleReadback` returns `false`
  when all staging buffers are in flight; the producer's pacing
  loop can use this to drop or delay the next dispatch.
- **Bridge-policy interaction** — if the bridge's push policy
  drops the frame (e.g. `'drop-newest'` with a full ring), the
  helper still unmaps the staging buffer and increments its
  internal `droppedCount` so dashboards pick up the loss.

The point of the staging-buffer ring is **breaking serialization,
not eliminating mapAsync**. Naive "submit, await mapAsync, push,
repeat" serializes the GPU and the readback — the next compute
pass waits for the previous readback to land, the producer thread
stalls, and the bridge runs empty under sustained load. With ≥ 3
staging buffers, two readbacks stay in flight while a third
decodes; the producer holds its dispatch cadence and the bridge
stays populated. **The `mapAsync` cost (5-15 ms, per
[Chromium 41487454](https://issues.chromium.org/issues/41487454)
and [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432))
is still paid per readback — it just stops being on the producer's
blocking path.**

Realistic latency impact:

  - Producer throughput: 60-125 Hz → 250-1000 Hz (5-10× improvement)
  - Producer thread blocking: ~8 ms/tick → <100 μs/tick
  - Per-frame readback latency: 5-15 ms (UNCHANGED — that's mapAsync)
  - Total input → audible: ~30-50 ms with stalls → ~15-25 ms reliably

This lands at typical web-audio latency (~15-25 ms) — sufficient
for ambient / pad / generative / WebXR / non-tracking DAW use
cases, marginal for fast percussion, **not pro-audio tracking
latency**. The 5-15 ms mapAsync floor is a hardware/driver limit;
breaking through it requires WebGPU spec evolution
(`mappedAtCreation` zero-copy readback, on the §Beyond 1.0
roadmap) that we don't control.

### Why

This is the named feature the library has been advertising since
0.3.0 — the wrapper that justifies the package name and the whole
"WebGPU compute → AudioWorklet" story. Every WebGPU-audio project
that hits the `mapAsync` latency wall ends up writing some version
of this code; shipping it as part of the bridge means the
canonical path is one import + one constructor + three lifecycle
calls per tick.

The original phased plan named this as 0.8.0 territory (a "wrapper
on top of the existing trajectory-schema + PLL machinery, not new
primitives"). Bringing it forward to 0.6.18 is deliberate: the
helper is the gateway feature that gets eyes on the rest of the
library. Without it, the bridge looks like "a clever SAB ring
abstraction"; with it, the bridge is "the working primitive for
WebGPU → AudioWorklet."

### Wire compatibility

- **No SAB changes.** The helper is heap-side over the existing
  `Bridge<S>.beginPush` / `commitPush` surface. A 0.6.17 peer and
  a 0.6.18 peer share a SAB transparently.
- **No public-API break.** The `BridgeGPUSource` class and its
  five type exports (`GpuBufferLike`, `GpuDeviceLike`,
  `GpuCommandEncoderLike`, `GpuReadbackDecoder`,
  `BridgeGPUSourceOptions`) are additive.
- **No `@webgpu/types` dependency.** The helper uses minimal
  structural interfaces (`GpuBufferLike`, `GpuDeviceLike`,
  `GpuCommandEncoderLike`) that the real WebGPU types satisfy
  structurally. Users on browsers (lib.dom.d.ts) or Node-with-
  WebGPU (`@webgpu/types`) pass real `GPUDevice` / `GPUBuffer` /
  `GPUCommandEncoder` directly without coercion. The bridge has
  no runtime WebGPU dependency.
- **Bench unchanged.** The helper is not on the bench path
  (`push` / `pull` / `pullLatest` medians stay at 1.20 μs).

### Tests

One new test pin (#81) in `tests/Bridge.test.ts`:

- **#81 — orchestration coverage.** A mock `GpuDevice` /
  `GpuCommandEncoder` / `GpuBuffer` that record + replay the call
  sequence without a real GPU. Verifies the full lifecycle:
  constructor builds N staging buffers; `scheduleReadback`
  encodes one `copyBufferToBuffer` per call and reserves a slot;
  back-pressure (`scheduleReadback` returns false when all in
  flight); `flushPending` starts `mapAsync` on each scheduled
  slot; `pollCompleted` waits for resolved promises, invokes the
  decoder against the mapped `ArrayBuffer`, calls `commitPush`,
  unmaps the staging buffer, returns the slot to idle. Counter
  increments (`pushedCount`, `droppedCount`) match the sequence.
  `destroy` releases all buffers. Constructor validates
  `stagingBufferCount ≥ 2` and `stagingBufferSize > 0`.

  The test is async (yields to microtasks to let the `.then`
  handlers fire before `pollCompleted`); `main()` is now
  `async function` and `await`s the helper test. The other 80
  pins remain synchronous.

All 7 suites green; bench medians unchanged at 1.20 μs.

### Documentation

- New `src/BridgeGPUSource.ts` with a self-contained file header
  covering the lifecycle, the overlap rationale, the structural
  WebGPU typing approach, and the per-method contract.
- `src/index.ts` widens the export surface by one class + five
  types.
- `README.md` §See it running / §The problem this solves gain
  short paragraphs pointing at `BridgeGPUSource` as the
  canonical path for the WebGPU → AudioWorklet integration; the
  full helper docs sit in the new §`BridgeGPUSource` section
  (alongside the existing trajectory + PLL sections).

## [0.6.17] — 2026-05-26

### Added — `forEachSampleInQuantum` batch evaluation API

`Bridge<S>` gains a single new method that wraps the canonical
"evaluate every sample of an audio quantum" pattern into one call:

```ts
bridge.forEachSampleInQuantum(evalFrame, sampleCount, (sampleIdx, frame) => {
  block[sampleIdx] = synth.step(frame.vEff);
});
```

Semantically equivalent to:

```ts
for (let i = 0; i < sampleCount; i++) {
  bridge.evaluateAtSampleOffset(evalFrame, i);
  callback(i, evalFrame);
}
```

but with the per-sample method-dispatch + cache-validity checks
hoisted out of the inner loop. The per-sample dt arithmetic is
inlined directly in the loop body, and all cached state is read
into locals once outside the loop. For a single-closure callback
(V8 monomorphic), the engine inline-caches the body so the
user-side per-sample cost approaches the raw `evaluateInto` time.

### Why

The README + Phase-Locked Extrapolation Plan named this as the
per-quantum batch API needed to "eliminate the per-sample call
overhead in the AudioWorklet's hot loop." The existing
`evaluateAtSampleOffset(out, i)` pattern is correct but pays a
per-sample method-dispatch + cache-validity check + cached-state
re-read tax. At 128 samples per quantum and a single
`Bridge<S>` per worklet, the overhead is a few percent — small but
real, and at the heart of the audio-rate path where every cycle
counts.

This patch ships the smaller, simpler scope from the roadmap's
"EvalMode dispatch + per-quantum batch API" pair: the batch API
only. EvalMode dispatch (step / alpha / trajectory / catmull) is
intentionally deferred — the catmull-rom case needs a K=4 history
ring with new invalidation rules and an interaction story with
`resetSmoother` / `resetEvalCache` that deserves its own focused
patch. The step / alpha / trajectory modes are already accessible
via the existing `pull` / `pullSmoothed` / `pullEvaluatedLatest`
surface; the API addition of `setEvalMode` is mostly ergonomics
and can wait until catmull-rom is ready to ship alongside it.

### Wire compatibility

- **No SAB changes.** `forEachSampleInQuantum` is heap-only on
  `Bridge<S>`. A 0.6.16 peer and a 0.6.17 peer share a SAB
  transparently.
- **No public-API break.** The new method is purely additive;
  existing `evaluateAtSampleOffset` calls continue to work
  unchanged. The two paths produce bit-identical output for the
  same inputs (verified by pin #80).
- **No bench-path change.** The bench's `push` / `pull` /
  `trajEval` cells don't exercise the per-quantum loop, so
  medians are unchanged at 1.20 μs / 1.10 μs.

### Tests

One new test pin (#80) in `tests/Bridge.test.ts`:

- **#80 — forEachSampleInQuantum batch eval.** Walks a 32-sample
  quantum on an order-2 trajectory schema; output values are
  bit-identical to a hand-rolled loop calling
  `evaluateAtSampleOffset(out, i)` per sample on the same schema
  + PLL state. Validates: throws when cachedEvalValid is false
  (must call `pullEvaluatedLatest` first); throws on negative /
  fractional / non-finite sampleCount; sampleCount = 0 no-ops
  cleanly (callback never invoked).

All 7 suites green; bench medians unchanged at 1.20 μs / 1.10 μs.

### Documentation

- `src/Bridge.ts` `forEachSampleInQuantum` carries a self-
  contained doc-comment covering semantic equivalence to the
  hand-rolled loop, the cost-model breakdown per iteration, the
  V8-monomorphic-friendly callback recommendation, and the
  validation contract.
- `README.md` §Per-frame evaluator (Pillar 3) gains a paragraph
  documenting the new batch API alongside the existing
  `evaluateAtSampleOffset` pattern; the canonical AudioWorklet
  example collapses by one indentation level using
  `forEachSampleInQuantum`.

## [0.6.16] — 2026-05-26

### Added — PLL lane 4-5 publication (Pillar 2 cross-process observability)

`Bridge<S>` now publishes the live PLL state to SAB header lanes 4-7 on
every `observeConsumerTime` and `resetPll`. A second worker / DevTools
panel constructing its own `Bridge` (or `SpscRing`) over the SAME SAB
can read the consumer's PLL state via the new `readPublishedPllState()`
method without IPC.

- **Lane layout (activates previously reserved 4-7).**
  - Lane 4-5: `offsetNs` as a signed Int64 (atomic 8-byte
    BigInt64-array store via aliased view). Range ±2^53 ns ≈ ±104
    days, well past any realistic clock offset.
  - Lane 6: `driftPpm` as Q16.16 signed Int32. Range ±32768 ppm,
    precision ≈ 1.5e-5 ppm.
  - Lane 7: status word. Bit 0 = `locked`; bits 1-31 reserved for
    future use (additional flags, generation counter, etc.).

- **Publisher contract.** `Bridge.observeConsumerTime` and
  `Bridge.resetPll` each end with a three-Atomics-store publication
  sequence. ~100 ns overhead per call, dominated by the Int64
  BigInt-bridge cost (BigInt allocation + Atomics.store). The flag
  `publishPllToSab` (in `BridgeOptions`) defaults to `true`; set to
  `false` to skip publication on hot paths where the cost matters
  more than cross-process visibility.

- **Reader contract.** `Bridge.readPublishedPllState()` returns
  `{ locked, offsetNs, driftPpm }`. Three atomic loads + one ppm
  decode. Allocation-free, safe to call from any thread (including
  AudioWorklets, though typically you'd just read your own heap
  state there).

- **Atomicity.** The offset Int64 is written and read atomically via
  the BigInt64 8-byte path — no torn-read window between the high
  and low 32-bit halves. The other two lanes (drift + status) are
  atomic individually. Cross-lane reads (offset vs drift vs status)
  are not mutually atomic — under live observer activity, the three
  fields are individually consistent but not necessarily from the
  same observe instant. Acceptable for the observability use case;
  point-in-time precision can be added via a generation counter in
  status lane bits 1-31 if a use case demands it.

### Why

The 0.6.2 PLL kept its state heap-only. The Phase-Locked Extrapolation
Plan flagged cross-process observability via the reserved header lanes
as a queued patch — useful when a second worker / DevTools extension
wants to graph the consumer's clock alignment without round-tripping
through postMessage. The wait-flag protocol's "do not ship" decision
(0.6.11) left lanes 4-7 reserved with no committed use; 0.6.16
activates 4-5 (plus 6 + 7) for PLL state, since the PLL state is the
most-asked-for cross-process diagnostic in the bridge.

The lane layout was designed in 0.6.16 explicitly to avoid conflict
with any future wait-flag protocol — the wait-flag protocol (if ever
revisited) would use a different lane or a higher bit of lane 7's
status word.

### Wire compatibility

- **Strictly additive.** Pre-0.6.16 peers never wrote to lanes 4-7
  and don't read from them. A 0.6.15 producer + 0.6.16 consumer
  share a SAB transparently: the consumer's `readPublishedPllState`
  reads the SAB-default zero state (`{ locked: false, offsetNs: 0,
  driftPpm: 0 }`), interpreted as "no published state yet" — which
  is correct since the legacy peer never published. The 0.6.16 peer
  can still publish its own state to its own SAB instance for any
  modern peer that watches.
- **No frame layout change.** Lanes 0-3 (write/read index, flow
  scale, torn counter) are byte-for-byte identical; the payload
  region at byte 32 is unchanged.
- **No public-API break.** `BridgeOptions` gains
  `publishPllToSab?: boolean` (default true); existing constructors
  continue to compile. `readPublishedPllState()` is additive on
  `Bridge<S>`.
- **Bench unchanged.** Push / pull / pullLatest medians stay at
  1.20 μs — publication only fires on `observeConsumerTime` /
  `resetPll`, which aren't on the bench's measured path.

### Tests

Two new test pins (#78–79) in `tests/Bridge.test.ts`:

- **#78 — cross-peer readability.** Two `Bridge` instances over the
  same SAB. Consumer-side observes, observer-side reads via
  `readPublishedPllState()`. Pre-observe: defaults (locked=false,
  offset=0). Post-observe: published state matches consumer's heap
  state within 1 ns (Math.round difference). Post-reset:
  defaults restored. `publishPllToSab: false` skips publication
  cleanly.
- **#79 — encoding + wire-compat.** Int64 offset round-trips across
  ±1 day of nanoseconds within 1 ns; Q16.16 drift round-trips
  ±100 ppm within 1e-4 ppm. Legacy SAB scenario (no peer ever
  published): reader sees the all-zero default and interprets it
  as "no published state" — confirming 0.6.15 → 0.6.16
  interoperability.

All 7 suites green; bench medians unchanged at 1.20 μs.

### Documentation

- `src/SpscRing.ts` header table updates to reflect lane 4-7 as
  PLL state (no longer "reserved"). The two new methods
  (`publishPllState`, `readPublishedPllState`) carry self-contained
  doc-comments explaining atomicity and encoding.
- `src/Bridge.ts` gains `readPublishedPllState()` on the public
  surface and a `publishPllToSab` flag on `BridgeOptions`.
- `README.md` §Phase-locked loop gains a paragraph documenting the
  cross-process observability use case + the new
  `readPublishedPllState()` method.

## [0.6.15] — 2026-05-26

### Added — PLL drift estimator (Pillar 2 second-order)

`ConsumerClockRecovery` gains an opt-in 2nd-order tracker that models
the offset as a linear function of consumer time:
`predicted_offset(t) = offsetNs + driftRate · (t − lastConsumerNs)`.
Switches the PI loop from 1st-order to a g-h alpha-beta filter when the
estimator is enabled.

- **Math.** Standard g-h shape:
  ```
  dt        = consumerNs − lastConsumerNs
  predicted = offset + driftRate · dt
  residual  = (producerNs − consumerNs) − predicted
  offset    = predicted + KP · residual         (α step, no PI integral)
  driftRate = driftRate + (driftGain / dt) · residual   (β step)
  ```
  The PI integral term is intentionally OFF in drift mode — the drift
  estimator IS the steady-state integrator at the 2nd-order level. A
  redundant integral would fight the drift estimator (both trying to
  absorb residual) and degrade convergence; keeping the integral term
  on lifts steady-state drift error from ~5 ppm to ~25+ ppm at
  default β. So drift-mode uses pure g-h; offset-only-mode keeps the
  pre-0.6.15 PI loop verbatim.

- **`phaseLockedTime(consumerNs)`** extrapolates using the current
  `(offset, driftRate, lastConsumerNs)` triple, so a quantum-rate
  AudioWorklet still gets sub-μs accurate offsets between
  observations.

- **Defaults.** `driftGain = 0.05` (g-h β) gives a ~20-observation
  time constant; at 60 Hz that's ~333 ms to track a fresh drift.
  Default β = 0.05 was chosen to balance noise rejection (lower β =
  smoother) against tracking latency (higher β = faster).

- **Opt-in.** The drift estimator is disabled by default
  (`enableDriftEstimator: false`). All pre-0.6.15 behavior is
  preserved bit-exact for any caller that doesn't explicitly opt in.
  Switch it on when producer and consumer live in different clock
  domains — the canonical case being a Worker stamping
  `performance.now()` and an AudioWorklet reading
  `AudioContext.currentTime` (which can drift relative to each other
  at tens of ppm).

- **Telemetry.** `Bridge.telemetry().pllDriftPpm` exposes the current
  drift estimate in parts-per-million. Reads 0 in offset-only mode.

### Why

Pillar 2's "first cut" landed in 0.6.2 as offset-only. The Phase-Locked
Extrapolation Plan explicitly called out drift estimation as the second-
order extension needed for production-grade tracking when producer and
consumer clocks have meaningfully different time sources. The 1st-order
PI loop can track a constant offset to sub-μs and absorbs short-term
drift via the KI integral, but it can't *predict* between observations
— `phaseLockedTime(t > lastObservation)` returns
`consumerNs + offsetNs` and that offset is the value at the LAST
observation, not at `consumerNs`. Over a multi-second window of
50 ppm drift, the prediction is off by 50 ppm × elapsed = tens of μs
to ms.

The g-h filter is the standard tool for this — same complexity as the
PI loop (one extra add and one extra multiply per observation),
asymptotically optimal for linear models, and well-understood
convergence properties via the α-β parameter pair.

Keeping it opt-in protects existing callers who measure
`pllOffsetNs` over multi-second windows and would be surprised to
see the offset state semantics shift to "offset at last observation"
when the estimator was off.

### Wire compatibility

- **No SAB changes.** The drift estimator is heap-only on
  `ConsumerClockRecovery`. A 0.6.14 peer and a 0.6.15 peer share a
  SAB transparently.
- **No public-API break.** The `ConsumerClockRecovery` constructor's
  opts bag gains two new fields (both with documented defaults);
  existing call sites continue to compile. `Bridge.telemetry()` adds
  one field; existing destructures keep working.
- **Bit-exact preservation when opt-out.** When
  `enableDriftEstimator` is `false` (default), the math path is
  identical to 0.6.14 — same residual computation, same PI integral,
  same offset update. The only added cost is one extra branch per
  observation (`if (this._enableDriftEstimator)`) which V8 inlines.
- **Lanes 4–7 still reserved** for the PLL publication patch
  (0.6.16) — the offsetNs + driftRate state will eventually publish
  to those lanes for cross-process observability.

### Tests

Three new test pins (#75–77) in `tests/Bridge.test.ts`:

- **#75 — default-off preserves 0.6.14.** Default-constructed PLL has
  `driftEstimatorEnabled === false` and `driftPpm === 0` even after
  feeding observations with 100 ppm drift. Bridge's built-in PLL is
  default-constructed → drift off.
- **#76 — converges on constant drift.** Opt in via
  `enableDriftEstimator: true`. Simulate 100 ppm constant drift over
  500 observations at 60 Hz with ±1 μs jitter; drift estimate
  converges to within 10 ppm (analytic 1-σ at default β = 0.05 is
  ~6 ppm). Offset stays within 1 ms of the moving truth (would walk
  off by ~tens of ms under offset-only).
- **#77 — phaseLockedTime extrapolation + validation.** With drift
  trained on 50 ppm truth, `phaseLockedTime(consumerNs + 100ms)`
  returns extrapolated value within 50 μs of the true offset at
  that future moment. Drift-enabled extrapolation strictly beats
  offset-only extrapolation in the same scenario. Construction
  validates `driftGain` (NaN / non-positive / Infinity rejected);
  `reset()` clears drift state but leaves the construction-time
  enable flag intact.

All 7 suites green; bench medians unchanged at 1.20 μs (PLL is not
on the bench's measured path).

### Documentation

- `src/ConsumerClockRecovery.ts` gains a self-contained "Drift
  estimator (0.6.15, opt-in)" section in the file header, covering
  the math, the integral-off rationale, the default tuning, and
  when to enable / when not to enable.
- `src/Bridge.ts` `telemetry()` annotates the new `pllDriftPpm`
  field with the "always 0 in offset-only mode" note.
- `README.md` §Phase-locked loop gains a paragraph documenting the
  drift estimator opt-in and the standard
  `Worker→performance.now()` vs `AudioWorklet→currentTime` case.

## [0.6.14] — 2026-05-26

### Added — PLL Mahalanobis outlier gate (Pillar 2 robustness)

`ConsumerClockRecovery` (the heap-side PLL `Bridge<S>` composes) gains a
default-on Mahalanobis-distance outlier gate that rejects single-frame
residual spikes — the canonical "30 ms mapAsync stall poisons the offset
estimate" scenario the README + Phase-Locked Extrapolation Plan flagged.

- **EWMA scale estimator.** Each post-warmup observation updates a
  running σ̂ of `|residual|` via a one-pole low-pass:
  `σ̂_{n+1} = (1 − α_σ)·σ̂_n + α_σ·|residual|`. Default `α_σ = 0.05`,
  effective window ~20 observations.

- **Gate test.** A residual gates as an outlier when
  `|residual| / σ̂ > outlierSigmaMultiplier`. Default multiplier is `6`
  (six-sigma). Gated observations skip both the PI update AND the EWMA
  update — they don't move the offset and they don't inflate σ̂.

- **Warmup.** The gate is disabled for the first
  `outlierWarmupObservations` (default `5`) post-seed observations so
  σ̂ has time to build up from zero. Pre-warmup observations participate
  in σ̂ but bypass the gate.

- **Step-detection escape.** A genuine offset epoch change (e.g.
  `AudioContext` suspend/resume) shows up as a sustained sequence of
  large residuals, not a single spike. After
  `outlierConsecutiveLimit` (default `3`) consecutive gated
  observations, the loop concludes a step occurred, resets σ̂ to
  `|residual| / multiplier`, and admits the latest observation. The
  step-recovery latency is `outlierConsecutiveLimit + 1` observations
  ≈ 67 ms at 60 Hz.

- **Public surface.** `ConsumerClockRecovery` constructor now takes an
  optional `ConsumerClockRecoveryOptions` bag with four tuning fields.
  Pass `outlierSigmaMultiplier: Infinity` to opt out entirely
  (preserves pre-0.6.14 behavior bit-exact for legacy tests).
  `Bridge.telemetry()` gains `pllOutliersRejected: number`. The
  exported `ConsumerClockRecoveryOptions` type joins the rest of the
  composable surface in `src/index.ts`.

### Why

The 0.6.2 PLL first-cut was honest about being a first cut: offset-
only, no drift estimator, no outlier protection. The convergence
analysis assumes Gaussian-jittered residuals around the true offset,
which holds for steady-state operation but breaks immediately under
any single-frame anomaly — and a 30 ms anomaly drives an
ungated 0.6.13 PLL into a 30-observation recovery sequence even after
the spike has cleared.

For the bridge to be production-grade — and 10/10 caliber for a 1.0
release — the PLL has to survive realistic browser-thread misbehavior
without manual intervention. The Mahalanobis gate is the standard
robust-statistics tool for this: cheap (5 ops per non-gated
observation, 3 ops + 1 compare on the gated path), per-instance heap-
only, and self-tuning via σ̂ once warmup completes.

The step-detection escape is the load-bearing complication. Without
it, a genuine offset epoch change would gate indefinitely and the PLL
would be stuck at the old offset forever. With it, the gate
self-corrects: 3 frames of "wait and see," then the loop accepts the
new reality. The 67 ms latency is well below any human-perceivable
audio glitch budget.

### Wire compatibility

- **No SAB changes.** The gate is heap-only on `ConsumerClockRecovery`.
  A 0.6.13 peer and a 0.6.14 peer share a SAB transparently.
- **No public-API break.** The `ConsumerClockRecovery` constructor
  gains an optional opts parameter that defaults to `{}` (all gate
  defaults). All existing call sites continue to compile and run.
  `Bridge.telemetry()` adds one field; existing destructures keep
  working.
- **Default-on behavior change** — strictly speaking, the gate
  defaults are now active for any Bridge that wasn't pinning the
  exact pre-0.6.14 PI output. The two existing PLL pins (#42 / #43)
  still pass because: (a) the convergence pin's ±100 μs jitter is
  well below the 6σ-of-σ̂ threshold; (b) the step pin's 1 ms step
  arrives during the warmup window AND the step-detection escape
  releases subsequent observations within the existing 200-cycle
  envelope. Callers who do pin exact pre-0.6.14 offset trajectories
  should construct `ConsumerClockRecovery` with
  `outlierSigmaMultiplier: Infinity`.
- **Lanes 4–7 still reserved** for the PLL publication patch in this
  cohort.

### Tests

Three new test pins (#72–74) in `tests/Bridge.test.ts`:

- **#72 — single spike rejected.** Build σ̂ via 25 ±100 μs jittered
  observations, then inject a single 30 ms residual. Gate rejects:
  `pllOutliersRejected += 1`, offset moves < 100 ns (vs the
  `KP · 30 ms = 6 ms` movement under ungated PI). Subsequent clean
  observations don't re-bump the counter.
- **#73 — sustained step admitted after consecutive limit.** After
  warmup, induce a 5 ms step. First 3 post-step observations gate
  (`pllOutliersRejected += 3`); 4th observation tips the consecutive
  counter past the limit, σ̂ resets, observation admits. From there
  the PI math converges to the new truth within the existing
  200-cycle step-response envelope.
- **#74 — opt-out + tuning + validation.** `outlierSigmaMultiplier:
  Infinity` disables the gate and a 30 ms spike yanks the offset by
  the expected `KP · spike` amount. Tight `multiplier: 3` gates
  observations that pass under the default. Construction validates
  all four opts fields (positive sigma, non-negative integer warmup,
  α in (0, 1], non-negative consecutive limit).

All 7 suites green; bench medians unchanged at 1.20 μs (PLL is not on
the bench's measured path).

### Documentation

- `src/ConsumerClockRecovery.ts` gains a self-contained "Mahalanobis
  outlier gate" section in the file header, covering the math, the
  warmup rationale, the step-detection escape, and the default
  tuning.
- `src/Bridge.ts` `telemetry()` return type annotates the new
  `pllOutliersRejected` field; the field's semantics are documented
  on the underlying `ConsumerClockRecovery.outliersRejected` getter.
- `README.md` §Phase-locked loop gains a paragraph documenting the
  default-on gate, the opt-out path, and the recommended pairing
  with `resetPll()` for `AudioContext` suspend/resume cycles.

## [0.6.13] — 2026-05-26

### Added — observability dashboards (1.0 must-have, item 2 of 2)

The second of the two README-named "Remaining 1.0 work" items, closing
out the pre-1.0 must-have list. `Bridge<S>.telemetry()` gains six new
fields, completing the dashboard / DevTools-panel surface that the
0.6.0 snapshot started:

- **`pushedFrames: number`** — cumulative successful writes since
  construction. `'drop-newest'` overflows do NOT increment (the frame
  never made it into the ring); `'drop-oldest'` overflows DO increment
  (a new frame WAS written, an old one was evicted, both lanes count
  on their respective counters); `'block'` and `'reject'` succeed-paths
  do.

- **`pulledFrames: number`** — cumulative successful reads, one per
  ok=true `pull` / `pullLatest`. Empty pulls do NOT increment.

- **`skippedFrames: number`** — cumulative `pullLatest`-discarded
  frames, summed across all calls. Separate from `pulledFrames` so
  dashboards can distinguish "frames consumer received" from "frames
  the bridge transported" — together they reconstruct total drain.

- **`lastFullWaitNs: number`** — duration of the most recent
  `waitForSpace` that actually parked, in nanoseconds (rounded from
  `performance.now()` millisecond resolution; sub-ms precision in
  modern Node). Zero if `waitForSpace` has never parked since
  construction or always took the immediate `'not-equal'` fast path.

- **`lastEmptyWaitNs: number`** — mirror of `lastFullWaitNs` for
  `waitForData`.

- **`maxOccupancyEverSeen: number`** — high-water mark of
  `(writeIdx - readIdx)` observed at any push or pull moment.
  Producer push records the post-write buffered count; consumer
  pull / pullLatest records the pre-pull buffered count. Monotonic
  from construction. The diagnostic that answers "did the ring's
  capacity match the traffic?" — if `maxOccupancyEverSeen === capacity`,
  the ring overflowed at least once and a larger capacity (or a more
  aggressive flow-scale honor) is indicated.

All six counters are per-instance heap state. Two peers over the same
SAB each see their own counters (the producer sees its pushes; the
consumer sees its pulls + wait durations). For cross-process
aggregation, the recommended pattern is `postMessage` of the
`telemetry()` snapshot at a sampled cadence — the overhead is
negligible compared to the 16 ms control-rate budget. The heap-only
design avoids stealing reserved SAB lanes for an observability
concern. Lanes 4-5 remain reserved for the PLL publication patch
landing later in this cohort.

### Why

The README explicitly carves out observability dashboards as one of
the two remaining 1.0-blocking items. The 0.6.0 telemetry snapshot
landed the structural surface (six fields covering counters, lanes,
and PLL state); 0.6.13 completes it with the cumulative + wait-duration
+ high-water-mark fields that turn the snapshot from "current state"
into "history of behavior." Together with 0.6.12's backpressure
policies, the pre-1.0 must-have list is now empty — the project is
free to focus on polish (PLL outlier gate, drift estimator, EvalMode
dispatch) without an outstanding API-shape contract.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding, torn-frame counter, header / payload boundary — all
  bit-for-bit identical to 0.6.12. A 0.6.12 peer and a 0.6.13 peer
  share a SAB transparently. The new telemetry fields are heap-side
  per-instance counters.
- **No public-API break.** `telemetry()`'s return type adds six
  fields, no removed fields; existing destructures continue to
  work. The six new accessors on `SpscRing` (`pushedCount` /
  `pulledCount` / `skippedCount` / `lastFullWaitNanos` /
  `lastEmptyWaitNanos` / `maxOccupancy`) are additive — they don't
  shadow any pre-0.6.13 surface.
- **No hot-path change of consequence.** The new counter increments
  inside `push` / `pull` / `pullLatest` are two scalar adds and one
  compare each; V8 inlines them into the same monomorphic call
  shape. Bench medians match the 0.6.12 baseline at 1.20 μs.
- **Wait-duration timing uses `performance.now()`** rather than
  `process.hrtime.bigint()` for cross-platform portability (Node +
  browser). The recorded value is rounded to nanoseconds from a
  millisecond-resolution float; sub-ms precision in modern V8
  / SpiderMonkey / JSC is sufficient for the dashboard use case.

### Tests

Three new test pins (#69–71) in `tests/Bridge.test.ts`:

- **#69 — pushed / pulled / skipped counter semantics.** Reject
  pushes don't bump pushedFrames; empty pulls don't bump pulledFrames;
  drop-newest doesn't bump pushedFrames on drops; drop-oldest bumps
  BOTH pushedFrames AND droppedFrames per overflow; pullLatest
  increments pulledFrames by 1 and skippedFrames by the skipped count.
- **#70 — wait duration counter semantics.** Fresh Bridge has both
  at 0; waitForSpace / waitForData on the immediate `'not-equal'`
  path do NOT touch the counter (stays at previous recorded value);
  parking calls record nanosecond elapsed within a loose bound (≥ 1 ms,
  ≤ 250 ms for a 5 ms target — accommodates platform timer jitter).
- **#71 — maxOccupancyEverSeen monotonicity.** Push/pull cycles drive
  the high-water mark up; drains do NOT decrement it; pullLatest's
  pre-pull buffered participates in the observation.

All 7 suites green; bench medians unchanged from 0.6.12 baseline.

### Documentation

- `src/SpscRing.ts` field doc-comments explain each counter's semantics,
  the per-instance caveat, and the timing-source rationale.
- `src/Bridge.ts` `telemetry()` return-type comment annotates the
  0.6.13 additions inline and notes the postMessage-aggregation
  pattern for cross-process consumers.
- `README.md` `Remaining 1.0 work` section reflects that BOTH items
  have shipped — the pre-1.0 must-have list is now empty. The
  §Adaptive backpressure section gains a sentence pointing at the
  full observability suite. A new §Observability dashboards section
  documents the full telemetry surface in one place.

## [0.6.12] — 2026-05-26

### Added — backpressure policies (1.0 must-have, item 1 of 2)

The first of the two README-named "Remaining 1.0 work" items. `Bridge<S>` and
`SpscRing<S>` constructors gain an optional `opts` bag whose first field is
`policy: 'reject' | 'drop-newest' | 'drop-oldest' | 'block'` (default
`'reject'` — preserves 0.4.0..0.6.11 behavior bit-exact). Selects what happens
when `push` would overflow.

- **`policy: 'reject'`** (default). Push returns false; the caller decides
  what to do (typically retry, drop, or `waitForSpace`). Same contract as
  every prior 0.x. No behavior change for any existing caller.

- **`policy: 'drop-newest'`**. Push returns true but does NOT write the new
  frame. The ring's existing older frames survive — `pull` continues to read
  the FIFO sequence the consumer was already mid-way through. Use for
  audit-style streams where state transitions matter more than the freshest
  tick. Drop counter increments per dropped push.

- **`policy: 'drop-oldest'`**. Push CAS-advances `read_index` to evict the
  oldest unread frame, then writes the new frame into the freed slot.
  Returns true. Use for freshness-wins streams where the newest update
  matters most. Multi-thread torn-frame race window documented on
  `BackpressurePolicy` and the `_dropOldest` body comment — pair with
  `.withInvariant(...)` for safe multi-thread use (the existing torn-frame
  classifier catches the race).

- **`policy: 'block'`** (with optional `blockTimeoutMs?: number`). Push
  parks the producer via the existing `waitForSpace` machinery until the
  consumer drains, then retries once. On timeout, push returns false (same
  surface as `'reject'`). Producer thread must be one where `Atomics.wait`
  is permitted (not the browser main thread, never an AudioWorklet's
  `process()`).

`Bridge<S>.telemetry()` gains two new fields: `policy: BackpressurePolicy`
and `droppedFrames: number`. The full `pushed` / `pulled` / wait-duration /
high-water-mark observability suite lands in the 0.6.13 companion patch
(README §Remaining 1.0 work item 2 of 2). `droppedFrames` is heap-side per
producer instance — drops are a producer-side fact, not a wire-format fact.

### Why

The README explicitly carves out backpressure policies as one of the two
remaining 1.0-blocking items. With 0.5.0's soft `flowScaleHint` already in
place, hard reject is rare in practice — but the policies cover the cases
where the producer cannot honor the hint at all (`'block'` is the explicit
"wait for consumer" surface; `'drop-newest'` / `'drop-oldest'` are the
freshness/audit-style streams where the producer keeps producing under
overload). Implementing them now lets us also exercise the docs-pattern
for the 0.6.13 observability patch on the same constructor surface before
1.0 freezes the API shape.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding, torn-frame counter, header / payload boundary — all
  bit-for-bit identical to 0.6.11. A 0.6.11 peer and a 0.6.12 peer share
  a SAB transparently. Policies are a per-instance producer-side concern;
  the consumer never observes the policy directly.
- **No public-API break.** All existing constructors continue to compile
  and behave bit-identically (the new `opts` parameter defaults to `{}`
  which resolves to `policy: 'reject'`). `telemetry()` adds two fields,
  no removed fields; existing destructures continue to work.
- **No `Bridge<S>` orchestration change.** Push / pull / pullSmoothed /
  pullEvaluated / observeConsumerTime / phaseLockedTime are all
  unaffected. The only push-path change is a single forward-predicted
  branch in the full-detection block that V8 inlines well — bench medians
  are unchanged at 1.20 μs.
- **`'drop-oldest'` SPSC caveat.** Documented on `BackpressurePolicy`:
  the producer CAS-writes `read_index` on overflow, which under SPSC is
  normally consumer-only. The CAS guarantees atomicity but does not
  prevent a concurrent consumer pull from reading torn bytes on the
  just-evicted slot. Pair with `.withInvariant(...)` for multi-thread
  use; single-thread use has no race.
- **Lanes 4–7 still reserved** for future wire-format extensions.

### Tests

Five new test pins (#64–68) in `tests/Bridge.test.ts`:

- **#64** — `'reject'` policy preserves 0.6.11 behavior (default and
  explicit construction); `telemetry().policy` round-trips; unknown
  policy throws at construction.
- **#65** — `'drop-newest'` returns true when full, the new frame is
  dropped, consumer reads the originally-oldest survivors,
  `droppedFrames` matches drop count.
- **#66** — `'drop-oldest'` returns true when full, the originally-
  oldest is evicted, consumer reads the newer frames that overwrote it,
  `available` stays at capacity, `droppedFrames` matches eviction count.
- **#67** — `'block'` fast path: with space available, push completes
  synchronously without invoking the parking machinery; sub-25 ms bound
  for 4 pushes on a 4-element physics schema.
- **#68** — `'block'` timeout: with no consumer draining, push returns
  false after ~5 ms; construction validates `blockTimeoutMs` is a
  non-negative finite number.

All 7 existing suites green; bench medians match the 0.6.11 baseline at
1.20 μs for push / pull / pullLatest (the new policy dispatch is a single
forward-predicted branch on the not-full path and never executes in
steady state).

### Documentation

- `src/SpscRing.ts` gains a `BackpressurePolicy` doc block covering the
  per-policy contract, the `'drop-oldest'` SPSC torn-frame caveat, and
  the recommended `.withInvariant(...)` pairing.
- `src/Bridge.ts` exports a new `BridgeOptions` interface (extends
  `SpscRingOptions`).
- `README.md` `Remaining 1.0 work` section is updated to reflect that
  item 1 has shipped; the §Back-pressure section gains a paragraph
  documenting the new policies and the multi-thread caveat. The full
  policy table will be added when item 2 (observability) lands in
  0.6.13.

## [0.6.11] — 2026-05-26

### Added — bench cells for downstream decisions

Pure measurement patch. Two new bench cells in `bench/Bridge.bench.ts`
produce the headline numbers that the next planning round will use to
decide whether the 0.7.0 wait-flag wire-format work + any future
frame-codegen evaluation are scope-justified. **No source-code behavior
change for any user-visible code path. No wire-format change. No public-
API break.** The shim added to `SpscRing` is dev-only (underscore-
prefixed, not exported, never called by `Bridge<S>`).

- **`propAccess (Bridge)` vs `propAccess (inline)` cell.** Pushes /
  pulls a 4-scalar-only schema (`u64` + `i32` + `f64` + `f32`, no array
  lanes) through a real `Bridge<S>` and through a hand-rolled inline
  loop that does the equivalent typed-array writes / reads directly,
  without the per-field closure dispatch + without the SAB / Atomics
  path. The delta is the **upper-bound envelope** on what frame-codegen
  could possibly save by inlining the closure dispatch (minus the SAB +
  notify costs that codegen wouldn't touch). Measured medians on the
  local machine: **`Bridge` ≈ 400 ns** for one full push+pull on the
  4-scalar schema; **`inline` ≈ 0 ns** (below `hrtime.bigint()`'s
  ~100 ns resolution); **delta ≈ 400 ns**, of which most is SAB /
  Atomics protocol cost rather than closure dispatch. Codegen's
  realistic ceiling is well under that delta.

- **`pull (notify)` vs `pull (noNotify)` cell.** Drives the same
  physics-control schema (`physicsControlFrameSchema(1000)`) push / pull
  cadence through a directly-constructed `SpscRing<S>`, alternating
  between the public `pull` (which fires `Atomics.notify(read_index)`)
  and the new dev-only `_pullNoNotify` shim (same body, notify skipped).
  Measured medians on the local machine: **`pull (notify)` ≈ 1.30 μs**;
  **`pull (noNotify)` ≈ 1.20 μs**; **delta ≈ 100 ns per pull**. The
  RFC's "syscall on every pull" framing overstates the impact: an
  `Atomics.notify` with zero waiters in V8 is around the
  `hrtime.bigint()` resolution floor, not a microsecond.

### Why

These two numbers are the inputs for the next planning round, not
something this patch acts on:

- The **codegen** evaluation (whether to ship a build-time or runtime
  frame codegen that inlines the per-field closures) needs an upper
  bound on the savings; without it the design conversation runs on
  vibes. ~400 ns per round-trip on a 4-scalar schema — most of which
  is the SAB protocol, not the closures — bounds the answer.
- The **0.7.0 wait-flag** wire-format extension's payoff is precisely
  the per-pull notify cost. If notify were microseconds, the extension
  would be a clear win and lane 4 would be activated immediately. At
  ~100 ns per pull, the case is far more nuanced: the wait-flag
  protocol adds protocol complexity to the SAB header for a savings on
  the order of a single cache hit. The 0.7.0 planning round can read
  the number and decide accordingly.

Both numbers were unknowns before this patch; both go into the next
planning effort's `Context` section as concrete data.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding, torn-frame counter, header / payload boundary — all
  bit-for-bit identical to 0.6.10. A 0.6.10 peer and a 0.6.11 peer
  share a SAB transparently.
- **No public-API change.** `src/index.ts` is byte-identical to 0.6.10;
  no symbols added, removed, or retyped. `_pullNoNotify` is a private-
  by-convention method on `SpscRing` (underscore prefix, no top-level
  re-export); the type signature on the class is widened by one slot
  but the surface visible to TS importers via `import { SpscRing }` is
  unchanged in shape because the new method is documented as dev-only
  and is not part of the supported API.
- **No `Bridge<S>` delegation.** `Bridge.pull` continues to call
  `this.ring.pull(out)` exactly as in 0.6.10; the shim sits beside
  `pull` on `SpscRing` and is reachable only by callers that hold a
  direct `SpscRing` reference (i.e. the bench harness).
- **Lanes 4–7 still reserved** for the 0.7.0 wait-flag protocol.

### Tests

No new test pins. The bench cells are measurement, not regression
gates. All 7 existing suites green on this patch:

- `tests/schema.test.ts` 14 pins (unchanged).
- `tests/Bridge.test.ts` 63 pins (unchanged).
- `tests/BridgeFacades.test.ts` 4 pins (unchanged); the
  `facade-symmetry-with-bridge` load-bearing pin still passes.
- `tests/Bridge.phaseLock.test.ts` (unchanged).
- `tests/Bridge.concurrent.test.ts` — 1,000,000-frame SPSC stress
  completes in ~830 ms with `emptyWaitTimeouts === 0` and
  `flow_scale envelope [0.500, 2.000]`. `_pullNoNotify` is dev-only and
  not on any user-visible code path, so the concurrent stress is
  unperturbed.
- `tests/Float64RingBuffer.test.ts` 9 pins (unchanged).
- `tests/Float64RingBuffer.concurrent.test.ts` (unchanged).

Bench medians on the unchanged cells match the 0.6.10 baseline within
the `hrtime.bigint()` 100 ns quantization on this machine: push /
pull / pullLatest 1.20–1.30 μs; `trajEval (fast)` 1.20 μs;
`trajEval (clamp)` 5.20 μs; flow-scale recovery 33 cycles. The two new
cells (`propAccess`, notify-on-pull) sit beside them and do not
displace any existing measurement.

### Documentation

- `README.md` `Performance` section gains a short paragraph documenting
  the two new bench cells with the measured medians.
- `bench/Bridge.bench.ts` file header gains a 0.6.11 cell-summary
  paragraph; both new bench functions carry self-contained header
  comments explaining what they measure, why, and what the delta
  represents.
- `src/SpscRing.ts` `_pullNoNotify` method carries a self-contained
  doc comment marking it as dev-only / not-on-user-path; the file
  header surface comment is unchanged because the dev shim is not part
  of the public protocol.

## [0.6.10] — 2026-05-26

### Added — composable consumer / producer + internal primitives exported

The deliberate promotion patch. The four internal heap state machines that
0.6.8 + 0.6.9 carved out of `Bridge<S>` move to the public composable API,
joined by two thin facade classes that wrap them as explicit consumer /
producer objects. `Bridge<S>` continues to work unchanged and remains the
recommended monolithic entry point; the facades are the alternative path
for users who want explicit control over which primitives are composed and
which invariant-failure policy is active. **No public-API break. No
wire-format change. Additive only.**

- **`src/index.ts`** widens its export surface (~24 lines → ~58 lines).
  Four primitive classes promoted from internal-only:
  - `SpscRing<S>` + the `SpscPullResult` type (the SAB / Atomics core).
  - `FrameSmoother<S>` (the unified consumer-side prev buffer + the
    trajectory-aware one-pole blender).
  - `ConsumerClockRecovery` (the PLL heap state machine).
  - `AdaptiveFlowController` (the lane-2 PI controller).
  Plus two new facade classes:
  - `BridgeConsumer<S>` + the `BridgeConsumerOptions` / `InvariantFailurePolicy`
    / `InvariantFailureCallback` types.
  - `BridgeProducer<S>`.

- **`src/BridgeConsumer.ts`** (~330 lines, new file). Thin wrapper over an
  `SpscRing<S>` + an optional `FrameSmoother<S>` + an optional
  `ConsumerClockRecovery`. Constructor takes the ring + an options bag:
  ```ts
  new BridgeConsumer(ring, {
    smoother?: FrameSmoother<S> | null,    // null = opt out
    pll?: ConsumerClockRecovery | null,    // null = opt out
    onInvariantFailure?: 'fallback-to-previous' | 'throw' | 'pass-through'
                       | ((out, computed, stored) => void),
  });
  ```
  Defaults match `Bridge<S>` bit-for-bit: a fresh `FrameSmoother<S>` wired
  to the consumer's own `scratchFrame` factory, a fresh
  `ConsumerClockRecovery`, and `'fallback-to-previous'` on hard
  invariant errors. Exposes the consumer surface from `Bridge<S>`: `pull`,
  `pullLatest`, `pullSmoothed`, `pullLatestSmoothed`, `resetSmoother`,
  `observeConsumerTime`, `phaseLockedTime`, `resetPll`, `available`,
  `flowScaleHint`, `tornFrameCount`, `scratchFrame`. Opt-out semantics:
  passing `smoother: null` makes the smoothed-pull methods throw with a
  clear message; passing `pll: null` makes the PLL methods throw. Custom
  callback policies receive `(out, computed, stored)` and may mutate `out`
  in place.

- **`src/BridgeProducer.ts`** (~120 lines, new file). Thin wrapper over an
  `SpscRing<S>`. No options; constructor takes just the ring. Exposes
  `push` / `beginPush` / `commitPush` / `abortPush` / `flowScaleHint` /
  `waitForSpace` / `scratchFrame`. SPSC rules apply: one `BridgeProducer`
  per ring, one `BridgeConsumer` per ring.

- **`src/Bridge.ts` unchanged in public shape.** The monolithic class
  continues to compose `SpscRing` + `FrameSmoother` + `ConsumerClockRecovery`
  internally the same way it did in 0.6.9, with the same `private`
  modifiers and the same external surface. The file header now lists the
  composable facades as the alternative path.

### Why — settle the API surface before locking in 1.0

0.6.8 + 0.6.9 carved the primitives. 0.6.10 promotes them — but the
promotion lands AS a patch, not a minor, deliberately. The new export
surface is purely additive: every existing `Bridge<S>` call site
continues to work bit-identically, the SAB protocol is unchanged, the
test-hook seam (`_updateFlowScale`) is unchanged. Users who don't want
the composable surface never have to know it exists.

Two motivations stack:

1. **Compose-vs-monolith choice for users.** Some callers want the full
   `Bridge<S>` and never look inside; the monolith stays for them. Others
   want to plug in a custom smoother (different α policy, different blend
   field rules), opt out of the PLL on a consumer that doesn't need
   clock recovery, or build a producer-only worker without the consumer
   machinery. The facades give those users explicit control without
   forcing them to fork `Bridge<S>`.

2. **API surface settles before 1.0.** The composable primitives now have
   public TS signatures, exported types, and pinned behavior contracts —
   any drift between `BridgeConsumer` and `Bridge<S>` (e.g. a future
   change to the invariant classifier on one path but not the other)
   surfaces through the `facade-symmetry-with-bridge` pin immediately.
   The promotion-while-additive shape means the symmetry pin is
   load-bearing and the next decade of patches has a clean way to keep
   both surfaces in sync.

Per the post-0.6.9 CLAUDE.md slowdown extension, the 0.7.x cohort is now
expected to reach deep into the patch space — `0.7.0 → 0.7.99` is the
planned envelope before any `0.8.0` is considered, with the same rule at
every subsequent minor. 0.6.10 is the last patch in the Phase B
"compose internals" arc; Phase C (0.6.11 bench cells + 0.6.12
Float64RingBuffer hard-deprecate) continues from the same plan.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding, torn-frame counter, header / payload boundary — all
  bit-for-bit identical to 0.6.9. A 0.6.9 peer and a 0.6.10 peer share
  a SAB transparently. The facade-built peer is wire-compatible with
  the `Bridge<S>`-built peer: a `BridgeProducer` over one ring
  interoperates with a `Bridge<S>` consumer over the matching SAB, and
  vice versa.
- **No public-API breakage.** Every existing exported symbol from
  `src/index.ts` (`Bridge`, `RING_HEADER_BYTES`, `RING_HEADER_LANES`,
  `BridgeAllocation`, `SmoothedPullOptions`, `SmootherSkipPolicy`, all
  the schema DSL exports, the trajectory evaluator, the canonical
  schemas, the deprecated legacy ring) is byte-identical to 0.6.9. The
  new exports are purely additive.
- **`Bridge<S>` is unchanged in shape.** All 1,134 lines stay; the file
  header mentions the facades as the alternative path but the class
  itself is identical. The `_updateFlowScale` test-hook seam is
  unchanged. `Bridge<S>` still composes `SpscRing` + `FrameSmoother` +
  `ConsumerClockRecovery` internally the same way; 0.6.10 simply
  exports those classes for direct use.
- **Lanes 4–7 still reserved** for the 0.7.0 wait-flag protocol.

### Tests

Test counts grow: a new `tests/BridgeFacades.test.ts` file with 4 pins
joins the suite (`Bridge.test.ts` stays at 63 pins). All 7 suites green:

- `tests/schema.test.ts` 14 pins (unchanged).
- `tests/Bridge.test.ts` 63 pins (unchanged).
- **`tests/BridgeFacades.test.ts` 4 pins (new)**:
  - `facade-construction-defaults` — default-constructed `BridgeConsumer`
    has non-null `FrameSmoother` + `ConsumerClockRecovery`; `scratchFrame`
    on both facades returns usable views; `smoother: null` / `pll: null`
    opt-out makes the affected methods throw with clear messages; raw
    pull on a smoother-less consumer still works.
  - `facade-round-trip` — `BridgeProducer` → `BridgeConsumer` over the
    same `SpscRing` round-trips physics frames bit-exact; `pullLatest`
    skipped count is correct; `beginPush` / `commitPush` works through
    the producer facade; `flowScaleHint` is symmetric across both
    facades.
  - **`facade-symmetry-with-bridge`** — the load-bearing pin. On two
    SABs of identical (capacity, schema) driven by the same producer
    pattern, `BridgeConsumer.pull` and `BridgeConsumer.pullLatestSmoothed`
    produce bit-identical output to `Bridge<S>.pull` /
    `Bridge<S>.pullLatestSmoothed`. Covers both `'stall-smooth'`
    (default) and `'catch-up'` skip policies. Catches drift in the
    duplicated invariant classifier and the smoother dispatch
    immediately.
  - `facade-invariant-policies` — the four `onInvariantFailure` modes.
    Default `'fallback-to-previous'` matches Bridge<S> bit-for-bit on
    the canonical corrupt-byte fixture (returns last-known-good A,
    tornFrames++). `'throw'` raises a clear Error and still bumps
    tornFrames. `'pass-through'` returns the corrupt payload unchanged
    and still bumps tornFrames. A custom callback receives
    `(out, computed, stored)` and its mutation of `out` is observable
    by the caller.
- `tests/Bridge.phaseLock.test.ts` (unchanged).
- `tests/Bridge.concurrent.test.ts` — 1,000,000-frame SPSC stress
  completes in ~600 ms with `emptyWaitTimeouts === 0` and
  `flow_scale envelope [0.500, 2.000]`. Still the load-bearing
  validation; SAB protocol surface is unchanged from 0.6.9 so the
  facade promotion does not perturb it.
- `tests/Float64RingBuffer.test.ts` 9 pins (unchanged).
- `tests/Float64RingBuffer.concurrent.test.ts` (unchanged).

Bench medians at N=1000 unchanged from 0.6.9: push 1.20 μs, pull 1.20 μs,
pullLatest 1.20 μs; `trajEval (fast)` 1.10 μs / `trajEval (clamp)`
~5.0 μs; flow-scale recovery 33 cycles. The facades are a thin layer of
method delegation; they do not touch the hot path's `SpscRing` mechanics
and are below the bench's resolution.

### Documentation

- `README.md` gains a new subsection under the API reference, "Composable
  consumer / producer (0.6.10)", showing side-by-side `Bridge<S>` vs
  `SpscRing` + `BridgeProducer` + `BridgeConsumer` composition. Roadmap
  line updated.
- The two new facade source files each carry a self-contained file header
  documenting the constructor shape, the wire-compatibility guarantee,
  and the invariant-failure policy table.

## [0.6.9] — 2026-05-26

### Changed — internal extract: `FrameSmoother` + `ConsumerClockRecovery` + `AdaptiveFlowController`

Three more heap-state machines lift out of `Bridge<S>` / `SpscRing<S>` into
dedicated internal classes, continuing the seam 0.6.8 carved. **No public-API
change. No wire-format change. No exported symbol additions.** Every
`Bridge<S>` method continues to work bit-identically; the 1 M-frame
concurrent SPSC stress passes the new seams unchanged.

- **`src/FrameSmoother.ts`** (~312 lines, new file) owns the unified
  consumer-side `prev` buffer (used by both `pullSmoothed` /
  `pullLatestSmoothed` and the schema-invariant hard-error recovery path)
  + the trajectory-aware one-pole blender + the precomputed per-field
  classification tables (`scalarIsBigInt`, `scalarIsInteger`,
  `arrayIsBigInt`, `arrayIsInteger`, `arrayTrajectoryOrder`). API:
  `observe(out, alpha)` (mutates out in place, updates prev),
  `seedFrom(src)` (invariant ok-branch), `fallbackInto(out)` →
  boolean (invariant hard-branch), `reset()`, `currentPrevValid()`.
  Lazily allocates its prev buffer via a factory passed at construction
  (Bridge passes `() => this.scratchFrame()`) so the smoother does not
  duplicate the schema-walk allocator. Schema-driven layout walks live here.

- **`src/ConsumerClockRecovery.ts`** (~134 lines, new file) owns the PLL:
  `_offsetNs`, `_integral`, `_locked`, plus the `PLL_KP` / `PLL_KI` /
  `PLL_INT_LIMIT_NS` constants (exposed as `static readonly KP` / `KI` /
  `INT_LIMIT_NS` for tests). API: `observe(consumerNs, producerNs)`
  (first call seeds exact offset + flips locked; subsequent calls run the
  PI math), `phaseLockedTime(consumerNs)` (returns `consumerNs + offsetNs`
  once locked, else `consumerNs` unchanged), `reset()` + `locked` /
  `offsetNs` getters for `telemetry()`. Argument validation (`Number.isFinite`)
  moved into the class.

- **`src/AdaptiveFlowController.ts`** (~131 lines, new file) owns the
  flow-scale PI loop + the Q16.16 encode that previously lived inline on
  `SpscRing._updateFlowScale` + the `FLOW_SCALE_KP` / `FLOW_SCALE_KI` /
  `FLOW_SCALE_INT_LIMIT` / `FLOW_SCALE_MIN` / `FLOW_SCALE_MAX` constants
  (exposed as `static readonly KP` / `KI` / `INT_LIMIT` / `MIN` / `MAX` /
  `Q` / `DEFAULT_Q`). API: `tick(buffered, capacity)` → encoded Q16.16
  value the ring writes into lane 2. The chosen signature passes the
  pre-computed `buffered` count (avoiding a redundant division at the call
  site that already has `writeIdx − readIdx` in hand) and lets the
  controller compute occupancy = `buffered / capacity` internally.

- **`src/Bridge.ts`** slims from ~1,329 to ~1,134 lines. The class continues
  to hold one `SpscRing<S>` as `this.ring`; it now also holds one
  `FrameSmoother<S>` as `this.smoother` and one `ConsumerClockRecovery` as
  `this.pll`. The `consumerPrev` / `consumerPrevValid` fields, the
  classification tables, the `_applySmoother` / `_seedConsumerPrev` /
  `_copyFrameInto` private methods, and the `pllOffsetNs` / `pllIntegral`
  / `pllLocked` fields — all gone, moved to the new classes. The
  invariant classifier (`_classifyInvariant` + epsilon floor) and the
  raw / smoothed invariant handlers (`_invariantHandleRaw`,
  `_invariantHandleSmoothed`) stay on Bridge but now dispatch onto the
  smoother (`seedFrom` / `observe` / `fallbackInto`). The per-frame
  trajectory evaluator (`evaluateInto`, `scratchEvaluatedFrame`,
  `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `setSampleRate`,
  `resetEvalCache`) stays unchanged. `telemetry()` gathers from Bridge +
  SpscRing + the new internals via existing accessors (`pll.locked`,
  `pll.offsetNs`).

- **`src/SpscRing.ts`** slims from ~875 to ~866 lines. `_updateFlowScale`
  is now a three-line bridge: compute `buffered = (writeIdx − readIdx) | 0`,
  call `this.flowController.tick(buffered, this.capacity)`, `Atomics.store`
  the returned encoded value into `FLOW_SCALE_LANE`. The PI gains, the
  anti-windup limit, and the Q16.16 encode all live on the controller;
  SpscRing keeps only the lane index and the seed-on-construct
  `Atomics.compareExchange` (which now reads `AdaptiveFlowController.DEFAULT_Q`).

- **All four extracted classes (SpscRing, FrameSmoother,
  ConsumerClockRecovery, AdaptiveFlowController) remain internal-only at
  0.6.9.** Not exported from `src/index.ts`. 0.6.10 is the deliberate
  promotion patch that lifts them to the public composable API.

### Why — keep slicing the seam ahead of the 0.6.10 promotion

0.6.8 carved Bridge along its largest seam (SpscRing). 0.6.9 takes the
remaining heap-side machinery out of the orchestrator: an α-smoother with
its own prev buffer, a PLL with its own integral state, and a flow
controller with its own integrator. Each is a self-contained heap state
machine with a small explicit API; each can be unit-tested without
spinning up a SAB (pins 61–63 do exactly that).

The dispatch shape on Bridge becomes even thinner: `pull` is now seven
lines (ring pull → either invariant dispatch or `smoother.reset()` →
return); the smoothed variants are six (ring pull → invariant or smoother
dispatch → return); the PLL methods are one-line delegators. The
invariant classifier (`_classifyInvariant` + epsilon floor) and the
trajectory evaluator stay on Bridge — they're orchestration, not single
state machines.

A second motivation: surface design. The 0.6.10 promotion needs each
primitive's API to be small, complete, and tested in isolation. Doing
the extract first and the public export second lets the API shape settle
under the existing pin suite before any external caller can pin against
it.

The 1 M-frame concurrent SPSC stress is again load-bearing. The new
seams are heap-only (FrameSmoother + ConsumerClockRecovery don't touch
the SAB; AdaptiveFlowController writes lane 2 via SpscRing the same as
before), so the SPSC protocol surface area is unchanged from 0.6.8.
If the seam had a release/acquire bug or a missed integrator update,
the test's `flow_scale envelope` and `emptyWaitTimeouts === 0`
assertions would catch it within the first few hundred frames.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding (now produced by `AdaptiveFlowController.tick` rather than
  inline on `SpscRing._updateFlowScale`, but bit-identical), torn-frame
  counter, header / payload boundary — all bit-for-bit identical to
  0.6.7 / 0.6.8. A 0.6.8 peer and a 0.6.9 peer share a SAB transparently.
  Lanes 4–7 remain reserved for the 0.7.0 wait-flag protocol.
- **No public-API breakage.** Every `Bridge<S>` method signature, return
  shape, and exported symbol from `src/index.ts` is byte-identical to
  0.6.8. `telemetry()` still returns the same frozen object with the same
  field names (`pllLocked` / `pllOffsetNs` are now sourced from
  `this.pll.locked` / `this.pll.offsetNs` but the public field names are
  unchanged).
- **No exported symbol additions.** `FrameSmoother`, `ConsumerClockRecovery`,
  and `AdaptiveFlowController` are internal-only — Bridge / SpscRing
  consume them from their respective module files but `src/index.ts` does
  not re-export them. 0.6.10 is the deliberate promotion patch.
- **Test-hook seam preserved.** `Bridge._updateFlowScale(writeIdx, readIdx)`
  → `SpscRing._updateFlowScale(writeIdx, readIdx)` → `flowController.tick(...)`.
  `tests/Bridge.test.ts#testFlowScalePIStepResponse` continues to pin
  the gain shape via this hook with no producer-side changes.

### Tests

Test counts grow: `tests/Bridge.test.ts` 60 → 63 pins (one small unit
test per new internal class). All 6 suites green:

- `tests/schema.test.ts` 14 pins (unchanged).
- `tests/Bridge.test.ts` 63 pins (every smoothed-pull, invariant,
  flow-scale, PLL, trajectory, and evaluator pin from 0.6.8 passes
  through the seam unchanged; three new pins exercise the extracted
  internals directly).
  - **`testFrameSmootherUnit`** (pin #61) — direct-construct the smoother
    against a mixed-kind schema (f64 scalar + u32 scalar + f64 array);
    first observe seeds prev (no blend); second observe blends per
    `α·curr + (1−α)·prev` with integer fields rounded; `seedFrom`
    replaces prev verbatim; `fallbackInto` copies back when valid /
    returns false when not; `reset` invalidates without freeing buffer.
  - **`testConsumerClockRecoveryUnit`** (pin #62) — cold start
    `locked === false`; first observe seeds exact offset and flips
    locked; second observe runs the PI math verified against the
    closed-form `KP·residual + KI·integral`; reset returns to cold;
    non-finite arguments throw on both consumerNs and producerNs.
  - **`testAdaptiveFlowControllerUnit`** (pin #63) — Q16.16 constants
    pin; first tick on empty ring matches the closed-form Q16.16-encoded
    scale; sustained full-ring saturates at MIN clamp after enough
    cycles; reset zeros integrator so the next tick from empty matches
    a brand-new controller's first tick.
- `tests/Bridge.phaseLock.test.ts` (unchanged).
- `tests/Bridge.concurrent.test.ts` — 1,000,000-frame SPSC stress
  completes in ~600 ms with `emptyWaitTimeouts === 0` and
  `flow_scale envelope [0.500, 2.000]`. **Still the load-bearing
  validation for the seam.** The integrator state moved off SpscRing
  onto AdaptiveFlowController but the lane-2 writes are bit-identical;
  a regression would flip the envelope assertion within the first few
  hundred frames.
- `tests/Float64RingBuffer.test.ts` 9 pins (unchanged).
- `tests/Float64RingBuffer.concurrent.test.ts` (unchanged).

Bench medians at N=1000 unchanged from 0.6.8: push 1.20 μs, pull 1.20 μs,
pullLatest 1.20 μs (p99 1.50–1.90 μs across all three);
`trajEval (fast)` 1.10 μs / `trajEval (clamp)` 4.80 μs; flow-scale
recovery 33 cycles (analytic ≈ 46). The extra method calls across the
new heap seams are below the bench's resolution.

### Documentation

- `src/FrameSmoother.ts`, `src/ConsumerClockRecovery.ts`, and
  `src/AdaptiveFlowController.ts` each carry a file header documenting
  the class's invariants, the math (PI gains, anti-windup, Q16.16 encode
  on the controller; KP / KI / clamp formula on the PLL; trajectory-
  aware blend rule and field-type classification on the smoother), and
  the "internal-only this patch, exported in 0.6.10" status.
- `src/Bridge.ts`'s file header gains a `0.6.8 / 0.6.9 architecture note`
  describing the composition: Bridge holds one `SpscRing`, one
  `FrameSmoother`, and one `ConsumerClockRecovery`; the existing
  Smoothed pulls / Schema invariants / Phase-locked loop sections are
  updated to point at the new owning classes while the public contract
  (the method names + signatures) remains unchanged.
- `src/SpscRing.ts`'s file header updates the 0.6.9-plan paragraph to a
  0.6.9-done description: `_updateFlowScale` is now a three-line wrapper
  around `AdaptiveFlowController.tick`.
- `CHANGELOG.md` — this entry.
- `README.md` — single roadmap line noting that 0.6.9 ships the internal
  extract of FrameSmoother / ConsumerClockRecovery / AdaptiveFlowController
  preparatory for the 0.6.10 composable exports.

## [0.6.8] — 2026-05-26

### Changed — internal extract: `SpscRing`

The SAB / Atomics core of `Bridge<S>` lifts into a new internal class
`SpscRing<S>` (`src/SpscRing.ts`). **No public-API change. No wire-format
change. No exported symbol additions.** Every `Bridge<S>` method continues
to work bit-identically; this is a pure architectural seam that 0.6.9–0.6.10
will widen and 0.6.10 will export.

- **`src/SpscRing.ts`** (~875 lines, new file) owns: SAB allocation
  (`byteLength`, `allocate`), header layout (lanes 0–3 active —
  `write_index`, `read_index`, `flow_scale`, `torn_frame_counter`; lanes
  4–7 reserved), lane-offset constants (`RING_HEADER_BYTES`,
  `WRITE_IDX_LANE`, etc.), `push` / `beginPush` / `commitPush` / `abortPush`
  / `pull` / `pullLatest` mechanics with the unconditional
  `Atomics.notify` protocol preserved as-is (the lane-4 wait-flag wake
  protocol is 0.7.0 territory), `available()`, `flowScaleHint()`,
  `tornFrameCount()` / `incrementTornFrameCount()`, `waitForData` /
  `waitForSpace`, `describeLayout()`, and the lane-2 adaptive
  flow-scale PI controller tick (`_updateFlowScale`). Pull-result handoff
  to `Bridge` uses a reused `pullResult` scratch object — no per-call
  allocation on the hot path.

- **`src/Bridge.ts`** slims from 2,196 to ~1,329 lines. The class becomes a
  thin orchestrator that constructs one `SpscRing<S>` as `this.ring` and
  delegates every ring-mechanic call (`push`, `pull`, `pullLatest`,
  `available`, `flowScaleHint`, `waitForData`, `waitForSpace`,
  `describeLayout`, etc.). The consumer-side state machines that are NOT
  ring mechanics stay on Bridge unchanged: α-smoother (`_applySmoother`,
  `pullSmoothed`, `pullLatestSmoothed`, `resetSmoother`), schema-invariant
  classifier (`_classifyInvariant`, `_invariantHandleRaw`,
  `_invariantHandleSmoothed`) with the 0.6.6 epsilon floor, PLL
  (`observeConsumerTime`, `phaseLockedTime`, `resetPll`), per-frame
  trajectory evaluator (`evaluateInto`, `scratchEvaluatedFrame`,
  `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `setSampleRate`,
  `resetEvalCache`), and the `telemetry()` snapshot (which now reads
  through the ring for ring-side counters).

- **`SpscRing` is internal-only at 0.6.8.** Not exported from
  `src/index.ts`. 0.6.9 will split `FrameSmoother` /
  `ConsumerClockRecovery` / `AdaptiveFlowController` out of Bridge along
  the same seam; 0.6.10 promotes the composable primitives to the public
  API.

### Why — pre-build the v1.0 composable API without breaking 0.6.x

The Bridge<S> god-object had accumulated SAB mechanics, an α-smoother, a
PLL, an invariant classifier, a per-frame evaluator, and a flow-scale PI
controller in one class. The 1.0 design — surfaced in the RFC and pinned
in `.claude/plans/we-need-your-help-swirling-russell.md` — exposes those
as composable primitives so callers can build custom consumer / producer
shapes (a smoother-only consumer with no PLL, a PLL-only consumer feeding
a custom blender, etc.) without paying for the rest. The composable
shape needs an internal seam first so the pieces can be tested in
isolation; this patch carves that seam without touching the public API.

The seam shape is "Bridge orchestrates, SpscRing carries SAB I/O." The
ring owns everything that touches the SAB or the always-notify protocol;
Bridge owns everything that lives on the heap (smoother prev, PLL
offset, invariant fallback buffer, evaluator cache). Pull-result handoff
between the two layers uses a reused scratch object on the ring — no
per-call allocation, no struct copy. The cost of the extract on the
1.20 μs N=1000 pull path is below the bench's resolution.

A second motivation: the 1 M-frame concurrent SPSC stress
(`tests/Bridge.concurrent.test.ts`) is now load-bearing evidence that the
ring's SPSC protocol survives the extraction. The producer worker still
talks to a `Bridge<S>` facade via `Bridge.describeLayout()` (no producer-
worker changes); 1 M frames cross the seam with zero lost wake-ups, zero
out-of-order seq, zero `fullWaitTimeouts`. If the seam had a release/
acquire ordering bug the test would flip red within the first few
hundred frames.

### Wire compatibility

- **No SAB changes.** Lane layout, byte offsets, Q16.16 flow-scale
  encoding, torn-frame counter, header / payload boundary — all bit-for-
  bit identical to 0.6.7. A 0.6.7 peer and a 0.6.8 peer share a SAB
  transparently. Lanes 4–7 remain reserved for the 0.7.0 wait-flag
  protocol.
- **No public-API breakage.** Every `Bridge<S>` method signature, return
  shape, and exported symbol from `src/index.ts` is byte-identical to
  0.6.7. `RING_HEADER_BYTES`, `RING_HEADER_LANES`, and `BridgeAllocation`
  continue to be importable from `./Bridge.js` (re-exported from the new
  `SpscRing.ts` canonical home).
- **No exported symbol additions.** `SpscRing`, `RING_HEADER_INT32_LANES`,
  the lane constants (`WRITE_IDX_LANE`, etc.), and `SpscPullResult`
  remain internal-only — Bridge consumes them from `./SpscRing.js` but
  `src/index.ts` does not re-export them. 0.6.10 is the deliberate
  promotion patch.
- **One unrelated internal change**: the test-only `_updateFlowScale`
  method on Bridge is now an underscore-prefixed instance method without
  a `private` TypeScript modifier (TS would flag it unused since the test
  reaches it through an `as unknown as { ... }` cast). It delegates
  through to `SpscRing._updateFlowScale`. Not part of the public API;
  subject to change without notice.

### Tests

All 6 suites green at the existing pin counts — no new pins added (the
extraction is validated by every existing pin remaining green):

- `tests/schema.test.ts` 14 pins.
- `tests/Bridge.test.ts` 60 pins (every smoothed-pull, invariant,
  flow-scale, PLL, trajectory, and evaluator pin from 0.6.7 passes
  through the seam unchanged).
- `tests/Bridge.phaseLock.test.ts`.
- `tests/Bridge.concurrent.test.ts` — 1,000,000-frame SPSC stress
  completes in ~600 ms with `emptyWaitTimeouts === 0` and
  `flow_scale envelope [0.500, 2.000]`. **This is the load-bearing
  validation for the seam.** Lost wake-ups, out-of-order seq, or a
  release/acquire regression in the extracted ring would flip the pin
  red within the first few hundred frames.
- `tests/Float64RingBuffer.test.ts` 9 pins.
- `tests/Float64RingBuffer.concurrent.test.ts`.

Bench medians at N=1000 unchanged from 0.6.7: push 1.20 μs, pull 1.20 μs,
pullLatest 1.20 μs (p99 1.50 μs across all three); `trajEval (fast)`
1.20 μs / `trajEval (clamp)` 4.80 μs; flow-scale recovery 33 cycles
(analytic ≈ 46). The pull-result scratch handoff and the extra method
call across the seam are both below the bench's resolution.

### Documentation

- `src/SpscRing.ts` carries the canonical SAB lane diagram, the
  release/acquire memory-ordering protocol, the counter representation
  detail (0.4.0), the always-notify protocol, the adaptive backpressure
  controller math (0.5.0), and the schema-dispatch overhead note.
  `src/Bridge.ts`'s file header is rewritten as a slim orchestrator
  description with a back-pointer comment to `SpscRing.ts` for the
  protocol detail, and retains the smoother / invariant classifier / PLL
  / evaluator sections (those are heap-side state machines that stay on
  Bridge).
- `CHANGELOG.md` — this entry.
- `README.md` — single roadmap line under the existing release sequence
  noting that 0.6.8 ships the internal SpscRing extract preparatory for
  the 0.6.10 composable exports.

## [0.6.7] — 2026-05-26

### Added — trajectory safety clamps

`f64TrajectoryArray(n, opts)` and its f32 twin gain four optional safety fields that make order-2 / order-3 Taylor extrapolation robust against transient producer values without changing the SAB byte layout.

- **`velocityClamp?: number`** — `|v_i|` capped pre-evaluation (both signs).
- **`accelerationClamp?: number`** — `|a_i|` capped pre-evaluation (order=3 only in practice; the spec accepts it on any order but the clamp is dormant at order ≤ 2).
- **`maxDeltaPerSample?: number`** — `|out[i] - out[i-1]|` capped post-evaluation. Sample 0 is always allowed (no prev).
- **`overflowFallback?: 'hold' | 'linear' | 'saturate'`** — consulted only when `maxDeltaPerSample` fires. Default `'saturate'` clamps the would-be output into `[prev - maxDelta, prev + maxDelta]`. `'hold'` freezes the signal at `prev`. `'linear'` drops the acceleration term and re-checks (collapses to saturate at order ≤ 2).

When no clamp is set the evaluator's fast path is preserved bit-exact equal to 0.6.6 across orders 1 / 2 / 3 (f64 + f32). When any clamp is set the evaluator switches to a clamped path that pre-resolves the spec into a small per-spec config (clamp values, fallback id) at function entry so the inner loop stays branch-free per call — no per-sample if/else on metadata. New exports: type `TrajectoryArrayOptions`, type `TrajectoryOverflowFallback`.

### Why — make order-3 trajectories safe under transient producer values

Order-2 and order-3 trajectory schemas trade producer-side derivative correctness for consumer-side extrapolation distance. The math is correct under the assumption that the derivatives are bounded by the underlying signal's bandwidth; a single transient (a numerical instability in the producer's PDE solver, a frame-boundary discontinuity, a `NaN`-to-large recovery glitch) propagates a huge velocity or acceleration straight into the audio block. At order=3 the quadratic term is especially fragile — a 100×-larger `a` blows the output by 100× in the next quantum.

The four clamp fields cover the three places extrapolation can go wrong: at the derivative load (`velocityClamp` / `accelerationClamp` cap the input pre-multiply), and at the output projection (`maxDeltaPerSample` caps successive-sample excursion). Pre-resolving the spec at function entry keeps the hot loop unrolled per-order and per-clamp-set — the fast path runs zero extra ops vs 0.6.6; the clamped path runs only the ops its config selects. This is the same dispatch shape as the 0.6.4 trajectory-aware smoother fix: behavior switched by precomputed metadata, not by per-sample branches.

Hermite interpolation was an alternative considered and deferred. Hermite would improve quality at the cost of changing the math contract (4-point stencil vs the current 1-point Taylor) and requires the producer to also publish a future sample. Clamps are the smaller, opt-in fix that doesn't change the wire shape or the producer pattern.

### Wire compatibility

- **No SAB changes.** Clamps are pure schema metadata. A clamp-equipped `TrajectorySpec` and its clamp-free twin produce identical frame bytes; a 0.6.7 producer and a 0.6.6 consumer (or vice versa) share a SAB transparently. Header lanes 0–3 unchanged from 0.6.0; lanes 4–7 still reserved.
- **No public-API breakage.** `f64TrajectoryArray(n, { order })` (no clamps) still works and produces a schema indistinguishable from one built without 0.6.7. All 0.6.6 call sites compile and execute unchanged. `TrajectorySpec`'s new fields are all optional.
- **Type-erased `SchemaLayoutFieldDescription.trajectory` carries the new optional fields.** `describeSchemaLayout(...)` propagates them to worklet-side inliners that read only the layout description; consumers that don't read the clamp fields see no change.

### Tests

`tests/schema.test.ts` grows from 13 to 14 pins:

- **`testTrajectoryClamps`** (pin #14) — every clamp field round-trips through `FieldSpec.trajectory` → `CompiledField.trajectory` → `SchemaLayoutFieldDescription.trajectory`; clamp-equipped and clamp-free schemas are byte-identical (`frameByteSize` matches); validation rejects non-finite / non-positive clamps (`0`, `-1`, `NaN`, `±Infinity`, strings, `null`) and unknown `overflowFallback` strings; trajectory tag stays frozen; f32 twin accepts the same opts.

`tests/Bridge.test.ts` grows from 55 to 60 pins:

- **`testTrajectoryVelocityClamp`** (pin #56) — order=2 with `velocityClamp: 2.0`; samples carrying `v = +10`, `v = -100`, `v = +1.5`, `v = -2.0` all classify correctly (clamped on overshoot, untouched in-band, untouched at boundary); dt=0 returns position regardless of clamp.
- **`testTrajectoryAccelerationClamp`** (pin #57) — order=3 with `accelerationClamp: 4.0`; samples with `a = +100`, `a = -1000`, `a = +2` evaluate to the expected `p + v·dt + ½·a_clamped·dt²` closed form.
- **`testTrajectoryHoldFallback`** (pin #58) — order=2 with `maxDeltaPerSample: 0.1` + `overflowFallback: 'hold'`; a square-wave-style transient (1.0 → 1.05 → 99 → 99.5 → 1.10) freezes at the held value for the duration of the spike and resumes when the raw signal returns within band. Bounded max |out| < 2.0 across the run.
- **`testTrajectoryDeltaSaturate`** (pin #59) — default `'saturate'` fallback bounds every per-sample step by `maxDelta`; against an alternating 0 / 100 input the output climbs / descends by exactly `maxDelta` per sample.
- **`testTrajectoryClampFreeBitExact`** (pin #60) — across orders 1 / 2 / 3 with N=128 mulberry32-seeded random fixtures, `evaluateTrajectoryInto` produces bit-identical output to the inlined Taylor formula; f32 spot check confirms order=2 byte-exact under f32 truncation. Sanity sub-pin shows the clamp path engages only when a clamp field is set.

All 6 test suites green (schema 14 pins / Bridge 60 pins / Bridge phase-lock / Bridge.concurrent / Float64RingBuffer 9 pins / Float64RingBuffer.concurrent). The clamp-free fast path bench cell holds the regression target (<1.25 μs at N=1000); the clamped path is documented as a separate median.

### Documentation

- `src/schema.ts` header gains a `Trajectory safety clamps (0.6.7)` section enumerating each clamp field and the fast-path / clamped-path dispatch contract; `TrajectorySpec` JSDoc covers each new optional field; `TrajectoryArrayOptions` and `TrajectoryOverflowFallback` are JSDoc'd at their declaration sites.
- `src/trajectory.ts` header gains a `Safety clamps (0.6.7)` section explaining the path split, the precomputed inner-loop config, and the per-fallback semantics.
- README `Trajectory arrays` subsection gains a clamp example and roadmap entry for 0.6.7.

## [0.6.6] — 2026-05-26

### Added — invariant epsilon floor + smoother named modes

Two independent heap-only DSP corrections shipped together. Both are wire-compatible and opt-in; every pre-0.6.6 schema and call site is preserved bit-exact on the default code path.

- **`.withInvariant(fn, opts?: { absoluteEpsilon })`** — second-argument opts bag adds an absolute lower floor to the invariant classifier's OK band. The OK comparator becomes `|computed − stored| < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`; relative error stays primary, the absolute floor catches subnormal-zero and tiny f64 rounding residues that the pre-0.6.6 pure-ratio classifier misclassified as hard. Default `1e-12`. Passing `{ absoluteEpsilon: 0 }` reproduces the pre-0.6.6 strict-ratio behavior. New exports: `DEFAULT_INVARIANT_ABSOLUTE_EPSILON`, type `WithInvariantOptions`.

- **`pullSmoothed` / `pullLatestSmoothed` now accept `opts?: { skipPolicy: 'stall-smooth' | 'catch-up' }`** — picks how `α_eff` responds when the consumer drains a backlog. Default `'stall-smooth'` is the legacy `α_eff = α_base · 2^(−skipped)` formula, bit-identical to 0.4.1..0.6.5 on every skipped value. Opt-in `'catch-up'` uses the closed-form `α_eff = 1 − (1 − α_base)^(skipped + 1)` — the math behind why a compounded EMA "should" use a larger α after a stall. Stall-smooth is click-suppression-first (large skips drive α→0, mostly trust prev); catch-up is chase-latency-first (large skips drive α→1, snap to the new frame). At `skipped = 0` both formulas degenerate to `α_eff = α_base` exactly, so `pullSmoothed` (always `skipped === 0`) accepts the option for API symmetry but it has no behavioral effect there. New exports: types `SmoothedPullOptions`, `SmootherSkipPolicy`.

### Why — two real-world bugs, neither worth a behavior change on the default path

**Invariant epsilon floor.** Pre-0.6.6 `_classifyInvariant` computed `delta = |c − s| / |s|` and treated `stored === 0` as a hard error unless `computed === 0` exactly. The relative-only form misfires in two situations both observed in the wavefunction-synth integration: (1) a schema whose invariant fn happens to return zero for the producer's quiescent state (e.g. `Σ|f|²` on a silence frame) blew up on the first frame where rounding flipped the consumer-side recompute to a subnormal nonzero; (2) a schema with very small but nonzero stored values (radio-band signal amplitudes ≲ 1e-15) classified pure f64 rounding noise (delta ≈ 1) as hard. Adding the absolute floor preserves the relative path for any non-trivial stored value while making the classifier robust on the boundary. The default `1e-12` is conservative: below `2^-40 ≈ 9 · 10^-13` most f64 sums are dominated by rounding, so `1e-12` is the smallest useful "treat as zero" band; users with tighter invariants (CRC32, xxhash) can pass `{ absoluteEpsilon: 0 }` and get the pre-0.6.6 strict behavior.

**Smoother named modes.** The "RFC review" 8/10→10/10 round-trip flagged the `2^(−skipped)` curve as audibly wrong for control surfaces and UI parameter changes — when the producer's post-stall value is a discontinuous correction (a knob turn, a synth voice retrigger), the consumer should snap, not drift. But for the wavefunction-synth use case the curve is right: a 60 Hz physics step stalling under GPU load and catching up at the next frame should NOT click-restart the audio voice envelope. The RFC's proposed unconditional swap to the compounded-EMA form would invert audible behavior for every existing caller. Shipping both formulas as named, opt-in policies — with the legacy formula as the default — lets each caller choose the right curve for their signal without breaking anyone.

### Wire compatibility

- **No SAB changes.** Both fixes are pure heap state on the consumer's Bridge instance. Header lanes 0–3 unchanged from 0.6.0; lanes 4–7 still reserved. A 0.6.5 peer and a 0.6.6 peer share a SAB transparently.
- **No public-API breakage.** `.withInvariant(fn)` (no opts) still works and yields a schema indistinguishable from one built with `{ absoluteEpsilon: 1e-12 }` — the default. `pullSmoothed(out, α)` and `pullLatestSmoothed(out, α)` still work with the legacy formula. All 0.6.5 call sites compile and execute unchanged.
- **`SchemaInvariantSpec` gains a non-optional `absoluteEpsilon: number` field.** Any caller reading `schema.invariant.absoluteEpsilon` (none in tree) now sees a numeric value instead of `undefined`. The field is always populated — the `makeSchema` factory defaults it to `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` for schemas without an explicit opt — so this is additive rather than breaking in practice.

### Tests

`tests/schema.test.ts` grows from 12 to 13 pins:

- **`testWithInvariantOpts`** (pin #13) — default-omit yields `DEFAULT_INVARIANT_ABSOLUTE_EPSILON = 1e-12`; explicit values thread onto `Schema.invariant.absoluteEpsilon`; `0` is permitted (reproduces pre-0.6.6 behavior); empty opts and `{ absoluteEpsilon: undefined }` fall back to the default; NaN / Infinity / negative / non-numeric / null opts all reject; schema with opts stays frozen.

`tests/Bridge.test.ts` grows from 53 to 55 pins:

- **`testInvariantEpsilonFloor`** (pin #54) — directly mutates the stored `__invariant` SAB lane to engineer a `(computed = 0, stored = 1e-15)` pair on a schema whose invariant fn returns the constant 0. Under default opts (`1e-12` floor) the pair classifies OK (no tornFrames, raw payload passes through); under `{ absoluteEpsilon: 0 }` the same pair classifies HARD (1 tornFrame, prev fallback) — proves the floor is what's doing the work. A third sub-pin asserts non-trivial-stored cases are unaffected: stored = 100, computed = 0 still classifies HARD because the relative term (`1e-3 · 100 = 0.1`) dominates the OK band over the `1e-12` floor.
- **`testSmootherCatchUpPolicy`** (pin #55) — sweep `skipped ∈ {0, 1, 5, 10}` against `α_base = 0.25` and assert: (a) explicit `'stall-smooth'` matches the closed form `α_base · 2^(−skipped)`; (b) default-omit (no third arg) is bit-exact equal to explicit `'stall-smooth'` on every skipped value, including the array path; (c) explicit `'catch-up'` matches `1 − (1 − α_base)^(skipped + 1)`; (d) at `skipped = 0` both policies converge exactly; for `skipped > 0` the policies diverge and `α_catch > α_stall`. Adds a parallel-ring assertion that `pullSmoothed` (always `skipped === 0`) produces identical output under both policies.

All 5 test suites green (schema 13 pins / Bridge 55 pins / Float64RingBuffer 9 pins / both concurrent stresses). Bench medians at N=1000 unchanged from 0.6.5: push 1.20 μs, pull 1.20 μs, pullLatest 1.20 μs.

### Documentation

- `src/schema.ts` header `Schema invariants` block updated to advertise the new opts arg; `WithInvariantOptions` and `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` carry JSDoc explaining the 1e-12 default and the `0` escape hatch.
- `src/Bridge.ts` header `Smoothed pulls` block rewritten to enumerate both policies and their click-vs-chase tradeoffs; `_classifyInvariant` doc spells out the `max(eps, OK · |stored|)` band.
- README `Schema invariants` and `Smoothed pulls` subsections add per-policy worked examples.

## [0.6.5] — 2026-05-26

### Added — timestamp roles + `pullEvaluatedLatest` / `evaluateAtSampleOffset` sugar (Pillar 3 second cut)

The hand-rolled pull + observe + per-sample-dt + evaluate loop from 0.6.3 collapses to two method calls per quantum. The canonical AudioWorklet pattern:

```ts
const skipped = bridge.pullEvaluatedLatest(evalFrame, currentTime * 1e9, sampleRate);
for (let i = 1; i < 128; i++) {
  bridge.evaluateAtSampleOffset(evalFrame, i);
  block[i] = synth.step(evalFrame.vEff);
}
```

Three building blocks make this work:

- **`defineSchema({...}).withTimestamps({ roleName: { field, unit, default? } })`** — declares one or more named timestamp roles on the schema. Each role points at an existing numeric scalar field and labels its unit (`'ns' | 'us' | 'ms' | 's' | 'samples'`). A producer that ships multiple clocks (macro / GPU / audio-frame index) declares all of them; each consumer picks the role most natural for its math. The first declared role (or one flagged `default: true`) is the default; per-call `{ timestamp: 'roleName' }` overrides it. Role names are **compile-time-checked** at every call site via the new `TimestampRoleOf<S>` type helper — typos surface as TypeScript errors, not runtime "unknown field" exceptions.

- **`bridge.pullEvaluatedLatest(out, baseConsumerNs, sampleRate?, opts?) → number`** — drain to newest, observe the PLL with the freshly-pulled timestamp, evaluate sample 0 of the quantum into `out`, and cache state for subsequent `evaluateAtSampleOffset` calls. Returns the skipped-frame count on fresh-pull; returns `-1` when the ring is empty (if the cache is valid from a prior pull, `out` is still populated from cache — the PLL is NOT re-observed, since a repeated stale stamp at advancing consumer times would poison the residual). The first-quantum-empty case leaves `out` untouched (zero-initialized silence via `scratchEvaluatedFrame()`).

- **`bridge.evaluateAtSampleOffset(out, sampleOffset) → void`** — reads the cached raw frame, computes `consumerNs = base + sampleOffset / sampleRate · 1e9`, runs `phaseLockedTime(...)` to map into producer-clock space, computes `dt_s = (producerEstimate − cachedTimestampNs) · 1e−9`, and calls `evaluateInto`. Heap-only — never touches the SAB.

- **`bridge.setSampleRate(rate)`** — registers a default so `pullEvaluatedLatest`'s `sampleRate` arg can be omitted. Per-call value wins precedence if both are set. Throws if neither is set when `pullEvaluatedLatest` runs.

- **`bridge.resetEvalCache()`** — invalidates the cache shared by `pullEvaluatedLatest` / `evaluateAtSampleOffset`. Independent of `resetSmoother()` and `resetPll()` — three orthogonal caches. Use on `AudioContext` suspend/resume or producer-epoch changes.

Internal: `_timestampToNs(value, unit, sampleRate)` converts each supported unit to nanoseconds (`samples` uses the per-call rate). A future `'custom'` escape hatch with a caller-supplied `toNs` multiplier is documented but deferred — the implementation site is a single switch case.

### Why — three new heap-only consumer-side primitives, no wire-format change

After 0.6.1 (trajectory schema), 0.6.2 (consumer PLL), and 0.6.3 (per-frame evaluator), every AudioWorklet that wanted Pillar 1+2+3 composed those primitives by hand:

```ts
// pre-0.6.5 manual pattern
if (this.bridge.pullLatest(this.rawFrame) < 0) return true;
this.bridge.observeConsumerTime(currentTime * 1e9, Number(this.rawFrame.tMacroNs));
for (let i = 0; i < 128; i++) {
  const cNs = currentTime * 1e9 + (i / sampleRate) * 1e9;
  const dtNs = this.bridge.phaseLockedTime(cNs) - Number(this.rawFrame.tMacroNs);
  this.bridge.evaluateInto(this.rawFrame, dtNs * 1e-9, this.evalFrame);
  block[i] = this.synth.step(this.evalFrame.vEff);
}
```

Five concerns mixed: empty-pull handling, clock observation, per-sample base-time math, unit conversion (`1e-9`), per-sample evaluation. Easy to get wrong. The 0.6.5 sugar bundles all five and pins the contract: the PLL is observed only on fresh-pulls; sample-offset arithmetic uses the cached quantum context; unit conversion is schema-driven. Identity tests verify the sugar produces bit-equivalent output to the hand-rolled loop.

The role system is the type-safe layer above raw field names. A typed selector (`{ timestamp: 'gpu' }` checked against `TimestampRoleOf<S>`) lets every project name their timestamp fields differently — Wavefunction uses `tMacroNs`, a game engine might use `tick`, a physics sim uses `simulationTime`, an audio renderer uses `sampleFrame` — without forcing a global convention. Roles are declared once at schema-author time; callers consume by role, not by field name.

### Wire compatibility

- **No SAB changes.** All new state is heap-only on the consumer's Bridge instance. Header lanes 0–3 unchanged from 0.6.0; lanes 4–7 still reserved. A 0.6.4 peer and a 0.6.5 peer share a SAB transparently.
- **`Schema<F>` gains a second optional generic parameter** (`Schema<F, T extends TimestampsConfig<F> | null = null>`) carrying compile-time role information. The default `T = null` keeps every existing `Schema<F>` usage backwards-compatible at the type level. `FrameFor<S>` was updated to extract `F` regardless of `T` (`S extends Schema<infer F, any>`).
- **API additions only.** New methods on `Bridge`: `setSampleRate`, `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `resetEvalCache`. New schema method: `.withTimestamps(config)`. `describeSchemaLayout(...)` return shape gains a `timestamps: SchemaTimestampsSpec | null` field. No removed or renamed members.

### Tests

`tests/schema.test.ts` grows from 11 to 12 pins:

- **`testWithTimestamps`** (pin #12) — declares two roles with one flagged default; default-flag and first-declared fallback both work; the spec propagates to `describeSchemaLayout`; composes with `.withInvariant(...)` in either order; rejects unknown field / array field / invalid unit / two defaults / empty config / bad role identifier / null config.

`tests/Bridge.test.ts` grows from 49 to 53 pins:

- **`testPullEvaluatedLatestRoundTrip`** (pin #50) — two Bridges with identical SAB streams driven side-by-side: one via the 0.6.5 sugar, one via the 0.6.3 manual loop. 100 quanta × 128 samples = 12 800 samples; every sample bit-exact across the two paths.
- **`testTimestampRoleResolution`** (pin #51) — default role picked when `opts.timestamp` omitted; per-call override picks the alt role; unknown role throws; schema without `.withTimestamps()` throws on `pullEvaluatedLatest`; `resetEvalCache` invalidates so `evaluateAtSampleOffset` throws until next pull.
- **`testSampleRateResolution`** (pin #52) — per-call sampleRate works without `setSampleRate`; registered default works with per-call omitted; per-call wins precedence over registered; both omitted → throws; `setSampleRate(rate)` rejects 0 / negative / NaN / ±Infinity.
- **`testTimestampUnitConversion`** (pin #53) — same producer stamp expressed in `ns` / `us` / `ms` / `s` / `samples` units; bridge converts each correctly such that `dt = 0` at sample 0 when `baseConsumerNs` matches the ns-equivalent.

### Documentation

- New `Timestamp roles (0.6.5)` section in `src/schema.ts` header documenting the role concept, units, validation rules, and the wire-compat guarantee (descriptive only, no SAB layout change).
- New `Per-frame evaluator sugar (0.6.5, Pillar 3 second cut)` section in `src/Bridge.ts` header documenting the three building blocks (roles, cache, unit conversion), the sample-rate handling, the cache-fallback semantics on empty pulls, and the `resetEvalCache` lifecycle.
- JSDoc on `.withTimestamps`, `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `setSampleRate`, `resetEvalCache` covers each contract.
- README gains a `#### Timestamp roles + pullEvaluatedLatest sugar` subsection under `Schema DSL` with the canonical worklet example collapsed from five lines to two. Roadmap `Shipped` adds the 0.6.5 entry.

## [0.6.4] — 2026-05-26

### Fixed — trajectory × α-smoother: derivative lanes were being blended

Pre-0.6.4, `pullSmoothed` / `pullLatestSmoothed` ran the one-pole blend across every element of every array field — including the velocity and acceleration lanes of `f{32,64}TrajectoryArray(n, { order: ≥2 })`. Blending a derivative across consecutive frames collapses the very signal the trajectory ships to preserve: under a perfectly linear position ramp the producer publishes a constant velocity, but the consumer's α-smoothed velocity would drift toward the previous-frame velocity at the smoother's time constant. Linear extrapolation built on the smoothed frame would then under- or over-shoot the true trajectory.

Fix in `_applySmoother`:

- **Plain arrays and order-1 trajectories**: unchanged (every element blends — order=1 is byte-identical to a positions-only array).
- **order=2 trajectories**: blend only the position lanes (`j % 2 === 0`); copy velocity lanes (`j % 2 === 1`) verbatim from curr.
- **order=3 trajectories**: blend only the position lanes (`j % 3 === 0`); copy velocity + acceleration lanes verbatim from curr.

Precomputed per-array `arrayTrajectoryOrder` table drives the dispatch — no per-call branch on field metadata; the existing tight indexed walk over `arrayLayout` keeps its shape.

This is the smallest correctness change in 0.6.4. It is technically a behavior change visible to existing callers that pulled a trajectory schema through `pullSmoothed`, so it ships alone as the headline fix of the patch.

### Added — four test pins (one inline FFT)

Four new pins make the 0.6.1 → 0.6.3 trajectory + PLL + per-frame-evaluator surface mechanically auditable:

- **Pin #47 — trajectory × α-smoother interop** (`tests/Bridge.test.ts`). Schema with plain array + order=1 + order=2 + order=3 trajectory in one fixture. Push A; pullSmoothed (seed). Push B; pullSmoothed at `α=0.25` → positions blend per the existing contract; velocity / acceleration lanes pass through verbatim from B; a third pullSmoothed of B confirms derivatives don't drift across repeated calls. Regression pin for the fix above.

- **Pin #48 — trajectory × invariant interop** (`tests/Bridge.test.ts`). Same trajectory schema with two different `.withInvariant(fn)` choices: positions-only and positions + velocities. SAB-mutation pattern from pins #35–#38 applied to a velocity lane post-push. Asserts classification differs by invariant choice: positions-only → ratio = 1 → OK pull, mutated velocity passes through; positions + velocities → ratio past SOFT threshold → hard error, last-known-good fallback, `tornFrames++`. Documents the recommended pattern for trajectory-aware invariants.

- **Pin #49 — end-to-end pull-lag p95 < 3 ms** (`tests/Bridge.test.ts`). Faked-clock discrete-event scheduler: 60 Hz producer (period 16_666_667 ns) stamps `decisionTimeNs = now`; 375 Hz consumer (= 48 kHz / 128-sample quantum, period 2_666_667 ns) calls `pullLatest`. Each successful pull records `now − decisionTimeNs`. Assertion: p95 across 10 k pulls is < 3 ms. Measured: p50 = 1.33 ms, p95 = 2.01 ms, p99 = 2.02 ms, max = 2.02 ms — under the cadence's analytic bound (uniform on [0, 2.67 ms]). Pins the bridge's *own* contribution to control→audio latency; real-world AudioContext latency stays in `bench/e2e-latency/`.

- **`tests/Bridge.phaseLock.test.ts` — phase-lock FFT spectrum** (the headline marketing pin). Producer (60 Hz, order=2 trajectory carrying `signal(t) = sin(2π·f·t)` + `signal'(t) = 2π·f·cos(2π·f·t)`) feeds a consumer that captures 16 384 audio samples (~0.34 s) under **two** reconstruction strategies side-by-side: step-and-hold and linear-Taylor (`evaluateInto`). Both buffers pass through an inline Cooley-Tukey radix-2 FFT (≈50 LOC, no dev-dep) under a Hann window. Pin asserts (a) the signal bin dominates both spectra within ±6 dB and (b) at every 60 Hz harmonic in `[60, 120, 180, 240, 300, 360, 420, 480]` Hz, the trajectory spectrum sits **at least 10 dB below** the step spectrum. Measured: 12–19 dB suppression at every harmonic, absolute trajectory floor −44 dB or quieter. This is the marketing claim "60 Hz GPU producer drives 48 kHz audio with collapsed staircase aliasing" made testable; the math (sinc² envelope of linear interp vs sinc of step+hold) gives the suppression for free at sub-Nyquist signal frequencies.

Test suite count: 5 → 6 (the new `Bridge.phaseLock.test.ts` joins `schema` / `Bridge` / `Bridge.concurrent` / `Float64RingBuffer` / `Float64RingBuffer.concurrent`). Bridge pin count: 46 → 49.

### Why — drain a correctness liability, then audit the new surface

The handoff doc for this session (`WebsitePlans/WebAudioBridge Phase-Locked Extrapolation - Handoff Post 0.6.3.md`) flagged the trajectory × α-smoother bug as a real correctness issue introduced by 0.6.1's trajectory layout and not yet caught by tests. The recommended sequencing — fix it before adding new public surface — keeps the patch focused and avoids riding a behavior bug into later releases. The four pins then audit the entire 0.6.1–0.6.3 stack at the points the deferred-work plans (`pullEvaluated` sugar, EvalMode dispatch, per-quantum batch API) will compose against next.

### Wire compatibility

- **No SAB changes.** The smoother fix is heap-only consumer-side; the test pins are pure additions. Header lanes 0–3 unchanged from 0.6.0; lanes 4–7 still reserved. A 0.6.3 peer and a 0.6.4 peer share a SAB transparently.
- **API additions only.** No removed or renamed members. The smoother fix changes the *output* of `pullSmoothed` / `pullLatestSmoothed` for order≥2 trajectory schemas (derivative lanes now reflect curr verbatim rather than the previous blended derivative); the *signatures* are unchanged. Schemas without trajectory fields are byte-identical to 0.6.3 behavior.

### Documentation

- New paragraph in the `Smoothed pulls` section of `src/Bridge.ts` header documenting the trajectory-aware rule (positions blend; velocity + acceleration pass through verbatim) and the precomputed `arrayTrajectoryOrder` dispatch.
- JSDoc on the `arrayTrajectoryOrder` field explains the 0-vs-order encoding (0 = plain or order-1; ≥2 = strided-blend path).
- `tests/Bridge.test.ts` header gains entries #47–#49 with the same numbered-template style as the rest of the file.
- `tests/Bridge.phaseLock.test.ts` carries a substantial file-header walkthrough: test setup, expected spectrum derivation (sinc vs sinc²), assertion shape, and the rationale for the inline FFT over a dev-dep.

## [0.6.3] — 2026-05-25

### Added — per-frame trajectory evaluator (Pillar 3 of phase-locked extrapolation, first cut)

0.6.1 made trajectory fields a first-class schema concept and shipped a per-field consumer-side evaluator (`evaluateTrajectoryInto`). 0.6.2 made the consumer↔producer clock relationship a first-class bridge concept (`observeConsumerTime` / `phaseLockedTime`). 0.6.3 closes the per-frame evaluation gap: the bridge now walks the whole schema in one call, applying the Pillar 1 evaluator to every trajectory field and passing everything else through. The full pull → observe → evaluate loop becomes three method calls per audio quantum instead of a hand-rolled per-field iteration.

- **`bridge.evaluateInto(srcFrame, dt, outFrame)`** — heap-only per-frame evaluator. Walks `compiled.fields`:
  - **Trajectory field** → `evaluateTrajectoryInto(srcFrame[name], spec, dt, outFrame[name])`. Out frame's trajectory field must have length ≥ `spec.sampleCount` (positions only — the source is `sampleCount * order`, the output is `sampleCount` after Taylor evaluation).
  - **Non-trajectory array** → `outFrame[name].set(srcFrame[name])`.
  - **Scalar (number or BigInt)** → `outFrame[name] = srcFrame[name]`.

  Pure function — no internal state, no SAB access, no atomic ops. Allocation-free against caller-owned buffers. Safe to call repeatedly at audio rate without cache-line pingpong against the producer (which can be writing the *next* frame while the consumer re-evaluates the *current* one in private heap memory).

- **`bridge.scratchEvaluatedFrame()`** — sugar allocator that returns a fresh out-frame with trajectory fields sized to `sampleCount` instead of `sampleCount * order`. Mirrors `scratchFrame()` for everything else (non-trajectory arrays at full length, scalars zero-initialized). Call once at consumer init outside the hot loop; reuse on every `evaluateInto`.

- **Canonical AudioWorklet pattern** (Pillars 1 + 2 + 3 stacked):

  ```ts
  const trajSpec = schema.compiled.fields.find((f) => f.name === "vEff")!.trajectory!;
  this.rawFrame = this.bridge.scratchFrame();          // pulled-frame shape (sampleCount * order)
  this.evalFrame = this.bridge.scratchEvaluatedFrame(); // post-eval shape (sampleCount)

  process(_inputs, outputs) {
    const block = outputs[0][0]; // 128 samples
    if (this.bridge.pullLatest(this.rawFrame) < 0) return true;
    const quantumNs = currentTime * 1e9;
    this.bridge.observeConsumerTime(quantumNs, Number(this.rawFrame.tMacroNs));
    for (let i = 0; i < block.length; i++) {
      const cNs = quantumNs + (i / sampleRate) * 1e9;
      const dtNs = this.bridge.phaseLockedTime(cNs) - Number(this.rawFrame.tMacroNs);
      this.bridge.evaluateInto(this.rawFrame, dtNs * 1e-9, this.evalFrame);
      block[i] = this.synth.step(this.evalFrame.vEff);
    }
    return true;
  }
  ```

  Three method calls per quantum + per-sample evaluation in the inner loop. The full Pillar 3 plan replaces all of that with a single `bridge.pullEvaluated(out, sampleOffset, sampleRate)` call (deferred — see below).

### Why — close the per-field iteration gap

After 0.6.1 and 0.6.2 the trajectory + PLL primitives existed but composing them at audio rate still meant a hand-written per-field loop in every consumer:

```ts
for (const field of trajectoryFields) {
  evaluateTrajectoryInto(rawFrame[field.name], field.spec, dt, evalFrame[field.name]);
}
for (const field of nonTrajectoryFields) { /* copy */ }
```

That's repeated in every worklet, easy to get wrong (field iteration order, length mismatches between rawFrame and evalFrame, forgetting to pass through non-trajectory fields). `evaluateInto` collapses it to one call that's guaranteed to walk every field in compiled order, with the right dispatch per kind, against a `scratchEvaluatedFrame()`-shaped out buffer that's known-correct for the schema.

It also unlocks the per-sample evaluation pattern at audio rate: the same `evaluateInto` call runs in a tight inner loop with different `dt` per sample. Heap-only + allocation-free + no atomic ops means it's bounded-cost regardless of how often the consumer pulls (which is the entire point of decoupling pull from evaluation).

### Wire compatibility

- **No SAB changes.** evaluateInto and scratchEvaluatedFrame are heap-only consumer-side methods. Header lanes 0-3 unchanged from 0.6.0; lanes 4-7 still reserved. A 0.6.2 peer and a 0.6.3 peer share a SAB transparently.
- **API additions only.** No removed or renamed members. No changes to `pull` / `push` / `pullLatest` / `pullSmoothed` / `telemetry` / `observeConsumerTime` / `phaseLockedTime` semantics.

### Tests

`tests/Bridge.test.ts` grows from 43 to 46 pins:

- **`testEvaluateIntoMixedSchema`** (pin #44) — schema with all three trajectory orders absent / present (u64 scalars, f64 scalar, u8Array non-trajectory, f64 order=2 trajectory, f32 order=3 trajectory). `scratchEvaluatedFrame` sizes trajectory fields to `sampleCount` and non-trajectory arrays at full length. Evaluation at `dt = 0.5` matches closed-form `p + v·dt` (order=2) and `p + v·dt + ½·a·dt²` (order=3) bit-exactly. Scalars and non-trajectory arrays copy verbatim. `dt = 0` returns positions exactly. No hidden state between calls (re-evaluation reproduces).

- **`testEvaluateIntoNoTrajectorySchema`** (pin #45) — degenerate case on `physicsControlFrameSchema(4)`. Every field is non-trajectory; evaluateInto reduces to a pure memcpy. `dt` is irrelevant (does not leak into output). Useful primitive for snapshotting frames without forcing trajectory migration.

- **`testEvaluateIntoValidation`** (pin #46) — non-finite `dt` (NaN, ±Infinity) throws. Out-frame trajectory field shorter than `sampleCount` surfaces `evaluateTrajectoryInto`'s error message (we deliberately don't pre-validate to avoid double-checking the same contract).

### Documentation

- New `Per-frame evaluator (0.6.3, Pillar 3 first cut)` section in `src/Bridge.ts` header documenting the field-walk dispatch, the heap-only contract, the src/out shape requirements, and what's deferred (`pullEvaluated` sugar, EvalMode dispatch, per-quantum batch API).
- JSDoc on `evaluateInto` and `scratchEvaluatedFrame` covers the per-field semantics, the dt unit contract, and the canonical AudioWorklet integration pattern.
- README gains a `#### Per-frame evaluator` subsection under the Phase-locked loop block, with the full pull + observe + evaluate AudioWorklet example showing Pillars 1 + 2 + 3 stacked.
- Roadmap `Shipped` adds the 0.6.3 entry; "phase-locked extrapolation" stays on the active roadmap with Pillar 2 extensions (drift estimator, outlier gate, lane publication) and Pillar 3 sugar (`pullEvaluated`, EvalMode dispatch) still ahead.

## [0.6.2] — 2026-05-25

### Added — consumer-side phase-locked loop (Pillar 2 of phase-locked extrapolation, first cut: offset only)

0.6.1 shipped the schema half of phase-locked extrapolation: producers can pack derivatives into a frame and consumers can Taylor-extrapolate via `evaluateTrajectoryInto`. The remaining gap was clock recovery — the consumer needs to know the elapsed time between a pulled frame's `tMacroNs` stamp and the audio-rate sample it's about to compute, sub-microsecond, against a producer clock that can jitter (`mapAsync` stalls) and drift (clock-domain crossings between Worker `performance.now()` and `AudioContext.currentTime`). 0.6.2 lands the consumer-side PLL that fills that gap.

- **`bridge.observeConsumerTime(consumerNs, producerNs)`** — consumer-side observation point. Pair the producer-stamped timestamp from a recently-pulled frame with the consumer's wall-clock at the moment of observation; the bridge runs one PI cycle. First call seeds the offset exactly (`pllOffsetNs = producerNs - consumerNs`, `pllLocked = true`); subsequent calls update via:

  ```
  residual = (producerNs - consumerNs) - pllOffsetNs
  integral = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
  pllOffsetNs += PLL_KP · residual + PLL_KI · integral
  ```

  ~5 arithmetic ops + 2 compares + 2 finite-checks per call. Allocation-free. Safe to call from an AudioWorklet's `process()` loop.

- **`bridge.phaseLockedTime(consumerNs) → number`** — map a consumer-clock reading into the producer's frame of reference. Returns `consumerNs + pllOffsetNs` once locked, `consumerNs` unchanged before lock. One add + one boolean check. Safe at audio rate. Typical pattern (the canonical pre-Pillar-3 hand-rolled loop):

  ```ts
  for (let i = 0; i < 128; i++) {
    const consumerNs = (currentTime + i / sampleRate) * 1e9;
    const dtNs = bridge.phaseLockedTime(consumerNs) - Number(frame.tMacroNs);
    evaluateTrajectoryInto(frame.vEff, spec, dtNs * 1e-9, out);
    synth.step(out[i]);
  }
  ```

- **`bridge.resetPll()`** — flip back to unlocked. Use on AudioContext suspend/resume, when the producer reconnects with a different `tMacroNs` epoch, or whenever the consumer's clock domain visibly jumps. Does not touch `consumerPrev` or `piIntegral` — the PLL, α-smoother, and flow-scale controller are independent state machines; pair with `resetSmoother()` if you want to drop both.

- **`bridge.telemetry()` gains two fields:** `pllLocked: boolean` and `pllOffsetNs: number` — the heap snapshot of the consumer-side PLL state. The PLL is heap-only on the consumer's Bridge instance; the producer side reading its own `telemetry()` sees its own PLL state (which is permanently unlocked unless that side also runs observations).

### Why — break the latency / phase tradeoff incrementally

The full Pillar 2 design (in [`WebsitePlans/WebAudioBridge Beyond 1 and 4 - Phase-Locked Extrapolation Plan.md`](../NewProject/website/WebsitePlans/WebAudioBridge%20Beyond%201%20and%204%20-%20Phase-Locked%20Extrapolation%20Plan.md)) calls for a drift estimator, an outlier gate, and cross-process observability via lanes 4-5. 0.6.2 ships the *core PI loop on offset only* — the smallest piece that gives a measurable improvement over no clock recovery at all. With `PLL_KP = 0.2` a fresh constant offset converges to within 1 μs in ~30 observations (geometric residual decay at 80 % per cycle); with `PLL_KI = 0.01` constant drift settles in a few seconds. This is enough for the most common case — both peers on the same machine with sub-ppm clock drift between `performance.now()` and `AudioContext.currentTime`.

What 0.6.2 does NOT do (still in the Pillar 2 plan, queued for follow-up patches):

- **Drift estimator** — second integrator over residuals normalized by inter-observation dt, tracking ppm. Improves long-term lock under heavy clock-domain drift.
- **Mahalanobis outlier gate** — reject `mapAsync` stalls so a single 30 ms residual spike doesn't poison the offset estimate.
- **Cross-process observability** via lanes 4-5. Producer reads the consumer's offset estimate for unified telemetry / DevTools dashboards. The 0.6.2 cut keeps the wire format byte-for-byte identical to 0.6.1.

### Wire compatibility

- **No SAB changes.** All PLL state lives on the consumer's Bridge instance (heap). Header lanes 0-3 remain as in 0.6.0; lanes 4-7 stay reserved. A 0.6.1 peer and a 0.6.2 peer share a SAB transparently.
- **API additions only.** `observeConsumerTime`, `phaseLockedTime`, `resetPll` are new public methods; the `telemetry()` return type gains two fields (`pllLocked`, `pllOffsetNs`). No removed or renamed members.

### Tests

`tests/Bridge.test.ts` grows from 40 to 43 pins:

- **`testPllColdStart`** (pin #41) — fresh Bridge: `telemetry().pllLocked === false`, `pllOffsetNs === 0`, `phaseLockedTime(x) === x`. First `observeConsumerTime(c, p)` seeds: `pllOffsetNs === p - c` exactly, `pllLocked === true`, no PI math runs. `phaseLockedTime(c) === p` post-seed; any other consumer time gets the same offset applied.

- **`testPllConvergence`** (pin #42) — seed at 10 ms below truth, feed 50 observations against a constant 50 ms true offset with ±100 μs of synthetic jitter per observation. Asserts the heap estimate converges to within 50 μs of truth (jitter-floor-respecting bound). The Kp=0.2 geometric decay alone closes a 10 ms residual in ~41 cycles, so 50 cycles has headroom.

- **`testPllStepAndResetAndValidation`** (pin #43) — three behaviors. Step response: lock at offset=0, jump to 1 ms offset, drive 200 cycles, assert residual < 1000 ns. `resetPll()`: flips back to unlocked, zeros state, next observation re-seeds exactly. Argument validation: `NaN` / `±Infinity` for either argument throws.

### Documentation

- New `Phase-locked loop (0.6.2, Pillar 2 first cut — offset only)` section in `src/Bridge.ts` header documenting the PI derivation, the heap-only storage rationale, the lock state machine, convergence properties, and the deferred follow-up items.
- JSDoc on `observeConsumerTime`, `phaseLockedTime`, `resetPll`, and the updated `telemetry()` covers the new contracts.
- README gains a `#### Phase-locked loop` subsection under `Schema DSL` with a worked AudioWorklet-pattern example showing trajectory + PLL combined (the Pillar 1 + Pillar 2 stack as designed).
- Roadmap `Shipped` adds the 0.6.2 entry; "phase-locked extrapolation" stays in the active roadmap with Pillars 2-extensions and Pillar 3 (`bridge.pullEvaluated`) still ahead.

## [0.6.1] — 2026-05-25

### Added — trajectory arrays (Pillar 1 of phase-locked extrapolation)

The bridge has historically packed *state* into a frame — a sampled position at the producer's timestamp. The consumer that wanted continuous-time output had to guess the derivative from sampled history (the 0.4.1 α-smoother does this implicitly) or accept step-function aliasing at the producer's rate. The producer almost always knows the derivative exactly — a GPU physics shader computes velocity and acceleration as part of its update — and 0.6.0's schema DSL is extensible. 0.6.1 ships the additive schema constructors that let the producer pack derivatives directly into the frame, and a single consumer-side Taylor evaluator that reads them.

- **`f64TrajectoryArray(n, { order })`** and **`f32TrajectoryArray(n, { order })`** — new schema field constructors next to the existing `f{32,64}Array(n)`. The underlying storage is a flat interleaved typed-array of `n * order` elements:
  - **`order: 1`** — positions only. Byte-identical to `f{32,64}Array(n)`. Lets a schema opt in field-by-field without changing wire format yet.
  - **`order: 2`** — `[p0, v0, p1, v1, ..., p_{n-1}, v_{n-1}]`. Linear Taylor extrapolation: `value(dt) = p + v · dt`.
  - **`order: 3`** — `[p0, v0, a0, p1, v1, a1, ...]`. Quadratic Taylor / cubic Hermite: `value(dt) = p + v · dt + ½ · a · dt²`.

  Order is restricted to `1 | 2 | 3` at both the TS literal-type level and the runtime validator. Higher orders on a unitary stepper are an open research direction — deferred until there is a concrete consumer for them.

- **`TrajectorySpec`** (`{ order, sampleCount }`) is a new tag on `FieldSpec`, `CompiledField`, and `SchemaLayoutFieldDescription`. Same shape in all three views so main-thread consumers (which see `Schema`) and worklet-side inliners (which see `SchemaLayoutDescription`) read it from one nested location with no cross-referencing. The tag is descriptive — the codec walks the flat element count exactly like any other array — so non-trajectory consumers ignore it transparently.

- **`evaluateTrajectoryInto(flat, spec, dt, out)`** — the single consumer-side hot-path helper. Overloaded for `Float64Array` and `Float32Array`. Allocation-free against the caller's pre-allocated `out` buffer. The order switch happens once per call (out of the loop); the inner loops are branch-free. Six ALU ops per sample at order=2; eight at order=3. Expected cost ~5–10 ns/sample on a modern x86, well under the 50 ns/sample budget the plan targets for the eventual Bridge-integrated `evaluateInto`.

- **`dt` and unit handling.** The evaluator is unit-agnostic — the producer chose the units of velocity / acceleration when it packed the frame, and the consumer supplies a matching `dt` (`units/second → dt in seconds`, `units/ns → dt in ns`). Clock recovery is the consumer's responsibility until Pillar 2 (PLL) lands; until then, the typical pattern is `dt = (consumerNowNs - frame.tMacroNs) * 1e-9`.

### Why — derivatives the producer already knows, paid forward into audio

A GPU physics shader stepping a wave equation, an FDTD lattice, a spring-mass network, or the wavefunction synth's Strang-split unitary evolution computes velocities (and frequently accelerations) as part of its update. That data has historically been discarded at the SAB boundary, leaving the consumer to estimate derivatives from sampled history with a one-frame lag (α-smoother) or accept the step-function aliasing of pure pull-latest. Both choices waste information the producer already has.

Packing the derivative into the frame and letting the consumer evaluate `p + v · dt` at audio rate is the trivial change that lets the consumer reconstruct a continuous-time signal *consistent with the producer's PDE by construction* — not a numerical approximation. For a unitary stepper (Strang split, leapfrog), the Taylor remainder is bounded by `O(dt²)` at order 2 and `O(dt³)` at order 3 — small in absolute terms over the sub-millisecond `dt` between successive audio-thread evaluations and the most-recent macro-frame timestamp.

Interleaved layout (`[p0, v0, p1, v1, ...]` rather than concatenated `[p0, p1, ..., v0, v1, ...]`) keeps each sample's position and derivatives cache-line adjacent so the evaluator walks the trajectory in one pass with minimal L1 misses for typical `N=128–2048` voice grids.

### Wire compatibility

- **No-trajectory schemas are unaffected.** Existing `f64Array(n)` / `f32Array(n)` fields read and write byte-for-byte as in 0.6.0; no field carries a `trajectory` tag unless explicitly opted in via `f{32,64}TrajectoryArray`. Pure additive metadata.
- **`f{32,64}TrajectoryArray(n, { order: 1 })` is wire-compatible with `f{32,64}Array(n)`.** A 0.6.0 peer cannot tell the difference — same byte layout, same byte count. Only the field's compiled metadata differs.
- **`order: 2` and `order: 3` change the field's byte count** (`n × order × bytesPerElement` instead of `n × bytesPerElement`). A schema that swaps `f64Array(64)` for `f64TrajectoryArray(64, { order: 2 })` doubles that field's footprint and produces a different total frame stride. Producer and consumer must agree on the schema (as always).
- **No header lane changes.** Lanes 0–3 stay as in 0.6.0; lanes 4–7 still reserved (Pillar 2's PLL will use lanes 4–5 in a future release).

### Tests

`tests/schema.test.ts` grows from 9 to 11 pins:

- **`testTrajectoryArrays`** — DSL layer (pin #10). `f64TrajectoryArray(n, { order: 1 })` is byte-identical to `f64Array(n)`; `order: 2` doubles the flat length and stores the trajectory tag; `f32TrajectoryArray` round-trips with `kind: "f32"` and any order. Tag propagates through `defineSchema` → `CompiledField` → `describeSchemaLayout`. Invalid orders (0, 4, 2.5) and invalid sampleCounts (0, -1, 1.5) are rejected. `FieldSpec` and the nested `trajectory` tag are frozen. `FrameFor<S>` inference compiles for the trajectory field.

- **`testEvaluateTrajectory`** — evaluator layer (pin #11). Order=1 copies positions exactly (dt ignored); order=2 is bit-exact `p + v · dt` (verified at `dt = 0` and `dt = 0.5` against analytic expressions); order=3 is bit-exact `p + v · dt + ½ · a · dt²`. f32 overload writes through a `Float32Array` with automatic precision truncation. `out` too small and `flat` too small both throw. In-place writes reuse the same `out` reference across repeated calls. End-to-end with the DSL: pulls the `TrajectorySpec` straight off `compiledField.trajectory!` and evaluates without manual spec construction — the pattern downstream consumers will use.

### Documentation

- New `Trajectory arrays (0.6.1 — Pillar 1 scaffolding)` section in `src/schema.ts` header documenting the interleaved layout, the order restriction, and the wire-compat guarantee for `order: 1`.
- New `src/trajectory.ts` with the evaluator and full math / units / clock-recovery / performance documentation in its file header.
- README `Schema DSL` section gains a `#### Trajectory arrays — Pillar 1 of phase-locked extrapolation` subsection with a worked example.
- README `Roadmap → Shipped` collapses the 0.6.0 entry and adds a 0.6.1 entry pointing at the new section.
- The Phase-Locked Extrapolation plan ([`WebsitePlans/WebAudioBridge Beyond 1 and 4 - Phase-Locked Extrapolation Plan.md`](../NewProject/website/WebsitePlans/WebAudioBridge%20Beyond%201%20and%204%20-%20Phase-Locked%20Extrapolation%20Plan.md)) anticipates this release as "Optional half-step before 0.7.0" — 0.6.1 is exactly that. Pillars 2 (PLL) and 3 (`pullEvaluated` / `evaluateInto`) remain on the roadmap and will land as future bumps.

## [0.6.0] — 2026-05-25

### Added — `Bridge<Schema>` schema invariants (cross-IPC bit-rot detection)

The bridge has historically trusted the SAB payload bytes byte-for-byte: a producer-side bug, a hardware ECC flip, or a (vanishingly-rare) V8/Chromium SAB-coherence bug would silently corrupt the consumer's frames, with the only symptom being downstream audio glitches. 0.6.0 lifts payload integrity from a per-caller responsibility into a protocol concern.

- **`defineSchema({...}).withInvariant(fn)`** is a new schema builder that returns a schema with a hidden `__invariant: f64` lane appended at the (8-aligned) end of each frame slot. `fn` is a caller-supplied scalar function (`frame → number`) — typically Σ|f|² for f64-dominant payloads, but the bridge doesn't constrain the choice: xxhash, CRC32, hand-rolled product-of-primes, anything that's pure, O(payload size), and allocation-free works. The frame byte size grows by exactly 8; `f64` joins `typesPresent` if not already there.
- **The bridge auto-computes the invariant on every push** (right before the release-store on `write_index`) and **verifies on every pull** (right after the payload read, before the recovery / release-store). Ratio = computed / stored; classification:
  - **`|ratio − 1| < INVARIANT_OK_THRESHOLD` (1e-3)** — ok. Pass through; seed/update `consumerPrev`.
  - **`|ratio − 1| < INVARIANT_SOFT_THRESHOLD` (1.0)** — soft error. Invoke the 0.4.1 α-smoother against `consumerPrev` with `α = clamp(INVARIANT_SOFT_ALPHA_BASE / |ratio − 1|, 0, 1)`. Small deviations get α≈1 (essentially pass through); deviations near the hard boundary get α≈0.1 (essentially trust prev). `tornFrames` does NOT increment.
  - **otherwise** — hard error. Atomically increment `torn_frame_counter` on lane 3 (mod 2^32), copy `consumerPrev` into `out` (last-known-good fallback). If `consumerPrev` is not yet valid (first pull ever was a hard error), the raw payload passes through and `tornFrames` still increments so the failure is visible.
- **Lane 3 of the Int32 header is now active.** `torn_frame_counter` (Int32 monotonic wrap-counter). Read via `bridge.telemetry().tornFrames`. The increment is `Atomics.add(..., 1)` so any thread can read a consistent count.
- **`bridge.telemetry()`** is a new diagnostic snapshot returning a frozen `{ tornFrames, flowScale, available, capacity, writeIndex, readIndex }` object. All reads use `Atomics.load`; fields are individually consistent but not mutually atomic (point-in-time samples). Folds in the planned "observability snapshot" roadmap item as a side-effect of #4 since lane 3 needed a public read path anyway.

### Why — first SPSC ring with payload integrity as a protocol concern

Existing SPSC ring libraries (`ringbuf.js`, LMAX Disruptor, `jack-ringbuffer`, `crossbeam::channel`) treat payload bytes as opaque — the protocol's job ends at "deliver these bytes intact." If the consumer wants integrity, the caller wraps each payload in their own checksum. That works for batch / message-oriented protocols where the per-message checksum cost is amortized, but it leaves a gap for streaming protocols where the receiver wants to gracefully recover from a single bad frame without dropping the whole stream.

The bridge's invariant lane closes that gap. With the same one-pole smoother that 0.4.1 added for click-free producer-stall masking, the bridge can now mask single-frame corruption click-free too — the soft-error path doesn't even tell the consumer something went wrong (`tornFrames` stays 0), it just blends curr with the last-known-good. Hard errors fall back to last-known-good outright and surface the failure as a numeric counter (`tornFrames`), so downstream alerting / dashboards / regression tests can pin against it.

Lineage: wavefunction-synth's `wfNormGuard.js:46-80` — a Σ|ψ|² invariant with ratio-band recovery applied to a quantum-mechanics simulation's state vector. The bridge generalizes the pattern to any caller-supplied scalar invariant. Same control-theoretic shape (measure-and-recover against a known-good signal) as 0.5.0's adaptive backpressure (CFL analog), different failure mode (data corruption vs rate mismatch).

### Unified `consumerPrev` cache

Internally the smoother prev (from 0.4.1) and the invariant last-known-good buffer (from 0.6.0) are now a single `consumerPrev: FrameFor<S> | null` field with one `consumerPrevValid: boolean` gate. The semantics: `consumerPrev` always holds the most recent value the consumer trusted — for raw pulls under an invariant schema, that's the last verified-ok frame; for smoothed pulls, that's the most recent blended output; for raw pulls under a no-invariant schema, `consumerPrev` is treated as invalid (existing 0.4.1 behavior preserved). The buffer is lazily allocated on first use; one allocation per Bridge instance.

`resetSmoother()` semantics extended: now also clears the invariant fallback. Use at quiescence boundaries (producer just started, consumer just woke from suspend).

### Wire compatibility

- **No-invariant schemas are wire-compatible across 0.5.x ↔ 0.6.0.** The invariant pathway is a single null-check on `schema.invariant` in push and pull; when null, behavior is identical to 0.5.0 (zero observable cost).
- **`.withInvariant(fn)` schemas have a different wire format from the base schema** — the frame size grows by 8 bytes. A 0.5.x peer cannot share a SAB with a 0.6.0 invariant-enabled peer (frame stride mismatch). 0.6.0 invariant peers must use matching `.withInvariant(fn)` schemas with the same compute function on both sides (the invariant is computed at push by the producer's fn and verified at pull by the consumer's fn — they must agree).
- Lane 3 (`torn_frame_counter`) was reserved in 0.5.x (stored as zero); 0.6.0 now writes to it via `Atomics.add` on hard errors. A 0.5.x consumer ignores the lane; a 0.6.0 consumer reads it via `telemetry()`. No SAB-layout conflict.

### Added — invariant + telemetry test pins

`tests/schema.test.ts` grows from 8 to 9 pins:

- **`testWithInvariant`** — schema layer: `.withInvariant(fn)` appends the hidden `__invariant: f64` lane, frame size grows by 8, `f64` joins `typesPresent` (even on schemas without prior f64 fields), `invariantByteOffset` is set; non-function argument throws; original schema is unchanged (immutable builder); result is frozen.

`tests/Bridge.test.ts` grows from 33 to 40 pins (7 new):

- **`testInvariantRoundTrip`** — 100-cycle healthy push/pull through a `seq:u64 + vEff:f64Array(4)` invariant schema. Frame round-trips bit-exact; `tornFrames === 0` (no false positives).
- **`testInvariantHardErrorFallback`** — push A, ok pull (seeds consumerPrev=A); push B, mutate B's `vEff[0]` to 99999 in the SAB via direct view, pull → hard classified, `tornFrames=1`, `out === A` (not corrupt B). Following ok pull doesn't bump tornFrames.
- **`testInvariantFirstPullHardError`** — first pull is a hard error: raw corrupt payload passes through, `tornFrames=1`, consumerPrev is NOT seeded from corrupt frame. Next ok pull (re-)seeds cleanly; subsequent hard error falls back to that ok frame, not the earlier corrupt one. Pins the "no fallback available" edge.
- **`testInvariantSoftErrorSmoothing`** — mutation of magnitude ≈ 0.27 in ratio space lands mid-soft-band (α ≈ 0.375). Output is visibly between corrupt (3) and prev (1); `tornFrames=0`.
- **`testInvariantThresholdBoundaries`** — three engineered runs hit ok-band (`ε=0.001`, delta ≈ 1.75e-4), soft-band (`ε=2`, delta ≈ 0.38), and hard-band (`ε=200`). Outcome correct for each (raw pass-through / blended / fallback) and tornFrames count matches.
- **`testNoInvariantSchemaUnchanged`** — 1k-cycle physicsControlFrameSchema run with no invariant: `schema.invariant === null`, `tornFrames=0`, full round-trip preserved. Verifies the opt-in design — zero observable cost when not used.
- **`testTelemetrySnapshot`** — `telemetry()` returns frozen `{ tornFrames, flowScale, available, capacity, writeIndex, readIndex }`. Cross-check vs `available()` / `flowScaleHint()`; values update correctly across pushes/pulls.

`tests/Bridge.concurrent.test.ts` cross-thread pin gets a new tornFrames assertion: 1 M frames of healthy SPSC traffic on the no-invariant `physicsControlFrameSchema(8)` must end with `telemetry().tornFrames === 0`. Any non-zero reading indicates either a false-positive classification or an SPSC-protocol regression — both worth catching loudly.

### Documentation

- New `Schema invariants (0.6.0, opt-in via .withInvariant(fn))` section in `src/Bridge.ts` header documenting the classification thresholds, the soft-error α curve, the consumer-side state machine, and the opt-in zero-cost guarantee.
- `Layout` block updated: lane 3 documented as `torn_frame_counter`; the reserved-lane table now shows lanes 0-3 as active and lanes 4-7 reserved.
- JSDoc on `withInvariant`, `telemetry`, and the updated `resetSmoother` semantics covers the new contracts.
- README `API reference` gets `bridge.telemetry()` and the `Schema invariants` subsection under "Schema DSL"; a new "Cross-IPC bit-rot detection" subsection appears under Back-pressure / Adaptive backpressure, showing the worked `.withInvariant(...)` example with a Σ|f|² invariant.
- Roadmap collapses: with #1 (adaptive backpressure) and #4 (schema invariants) both shipped, the remaining 1.0 work is two items (backpressure policies + observability dashboards on top of `telemetry()`). 1.0 freeze is in sight.

## [0.5.0] — 2026-05-25

### Added — `Bridge<Schema>` adaptive backpressure (CFL-style)

The bridge's existing backpressure model is binary: `push` returns `false` when full (and the caller drops or stalls), `pullLatest` reports `skipped > 0` when the consumer fell behind (and the caller smooths or accepts the jump). Neither side has any continuous signal of what's actually happening on the peer's side until something has already gone wrong. 0.5.0 adds that continuous signal as a first-class lane on the bridge header.

- **Lane 2 of the Int32 header is now active.** Encodes `flow_scale` as a Q16.16 fixed-point in `[0.5, 2.0]` (stored `[32768, 131072]`). Default is `65536` = `1.0` = "no scaling." The lane is independent of the SPSC counter lanes — no acquire/release ordering with the payload, no compare-exchange needed; the consumer's controller is the sole writer and the producer's read is best-effort.
- **`bridge.flowScaleHint() → number`** — producer-side read. Returns the consumer's most recent flow_scale in `[0.5, 2.0]`:
  - `1.0` — rates are matched, no action needed.
  - `< 1.0` — consumer is overfull, producer should slow down (scale its `dt`, drop frames, sleep a fraction of its interval).
  - `> 1.0` — consumer is starved, producer should speed up.
- **The bridge does NOT enforce the hint.** The hard contract is still capacity-based push reject; the producer voluntarily honors the soft hint. When honored, the producer/consumer match continuously and the hard reject is reached only under genuine overload — which is the entire point.

### Why — first SPSC ring with control-theoretic flow control

Existing SPSC ring libraries (`ringbuf.js`, LMAX Disruptor, `jack-ringbuffer`, `crossbeam::channel`) all do binary block-or-drop. Their assumption is "the caller picks the right capacity and tolerates the rest." Real audio pipelines don't have a right capacity — producer and consumer rates drift, especially at the GPU compute / audio worklet boundary where the GPU's mapAsync cadence is irregular and the audio quantum is hard-real-time.

Lineage: this is the SPSC analog of the CFL stability condition in the wavefunction-synth project's `wf2dStepper.js:100-116`:

```js
if (maxRate * dt > PHASE_CAP) {
  dt = PHASE_CAP / maxRate;
}
```

The stepper measures a per-step "I'm about to exceed the safety bound" signal and adapts its step size to stay under. The bridge's controller measures a per-pull "buffer is filling / draining" signal and publishes a producer-side adaptation hint. Same control-theoretic shape (P + I closing a feedback loop against a measured invariant), different domain (ring-buffer occupancy vs phase advance per step).

### The control law

```
err      = occupancy - 0.5                            // pre-pull, signed
integral = clamp(integral + err, ±FLOW_SCALE_INT_LIMIT)
scale    = clamp(1 - Kp·err - Ki·integral, 0.5, 2.0)
```

- **`Kp = 0.5`, `Ki = 0.05`** — conservative gains designed for ~10 ms settling time at the canonical 375 Hz consumer cadence (≈4 controller cycles per settling time). Bode-style argument: `occupancy_dot = (push_rate - pull_rate) / capacity`, PI closes the loop with crossover well below the audio rate.
- **Target occupancy = 0.5** — half-full leaves equal slack for producer overrun and consumer overrun. Other choices are valid; 0.5 is the symmetric default.
- **Anti-windup**: integral is clamped to `±20` so a long stall can't trap the controller in permanent over-correction (`INT_LIMIT = (range/2) / Ki = 1.0 / 0.05 = 20`). Without anti-windup, a 100 k-cycle full-ring stall would leave the integral at a value the controller could never recover from in human time.
- **Sign**: positive err (consumer overfull) gives `scale < 1` (slow down); negative err (consumer starved) gives `scale > 1` (speed up). The hint is "rate multiplier the producer should aim for relative to its baseline."

### Where the controller runs

`_updateFlowScale(write, read)` is called from `pull`, `pullLatest`, `pullSmoothed`, `pullLatestSmoothed` AFTER the release-store on `read_index` but ONLY on the successful (frame-was-consumed) branch:

- Empty-pull early-returns do NOT update the lane. The "occupancy = 0" reading on an empty-pull would misleadingly say "producer too slow" when in fact the consumer hasn't actually consumed a frame.
- `available()` is a pure observer and never touches the lane.
- The lane is published AFTER the read-index release-store so the producer's slot is freed before the controller math runs.

The cost is ~10 ns on the hot path (one mul, one add, two clamps, one `Math.floor`, one `Atomics.store`). The 0.5.0 bench at N=1000 shows push/pull/pullLatest median unchanged from 0.4.1 — the controller cost is invisible against the 1.20 μs Atomics-notify-dominated baseline.

### Wire compatibility

- **Bytes are compatible across 0.4.x ↔ 0.5.0.** Lane 2 was reserved in 0.4.x (stored as zero); the 0.5.0 constructor uses `Atomics.compareExchange(lane2, 0, 65536)` to seed only if the lane is still zero. A 0.4.x peer that ignores lane 2 will see no behavioral change.
- A 0.5.0 producer running against a 0.4.x consumer: `flowScaleHint()` will keep reading the 0.5.0 default (1.0) because the 0.4.x consumer never updates the lane. The producer behaves as if no controller is running — which is correct.
- A 0.4.x producer running against a 0.5.0 consumer: the controller still runs on the consumer side and publishes to lane 2, but the producer never reads it (it doesn't have the method). Harmless.

### Added — `flow_scale` test pins

`tests/Bridge.test.ts` grows from 27 to 33 pins:

- **`testFlowScaleLaneInit`** — brand-new Bridge has lane 2 seeded to `Q16.16(1.0) = 65536`; `flowScaleHint()` returns `1.0`.
- **`testFlowScaleQ1616RoundTrip`** — sweeps `[0.5, 2.0]` in 0.1 steps; round-trip error bounded by `2⁻¹⁶`. Clamp boundaries `0.5` and `2.0` round-trip exactly.
- **`testFlowScalePIStepResponse`** — synthetic controller test via direct `_updateFlowScale` access. Pins the first three cycles' analytic values bit-exactly (within Q16.16 quantum), then verifies 100-cycle saturation at the low clamp = `0.5` (output clamp + anti-windup engaged).
- **`testFlowScaleIntegrationDirection`** — drives the controller through real push/pull cycles at two regimes:
  - push1/pull1 (starved, pre-pull occupancy = 1/16) → hint saturates at the high clamp `2.0`.
  - full+refill (overfull, pre-pull occupancy = 1.0) → hint saturates at the low clamp `0.5`.
- **`testFlowScaleStability`** — 5000 randomized push/pull operations (mulberry32 seed `0xfacefeed`), counting zero-crossings of `flowScaleHint() − 1`. With `Kp=0.5/Ki=0.05` the P-dominant response shouldn't ring; ≤ 50 sign changes asserted (typical run ≈ 37). A truly oscillating controller would cross ~2500 times.
- **`testFlowScaleAntiWindup`** — saturates the integrator low for 200 cycles, switches to starvation, asserts the controller recovers to `scale > 1` within 100 cycles (analytic ≈ 46). Without anti-windup, recovery would take ~∞ cycles; this pin catches any future regression of the integral clamp.

`tests/Bridge.concurrent.test.ts` cross-thread pin extended with a flow-scale envelope sampler. After every pull chunk, `flowScaleHint()` is sampled into a running `[min, max]` envelope. End-of-run assertion: the envelope must stay within `[0.5, 2.0]` for the full 1 M-frame run. A reading outside this band would indicate a sign-flip, clamp miss, or encoder overflow. The 1 M-frame run on a dev laptop covers both clamps because the producer/consumer rates are unmatched (producer is a tight loop, consumer pulls in 8 k chunks).

### Added — `flow_scale recovery` bench cell

`bench/Bridge.bench.ts` gets a third measurement cell. Drives the controller through a saturate-then-step disturbance (200 overfull cycles, then switch to starved), reports the recovery cycle count, and fails if recovery exceeds 100 cycles. Local measurement: 33 cycles to recover, well under the 100-cycle budget (analytic ≈ 46). This is not a per-op latency measurement — the controller's hot-path cost is folded into the regular `pull` cell, which still measures at the 1.20 μs floor.

### Documentation

- New `Adaptive backpressure (CFL-style, 0.5.0)` section in `src/Bridge.ts` header documenting the math, the gain rationale, the run-site selection (only on the successful pull branch), and the cost.
- `Layout` block updated: lane 2 now documented as `flow_scale (Q16.16 consumer→producer PI hint)`, with a reserved-lane table covering lanes 0-7.
- JSDoc on `flowScaleHint()` covers the producer contract (voluntarily honor, not enforced) and the Q16.16 quantum.
- README gets a new "Adaptive backpressure (CFL-style)" subsection under [Back-pressure](#back-pressure) showing the producer's voluntary-honor pattern with a `dt` scaling example.
- Roadmap updated: #1 (adaptive backpressure) marked shipped; #4 (schema invariant header for cross-IPC bit-rot detection) is the remaining open item targeting 0.6.0.

## [0.4.1] — 2026-05-25

### Added — `Bridge<Schema>` smoothed-pull API

Two new consumer-side methods plus a small helper:

- **`bridge.pullSmoothed(out, alphaBase)`** — like `pull(out)` but blends the freshly-read frame against the previous smoothed-call output via a one-pole low-pass: `out_i ← α_base · curr_i + (1 − α_base) · prev_i`. Returns `false` on empty (no payload read; smoother state untouched). For per-quantum consumers that want click-free interpolation across the producer's irregular cadence.
- **`bridge.pullLatestSmoothed(out, alphaBase)`** — like `pullLatest(out)` but with skip-scaled blending: `α_eff = α_base · 2^(−skipped)`. Steady-state (`skipped=0`) blends with `α_base`; a large drain (producer stalled, consumer caught a backlog) blends with an exponentially smaller `α_eff` so the consumer drifts slowly toward the catch-up state instead of jumping. Returns `−1` on empty, else the skipped count (same shape as `pullLatest`).
- **`bridge.resetSmoother()`** — explicit prev-invalidation. Raw `pull` / `pullLatest` already invalidate prev implicitly (the next smoothed call re-seeds as a first-call: no blending, just seed with curr); call `resetSmoother()` to invalidate without consuming a frame.

### Why — α-smoother as a first-class ring-buffer primitive

Lineage: the wavefunction-synth project's 60 → 48 kHz boundary smoother (`wfEvolve.js:145-146,361-362`). The one-pole shape `y ← y + α·(x − y)` masks GPU hiccups click-free at the audio-rate consumer. Pre-0.4.1 the worklet had to implement it manually around `pullLatest`; lifting it into `Bridge` makes "temporally-coherent drain-to-newest" a single library primitive, with the skip-scaling automatic from the existing skipped-count diagnostic.

Compared to other ring-buffer libraries (`ringbuf.js`, LMAX Disruptor, `jack-ringbuffer`, `crossbeam::channel`): all return "bytes since last read" — none return *temporally-coherent* bytes. For audio-rate consumers downstream of a control-rate producer, that's real value. Closes one of the two open 1.0-roadmap items from the README's improvements plan.

### Field-type rules for the blend

- **f64 / f32** (and their `*Array` variants): blended in float, stored as float. No rounding.
- **u8 / i8 / u16 / i16 / u32 / i32** (and their `*Array` variants): blended in float, then `Math.round`-ed back to integer before storage. So a 0.5 blend between `10` and `11` stores `11` (JS `Math.round` rounds half away from zero for positives).
- **u64 / i64** (BigInt-typed scalars and arrays): pass through verbatim as `curr` — there is no meaningful blend on monotonic sequence counters or timestamps. The previous prev value for these fields is overwritten with curr each call so the smoother's prev mirror stays consistent.

### Memory ordering

Identical to `pull` / `pullLatest`: acquire-load writeIdx, read payload, release-store readIdx, `Atomics.notify`. The blend math runs AFTER the release-store — blend touches only heap-side `out` and `prev`, never the SAB, so the producer's slot is released as early as possible. Smoother adds zero to the SPSC critical-section length.

### Wire compatibility

- **No SAB-layout change.** Header is still 32 bytes, counter lanes still i32 at bytes [0..3] and [4..7], reserved lanes 2-7 untouched. A 0.4.0 producer / consumer pair can interop with a 0.4.1 peer in either direction.
- The smoother's prev frame lives heap-side on the consumer's `Bridge` instance, not in the SAB. No producer-side change.

### Implementation notes

- Smoother prev (`smoothPrev: FrameFor<S> | null`) is lazily allocated on the first smoothed call via `scratchFrame()`, then retained for reuse. Once allocated, smoothed calls are allocation-free.
- `pull` / `pullLatest` flip a single boolean (`smoothPrevValid = false`) to invalidate the smoother. Cost is one store on the existing hot path — measured invisible in the bench (median push/pull/pullLatest all still ~1.10–1.20 μs at N=1000).
- Field classification (`isBigInt` / `isInteger`) is precomputed at construction so the blend inner loop is a tight indexed walk over the schema's field arrays.

### Added — smoothed-pull test pins

`tests/Bridge.test.ts` grows from 17 to 27 pins (10 new):

- **`testSmoothedEmpty`** — empty ring → `pullSmoothed` returns `false`, `pullLatestSmoothed` returns `−1`. Smoother state untouched on empty-return.
- **`testSmoothedFirstCallNoBlend`** — first smoothed call returns curr verbatim regardless of α (no prev to blend with).
- **`testSmoothedAlphaOneEqualsRawSteadyState`** — 10-cycle loop at α=1.0 with steady-state cadence (`skipped=0`) reproduces raw `pullLatest` values bit-exactly.
- **`testSmoothedHandComputedBlend`** — two-step seed-then-blend matches hand-computed `0.5·B + 0.5·A` for every numeric field. BigInt fields pass through as `B` verbatim.
- **`testSmoothedSkipScaling`** — push 5 frames then one `pullLatestSmoothed` sees `skipped=3`, `α_eff = α_base · 2⁻³`. Hand-computed blend matches.
- **`testSmoothedPullSymmetricToPull`** — `pullSmoothed` (single-frame variant) blends with `α_eff = α_base` (no skip scaling).
- **`testNonSmoothedPullInvalidatesSmoother`** — raw `pull` and `pullLatest` both invalidate prev; next smoothed call behaves as first-call.
- **`testResetSmoother`** — explicit invalidation path, same observable behavior.
- **`testSmoothedIntegerRounding`** — u8 scalar, u32 scalar, and u8Array elements all `Math.round` through to integer. Float field in the same schema is not rounded.
- **`testSmoothedFloatArrayBlend`** — 16-element f64Array blends elementwise; cross-checks the array path.

### Documentation

- New `Smoothed pulls (α-smoother as first-class API)` section in `src/Bridge.ts` header documenting the blend, the field-type rules, the skip-scaling, and the prev-invalidation behavior.
- JSDoc on `pullSmoothed`, `pullLatestSmoothed`, and `resetSmoother` covers semantics, return values, and the wavefunction-synth lineage.

## [0.4.0] — 2026-05-25

### Changed — `Bridge<Schema>` counter representation: BigInt64 → Int32 wrap

The `write_index` / `read_index` lanes in `Bridge<Schema>` change from BigInt64 to Int32 wrapping mod 2^32, computed via the standard SPSC modular trick:

```
diff = (writeIdx - readIdx) | 0       // signed-32 subtraction
slot = (idx >>> 0) & mask              // unsigned-then-mask
```

The signed-32 diff carries the true delta for any `|delta| < 2^31`. Capacity is power-of-two and now hard-capped at 2^30 (was unbounded, practically capped by SAB size) so the diff stays well within the signed-32 range. Slot mask is wrap-correct because the low `log2(capacity)` bits don't depend on signed-ness. Wrap clock: 2^32 / 48000 ≈ 24 h at audio rate; 2^32 / 60 ≈ 2.27 years at a 60 Hz control-rate producer. The SEMANTIC monotonic seq is whatever your schema declares (e.g. `physicsControlFrameSchema(n)` declares `seq: u64` which is exact through 2^64) — the ring's INTERNAL counter only needs to indicate "which slot is next" and "how full is the ring," both of which are wrap-invariant operations.

### Why — closing the ringbuf.js-class atomic floor

Pre-0.4 the `Bridge<Schema>` Atomics path paid both the notify syscall AND BigInt boxing on every push/pull. Isolated atomic load+store+notify cost measured ~160 ns on Windows + V8 + Node 22, vs ~100 ns on Int32 — a ~40 % gap against the ringbuf.js-class floor. At the canonical macro-physics frame size (N=1000, 16 KB payload) the cost is dominated by the payload memcpy, so the median is unchanged (~1.1 μs). The win shows up at small N — relevant for the planned smoothed-pull / flow_scale lanes (roadmap items #1, #2) and any user-defined schema with control-signal-sized payloads:

| N    | Frame size | Push median |
|------|-----------|-------------|
| 1    | 48 B      | 100 ns      | (atomic-only floor — ringbuf.js territory)
| 4    | 96 B      | 200 ns      |
| 64   | 1056 B    | 200 ns      |
| 256  | 4128 B    | 400 ns      |
| 1000 | 16032 B   | 1100 ns     | (memcpy-bound, atomics invisible)

Inspiration credit: the principle "small lanes with proven algebra replace the boxed wide type" comes from the wavefunction-synth project's `doubleSingle.ts` (Knuth two-sum on f32 pairs for unitarity preservation in a WGSL Strang stepper). For floats that's two-sum / Veltkamp split; for monotonic integers the analog is modular ring arithmetic with the signed-32 diff trick — same conceptual move, different domain.

### Wire compatibility

- **`Bridge<Schema>` SABs are NOT compatible across the 0.3 / 0.4 boundary.** `write_index` moves from bytes [0..7] to [0..3], `read_index` moves from bytes [8..15] to [4..7]. Both producer and consumer must run on the same major.minor version. This is the breaking change the minor bump tracks.
- **`Float64RingBuffer` is untouched** and continues to carry the v0.1.x byte format. Users on the deprecated path see zero behavior change. The class still ships from the package root with the same `@deprecated` tag pointing at `Bridge` + `physicsControlFrameSchema(n)`. Removal scheduled no earlier than 2.0, unchanged from 0.3.
- The `Bridge.RING_HEADER_BYTES` constant stays at 32; lanes 2-7 of the new Int32 view (bytes 8..31) are explicitly reserved for the roadmap #1 (`flow_scale` for adaptive backpressure) and #7 (observability counters) fields. A new exported constant `RING_HEADER_INT32_LANES = 8` names the underlying view length; `RING_HEADER_LANES = 2` is preserved and re-documented as "active counter lanes."

### Added — counter-arithmetic test pins

`tests/Bridge.test.ts` grows from 14 to 17 pins:

- **`testWrapAcrossInt32Boundary`** — seeds the counters at `INT32_MAX - 2` and runs 20 push/pull cycles, walking the indices across `0x7FFFFFFF → 0x80000000`. Asserts FIFO + payload round-trip + signed-32 sign crossing at the end.
- **`testFullPushAtInt32Boundary`** — fills to capacity while the producer counter wraps mid-fill; asserts the signed-32 full-check keeps rejecting overflow with writeIdx negative and readIdx positive.
- **`testCounterArithmeticVsOracle`** — 10 k mulberry32-seeded push/pull stream driven against a BigInt oracle, asserting `(a - b) | 0 === oracleDiff` and `(a >>> 0) & mask === oracleSlot` at every step. Seeded near `INT32_MAX` so the run covers the boundary. Mirrors the wavefunction-synth `doubleSingle.test.ts` methodology — same property-test shape, different domain (exact integer algebra vs DS-f32 to 1e-13).

`tests/Bridge.concurrent.test.ts` PRODUCER_SOURCE updated lockstep: the inlined worker mirrors the new `Bridge.push` write semantics (Int32 lanes, signed-32 diff, unsigned-mask slot). The 1 M-frame cross-thread bit-exact pin is unchanged structurally — local run with `physicsControlFrameSchema(8)` and `CAPACITY=16`: ~1.45 s on a dev laptop (vs ~625 ms in 0.3.0; ~2× wall-clock variance run-to-run is normal at this contention level — the bit-exact pin is the proof, not throughput).

### Documentation

- New `Counter representation` section in `src/Bridge.ts` documenting the wrap algebra, the capacity cap rationale, the wire-format change, and the wavefunction-synth `doubleSingle.ts` inspiration credit.
- `bench/Bridge.bench.ts` header gets a `0.4.0 perf note` with the measured floor-by-N table.
- README perf section to be refreshed in a follow-up; the bench output is the canonical reference for now.

## [0.3.0] — 2026-05-25

### Added — schema-driven frames

The library's identity shifts from "the bridge for control-rate physics" to "the bridge for any structured GPU → audio control payload." The old V/J-physics frame is preserved as one canonical schema; users can now define arbitrary frame shapes with mixed primitive types.

- **`Bridge<Schema>`** in `src/Bridge.ts`. SPSC ring-buffer protocol, atomics, and park/wake semantics are identical to `Float64RingBuffer` — only the payload codec is now driven by a `Schema` object. New methods: `push(frame)`, `pull(out)`, `pullLatest(out)`, `scratchFrame()`, `beginPush()` / `commitPush()` / `abortPush()` (two-step zero-copy producer), `pushChecked(frame)` (dev-mode validation), `describeLayout()` (postMessage-safe byte-offset table for worklets that inline the read).
- **Schema DSL** in `src/schema.ts`. `defineSchema({ field: u64(), arr: f64Array(n), ... })` style. Field constructors cover every primitive: `u64`/`i64`/`u32`/`i32`/`u16`/`i16`/`u8`/`i8`/`f64`/`f32` as scalars, plus `*Array(n)` variants for fixed-length arrays. `FrameFor<S>` mapped type gives full TypeScript inference (field-name autocomplete, per-field types) without any `as const` gymnastics.
- **Canonical schemas** in `src/schemas/physics.ts`:
  - `physicsControlFrameSchema(n)` — recommended for new code. `seq` and `tMacroNs` are `u64` (bigint), escaping the `≤ 2^53` precision caveat that the legacy `Float64RingBuffer.RingFrameHeader` carries on those fields. Bytes are NOT compatible with v0.1.x `Float64RingBuffer`.
  - `legacyPhysicsControlFrameSchema(n)` — `seq` and `tMacroNs` as `f64`. Byte-identical wire format to v0.1.x `Float64RingBuffer`. For users porting line-by-line from `Float64RingBuffer`, or who need sub-microsecond fractional precision in `tMacroNs` (as the e2e-latency bench does).
- **Tests:**
  - `tests/schema.test.ts` — 8 pins covering field constructors, validation, alignment-class grouping, frame padding, `describeSchemaLayout`, TS `FrameFor` inference, and the frozen-schema contract.
  - `tests/Bridge.test.ts` — 15 pins mirroring the structure of `tests/Float64RingBuffer.test.ts`, plus dedicated coverage for `beginPush`/`commitPush`/`abortPush`, `pushChecked` validation errors, and a mixed-type toy schema (`{ ts: u64(), label: u8Array(16), value: f32() }`) that exercises the alignment-grouping path with declared order ≠ physical order. Round-trips `0xdeadbeefcafef00dn` bit-exact through u64.
  - `tests/Bridge.concurrent.test.ts` — port of the 1M-frame cross-thread stress test against `Bridge<physicsControlFrameSchema(8)>`. The inline producer reconstructs typed-array views from `Bridge.describeLayout()` (not hardcoded offsets), so any schema change auto-propagates. Same `fullWaitTimeouts === 0` / `emptyWaitTimeouts === 0` assertion as the legacy concurrent test. Local run: 1M frames bit-exact in ~625 ms on a dev laptop.
- **Bench:** `bench/Bridge.bench.ts` mirrors `bench/Float64RingBuffer.bench.ts` against `Bridge<physicsControlFrameSchema(N)>`. Same loop shape, same 10 μs hard budget. Measured overhead vs the legacy class: +100–200 ns/op median (matching the planned 50–150 ns closure-dispatch cost), well under the budget. Users wanting peak performance on the legacy shape can keep using `Float64RingBuffer` directly.
- **Worklet inlining helper.** `Bridge.describeLayout()` returns a JSON-safe table with each field's byte offset, kind, and length. Worklets pass it through `processorOptions` and reconstruct typed-array views inline — no library code on the audio thread. Both bundled examples (`examples/minimal/worklet.js`, `bench/e2e-latency/worklet.js`) demonstrate the pattern.

### Migrated — examples and benches

- `examples/minimal/*` now uses `Bridge` + `physicsControlFrameSchema(n)`. New shared `examples/minimal/schema.js` module imported by both worker and main thread. Worklet receives `describeLayout()` via `processorOptions.layout` and reads frames inline.
- `bench/e2e-latency/*` now uses `Bridge` + `legacyPhysicsControlFrameSchema(n)`. Deliberately the legacy schema: the bench's latency measurement depends on sub-µs fractional precision in `tMacroNs`, which only the all-f64 schema preserves. Shared `bench/e2e-latency/schema.js` module.

### Deprecated

- **`Float64RingBuffer`** and the related exports (`RingFrameHeader`, `RingAllocation`, `RING_FRAME_PRELUDE`). Implementation is unchanged and the class continues to be exported from the package root. JSDoc `@deprecated` tag points at `Bridge` + `physicsControlFrameSchema(n)`. Removal scheduled no earlier than 2.0.
- All legacy tests (`tests/Float64RingBuffer*.test.ts`) and the legacy bench (`bench/Float64RingBuffer.bench.ts`) are preserved unchanged and continue to run as part of `npm test` / `npm run bench`. They serve as the regression oracle proving the deprecated class still works bit-exactly through the entire 1.x line.

### Wire compatibility

- `Bridge<physicsControlFrameSchema(N)>` produces **different bytes** from `Float64RingBuffer` (u64 vs f64 lanes for `seq` / `tMacroNs`). These two cannot share a SAB.
- `Bridge<legacyPhysicsControlFrameSchema(N)>` produces **byte-identical** SAB content to `Float64RingBuffer`. Either class can read a frame written by the other. This is the migration path for users with existing v0.1.x SAB layouts they want to preserve.

### Documentation

- README restructured: lead now describes `Bridge<Schema>`, with the physics frame as a worked example via `physicsControlFrameSchema(n)`. New "Schema DSL" reference table covers every field constructor. Legacy `Float64RingBuffer` demoted to a "Legacy API" subsection. Roadmap split into "Shipped in 0.3.0" / "Remaining 1.0 work" (#6 backpressure policies, #7 observability snapshot) / "Beyond 1.0".
- `src/Bridge.ts` header carries verbatim copies of the load-bearing memory-ordering, park/wake, and wall-clock-vs-CPU-shape sections from `src/Float64RingBuffer.ts`. The protocol is identical; only the payload codec changes.

## [0.2.0] — 2026-05-25

### Added — park/wake protocol

Purely additive. Existing call sites that don't park continue to work bit-for-bit; the new methods and the unconditional notify give consumers a kernel-park back-pressure path instead of forcing them to invent a polling loop.

- **`Atomics.notify` on every push, pull, and pullLatest.** Unconditional (not edge-triggered). A parked peer is guaranteed to be woken on every state change. Syscall cost when nobody is parked is dominated by the write itself (~100 ns / call with zero waiters on Windows + V8).
- **`waitForSpace(timeoutMs?)`.** Producer-side park. Returns `"not-equal"` immediately if space is already available; otherwise `Atomics.wait` on `read_index`. Closes the load-then-park race via the spec's atomic compare-and-park semantic.
- **`waitForData(timeoutMs?)`.** Consumer-side park. Mirror of `waitForSpace`. **Not real-time safe** — must not be called from `AudioWorklet.process()`. The AudioWorklet read path should continue to use `pullLatest()` + the consumer's existing miss-tolerance logic; `waitForData` is for non-realtime consumers (tests, bench harnesses, non-audio downstream readers).

### Added — concurrent stress test

- **`tests/Float64RingBuffer.concurrent.test.ts`.** A Node `worker_threads` SPSC stress test: the main thread is the consumer using the production `Float64RingBuffer.pull`; the worker thread is an inline-JS producer that mirrors `Float64RingBuffer.push` verbatim. Both share one `SharedArrayBuffer`. Validates 1,000,000 frames with `assertEq` (`===`) on every header field and every payload `f64` against a deterministic generator — any memory-ordering hazard (release-store downgraded to plain store, acquire-load elided) would manifest as non-monotonic `seq` or off-recipe payload. **The proof is the contention pattern, not the throughput**: under the always-notify protocol both sides park in the kernel when blocked, so the contention shows up as hundreds of thousands of `fullWaits` and `emptyWaits` rather than the millions of busy-spin iters an unsynchronized version would log — same proof, three orders of magnitude less wasted CPU. Asserts `fullWaitTimeouts === 0` and `emptyWaitTimeouts === 0` as protocol-regression alarms: any future V8 / OS / capacity change that re-introduces the lost-wakeup hole fires here within seconds. Local run: 1M frames bit-exact in ~660 ms on a dev laptop.
- **`npm test` now chains both layers** (single-thread `tests/Float64RingBuffer.test.ts` + cross-thread `tests/Float64RingBuffer.concurrent.test.ts`). New `test:unit` and `test:concurrent` scripts run them independently.

### Documentation

- **New `Park / wake protocol` section** in `src/Float64RingBuffer.ts` documenting always-notify (vs the edge-trigger experiment kept as a warning) and the load-then-park race spec-correctness.
- **New `Wall-clock vs CPU-shape tradeoff` section** naming the +180 ms / ~1 μs-per-op costs honestly: the microbench is ~5× slower per op vs 0.1.x because every push and pull now pays an `Atomics.notify` syscall. In production (60 Hz × 375 Hz) that's ~435 syscalls/sec total → <0.05 % of one CPU. Wall-clock is the wrong axis — CPU shape, power, and degradation-mode under stalls are what change. Busy-spin pins two cores at 100 % during any back-pressure window and amplifies stalls; wait/notify parks them and degrades gracefully.
- **Bench header** gets a `Target history` section explaining the 0.1.x vs 0.2.0 floor (~150–200 ns → ~1.1 μs on Windows + V8 + always-notify) so the bench output doesn't read as a regression.
- **README** gets a new **Back-pressure** section with a `waitForSpace` example and the explicit "do not call `waitForData` from `AudioWorklet.process()`" warning. Memory ordering steps extended with the notify lines. API reference gets `waitForSpace` / `waitForData` entries. Performance section paragraph refreshed for the post-protocol ~1.1 μs/op floor.
- `Float64RingBuffer.test.ts` header explicitly marks the file as single-threaded API correctness and points at `Float64RingBuffer.concurrent.test.ts` for the actual cross-thread memory-ordering coverage. README "What this is" section updated to describe the two test layers honestly.

## [0.1.1] — 2026-05-25

### Changed
- `pull()` and `pullLatest()` no longer perform a second `Atomics.load(write_index)` re-check after copying the payload. Under the library's strict push contract (`push()` refuses when `write_index − read_index ≥ capacity`), the producer cannot advance `write_index` past `read_index + capacity`, so the slot offsets `(write_index & mask)` and `(read_index & mask)` cannot collide while there is an unread frame. The re-check was guarding an impossibility and is removed. `pull()` returns `false` only on empty; `pullLatest()` returns `-1` only on empty. Callers that previously treated the second-`false`/`-1` case as "torn" continue to work — that path was unreachable under the conforming contract.
- README "Memory ordering" section updated to reflect the simpler protocol.
- `testTornFrameDetection` removed from the test suite — it tested the now-deleted code path. Test count 12 → 11.

### Fixed
- README CPU-overhead figure was misstated as `~0.000006%` at 60 Hz (raw ratio written with a `%` sign, plus an extra zero); corrected to `~0.006%` of one core in 0.1.0 README via README-only patch on the 0.1.0 tag's main branch. Restated here for the version-bound CHANGELOG record.

### Documentation
- Added secondary cite to public [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432) alongside the Chromium tracker for the 5–15 ms `mapAsync` claim.
- Clarified that ECMA-262 only defines sequentially-consistent atomics; the release/acquire description names the protocol shape, not the underlying primitive.

## [0.1.0] — 2026-05-25

Initial release.

### Added
- `Float64RingBuffer` — lock-free SPSC ring over `SharedArrayBuffer`.
  - BigInt64 monotonic-forever indices via `Atomics`.
  - Frame-oriented layout: `[seq, tMacroNs, vMax, jMax, V_eff[N], J_eff[N]]` per slot.
  - `push()`, `pull()`, `pullLatest()`, `available()` API.
  - Torn-frame re-check on both read paths.
  - Static `allocate()` and `byteLength()` helpers.
- 12-pin property-test suite including a 10,000-iteration mulberry32-seeded fuzz against an oracle queue.
- Microbenchmark reporting push / pull / pullLatest median, p99, and mean.
- Documentation of the macro / micro control-rate-GPU / audio-rate-CPU architectural pattern.
