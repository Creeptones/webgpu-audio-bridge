# Record/replay deterministic control timeline + offline bounce — design note

**Status**: **shipped** (2026-05-28, patch bump). Ships `src/TimelineRecorder.ts` (recorder + player + codec) as a standalone additive module; no `Bridge.ts` mutation.
**Author**: maintainer + Claude (2026-05-28 design + ship).
**Shipped scope**: MVP1 shape (b) below — `TimelineRecorder<S>` snapshot capture + schema-tagged `serialize()`/`deserialize()` + deterministic `TimelinePlayer<S>` offline bounce. Slug: `record-replay-timeline`.

## Executive summary

Today the bridge is a *live medium*: a producer pushes control frames into a `SpscRing<S>`, a consumer pulls the freshest one per audio quantum and extrapolates it to sample resolution via the Taylor evaluator + PLL clock recovery. Nothing in the system is *recordable* or *re-renderable*. There is no way to:

1. Capture exactly the stream of frames a producer emitted, with their macro timestamps, to a portable artifact.
2. Replay that artifact later, at an arbitrary target sample rate, and get **bit-identical output** across runs and across machines.
3. Bounce the timeline **faster than real time** for offline rendering (export to WAV, regression-pin a render, fuzz an audio graph deterministically).

This track turns the bridge into a recordable, deterministic, re-renderable medium by adding **one standalone module** — `src/TimelineRecorder.ts` — exporting three cooperating pieces:

- **`TimelineRecorder<S>`** — captures pushed frames as `(tMacroNs, frameSnapshot)` tuples into a growable heap buffer (zero SAB, zero Atomics). Snapshots reuse the existing schema codec byte layout, so a recorded frame is byte-identical to what would have crossed the ring.
- **`serialize()` / `deserialize()`** — pack/unpack the captured tuples to a compact, **schema-tagged** `ArrayBuffer`. The tag is a hash of `describeLayout()` so a deserialize against a mismatched schema is rejected loudly rather than silently mis-decoding.
- **`TimelinePlayer<S>`** — given a target sample rate and a *deterministic* consumer clock, replays the tuples sample-accurately and bit-identically, reusing the same `evaluateTrajectoryInto` math the live consumer uses. An offline bounce that can run unbounded-fast.

The key insight: **the live consumer is already deterministic given a fixed `(rawFrame, dt)` pair** — `evaluateInto` is a pure Taylor expansion with no hidden state. The only non-determinism in the live path is the PLL (it observes wall-clock `consumerNs`/`producerNs` arrivals). Record/replay removes the PLL from the loop by capturing the *producer macro timestamps directly* and synthesizing a deterministic consumer clock from `(sampleIndex, sampleRate)`. With the PLL gone, replay is a pure function of `(timeline, sampleRate)` — hence bit-identical.

**Recommendation**: ship shape (b) "snapshot timeline + deterministic offline player" at MVP1 scope. ~520 LOC module + ~240 LOC tests + this note. No new wire format on the live ring; the serialized artifact is a *new, independent* container format that this note pins.

## Why record/replay exists — the problem it solves

The live bridge is excellent for real-time GPU→audio control, but every real audio library eventually needs an **offline render path**:

| Need | Why the live bridge can't do it today |
|---|---|
| Export a deterministic WAV bounce | The consumer's output depends on PLL clock recovery, which depends on wall-clock arrival jitter — not reproducible. |
| Regression-pin an audio render in CI | No artifact captures "exactly these frames at these times"; the SAB is ephemeral and the PLL state is machine-dependent. |
| Faster-than-real-time rendering | The live path is paced by the audio callback (one quantum per 2.7 ms at 48 k / 128). Offline wants to render N minutes in seconds. |
| Reproduce a bug report | "It glitches here" is unactionable without a portable, replayable capture of the control stream. |
| A/B two consumer configs on identical input | Requires feeding *byte-identical* frames at *identical times* to both — impossible with two separate live runs. |

The record/replay medium answers all five with one artifact + one player. It is the audio-control analogue of a MIDI file + a deterministic synth: capture the control events with their times, re-render them anywhere.

