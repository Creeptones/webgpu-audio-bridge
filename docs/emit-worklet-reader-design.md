# Schema-derived zero-import worklet reader codegen (`emitWorkletReader`) — design note

**Status**: **shipped** (2026-05-28, patch bump). Ships `src/emitWorkletReader.ts` + `tests/Bridge.codegen.test.ts`. Patch slot (no wire-format change, net-new public function only) — see [Scope & ship decision](#scope--ship-decision).
**Author**: maintainer + Claude (2026-05-28).
**Decision pending**: no — the codegen function is additive and wire-neutral; it emits a source string and reads existing SAB byte layout. The only open choices (documented below) are the *input type* (Schema vs SchemaLayoutDescription) and the *invariant-lane opt-in*, both resolved here.

## Executive summary

`emitWorkletReader(layout, opts?)` turns a compiled schema layout into a **source string**: a monomorphized, zero-import frame reader for that *exact* schema. Every byte offset is baked in as a numeric literal; there is no runtime offset math, no `kindByteSize()` call, no library import on the audio thread. The emitted function takes a `DataView` over the SAB and a slot index, and writes the frame's fields into a caller-supplied plain object using hardcoded `DataView.getFloat64(off, true)` / `getBigUint64(...)` / etc. accessors at fixed offsets.

This is the "the schema *generates* the hottest read path" track. The library's own `pull`/`pullLatest` path is already fast (umbrella typed-array views + cached per-field readers — see `SpscRing.scalarReaders` / `arrayViews`), but it is *generic*: it loops over `scalarReaders[]` and `arrayLayout[]`, dispatches through closures, and carries the full Bridge dependency graph. A worklet that only needs to *read* one fixed schema can instead `new Function(emitWorkletReader(desc))` once at construction and run a flat, branch-free, allocation-free reader per quantum — with **zero** package code shipped to `AudioWorkletGlobalScope`.

The emitted reader is bit-exact with `Bridge.pull`/`pullLatest` for every `FieldKind` and array field, because both ultimately decode the same little-endian bytes at the same `RING_HEADER_BYTES + slot*frameByteSize + field.byteOffset` addresses.

## Why this exists — the problem it solves

Three forces motivate generated read code:

1. **Zero-import audio thread.** `AudioWorkletGlobalScope` has no module loader in many setups; worklet code is often shipped as a single registered processor string. Pulling the whole `Bridge` graph (`SpscRing`, `FrameSmoother`, `ConsumerClockRecovery`, `AdaptiveFlowController`, `schema.ts`) into a worklet bundle is heavy when all the consumer wants is "read field `vEff` from the newest slot." A generated reader is a self-contained string — paste it into the processor, or `new Function(...)` it, no bundler, no imports.

2. **Monomorphization beats generic dispatch.** `SpscRing`'s generic reader is excellent *because* it's data-driven (one code path for all schemas). But data-driven means: a `for` loop over `scalarReaders`, one indirect call per field, an `arrayViews[i][slot]` subarray lookup per array field, and a `.set()` copy. A schema-specialized reader has the field set, offsets, and accessor methods *inlined* — the JIT sees straight-line code with constant offsets, no closure dispatch, no per-field bounds re-derivation. For a fixed 64-element trajectory grid read every 2.7 ms, the difference is real.

3. **No runtime offset arithmetic.** The generic path computes `slot * frameByteSize + byteOffset + i*elemSize` for array elements at runtime. Codegen folds `frameByteSize`, `byteOffset`, and `elemSize` into literals, leaving only `slotBase + <const>` and `slotBase + <const> + i*<const>` — and `slotBase = 32 + slot*<frameByteSize const>`.

The trade is generality for speed + independence: the emitted reader is welded to one schema. Change the schema, re-emit. That's exactly the right contract for a worklet pinned to a known producer.

## What's already in place

The grounding is solid — this is greenfield codegen over fully-shipped layout machinery:

1. **`CompiledLayout` / `CompiledField`** (`src/schema.ts:465-488`) carry everything: `name`, `kind`, `length` (flat element count — `1` for scalar, `sampleCount*order` for trajectory), `isArray`, frame-relative `byteOffset`, optional `trajectory` tag.
2. **`describeSchemaLayout(schema)`** (`src/schema.ts:974-996`) produces the frozen, postMessage-safe `SchemaLayoutDescription`: `headerBytes: 32` literal, `frameByteSize`, a per-name `{kind, byteOffset, length?}` record (`length` present **iff** `isArray`), `timestamps`, `invariantByteOffset`. This is what already crosses to the worklet today.
3. **`kindByteSize`** (`src/schema.ts:177-184`) and **`kindTsType`** (`src/schema.ts:187-192`) are the canonical size + bigint/number maps. Codegen consults them at *emit* time and bakes literals — it does **not** emit calls to them.
4. **The byte-address formula is fixed and confirmed**: field address in the SAB = `RING_HEADER_BYTES (32) + slot*frameByteSize + field.byteOffset` (`SpscRing.ts:683`); array element `i` adds `i*elemSize`. Umbrella typed-array views are host-endian; this platform is little-endian, which codegen pins as `true` on every `DataView` accessor.
5. **The reference read path** for the bit-exactness pin is `pull`/`pullLatest` (`SpscRing.ts:953` / `:1078`): they decode the same bytes via cached readers, so a known-pushed frame round-tripped through `Bridge.pull` is the ground truth the emitted reader must match element-for-element.
6. **Trajectory transparency**: `f{32,64}TrajectoryArray(n,{order})` is byte-identical to `f{32,64}Array(n*order)`, and `CompiledField.length` already equals `sampleCount*order`, so the reader treats a trajectory field as a flat array of `length` elements — no special trajectory branch needed in the hot path (the tag is emitted only as a comment).

## Design — `src/emitWorkletReader.ts`

### Input type — accept `SchemaLayoutDescription` (recommended)

| Option | Pro | Con |
|---|---|---|
| **(a) `SchemaLayoutDescription`** *(recommended)* | The postMessage-safe, dependency-free object that already crosses to the worklet. No `Schema` object required at emit time. Matches "the worklet's view of the layout." | `isArray` must be inferred from `length !== undefined`; `typesPresent` is absent (irrelevant — DataView reads per field). |
| (b) `Schema<S>` | Has `CompiledLayout.fields` directly with explicit `isArray`. | Drags the full `Schema` object; redundant since codegen would just call `describeSchemaLayout()` first anyway. |

**Resolution**: accept **either** via a union, normalizing internally. If the input has a `compiled` field it is a `Schema` → call `describeSchemaLayout(input)`; otherwise treat it as a `SchemaLayoutDescription`. Array-ness is decided by `length !== undefined`. This keeps the public ergonomic (pass a `Schema` in tests/Node, pass a `desc` in the worklet) while the canonical internal form is the description.

### Proposed signatures

```ts
// src/emitWorkletReader.ts

import {
  type SchemaLayoutDescription,
  type SchemaLayoutFieldDescription,
  type FieldKind,
  type Schema,
  type FieldsObject,
  type TimestampsConfig,
  describeSchemaLayout,
  kindByteSize,
} from "./schema.js";

/** Options controlling the emitted reader's shape. All optional. */
export interface EmitWorkletReaderOptions {
  /** Name of the emitted function (must be a valid JS identifier).
   *  Default: "readFrame". */
  readonly functionName?: string;
  /** Emit a full `function <name>(view, slot, out) { ... }` declaration
   *  (default), or just the function BODY suitable for `new Function(
   *  "view","slot","out", body)`. The test uses `bodyOnly` so it can
   *  `new Function(...)` the result without a wrapper parse step. */
  readonly bodyOnly?: boolean;
  /** Also emit a read of the hidden `__invariant: f64` lane into
   *  `out.__invariant`. Default false — FrameFor<S> excludes __invariant
   *  by contract, so codegen omits it unless explicitly requested. No-op
   *  when the layout has invariantByteOffset === null. */
  readonly includeInvariant?: boolean;
  /** Identifier names for the emitted params. Defaults: "view","slot","out". */
  readonly viewParam?: string;
  readonly slotParam?: string;
  readonly outParam?: string;
}

/** Emit, as a SOURCE STRING, a monomorphized zero-import DataView reader for
 *  EXACTLY this schema layout. Fixed byte offsets are baked in as numeric
 *  literals; no runtime offset math, no library import, no closure dispatch.
 *
 *  The emitted reader has the shape:
 *
 *      function readFrame(view, slot, out) {
 *        const b = 32 + slot * <frameByteSize>;            // slotBase
 *        out.seq  = view.getBigUint64(b + 0, true);        // u64 scalar
 *        out.vMax = view.getFloat64(b + 16, true);         // f64 scalar
 *        { const a = out.vEff;                              // f64 array, len 64
 *          for (let i = 0; i < 64; i++) a[i] = view.getFloat64(b + 24 + i*8, true); }
 *        return;
 *      }
 *
 *  Endianness is pinned little-endian (true) to match the host-endian umbrella
 *  typed-array views SpscRing constructs. Scalars are read with a single
 *  accessor; arrays loop with the element stride folded to a literal. Array
 *  fields write IN PLACE into a pre-existing `out[name]` typed array (the
 *  caller owns allocation — matching Bridge.pull's `dst.set(...)` contract),
 *  so the hot path is allocation-free. */
export function emitWorkletReader(
  layout: SchemaLayoutDescription | Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>,
  opts?: EmitWorkletReaderOptions,
): string;
```

### Per-kind DataView accessor table (baked at emit time)

No such map exists in the repo; codegen owns it. `kindTsType` only distinguishes bigint vs number — not the specific accessor — so codegen builds its own `FieldKind → method` table:

| `FieldKind` | DataView getter | `elemSize` (literal) | TS value |
|---|---|---|---|
| `f64` | `getFloat64` | 8 | number |
| `f32` | `getFloat32` | 4 | number |
| `u64` | `getBigUint64` | 8 | bigint |
| `i64` | `getBigInt64` | 8 | bigint |
| `u32` | `getUint32` | 4 | number |
| `i32` | `getInt32` | 4 | number |
| `u16` | `getUint16` | 2 | number |
| `i16` | `getInt16` | 2 | number |
| `u8` | `getUint8` | 1 | number |
| `i8` | `getInt8` | 1 | number |

The `u8`/`i8` getters take **no** endianness argument; codegen must emit `view.getUint8(off)` (one-byte, no LE flag) while all multi-byte getters take the `, true` LE flag. This is a per-kind emit branch, not a runtime one.

### Determinism / correctness math (why bit-exact)

The emitted reader reads byte address

```
addr(field, slot, i) = 32 + slot * frameByteSize + field.byteOffset + i * elemSize(field.kind)
```

`Bridge.pull`/`pullLatest` read the *same* address: the umbrella views are constructed at `RING_HEADER_BYTES` with element stride `frameByteSize/elemSize`, and field `f`'s view indexes `slot*(frameByteSize/elemSize) + byteOffset/elemSize + i` — algebraically identical after multiplying by `elemSize` and adding the `RING_HEADER_BYTES` base. Both interpret the bytes with the same width and signedness (the accessor table mirrors the typed-array element type), and both are little-endian on this host. Therefore for every field kind and every array index, `emitted(view, slot, out)[name][i] === library_pull(out)[name][i]` bit-for-bit — for floats this is *bit-identical IEEE-754*, for ints exact, for bigints exact 64-bit. There is no rounding, interpolation, or smoothing on this path; it is a pure byte decode, so determinism is total (no epsilon needed in the pin — exact `===` / `Object.is` for `-0`/`NaN` care, and `BigInt ===` for 64-bit lanes).

The one subtlety the pin must respect: `Bridge.pull` advances `read_index` (consuming the slot) whereas the emitted reader is a *pure peek* at a slot index. The test therefore reads the **same physical slot** the library is about to read — it computes the slot the library's `pull` will consume (`read_index & mask` before the pull), runs the emitted reader against that slot, then runs `pull` and compares — or, more simply, pushes one frame, peeks slot 0 with the emitted reader, and `pull`s into a second frame and compares the two decoded objects. The second form is cleaner and is what the pins use.

### Emitted-output shape (commented, readable)

Codegen emits a leading comment banner (schema fingerprint: `frameByteSize`, field count, generator version-neutral tag), then one commented line/block per field in **declaration order of the description's `fields` record** (insertion-ordered, matching `compileLayout`'s emit order). Scalars are one line; arrays are a braced block with a folded-stride loop. Example for `{seq:u64, tNs:u64, vMax:f64, vEff:f64Array(64)}`:

