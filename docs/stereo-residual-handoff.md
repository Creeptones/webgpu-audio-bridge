# Stereo / multichannel hybrid residual — handoff note (`BridgeBlockConsumer` interleaved channels)

**Status**: **✅ shipped (0.9.48, 2026-05-28)** — see the "Shipped postscript" at the bottom for the actual API + deviations. Original spec preserved below as written. Implementation-grade spec for the highest-leverage real-audio feature on the hybrid-residual track: stereo (and N-channel) consumption in `BridgeBlockConsumer<S>`.
**Author**: maintainer + Claude (2026-05-28 handoff).
**Scope**: additive, wire-equivalent, source-compatible. Mono stays bit-identical. Ships as a **patch** under the CLAUDE.md policy: `0.9.47 → 0.9.48`.
**Closes**: Gap #1 ("Stereo / multi-channel support") from [`docs/hybrid-residual-comparison.md`](./hybrid-residual-comparison.md), the doc's own Recommendation 2 ("every adopter who tries the hybrid pattern will hit this gap in the first 30 seconds").

## Why this note exists

The hybrid residual-on-carrier pattern (0.9.41) is **mono**. `BridgeBlockConsumer` requires exactly one `f32Array` field and the demo worklet writes only `outputs[0][0]`. Real audio is stereo at minimum. Stereo is the first feature that makes the hybrid demo feel like an instrument instead of a proof. This note closes it with the lowest-risk shape the gap analysis identified: **interleaved samples in a single `f32Array(channels * blockSize)`**, decoded per-channel on the consumer side.