## What's already in place

The scaffolding this track reuses (it invents almost no new frame math):

1. **The schema codec is already a pure byte layout.** `schema.compiled.fields` is an ordered list of `CompiledField { name, kind, length, isArray, byteOffset }`. `MessageChannelBridge._encodeFrame/_decodeFrame` (`src/MessageChannelBridge.ts:352-389`) already demonstrate the exact pattern: a `DataView` walk over `compiled.fields`, little-endian scalars via `dv.setFloat64(off, v, true)` / etc., array fields via `Uint8Array.set` over `byteOffset .. byteOffset+byteLength`. The recorder snapshot codec is this same walk into a per-frame `frameByteSize`-wide region.
2. **`buildScratchFrame(schema.compiled.fields)`** (`src/_heap.ts:76`) is the canonical heap-frame factory the player hands to its evaluator. Zero-init scalars, right-kind/right-length typed arrays for array fields.
3. **`describeSchemaLayout(schema)`** (`src/schema.ts:975`) produces a frozen, JSON-safe `SchemaLayoutDescription { headerBytes:32, frameByteSize, fields, timestamps, invariantByteOffset }`. This is the *exact* structure to hash for the schema tag — it captures every byte-layout-relevant fact (field order, kind, offset, array length, trajectory tag) and nothing machine-specific.
4. **The Taylor evaluator is pure and forward-in-time capable.** `evaluateTrajectoryInto(flat, spec, dt, out)` (`src/trajectory.ts`) is `out[i] = p_i + v_i·dt (+ ½ a_i dt²)` — no hidden state, deterministic for any finite `dt`. `Bridge.evaluateInto(srcFrame, dt, outFrame)` (`src/Bridge.ts:883`) only guards `Number.isFinite(dt)` — no max-dt clamp, no sign restriction. The player calls this same math.
5. **The per-sample dt arithmetic already exists** in `Bridge.evaluateAtSampleOffset` (`src/Bridge.ts:1127`): `consumerNs = base + (sampleOffset/sampleRate)·1e9; dt_s = (phaseLockedTime(consumerNs) − cachedTimestampNs)·1e-9`. The player uses the **identical arithmetic minus the PLL** — `phaseLockedTime` collapses to the identity, since recorded macro times *are* the producer clock.
6. **MVP-relevant exclusion already documented**: `MessageChannelBridge` rejects `.withInvariant(...)` schemas because the invariant lane is a SAB-header concern. The recorder applies the same exclusion (the `__invariant` lane is bridge-managed, never in `FrameFor<S>`, and the recorder never sees it).

## Determinism contract (the load-bearing math)

The recorder captures tuples `(tMacroNs_k, snapshot_k)` for `k = 0 .. K−1`, where `tMacroNs_k` is the producer's macro timestamp for frame `k` (read from the frame's declared default timestamp role if the schema has `.withTimestamps(...)`, else supplied explicitly by the caller per-record). Snapshots are stored in producer-emit order.

Replay computes, for output sample index `n` at target rate `R` (Hz), with epoch `t0 = tMacroNs_0`:

```
consumerNs(n)  = t0 + (n / R) · 1e9                      // deterministic — no wall clock
k(n)           = index of the newest tuple with tMacroNs_k ≤ consumerNs(n)   // "latest" selection
dt_s(n)        = (consumerNs(n) − tMacroNs_{k(n)}) · 1e-9
out(n)         = evaluateTrajectoryInto(snapshot_{k(n)}.trajField, spec, dt_s(n), …)   // per trajectory field
```

Three facts make `out(n)` **bit-identical across runs and machines**:

