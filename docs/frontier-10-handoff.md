# Closing the last rung — handoff note (`emitWorkletReader` seamlessness + `connect()` latency-budget sizing)

**Status**: **SHIPPED** (0.9.47, 2026-05-28). Both parts landed as a single combined patch. Implementation-grade spec for two small, additive refinements that take two shipped frontier tracks from 9.x → 10. See the "Shipped postscript" at the bottom for the actual landed API + the one deviation.
**Author**: maintainer + Claude (2026-05-28 handoff).
**Scope**: both refinements are wire-equivalent, source-compatible, and additive (new optional surfaces only). Each is a **patch** under the CLAUDE.md policy; they can land together or independently.

## Why this note exists

Two frontier tracks shipped at 9-ish, not 10, for reasons that are small, real, and the last rung:

> **`emitWorkletReader` (0.9.44)** returns a *source string* the caller must themselves get into the worklet (eval / Blob / build step) — an unavoidable boundary (source has to cross into `AudioWorkletGlobalScope`) but still a sharp edge that leaves the codegen story one rung short of seamless.
>
> **`connect()` (0.9.46)** maps `latencyHint → capacity` through a *fixed table* (64 / 256 / 1024 macro). A 10 derives the capacity from the declared schema's `frameByteSize` and the output buffer, so the backlog is computed from the *actual latency budget*, not bucketed.

This note closes both. Each part is self-contained; read the one you're implementing.

---

# Part A — `emitWorkletReader`: close the source-string boundary

## The sharp edge today

`src/emitWorkletReader.ts` exports exactly one function:

```ts
export function emitWorkletReader(
  input: Schema<…> | SchemaLayoutDescription,
  opts?: EmitWorkletReaderOptions, // { functionName?, viewParam?, slotParam?, outParam?, includeInvariant?, bodyOnly? }
): string; // emits `function readFrame(view, slot, out) { … }`
```

It hands back a **string**. To actually use it on the audio thread the caller must do the plumbing themselves, in one of three ways, each with a footgun:

1. **`new Function(src)`** on the main thread — works for tests / Standard-mode (main-thread) consumers, but is invisible to the worklet and trips strict CSP (`unsafe-eval`).
2. **`Blob` + `URL.createObjectURL` + `audioWorklet.addModule(url)`** — but `emitWorkletReader` emits a *bare function*, not a `registerProcessor(...)` module, so `addModule` of it does nothing useful. The caller has to wrap it in a processor template by hand.
3. **Build step** — paste the string into a `.js` file the bundler ships. CSP-safe and the production-correct path, but requires the caller to wire codegen into their build, which is exactly the friction the track was trying to remove.

The boundary (source must cross into the worklet realm) is genuinely unavoidable. What's *not* unavoidable is making the caller hand-roll the Blob/eval/template plumbing. **The 10 ships that plumbing.**

## Design — three additive helpers (no change to `emitWorkletReader`)