```js
// emitWorkletReader — generated zero-import frame reader
// schema: frameByteSize=536, fields=4, headerBytes=32, LE
// DO NOT EDIT — regenerate from the schema via emitWorkletReader(desc).
const b = 32 + slot * 536; // slotBase = RING_HEADER_BYTES + slot*frameByteSize
out.seq = view.getBigUint64(b + 0, true);   // u64 scalar @0
out.tNs = view.getBigUint64(b + 8, true);   // u64 scalar @8
out.vMax = view.getFloat64(b + 16, true);   // f64 scalar @16
// vEff: f64[64] @24 stride 8 (trajectory order=? if tagged)
{ const a = out.vEff; for (let i = 0; i < 64; i++) a[i] = view.getFloat64(b + 24 + i * 8, true); }
```

### File plan

- **`src/emitWorkletReader.ts`** (~180–230 LOC incl. header + comment density matching `schema.ts`):
  - File header block (purpose, zero-import contract, LE assumption, the address formula, the "regenerate on schema change" caveat).
  - `const DATAVIEW_GETTER: Record<FieldKind, string>` accessor table.
  - `normalizeLayout(input): SchemaLayoutDescription` — Schema-vs-desc discriminator (`"compiled" in input` → `describeSchemaLayout`).
  - `emitScalarRead(name, kind, byteOffset, view, out): string` and `emitArrayRead(name, kind, byteOffset, length, view, out): string` helpers (string builders; bake `elemSize` from `kindByteSize` at emit time; branch the LE flag off `elemSize === 1`).
  - `emitWorkletReader(...)` orchestration: banner → `const b = 32 + slot*<frameByteSize>;` → per-field lines (skip the hidden `__invariant` unless `includeInvariant`) → optional invariant read → wrap in `function <name>(view, slot, out) { ... }` unless `bodyOnly`.