1. **No wall clock.** `consumerNs(n)` is a pure function of `(n, R, t0)`. There is no `performance.now()`, no `AudioContext.currentTime`, no PLL observation. The live path's only non-determinism source is removed by construction.
2. **`k(n)` is a deterministic step function.** Tuples are sorted by `tMacroNs` ascending at deserialize time (recorder already appends in emit order; deserialize asserts monotonic-nondecreasing and rejects otherwise). The "newest tuple at or before `consumerNs(n)`" is a single forward scan with a monotone cursor — O(K + N), no floating-point comparison ambiguity beyond the `≤` on exact f64-decoded ns values.
3. **`evaluateTrajectoryInto` is IEEE-754 deterministic.** It is `+`, `−`, `·` on f64/f32 with a fixed evaluation order (`p + v·dt` then `+ ½·a·dt²`), no transcendentals, no reduction reordering. IEEE-754 pins these operations bit-exactly on every conformant platform (which is every JS engine). The `dt_s(n)` it receives is itself a deterministic f64 expression. Therefore equal inputs ⇒ equal bits.

**Edge cases pinned by the contract:**

- `n` before the first tuple (`consumerNs(n) < tMacroNs_0`): cannot happen for `n ≥ 0` since `t0 = tMacroNs_0` makes `consumerNs(0) = t0`. The player asserts `n ≥ 0`.
- `n` after the last tuple: `k(n)` saturates at `K−1` and `dt_s(n)` grows — a *forward extrapolation*, which the Taylor evaluator already supports. The clamped path (`velocityClamp` etc.) bounds runaway excursions exactly as in the live path. This is intentional: a recorded timeline can be rendered past its last frame, and the result is still deterministic.
- Order-1 trajectory / plain scalar fields: `dt` is ignored (`out[i] = p_i`), so they hold the last snapshot value — deterministic by definition.

**Why faster-than-real-time is free:** nothing in the replay loop blocks on a clock. The player exposes `renderInto(out, startSample, sampleCount)` which the caller drives in a tight loop with no pacing. Rendering 10 minutes of 48 kHz audio is `28.8M` iterations of the same arithmetic the live worklet does per sample — bounded only by CPU, not by real time. The same `renderInto` called once per audio quantum *would* reproduce the real-time path; the offline caller simply calls it as fast as it can.

## Serialized container format (schema-tagged)

`serialize()` produces a single `ArrayBuffer` with this layout (all little-endian, matching the umbrella-view host-endian assumption SpscRing uses):

```
┌─ Header (32 bytes, fixed) ─────────────────────────────────────────────┐
│ off  0 : u32   magic            = 0x57414254  ("WABT", WAB Timeline)    │
│ off  4 : u16   formatVersion    = 1                                     │
│ off  6 : u16   flags            = 0 (reserved; bit0 future: f32 times)  │
│ off  8 : u32   schemaTag        = FNV-1a32 of canonical describeLayout()│
│ off 12 : u32   frameByteSize    = schema.frameByteSize (cross-check)    │
│ off 16 : u32   tupleCount K                                             │
│ off 20 : f64   epochNs t0       = tMacroNs_0 (or 0 if K==0)             │
│ off 28 : u32   reserved = 0                                             │
├─ Times block (K · 8 bytes) ────────────────────────────────────────────┤
│ K × f64 tMacroNs, ascending (monotonic-nondecreasing, asserted)        │
├─ Snapshot block (K · frameByteSize bytes) ─────────────────────────────┤
│ K × frame payload, each encoded by the schema codec walk (LE)          │
└────────────────────────────────────────────────────────────────────────┘
```

**Schema tag** is a 32-bit FNV-1a hash over the *canonical JSON* of `describeSchemaLayout(schema)` (sorted keys, no whitespace). It captures field order, kinds, byte offsets, array lengths, trajectory specs, timestamps spec, and invariant offset — every fact that affects decode correctness — while excluding nothing layout-relevant and including nothing machine-specific. On `deserialize(buf, schema)` the player recomputes the tag from its own `schema` and **rejects** with a precise error if it mismatches, *and* cross-checks `frameByteSize` as a cheap second gate (catches the astronomically-rare hash collision). This is the brief's "schema-tag mismatch rejection" pin.

Rationale for f64 times rather than i64/bigint: macro times are already f64 in the per-sample dt arithmetic (`evaluateAtSampleOffset` multiplies by `1e9` in f64), and f64 exactly represents integer ns up to 2^53 ≈ 104 days of nanoseconds — far beyond any plausible recording. Keeping times f64 avoids a bigint↔number coercion seam in the deterministic loop. (Schemas whose timestamp role is `u64`/`i64` are coerced via `Number(...)` at *record* time, exactly as `SchemaTimestampsSpec.isBigInt` documents the live Bridge does.)

