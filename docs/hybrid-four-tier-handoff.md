# Handoff — push hybrid residual-on-carrier harder (the four-tier stack)

> **SHIPPED POSTSCRIPT (0.9.72).** The recommended next ship (§3) landed as
> `examples/hybrid-four-tier/` + `tests/Bridge.fourTier.test.ts` (pins 110–113)
> + the README "Four-tier stack" subsection. What shipped vs. what this handoff
> scoped:
>
> - **Tiers 1–4 composed** as scoped. Tier 1 = the carrier input lane (copied
>   from the mono demo — the stereo base it suggested as a starting point does
>   **not** actually carry an input lane; the mono one does). Tier 4 = the macro
>   `Bridge<S>` + `~60 Hz` position+velocity producer (on the **main thread**) +
>   `pullPredictedLatest` in the worklet, lead-sourced from the relayed
>   `lastReadbackUs` → `recordReadbackLatency()` exactly as §3.3 describes.
> - **Spatial field (§3.4) shipped** as the tier-4 `azimuth` macro driving an
>   equal-power L/R pan applied **in the worklet** (per §3.2's "azimuth to the
>   L/R pan of carrier+residual"), not in the WGSL. The worker stays the proven
>   stereo harmonic-residual producer.
> - **Cutoff** drives a one-pole low-pass on the mix (the §3.2 sketch's "apply
>   cutoffHz to the carrier filter"); a **"Predict (negative latency)" A/B
>   toggle** was added so the predictive layer is audible on/off.
> - **Convolution / room tail (§3.4) DEFERRED.** It needs a two-pass
>   persistent-history WGSL dispatch (cross-block IR state) that can't be
>   verified without a browser/WebGPU in the ship environment; deferring it keeps
>   0.9.72 composition-only, as §3.5's versioning note allows. It remains the
>   documented next-step content for tier 3.
>
> Everything below is the original (pre-implementation) handoff, retained as the
> design record.

---

**Status**: ✅ shipped as 0.9.72 (was: handoff / design). Scoped the four-tier
ship on the hybrid pattern.
**Author**: maintainer + Claude (2026-05-29), after shipping 0.9.71.
**Prereqs already shipped**: `processAdd` (0.9.41), stereo residual (0.9.48),
sample-accurate carrier params via `BridgeInputLane` (0.9.49), comparator bench
(0.9.50), graceful degradation (0.9.51), **predictive `pullPredictedLatest`
(0.9.71)**.

> Read `docs/hybrid-residual-comparison.md` first — this handoff builds on its
> 15-gap analysis and assumes its vocabulary (carrier / residual / the
> perceptual CPU-GPU split).

---

## 1. The target — a four-tier experimental stack

The ask: *"For anything pitch-, attack-, or gesture-sensitive, the CPU carrier
should own the latency. GPU should add residual/timbre/space, not the fundamental
action."* Concretely, four tiers each owning a different latency class:

```
TIER                     OWNS                                   LATENCY    STATUS
──────────────────────── ────────────────────────────────────  ─────────  ──────────────
1 BridgeInputLane      → note / gesture / carrier params        ~1 µs SAB  ✅ 0.6.19 / wired 0.9.49
2 CPU AudioWorklet     → pitch, attack, transient, fundamental  sub-quantum ✅ carrier (0.9.41)
3 GPU residual bridge  → upper harmonics, conv tail, spatial    ~85 ms     ✅ mono+stereo; conv/spatial NEW
4 predictive macro     → smooth forward compensation            "negative" ✅ pullPredictedLatest (0.9.71) — NOT yet wired
```

The headline insight: **three of the four tiers already ship as primitives.**
The work is not new machinery — it is *composition* plus two genuinely new pieces
of residual content (convolution tail, spatial field). The single missing wire is
**tier 4**: nothing yet uses `pullPredictedLatest` inside the hybrid stack, even
though it is the exact primitive the brief's "predictive macro layer → smooth
forward compensation" describes.

That is the recommended next ship.

---

## 2. What tier 4 actually is (and is NOT)

**Tier 4 = a control-rate `Bridge<S>` of *smooth macro fields* that the worklet
pulls with `pullPredictedLatest`, so it renders each macro where it *will be* once
the block is heard — cancelling the control+readback staleness for the smooth
layer while the carrier (tier 2) keeps owning the latency-critical action.**

Smooth macro fields are things like: filter cutoff sweep, spatial azimuth /
distance, IR-morph coefficient, spectral tilt, reverb mix, wavetable position.
They are continuous, band-limited, and tolerate a confidence-bounded forward step.
A 10–15 ms readback lag on a *cutoff sweep* is audible as "the filter is behind
the gesture"; forward-compensating it with `pullPredictedLatest(leadMs ≈
readbackMedian)` makes the sweep track the gesture even though the GPU residual
that the cutoff modulates is still ~85 ms behind. That is how the user gets
"<5 ms tracking feel even while GPU readback remains 5–15 ms" — the *perceived*
control surface (carrier pitch + macro envelopes) is current; only the spectral
*body* lags, inside the perceptual integration window.

**Tier 4 is NOT:**
- **Not the carrier.** Never predict pitch / attack / transient / note-on. Those
  are discontinuous or latency-critical → tier 1 (sample-accurate input lane) and
  tier 2 (CPU). Forward-extrapolating a step pre-echoes it. `pullPredictedLatest`
  is for *smooth macro fields only* — this is a hard usage rule, already documented
  on the method.
- **Not Gap #6 "predictive carrier."** Gap #6 is the *carrier* tracking the
  *residual's* pitch hint. Tier 4 is the *macro params* tracking *real time*. They
  are orthogonal; Gap #6 stays deferred.
- **Not a new wire format.** `pullPredictedLatest` is a heap-side consumer
  computation over the existing frame format. Tier 4 needs the macro schema to
  carry `f64TrajectoryArray`/`f32TrajectoryArray` (order ≥ 2) fields + a
  `.withTimestamps(...)` role — all shipped DSL.

---

## 3. Recommended next ship — `examples/hybrid-four-tier/` (0.9.72, patch)

Examples + docs only, no library change — the same posture that made 0.9.49 a
patch. Demonstrates all four tiers composed in one demo so the stack is legible
and regression-pinnable.

### 3.1 Topology

```
MAIN THREAD                         WORKER (GPU, ~50 Hz)            WORKLET (audio thread)
───────────                         ───────────────────            ──────────────────────
input lane producer  ──SAB──────────────────────────────────────▶ tier 1: inputLane.pullAll()
  (freq / note / gesture, ~1 µs)                                     → carrier retune @ sampleOffset

macro bridge producer ──SAB──────▶ reads macro for residual ──┐    tier 4: macroBridge.pullPredictedLatest(
  (cutoff, azimuth, morph;        params (cutoff drives WGSL  │      out, { leadMs: macroBridge.lastReadbackMedianMs(),
   order-2 trajectory + tMacroNs)  filter, azimuth drives pan)│              maxLeadMs: 20, confidenceFloor: 0.25,
                                                              │              consumerNs: currentTime*1e9 })
                                   GPU residual ──block SAB───┼──▶ tier 3: consumer.processAddStereo(L, R, gain)
                                   (harmonics + conv tail +   │      (de-interleaved spatial residual)
                                    spatial field, interleaved)│
                                   posts lastReadbackUs ───────┘    (main relays → worklet.recordReadbackLatency)

                                                                   tier 2: CPU stereo carrier into L,R first
```

The worklet holds **three consumer handles**: the input lane (tier 1), the macro
`Bridge<S>` (tier 4), and the `BridgeBlockConsumer` (tier 3). Tier 2 is just the
per-sample carrier loop it already runs.

### 3.2 Macro schema sketch (tier 4)

```ts
// schema.js — new macro control bridge (separate SAB from input lane + block ring)
export function makeMacroSchema() {
  return defineSchema({
    seq:      u64(),
    tMacroNs: u64(),
    // Smooth macro fields as order-2 trajectories (position + velocity) so
    // pullPredictedLatest can forward-extrapolate them. sampleCount = 1 each
    // (scalar-valued macro), or N for a vector field (e.g. per-band tilt).
    cutoff:   f64TrajectoryArray(1, { order: 2 }),  // filter cutoff Hz + dHz/s
    azimuth:  f64TrajectoryArray(1, { order: 2 }),  // pan angle + angular vel
    morph:    f64TrajectoryArray(1, { order: 2 }),  // IR / wavetable morph
  }).withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } });
}
```

Producer (main thread or worker) stamps `tMacroNs` and writes **position +
velocity** per field (velocity = the slope it's currently sweeping at; 0 for a
held value → prediction collapses to hold, which is correct). The worklet:

```ts
// worklet.js per quantum (tier 4)
const r = this.macro.pullPredictedLatest(this.macroOut, {
  leadMs: this.macro.lastReadbackMedianMs(), // forward-compensate the readback wall
  maxLeadMs: 20,
  confidenceFloor: 0.25,                      // cold/jittery clock → just hold
  consumerNs: currentTime * 1e9,             // warms the PLL (sole macro pull)
});
const cutoffHz = this.macroOut.cutoff[0];     // already where it'll be when heard
const azimuth  = this.macroOut.azimuth[0];
// apply cutoffHz to the carrier filter + azimuth to the L/R pan of carrier+residual
```

### 3.3 Feeding the readback median (concrete, already half-built)

`examples/hybrid-residual/worker.js` **already measures `lastReadbackUs`** and
posts it in its telemetry (~4×/sec). Wiring tier 4's lead source is therefore:

1. Worker already has the number → post it (it does, as `lastReadbackUs`).
2. `main.js` relays it to the worklet via the input lane or a `port.postMessage`.
3. Worklet calls `this.macro.recordReadbackLatency(lastReadbackUs / 1000)` (µs→ms).
4. `lastReadbackMedianMs()` now returns a live median → feeds `leadMs`.

No new measurement code — just plumbing an existing number to the consumer handle.
(Reminder from 0.9.71: readback latency is producer-side-measured by construction;
the PLL can't recover it. This plumbing IS the intended path.)

### 3.4 New residual *content* (tier 3 frontier — examples-only)

The brief lists residual content the stack hasn't demonstrated:

- **Convolution tail.** WGSL residual = an FFT/partitioned convolution of an
  impulse response against the carrier excitation, producing a reverb/room tail.
  Latency-tolerant by nature (tail is diffuse) → ideal residual. Pure
  worker-side WGSL + the existing block bridge; no library change.
- **Spatial field.** Extend the stereo residual to a spatialized field — azimuth
  from tier 4's `azimuth` macro drives an equal-power or simple HRTF-ish pan of
  the residual across L/R (and later 4/6/8 ch via the shipped `channels` option).
  `processAddStereo` / `processAddChannel` already de-interleave; the spatial math
  is worklet/worker-side.

Both are example content, not library surface. They prove tier 3 carries
"timbre + space," not just harmonics.

### 3.5 Deliverables for 0.9.72

- `examples/hybrid-four-tier/` — `index.html`, `serve.mjs`, `main.js`, `worker.js`,
  `worklet.js`, `schema.js` (+ a `dev:four-tier` script in `package.json`).
  Reuse the hybrid-residual-stereo worker/worklet as the base; add the macro
  bridge + predictive pull + spatial pan + (optional) convolution-tail WGSL.
- README §"Hybrid residual mode" gains a "Four-tier stack" subsection with the
  topology diagram + the tier-4 snippet, and an explicit "predict smooth macros,
  never the carrier" rule.
- A headless regression pin: a Node test that constructs the macro schema, warms
  the PLL, and asserts `pullPredictedLatest` leads a sweeping `cutoff` forward and
  collapses to hold on a held value (composes the 0.9.71 pins; ~1 new suite or a
  few pins appended to `Bridge.predictLatest.test.ts`).
- CHANGELOG `[0.9.72]` + ROADMAP shipped row + this doc flipped to a
  "shipped postscript."

**Versioning**: patch (0.9.72). Examples + docs + maybe a test pin; no wire
change, no breaking API. Same call as 0.9.49. If a small *additive* API turns out
worth it (see §4), it stays patch unless it touches the wire or breaks a public
type.

---

## 4. Follow-on gaps that "push harder" (after the four-tier demo)

Ordered by leverage for *this* theme. Each is independent; none blocks the 0.9.72
demo. Cross-refs are to `docs/hybrid-residual-comparison.md`.

| # | Gap | Why it pushes the stack | Cost / kind |
|---|-----|-------------------------|-------------|
| 1 | **Polyphony** (Gap #2) | N CPU carriers + one chord-driven GPU residual. The single biggest "real music" unlock after the four-tier demo. | 400–800 LOC, example + maybe small API. Patch unless schema/wire. |
| 2 | **Residual gain envelope** (Gap #4) | `processAddRamp(out, g0, g1, count?)` / `processAddEnveloped(out, gainArr)` — per-sample attack/release on just the residual. Small *additive* API. | 100–150 LOC + pins. Patch. |
| 3 | **Crossfade-on-stall** (Gap #5) | Continuous residual fade over staleness instead of the binary drop, using the shipped `lastSuccessfulPullTime()`/`elapsedSeconds()`. Constructor opt `stallFadeMs?`. | 150–250 LOC + pins. Patch. |
| 4 | **Multi-resolution residual** (Gap #10) | Fast (B=256, ~21 ms) transient layer + slow (B=4096) steady-state layer, both `processAdd`-ed. Finer latency control of "space." | 500–800 LOC, two rings. Patch (examples) or small API. |
| 5 | **Latency-compensated sync** (Gap #9) | Opt-in `carrierDelayMs?` to phase-align carrier with residual when phase coherence matters. Trades tier-2 latency for coherence; knob, not default. | 200–300 LOC + pins. Patch. |
| 6 | **Envelope-follows-carrier** (Gap #13) | Auto-duck residual gain by carrier RMS. Pure worklet pattern, doc-only. | 50–100 LOC example. Patch. |
| 7 | **Predictive carrier** (Gap #6) | Carrier tracks residual pitch hint (peek next block). Distinct from tier 4. Needs `peekBlock`/`peekLatest` + schema pitch-hint lane. | 300–500 LOC. Patch-to-minor depending on schema. |

**Recommended order after 0.9.72**: polyphony (biggest user-visible unlock) →
residual gain envelope + crossfade-on-stall (cheap, both improve the demo's
musicality and degradation feel) → multi-resolution / latency-comp as deeper
experiments.

---

## 5. Risks, gotchas, and invariants to respect

- **PLL must be warmed for tier 4 to engage.** `pullPredictedLatest` only predicts
  when the PLL is locked with low sigma. The worklet MUST pass `consumerNs:
  currentTime*1e9` every quantum so the macro bridge observes. A cold PLL → pure
  hold (safe, but no compensation). Make the macro pull the *sole* per-quantum
  observe of that bridge (don't also `pullEvaluatedLatest` it).
- **Velocity must be real.** Forward extrapolation needs the producer to stamp
  *velocity* in the order-2 trajectory, not just position. If the producer writes
  position-only (velocity = 0), prediction degrades to hold and tier 4 does
  nothing. The producer computes velocity as the current sweep slope (e.g. finite
  difference of the last two control values ÷ dt).
- **Three handles, one SAB each.** Input lane, macro bridge, block ring are three
  separate SABs, all passed through `processorOptions`. Keep them distinct; don't
  multiplex.
- **`confidenceFloor` is the safety valve.** Default it ~0.2–0.3 in the demo so a
  jittery clock (mobile, contended thread) collapses macros to hold rather than
  wobbling. The carrier is unaffected either way.
- **Stereo cursor contract.** `processAddStereo` advances the block cursor once
  for both channels — do not call `processAddChannel` twice for L/R (double
  advance). The shipped stereo example is the reference.
- **Role lattice (0.9.45).** The worklet handles are `"worklet"`-branded; no
  `waitForData`/`subscribeTelemetry` there. Telemetry stays worker/main-side.
- **Don't predict the carrier, ever.** Repeat for the next implementer: tier 4 is
  smooth macros only. Pitch/attack/gesture go through tiers 1+2.

---

## 6. Quick-start for the next session

1. `cp -r examples/hybrid-residual-stereo examples/hybrid-four-tier` as the base
   (it already has stereo carrier + `processAddStereo` + input lane).
2. Add `schema.js → makeMacroSchema()` (§3.2) and allocate a third SAB in
   `main.js`; spawn a macro producer that stamps position+velocity+`tMacroNs`.
3. Worklet: add the macro consumer handle + the tier-4 `pullPredictedLatest`
   block (§3.2); apply `cutoff` to a carrier filter and `azimuth` to L/R pan.
4. Plumb the worker's existing `lastReadbackUs` → `recordReadbackLatency` (§3.3).
5. (Optional, same patch) swap/extend the WGSL residual to add a convolution tail
   and azimuth-driven spatial pan (§3.4).
6. Add the regression pin (§3.5), update README/CHANGELOG/ROADMAP, run the
   gates (`npm run typecheck && npm test && npm run bench`), ship **0.9.72**.

Everything tier-4 needs already exists and is tested (0.9.71 pins 90–98). This
ship is composition + content, not new protocol — which is exactly why the hybrid
pattern was designed to be pushed this way.

— end of handoff —