- **`tests/Bridge.codegen.test.ts`** (numbered pins, `tsx`-runnable, no framework):
  1. **emitted source parses** — `new Function(viewParam, slotParam, outParam, emitWorkletReader(schema, {bodyOnly:true}))` does not throw; the default `bodyOnly:false` form also parses via `new Function("return (" + src + ")")`.
  2. **bit-exact vs library pull** — allocate a `Bridge`, `push` a known frame (every FieldKind exercised: u64/i64/f64/f32/u32/i32/u16/i16/u8/i8 scalars + an f64 array + a trajectory array), build a `DataView` over the same SAB, run the emitted reader against the producer's slot, `pull` into a second frame, assert element-for-element equality (`Object.is` for numbers to catch `-0`/`NaN`, `===` for bigints).
  3. **import-free** — assert the emitted string contains no `import` and no `require` token (regex `\bimport\b` / `\brequire\b` both absent).
  4. **all FieldKinds covered** — assert the emitted source contains the expected `getX` accessor for each kind present, and that array fields emit a loop with the correct folded stride literal.
  5. **invariant opt-in** — a `.withInvariant(...)` schema emits no `__invariant` line by default, and emits `out.__invariant = view.getFloat64(...)` when `includeInvariant:true`.

The test file is wired into both `test` and `test:unit` npm scripts **before** `Bridge.concurrent.test.ts` (per the test-conventions ordering rule). The orchestrator handles the package.json wiring + export of `emitWorkletReader` from `src/index.ts`; this track only writes the net-new files.