## Proposed signatures (`src/TimelineRecorder.ts`)

```ts
/** One captured control frame: producer macro time + a byte snapshot of the
 *  frame, encoded by the schema codec (same LE byte layout the ring uses). */
export interface TimelineTuple {
  readonly tMacroNs: number;       // producer macro timestamp (f64 ns)
  readonly snapshot: ArrayBuffer;  // frameByteSize bytes, schema-codec encoded
}

/** Options for TimelineRecorder. */
export interface TimelineRecorderOptions<S> {
  /** Timestamp role to read tMacroNs from on `record(frame)`. Defaults to the
   *  schema's default timestamp role. If the schema has no `.withTimestamps`,
   *  callers MUST use `recordAt(frame, tMacroNs)` instead. */
  readonly timestampRole?: TimestampRoleOf<S>;
  /** Initial tuple capacity for the growable buffer (doubles on overflow). */
  readonly initialCapacity?: number;  // default 1024
}

/** Captures pushed frames into a growable heap buffer. Zero SAB, zero Atomics.
 *  Standalone — does not touch Bridge<S>; the caller forwards each frame it
 *  pushes (or would push) to `record` / `recordAt`. */
export class TimelineRecorder<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  constructor(schema: S, opts?: TimelineRecorderOptions<S>);

  /** Snapshot `frame` reading tMacroNs from the configured timestamp role.
   *  Throws if the schema has no timestamps spec. Allocation: one snapshot
   *  ArrayBuffer per call (recording is NOT a hot-loop-allocation-free path —
   *  it is a capture path, documented as such). */
  record(frame: FrameFor<S>): void;

  /** Snapshot `frame` with an explicit macro time. Used when the schema has
   *  no timestamp role, or to override. tMacroNs must be finite and
   *  >= the previously recorded time (monotonic-nondecreasing). */
  recordAt(frame: FrameFor<S>, tMacroNs: number): void;

  /** Number of tuples captured so far. */
  get length(): number;

  /** Drop all captured tuples; reuse the recorder for a new take. */
  reset(): void;

  /** Pack captured tuples into a compact, schema-tagged ArrayBuffer. */
  serialize(): ArrayBuffer;
}

/** Reconstruct a timeline from a serialized buffer, validating the schema tag
 *  against `schema`. Throws TimelineSchemaMismatchError on tag/frameByteSize
 *  mismatch, or TimelineFormatError on bad magic/version/monotonicity. */
export function deserialize<S extends Schema<FieldsObject, any>>(
  buf: ArrayBuffer,
  schema: S,
): TimelinePlayer<S>;

/** Deterministic offline replay of a captured timeline. Given a target sample
 *  rate, replays tuples sample-accurately + bit-identically. No wall clock,
 *  no PLL — output is a pure function of (timeline, sampleRate). */
export class TimelinePlayer<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  readonly tupleCount: number;
  readonly epochNs: number;

  /** Construct directly from in-memory tuples (the recorder's serialize ->
   *  deserialize round-trip uses this internally). `tuples` must be sorted
   *  ascending by tMacroNs. */
  constructor(schema: S, tuples: readonly TimelineTuple[], epochNs: number);

  /** Set the target output sample rate (Hz). Must be set before renderInto. */
  setSampleRate(rate: number): void;

  /** Allocate a reusable evaluated frame (one heap frame, array fields sized
   *  to the trajectory's evaluated sampleCount). Call once outside the loop. */
  scratchFrame(): FrameFor<S>;

  /** Evaluate the timeline at a single output sample index into `out`.
   *  consumerNs(n) = epochNs + (n/rate)*1e9; selects the newest tuple at or
   *  before that time; dt_s = (consumerNs - tMacroNs_k)*1e-9; runs the Taylor
   *  evaluator. Deterministic; allocation-free after scratchFrame(). */
  evaluateAtSample(out: FrameFor<S>, sampleIndex: number): void;

  /** Faster-than-real-time block render. For each sample in
   *  [startSample, startSample+sampleCount), evaluates the timeline and
   *  invokes callback(localIdx, frame). The cursor over tuples advances
   *  monotonically across the block (O(sampleCount + tuplesCrossed)). */
  renderInto(
    frame: FrameFor<S>,
    startSample: number,
    sampleCount: number,
    callback: (localIdx: number, frame: FrameFor<S>) => void,
  ): void;

  /** Total sample count to cover the recorded span at the current rate,
   *  i.e. ceil((tMacroNs_last - epochNs)/1e9 * rate) + 1. Convenience for
   *  "render the whole timeline". */
  totalSamples(): number;
}

export class TimelineSchemaMismatchError extends Error { /* expectedTag, actualTag, expectedFrameByteSize, actualFrameByteSize */ }
export class TimelineFormatError extends Error { /* reason */ }
```