Keep `emitWorkletReader` exactly as is (it's the primitive). Add a thin convenience layer in the same module.

```ts
// ── src/emitWorkletReader.ts (additive) ──────────────────────────────────

/** Wrap the emitted reader in a self-registering AudioWorklet PROCESSOR
 *  module. `processorName` is the name passed to `registerProcessor` (and to
 *  the `AudioWorkletNode` ctor). `processBody` is the caller's per-quantum
 *  body, spliced in with the reader function + a pre-built `out` frame and the
 *  `slot`-resolution already in scope. Returns a complete ES module source
 *  string ready for a Blob. */
export function emitWorkletProcessorModule(
  input: EmitWorkletReaderInput,
  opts: EmitWorkletProcessorOptions, // { processorName, processBody, capacity?, headerBytes?, ...EmitWorkletReaderOptions }
): string;

/** Convenience: wrap ANY emitted source (reader or processor module) in a
 *  `Blob` and return an object URL ready for `audioWorklet.addModule(url)` or
 *  dynamic `import(url)`. Returns `{ url, revoke }`; the caller calls
 *  `revoke()` after `addModule` resolves (or on teardown). Guards: throws a
 *  clear error if `Blob` / `URL.createObjectURL` are absent (SSR / Node). */
export function toWorkletModuleURL(source: string): { url: string; revoke: () => void };

/** Convenience for NON-worklet threads (tests, Standard-mode main-thread
 *  consumers): compile the emitted reader to a live function via `new
 *  Function`. Returns `(view: DataView, slot: number, out: FrameFor<S>) =>
 *  void`. Documented to require `unsafe-eval` CSP; not for the audio thread
 *  (where eval is unavailable anyway). */
export function compileWorkletReader<S extends Schema<…>>(
  input: S | SchemaLayoutDescription,
  opts?: EmitWorkletReaderOptions,
): (view: DataView, slot: number, out: FrameFor<S>) => void;
```

### `EmitWorkletProcessorOptions`

```ts
export interface EmitWorkletProcessorOptions extends EmitWorkletReaderOptions {
  /** Name for `registerProcessor(name, …)` + the `AudioWorkletNode` ctor. */
  readonly processorName: string;
  /** The per-quantum body. Runs inside `process(inputs, outputs, params)`.
   *  In scope when it runs: the emitted reader fn (default `readFrame`), a
   *  reusable `out` frame object (pre-allocated in the ctor — NOT per quantum),
   *  the `DataView` over the SAB (`this._view`), `this._capacity`, and a
   *  `slotOf(writeIndexMinus1)` helper. The body returns `true`/`false` like a
   *  normal processor. */
  readonly processBody: string;
}
```

The processor-module emitter is the piece that makes `addModule` "just work": it bakes the reader, a ctor that takes the SAB via `processorOptions`, the per-field `out` allocation, and the caller's `processBody` into one self-registering module. The caller's flow collapses to:

```ts
// main thread
const url = toWorkletModuleURL(
  emitWorkletProcessorModule(layout, { processorName: "macro-reader", processBody: MY_BODY }),
);
await ctx.audioWorklet.addModule(url.url);
url.revoke();
const node = new AudioWorkletNode(ctx, "macro-reader", { processorOptions: { sab, capacity } });
```

No hand-written Blob, no template, no build step required — but the build step remains available (just write `emitWorkletProcessorModule(...)` output to a file) for CSP-strict deployments.

## The unavoidable boundary + the CSP caveat (document, don't hide)

A 10 is honest about what it can't remove:

- **Source must cross into the worklet realm.** `addModule` takes a URL; `toWorkletModuleURL` makes that URL from a Blob. That's the boundary; the helper just removes the keystrokes.
- **CSP.** `blob:` in `script-src` (or `worker-src`) is required for `toWorkletModuleURL` + `addModule`; `unsafe-eval` for `compileWorkletReader`. Apps with strict CSP must use the **build-step path** (emit to a file the bundler serves). The note's job is to make this a documented choice, not a surprise: the helpers carry a one-line JSDoc CSP warning and the README §codegen gains a "Getting the reader into the worklet" subsection with the three paths and their CSP posture.

## Tests (extend `tests/Bridge.codegen.test.ts`)

- `compileWorkletReader` round-trips bit-exactly vs `Bridge.pull` (the existing pin already proves the *string* does; this proves the *compiled function* does).
- `emitWorkletProcessorModule` output (a) contains exactly one `registerProcessor(<processorName>, …)`, (b) embeds the reader fn, (c) is import-free/require-free, (d) parses via `new Function` (smoke — it won't *run* outside a worklet, but it must parse).
- `toWorkletModuleURL` throws a clear error when `URL.createObjectURL` is stubbed absent (Node path); returns a `blob:`-prefixed url + a `revoke` fn when a minimal stub is present.

## Scope / ship (Part A)

Additive: three new exports + one options interface; `emitWorkletReader` unchanged. Patch bump. No wire change. The headline `emitWorkletProcessorModule` + `toWorkletModuleURL` pair is the rung-closer; `compileWorkletReader` is a small bonus for the test/main-thread path.

---

# Part B — `connect()`: derive capacity from the latency budget, not a bucket

## The bucket today

`src/connect.ts` sizes rings from a three-value enum via a fixed table:

```ts
const HINT_TABLE: Record<LatencyHint, { macro: number; input: number }> = {
  tracking:   { macro: 64,   input: 256 },
  balanced:   { macro: 256,  input: 512 },
  throughput: { macro: 1024, input: 2048 },
};
// capacity = nextPow2(override ?? HINT_TABLE[hint][lane]); clamped to 2^30.
```

The table is a reasonable default, but it is *bucketed*: "tracking" is 64 frames regardless of how much audio a frame actually represents or what the consumer's output buffer is. A frame carrying 1024 PCM samples at 48 kHz is **21 ms** of audio; 64 of them is **1.36 s** of potential backlog — wildly more than a "tracking" caller wants. The bucket ignores the two facts that actually set the latency: **how much audio one buffered frame is** (derivable from `schema.frameByteSize`) and **the consumer's output buffer / sample rate**.

## The insight — `frameByteSize` → per-frame audio duration → backlog

For an **audio-rate / block schema** (a single PCM array field — the `BridgeBlockConsumer` shape), one buffered frame represents a fixed slice of audio:

```
samplesPerFrame = (frameByteSize − headerOfNonAudioFields) / bytesPerSample
                ≈ the lone PCM array field's length          (read from the schema)
frameAudioMs    = 1000 · samplesPerFrame / sampleRate
```

So to bound the buffered backlog to a declared budget `latencyMs`:

```
capacityTarget = ceil(latencyMs / frameAudioMs)
               = ceil(latencyMs · sampleRate / (1000 · samplesPerFrame))
capacity       = nextPow2(max(1, capacityTarget))   // then clamp to 2^30
```

`frameByteSize` enters a second time as a **memory guard**: the resulting SAB is `capacity · frameByteSize` bytes; an optional `maxSabBytes` clamps `capacity` so a large-frame schema can't silently allocate a huge ring.

**Worked example.** 1024-sample f32 frames @ 48 kHz → `frameAudioMs ≈ 21.3 ms`. A `latencyMs: 60` budget → `ceil(60/21.3) = 3` → `nextPow2(3) = 4`. The bucket would have given 256 ("balanced") — a **64×** over-allocation of backlog. The budget path gives 4 frames ≈ 85 ms worst case, matching intent.

### Fallback ladder (when `frameByteSize → samples` isn't defined)

A **control-rate schema** (scalars + non-PCM arrays consumed via `pullLatest`) has no "audio per frame." The ladder:

1. **Block schema (lone PCM array field detected)** → use the `frameAudioMs` math above.
2. **Caller supplies `producerHz`** → `capacityTarget = ceil(latencyMs · producerHz / 1000)` (backlog = N producer frames that fit in the budget). Works for any schema.
3. **Neither** → fall back to the existing enum table (current behavior), so nothing regresses.

The macro path still wants *freshness* and the input lane *completeness*, so the budget applies to the macro ring; the input lane keeps a generous floor (the budget result, but never below the current per-hint input value) because dropping discrete events loses user intent.

## Design — `latencyHint` accepts a budget object (additive)

```ts
// ── src/connect.ts (additive) ─────────────────────────────────────────────

/** Precise latency budget — the "10" alternative to the coarse enum. */
export interface LatencyBudget {
  /** Target buffered-latency budget for the macro ring, in milliseconds. */
  readonly latencyMs: number;
  /** Consumer sample rate. Default 48000. */
  readonly sampleRate?: number;
  /** Audio render quantum (frames the consumer pulls per callback). Default
   *  128. Used as the floor: capacity is never sized below one quantum's
   *  worth of slack. */
  readonly outputBufferFrames?: number;
  /** Producer cadence (Hz) — required to size a CONTROL-rate (non-PCM)
   *  schema from the budget; ignored when the schema is block-shaped. */
  readonly producerHz?: number;
  /** Optional memory ceiling: capacity is clamped so capacity·frameByteSize ≤
   *  maxSabBytes. Default: unbounded (only the 2^30 frame cap applies). */
  readonly maxSabBytes?: number;
}

// widen the existing union — the enum still works unchanged
export type LatencyHint = "tracking" | "balanced" | "throughput" | LatencyBudget;
```

`connect()` resolves capacity per ring: explicit `spec.<ring>.capacity` override still wins (unchanged); else if `latencyHint` is a `LatencyBudget`, run the ladder above using `schema.frameByteSize` + the schema's PCM field length; else the enum table. Surface the result so the caller can see what intent produced:

```ts
// add to ConnectRingHandle (clone-safe; crosses to the peer for diagnostics)
readonly sizing?: {
  readonly resolvedFromBudget: boolean;
  readonly frameAudioMs?: number;   // present iff block-shaped
  readonly estimatedLatencyMs: number; // capacity · frameAudioMs (or backlog/producerHz)
  readonly sabBytes: number;        // capacity · frameByteSize
};
```

This makes the sizing *legible*: `topo.handle.macro.sizing.estimatedLatencyMs` tells the caller exactly what their budget bought, and `sabBytes` exposes the memory footprint that `frameByteSize` drives.

### Detecting the PCM field + bytes-per-sample

Read `schema.compiled.fields`: a block schema has exactly one array field (the PCM lane). `samplesPerFrame = thatField.length`; `bytesPerSample = kindByteSize(thatField.kind)`. If zero or >1 array fields, treat as control-rate (ladder step 2/3). Keep the detection in a small pure helper `audioFramesPerSlot(schema): number | null` so it's unit-testable in isolation.

## Tests (extend `tests/connect.test.ts`)

- `testLatencyBudgetBlockSchema` — a 1024-sample f32 block schema + `{ latencyMs: 60, sampleRate: 48000 }` → macro capacity 4 (worked example); `sizing.frameAudioMs ≈ 21.3`, `sizing.estimatedLatencyMs ≈ 85`, `sizing.resolvedFromBudget === true`.
- `testLatencyBudgetControlSchema` — a scalar control schema + `{ latencyMs: 50, producerHz: 60 }` → capacity `nextPow2(ceil(50·60/1000)) = nextPow2(3) = 4`.
- `testLatencyBudgetFallback` — control schema + budget with NO `producerHz` → falls back to the enum default (256), `sizing.resolvedFromBudget === false`.
- `testMaxSabBytesClamp` — a large-frame schema + tiny `maxSabBytes` → capacity clamped so `capacity·frameByteSize ≤ maxSabBytes` (and ≥ 1); `sizing.sabBytes` respects the cap.
- `testEnumStillWorks` — the three string hints still produce 64/256/1024 (no regression).

## Scope / ship (Part B)

Additive: widen the `LatencyHint` union with `LatencyBudget`, add the `sizing` field on `ConnectRingHandle`, add the `audioFramesPerSlot` helper. The enum remains the default (`'balanced'`), so every existing `connect(...)` call is unchanged. Patch bump. No wire change. Pairs naturally with Part A but is independent.

---

## Combined ship checklist (for the executing session)

1. Part A: extend `src/emitWorkletReader.ts` (+3 exports, +1 options interface); extend `tests/Bridge.codegen.test.ts`.
2. Part B: extend `src/connect.ts` (`LatencyBudget`, widened `LatencyHint`, `sizing` on `ConnectRingHandle`, `audioFramesPerSlot` helper); extend `tests/connect.test.ts`.
3. Wire new exports into `src/index.ts` (Part A's three functions + `LatencyBudget` type).
4. Gates: `npm run typecheck` clean, `npm test` green (the new pins + the 1M concurrent stress), `npm run bench` within budget (neither change touches the hot path — both run at setup / codegen time).
5. Docs: CHANGELOG `### Added` entries for each part; README §codegen "getting the reader into the worklet" subsection + §connect sizing "latency-budget mode"; flip this note's status to **shipped** with a postscript noting the actual API as landed (mirroring the `connect-topology-design.md` postscript convention) and recording any deviations.
6. Versioning: patch(es) in the `0.9.x` line per CLAUDE.md; can be one combined patch or two.

## Why these are genuinely the last rung (and what stays out)

Both are *ergonomics + precision*, not capability — the transports, the codec, and the protocol are untouched. Part A removes the eval/Blob keystrokes while being honest that the source-crossing boundary and the CSP trade-off remain (build-step path stays the CSP-safe default). Part B replaces a 3-bucket guess with the actual `frameAudioMs · capacity = latency` identity, with a clean fallback ladder so non-block schemas don't regress. Neither is a new wire feature; both are the polish that turns "works, with a sharp edge" into "seamless." Explicitly **out of scope**: synthesizing the schema across the wire (still re-supplied at `mount`), auto-detecting producer cadence at runtime (the caller declares `producerHz`), and a CSP-bypass for the worklet boundary (there isn't one — it's documented, not removed).

---

## Shipped postscript (0.9.47, 2026-05-28)

Both parts landed as one combined patch, as specified, with the API shapes essentially unchanged from this note. What actually shipped:

**Part A** — `src/emitWorkletReader.ts` gained the three helpers (`emitWorkletProcessorModule`, `toWorkletModuleURL`, `compileWorkletReader`) plus `EmitWorkletProcessorOptions`, exactly as specified; `emitWorkletReader` is unchanged. The emitted processor module is an anonymous class expression (`registerProcessor("name", class extends AudioWorkletProcessor { … })`) so `processorName` is free of JS-identifier constraints (it can contain `-`), and the ctor reads `sab` + `capacity` from `processorOptions` (falling back to a baked `capacity` when provided). Per-field `out` allocation mirrors `scratchFrame()` (typed arrays for arrays, `0`/`0n` for scalars). `compileWorkletReader` forces the full `function …(){}` form regardless of `opts.bodyOnly`.

**Part B** — `src/connect.ts` widened `LatencyHint` with `LatencyBudget`, added `RingSizing` + the `sizing` field on `ConnectRingHandle`, and exported the pure `audioFramesPerSlot(schema)` detector. The ladder (block-math → `producerHz` → enum fallback), the `outputBufferFrames` floor, the input-lane "never below the balanced enum value" floor, and the `maxSabBytes` clamp-down are all as specified.

**Deviation (one).** The spec listed `sizing.estimatedLatencyMs` as a non-optional `number`. On the fallback path (control schema, no `producerHz`) the per-frame audio duration is genuinely indeterminate, so rather than fabricate a value the shipped field is **`NaN`** there, with `resolvedFromBudget === false` as the honest signal. `frameAudioMs` remains present-iff-block-shaped as specified. The handle-level `sizing` record itself is **absent** for the string-enum path and for an explicit `capacity` override (it is attached only when a `LatencyBudget` was supplied) — `testEnumStillWorks` pins this.

**Tests / gates.** Codegen pins 6–8 + connect pins 103–108 added and green; full Node suite green incl. the 1M-frame concurrent stress (0/10 timeouts); `npm run typecheck` clean; `npm run bench` within budget (hot path untouched). Patch bump `0.9.46 → 0.9.47` per CLAUDE.md (additive, wire-equivalent).