## Alternatives considered

### (a) Generic runtime reader factory (no codegen)
Return a *closure* (`(view, slot, out) => void`) built from the layout at runtime instead of a string. **Rejected**: doesn't deliver zero-import (the factory itself is library code shipped to the worklet) and the JIT can't monomorphize offsets it reads from captured arrays as well as it folds literals. The whole point of the track is the *string*.

### (b) Emit umbrella-typed-array reads instead of DataView
Emit `new Float64Array(sab, 32, ...)` umbrella views like `SpscRing` uses. **Rejected for the general case**: mixed-kind schemas would need one umbrella view per kind plus per-field index math, and 8-byte-misaligned access for sub-views is fragile across kinds. DataView with absolute byte offsets is uniform across all ten kinds, handles bigint lanes natively (`getBigUint64`), and needs no alignment reasoning in the emitted code. (A future `opts.strategy:"typedarray"` could add the umbrella variant for all-f64 schemas where it's a measurable win — deferred, not in MVP.)

### (c) Emit a class with cached `DataView`
Emit a stateful reader holding its own `DataView`. **Rejected for MVP**: the caller already has the SAB and can make one `DataView` at construction; passing it in keeps the emitted unit a pure function (easiest to `new Function` and test) and avoids prescribing object lifecycle. Can be layered later.

## Scope & ship decision

**Ship MVP**: `emitWorkletReader(layout, opts?) -> string` returning a DataView reader covering all ten `FieldKind`s + scalar/array/trajectory fields, LE-pinned, allocation-free hot path (caller owns `out` and its typed arrays), import-free output, with the five-pin test suite. ~200 LOC module + ~150 LOC test.

**Versioning**: **patch bump**. No wire-format change (reads existing layout), no breaking public-API change — a net-new additive function. Per `CLAUDE.md`'s slowdown policy this is squarely patch-level; the orchestrator picks the slot.

**Deferred (explicit non-goals for MVP)**:
- A *writer* codegen (`emitWorkletWriter`) — symmetric but the producer side rarely needs zero-import.
- `opts.strategy:"typedarray"` umbrella-view variant.
- Emitting a `pullLatest`-equivalent that does the `read_index` advance (codegen stays a pure peek; advancing the index is the SAB protocol's job and not worklet-codegen's concern).
- Big-endian support (the SAB is host-endian; every target is LE — documented assumption, not a runtime branch).

## Risks

1. **Endianness assumption.** Emitting `, true` (LE) is correct on every realistic target but is an *assumption*, not a runtime check. Documented in the file header and the emitted banner. A big-endian host would silently mis-decode multi-byte lanes — acceptable given the SAB is already host-endian throughout the library.
2. **Schema drift.** The emitted reader is welded to one `frameByteSize` + offset set. If the producer's schema changes, a stale reader mis-decodes. Mitigation: the banner records `frameByteSize` + field count; callers can fingerprint. Not enforced at runtime (zero-import means no validation code) — this is the inherent cost of monomorphization and is called out in the docs.
3. **`new Function` and CSP.** `new Function(...)` is blocked under strict `Content-Security-Policy` (`script-src` without `unsafe-eval`). The emitted *string* is still useful (paste into a built worklet); the `new Function` path is a convenience the test uses and that CSP-free environments can use. Documented as a caveat, not a blocker.
4. **`out` ownership.** The hot path is allocation-free *only if* the caller pre-allocates `out` and its typed arrays (mirroring `Bridge.pull`'s `dst.set` contract). If a caller passes a fresh `{}` with no typed arrays, the array writes throw. Documented in the function JSDoc; the test always passes a `scratchFrame()`-shaped `out`.