### Internal codec (reused, not reinvented)

`TimelineRecorder` holds private `_encodeFrame(view, buf, byteOffset)` / the player holds `_decodeFrame(out, dv, byteOffset)` — both copies of the `MessageChannelBridge` DataView walk (`src/MessageChannelBridge.ts:352-433`) generalized to take a base byte offset so snapshots can be packed contiguously in the serialized block without per-frame `ArrayBuffer` allocation. Scalars via `dv.set/getFloat64(off, v, true)` etc.; array fields via `Uint8Array.set`. Little-endian pinned to match host umbrella views. (A later patch could extract `src/_frameCodec.ts` shared between MessageChannelBridge and TimelineRecorder; out of scope for MVP1 — duplicate-then-extract is the project's stated idiom, see `_heap.ts:1-9`.)

## Design space — scope options

### Shape (a): full timeline with PLL replay fidelity

Capture the producer frames *and* a recording of the consumer's wall-clock arrival pattern, then replay through the real `ConsumerClockRecovery` so the bounce reproduces the *exact* jitter the live consumer saw.

| Pro | Con |
|---|---|
| Highest-fidelity reproduction of a specific live session, jitter and all. | **Not deterministic across machines** — the whole point of record/replay is bit-identical reproduction; baking in observed jitter defeats it. |
| Could debug a PLL-specific glitch. | Doubles the captured data (must store every `observeConsumerTime` call) and the format. |
| | The PLL has internal EWMA state that would need serialization too — large surface, fragile. |

**Estimated LOC**: 900–1200 + 400 tests. **Effort**: 5–7 weekends. **Verdict**: rejected — fights the determinism goal.

### Shape (b): snapshot timeline + deterministic offline player *(recommended)*

Capture `(tMacroNs, snapshot)` tuples; replay with a synthesized deterministic consumer clock and the pure Taylor evaluator; PLL removed from the loop. Schema-tagged compact container.

| Pro | Con |
|---|---|
| **Bit-identical across runs and machines** — the brief's central requirement, delivered by construction. | Does not reproduce a *specific* live session's jitter (by design — that's shape (a)). |
| Faster-than-real-time is free (no clock in the loop). | Recording allocates one snapshot buffer per `record` call — a capture-path cost, documented, not a hot-audio-path regression. |
| Reuses the schema codec, `buildScratchFrame`, and `evaluateTrajectoryInto` verbatim — almost no new math. | Standard-mode-style exclusion of `.withInvariant` schemas (consistent with MessageChannelBridge). |
| Zero changes to `Bridge.ts` / `SpscRing.ts` / wire format — fully additive. | |
| The container is a portable artifact suitable for CI pins, WAV export, bug repros. | |

**Estimated LOC**: ~520 module + ~240 tests + this note. **Effort**: 2–3 weekends.

### Shape (c): live tee into the ring (record by mirroring SAB slots)

Tap the SAB directly — have the recorder read committed slots out of the live `SpscRing` rather than having the caller forward frames.

| Pro | Con |
|---|---|
| "Free" capture — no caller cooperation. | Requires reaching into `SpscRing` internals → violates "do NOT mutate Bridge.ts / additive only." |
| | Drop-oldest / overrun means the recorder could miss frames the consumer also missed — capture would be lossy and racy. |
| | Couples the recorder to the SAB memory-ordering protocol — exactly the fragile surface this track should avoid. |

**Estimated LOC**: 700+ and a new SAB read path. **Verdict**: rejected — wrong layer, breaks additivity.

## File plan

| File | Status | Contents |
|---|---|---|
| `src/TimelineRecorder.ts` | **new** | `TimelineRecorder<S>`, `TimelinePlayer<S>`, `deserialize`, `TimelineTuple`, `TimelineRecorderOptions<S>`, `TimelineSchemaMismatchError`, `TimelineFormatError`. Self-contained header documenting the container format + the determinism contract (mirrors the math section above). |
| `tests/Bridge.timeline.test.ts` | **new** | Numbered pins (see below). `npx tsx tests/Bridge.timeline.test.ts`. Uses `_assert.ts` + `_bridgeHelpers.ts`. |
| `docs/record-replay-design.md` | **new (this note)** | — |
| `src/index.ts` | *orchestrator-owned* | Will export the new value/type surface. **Not edited by this track.** |
| `package.json` | *orchestrator-owned* | Will wire `Bridge.timeline.test.ts` into `test` (before `Bridge.concurrent.test.ts`) and `test:unit`. **Not edited by this track.** |

## Test pins (`tests/Bridge.timeline.test.ts`)

1. **`testRoundTripDeterminism`** — record a hand-built timeline (mix of trajectory + scalar fields), `serialize()`, `deserialize()`, render the full span twice into separate Float64 capture arrays; assert the two renders are **byte-identical** (`framesEqual` over every sample). Also render directly from the in-memory recorder (no serialize) and assert it equals the deserialized render — pins that the container round-trip is lossless.
2. **`testFasterThanRealTime`** — render a multi-second timeline at 48 kHz in a tight `renderInto` loop with no pacing; assert it completes well under the wall-clock duration of the rendered span (e.g. render 2 s of audio in < 100 ms), and assert sample count == `totalSamples()`. Pins the "no clock in the loop" property without asserting an exact speed (machine-independent: just `renderedSeconds > 10 × wallSeconds`).
3. **`testSchemaTagMismatchRejection`** — serialize against schema A; attempt `deserialize(buf, schemaB)` where B differs in a layout-relevant way (different field kind / extra field / different array length); assert it throws `TimelineSchemaMismatchError` with the expected/actual tags populated. Also pin that a corrupted magic / bad formatVersion throws `TimelineFormatError`, and a non-monotonic times block is rejected.

Plus supporting pins consistent with house style:
4. **`testForwardExtrapolationPastLastFrame`** — render samples past `tMacroNs_last`; assert deterministic + finite (and, with clamps set, bounded).
5. **`testRecordViaTimestampRole`** — schema with `.withTimestamps(...)`; `record(frame)` reads `tMacroNs` from the default role; assert tuples carry the role's value (coerced via `Number` for bigint roles).
6. **`testInvariantSchemaRejected`** — constructing a `TimelineRecorder` over a `.withInvariant(...)` schema throws (consistency with MessageChannelBridge).

## Scope / ship decision

Recommend shape (b), MVP1. It delivers the brief exactly — recordable, deterministic, re-renderable, faster-than-real-time, schema-tagged — with the smallest sustainable surface and zero risk to the live wire path. The module is fully additive; the orchestrator wires exports + the test runner + the version bump afterward. The duplicated frame codec is acceptable per the project's documented duplicate-then-extract idiom; a future `src/_frameCodec.ts` extraction can unify it with `MessageChannelBridge` once a third consumer appears.

Open questions for the maintainer:
- **f64 vs i64 macro times in the container.** This note picks f64 (exact to 2^53 ns ≈ 104 days, avoids a bigint seam in the deterministic loop). If recordings longer than 104 days are ever a concern, bit0 of `flags` reserves an i64-times variant.
- **Whether `renderInto` should hand the caller a *sample-batched* trajectory view** (like `forEachSampleInQuantum`) or a per-sample evaluated frame. MVP1 ships per-sample (simplest deterministic contract); a batched fast path can land as a patch.
