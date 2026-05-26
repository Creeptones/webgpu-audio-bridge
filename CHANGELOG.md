# Changelog

All notable changes to this project will be documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning policy (post-0.6.0)**: future improvements default to **patch bumps** (`0.6.x`) rather than minor bumps. Many additional improvements are planned before 1.0; we want the version number to reflect actual maturity, not feature count. Minor bumps (`0.7.0` etc.) are reserved for wire-format changes, breaking public-API changes, or batched-patch promotion. See [`CLAUDE.md`](./CLAUDE.md) for the full policy.

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