The key reason this is low-risk: an interleaved schema **still has exactly one `f32Array` field**, so the construction-time schema validation is unchanged, the wire format is unchanged, `BridgeBlockProducer` works as-is (it copies the lone array's full length), and a channels-omitted/`channels: 1` consumer is bit-for-bit the legacy mono path. The entire feature is consumer-side cursor arithmetic.

---

## API surface (additive)

```ts
// ── src/BridgeBlockConsumer.ts ───────────────────────────────────────────

/** Channel memory layout within the lone f32Array samples field.
 *    'mono'        — channels === 1; the legacy path, byte-identical to ≤0.9.47.
 *    'interleaved' — channels ≥ 2 packed L,R,L,R… in ONE f32Array(channels*blockSize).
 *    'planar'      — DEFERRED (throws at construction in 0.9.48). Reserved in the
 *                    type for the future multi-field / multi-ring shape so adding
 *                    it later is non-breaking. */
export type BlockChannelLayout = "mono" | "interleaved" | "planar";

export interface BridgeBlockConsumerOptions {
  readonly underflowPolicy?: BlockUnderflowPolicy;   // unchanged
  /** Channel count. Default 1 (mono, legacy). Restricted to standard audio
   *  layouts. */
  readonly channels?: 1 | 2 | 4 | 6 | 8;
  /** Sample layout. Default 'mono' when channels===1, else must be 'interleaved'
   *  ('planar' throws in 0.9.48). */
  readonly layout?: BlockChannelLayout;
}
```

New methods on `BridgeBlockConsumer<S>`:

```ts
/** Additive per-channel mix. SUMS gain * residual[channelIndex] into out[i]
 *  for `count` per-channel samples AT THE CURRENT CURSOR, then advances the
 *  cursor by `count` per-channel samples. Returns the number of per-channel
 *  samples actually mixed before any underflow (== count on a full window).
 *  Underflow leaves out's unfilled tail UNTOUCHED (hybrid carrier-survives
 *  semantics, same as processAdd). */
processAddChannel(
  out: Float32Array,
  channelIndex: number,
  gain?: number,        // default 1
  count?: number,       // default out.length
): number;

/** Convenience for the common stereo case: mix channel 0 → left and channel 1
 *  → right from the SAME cursor window, advancing the cursor ONCE by `count`.
 *  Requires channels >= 2. Returns per-channel samples actually mixed. */
processAddStereo(
  left: Float32Array,
  right: Float32Array,
  gain?: number,        // default 1
  count?: number,       // default Math.min(left.length, right.length)
): number;
```

### The cursor-advance contract (the crux — read this twice)

The interleaved frame is `[L0,R0,L1,R1,…,L_{B-1},R_{B-1}]` for `blockSize = B` per-channel samples and `channels = C`. Sample for channel `c` at per-channel index `j` lives at flat index `j*C + c`. **The cursor walks per-channel-sample units in `[0, blockSize]` — exactly as in mono today** (mono is `C = 1`, where `j*1+0 = j`, so nothing changes).

Both new methods are thin wrappers over a single **private cursor-advancing window-walker** (`_mixWindow`), NOT one over the other:

- `processAddChannel(out, c, g, n)` → mixes channel `c` for the window, advances the cursor by `n`.
- `processAddStereo(L, R, g, n)` → mixes channel 0 into `L` **and** channel 1 into `R` from the **same** window, advances the cursor **once** by `n`.

This split is deliberate and load-bearing:

> **`processAddStereo` is NOT `processAddChannel(left,0)` + `processAddChannel(right,1)`** — that would advance the cursor twice and read two consecutive windows, desyncing L from R. To render one stereo quantum you MUST read both channels from one window and advance once; `processAddStereo` is that atomic op.
>
> `processAddChannel` advances the cursor on every call. It is the right primitive for a **one-channel-per-consumer** topology or for sequential consumption, **not** for rendering multiple channels of the same time window. For >2 channels in one quantum, `processAddStereo` does not suffice — see "Open decision A" for the `processAddChannels(outs[])` question.

Document this contract in the method JSDoc and in the file header in the same voice as the existing "Cursor + checkout discipline" section. A test pin (#26 below) must lock it.

### Legacy `process()` / `processAdd()` when `channels > 1`

`process(out)` / `processAdd(out, gain)` take no channel index, so they are ambiguous for multichannel. **Recommended (Open decision B): throw a clear, guiding error** at call time when `channels > 1` ("use processAddChannel / processAddStereo for multichannel consumers"), rather than silently operating on channel 0 (a footgun that ships wrong-sounding audio). When `channels === 1` they are completely unchanged.

---

## blockSize semantics + construction validation

`this.blockSize` becomes **per-channel** samples:

```
arrayLength = the lone f32Array field's declared length   (unchanged detection)
channels    = opts.channels ?? 1
blockSize   = arrayLength / channels                      (per-channel; cursor walks [0, blockSize])
```

Construction validation (extend the existing exactly-one-f32Array check — keep that check unchanged):

1. `channels` must be one of `1 | 2 | 4 | 6 | 8` (reject others with a clear message).
2. If `channels === 1`: `layout` defaults to / must be `'mono'`. Behaviour is the legacy path verbatim. (`layout: 'interleaved'` with `channels: 1` is harmless and equals mono — accept it, or normalize to mono.)
3. If `channels > 1`:
   - `layout` must be `'interleaved'`. `'mono'` → throw ("channels>1 requires layout:'interleaved'"). `'planar'` → throw ("planar layout is not implemented in 0.9.48; use 'interleaved'").
   - `arrayLength % channels === 0` must hold → else throw (`f32Array length ${arrayLength} is not divisible by channels ${channels}`).
4. `processAddStereo` requires `channels >= 2` at call time (throw otherwise); `processAddChannel`'s `channelIndex` must be an integer in `[0, channels)` (throw otherwise).

`samplesField`, `bridge`, `underflowPolicy`, `framesConsumed()`, `underflowSamples()`, `remainingInFrame()`, `reset()` are unchanged in shape. Add public readonly `channels: number` and `layout: BlockChannelLayout` so callers/tests can introspect.

## Underflow + telemetry semantics

- **Carrier survives per channel.** One interleaved frame = one ring pull, so all channels underflow together. On ring-empty, `processAddChannel` / `processAddStereo` leave the unfilled tail of **every** output buffer untouched — left AND right keep their carrier. This is the headline guarantee; pin it (#27).
- **`framesConsumed()`** counts **ring pulls** (frames), independent of channel count — unchanged meaning.
- **`underflowSamples()`** counts **per-channel window samples** that couldn't be filled (cursor units), so a stereo underflow of K window samples adds K (not 2K). This keeps the counter in the same units as the cursor and as the mono path. Document the unit explicitly.
- `gain === 0` still pulls + advances + counts (drain-without-mix), matching the existing `processAdd` contract. `gain` finiteness + `count` bounds validated identically to `processAdd`.

## Worked example (the canonical stereo schema)

```ts
const residualStereoSchema = defineSchema({
  blockIndex: u64(),
  samples:    f32Array(2 * 1024),   // L,R,L,R…  one ring, one producer timeline
});

const consumer = new BridgeBlockConsumer(bridge, {
  channels: 2,
  layout: "interleaved",
  underflowPolicy: "zero-fill",     // ignored by processAdd* (carrier-survives)
});
consumer.blockSize;   // 1024 (per-channel)
consumer.channels;    // 2

// in process(inputs, outputs):
const [L, R] = outputs[0];          // two planar Float32Array(128) from WebAudio
// …write carrier into L and R…
consumer.processAddStereo(L, R, residualGain);   // fold GPU residual on top
```

One ring, one producer timeline, interleaved bytes — exactly the gap analysis's recommended first shape. `BridgeBlockProducer` needs no change: it copies the lone array's full `2*1024` length; the producer (or the example worker) just has to fill it interleaved.

---

## Tests (extend `tests/BridgeBlockConsumer.test.ts`, continue numbering at 22)

Reuse the existing `makeBridge` / `pushRampFrame` helpers; add an interleaved ramp helper that fills `samples[j*C + c]` so channel `c`'s de-interleaved stream is a known per-channel ramp (e.g. channel 0 = even ramp, channel 1 = ramp + 0.5 offset, so L/R are distinguishable).

- **22. Mono backward-compat** — `channels: 1` (and `channels` omitted) construct identically: `blockSize === arrayLength`, `channels === 1`, `layout === 'mono'`; run the pin-3 ramp and assert byte-identical output to the legacy path. (Belt-and-suspenders that the refactor didn't move mono.)
- **23. Interleaved construction** — `channels: 2, layout: 'interleaved'` on `f32Array(2*1024)` → `blockSize === 1024`, `channels === 2`. Introspection surfaces correct.
- **24. Construction validation** — `arrayLength % channels !== 0` throws; `channels > 1` with `layout: 'mono'` throws; `layout: 'planar'` throws (not-yet-impl); `channels: 3` (not in the allowed set) throws.
- **25. processAddStereo cursor advancement (headline)** — push interleaved ramp frames; consume via `processAddStereo(L, R)` in 128-quanta with `L`/`R` pre-zeroed each quantum; assert L is channel-0's de-interleaved ramp and R is channel-1's, across frame boundaries, with **one** cursor advance per call (`framesConsumed` increments once per `blockSize` per-channel samples, NOT once per `blockSize*channels`). Non-divisor quantum variant too.
- **26. processAddChannel single-channel + cursor contract** — `processAddChannel(out, 1)` mixes only channel 1 and advances the cursor; a second `processAddChannel(out, 1)` reads the NEXT window (proving the advance-on-every-call contract, and that it's a one-channel-per-consumer tool, not a stereo renderer).
- **27. Interleaved underflow preserves the carrier per channel** — ring empty; `L`/`R` pre-filled with distinct sentinels; `processAddStereo` leaves BOTH untouched and `underflowSamples()` ticks by the per-channel window count. Mid-window underflow variant: head of L/R gets real adds, tails of BOTH keep their carrier (not zero-fill, not hold-last). **This is the "carrier remains untouched per channel" pin the feature is judged on.**
- **28. Legacy methods guarded under multichannel** — with `channels: 2`, `process(out)` and `processAdd(out)` throw the guiding error (or, if Open decision B lands as "channel 0", assert channel-0 behaviour instead — decide before writing).
- **29. Telemetry parity** — `framesConsumed` counts ring pulls regardless of channels; `underflowSamples` in per-channel units; `reset()` zeroes both and discards the in-flight interleaved frame.

All pins via the existing `assert`/`assertEq`/`ok` helpers; append to `main()`'s call list; update the file-header pin index comment.

## Example — `examples/hybrid-residual-stereo/`

Mirror `examples/hybrid-residual/` (six files: `index.html`, `main.js`, `schema.js`, `worker.js`, `worklet.js`, `serve.mjs`) and add an `npm run dev:hybrid-residual-stereo` script in `package.json`:

- **`schema.js`** — `f32Array(2 * BLOCK_SIZE)`, `channels: 2`.
- **`worker.js`** — produce an **interleaved** residual (the partial-stack synth from the mono demo, written L,R,L,R…). Simplest first cut: a stereo widener — same partials, slight per-channel phase/detune offset on R so the stereo image is audible. Fills `samples[2*i] = L_i`, `samples[2*i+1] = R_i`.
- **`worklet.js`** — carrier into both `outputs[0][0]` and `outputs[0][1]` (e.g. hard-panned-center sawtooth, or a tiny L/R detune for width), then `consumer.processAddStereo(out[0], out[1], residualGain)`. Keep the three A/B modes (`hybrid` / `replace` / `carrier-only`); for `replace` mode call `processAddStereo` onto zeroed L/R (or add a stereo `process` variant — see Open decision C). Set the `AudioWorkletNode` with `outputChannelCount: [2]`.
- **`main.js`** / **`index.html`** — same control surface (carrier freq, residual gain, mode, simulate-GPU-stall) plus a stereo-width control and an L/R level meter so the stereo image and the "carrier survives the stall on both channels" story are visible.

Keep the README §"Audio-rate mode" / §"Hybrid residual-on-carrier mode" cross-links; add a short "Stereo / multichannel" subsection documenting the interleaved convention, the `channels` / `layout` options, the cursor-advance contract, and that `process()`/`processAdd()` are mono-only.

---

## Combined ship checklist (for the executing session)

1. `src/BridgeBlockConsumer.ts`: add `channels`/`layout` options + `BlockChannelLayout` type; refactor the cursor walk into a private `_mixWindow(outsByChannel, gain, count)` core; add `processAddChannel` + `processAddStereo` as wrappers; add `channels`/`layout` readonly fields; extend construction validation; guard legacy `process`/`processAdd` under multichannel (per Open decision B). Keep mono paths byte-identical.
2. `src/index.ts`: export `BlockChannelLayout` (type). `BridgeBlockConsumerOptions` is already exported.
3. `tests/BridgeBlockConsumer.test.ts`: pins 22–29.
4. `examples/hybrid-residual-stereo/` + `package.json` `dev:hybrid-residual-stereo` script.
5. Gates: `npm run typecheck` clean; `npm test` green (incl. the 1M-frame concurrent stress); `npm run bench` within budget (the new code is consumer-side and runs at audio-quantum rate, but the hot loop is the same fused multiply-add — confirm no regression on the existing `processAdd` bench cells, and consider adding a `processAddStereo` cell).
6. Docs: CHANGELOG `[0.9.48]` block (Added / Why / Wire compatibility / Tests / Documentation) mirroring the established shape; README stereo subsection; flip THIS note's status to **shipped** with a postscript recording the actual API + any deviations (mirror the `frontier-10-handoff.md` postscript convention); flip Gap #1 in `docs/hybrid-residual-comparison.md` to "shipped (0.9.48)".
7. Versioning: patch `0.9.47 → 0.9.48`. Additive + wire-equivalent → patch per CLAUDE.md. (Mono unchanged; the only public-surface change for existing callers is the new optional options + methods. `blockSize`'s meaning changes ONLY for `channels > 1`, which is brand-new, so it is not a break.)

## Open decisions (resolve before/at implementation; default in **bold**)

- **A. >2 channels API.** `processAddStereo` covers 2ch. For 4/6/8ch in one quantum, the per-call-advances `processAddChannel` can't render one window across channels. Options: **(a) ship 2ch fully now, accept `channels: 4|6|8` in the type but document N>2 multi-channel rendering as needing a follow-up `processAddChannels(outs: Float32Array[], gain?, count?)` atomic (deferred to a later patch);** (b) implement `processAddChannels(outs[])` now. Default (a) — stereo is the 30-second adopter need; N>2 has no concrete consumer yet. If (a), make `processAddStereo` throw for `channels` that are declared but where the caller only wired 2 — actually just require `channels >= 2` and read ch0/ch1.
- **B. Legacy `process()`/`processAdd()` under `channels > 1`.** **Throw a guiding error** (recommended — no silent wrong-channel audio) vs. operate on channel 0. Pin #28 follows whichever lands.
- **C. A `process`-style (replacing) stereo method?** The hybrid demo's `replace` mode needs a stereo overwrite. **Default: don't add a new replacing method; the example's `replace` mode zeroes L/R then `processAddStereo`s** (one fewer public method to commit to pre-1.0). Revisit if a non-hybrid stereo block consumer appears.
- **D. `underflowSamples` units for stereo.** **Per-channel window samples (cursor units)** — keep parity with the cursor + mono. Documented either way.

## What stays out (explicit non-goals)

- **Planar layout / multiple `f32Array` fields** — reserved in the `BlockChannelLayout` type, throws in 0.9.48. The "two consumers + two schemas" shape from the gap analysis is also out (it doubles ring depth/memory; revisit only if a hard channel-isolation requirement appears).
- **Standard mode** — `BridgeBlockConsumer` is Turbo-only (gap-analysis §"MessageChannelBridge + BridgeBlockConsumer interaction"); the block-mode latency floor compounding with Standard's 5–50 ms transport floor puts interactive carrier latency past the perceptual threshold. Documented non-goal.
- **Producer-side stereo helper / GPU interleaving** — `BridgeBlockProducer` works as-is (copies the lone array's full length); producing interleaved data is the producer's job. No new producer class.
- **Polyphony, per-channel independent rings, sample-accurate parameter binding** — Gaps #2+ in the comparison doc, separate tracks.

## Why this is the right next feature (and right-sized)

It's the highest-leverage *real* feature on the hybrid track: the gap analysis flags it as the wall every adopter hits in the first 30 seconds, and stereo is what turns the demo from a proof into an instrument. Yet the engineering is low-risk — interleaved keeps one `f32Array`, one ring, one producer timeline, no wire change, mono bit-identical — so almost all the work is consumer-side cursor arithmetic + the example. The psychoacoustic carrier/residual split applies in stereo exactly as in mono; the only genuinely new design surface is the cursor-advance contract for multi-channel-per-quantum rendering, which `processAddStereo` resolves cleanly and pin #25/#26 lock down.

---

## Shipped postscript (0.9.48 — 2026-05-28)

Shipped exactly as specced. The API, cursor math, telemetry units, and ship plan all landed as written; no behavioral deviations.

**API as shipped** (matches the spec verbatim):
- `BlockChannelLayout = "mono" | "interleaved" | "planar"`; `BridgeBlockConsumerOptions` gained `channels?: 1|2|4|6|8` + `layout?`; public readonly `channels` / `layout`; `blockSize` is per-channel.
- `processAddChannel(out, channelIndex, gain?, count?): number` and `processAddStereo(left, right, gain?, count?): number`, both thin wrappers over a private `_mixWindow(nOuts, gain, count)` walker that reads from preallocated `_outs` / `_chans` scratch arrays (allocation-free hot path — a small deviation from the spec's `_mixWindow(outsByChannel, gain, count)` signature, same behavior).
- Legacy `process()` / `processAdd()` throw under `channels > 1`. Construction validation: channels-set / divisibility / channels>1+mono / planar all throw; `channels: 1` normalizes `layout` to `'mono'`.

**Open decisions resolved at the spec defaults:** A → ship 2ch, accept 4|6|8 in the type, defer `processAddChannels(outs[])`; B → throw; C → no replacing stereo method (example "replace" mode zeroes L/R then adds); D → `underflowSamples()` in per-channel cursor units.

**Tests:** pins 22–29 in `tests/BridgeBlockConsumer.test.ts` (all 29 green; full suite + 1M-frame concurrent stress pass).

**Bench:** added a `processAddStereo` cell to `bench/Bridge.bench.ts` (≈ 0.7 µs/quantum, ~0.4 µs over mono `processAdd` — both far under the ~2.67 ms worklet budget). `push`/`pull`/`pullLatest` within baseline.

**Deviations from the spec:**
- The stereo demo serves on **port 5178** (not an unassigned slot in the spec) because 5177 is taken by `bench:hybrid-residual`.
- `_mixWindow` signature uses preallocated `(_outs, _chans, nOuts)` scratch instead of passing an `outsByChannel` array per call, to keep the audio-thread path allocation-free. No observable difference.
- Worklet diag drops the mono demo's RMS instrumentation in favor of a cheap per-channel peak meter (L/R), since the stereo demo's story is the stereo image, not the RMS continuity ratio (that lives in the mono bench).

**Docs:** README §"Stereo / multichannel"; CHANGELOG `[0.9.48]`; Gap #1 flipped to shipped in `docs/hybrid-residual-comparison.md`; this note flipped to shipped.
