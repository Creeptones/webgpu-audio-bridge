# Changelog

All notable changes to this project will be documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning policy (post-0.6.0)**: future improvements default to **patch bumps** (`0.6.x`) rather than minor bumps. Many additional improvements are planned before 1.0; we want the version number to reflect actual maturity, not feature count. Minor bumps (`0.7.0` etc.) are reserved for wire-format changes, breaking public-API changes, or batched-patch promotion. The 0.7.x cohort (and every subsequent minor) is expected to go deep — `0.7.0 → 0.7.99` is the planned patch envelope before `0.8.0` is considered. See [`CLAUDE.md`](./CLAUDE.md) for the full policy.

## [0.9.63] — 2026-05-29

### Added — `BridgeGPUSource` `"raw"` decoder mode

`BridgeGPUSource`'s `decoder` constructor argument now accepts the sentinel
string `"raw"` in addition to a `GpuReadbackDecoder<S>` closure. In raw mode the
helper skips the `beginPush` → decoder → `commitPush` dance and instead memcpys
each completed readback straight into the ring via `bridge.pushRaw(mappedRange)`
(0.9.62). Pairs with an `emitWgslStruct(schema)`-generated producer struct so the
GPU bytes already match the SAB frame layout — the ergonomic endpoint of the
WGSL↔TS bridge: **define the schema once → generate the shader struct →
`"raw"` wires the GPU→SAB readback with zero decode boilerplate.**

- The token is `"raw"`, deliberately NOT `"auto"` — `"auto"` is already the
  `writeTarget` transport selector (map-async vs a future shared-memory path)
  and the two must not collide. The new `decoderMode()` accessor reports
  `'raw'` vs `'closure'` for telemetry.
- **Construction validation:** raw mode requires `stagingBufferSize ===
  schema.frameByteSize` (the default), since the whole mapped range is treated
  as one frame. A mismatch throws before any `device.createBuffer` side effects.
- Slot recycling, `droppedCount()` on a full bridge (pushRaw returns false),
  `onError`, the device-lost classification, and the literal-`finally`
  `releaseMap` recycle path all behave exactly as in closure mode — the raw
  branch reuses the shared post-dispatch release block. Since `pushRaw` publishes
  atomically there is no half-written frame to `abortPush` on a `readMapped`
  throw; the error path just ticks the drop counter and recycles the slot.

### Why

With `emitWgslStruct` guaranteeing byte-isomorphism and `pushRaw` providing the
zero-decode copy, the remaining boilerplate was the hand-written
`GpuReadbackDecoder` closure — pure ceremony when the bytes already match.
`"raw"` removes it, completing the "schema is the single source of truth"
pipeline for GPU macro-control frames. Third pillar of the WGSL↔TS bridge track.

### Wire compatibility

Zero. Purely additive: the `decoder` parameter type widened from
`GpuReadbackDecoder<S>` to `GpuReadbackDecoder<S> | "raw"` (existing closure
callers compile and behave identically — verified by a regression pin). No
schema, SAB byte, or protocol change; a raw-mode producer writes the exact same
slot bytes a closure-mode producer would.

### Tests

New `tests/BridgeGPUSource.raw.test.ts` (5 pins, wired into `npm test` /
`test:unit` next to the existing `BridgeGPUSource.writeTarget` suite): raw
dispatch lands a frame via `pushRaw` with no closure (payload round-trips,
`decoderMode()==='raw'`); full bridge → `droppedCount++` + slot recycled;
throwing `releaseMap` after a successful `pushRaw` keeps the frame and recycles
the slot via `finally`; `stagingBufferSize !== frameByteSize` throws with no
buffers leaked; closure mode unaffected (regression). Mandatory gates green:
`npm run typecheck`, `npm test` (33 suites), `npm run bench` (~1.20 µs `push`,
unchanged).

### Documentation

This entry; a "Skip the decoder entirely — `"raw"` mode" subsection in the
README `BridgeGPUSource` section; method JSDoc on the widened constructor +
`decoderMode()`; an inline rationale block at the `pollCompleted` raw branch.

## [0.9.62] — 2026-05-29

### Added — `pushRaw(src, srcOffset?)`: zero-decode raw-byte push

A new producer method on `Bridge<S>` (and the `BridgeProducer` / `BridgeInputLane`
facades, all forwarding to the `SpscRing` core) that copies exactly one frame of
bytes (`frameByteSize`) from `src` straight into the next free slot via a
**single native `Uint8Array.set` memcpy** — no per-field encode loop — then
publishes with the *same* release-store + `Atomics.notify` protocol as `push`.
The consumer cannot distinguish a `pushRaw` frame from a `push` frame: identical
slot bytes, identical invariant lane, identical happens-before ordering.

`src` may be an `ArrayBuffer` or any `ArrayBufferView` (typed array / `DataView`);
`srcOffset` (default 0) selects where the frame begins. A source with fewer than
`frameByteSize` bytes at the offset throws `RangeError`.

Internals:

- **Shared backpressure dispatch.** The cold-path overflow logic in `push` is
  extracted into a private `_applyOverflowPolicy(writeIdx, readIdx)` helper that
  `push` and `pushRaw` both call, so the two producers cannot drift on
  reject / drop-newest / drop-oldest / block semantics. It runs only on overflow
  (zero hot-path cost) and is allocation-free (decision returned as a small code,
  advanced readIdx via an instance scratch field). `beginPush` keeps its distinct
  drop-newest-returns-null semantics and is intentionally left unchanged.
- **Cached destination view.** A whole-SAB `Uint8Array` is cached once at
  construction so the memcpy never re-allocates a destination view.
- **Invariant guard.** No-invariant schemas take a pure memcpy + publish. For
  `.withInvariant(fn)` schemas, `pushRaw` decodes the just-copied slot into a
  cached scratch frame (`buildScratchFrame`, the same shape as
  `Bridge.scratchFrame()`) solely to recompute the JS invariant and stamp the
  hidden f64 lane *before* the release-store — so the source bytes' invariant
  lane (which a GPU producer never writes) is ignored and the consumer-side
  classifier still works. The no-invariant fast path pays none of this.

### Why

`emitWgslStruct` (0.9.61) guarantees the GPU storage buffer is byte-for-byte
identical to the SAB frame, which makes per-field readback decoding pointless
CPU work. `pushRaw` collapses GPU→SAB readback to one memcpy. Honest naming:
**zero-decode** (one memcpy, no per-field JS dispatch loop), *not* "zero-copy"
(bytes still move; true zero-copy awaits a shared-memory WebGPU mapping
primitive) and *not* "O(1)" (it is O(`frameByteSize`) in the copy, O(1) in field
dispatch). Second pillar of the WGSL↔TS bridge track; the `BridgeGPUSource`
`"raw"` decoder mode (0.9.63) will call `pushRaw` automatically on each
completed readback.

### Wire compatibility

Zero. `pushRaw` writes the exact same slot bytes + invariant lane as `push` and
uses the identical release-store/notify protocol — a `pushRaw` producer and any
existing consumer interoperate over the same SAB transparently. No schema, SAB
byte, or frame-size change. The `_applyOverflowPolicy` extraction is a pure
refactor: `push`'s observable behavior is unchanged (bench `push` median
1.20 µs, unchanged; the 1 M-frame + 250 K drop-oldest concurrent stresses pass).

### Tests

New `tests/Bridge.pushRaw.test.ts` (6 pins, wired into `npm test` / `test:unit`):
slot bytes byte-identical to `push` + decode round-trip; `ArrayBuffer` /
typed-array / `DataView` inputs and non-zero `srcOffset`; short-source
`RangeError`; reject / drop-newest / drop-oldest parity with `push` (return
values, dropped counts, surviving frames); `block` + 0 ms timeout → false;
invariant lane recomputed from payload (corrupted source lane ignored) and equal
to `push`'s stored lane. Mandatory gates green: `npm run typecheck`, `npm test`
(32 suites), `npm run bench` (~1.20 µs `push`, unchanged).

### Documentation

This entry; a "Zero-decode GPU readback — `pushRaw`" README subsection; method
JSDoc on `Bridge.pushRaw` and the facades; a self-contained `pushRaw` /
`_applyOverflowPolicy` / `_decodeSlotInto` doc block in `src/SpscRing.ts`.

## [0.9.61] — 2026-05-29

### Added — `emitWgslStruct(schema, opts?)`: schema-derived WGSL struct codegen

A new string-emitting codegen sibling to `emitWorkletReader`. Given a `Schema`
(or a postMessage'd `SchemaLayoutDescription`) it emits a WGSL `struct` whose
memory layout is **byte-isomorphic to the SAB frame** the `Bridge` reads/writes
for that schema, making the TS `Schema` the single source of truth for the
GPU-side struct as well as the CPU-side one.

New public surface (exported from `src/index.ts`):

- `emitWgslStruct(input, opts?) → string` — the WGSL `struct` (+ optional
  trajectory helpers) as a source string.
- `computeWgslLayout(input, opts?) → WgslLayout` — the testable spine: re-derives
  member offsets/sizes from WGSL alignment rules so the isomorphism is provable
  arithmetically (no `naga`/`tint` in the test path).
- `WgslUnsupportedKindError` — thrown for sub-32-bit kinds.
- Types: `EmitWgslStructOptions`, `EmitWgslStructInput`, `WgslMember`,
  `WgslLayout`.

Design decisions baked in:

- **Sub-32-bit kinds fail-fast.** WGSL storage buffers have no native
  `u8/i8/u16/i16` (absent the unassumable `16bit` extension), so the emitter
  throws `WgslUnsupportedKindError` rather than emit invalid shader code.
- **64-bit kinds byte-transport as `vec2<u32>`.** WGSL has no concrete 64-bit
  scalar; `f64/u64/i64` map to `vec2<u32>` (align/size 8) — lossless byte
  transport, not native 64-bit GPU arithmetic.
- **Trailing padding is forced.** An all-32-bit schema would round its WGSL
  struct size to 4, but the schema pads frames to 8. A trailing
  `_wab_pad: array<u32, k>` member stretches the struct to the schema's exact
  `frameByteSize`, keeping `array<Struct>` element stride equal to the SAB slot
  stride. The same pad covers the hidden invariant lane unless `includeInvariant`
  exposes it as a named `vec2<u32>` member.
- **Trajectory helpers.** `f32` trajectory fields get an inline
  `fn <Struct>_set_<field>(state, idx, p, v[, a])` tuple writer matching the
  interleaved `[p, v, [a]]` storage order (opt-out via `includeHelpers: false`).

### Why

Eliminates the **alignment trap**: today a developer hand-writes a WGSL struct
to match their TS schema, and WGSL's strict, silent padding/stride rules mean a
one-byte drift makes the AudioWorklet decode mathematically-plausible garbage
without ever crashing — days lost debugging DSP when the bug is memory layout.
Because `compileLayout` already packs fields by descending alignment class
(8→4→2→1) with every offset a multiple of its element size, that packing is
isomorphic to WGSL's host-shareable struct layout once sub-32-bit kinds are
excluded — so a generated struct is correct *by construction*. This is the first
pillar of the WGSL↔TS bridge track; it pairs with the zero-decode `pushRaw`
readback path (0.9.62) and the `BridgeGPUSource` `"raw"` decoder mode (0.9.63).

### Wire compatibility

Zero. Purely additive build-time codegen — no `src/` runtime logic on any hot
path, no schema/SAB byte change, no public-API break. Bit-for-bit identical
runtime to 0.9.60.

### Tests

New `tests/Bridge.wgsl.test.ts` (8 pins, wired into `npm test` / `test:unit`):
sub-32-bit rejection; member offsets equal compiled `byteOffset`s; `structSize`
equals `frameByteSize` across five schema shapes; all-`f32` trailing-pad; 64-bit
→ `vec2<u32>`; trajectory flat-array + interleaved helper; invariant fold-vs-
expose; DO-NOT-EDIT banner + `frameByteSize` fingerprint. Mandatory gates green:
`npm run typecheck`, `npm test` (31 suites), `npm run bench` (~1.20 µs baseline,
unchanged — codegen doesn't touch the hot path).

### Documentation

This entry; a new `emitWgslStruct` bullet in the README codegen section; a
self-contained file header in `src/emitWgslStruct.ts` documenting the
isomorphism argument, the type-support gate, the 64-bit byte-transport choice,
and the trailing-pad rule.

## [0.9.60] — 2026-05-29

### Changed — fix stale `subarray` description in `BridgeBlockConsumer.process()` doc

`process()`'s JSDoc still described its hot path as "a single
`Float32Array.prototype.set` from an internal subarray view into the caller's
buffer" — the pre-0.9.55 behavior. 0.9.55 replaced that with an allocation-free
indexed loop, so the doc contradicted the code. Updated to describe the
allocation-free cached-locals loop and cross-reference the additive
`processAdd` / `_mixWindow` paths.

Comment-only; the two other `subarray` mentions in the file are the 0.9.55
inline comments that correctly describe what was *replaced*, so they're accurate
and left as-is.

### Why

Clears the audit's last item: "there is at least one stale comment in
`BridgeBlockConsumer.process()` saying subarray even though the code no longer
does that." Stale hot-path docs on a render-loop method mislead readers about
the allocation profile.

### Wire compatibility

Zero. Doc-comment only — no `src/` logic, schema, SAB byte, or public-API change.
Bit-for-bit identical runtime to 0.9.59.

### Tests

No new pins (comment-only); the 0.9.55 byte-equivalence pin
(`tests/BridgeBlockConsumer.test.ts#34`) already pins the behavior the doc now
describes. Mandatory gates re-run green: `npm run typecheck`, `npm test`
(30 suites), `npm run bench` (~1.20 µs baseline).

### Documentation

This entry; the corrected `process()` doc-comment.

## [0.9.59] — 2026-05-29

### Changed — inline the remaining internal machinery + facades in `LLM_BUNDLE.md`

0.9.56 inlined the `SpscRing` core but left six files header-only:
`FrameSmoother`, `ConsumerClockRecovery`, `AdaptiveFlowController`,
`BridgeConsumer`, `BridgeProducer`, `BridgeWebNNSource`. An auditor reading the
bundle could see their header math but not the smoother blend, the PLL PI loop,
the flow-controller integrator, or the facade delegation.

All six are now inlined in **full**. With the `SpscRing` core that puts the
**entire runtime source surface** in the bundle — no `src/` file is summarized
header-only anymore (verified: zero "no leading JSDoc header" placeholders, all
six class bodies present). Bundle grows to ~23,150 lines / ~1.23 MB.

### Why

Clears the audit's remaining bundle caveat: "some deep machinery is still
header-only — FrameSmoother, ConsumerClockRecovery, AdaptiveFlowController,
BridgeConsumer, BridgeProducer, and BridgeWebNNSource remain summarized rather
than fully inlined." A self-contained audit artifact should contain the code it
asks the reader to trust.

### Wire compatibility

Zero. Tooling/documentation only — no `src/` runtime change, no schema or SAB
byte change. `LLM_BUNDLE.md` is a `.gitignore`d build artifact; the committed
change is the generator script + this entry.

### Tests

No new pins (generator/doc change). Mandatory gates re-run green:
`npm run typecheck`, `npm test` (30 suites), `npm run bench` (~1.20 µs baseline).
Bundle regenerated and verified: all six class bodies present, zero header-only
placeholders remaining.

### Documentation

This entry; `scripts/regenerate-llm-bundle.mjs` inclusion list + rationale comment
+ the bundle's "What this bundle contains" section (item 6 now "inlined in full").

## [0.9.58] — 2026-05-29

### Fixed — `releaseMap()` slot reset moved into a literal `finally`

0.9.54 contained decoder faults in `BridgeGPUSource.pollCompleted()`, but the
`releaseMap()` (`buffer.unmap()`) + slot-state reset still ran as plain
statements *after* the decode try/catch — not inside a `finally`. So a throwing
`unmap()` (an already-unmapped/destroyed buffer, or a device lost between map and
unmap) would escape before the slot reset and strand the slot in `in-flight`
again — the same leak class 0.9.54 closed for the decoder, left open for the
release step.

The unmap + slot reset now run in a literal `try { releaseMap } finally { reset }`,
so the slot **always** recycles to idle regardless of whether `unmap()` throws.
The unmap error is surfaced through the same `onError(err, kind)` channel
(classified `'transient'` unless `device.lost` has resolved). Because `unmap()`
runs *after* `commitPush()`, the already-published frame is kept — the push is
**not** rolled back; this is a release-time failure, not a dropped frame.

### Why

Closes the last sharp edge the audit flagged on the decode/push/unmap path:
"releaseMap() + slot reset are after the decode try/catch, not inside a literal
finally; a throwing releaseMap() would still escape before slot reset." Real-time
helpers must guarantee slot recycle on *every* exit path, including a throwing
release.

### Wire compatibility

Zero. No schema, SAB-byte, or public-API change — internal control flow in
`pollCompleted()`. A non-throwing `unmap()` behaves bit-for-bit as in 0.9.57.

### Tests

New `tests/BridgeGPUSource.writeTarget.test.ts` pin **12**
(`testReleaseMapThrowRecovers`): a mock whose `unmap()` throws after a successful
decode + commit. Asserts the committed frame is readable (push not rolled back),
the slot recycles to idle (the `finally` ran), `onError('transient')` fires, and
the recycled slot accepts the next readback once `unmap()` recovers. Mandatory
gates re-run green: `npm run typecheck`, `npm test` (30 suites), `npm run bench`
(~1.20 µs baseline).

### Documentation

This entry; README §BridgeGPUSource "Decoder-fault containment" subsection
extended with the release-step hardening.

## [0.9.57] — 2026-05-29

### Changed — reconcile stale "reserved" lane comments with the shipped PLL lanes

Since 0.6.16 the consumer's Bridge publishes PLL state (offset / drift / status)
to SAB header lanes 4–7 on every `observeConsumerTime` / `resetPll`, readable
cross-process via `readPublishedPllState()`. Several header/inline comments still
described lanes 4–7 as "reserved" and cross-process PLL observability as "a
follow-up" — language that predated 0.6.16 and now contradicts the live code.

Comment-only reconciliation, no behavior change:

- **`src/SpscRing.ts`** — file-header "what lives here" bullet, the byte-layout
  lane table, and the `[byte 16..31]` description now state lanes 4–7 carry
  published PLL state (offset Int64 ns / drift Q16.16 ppm / status word), point
  at the canonical lane-index constants as the single source of truth, and note
  the pre-0.6.16 all-zero default reads as "no published state."
- **`src/Bridge.ts`** — the `telemetry()` PLL-fields comment no longer claims
  lanes 4–5 "are still reserved"; it now documents the heap-side read path and
  the separate 0.6.16 cross-process publish path. The heap-only-counters comment
  drops the stale "reserved SAB lanes" phrasing.
- **`src/ConsumerClockRecovery.ts`** — clarifies that *this class* is heap-only
  while *Bridge* publishes its state to lanes 4–7 (0.6.16), instead of calling
  the lanes reserved.

The genuinely-reserved bits (lane 7 status word "bits 1-31 reserved") are
correct and left intact.

### Why

Addresses the audit's documentation finding: "the code path now publishes PLL
state to SAB lanes but some comments still describe them as reserved." Stale
protocol comments on a correctness-critical file mislead auditors and future
maintainers about the wire's actual shape.

### Wire compatibility

Zero. Comments only — no `src/` logic, schema, SAB byte, or public-API change.
Bit-for-bit identical runtime to 0.9.56.

### Tests

No new pins (comment-only). Mandatory gates re-run green: `npm run typecheck`,
`npm test` (30 suites), `npm run bench` (~1.20 µs baseline).

### Documentation

This entry; the reconciled comments in `src/SpscRing.ts`, `src/Bridge.ts`, and
`src/ConsumerClockRecovery.ts`.

## [0.9.56] — 2026-05-29

### Changed — inline the full `SpscRing` core in `LLM_BUNDLE.md`

The bundle generator (`scripts/regenerate-llm-bundle.mjs`) shipped
`src/SpscRing.ts` as **header-only** — but `SpscRing` is the correctness-critical
core (SAB/Atomics counter arithmetic, the park/wake wait protocol, overflow
policies, notify behavior). An auditor reading the bundle alone could verify the
header math but not the actual implementation that backs it.

`SpscRing.ts` is now inlined in **full** (promoted out of the header-only group),
sitting alongside `formal/SpscRing.tla` so the modeled invariants and the real
code are both present in one read. The remaining extracted heap-state machines
(`FrameSmoother`, `ConsumerClockRecovery`, `AdaptiveFlowController`,
`BridgeConsumer`, `BridgeProducer`, `BridgeWebNNSource`) stay header-only. This
patch also folds in the in-flight generator updates (frontier design notes +
formal artifacts now inlined, headline list and suite count refreshed to 30).

### Why

Addresses the audit's recurring caveat across categories 1 and 6 — that the core
SPSC implementation was not inlined in the bundle, so the counter arithmetic,
wait protocol, overflow policies, and notify behavior could not be verified from
the artifact alone.

### Wire compatibility

Zero. Tooling/documentation only — no `src/` runtime change, no schema or SAB
byte change. `LLM_BUNDLE.md` is a `.gitignore`d build artifact; the committed
change is the generator script + this entry.

### Tests

No new pins (generator/doc change). Mandatory gates re-run green:
`npm run typecheck`, `npm test` (30 suites), `npm run bench` (~1.20 µs baseline).
Bundle regenerated and verified to contain deep `SpscRing` symbols
(`_pullOverrunAware`, `publishPllState`, `drainNoNotify`) in the body, not just
the header (`npm run llm-bundle` → 21,747 lines / ~1.17 MB).

### Documentation

This entry; `scripts/regenerate-llm-bundle.mjs` inclusion list + rationale comment
+ the bundle's "What this bundle contains" section.

## [0.9.55] — 2026-05-29

### Changed — allocation-free copy in `BridgeBlockConsumer.process()`

`process()`'s per-chunk copy was `out.set(this.samples.subarray(cursor, cursor +
take), written)`. `subarray()` mints a fresh typed-array **view object** per
chunk inside the AudioWorklet render loop (≈8 per quantum for a 1024-block /
128-quantum split) — GC pressure on the audio thread, which the additive paths
(`processAdd` / `_mixWindow`) already avoid with explicit indexed loops.

`process()` now uses the same allocation-free pattern: cache `samples` / `cursor`
/ `written` into locals and copy with a plain `for` loop. The `holdSample`
bookkeeping reads off the cached locals. Output is **byte-for-byte identical** to
the prior copy.

### Why

Addresses the audit's real-time hot-path finding (category 2): `process()` was
the lone render-loop path still creating a per-chunk view, out of step with the
additive paths. Removing it makes the whole `BridgeBlockConsumer` render surface
allocation-free in steady state.

### Wire compatibility

Zero. No schema, SAB-byte, or public-API change — pure internal copy mechanics.
Bit-for-bit identical output to 0.9.54.

### Tests

New `tests/BridgeBlockConsumer.test.ts` pin **34** (`testProcessCopyEquivalence`):
asserts the explicit-loop copy is byte-identical to a faithful reference across
an irregular straddling chunk schedule (exact-multiple, non-divisor, 1-sample,
and a >blockSize multi-frame straddle), and that `holdSample` read off the same
copy still tracks the final value (verified via a hold-last underflow). Mandatory
gates re-run green: `npm run typecheck`, `npm test` (30 suites), `npm run bench`
(push/pull/pullLatest ~1.20 µs; `process (replace)` cell neutral within the
100 ns measurement granularity).

### Documentation

This entry; README §Audio-rate mode note that `process()` is allocation-free on
the render path.

## [0.9.54] — 2026-05-29

### Fixed — decoder-fault containment in `BridgeGPUSource.pollCompleted()`

The user-supplied `decoder(range, frame)` runs inside `pollCompleted()` and can
throw (malformed range, a decode bug, OOM in a heavy decoder). Before this patch
a decoder throw escaped the readback loop **after** `beginPush()` had opened a
ring slot, so `commitPush()` and the staging-buffer `releaseMap()` + slot reset
were all skipped. The slot leaked into a permanent `in-flight` "zombie" (its GPU
buffer still mapped, never re-acquired) — and slot by slot the whole readback
pipeline starved.

`pollCompleted()` now wraps the `readMapped → decoder → commitPush` region in
try/catch. On a throw it calls `abortPush()` (so the ring's `write_index` does
**not** advance on the half-written frame — no torn frame is ever published),
ticks `droppedCount()`, and surfaces the error through the same
`onError(err, kind)` channel used for `mapAsync` rejection (classified
`'transient'` unless `device.lost` has resolved). The unconditional
`releaseMap()` + slot reset that already followed the push now serve as the
finally for every outcome — success, decoder throw, or bridge-full skip — so the
staging slot is always unmapped and recycled. One bad decode costs one dropped
frame, not the pipeline.

### Why

Addresses the audit's most serious fault-tolerance finding (category 5): the
decode-failure path could leave a staging slot in a bad state and skip
`releaseMap()`. Real-time helpers must survive user-decoder exceptions the same
way they survive device-lost rejections — drop one frame, recycle, keep running.

### Wire compatibility

Zero. No schema, SAB-byte, or public-API change — the fix is internal control
flow in `pollCompleted()`. A decoder that never throws behaves bit-for-bit as in
0.9.53; only the throwing path changed (from leak to contained drop).

### Tests

New `tests/BridgeGPUSource.writeTarget.test.ts` pin **11**
(`testDecoderThrowRecovers`): a resolving mock device drives a slot to the decode
path with a decoder that throws on the first frame and succeeds on the second.
Asserts the failed frame pushes nothing (`pushedCount` unchanged), aborts the
push (no frame readable from the bridge), unmaps the buffer, recycles the slot to
idle, ticks `droppedCount`, fires `onError('transient')` — and that the recycled
slot then accepts the next successful readback. Mandatory gates re-run green:
`npm run typecheck`, `npm test` (30 suites), `npm run bench` (~1.20 µs baseline).

### Documentation

This entry; README "Decoder-fault containment (0.9.54)" subsection under
§BridgeGPUSource, alongside the existing device-lost handling docs.

## [0.9.53] — 2026-05-29

### Added — full layout-fingerprint validation in `mount()`

`connect().mount()` previously validated only `frameByteSize` before
reconstructing a ring from a handle. That check is necessary but **not
sufficient**: two schemas can pad to the same frame size yet disagree on field
names, kinds, byte offsets, array lengths, trajectory specs, timestamp roles, or
invariant placement. A peer that imported a same-size-but-different-shape schema
would have silently **misdecoded** the SAB — the typed-array constructors still
succeed (alignment is valid) but the bytes mean something different.

`mountRing()` now runs a deep structural comparison after the `frameByteSize`
fast-check: it walks the full `SchemaLayoutDescription` already carried on the
handle and throws on the **first** divergence, naming the field and what
differs (e.g. `field "seq": kind u64 vs handle f64`). No new utility surface and
**no wire change** — the handle already ships `describeSchemaLayout()` JSON, so
the peer simply recomputes its own and compares.

### Why

Addresses the audit finding that the schema-layout validation was only partial
(category 3). Silent misdecode is the worst failure mode for a transport — it
produces plausible-but-wrong frames rather than a loud error. Failing at
`mount()` turns a latent data-corruption bug into an actionable version-skew
message at topology construction time.

### Wire compatibility

Zero. No `src/` schema change, no SAB byte change, no handle-shape change — the
comparison reuses the `layout` field already present on `ConnectRingHandle`. A
correctly-matched mount behaves bit-for-bit as in 0.9.52; only mismatched
mounts that previously slipped through now throw.

### Tests

New `tests/connect.test.ts` pin **109** (`testMountLayoutMismatchSameByteSize`):
builds an imposter schema with the **same** `frameByteSize` as the topology's
macro schema but swapped field kinds, asserts `mount()` throws and that the
message names the divergent field + kind. Mandatory gates re-run green:
`npm run typecheck`, `npm test` (30 suites), `npm run bench` (~1.20 µs baseline,
unmoved).

### Documentation

This entry; README `connect()` / `mount()` note on the full-layout guard.

## [0.9.52] — 2026-05-29

### Changed — public-facing metadata sync (docs / packaging only)

The repo-facing story had drifted behind the code: the README status block
still read `0.9.37` / "22 Node suites", `CITATION.cff` still read `0.9.43`, and
the `package.json` description/keywords still described only the original
control-rate ring rather than the three-lane architecture that shipped across
0.9.48–0.9.51 (stereo block consumer, sample-accurate input lane, additive GPU
residual, graceful degradation). This patch resyncs the metadata to match the
shipped surface.

- **`package.json`**: description reframed to the reference-bridge architecture;
  keywords expanded from 11 to 20 topics (adds `realtime-audio`,
  `low-latency-audio`, `browser-audio`, `gpu-compute`, `audio-dsp`,
  `audio-synthesis`, `audio-engine`, `typescript`, `web-worker`,
  `messagechannel`, `audio-rate`).
- **`README.md`**: hero blockquote reframed to "realtime CPU synthesis,
  latency-tolerant WebGPU compute, and lock-free lanes for macro state, input
  events, and additive residual blocks"; status corrected to **0.9.52** and
  **30 Node/TypeScript suites in `npm test`** (was 22) plus the cross-engine
  Playwright browser CI line.
- **`CITATION.cff`**: `version` `0.9.43` → `0.9.52`, `date-released` →
  `2026-05-29`.
- **GitHub repo description** updated to match (out-of-tree).

### Why

Packaging + citation metadata are the project's outward-facing front door for
npm search, Zenodo/DOI citation, and LLM auditors. Letting them lag the code
under-sells the current architecture and misreports the test count. No code,
schema, or wire change — this is a documentation/packaging patch.

### Wire compatibility

Zero. No `src/` change, no schema change, no SAB byte change. Bit-for-bit
identical runtime to 0.9.51.

### Tests

No new pins (metadata-only). Mandatory gates re-run green before the bump:
`npm run typecheck`, `npm test` (30 suites), `npm run bench` (push/pull/pullLatest
~1.20 µs baseline).

### Documentation

This entry; README status + hero; `CITATION.cff`; `package.json`
description/keywords. `LLM_BUNDLE.md` regenerated (build artifact, `.gitignore`d).

## [0.9.51] — 2026-05-29

### Added — underflow telemetry + graceful-degradation controller

Closes **Gap #12** ("Subscribe-to-underflow callback") and **Gap #8**
("Stall-aware quality degradation") from `docs/hybrid-residual-comparison.md`,
now unblocked by stereo (0.9.48) + the comparator bench (0.9.50). The headline:
**the residual thins before it glitches.** Under sustained GPU underflow the
producer voluntarily simplifies the residual (fewer partials) instead of letting
the ring run dry and the consumer zero-fill.

#### Consumer-side telemetry (`BridgeBlockConsumer<S>`)

Three new windowed, audio-domain getters on top of the existing
`underflowSamples()` / `framesConsumed()` counters — all **pure polling
getters**: no timer, no `Atomics.wait`, no audio-thread allocation
(worklet-safe by construction):

- `underflowRate(windowMs)` — fraction in `[0,1]` of per-channel window samples
  that took the underflow path over the last `windowMs`. Backed by a
  fixed-size, preallocated circular history of cumulative
  `(samplesEmitted, underflowSamples)` marks stamped from inside the
  `process*()` calls (the cadence is the audio quantum); the mark stride
  auto-scales to `underflowWindowMs` so the buffer always spans the window
  regardless of `process()` quantum. `windowMs` is clamped to
  `underflowWindowMs`.
- `lastSuccessfulPullTime()` — the audio-domain time (seconds) of the most
  recent successful ring pull. Monotonic; stalls across an underflow run.
- `elapsedSeconds()` — the consumer's audio-domain "now"; their difference is
  the stall age.

All three derive from an exact audio-sample clock (`samplesEmitted /
sampleRate`), **not** `performance.now()` — which is not reliably exposed in
`AudioWorkletGlobalScope`. New optional constructor opts: `sampleRate` (the
AudioWorklet global is in scope; falls back to `globalThis.sampleRate`, else the
three getters throw a descriptive error) and `underflowWindowMs` (default 1000).
`reset()` zeroes the new clock + history too.

#### Producer-side controller (`ResidualQualityController`)

A new standalone class (mirrors `AdaptiveFlowController`'s discipline) that maps
a back-pressure signal into a smoothed, hysteretic `suggestedQualityScale` the
GPU worker applies to its own knobs (partial count, workgroup count,
oversampling, …):

- `tick(signal) → { underflowRate, suggestedQualityScale }`. Higher signal =
  more pressure = degrade.
- **Option 1 (recommended first ship; zero new wire):** feed
  `bridge.flowScaleHint()` — a starved consumer drives `flow_scale` toward 2.0
  ("speed up"), which the producer honors by *simplifying* (cheaper blocks
  compute faster). Default watermarks (1.6 / 1.15) are tuned for this
  `[0.5, 2.0]` signal.
- **Option 2 (more faithful follow-up):** feed the consumer's true measured
  `underflowRate(windowMs)` over a dedicated back-channel SAB (construct with
  `[0,1]` watermarks).
- Hysteresis is mandatory, not polish: a watermark deadband + a bounded
  `rampPerTick` make quality glide between 1.0 and `minScale` over tens of ticks
  rather than pumping the timbre per block.

#### Why

Graceful degradation is the next win after the hybrid residual became stereo
and measurable: rather than the residual glitching/zero-filling under load, it
*thins* — fewer partials, audible as a duller but continuous timbre — and
recovers when the GPU catches up. This makes the hybrid pattern robust under
real GPU jitter, not just nominal conditions.

### Wire compatibility

**Zero.** No new SAB header lane (the ring's 8 Int32 lanes are unchanged). The
first ship derives the controller's signal from the **existing** `flow_scale`
lane (Option 1); Option 2's measured-rate back-channel, if a later session adds
it, is a *separate* SAB, not the Bridge header — also patch-safe. The new
consumer getters and the new controller class are purely additive API;
`TelemetrySnapshot` is untouched (new fields are discrete getters, deliberately
NOT mutated into the frozen 21-field snapshot). A `0.9.51` consumer is
bit-for-bit interoperable with a `0.9.50` peer.

### Tests

- `tests/BridgeBlockConsumer.test.ts` — 4 new pins (30–33): `underflowRate`
  (0 / recent-all / mixed-fraction / windowMs clamp / no-sampleRate throw),
  `lastSuccessfulPullTime`/`elapsedSeconds` (advance-on-pull, stall-across-
  underflow, stall age), `reset()` zeroes the new state, and an
  instrument-every-path guard across `process` / `processAdd` /
  `processAddStereo`.
- `tests/ResidualQualityController.test.ts` — new file, 9 pins: construction +
  validation, pressure normalization, sustained-high degrade to `minScale`,
  sustained-low recover to 1.0, the hysteresis bound (|Δ| ≤ `rampPerTick`
  across an adversarial alternating signal), floor/ceiling clamps, `reset()`,
  `tick(NaN)` throws, and Option-2 `[0,1]` watermarks.
- All prior suites green; `npm run bench` push/pull/pullLatest unchanged at the
  ~1.20 µs baseline (the `_noteEmitted` tail add is invisible).

### Documentation

- `bench/graceful-degradation.bench.ts` (+ `npm run bench:graceful-degradation`)
  — a Node-runnable simulation that drives the real `BridgeBlockConsumer` +
  `ResidualQualityController` against a GPU producer whose block cost scales
  with partial count, printing the handoff's §8 table and asserting the headline
  claim: controller-on underflow (≈0%) ≪ controller-off underflow (≈21%), with
  `effectiveN` dropping under load and recovering.
- README "Graceful degradation" subsection under the hybrid section.
- `docs/hybrid-residual-comparison.md` — Gaps #8 + #12 marked ✅ shipped, with
  the no-new-lane decision recorded.

## [0.9.50] — 2026-05-29

### Added — audio-pipeline comparator bench (`bench/audio-pipeline-comparator/`)

Closes **Gap #11** ("Comparator bench harness — apples-to-apples vs A / B / C")
from `docs/hybrid-residual-comparison.md` — that document's own **Recommendation
1**, the highest-leverage item for the comparative claim. The doc *asserts* that
the hybrid residual-on-carrier pattern is a marked upgrade over the four standard
approaches to GPU-accelerated browser audio; this bench renders the **same**
reference signal through **all four** pipelines and produces a side-by-side
scorecard, turning "we think this is better" into "here are the numbers."

#### What shipped (bench + docs only — no `src/`, no wire-format change)

A new `bench/audio-pipeline-comparator/` renders one reference signal
(fundamental + N LFO-modulated harmonic partials, defined once in a shared
`reference-signal.js`) four ways:

- **A** — pure-CPU AudioWorklet additive synth (`worklet.cpu.js`); carrier driven
  sample-accurately by `BridgeInputLane`. CPU-bound: the O(N)-per-sample cost
  caps the sustainable partial count.
- **B** — naïve GPU → `AudioBufferSourceNode` (`worker.gpu.js` "absn" mode +
  main-thread scheduler). The only path with no `process()` callback; latency is
  the buffer-queue floor, continuity collapses when the queue drains.
- **C** — GPU block-replace (`worklet.gpu-block-replace.js` over
  `BridgeBlockConsumer.process()`); a pitch change is only audible once a block
  *computed at the new freq* crosses the ring, so it inherits the ~85 ms block
  floor. The producer tags each block with `frame.carrierFreq` so C's latency
  probe can detect the first new-freq sample.
- **G** — hybrid carrier + GPU residual (`worklet.hybrid.js`,
  `processAdd`); the pattern under test.

The GPU producer (`worker.gpu.js`) is shared: one WGSL kernel emits the **full**
signal (B/C) or the **residual** only (G) via a uniform, and emits over either a
`Bridge<S>` SAB ring (C/G) or `postMessage` for the ABSN path (B). Metrics:
freq-change latency (p50/p95/p99/max + spread, shared latency histogram), stall
continuity (RMS), max sustainable partials, `process()` p99 (feature-detected),
and underflow / scheduling-gap counts. A "Copy report" button emits a JSON+text
blob for `results/<engine>.txt`. `npm run bench:comparator` serves it on port
5178 (COOP/COEP + root fallback).

### Why

The hybrid claim was argued, not measured — `bench/hybrid-residual/` measures
only one axis (RMS continuity under stall) between only two of the four paths
(G vs C). This bench measures all the axes across all four paths, producing the
evidence behind the "marked upgrade" framing: **G is the only path that wins
latency, continuity, and spectral richness simultaneously** — A wins latency but
loses partials; B / C win partials but lose latency + continuity.

### Wire compatibility

Zero change. Bench + docs only. `src/` and `dist/` are untouched; the bench
consumes the already-shipped `Bridge`, `BridgeBlockProducer`,
`BridgeBlockConsumer.process`/`processAdd`, and `BridgeInputLane` surfaces.

### Tests

Mandatory gates re-run (`npm run typecheck`, `npm test`, `npm run bench`) — all
green against the unchanged library surface. The comparator itself is a
manual/browser bench; an optional headless Playwright ordering-assertion spec is
documented as a follow-up (not shipped). Cross-browser captures land in
`results/` as gathered (Chromium drivable via the chrome-devtools MCP;
Firefox/Safari manual), following the `notify-cost-browser/results/` precedent.

### Documentation

`bench/audio-pipeline-comparator/README.md` (methodology + the Web-Audio-quantum
framing + predicted-vs-measured scorecard) and `results/README.md`.
`docs/audio-pipeline-comparator-handoff.md` marked shipped; Gap #11 and
Recommendation 1 in `docs/hybrid-residual-comparison.md` marked
✅ shipped (0.9.50); README §Hybrid gained a comparator pointer and a
`bench:comparator` run line.

## [0.9.49] — 2026-05-29

### Added — sample-accurate carrier control in the hybrid-residual demo via `BridgeInputLane`

Closes **Gap #3** from `docs/hybrid-residual-comparison.md` (Recommendation 3, the
smallest-cost gap on the list). The 0.9.41 hybrid demo controlled the carrier
fundamental through `port.postMessage({ type: "config", carrierFreq })` — a
control path that is quantum-granular at best and subject to MessagePort delivery
jitter. That undersold the architecture: the whole hybrid claim is *"the carrier
is low-latency,"* yet the carrier was being driven through the slowest transport
in the system. This rewires it onto the project's existing fast-lane primitive.

#### What changed (examples-only — no library / wire-format change)

`examples/hybrid-residual/` gained a second schema and a second SAB:

- **`makeInputSchema()`** (`schema.js`) — one frame per discrete carrier-control
  event: `seq: u64`, `tInputNs: u64`, `eventType: u32` (`0 = freq`, `1 = noteOn`,
  `2 = noteOff`, `3 = gain`), `sampleOffset: u32`, `value0: f32`, `value1: f32`.
  Plus `INPUT_CAPACITY = 64`, `EVENT_DRAIN_PER_QUANTUM = 32`, and `EVT_*` constants.
- **`main.js`** — allocates the input SAB (`SpscRing.allocate`), holds the
  `BridgeInputLane` producer side, and routes the freq + residual-gain sliders
  through `fireInputEvent()` (a ~1 µs synchronous SAB write) instead of
  `port.postMessage`. The GPU residual still gets the freq via `postMessage` to
  the worker (it rides the slow lane by design). Only the mode toggle stays on
  `postMessage` (control-plane, not sample-timed).
- **`worklet.js`** — holds the `BridgeInputLane` consumer side, drains every
  unread event per quantum (`drainEvents()` → `inputLane.pullAll`), clamps +
  sorts the batch by `sampleOffset`, then applies each frequency change **at its
  sample offset** inside the per-sample carrier loop. The carrier retunes within
  one quantum (~2.7 ms), bounded only by the audio output buffer.

`sampleOffset` is producer-supplied: a source that can correlate its clock to the
audio quantum (a sequencer, a timestamped MIDI stream) sets it for true
intra-quantum placement; a slider drag can't, so it leaves it `0` ("apply at
quantum start") — still a one-quantum response. The worklet honors whatever the
producer sends, clamped to `[0, N-1]`.

### Why

The perceptual win the hybrid pattern promises — *GPU residual may lag; carrier
control does not* — is only real if the carrier's control path is actually fast.
Routing carrier frequency through `postMessage` made the demo's headline a
fiction: pitch changes inherited the event-loop's latency, the exact thing the
architecture exists to avoid. Wiring it through `BridgeInputLane` makes the claim
true and demonstrates that the hybrid-residual pattern composes with the
project's fast-lane primitive (the same `BridgeInputLane` the `examples/fast-lane/`
demo uses for note events).

### Wire compatibility

Zero change to the library. This is an examples-only patch — it consumes the
already-shipped `BridgeInputLane` (0.6.19) and `BridgeBlockConsumer.processAdd`
(0.9.41) surfaces unchanged. `src/` is untouched; `dist/` is unchanged.

### Tests

`npm run typecheck` / `npm test` / `npm run bench` re-run green (no `src/` change,
so the existing suites cover the unchanged library surface). The new input-lane
round-trip was validated out-of-band: a producer pushing freq/gain events through
`BridgeInputLane` over the new schema and a separate consumer view draining them
via `pullAll` round-trips all six fields bit-exactly (`u64` seq/timestamp, `u32`
eventType/sampleOffset, `f32` value0/value1) in FIFO order.

### Documentation

- README §"Hybrid residual-on-carrier mode" gained a "Sample-accurate carrier
  control (0.9.49)" paragraph.
- `examples/hybrid-residual/index.html` copy updated to describe the input-lane
  control path and the carrier/residual latency asymmetry.
- `docs/hybrid-residual-comparison.md` Gap #3 and Recommendation 3 marked
  ✅ shipped (0.9.49).

## [0.9.48] — 2026-05-28

### Added — stereo / multi-channel `BridgeBlockConsumer` (interleaved `processAddStereo` / `processAddChannel`)

Lands the `docs/stereo-residual-handoff.md` spec: the highest-leverage real-audio
feature on the hybrid-residual track. The hybrid pattern (0.9.41) was mono;
stereo is the wall every adopter hits in the first 30 seconds. This closes Gap #1
from `docs/hybrid-residual-comparison.md` with the lowest-risk shape the gap
analysis identified — **interleaved samples in the lone `f32Array`**, decoded
per-channel on the consumer side.

#### What it does

`BridgeBlockConsumer<S>` gained two construction options and two methods:

- **`channels?: 1 | 2 | 4 | 6 | 8`** (default 1) and **`layout?: BlockChannelLayout`**
  (`"mono" | "interleaved" | "planar"`). For `channels > 1` the lone `f32Array`
  is interpreted as interleaved `L,R,L,R…` of `channels * blockSize` flat samples;
  `blockSize` becomes **per-channel** (`arrayLength / channels`). The sample for
  channel `c` at per-channel index `j` lives at flat index `j*channels + c`, and
  the cursor walks per-channel-sample units exactly as in mono (`channels === 1`
  is bit-for-bit the legacy path).
- **`processAddChannel(out, channelIndex, gain?, count?)`** — additive per-channel
  mix that ADVANCES THE CURSOR. The primitive for a one-channel-per-consumer
  topology or sequential consumption.
- **`processAddStereo(left, right, gain?, count?)`** — mixes channel 0 → `left`
  and channel 1 → `right` from the SAME window, advancing the cursor ONCE. The
  atomic "render one stereo quantum" op. Returns per-channel samples mixed.

The cursor-advance contract is load-bearing: `processAddStereo` is deliberately
NOT `processAddChannel(left,0)` + `processAddChannel(right,1)` — the latter
advances the cursor twice and reads two consecutive windows, desyncing L from R.
Both methods are thin wrappers over a private allocation-free `_mixWindow`
window-walker.

Carrier survives **per channel**: one interleaved frame is one ring pull, so all
channels underflow together; on ring-empty both methods leave the unfilled tail
of every output buffer untouched. `framesConsumed()` counts ring pulls regardless
of channel count; `underflowSamples()` counts per-channel window samples (cursor
units) — a stereo underflow of K window samples adds K, not 2K.

Legacy `process()` / `processAdd()` take no channel index and now THROW under
`channels > 1` (a guiding error, no silent wrong-channel audio). Public readonly
`channels` and `layout` were added for introspection.

#### Resolved design decisions (from the handoff's open questions)

- **A (>2ch):** stereo ships fully via `processAddStereo`; `channels: 4|6|8` is
  accepted by the type/validation but a `processAddChannels(outs[])` atomic for
  N>2-in-one-quantum is deferred (no concrete consumer yet). `processAddChannel`
  is the per-channel primitive available now.
- **B:** legacy `process`/`processAdd` throw under `channels > 1`.
- **C:** no new replacing stereo method; the example's "replace" mode zeroes L/R
  then `processAddStereo`s.
- **D:** `underflowSamples()` in per-channel window-sample (cursor) units.

`'planar'` layout throws at construction in 0.9.48 (reserved in the type for a
future non-breaking multi-field shape).

#### New exports (package root)

`BlockChannelLayout` (type).

### Why

The gap analysis flags stereo as the wall every hybrid-residual adopter hits
immediately, and stereo is what turns the demo from a proof into an instrument.
Yet interleaved keeps it low-risk: one `f32Array`, one ring, one producer
timeline, no wire change, mono bit-identical — almost all the work is
consumer-side cursor arithmetic. The psychoacoustic carrier/residual split
applies in stereo exactly as in mono; the only genuinely new design surface is
the cursor-advance contract for multi-channel-per-quantum rendering, which
`processAddStereo` resolves cleanly.

### Wire compatibility

Zero change. An interleaved schema still declares exactly one `f32Array`, so the
construction contract, the SAB layout, and `BridgeBlockProducer` are all
unchanged (the producer copies the lone array's full `channels * blockSize`
length). A `channels`-omitted / `channels: 1` consumer is byte-identical to
≤0.9.47. Additive + wire-equivalent → **patch** bump (`0.9.47 → 0.9.48`).
`blockSize`'s meaning changes only for `channels > 1`, which is brand-new, so it
is not a break.

### Tests

`tests/BridgeBlockConsumer.test.ts` pins 22–29: mono backward-compat (byte-
identical), interleaved construction + introspection, construction validation
(non-divisible length / channels>1+mono / planar / channels:3 all throw),
`processAddStereo` cursor advancement across frame boundaries + non-divisor
quantum (headline), `processAddChannel` advance-on-every-call contract,
interleaved underflow preserving the carrier per channel (full + mid-window),
legacy methods guarded under multichannel, and telemetry parity + `reset()`.
All 29 pins green; full suite + 1M-frame concurrent stress pass; `npm run bench`
within budget (new `processAddStereo` cell ≈ 0.7 µs/quantum, ~0.4 µs over the
mono `processAdd`).

### Documentation

`src/BridgeBlockConsumer.ts` file header gained a "Stereo / multi-channel"
section; method JSDoc documents the cursor-advance contract. README gained a
"Stereo / multichannel" subsection. New `examples/hybrid-residual-stereo/`
(six files + `npm run dev:hybrid-residual-stereo`) mirrors the mono demo with a
stereo-width slider and an L/R meter. `docs/stereo-residual-handoff.md` flipped
to shipped with a postscript; Gap #1 in `docs/hybrid-residual-comparison.md`
flipped to "shipped (0.9.48)".

## [0.9.47] — 2026-05-28

### Added — closing the last rung on two frontier tracks (codegen seamlessness + connect() latency-budget sizing)

Lands the `docs/frontier-10-handoff.md` spec (two small, additive,
wire-equivalent refinements) that take the `emitWorkletReader` (0.9.44)
and `connect()` (0.9.46) tracks from 9-ish to 10. Each was one rung short
of seamless for a small, real reason; this patch closes both. Combined
single patch — both are setup/codegen-time only, no hot-path or wire
change.

#### Part A — `emitWorkletReader`: close the source-string boundary

`emitWorkletReader` returns a *bare function* source string the caller
had to get into the worklet themselves (eval / Blob / build step), each
with a footgun. Three additive helpers in `src/emitWorkletReader.ts` ship
that plumbing (the `emitWorkletReader` primitive is unchanged):

- **`emitWorkletProcessorModule(input, opts)`** — wraps the reader in a
  self-registering, import-free `AudioWorkletProcessor` module string: it
  bakes the reader fn, a ctor that takes the SAB + capacity via
  `processorOptions`, a pre-allocated reusable `out` frame (typed arrays
  for array fields, so `process()` is allocation-free), and the caller's
  `processBody`. In scope inside `processBody`: the reader fn
  (`readFrame`), the reusable `out`, `this._view`, `this._capacity`, and a
  `slotOf(writeIndexMinus1)` helper. New `EmitWorkletProcessorOptions`
  interface (`{ processorName, processBody, capacity?, …EmitWorkletReaderOptions }`).
- **`toWorkletModuleURL(source)`** — Blobs *any* emitted source into an
  `addModule`-ready `{ url, revoke }`. Throws a clear, build-step-pointing
  error when `Blob` / `URL.createObjectURL` are absent (SSR / Node).
- **`compileWorkletReader(input, opts?)`** — `new Function`s the reader
  into a live `(view, slot, out) => void` for tests / Standard-mode
  main-thread consumers (NOT the audio thread; eval is unavailable there).

The caller's flow collapses to `toWorkletModuleURL(emitWorkletProcessorModule(…))`
→ `addModule(url)` → `new AudioWorkletNode(ctx, name, { processorOptions })`.
The unavoidable source-crossing boundary and the CSP trade-off
(`blob:` in `script-src`/`worker-src` for the Blob path; `unsafe-eval`
for `compileWorkletReader`; the build-step path stays the CSP-safe
default) are documented in the JSDoc + README §codegen, not hidden.

#### Part B — `connect()`: derive capacity from the latency budget, not a bucket

`connect()`'s `latencyHint` accepts a new `LatencyBudget` object
(`{ latencyMs, sampleRate?, outputBufferFrames?, producerHz?, maxSabBytes? }`)
alongside the three string hints (union widened; the enum is unchanged and
remains the default). For a **block schema** (a lone PCM array field), the
macro ring is sized from the actual audio one frame represents via the
identity `frameAudioMs · capacity = latency`:

```
samplesPerFrame = the lone PCM array field's flat length
frameAudioMs    = 1000 · samplesPerFrame / sampleRate
capacity        = nextPow2(ceil(latencyMs / frameAudioMs))
```

Worked example: 1024-sample f32 frames @ 48 kHz → `frameAudioMs ≈ 21.3`;
a `latencyMs: 60` budget → capacity **4** (≈ 85 ms worst case), where the
`'balanced'` bucket would over-allocate to **256**. Fallback ladder:
block-math → `producerHz` (control schema) → enum default (flagged
`sizing.resolvedFromBudget === false`). `maxSabBytes` clamps capacity DOWN
as a memory guard. The resolved sizing is surfaced on the new
`ConnectRingHandle.sizing` (`{ resolvedFromBudget, frameAudioMs?,
estimatedLatencyMs, sabBytes }`) so the choice is legible. New pure helper
`audioFramesPerSlot(schema)` is the block-shape detector.

#### New exports (package root)

`emitWorkletProcessorModule`, `toWorkletModuleURL`, `compileWorkletReader`,
`audioFramesPerSlot` (values); `EmitWorkletProcessorOptions`,
`LatencyBudget`, `RingSizing` (types). `LatencyHint` widened to include
`LatencyBudget`.

#### Refinement vs the spec

The spec's `sizing.estimatedLatencyMs` was non-optional; on the fallback
path (control schema, no `producerHz`) the per-frame audio duration is
genuinely indeterminate, so the shipped field is `NaN` there (with
`resolvedFromBudget === false` as the honest signal) rather than a
fabricated value. Recorded in the design-note postscript.

### Why

Both are ergonomics + precision, not capability — the transports, the
codec, and the protocol are untouched. Part A removes the eval/Blob
keystrokes while staying honest that the source-crossing boundary and the
CSP trade-off remain. Part B replaces a 3-bucket guess with the actual
`frameAudioMs · capacity = latency` identity plus a clean fallback ladder
so non-block schemas don't regress.

### Wire compatibility

Fully wire-equivalent and additive. No SAB lane, no frame-layout change,
no change to any existing class or method. `emitWorkletReader` and the
string `latencyHint` enum behave identically. Both refinements run at
setup / codegen time, never in `process()` — bench unaffected.

### Tests

`tests/Bridge.codegen.test.ts` gains pins 6–8 (compiled-fn round-trip vs
`Bridge.pull`; `emitWorkletProcessorModule` shape — one `registerProcessor`,
embeds the reader, import-free, parses; `toWorkletModuleURL` guard +
stubbed happy path). `tests/connect.test.ts` gains pins 103–108
(block-schema worked example; `producerHz` control sizing; fallback
ladder; `maxSabBytes` clamp; enum-still-works regression; `audioFramesPerSlot`
unit test). Full suite green incl. the 1M-frame concurrent stress (0/10
timeouts); typecheck clean; bench within budget (push/pull/pullLatest
median 1.30 μs).

### Documentation

README §codegen gains a "Getting the reader into the worklet" subsection
(the three paths + their CSP posture) and §connect gains a "Latency-budget
sizing" subsection (the worked example + the ladder).
`docs/frontier-10-handoff.md` status flipped to shipped with a postscript
recording the actual landed API + the one deviation.

## [0.9.46] — 2026-05-28

### Added — `connect()` one-call topology constructor (final frontier track)

Lands the `connect-topology` design note (shipped at 0.9.44 as a
decision-pending spec) as **shape (b) "allocator + handle + mount"** at
MVP1 scope. New module `src/connect.ts`. With this, all five frontier
tracks from the 10/10 roadmap are shipped; the two design-only specs
(`Bridge<S,Role>` at 0.9.45, `connect()` here) are now both real.

#### What it does

`connect(spec)` collapses the multi-step Turbo setup recipe — pick a
capacity, `Bridge.allocate`, allocate a second SAB for the fast input
lane, `postMessage` the sab(s) + `describeLayout()`, reconstruct a facade
per peer, and guard the COOP/COEP precondition — into one call plus a
symmetric `mount(handle, opts)`:

```ts
// allocator + producer thread
const topo = connect({ macro: macroSchema, input: inputSchema, latencyHint: "tracking" });
worker.postMessage(topo.handle, topo.transferList);
const me = topo.mount({ role: "producer", macroSchema, inputSchema });

// worker (consumer)
const them = mount(e.data, { role: "consumer", macroSchema, inputSchema });
```

It (1) probes the environment via the shipped `getEnvironmentReport()`,
(2) resolves Turbo (SAB) vs Standard (`MessageChannelBridge`) vs a
graceful throw, (3) sizes the ring(s) from a `latencyHint`, (4) allocates
the macro ring + optional fast-input ring, and (5) returns a frozen,
clone-safe `ConnectTopology` carrying the transferable `handle` plus a
thread-local `mount(...)`.

#### Sizing heuristic (`latencyHint` → capacity)

Declared intent instead of a magic slot count. Per-lane backlog budgets
(rounded up to a power of two, clamped to 2³⁰):

| `latencyHint` | macro | input |
|---|---|---|
| `'tracking'` | 64 | 256 |
| `'balanced'` *(default)* | 256 | 512 |
| `'throughput'` | 1024 | 2048 |

The macro path wants freshness (small backlog; `pullLatest` collapses to
newest); the input lane wants completeness (large backlog; `pullAll`
preserves every discrete event). A numeric per-ring `capacity` override
bypasses the table (still pow2-rounded).

#### Graceful COOP/COEP failure

`crossOriginIsolated` was previously referenced only in
`src/environment.ts`, never in the transport classes — a non-isolated
page hit an opaque `SharedArrayBuffer is not defined` throw. `connect()`
reads `report.suggestedMode`: `"unsupported"` (no AudioWorklet) throws
`ConnectUnsupportedError("unsupported")`; `"standard"` either falls back
to `MessageChannelBridge` (default) or, when `allowStandardFallback:
false`, throws `ConnectUnsupportedError("isolation-required")`. The error
carries the `EnvironmentReport` so the caller can render the actionable
`report.fixes` (e.g. `"enable-coop-coep"`). A `.withInvariant(...)`
schema that would resolve to Standard mode is rejected at `connect()`
time (not deferred to `mount` on a worker), since `MessageChannelBridge`
has no invariant lane.

#### New exports (package root)

`connect`, `mount`, `ConnectUnsupportedError` (values) and `LatencyHint`,
`ConnectRingSpec`, `ConnectSpec`, `ConnectMode`, `ConnectRingHandle`,
`ConnectHandle`, `ConnectRole`, `MountOptions`, `MountResult`,
`ConnectTopology` (types).

#### Refinement vs the spec

The spec's `ConnectRingHandle` did not carry `policy`; the shipped handle
does, so the peer's reconstructed `SpscRing` matches the allocator's
backpressure policy (it must agree on both ends). `publishPllToSab` from
the spec's `ConnectRingSpec` was dropped: it is a `Bridge<S>`-level PLL
concern with no equivalent on the `BridgeProducer`/`BridgeConsumer`
facade reconstruction path, so accepting-and-ignoring it would have been
dishonest. Both noted in the design-note postscript.

### Why

`connect()` is ergonomics over capability — every piece it orchestrates
already shipped. Its value is collapsing the hand-wired, twice-written
two-ring recipe into one declarative call and converting the opaque
non-isolated `SharedArrayBuffer` throw into a guided `report.fixes`
message. The `latencyHint` removes a genuine magic-number papercut.

### Wire compatibility

Fully wire-equivalent and additive. No SAB lane, no frame-layout change,
no change to any existing class. `connect`/`mount` run once at setup,
never in `process()`; the returned facades' hot-path methods are the
existing RT-safe ones unchanged — bench unaffected.

### Tests

New `tests/connect.test.ts` (pins 95–102), wired into `test` /
`test:unit` before the concurrent stress: Turbo handle shape; latencyHint
sizing table + numeric override; producer/consumer mount round-trip over
one shared SAB; input-lane topology (`pullAll` drains every event in
order); graceful Standard fallback (handle carries a `MessagePort` +
`report.fixes`); unsupported + isolation-required throws; invariant
schema rejected at `connect()` time on Standard; `mount` frameByteSize
mismatch guard. The environment is injected via `spec.environment` for
determinism under Node. 29 Node suites green (was 28); 1M-frame
concurrent stress 0/10 timeouts; typecheck clean; bench within budget.

### Documentation

`docs/connect-topology-design.md` status flipped to shipped with the
reserved postscript filled in. README's Frontier-primitives section gains
a `### One-call topology — connect()` subsection; with this all frontier
tracks are shipped (no remaining design-only specs).

## [0.9.45] — 2026-05-28

### Added — `Bridge<S, Role>` real-time-safety role lattice (frontier track ship 2/2)

Lands the `rt-safety-lattice` design note (shipped at 0.9.44 as a
decision-pending spec) as **option (c)**: a phantom `Role` type parameter
on the canonical `Bridge`. The maintainer chose option (c) over the
spec's hedged option (b) — the hedge existed only to dodge the
public-generic-arity change, which is moot at **zero users**. Stays in
the `0.9.x` soak line (patch, not the `0.10.0` minor the spec
anticipated) on the same override basis as Standard mode (0.9.40).

#### What it does

`Bridge<S, Role>` brands a handle with the thread it lives on. On the
`"worklet"` brand the methods that are illegal on the audio render
thread are **structurally absent** — calling them is a compile error:

- `waitForData` / `waitForSpace` (Axis 1) — call `Atomics.wait`, which
  throws `TypeError` on the browser main thread and stalls the render
  quantum inside `process()`.
- `subscribeTelemetry` (Axis 3) — uses `setInterval`, absent from
  `AudioWorkletGlobalScope`.

```ts
const worklet = forWorklet(Bridge.allocate(1024, schema)); // Bridge<S,"worklet">
worklet.pullLatest(frame);   // ✅ RT-safe
worklet.waitForData(50);     // ❌ TS2339: Property 'waitForData' does not exist
const worker = forWorker(alloc);   // Bridge<S,"worker"> — full surface
```

The allocating Axis-2 helpers (`scratchFrame` / `scratchEvaluatedFrame`
/ `telemetry`) stay present on the worklet handle — a worklet
constructor legitimately pre-allocates scratch frames before entering
`process()`, so those are documented-discouraged, not gated.

#### How it's built

The class was renamed to an exported `BridgeImpl<S>`; `Bridge` is now a
conditional **type alias** (`Role extends "worklet" ? Omit<…, blocking> :
BridgeImpl<S>`) plus a retyped **`const` constructor**, so the gated
methods are genuinely **absent** ("Property does not exist") rather than
present-but-`never`. The phantom brand is a required `unique symbol`
field — erased at runtime (zero bytes, zero ops; the runtime object is
one ordinary `Bridge`), but nominally distinct so a `"worker"` handle
cannot up-assign into a `"worklet"` slot and re-expose the blocking
surface through structural subtyping. `forWorklet` / `forWorker`
role-stamp a handle from a single `Bridge.allocate(...)`.

#### New exports (package root)

`forWorklet`, `forWorker` (values) and `BridgeRole`, `DefaultRole`
(types). `BridgeImpl` is exported from the module for declaration-emit
nameability but is not part of the package root surface.

### Why

Promotes a class of real-time-safety violations from production runtime
(a thrown `TypeError` or an audible render-quantum stall) to a compile
error at the keystroke. The per-method RT contract previously lived only
in JSDoc prose; `Bridge<S, Role>` makes the compiler enforce it. Zero
runtime cost keeps it free for the hot path.

### Wire compatibility

Fully wire-equivalent and source-compatible. No SAB/header/frame change.
`DefaultRole = "worker"`, so `Bridge<S>`, every `new Bridge(...)` call
site, all static members, and `instanceof Bridge` are unchanged. The
only removed capability is `class X extends Bridge` (subclassing the
now-`const` `Bridge`) — used nowhere in the repo.

### Tests

New `tests/Bridge.roles.test.ts` (pins 90–94 + a `_typeLevelPins`
block of `@ts-expect-error` conformance pins), wired into `test` /
`test:unit` before the concurrent stress. Runtime pins: worklet↔worker
round-trip over one allocation, brand-erased-at-runtime, statics
reachable through the retyped const, worker keeps the blocking surface.
Type-level pins (enforced by `npm run typecheck`): `waitForData` /
`waitForSpace` / `subscribeTelemetry` absent on worklet, and role-brand
invariance on assignment — `tsc` fails if any regresses. 28 Node suites
green (was 27); 1M-frame concurrent stress 0/10 timeouts; typecheck
clean; bench unchanged (phantom brand adds no runtime).

### Documentation

`docs/rt-safety-lattice-design.md` status flipped to shipped (option c)
with a shipped postscript. README gains a `### Real-time-safety role
lattice — Bridge<S, Role>` subsection under Frontier primitives;
`connect()` remains the one outstanding design-only spec.

## [0.9.44] — 2026-05-28

### Added — frontier "King-track" cohort: predictive extrapolation, record/replay timeline, worklet codegen, formal SPSC proof

A multi-track patch landing the net-new, wire-equivalent half of the
frontier roadmap (the "10/10" analysis). Three additive public modules,
two new correctness artifacts, a machine-checkable formal model, and two
design-only specs for the public-surface changes that still need
maintainer sign-off. No wire-format change; no breaking public-API
change; every existing surface behaves bit-identically.

#### `predictiveExtrapolateInto` — confidence-bounded forward extrapolation (`src/predictiveExtrapolation.ts`)

Promotes the trajectory evaluator from *interpolation* (between two known
frames) to bounded *extrapolation* (past the newest frame, to consumer
time `t` or `t + outputBuffer` — where the sample will actually be
audible). The new standalone pure function evaluates the Taylor/Hermite
trajectory forward and, crucially, **clamps the extrapolation distance
and blends back toward hold as the PLL's uncertainty grows**, so a
low-confidence clock estimate can never let the prediction run wild. It
maps the PLL's ns-domain uncertainty (`sigmaEstimateNs`, `driftPpm`)
through the trajectory derivatives into a per-sample value band. Treats
`sigma == 0` as "seeding/unknown" (conservative hold), not "zero
uncertainty". Allocation-free hot path; reuses the existing
`evaluateTrajectoryInto` math. Non-breaking — no `Bridge.ts` edit.
Exports: `predictiveExtrapolateInto` + types `PllUncertainty`,
`PredictiveExtrapolationConfig`, `PredictiveExtrapolationResult`.

#### `TimelineRecorder` / `TimelinePlayer` — deterministic record/replay + offline bounce (`src/TimelineRecorder.ts`)

Turns the live bridge into a recordable, deterministic, re-renderable
medium. `TimelineRecorder<S>` captures pushed frames as
`(tMacroNs, frameSnapshot)` tuples into a growable heap buffer (zero SAB,
zero Atomics); `serialize()`/`deserialize()` pack them to a compact,
**schema-tagged** `ArrayBuffer` (the tag is a hash of `describeLayout()`,
so a mismatched-schema deserialize is rejected loudly rather than
silently mis-decoding); `TimelinePlayer<S>` replays the tuples
sample-accurately and **bit-identically across runs and machines**, far
faster than real time. The insight: replay removes the PLL from the loop
by synthesizing a deterministic consumer clock from
`(sampleIndex, sampleRate)`, making replay a pure function of
`(timeline, sampleRate)`. Exports: `TimelineRecorder`, `TimelinePlayer`,
`deserialize`, `TimelineSchemaMismatchError`, `TimelineFormatError` +
types `TimelineTuple`, `TimelineRecorderOptions`.

#### `emitWorkletReader` — schema-derived zero-import worklet codegen (`src/emitWorkletReader.ts`)

Makes the schema *generate* the hottest read path instead of describing
it. `emitWorkletReader(schema, opts?)` emits, as a source-code **string**,
a monomorphized zero-import `DataView` reader for that exact schema —
fixed byte offsets and strides folded in as literals, no runtime offset
math, no library import on the audio thread. Covers every `FieldKind`
plus array fields; the invariant lane is opt-in. The emitted source is
verified import-free and bit-exact against `Bridge.pull`. Exports:
`emitWorkletReader` + types `EmitWorkletReaderOptions`,
`EmitWorkletReaderInput`.

#### Formal SPSC correctness artifacts (`formal/`, `docs/spsc-happens-before-proof.md`)

- **`formal/SpscRing.tla` + `.cfg` + README** — a TLA+/PlusCal model of
  the SPSC protocol under a weak-memory abstraction: producer push and
  consumer pull as interleaved processes over the active `write_index` /
  `read_index` lanes, with the payload-visibility ordering established by
  the release-store/acquire-load pairing. Invariants `NoTornRead`,
  `NoOverwrite`, `WakeLiveness`. Models the JS `Int32` counters as 32-bit
  signed wrapping integers (not Naturals) and encodes both the `|0`
  (ToInt32, signed diff) and `>>>0` (ToUint32, slot index) coercions
  exactly. Checked offline (no TLC in the repo image).
- **`docs/spsc-happens-before-proof.md`** — a written happens-before
  proof, lane by lane, grounding each claim against the exact `Atomics`
  call sites in `src/SpscRing.ts` with line numbers. Extends the informal
  narrative in the `SpscRing.ts` header (lines 91–119) to the multi-frame
  `pullLatest` jump and the drop-oldest CAS-commit consumer that the
  header does not cover.

#### Design-only specs (decision-pending, no `src/` change)

- **`docs/rt-safety-lattice-design.md`** — phantom-typed `Bridge<S, Role>`
  RT-safety lattice: `waitForData` / `waitForSpace` (blocking) made
  *non-existent* on the worklet-branded type, turning the doc-comment
  warning into a compile error. Recommends a non-breaking landing under
  the existing `webgpu-audio-bridge/experimental` subpath. Changes the
  public generic surface, so it ships as a spec pending sign-off.
- **`docs/connect-topology-design.md`** — a one-call `connect({ macro,
  input?, latencyHint? })` factory that assembles the dual-ring
  macro + fast-lane topology, allocates and sizes the SABs, runs the
  COOP/COEP precondition check, and hands back correctly-branded
  producer/consumer pairs. Depends on the role lattice; spec only.

### Why

These tracks compose machinery the project already had (the trajectory
evaluator, the clock-recovery PLL, the schema-as-truth layout, the
documented Atomics protocol) into capabilities the control-rate-to-
audio-rate category doesn't yet ship: extrapolating a frame that doesn't
exist *yet* (collapsing control-rate latency for continuously-varying
parameters), turning an ephemeral live bridge into a bounceable format,
generating the audio-thread read path from the schema, and converting
"we tested it hard" into a machine-checkable proof of the lock-free
core. The public-surface tracks (role lattice, `connect()`) are
deliberately held as specs because they touch the `Bridge<S>` generic
signature and warrant explicit maintainer sign-off per the versioning
policy.

### Wire compatibility

Fully wire-equivalent. No SAB header lane change, no frame-layout change,
no change to any existing method's behavior. All three new modules are
additive heap-side / build-time helpers; `src/index.ts` gained only
additive re-exports. A 0.9.44 peer interoperates bit-for-bit with any
0.3+ peer.

### Tests

Four new standalone suites (wired into both `test` and `test:unit`,
before the concurrent stress):

- `tests/Bridge.predict.test.ts` — pins 81–89: cold/unlocked PLL → hold,
  confident path == bare evaluator, mid-σ lerp toward hold, deep-horizon
  fade, order-1 zero-uncertainty, drift inflation shrinks horizon,
  value-uncertainty formula, allocation-free reuse, f32/f64 parity.
- `tests/Bridge.timeline.test.ts` — round-trip determinism (two
  renders + two deserializes byte-identical), faster-than-real-time
  replay (~9.98 s audio in ~0.26 s wall), schema-tag / magic / version /
  monotonicity rejection, forward extrapolation past the last frame,
  invariant-schema rejection at construction.
- `tests/Bridge.codegen.test.ts` — emitted source parses via
  `new Function`, bit-exact vs `Bridge.pull` across every kind,
  import-free / require-free, literal-folded strides + loop bounds,
  opt-in invariant lane.
- `tests/Bridge.interleaving.test.ts` — loom-style deterministic
  interleaving explorer: 12,870 interleavings / 48,619 states reproducibly
  enumerated; `Int32` wrap coercions at the 2³¹ boundary; reject/drain
  fast path; no torn read / no overwrite over the full state space;
  consumer + producer lost-wake; `pullLatest` multi-frame jump;
  drop-oldest two-writer CAS-fail-and-retry race with bounded retries.

All 27 Node suites green (was 23), including the 1 M-frame concurrent
stress (0/10 timeouts). `npm run typecheck` clean. `npm run bench`
within budget — push/pull/pullLatest medians 1.30 μs, trajEval fast path
within the documented 1.25 μs gate.

### Documentation

Seven new design notes under `docs/` (predictive-extrapolation,
record-replay, emit-worklet-reader, formal-verification,
interleaving-fuzzer, rt-safety-lattice, connect-topology) plus the
happens-before proof, all matching the `docs/standard-mode-design.md`
house style. `formal/` is a new top-level directory for the TLA+ model.

## [0.9.43] — 2026-05-28

### Added — `LLM_BUNDLE.md` regeneration script + refresh to 0.9.42 specs

The previously hand-maintained `LLM_BUNDLE.md` had drifted to version
0.6.4 / 2026-05-26 — seven patches plus the entire audit-response
cohort, Standard mode (0.9.40), the hybrid pattern (0.9.41), and two
design notes (0.9.39, 0.9.42) behind. This patch closes the drift
permanently by replacing the hand-maintained file with a generator
script and refreshing the bundle in one shot. Lands task #12 from
the audit-response in-flight task list.

#### New `scripts/regenerate-llm-bundle.mjs`

Node ESM script (no runtime dependencies). Reads the project's
canonical files (`package.json`, `CITATION.cff`, `README.md`,
`ROADMAP.md`, `QUICKSTART.md`, `MIGRATION.md`, recent `CHANGELOG.md`
entries, both design notes, public-API source files, machinery
file headers, the two canonical example demos) and assembles them
into a single Markdown bundle at `LLM_BUNDLE.md`.

Wired into `package.json` as `npm run llm-bundle`. Runs in well
under a second on a dev laptop. The script supports three inline
modes per file:

- `full` — inline the whole file (most entries).
- `header` — extract only the leading `/* ... */` JSDoc header. Used
  for the seven extracted machinery files (`SpscRing.ts`,
  `FrameSmoother.ts`, `ConsumerClockRecovery.ts`,
  `AdaptiveFlowController.ts`, `BridgeConsumer.ts`,
  `BridgeProducer.ts`, `BridgeWebNNSource.ts`) whose protocol math
  + invariants live in the header and whose internals would triple
  the bundle size for diminishing return.
- `recent-changelog` — inline only `## [...]` entries at or above a
  pinned version (currently 0.9.36). Older entries stay in the full
  `CHANGELOG.md` at the repo.

The `INCLUDES` array at the top of the script is the source of
truth for what gets bundled. Adding a new file is a one-line
addition; reordering is rearranging the array.

#### `.gitignore` — `LLM_BUNDLE.md` marked as build artifact

The bundle is now an `npm run llm-bundle` output, not a hand-edited
checked-in file. Treating it as a build artifact (like `dist/`):

- Prevents the historical drift problem — the file can't get stale
  silently if it's generated on demand.
- Avoids committing a 640 KB single-file blob that gets regenerated
  every patch.
- Lets adopters regenerate their own snapshot after `git pull` if
  they want to feed the current project state to an LLM.

#### README cross-link for LLM auditors

The `### Status & maturity` preamble at the top of the README gains
a final bullet pointing LLM auditors / search agents at the bundle
and naming the regenerator. The audit-response framing assumed
auditors would discover the bundle on their own (the file was at
the repo root); making the pointer explicit costs one line and
removes the "did the auditor find this?" ambiguity.

#### `CLAUDE.md` — bundle entry added to "What lives where"

Three new entries in the file inventory section so future Claude
sessions know about `docs/standard-mode-design.md`,
`docs/hybrid-residual-comparison.md`, and the `LLM_BUNDLE.md`
regenerator. Treating these as first-class repo surface rather
than implementation details.

#### Bundle refreshed to 0.9.42

First run of the new generator produces a 12,360-line / 641 KB
bundle. Reflects all surfaces shipped through 0.9.42:

- Two-tier transport story (Turbo + Standard, both shipped).
- Hybrid residual-on-carrier pattern with the 0.9.41
  `BridgeBlockConsumer.processAdd()` API.
- Both design notes inlined.
- Bus-factor disclaimer + scope discipline section from 0.9.38.
- Audit-response decision table + freshness policy from 0.9.37.
- WebGPU Baseline browser-support matrix from 0.9.36.

The bundle is intentionally about 3× the size of the 0.6.4
snapshot — the project surface has grown by Standard mode, the
hybrid pattern, two design notes, and the entire audit-response
README rework.

### Why

The audit's "an LLM auditor reading the first screen of the README
should get an accurate picture" framing applies recursively: the
bundle was supposed to be the single-shot snapshot for auditors
who do want a full picture, but it had silently gone seven patches
stale. A regeneration script removes the staleness as a class of
problem — the bundle now matches the repo state at whatever moment
the script was last run.

This patch is the closeout of the audit-response cohort's
documentation work. The remaining audit-response tasks (#7 cross-
browser bench corpus, #8 alternatives comparison) are either
substantial standalone work (Gap #11 from the hybrid-residual
comparison covers #7 conceptually) or substantially overlapping
with what's already shipped (the alternatives comparison in #8 was
absorbed by the §"Is this the right tool for your problem?"
decision table in 0.9.37 plus the §"The alternative landscape" in
the hybrid-residual comparison doc).

### Wire compatibility

None affected. New script + .gitignore + README pointer + CLAUDE.md
file inventory entries. No SAB protocol change, no schema DSL
change, no public-API change.

### Tests

23 Node suites green. `npm run typecheck` clean. `npm run bench`
within all documented budgets. `npm run llm-bundle` succeeds and
produces a well-formed Markdown file.

### Documentation

- `scripts/regenerate-llm-bundle.mjs` — **new file**, ~240 LOC.
  Reads inputs, assembles bundle, writes `LLM_BUNDLE.md`. No
  runtime dependencies.
- `package.json` — `version` bumped to 0.9.43; new `llm-bundle`
  script entry.
- `CITATION.cff` — `version` bumped to 0.9.43.
- `.gitignore` — `LLM_BUNDLE.md` added with a one-line note.
- `README.md` — final bullet in §Status & maturity points at the
  bundle.
- `CLAUDE.md` — three new entries in the §"What lives where" file
  inventory (`docs/standard-mode-design.md`,
  `docs/hybrid-residual-comparison.md`, `LLM_BUNDLE.md`).
- `CHANGELOG.md` — this entry.
- `ROADMAP.md` — 0.9.43 row in the cohort table.

## [0.9.42] — 2026-05-28

### Added — Hybrid residual-on-carrier: comparison and gap analysis

Documentation-only patch. Lands task #14 from the audit-response
in-flight task list. The 0.9.41 hybrid pattern's comparative claim
("marked upgrade against alternative GPU-accelerated browser audio
approaches") has been asserted in the README but not characterized
against the full landscape; the new design note does that and also
maps the room to push the pattern further on the existing
foundation.

#### New `docs/hybrid-residual-comparison.md`

Sibling to `docs/standard-mode-design.md` (0.9.39). ~700 lines.
Three substantive parts:

**1. The alternative landscape.** Six approaches characterized:

- **A. Pure CPU AudioWorklet** — production-audio status quo.
- **B. GPU compute → AudioBufferSourceNode** — the naïve attempt
  most "WebGPU audio" tutorials take; fails the latency test
  (30-65+ ms before zero-latency monitoring).
- **C. Pure GPU block mode via `BridgeBlockConsumer.process()`** —
  our own pre-0.9.41 pattern; ~85 ms block-mode floor.
- **D. Faust / Emscripten WASM DSP in AudioWorklet** — universal
  deployment; CPU-bound spectral richness.
- **E. Tone.js + custom GPU side channel** — bespoke per project,
  no packaged reference implementation.
- **F. `OfflineAudioContext` + GPU pre-render** — fixed
  compositions, non-interactive.

Each scored across 7 axes (interactive latency / spectral richness
/ glitch tolerance / browser deployment / implementation cost /
polyphonic capability / maturity) with verdict paragraphs explaining
when each is the right choice.

**2. The hybrid pattern's three distinctive claims.** The
comparative argument boils down to three things no alternative does
simultaneously:

- **Perceptual CPU/GPU split, not technical.** The carrier
  (pitch-defining, latency-critical) is on CPU at sub-quantum
  latency; the residual (spectrally rich, latency-tolerant) is on
  GPU at the block-mode floor. The split is informed by the
  psychoacoustic asymmetry between pitch perception (tight time
  resolution) and spectral envelope perception (coarse time
  resolution). No other public pattern in the WebGPU-audio space
  exploits this asymmetry.
- **Strict glitch-tolerance superiority via additive composition.**
  `processAdd` leaves `out` untouched on underflow; the carrier
  already written to `out` survives the GPU stall. Audibly: residual
  fades out, fundamental keeps playing. Quantitatively: stall-window
  RMS / baseline RMS at ~95-100% (hybrid) vs ~0% (replace), measured
  by `bench/hybrid-residual/`. No alternative degrades this way.
- **One-method-call composition.** The worklet change from pure
  block-mode to hybrid is three lines. No new class, no schema
  change, no protocol bump, no backward-compat break.

Quantitative comparison table includes per-quantum cost (200 ns
hybrid-mode tax = 0.0075% of 2.67 ms quantum budget), stall-window
continuity ratio (~95-100% hybrid vs ~0% replace), and a
latency-floor matrix showing hybrid is the only entry where the
interactive component matches pure CPU AudioWorklet AND the
spectral component matches full GPU compute.

**3. Fifteen-item gap analysis.** Each gap has a one-line
rationale, cost / complexity estimate, and dependency note:

1. Stereo / multi-channel support (current pattern is mono).
2. Polyphonic carrier / N-voice hybrid (current is monophonic).
3. Sample-accurate carrier params via `BridgeInputLane` (current is
   postMessage-poll).
4. Sample-accurate residual gain envelope (current is scalar gain).
5. Crossfade-on-stall (current is binary — drops instantly on
   underflow).
6. Predictive carrier from upcoming residual blocks (advanced —
   carrier tracks GPU spectral evolution).
7. Three-tier hybrid (CPU audio + GPU block + main-thread control).
8. Stall-aware quality degradation (reverse `flow_scale` for
   compute load).
9. Latency-compensated synchronization mode (intentional carrier
   delay for phase coherence).
10. Multi-resolution residual (fast + slow GPU layers at different
    block sizes).
11. **Comparator bench harness — apples-to-apples vs alternatives
    A / B / C.** Proves the marked-upgrade claim quantitatively.
12. Subscribe-to-underflow callback (current is raw count polling).
13. Residual envelope-follows-carrier (auto-ducking pattern).
14. Cross-browser stall continuity measurement (current bench is
    Chromium-only).
15. Long-tail latency measurement under realistic load (current
    bench is steady-state).

The note ends with three highest-leverage gaps recommended to
address first: **#11 comparator bench** (proves the claim
quantitatively), **#1 stereo** (every adopter hits this in the
first 30 seconds), **#3 sample-accurate carrier params via
BridgeInputLane** (composes with existing primitives, lowest cost).

The note also explicitly names **two non-gaps**: replacing the
carrier with a higher-quality CPU oscillator (worklet-side concern,
not library-side), and direct GPU→AudioWorklet shared memory
(blocked on the WebGPU `mappedAtCreation` spec evolution, tracked
under Beyond 1.0).

#### README cross-link

The §Hybrid residual-on-carrier mode section gains a paragraph
linking the new design note for adopters who want the comparative
analysis + gap roadmap.

### Why

The 0.9.41 release shipped a genuinely novel pattern — the
perceptual CPU/GPU split is the kind of move that should be made
explicit so future audits, contributors, and adopters can see the
reasoning behind it rather than treating the pattern as
self-explanatory. The comparison against six alternatives also
serves as a defensible answer to the future audit question "is
this approach actually better than X, or is it just different?"

The gap analysis serves the same purpose looking forward — it
documents the design surface the project is choosing not to
exploit yet, with cost estimates, so the maintainer can decide
which gaps to close as the 0.9.x soak continues toward 1.0. The
three highest-leverage gaps (comparator bench / stereo /
sample-accurate carrier params) are the most likely candidates for
the next few patches.

### Wire compatibility

None affected. Documentation only — new design-note file + a
README paragraph linking it. No SAB protocol change, no schema
DSL change, no public-API change.

### Tests

23 Node suites green. `npm run typecheck` clean. `npm run bench`
within all documented budgets. The `tests/readme-imports.test.ts`
drift gate still holds — none of the README import blocks were
touched.

### Documentation

- `docs/hybrid-residual-comparison.md` — new file, ~700 lines.
  Six-alternative landscape characterization + three-claim
  comparative argument + quantitative measurement table +
  fifteen-gap roadmap + three highest-leverage recommendations +
  two explicit non-goals + open questions for the gaps that need
  separate design decisions before implementation.
- `README.md` — §Hybrid residual-on-carrier mode gains a final
  paragraph linking the new design note.
- `ROADMAP.md` — new 0.9.41 row (backfilled — the 0.9.41 ship
  didn't add it) and new 0.9.42 row in the cohort table.
- `CITATION.cff` — `version` bumped to 0.9.42.
- `package.json` — `version` bumped to 0.9.42.
- `CHANGELOG.md` — this entry.

## [0.9.41] — 2026-05-28

### Added — `BridgeBlockConsumer.processAdd()` for hybrid residual-on-carrier audio

The headline addition this patch: an additive sibling of the audio-rate
`process()` path. `processAdd(out, gain?, count?)` sums
`gain * sample[i]` into `out[i]` instead of overwriting. Designed for
the **hybrid residual-on-carrier pattern** — the AudioWorklet generates
a cheap CPU "carrier" (e.g. sawtooth at slider-controlled fundamental,
zero-latency by construction) into `out`, then folds the GPU-computed
"residual" (a spectrally rich layer that benefits from GPU parallelism)
on top.

```ts
import { Bridge, BridgeBlockConsumer } from "webgpu-audio-bridge";

class HybridProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const bridge = new Bridge(opts.processorOptions.sab, /*…*/);
    this.consumer = new BridgeBlockConsumer(bridge);
    this.phase = 0;
  }
  process(_in, outputs) {
    const out = outputs[0][0];
    // 1. CPU carrier — fundamental sawtooth, zero latency.
    const dphi = this.freq / sampleRate;
    for (let i = 0; i < out.length; i++) {
      out[i] = (2 * this.phase - 1) * 0.25;
      this.phase = (this.phase + dphi) % 1;
    }
    // 2. GPU residual — harmonic partials, sums on top.
    this.consumer.processAdd(out, this.residualGain);
    return true;
  }
}
```

#### Underflow semantics — the headline win

`processAdd` differs from `process` in exactly one place: **the
underflow path leaves `out` untouched**. When the GPU producer stalls
(`mapAsync` jitter, frame drop, browser tab throttling, deliberate
`stallUntil`), `process()` has to zero-fill (audible click) or
hold-last (audible flat-line). `processAdd()` leaves the unfilled tail
alone — the **caller's CPU carrier in those samples survives the GPU
outage**. Audibly: the timbre thins for the stall duration, the
fundamental keeps playing. Same `underflowSamples()` telemetry; the
semantic difference is what `out` looks like during the stall, not
what the counter shows.

The `underflowPolicy` field (`'zero-fill'` / `'hold-last'`) is
IGNORED by `processAdd`. "Leave caller's data alone" is the hybrid
mode's underflow semantics by construction; no per-method override.

#### Why this matters — sizing the latency story

Block-mode `process()` inherits the `mapAsync` latency floor: at
depth D, blockSize B, sample rate R, the worst-case input-to-audible
delay is `D * B / R` (~85 ms at D=4, B=1024, R=48000). For
fundamentals — pitch-defining, ear-localized — that's audible lag.

The hybrid pattern splits responsibilities by latency tolerance:

- **Fundamental** (carrier) stays on the CPU at zero latency. Slider
  events are heard within one quantum (~2.7 ms @ 128 samples).
- **Spectral richness** (residual — upper harmonics, slow LFO
  envelope, granular texture) rides the GPU lane with the block-mode
  floor. The ear can't lock to upper-harmonic envelope phase as
  tightly as to the fundamental's; the residual's lateness is
  inaudible under steady state.

Net: the perceptual latency is the carrier's (sub-quantum), not the
block-mode floor. The 200 ns additive-tax cost of `processAdd` over
`process` (see Bench cell below) is paid once per quantum and is
0.0075% of the audio budget at 48 kHz.

#### Public surface

`BridgeBlockConsumer.processAdd(out: Float32Array, gain?: number, count?: number): void`

- `out` — caller's buffer carrying the carrier. Modified in place:
  `out[i] += gain * samples[cursor + i]`.
- `gain` — multiplier applied to the residual. Default `1.0`. `0.0`
  is a "drain the ring without mixing" path (cursor still advances,
  telemetry still updates, `out` untouched). Non-finite gain throws.
- `count` — samples to mix. Default `out.length`. Must be in
  `[0, out.length]`.

Telemetry parity with `process()`: `framesConsumed()` and
`underflowSamples()` tick identically. The cursor is shared — you can
interleave `process()` and `processAdd()` calls on the same consumer
and the sample stream stays monotonic. (See test pin #21.)

### Why a patch bump, not a minor bump

Per the CLAUDE.md versioning policy and the extended-slowdown rule
landed at 0.9.0: minor bumps are reserved for **wire-format changes**
(new active lanes, frame-size additions, breaking SAB layout shifts)
or **breaking public-API changes** (renamed/removed methods, changed
return types).

`processAdd` is a purely additive heap-side helper on an existing
class. Zero SAB byte change. Zero schema change. The `Bridge<S>`
producer side is unchanged. Existing callers continue to work
unchanged — `processAdd` is opt-in; the default `process()` path is
byte-for-byte identical to 0.9.40. A bridge driven by a
`processAdd`-using consumer is bit-for-bit interoperable with one
driven by `process` directly (the producer cannot tell which method
the consumer calls).

Default `0.9.x` patch.

### Wire compatibility

Zero change. `BridgeBlockConsumer.processAdd` composes the existing
`bridge.pull` + `scratchFrame()` surface; uses the SAB layout exactly
as `BridgeBlockConsumer.process` does. No SAB byte change, no schema
extension, no protocol change, no new ring lanes.

A 0.9.41 bridge interoperates with any 0.7.13–0.9.40 sibling driven
through `BridgeBlockConsumer.process` directly. The producer side
(`BridgeBlockProducer`) is unchanged.

### Demo + benchmark

`examples/hybrid-residual/` — runnable demo of the pattern. CPU
sawtooth carrier at slider freq + GPU-computed harmonic-partial
residual (16 partials, 1/k roll-off, per-partial slow LFO). Three
modes selectable from the UI:

- `hybrid` — carrier first, then `processAdd` (residual sums on top).
  The headline path.
- `replace` — `process()` overwrites with the ring contents. The
  pure block-mode comparator; audibly worse on producer stalls.
- `carrier-only` — carrier alone (no GPU). Reference path.

"Simulate GPU stall (250 ms)" button drops producer ticks; in
hybrid mode the harmonic layer fades out cleanly while the
fundamental keeps going, in replace mode the worklet emits silence
during the stall window (audible click). Run with
`npm run dev:hybrid-residual` (port 5176).

`bench/hybrid-residual/` — programmatic benchmark page. Drives a
controlled stall sequence and reports baseline + stall-window output
RMS for each mode. The **continuity ratio** (stall RMS / baseline
RMS) is the headline result: ~0% for replace mode (zero-fill
collapses RMS), ~95–100% for hybrid mode (carrier survives). Run
with `npm run bench:hybrid-residual` (port 5177).

### Tests

`tests/BridgeBlockConsumer.test.ts` — extended with 8 new pins
(#14–21) for the `processAdd` surface, on top of the 13 existing
`process` pins:

- #14 — additive ramp continuity. Carrier of 100; residual ramp;
  output is `100 + ramp[i]` over 4 frames consumed.
- #15 — gain scaling. `gain = 2.5` produces `2.5 * ramp[i]` from
  zero carrier.
- #16 — hybrid underflow preservation. Sentinel-filled `out`
  survives a full-underflow `processAdd` call untouched.
- #17 — mid-quantum hybrid underflow. Real adds for the head of the
  quantum, carrier preserved for the tail past ring-exhaust
  (distinguishes from zero-fill and hold-last).
- #18 — telemetry parity. `framesConsumed` and `underflowSamples`
  track identically to `process()` on identical traffic.
- #19 — `gain = 0` cursor advance. `out` untouched, cursor still
  advances, telemetry still increments — the "drain without mix"
  semantics.
- #20 — bounds + finite-gain validation. Out-of-range count and
  non-finite gain (NaN, Infinity) throw.
- #21 — `process` / `processAdd` cursor interop. Interleaved calls
  on the same consumer share cursor state; sample stream is
  monotonic across modes.

21 pins total green; the previous 13 are unchanged.

```
$ npm test
... 24 suites, all green
all BridgeBlockConsumer pins green
```

`npm run typecheck` clean. `npm run bench` push / pull / pullLatest
medians within the 10 μs hard budget; trajEval (fast) within the
1.25 μs fast-path budget; flow_scale recovery within the 100-cycle
budget.

### Bench — processAdd hot-path cost

New cell in `bench/Bridge.bench.ts` measures per-quantum cost of
`process` vs `processAdd` over a 1024-sample block / 128-sample
quantum cadence (one pull every 8 calls, mirroring steady-state
audio consumption). Refill cadence: one block push per 8 quanta.

Medians on a Node 22 dev laptop:

```
  process (replace) median=  100 ns  p99=  800 ns
  processAdd g=1    median=  300 ns  p99=  800 ns
  processAdd g≠1    median=  300 ns  p99=  800 ns
  processAdd hybrid tax g=1.0  =   200 ns  (vs process replace)
  processAdd hybrid tax g≠1.0  =   200 ns  (general-gain path)
```

The 200 ns hybrid-mode tax is the cost of the additive inner loop
over the `Float32Array.set` baseline. At 48 kHz the worklet has
~2.67 ms of wall-clock budget per quantum on top of whatever the
carrier loop costs; 200 ns is 0.0075% of that budget. The
`g = 1.0` fast path skips the multiply; the general-gain path is
indistinguishable at the measured precision because the JIT folds
the multiply into a fused-multiply-add. Not gated.

### Documentation

- `src/BridgeBlockConsumer.ts` — file header gains a "Hybrid
  residual-on-carrier mode (0.9.41)" subsection documenting the
  pattern, the latency story, the underflow semantics, and the
  telemetry parity. JSDoc on `processAdd` itself documents the
  underflow-leaves-out-untouched contract and the `gain = 0` and
  `gain = 1` fast-path behaviors.
- `tests/BridgeBlockConsumer.test.ts` — file header pin index
  extended with #14–21.
- `bench/Bridge.bench.ts` — new 0.9.41 cell + main-loop summary.
- `examples/hybrid-residual/` — new demo directory (6 files:
  `schema.js` / `main.js` / `worker.js` / `worklet.js` /
  `index.html` / `serve.mjs`).
- `bench/hybrid-residual/` — new bench page (4 files:
  `main.js` / `index.html` / `serve.mjs` reusing the demo's worker
  + worklet via direct path import).
- `package.json` — `version` bumped to 0.9.41; new `dev:hybrid-residual`
  and `bench:hybrid-residual` scripts.
- `CHANGELOG.md` — this entry.

## [0.9.40] — 2026-05-28

### Added — Standard mode shipped: `MessageChannelBridge<S>` MVP1

The audit-response mini-cohort's headline feature. The 0.9.39 design
note recommended shipping Standard mode at shape (b) "transport-only
parity" + MVP1 scope; this patch lands the implementation directly to
main. The design note's 0.10.0 versioning recommendation is overridden
in favour of a 0.9.40 patch — see "Why a patch bump" below.

#### New class: `MessageChannelBridge<S>`

```ts
import { MessageChannelBridge, defineSchema, u64, f64 } from "webgpu-audio-bridge";

const TelemetrySchema = defineSchema({
  seq: u64(),
  cpuPercent: f64(),
  fps: f64(),
});

const { port1, port2, capacity } = MessageChannelBridge.allocate(16);
// Hand port2 to the consumer thread via worker.postMessage(msg, [port2]).

const producer = new MessageChannelBridge(port1, capacity, TelemetrySchema);
const consumer = new MessageChannelBridge(port2, capacity, TelemetrySchema);

const frame = producer.scratchFrame();
frame.seq = 1n;
frame.cpuPercent = 47.3;
frame.fps = 60;
producer.push(frame);                  // queues for delivery on port2

const out = consumer.scratchFrame();
if (consumer.pull(out)) {              // dequeues the next frame
  // out.seq === 1n, out.cpuPercent === 47.3, out.fps === 60
}
```

Sibling tier to `Bridge<S>`'s Turbo mode. Same schema DSL surface
(`defineSchema({ ... })`, `physicsControlFrameSchema(n)`,
`FrameFor<typeof Schema>` inference). Transport is `MessageChannel` +
transferable `ArrayBuffer` instead of `SharedArrayBuffer` +
`Atomics`. **Does not require cross-origin isolation** — works in
any environment with `globalThis.MessageChannel` (every modern
browser + Node 15+).

#### Public surface (MVP1)

- `class MessageChannelBridge<S extends Schema<FieldsObject, any>>`
- `static MessageChannelBridge.allocate(capacity: number) → MessageChannelBridgeAllocation`
  — constructs a fresh `MessageChannel`; returns `{ port1, port2, capacity }`.
- `constructor(port: MessagePort, capacity: number, schema: S)`
- `scratchFrame(): FrameFor<S>` — reusable frame view, same shape as `Bridge<S>.scratchFrame()`.
- `push(view: FrameFor<S>): boolean` — encodes the frame into a fresh
  `ArrayBuffer`, transfers via `postMessage`. Returns false only if
  the bridge is closed.
- `pull(out: FrameFor<S>): boolean` — dequeues the oldest queued frame
  into `out`. Returns false on empty queue or after close.
- `describeLayout(): SchemaLayoutDescription` — same shape as
  `Bridge<S>.describeLayout()`; JSON-safe for postMessage. The
  `Bridge<S>` ↔ `MessageChannelBridge<S>` describeLayout symmetry is
  pinned by `tests/MessageChannelBridge.test.ts` pin #4.
- `available(): number` — queue depth on the consumer side.
- `pushedCount() / pulledCount() / droppedCount(): number` — diagnostics.
- `close(): void` — idempotent; unsubscribes the handler, closes the
  port, clears the queue.

New exported type: `MessageChannelBridgeAllocation` — frozen
`{ port1: MessagePort, port2: MessagePort, capacity: number }`.

#### Overflow policy: consumer-side drop-oldest (hard-coded for MVP1)

When the consumer's queue is at `capacity` and an incoming frame
would push it past, the OLDEST queued frame is silently evicted and
`droppedCount()` ticks. Same freshness-over-completeness philosophy
that `BridgeGPUSource` applies on the producer side — for a control
bus where the consumer wants the freshest frame, an older
undelivered frame is just garbage in the way.

The producer receives no signal about consumer-side overflow
(MessageChannel has no built-in flow control and MVP1 does not
implement an ack channel). Adopters who care about the drop rate
inspect `droppedCount()` on the consumer side. Adopters who need
lossless delivery should use Turbo mode (`Bridge<S>` with
`policy: 'block'` or `'reject'`).

MVP2 will add producer-side capacity awareness via a lightweight
ack channel; the API surface for that is reserved but unspecified
in MVP1.

#### Deliberately excluded from MVP1

By design, the following `Bridge<S>` features do NOT have
Standard-mode counterparts in 0.9.40:

- **`pullLatest`** / **`pullAll`** — reserved for MVP2.
- **Overflow `policy` option** (`reject` / `drop-newest` / `drop-oldest`
  / `block`) — hard-coded to consumer-side drop-oldest for MVP1;
  user-selectable in MVP2.
- **PLL clock recovery** (`observeConsumerTime` / `phaseLockedTime`) —
  SAB-header-lane concern; no equivalent shape on MessageChannel.
- **Frame smoothing** (`pullSmoothed` / `pullLatestSmoothed`) —
  reserved for MVP3+ if real demand surfaces.
- **Invariant classification** (`.withInvariant(...)` schemas) — uses
  the SAB header's `torn_frame` lane. Schemas built with
  `.withInvariant(...)` are **rejected at construction with a
  `TypeError`** rather than silently losing the invariant bytes.
- **Adaptive flow-scale** (`flowScaleHint` / lane 2) — SAB-header
  concern.
- **`beginPush` / `commitPush`** zero-copy push — meaningless without
  shared memory; every `push` allocates a fresh transferable buffer.

See [`docs/standard-mode-design.md`](./docs/standard-mode-design.md)
§"Deliberately excluded from MVP1" for the per-feature exclusion
rationale and the MVP2 / MVP3 ladder for future ports.

#### `tests/MessageChannelBridge.test.ts` — 9 pins

New standalone tsx test file (~360 LOC), wired into both `npm test`
and `npm run test:unit`. Pins:

1. Construction validation — capacity must be a positive integer;
   `.withInvariant(...)` schemas rejected with `TypeError`.
2. `allocate(capacity)` returns two `MessagePort` instances + the
   capacity in a frozen object.
3. `scratchFrame()` produces the expected shape: scalar fields
   zero-initialized (`0` / `0n`), array fields typed of the right
   kind and length; per-call freshness (each call returns
   independent typed arrays).
4. **`describeLayout()` symmetry with `Bridge<S>.describeLayout()`** —
   field-for-field equality (kind, byteOffset, length) for the same
   schema across both transports. Catches future drift where one
   transport's layout description diverges from the other.
5. All-scalar push/pull round-trip bit-exact — every `FieldKind`
   (u64, i64, u32, i32, u16, i16, u8, i8, f64, f32) round-trips with
   the published bit pattern intact via the transferable ArrayBuffer.
6. Array-field push/pull round-trip bit-exact — typed-array contents
   round-trip via the byte-level copy in `_encodeFrame` / `_decodeFrame`.
7. **Capacity respect under burst** — producer pushes 10 frames into
   a capacity=4 bridge; consumer queue caps at 4; `droppedCount() === 6`;
   the surviving frames are the FRESHEST 4 (sequence numbers 6, 7, 8, 9
   rather than 0, 1, 2, 3). Pins the drop-oldest semantic explicitly.
8. Empty-pull semantics + `available()` accuracy — empty pull returns
   false; available() reports queue depth accurately as pulls drain it.
9. `close()` lifecycle — idempotent; post-close push returns false;
   post-close pull returns false; queued frames cleared.

Total node test suite count: **23 suites green** (up from 22 — the
`MessageChannelBridge.test.ts` script is wired into both `npm test`
and `npm run test:unit`, sequenced after `BridgeWebNNSource.test.ts`
and before `environment.test.ts`).

#### README updates

- **§Two transport tiers** — heading rewritten as "Turbo and Standard
  (both shipped)"; lead paragraph updated to reflect that Standard
  shipped at 0.9.40 as MVP1; per-tier paragraphs revised; the
  "library will never auto-detect" invariant kept and re-stated.
- **§Standard mode quick start** — new subsection with the canonical
  producer / consumer two-port example shown above. Sits inside the
  transport-tier discussion as the first concrete code block adopters
  read after learning the two-tier framing.
- **§Browser support matrix** — Standard mode row flipped from
  "reserved at 0.8.0 — not shipped" to "shipped at 0.9.40";
  accompanying notes paragraph rewritten.
- **§Is this the right tool for your problem?** — the no-COOP/COEP
  decision row updated to point TO `MessageChannelBridge<S>` instead
  of recommending users wait. The other 7 decision rows are unchanged.

#### ROADMAP updates

The "Reserved slot — Standard mode" subsection is retitled as
"Standard mode (`MessageChannelBridge<S>`) — shipped at 0.9.40" with
a status callout documenting the 0.9.40-vs-0.10.0 version override.
The cohort table gains a new 0.9.40 row.

#### `docs/standard-mode-design.md` updates

The status header flips from "design analysis, no commitment to
ship" to "shipped at 0.9.40, MVP1 scope". A new "Shipped postscript"
at the bottom of the file documents:

- The 0.9.40-vs-0.10.0 version-slot override (and its rationale).
- The drop-oldest-vs-ack-channel capacity-model deviation from the
  analysis above.
- The 9-pin-vs-6-pin test count (extras for construction
  validation, empty-pull, close lifecycle).
- The ~930-LOC-actual vs ~1180-LOC-estimate scoping delta.

The design analysis above the postscript is preserved unchanged
as the historical reasoning record.

#### `package.json` updates

- `version` bumped to 0.9.40.
- `description` rewritten to say "Two transport tiers share one
  schema DSL and one frame API" — Standard mode is no longer
  "reserved" in the package metadata.
- `test` + `test:unit` scripts gain `tsx tests/MessageChannelBridge.test.ts`
  in sequence before `tests/environment.test.ts`.

### Why a patch bump, not a minor bump

The 0.9.39 design note recommended shipping Standard mode at 0.10.0
on the grounds that "a new transport with a new public API class is
a minor-bump trigger." Re-reading `CLAUDE.md`'s actual minor-bump
triggers:

> - **Wire-format changes** (new active lanes, frame-size additions, breaking SAB layout shifts).
> - **Public-API breaking changes** (renamed/removed methods, changed return types).
> - **Accumulated patches reaching a coherent "release moment"** worth calling out.

None of those apply. `MessageChannelBridge<S>` is:

- **Wire-format inert** — different transport, but the SAB protocol
  Turbo mode uses is unchanged.
- **Purely additive** — every existing `Bridge<S>` user can `npm
  install webgpu-audio-bridge@0.9.40` without changing a line of
  code. No renames, no removed methods, no changed return types.
- **One feature, not a release-moment cohort** — single class,
  single ship, fits the patch envelope.

The recommendation's reasoning confused "substantial" with
"breaking." Standard mode is substantial — it doubles the project's
transport surface — but every existing surface keeps working
identically. That's the test under semver, and it lands on patch.

The 0.9.x soak cohort continues unchanged. Standard mode is one
more additive-API improvement among the patches accumulating toward
1.0.

### Why

The audit's "ship Standard mode" recommendation was real. The
COOP/COEP burden filters out a nontrivial chunk of potential
adopters (third-party embeds, SaaS-hosted apps, hosted-sandbox
prototyping). For control-plane use cases where 5–50 ms latency is
fine, Standard mode unlocks those audiences without changing how
Turbo mode works for everyone else.

The MVP1 scope cut is conservative on purpose. Shipping `pullLatest`,
overflow policies, and PLL all on day one would have meant two-to-
four times the LOC and four-to-six times the maintenance commitment
for features the audit didn't actually ask for. MVP2 work lands
when real adopter demand surfaces, not speculatively.

### Wire compatibility

**Fully wire-compatible with all existing `Bridge<S>` peers.**
`MessageChannelBridge<S>` is a separate transport — the SAB protocol
that Turbo mode uses is unchanged. A `Bridge<S>` peer and a
`MessageChannelBridge<S>` peer cannot directly interoperate
(different transports), but neither does any change in 0.9.40 affect
an existing `Bridge<S>` ↔ `Bridge<S>` SAB session.

### Tests

23 Node suites green:

```
schema / Bridge.core / Bridge.smoother / Bridge.invariant / Bridge.pll /
Bridge.trajectory / Bridge.backpressure / Bridge.observability /
Bridge.facades / Bridge.properties / Bridge.recovery / BridgeFacades /
BridgeInputLane / BridgeBlockConsumer / BridgeGPUSource.writeTarget /
BridgeWebNNSource / MessageChannelBridge / environment /
Bridge.phaseLock / Bridge.wasmEquivalence / Bridge.concurrent /
typecheck-deprecations / readme-imports
```

`npm run typecheck` clean. `npm run bench` push / pull / pullLatest
medians within the documented 10 μs hard budget; trajEval (fast)
within the 1.25 μs fast-path budget; flow_scale recovery within the
100-cycle budget.

### Documentation

- `src/MessageChannelBridge.ts` — new file, ~390 LOC, ships the class.
- `src/index.ts` — new export block for `MessageChannelBridge` +
  `MessageChannelBridgeAllocation`.
- `tests/MessageChannelBridge.test.ts` — new file, ~360 LOC, 9 pins.
- `README.md` — `### Two transport tiers` rewritten; new
  `#### Standard mode quick start` subsection; browser-support
  matrix Standard row flipped; decision-table no-COOP/COEP row
  flipped.
- `ROADMAP.md` — "Reserved slot" subsection retitled "shipped at
  0.9.40" with the 0.9.40-vs-0.10.0 override rationale callout. New
  0.9.40 row in the cohort table.
- `docs/standard-mode-design.md` — status header flipped to
  "shipped at 0.9.40"; new "Shipped postscript" subsection covering
  the version-slot, capacity-model, test-count, and LOC deviations
  from the analysis. The analysis itself is preserved unchanged.
- `package.json` — `version` bumped; `description` updated to drop
  the "reserved for 0.8.0" framing; `test` + `test:unit` scripts
  wire in the new test file.
- `CITATION.cff` — `version` bumped to 0.9.40; date 2026-05-28.
- `CHANGELOG.md` — this entry.

## [0.9.39] — 2026-05-27

### Added — Standard mode (`MessageChannelBridge<S>`) design note (0.9.x soak)

Fourth patch in the audit-response mini-cohort. Documentation-only;
zero runtime surface change. Lands task #11 from the in-flight
audit-response task list as a **design note**, not an implementation.

#### New `docs/standard-mode-design.md`

Substantial design analysis (~5-7 pages) covering the audit's
"ship Standard mode" recommendation. Walks the decision space
across three independent axes:

1. **API shape**: full feature parity (shape a) / transport-only
   parity (shape b) / separate-name adapter (shape c). Each option
   gets a pro/con table and an LOC/effort estimate.

2. **Versioning slot**: retroactively fill 0.8.0 / ship as 0.10.0 /
   ship as a 0.9.x patch. The 0.8.0 reservation in ROADMAP turned
   out to be historically odd — the cohort jumped from 0.7.17 to
   0.8.1 with no 0.8.0 release ever on npm — and the note
   recommends retiring the reserved slot in favour of 0.10.0.

3. **MVP scope**: MVP1 (push/pull/scratchFrame only) vs MVP2
   (adds pullLatest + policies + telemetry) vs Full transport
   parity. Each scoped with concrete LOC + effort estimates for
   a single-maintainer project.

The note ends with:

- **Concrete implementation cost** (file list with LOC estimates;
  ~1180 LOC total for shape (b) MVP1 ship).
- **Decision criteria** the maintainer should answer before
  committing (real adopter vs speculative; willingness to
  maintain two transports; 1.0 stability promise scope).
- **Recommendation**: shape (b) "transport-only parity" at MVP1
  scope, versioned as 0.10.0.
- **Alternative recommendation** for "don't ship": dated honest
  deferral notice in ROADMAP, leave environment-helper scaffolding
  in place.
- **Explicit non-goals** (not audio rate, not Turbo replacement,
  not auto-detection, not a port of every Bridge feature).
- **Open questions** (main entry vs subpath, BridgeBlockProducer
  interaction, scratch-frame vs per-call ArrayBuffer allocation,
  CI test placement).
- **Next-steps playbook** for both the ship and don't-ship paths.

The note's framing: this is options + recommendation, decision
deferred to the maintainer. The deliverable is the analysis, not a
commit to ship. The worst outcome is shipping Standard mode
under-baked because an auditor said to; the second-worst is leaving
the ROADMAP's reserved-slot promise dangling indefinitely. Either
path is honest if chosen deliberately.

#### `ROADMAP.md` reserved-slot subsection rewritten

The "Reserved slot — 0.8.0 (MessageChannelBridge)" subsection at
line 81 was outdated: it framed Standard mode as "the minor-bump
anchor that ships whenever ready" without acknowledging that the
0.8.0 slot is now historically odd. Rewritten as "Reserved slot —
Standard mode (`MessageChannelBridge<S>`)" with a callout
referencing the new design note and the slot's decision-pending
status. Adopters who want Standard mode built are invited to add
their voice to the GitHub issue tracker.

#### `README.md` transport-tier paragraph updated

The "Standard mode (reserved at 0.8.0 — `MessageChannelBridge<S>`)"
paragraph in the `### Two transport tiers` section now links to
the design note alongside the ROADMAP reference. Adopters reading
the README's transport-tier section can follow the link to the
full analysis without needing to dig through commit history.

### Why

The audit's "ship Standard mode" recommendation was real — the
COOP/COEP burden does filter out a nontrivial chunk of potential
adopters. But "ship Standard mode" is three independent decisions
(API shape, versioning slot, scope cut) with multiplicative cost
differences, and the wrong combination would land somewhere
between "double the maintenance burden" and "fork the project's
release line in half." A design note that lays out the trade-offs
and recommends a concrete path is the right first deliverable,
not a hasty implementation that has to be walked back later.

The design note is also a forward-looking artifact: if the
maintainer chooses to ship at any point in the next year, the note
serves as the implementation spec; if they choose not to, the note
explains the deferral honestly. Either way it removes the
"unspecified future ship" ambiguity that the audit flagged.

### Wire compatibility

None affected. Documentation only — new design-note file +
README/ROADMAP prose updates. No SAB protocol change, no schema
DSL change, no public-API change.

### Tests

22 Node suites green. `npm run typecheck` clean. `npm run bench`
within all documented budgets. The `tests/readme-imports.test.ts`
drift gate still holds — none of the README import blocks were
touched.

### Documentation

- `docs/standard-mode-design.md` — **new file**, ~500 lines.
  Design space analysis with options, recommendation, decision
  criteria, implementation cost estimate, non-goals, open
  questions, next-steps playbook.
- `ROADMAP.md` — `Reserved slot — 0.8.0 (MessageChannelBridge)`
  subsection rewritten as `Reserved slot — Standard mode
  (MessageChannelBridge<S>)` with a status callout linking the
  design note. New 0.9.39 row in the cohort table.
- `README.md` — Standard-mode paragraph in `### Two transport
  tiers` updated to link the design note alongside the ROADMAP
  reference.
- `CITATION.cff` — `version` bumped to 0.9.39.
- `package.json` — `version` bumped to 0.9.39.
- `CHANGELOG.md` — this entry.

## [0.9.38] — 2026-05-27

### Added — Maintenance & operational status section (0.9.x soak)

Third patch in the audit-response mini-cohort. Documentation-only;
zero runtime surface change. Lands task #10 from the in-flight
audit-response task list — the "Maintenance & scope" disclaimer that
addresses the audit's bus-factor concern head-on.

#### New `## Maintenance & operational status` README section

Sits between `## Prior art` and `## Acknowledgments`. Five
subsections:

1. **Bus factor** — names it openly (= 1, single primary maintainer,
   no organization backing). The "Ephemera contributors" entry in
   `CITATION.cff` is clarified as informal-credit, not a co-maintainer
   commitment. Frames the risk as real and worth factoring into an
   adoption decision rather than dressing it up.

2. **Scope discipline — what this library deliberately won't grow
   into.** Six bulleted non-goals (synthesis engine, scheduling layer,
   audio-graph abstraction, auto-detection between transports,
   general-purpose IPC, WebGPU framework) with cross-links where an
   alternative is the right answer. The narrower the surface, the
   smaller the maintenance burden — this is the bus-factor mitigation
   that does the most work.

3. **Hand-off readiness — what makes this library pickup-able by a
   stranger.** Six concrete artifacts that exist specifically for
   forkability: header comment blocks on every public method,
   22 test suites with numbered pins, the 1M-frame concurrent SPSC
   stress test, cross-engine Playwright CI, the bench regression
   budget, zero runtime dependencies, MIT license. Each is a
   sentence with a file pointer.

4. **What "abandoned" actually looks like for this library.** Honest
   account of the failure mode: published versions on npm/Zenodo
   keep working (SAB+Atomics+AudioWorklet are stable platform
   features); browser-support matrix is the most-likely-to-drift
   surface; no new features land; CVE-class bugs become the real
   adoption risk. Closes with "this is not a comforting story; it
   is the actual story."

5. **Contributing** — moved into the new section (was absent from
   the README before; previously only in `ROADMAP.md`). Names the
   bar for landing changes: test pins, wire-compat notes, bench-gate
   respect, versioning policy. Links to `CLAUDE.md` for the full
   commit/test/release-cadence playbook.

The existing Status & maturity bullet at the top of the README
(formerly a paragraph-length single line covering all of this)
shrinks to a one-liner: "single primary maintainer (bus factor = 1,
named honestly); see §Maintenance & operational status for the
full treatment." Keeps the title-page Status block scannable while
the substantive treatment lives where readers go when they want it.

### Why

The audit flagged bus factor as one of three "high-impact" project
risks (alongside versioning incoherence and stale browser docs — both
addressed in 0.9.36). The honest response is not to hide the risk
but to (a) name it openly and (b) document the mitigations
explicitly. An evaluator who reads this section now has a clear
picture of *what they're actually adopting* — not a polished
single-maintainer-as-team posture.

The "what abandoned looks like" subsection in particular is the
piece that's hard to write but most useful. Most open-source
libraries with bus factor 1 don't write this out; the audit's
implicit complaint is that the reader has to guess. Now they don't.

### Wire compatibility

None affected. Documentation only. No SAB protocol change, no schema
DSL change, no public-API change.

### Tests

22 Node suites green. `npm run typecheck` clean. `npm run bench`
within all documented budgets. The `tests/readme-imports.test.ts`
drift gate still holds — none of the README import blocks were
touched.

### Documentation

- `README.md` — new `## Maintenance & operational status` section
  (~110 lines) between Prior art and Acknowledgments. Status &
  maturity bullet at line 15 shortened to a one-liner pointing at
  the new section. Net +1 H2.
- `CITATION.cff` — `version` bumped to 0.9.38.
- `package.json` — `version` bumped to 0.9.38.
- `CHANGELOG.md` — this entry.
- `ROADMAP.md` — 0.9.38 row added to the cohort table.

## [0.9.37] — 2026-05-27

### Added — README readability for LLM-skim audits (0.9.x soak)

Second patch in the audit-response mini-cohort. Documentation-only;
no runtime surface change. Lands tasks #2, #3, #4, #6 from the
in-flight audit-response task list.

#### Status & maturity preamble (task #3 + #2)

New `### Status & maturity` section directly under the README's
title-and-tagline block, before the architecture diagram. Five
bulleted lines that a 30-second skim picks up:

- Current version + ROADMAP link + "pre-1.0 is deliberate policy"
  framing.
- Test posture: 22 Node suites + cross-engine Playwright (Chromium /
  Firefox / WebKit) gating CI.
- Distribution: npm + Zenodo concept DOI + MIT + zero runtime deps.
- **Release artifacts policy (task #2)**: per-patch history lives in
  `CHANGELOG.md`; GitHub Releases tab is intentionally sparse (only
  v0.1.x foundation releases were tagged there). Cite via npm version
  or Zenodo version DOI. This is the doc-only resolution of task #2 —
  the audit's "v0.1.0/v0.1.1 only on GitHub Releases" gripe; rather
  than back-tagging ~30 historical releases (lossy and expensive at
  this point), the policy is now explicit and the absence is
  intentional rather than a hygiene gap.
- Maintainership: single primary maintainer; contributions welcome;
  bus-factor mitigations (header comments, test pins, MIT + zero
  deps, forking is `git clone` away) named explicitly. This is partial
  prep for task #10 (full bus-factor disclaimer) which lands later.

Goal: an LLM auditor or human evaluator who reads the first screen of
the README now has an accurate picture of project maturity without
needing to triangulate across `ROADMAP.md` / `CITATION.cff` /
`CHANGELOG.md` / the GitHub Releases tab.

#### Front-loaded "Is this the right tool" decision table (task #4)

Existing use-case fitness table at the bottom of the BridgeGPUSource
section (line ~810) is excellent but buried 800+ lines deep. New
`### Is this the right tool for your problem?` subsection sits in
`## The problem this solves`, right before the transport-tier
discussion, with an 8-row decision table:

- **TOWARD this library**: GPU/worker control bus into AudioWorklet.
- **AWAY**: raw f32 streams → ringbuf.js; custom DSP → Emscripten /
  Faust; musical sequencing → Tone.js; AudioParam-expressible
  automation → native Web Audio; pro-audio tracking → fast-lane
  pattern (in-repo) or different stack; direct GPU → audio synthesis →
  not viable in browsers today; broadest deployment with no
  COOP/COEP → wait for Standard mode (0.8.0).

Every "AWAY" row links to the actual alternative project so an
auditor reading the table can verify the recommendation rather than
having to invent one. This pre-empts the LLM-audit failure mode where
the auditor synthesizes a comparison the library never offered.

#### BridgeGPUSource drop-on-full as deliberate freshness policy (task #6)

New `### Overload policy: freshness over completeness` subsection in
the BridgeGPUSource documentation, between `### The honest pitch` and
`### Lifecycle`. Names the design choice explicitly:

> `BridgeGPUSource` is a **freshness-first** helper, not a lossless
> transport. When the bridge is full at `pollCompleted()` time, the
> helper drops the decoded frame.

Three-row comparison table walks through the alternatives we
explicitly don't take (block-the-producer / queue-overflow /
crash-on-overflow) and why each is the wrong shape for a control bus
into a real-time audio thread. Closes with an escape hatch: "If your
use case demands lossless delivery, here are the three things to do
instead" (switch the `Bridge` `policy`; use `BridgeBlockProducer`;
or don't use this library — link back to the decision table).

The existing `### Overflow policies (0.6.12)` section also gains a
short blockquote noting that `BridgeGPUSource`'s drop step runs
**before** the bridge `policy` fires, with a cross-link to the new
subsection.

### Why

The first audit-response patch (0.9.36) was hygiene: CITATION + browser
matrix + transport-tier narrative — the bare-minimum facts an auditor
hits in the first 30 seconds. This patch is the next layer up:
information *architecture* — making the README readable in the order an
auditor or evaluator naturally consumes it. The "what / for whom / when
not / what would I use instead" questions now have answers at the front
of the document, not the back.

### Wire compatibility

None affected. Documentation, version metadata only. No SAB protocol
change, no schema DSL change, no public-API change.

### Tests

22 Node suites green. `npm run typecheck` clean. `npm run bench`
push / pull / pullLatest medians within the 10 μs hard budget. The
`tests/readme-imports.test.ts` drift gate still holds — none of the
README import blocks were touched.

### Documentation

- `README.md` — three new subsections (`### Status & maturity`,
  `### Is this the right tool for your problem?`,
  `### Overload policy: freshness over completeness`) and a
  cross-link blockquote in `### Overflow policies (0.6.12)`. Net
  +1 H3 on the title page, +1 H3 in `## The problem this solves`,
  +1 H3 in `## BridgeGPUSource`.
- `CITATION.cff` — `version` bumped to 0.9.37.
- `package.json` — `version` bumped to 0.9.37.
- `CHANGELOG.md` — this entry.
- `ROADMAP.md` — 0.9.37 row added to the cohort table.

## [0.9.36] — 2026-05-27

### Added — Audit-response hygiene patch (0.9.x soak)

Documentation-only patch responding to a third-party LLM audit that
flagged three real concerns: a stale `CITATION.cff` version field, a
browser-support matrix that hadn't tracked WebGPU's stable rollout into
Firefox and Safari, and a "Two transport tiers (0.7.0)" section
heading that conflated the 0.7.0 framing-pivot release with the 0.8.0
reserved Standard-mode ship date. None of the runtime surface changes;
this is the first patch in a doc-hygiene mini-cohort surfaced as
tasks #1, #5, #9 in the audit-response task list.

#### `CITATION.cff` version reconciliation

`version` was pinned at `0.7.0` with `date-released: 2026-05-26` — both
stale by ~30 patches. A skim auditor reading the file alongside the
ROADMAP (which references `0.9.31` / `0.9.32` / `0.9.33` / `0.9.35`)
naturally concludes the project's release artifact story is incoherent.
The field now reads `0.9.36` / `2026-05-27`, matching `package.json`.
Two `"TBD"`-DOI entries for v0.3.0 and v0.7.0 (which never landed at
Zenodo) were removed; the file now lists only the concept DOI plus the
two confirmed v0.1.x version DOIs.

#### Browser-support matrix refresh

WebGPU became Baseline in January 2026 — the README still described
Firefox as "Nightly behind `dom.webgpu.enabled`" and Safari as "18.0+ /
16.4–17.x Technology Preview", both stale. The matrix now reflects the
actual rollout:

- **Chrome / Edge** — stable since 113; **Android since Chrome 148**.
- **Firefox 141+** — stable on Windows.
- **Firefox 145+** — stable on macOS Apple Silicon (macOS Tahoe 26+).
- **Firefox Linux / Android** — still landing; CPU fallback remains
  the documented path for now.
- **Safari 26.0+** — stable on macOS Tahoe 26, iOS 26, iPadOS 26,
  visionOS 26.

The matrix also gained a "last verified" date and a citation footnote
pointing at [caniuse/webgpu](https://caniuse.com/webgpu) + the
[WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
post so the next refresh has a starting cite. The note row for
Standard mode was rewritten to make it unambiguous that it's the
**target** compatibility for a not-yet-shipped tier.

#### Transport-tier narrative untangling

The README's `### Two transport tiers (0.7.0)` heading was the
loudest source of "is Standard mode shipped or not?" confusion: the
parenthetical `(0.7.0)` reads as "shipped at 0.7.0", but the body
text said Standard was "reserved at 0.8.0". Rewritten as:

> Two transport tiers — Turbo (shipped) and Standard (reserved at 0.8.0)
>
> The 0.7.0 release was a **framing pivot**, not a feature ship:
> it introduced the two-tier transport-name model that this section
> describes. As of the 0.9.x soak cohort, only one tier has actually
> shipped — Turbo mode. Standard mode is the deliberate second-tier
> sibling, reserved for the 0.8.0 minor bump, and has not landed yet.

The package.json `description` field carried the same ambiguity (it
read "Standard mode (MessageChannel, 5-50ms — 0.8.x)") and was
rewritten to explicitly say "is reserved for 0.8.0".

### Why

The 0.9.x soak is in the deliberate "polish toward 1.0" phase — the
20% of work that buys 80% of perceived maturity. LLM-driven audits of
the repo will keep happening, and each one represents a real evaluator
forming an "adopt or avoid" opinion in minutes. The three flagged
issues are all artifacts that an evaluator hits in the first 30
seconds of skimming. Fixing them is cheap; the cost of leaving them is
that the project keeps getting downgraded on hygiene rather than
substance.

This patch is the cheap-fix component of a broader audit-response
plan (12 tasks total — see the in-flight task list). The other nine
are larger doc reshapes that land in subsequent 0.9.3x patches.

### Wire compatibility

None affected. Documentation, version metadata, and `package.json`
description-string changes only. No SAB protocol change, no schema
DSL change, no public-API change.

### Tests

22 Node suites green. `npm run typecheck` clean. `npm run bench` push
/ pull / pullLatest median sanity-check against the 0.6.x baseline
(~1.20 μs at N=1000) unchanged. No new pins required — this patch
adds zero runtime surface.

### Documentation

- `README.md` — `Browser support matrix` table + notes rewritten;
  `Two transport tiers (0.7.0)` heading + paragraph rewritten.
- `CITATION.cff` — `version` / `date-released` bumped; stale TBD DOI
  identifiers removed.
- `package.json` — `description` rewritten to remove the 0.7.0/0.8.x
  conflation; `version` bumped to 0.9.36.
- `CHANGELOG.md` — this entry.
- `ROADMAP.md` — 0.9.36 row added to the cohort table.

## [0.9.35] — 2026-05-27

### Added — `BridgeConsumer.telemetry()` symmetry with `Bridge<S>.telemetry()` (0.9.x soak)

Closes the composable-surface telemetry gap. `Bridge<S>` has had
`telemetry()` returning a frozen `TelemetrySnapshot` since 0.6.13;
`BridgeConsumer<S>` (the composable equivalent) was missing the method
entirely. Composable-API users had to either hold their own
`ConsumerClockRecovery` reference and read its getters piecemeal, or
construct a separate `Bridge<S>` over the same SAB just for telemetry.
Neither was a great pre-1.0 shape.

#### `BridgeConsumer.telemetry()`

```ts
telemetry(): TelemetrySnapshot
```

Returns the same `TelemetrySnapshot` shape `Bridge<S>.telemetry()`
returns — same field set, same types, same semantics. Ring-side
fields delegate to the composed `SpscRing` (`tornFrames`,
`flowScale`, `available`, `capacity`, `writeIndex`, `readIndex`,
`policy`, `droppedFrames`, `pushedFrames`, `pulledFrames`,
`skippedFrames`, `lastFullWaitNs`, `lastEmptyWaitNs`,
`maxOccupancyEverSeen`). PLL-side fields delegate to the composed
`ConsumerClockRecovery` (`pllLocked`, `pllOffsetNs`,
`pllOutliersRejected`, `pllDriftPpm`, `stallRecoveries`), or report
`false` / `0` when the consumer was constructed with `pll: null`.

The snapshot is `Object.freeze`d and safe to retain. Subscribing
dashboards see the same shape on a `BridgeConsumer` as they would on
a `Bridge<S>` over identical traffic.

#### `BridgeConsumer._softFrames` counter

Pre-0.9.35, `BridgeConsumer`'s `_invariantHandleRaw` and
`_invariantHandleSmoothed` ran the soft branch but did NOT increment
any counter — so `Bridge<S>._softFrames` and a hypothetical
`BridgeConsumer.softFrames` would have diverged. The patch adds a
`private _softFrames: number = 0` field on `BridgeConsumer` that
increments on every soft-classified invariant deviation, mirroring
`Bridge._softFrames` exactly. The `facade-telemetry-symmetry` pin
asserts the two values match field-for-field through a soft-corruption
sequence.

#### Symmetry pin

`tests/BridgeFacades.test.ts` grows from 4 pins to 5. The new
`facade-telemetry-symmetry` pin builds:

1. **Phase A** — no-invariant schema. Two SABs of identical shape
   driven through identical pushes + raw pulls + smoothed pulls + PLL
   observations. Compares `Bridge.telemetry()` and
   `BridgeConsumer.telemetry()` field-for-field via
   `Object.keys(refSnap)` iteration — additive future fields get
   covered automatically.
2. **Phase B** — invariant schema. Pushes a frame, mutates the SAB
   slot's `vEff[0]` from 10 to 11 (relative deviation 21/3000 ≈
   0.7% — well past the 0.1% ok threshold, well under the 100%
   hard threshold, so soft). Both `Bridge._softFrames` and
   `BridgeConsumer._softFrames` tick to 1. Then mutates a different
   slot's `vEff[0]` to 99999 (hard) and asserts both `tornFrames`
   tick to 1 while `softFrames` stays at 1.
3. **Phase C** — `pll: null` opt-out. Constructs a `BridgeConsumer`
   without a PLL and asserts `telemetry().pllLocked === false`,
   `pllOffsetNs === 0`, `pllOutliersRejected === 0`, `pllDriftPpm ===
   0`, `stallRecoveries === 0`. Ring-side fields still populate.

The Phase A field-for-field loop is the load-bearing assertion. The
sanity floor (`pushedFrames === 10`, `pulledFrames === 3`) catches the
trivial-zero case where both snapshots happen to be empty.

### Why

Two motivations:

1. **Composable-API parity is a 1.0 contract concern.** Pre-1.0 is the
   right window to close asymmetries between `Bridge<S>` and the
   composable surfaces (`BridgeProducer` / `BridgeConsumer`). The
   composable shape's whole value proposition is "you can build the
   same thing yourself"; the moment a method exists on `Bridge<S>` but
   not on the composable equivalent, that promise breaks.
2. **Soft-frame counting was a latent invariant gap.** The
   `_softFrames` counter on `BridgeConsumer` was never wired — only
   surfaced by the absence of `telemetry()`. Adding `telemetry()`
   forced the audit; `_softFrames` lands as part of the same patch.

The discovery came out of 0.9.34's test-writing session: the recovery
test for the 5-second frame famine pin needed PLL state inspection
on a `BridgeConsumer`, and the missing `telemetry()` forced a local
PLL-reference hack documented in the test's pin 3 comment. 0.9.35 is
the patch that removes the need for that hack.

### Wire compatibility

**100% wire-compatible.** No SAB byte layout change, no schema-DSL
extension, no protocol change. `Bridge<S>` is untouched. `BridgeConsumer`
gains a method + a private field; the public API addition is purely
additive.

### Tests

`tests/BridgeFacades.test.ts` grows from 4 pins to 5 — the
suite-count stays at 22 (`facade-telemetry-symmetry` is a sub-pin
inside the existing `BridgeFacades.test.ts` file). All other 21 Node
suites unaffected. `tests/Bridge.observability.test.ts`'s
`telemetry-snapshot` pin (which asserts the `Bridge<S>` snapshot
shape) is now also indirectly the shape-anchor for `BridgeConsumer`:
any field added there must also land on `BridgeConsumer` to keep the
symmetry pin green.

### Bench

Unaffected. `telemetry()` is heap-side observability, off the hot
loop.

### Documentation

- `src/BridgeConsumer.ts` — file header gains a "Telemetry (0.9.35)"
  paragraph; `telemetry()` method gets a ~25-line docstring; the
  new `_softFrames` field carries an inline doc.
- `README.md` — §Composable primitives gains a paragraph describing
  `BridgeConsumer.telemetry()`'s symmetry with `Bridge<S>.telemetry()`
  and the `pll: null` zero-fill behavior.
- `ROADMAP.md` — 0.9.35 row added to the cohort table.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/BridgeConsumer.ts` — `telemetry()` method added (~30 LOC
  including docstring); `_softFrames` field added + wired into the
  two invariant handlers; `TelemetrySnapshot` type re-exported from
  `./Bridge.js`; file header expanded.
- `tests/BridgeFacades.test.ts` — new `testTelemetrySnapshotSymmetry`
  pin (~155 LOC) with three phases; main() wires it in.
- `README.md` — §Composable primitives paragraph added.
- `package.json` — version `0.9.34` → `0.9.35`.
- `ROADMAP.md` — 0.9.35 row.
- `CHANGELOG.md` — this entry.

## [0.9.34] — 2026-05-27

### Added — worklet error-recovery test pins (0.9.x soak)

New test file `tests/Bridge.recovery.test.ts` (~330 LOC) covering
three failure modes the audio thread can hit in production. The
pins are pure observation — they don't change any source — but
encode invariants the library has been relying on without explicit
documentation: empty-pull behavior on a stalled producer,
SAB-state survival across a consumer crash, and PLL drift /
smoother prev resilience across a multi-second frame famine.

The pin numbers (1 / 2 / 3 inside the file) are local to the
recovery suite; numbered to keep the format consistent with the
other 0.8.5-split feature files.

#### Pin 1 — producer disappears mid-stream

The consumer keeps polling via `pullLatest` + `pullLatestSmoothed`
and gets clean `-1` returns for 200 empty quanta (400 total empty
pulls). Asserts:

- No exceptions across the empty-pull window.
- `tornFrames` / `softFrames` counters do not move (no payload
  ever materialises, so the invariant classifier never runs).
- `pllOffsetNs` is unchanged across the famine — the PLL only
  updates on explicit `observeConsumerTime` calls; no
  observations → no estimate drift.
- The smoother's `prev` frame is preserved. The pin verifies this
  by pushing a single fresh frame with a distinct `vMax`,
  pulling with `α = 0`, and asserting the output's `vMax` equals
  the pre-famine prev's `vMax` (the prev wins the blend).

#### Pin 2 — consumer crashes mid-quantum, SAB state survives

The AudioWorklet's `process()` throwing is fatal to that worklet
— the browser shuts down the audio thread. But the SAB owned by
the Bridge is process-owned, not worklet-owned. Pin asserts the
crash-and-reattach pattern:

1. Producer pushes 10 frames into the bridge.
2. Consumer A pulls 3 via `pull`, 1 via `pullSmoothed`, then
   seeds smoother + PLL via local calls. SAB-side: 4 frames
   consumed, 6 unread.
3. Consumer A's reference is dropped (simulating worklet death).
4. Consumer B attaches a fresh `Bridge<S>` over the same SAB.
   Its `available()` reports `6` — the SAB cursors survived.
5. Consumer B drains the remaining 6 frames; their `seq` values
   are 5..10 in FIFO order.
6. Consumer B's heap-only state (smoother prev, PLL offset) is
   fresh — `pllLocked === false`, `pllOffsetNs === 0` — confirming
   that crash-induced heap loss is the documented cost.

This pin formalises the "SAB is the wire; heap is local" boundary
the library has been relying on; the BridgeWebNNSource +
BridgeGPUSource adapters all assume the same crash-safety property.

#### Pin 3 — 5-second frame famine, PLL drift + smoother survive

A drift-estimator-enabled `BridgeConsumer` is trained on 200
observations at ~60 Hz with a 100-ppm producer↔consumer skew.
After lock (drift estimate within 10 ppm of truth), a 5-second
famine — no observations, no pushes, no pulls. Pin asserts:

- `phaseLockedTime(consumerNsAtFamineEnd)` is finite (not
  NaN/Inf) AND within 5 ms of truth. The drift estimator
  extrapolates the offset across the gap; truth-vs-estimate is
  bounded by the ppm difference between the converged estimate
  and the true drift rate.
- The post-famine recovery observation (at the consistent skew)
  is admitted by the outlier gate. At most one rejection
  permitted across the recovery.
- Post-recovery `offsetNs` + `driftPpm` are both finite; drift
  estimate still tracks truth within 50 ppm.
- The smoother's `prev` frame is heap-state, retained across the
  famine. A post-famine pull with `α = 0` against a fresh frame
  yields the pre-famine vMax — the prev still wins the blend.

`BridgeConsumer` doesn't expose `telemetry()`, so PLL inspection
in the pin goes through a local `pll` reference passed to the
constructor and read directly. This documents the BridgeConsumer
inspection pattern alongside the wire-state assertion.

### Why

Two motivations:

1. **Document failure modes that have been silent invariants.**
   Through 0.9.33 the library's behavior on empty pulls, consumer
   crash, and frame famine has been implementation-defined: it
   works, but nothing pinned it. Pre-1.0 is the right moment to
   make those invariants part of the regression backstop so a
   future refactor that breaks them fails in CI rather than in a
   shipped consumer.
2. **Set up 0.9.35's e2e audio spec.** The Playwright
   `tests/browser/audio-output.spec.ts` planned for 0.9.35 needs
   confidence that the Node-side bridge invariants are pinned —
   otherwise a browser-side regression could be mistaken for an
   audio-output bug. With these pins in place, a future failure
   in the e2e spec is unambiguously a worklet / browser-stack
   issue, not a bridge protocol issue.

The Node-as-simulator approach is intentional: a real
AudioWorklet `process()` throw is fatal to the worklet and
unobservable from outside the audio thread. What we own is the
SAB protocol invariant, which is testable from a single-threaded
Node script — and that's where the failure modes land.

### Wire compatibility

**100% wire-compatible.** New test file only. No source
change, no public API change, no schema-DSL extension.

### Tests

21 → 22 Node suites. The new file is wired into the `test` +
`test:unit` scripts after `Bridge.properties.test.ts` and before
`BridgeFacades.test.ts` to keep the `Bridge.*` family
contiguous.

### Bench

Unaffected.

### Documentation

- `tests/Bridge.recovery.test.ts` — new file with ~50-line
  header docstring describing the three pins and their
  rationale.
- `ROADMAP.md` — 0.9.34 row added to the cohort table.
- `CHANGELOG.md` — this entry.

### Patch surface

- `tests/Bridge.recovery.test.ts` — new file (~330 LOC).
- `package.json` — wire into `test` + `test:unit` scripts;
  version `0.9.33` → `0.9.34`.
- `ROADMAP.md` — 0.9.34 row.
- `CHANGELOG.md` — this entry.

## [0.9.33] — 2026-05-27

### Added — browser CI matrix gating: Chromium + Firefox + WebKit (0.9.x soak)

The Playwright smoke that's been running Chromium-only and
non-gating (`continue-on-error: true`) since the workflow first
landed is now a real gate across the three Playwright-bundled
engines. `.github/workflows/browser.yml` runs a matrix
`browser: [chromium, firefox, webkit]` with `fail-fast: false`;
each slot installs only its own browser, runs the smoke with
`--project=<browser>`, and uploads a uniquely-named Playwright
report on failure. `continue-on-error: true` is gone — a smoke
regression in any engine fails the merge.

#### Workflow shape

```yaml
strategy:
  fail-fast: false
  matrix:
    browser: [chromium, firefox, webkit]
steps:
  - run: npx playwright install --with-deps ${{ matrix.browser }}
  - run: npm run test:browser -- --project=${{ matrix.browser }}
```

`fail-fast: false` is the deliberate choice — a Firefox-only
regression shouldn't mask a separate Chromium regression in the
same PR. Each engine's failure surface is independently visible.

#### Playwright config shape

`tests/browser/playwright.config.ts` ships three projects (was one).
Each project carries only the autoplay configuration its engine
recognizes:

- **chromium** — `launchOptions.args: ['--autoplay-policy=no-user-gesture-required']`
  (the prior config's top-level setting, scoped per-project).
- **firefox** — `launchOptions.firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }`
  (Firefox autoplay control lives in prefs, not CLI args).
- **webkit** — no autoplay launch option (WebKit has no
  autoplay-override knob analogous to Chromium's; real user
  gestures unlock playback, and the spec's `#start` click is one).

The top-level `use` block no longer carries `launchOptions` — the
defensive autoplay flag previously applied globally was
Chromium-shaped and would have been an unrecognized arg on
Firefox / WebKit. Per-project scoping fixes that.

#### Why this works cross-browser

The two browser specs (`tests/browser/minimal.spec.ts` +
`tests/browser/latency.spec.ts`) were already written to be
portable:

- They don't depend on WebGPU — both specs force / accept the
  CPU fallback path (`#backend=cpu` in latency, "either backend
  ok" in minimal). Linux headless WebGPU varies across engines
  and isn't the load-bearing concern.
- They use `crossOriginIsolated` + `SharedArrayBuffer` only, which
  all three engines support under COOP/COEP since the matrix's
  documented floor (Chrome 113 / Firefox 113 / Safari 16.4).
- They drive the `#start` button with `page.click(...)`, which is
  a real user gesture by Playwright's semantics — that's what
  WebKit needs to unlock AudioContext autoplay.

### Why

Two intersecting motivations:

1. **The audit's punch-list item #5.** The 0.8.7 design audit
   flagged `continue-on-error: true` on `browser.yml` as a real
   gap: the matrix was running but its outcome wasn't gating
   merges. The cohort plan slotted "remove continue-on-error +
   expand matrix" together because expanding without gating
   compounds the problem (more engines that aren't actually being
   enforced). 0.9.33 closes both halves.
2. **0.9.35 needs this.** The planned end-to-end audio Playwright
   spec (e2e audio fingerprint match on `examples/minimal/`)
   lands as a new spec under `tests/browser/`. That spec is only
   useful if its outcome gates merges across the three engines —
   shipping it under a non-gating matrix would be a regression
   from the value of the existing specs. 0.9.33 is the
   foundation; 0.9.35 builds on it.

The decision NOT to gate Linux WebGPU specifically (Chromium's
flagged-WebGPU path on Linux runners) is deliberate: Linux
headless WebGPU varies across kernel + driver + Chromium-version
combinations in ways that produce flake on the order of 5-15%.
The CPU-fallback portability is the right gating surface today;
a Chrome-Canary-WebGPU-only nightly job is the right shape for
WebGPU-specific coverage and can land as a follow-up patch under
a separate workflow file.

### Wire compatibility

**100% wire-compatible.** This is a CI + Playwright config patch
only — no source change, no test change to the JS side, no API
change. The `BridgeGPUSource.onError` 0.9.32 surface and every
prior surface remain byte-identical.

### Tests

21 Node suites green; unaffected. The browser-smoke matrix runs
in CI and exercises:

- `tests/browser/minimal.spec.ts` — `examples/minimal/` loads,
  reports `crossOriginIsolated`, accumulates frames, drains the
  ring at the expected rate.
- `tests/browser/latency.spec.ts` — `bench/e2e-latency/` runs in
  CPU mode, accumulates ≥ 50 samples in a 5-second window,
  reports a coherent histogram, doesn't blow past the loose 500ms
  catastrophic-regression p99 budget.

Both specs were portable before 0.9.33 — they just weren't being
run on Firefox / WebKit. The matrix expansion exercises code
paths that were previously latent.

### Bench

Unaffected.

### Documentation

- `README.md` — §Browser support matrix gains a "Browser smoke
  (Playwright)" row marking Chromium / Firefox / WebKit as
  "tested in CI" and a §Notes bullet describing the matrix shape
  + the `playwright-report-<browser>` artifact naming.
- `ROADMAP.md` — 0.9.33 row added to the cohort table.
- `CHANGELOG.md` — this entry.

### Patch surface

- `.github/workflows/browser.yml` — `continue-on-error: true`
  removed; `strategy.matrix.browser: [chromium, firefox, webkit]`
  added with `fail-fast: false`; per-browser `playwright install
  --with-deps` + `--project=` flag; unique artifact name per
  slot. File header comment updated.
- `tests/browser/playwright.config.ts` — top-level
  `use.launchOptions` removed; three `projects` (was one) with
  per-project autoplay configuration scoped to the engine's
  recognized API.
- `README.md` — §Browser support matrix updated.
- `package.json` — version `0.9.32` → `0.9.33`.
- `ROADMAP.md` — 0.9.33 row.
- `CHANGELOG.md` — this entry.

## [0.9.32] — 2026-05-27

### Added — `BridgeGPUSource.onError` opt-in callback for device-lost handling (0.9.x soak)

The first slot in the post-cadence-reset envelope (0.9.31 → 0.9.99).
`BridgeGPUSource` gains an opt-in `onError(err, kind)` callback on its
constructor options for surfacing `mapAsync` rejections — most importantly
the device-lost case that every WebGPU app needs to handle eventually
(driver crash, OOM, tab-focus reset, user-agent shutdown). Default
behavior on the success path is byte-for-byte unchanged; on the rejection
path the helper now correctly routes the slot to drop-and-recycle instead
of running `getMappedRange` + `unmap` against a never-mapped buffer.

#### `onError` on `BridgeGPUSourceOptions`

```ts
readonly onError?: (err: unknown, kind: "transient" | "fatal") => void;
```

Fires when the slot's `beginMap` promise rejects. Classification is
best-effort:

- `'fatal'` — `device.lost` has resolved before the rejection lands.
  The GPU is gone; further readbacks will keep rejecting until the
  caller rebuilds the device. Typical response: `destroy()` the source,
  surface a "device lost" state to the UI, await
  `navigator.gpu.requestAdapter()`, rebuild.
- `'transient'` — any other rejection. The buffer slot recycles; the
  producer's next dispatch may succeed. Typical response: log + ignore.

Omitting `onError` keeps the helper silent (the pre-0.9.32 default).
Subscribing has zero hot-path cost — the callback fires only on the
rejection branch, which never runs on healthy hardware.

Device-lost detection requires the device exposing `lost` as a
Promise-like (the real `GPUDevice` always has it; minimal
`GpuDeviceLike` implementations and mocks may not). The constructor
subscribes once at construction with `device.lost?.then(...)` and flips
an internal `_deviceLost` flag on resolve. Absent or non-thenable
`lost` → all rejections classify as `'transient'` (the best-effort
fallback). The classification is observed at rejection time, not
retroactively — if `device.lost` resolves AFTER a rejection has already
fired, the prior callback gets `'transient'` and subsequent ones get
`'fatal'`.

`GpuDeviceLike` gains an optional `readonly lost?: PromiseLike<unknown>`
field. The real `GPUDevice.lost` is `Promise<GPUDeviceLostInfo>`;
`PromiseLike<unknown>` is structurally weaker and accepts it. Existing
`GpuDeviceLike` implementers without a `lost` field continue to compile
— the field is optional and the helper's subscription path is guarded.

User-callback exceptions are swallowed. If the consumer's `onError`
itself throws, the helper catches and discards the throw; the rejection
path still recycles the slot. This preserves the invariant "the helper
does not crash the producer thread on a `mapAsync` rejection" even
when the user handler is misbehaving.

#### Side-effect fix: rejection-path state machine

Before this patch, a rejected `beginMap` left `slot.mapped = true` so
`pollCompleted` would proceed to call `readMapped` (= `getMappedRange`)
+ `decoder` + `releaseMap` (= `unmap`) against a buffer that was never
mapped. On a real GPU that's an unmap-of-unmapped throw inside
`pollCompleted` (which would propagate to the producer's tick loop); on
the existing mock-based tests it silently fed uninitialized bytes into
the decoder. No shipping consumer hit this in practice because real-GPU
`mapAsync` rejections without device-lost are vanishingly rare.

The fix: capture the rejection's `err` on the slot (`StagingSlot.error`)
and check it in `pollCompleted` before the readback path. When set, the
slot routes to drop-and-recycle: `droppedCount` ticks, the
`lastReadbackUs` timer still updates (the cycle "completed", just with
nothing pushed), the slot returns to `idle`. No `readMapped` / `decoder`
/ `releaseMap` calls on the error branch.

This is technically a behavior change from the pre-0.9.32 buggy path,
but the buggy path was unreachable in green tests — and on a real GPU
it would have manifested as a runtime exception, not as observable
behavior an app could depend on. Calling it a "fix" is more honest than
"behavior change."

### Why

Two converging motivations:

1. **Device-lost is the WebGPU app's single most-likely "expected
   error" state.** Drivers crash, GPUs OOM, browsers reset adapters on
   tab focus or after long-idle. Every production WebGPU app needs a
   handler. Shipping `BridgeGPUSource` to 1.0 without a clean
   opt-in for the case would force consumers to wrap the helper or
   monkey-patch the rejection handler. `onError` is the canonical hook;
   one line in the constructor, no other changes.
2. **The latent state-machine bug needed fixing before 1.0.** The 1.0
   stability commitment promises that the helper's documented behavior
   matches its actual behavior. The pre-patch path "if mapAsync
   rejects, the slot's lifecycle goes wrong and pollCompleted will
   throw on a real GPU" wasn't documented anywhere because nobody had
   exercised it. The `onError` patch is the natural place to surface
   the path, audit it, and harden it.

The classification-is-observed-at-rejection-time semantic is
deliberate. The alternative — defer classification until poll time and
re-read `device.lost`'s state — is more expensive (sync-checking a
Promise's state isn't a thing; we'd have to maintain a parallel `then`
chain per error). Observed-at-rejection-time is simpler, correct in
practice (device-lost is irreversible; once flipped it stays flipped),
and predictable for callers.

### Wire compatibility

**100% wire-compatible.** No SAB byte layout change, no schema-DSL
extension, no protocol change. `Bridge<S>` is untouched. `BridgeGPUSource`'s
public method surface is unchanged — only `BridgeGPUSourceOptions` and
`GpuDeviceLike` gain optional fields.

### Tests

21 suites green; `tests/BridgeGPUSource.writeTarget.test.ts` grows from
6 pins to 10:

- Pin 7 — `onError` fires with `kind: 'transient'` on a generic
  rejection (no device.lost set). Asserts the slot routes to
  drop-and-recycle without calling `getMappedRange` / `unmap` on the
  never-mapped buffer (the rejecting mock throws if those methods are
  hit on the error path — the pin holds because the new error-routing
  in `pollCompleted` skips them).
- Pin 8 — `onError` fires with `kind: 'fatal'` after `device.lost`
  resolves. The mock device exposes a resolvable `lost` promise; the
  pin resolves it before flushing the rejection and asserts the
  classification flipped.
- Pin 9 — omitting `onError` leaves the helper silent on rejection.
  Drop counter still ticks; slot still recycles; `pollCompleted` doesn't
  throw despite the underlying mock methods throwing on unmapped
  access.
- Pin 10 — a user `onError` handler that throws is swallowed. The
  helper's "don't crash the producer thread" invariant holds even with
  a misbehaving consumer callback.

The new pins added a small `makeRejectingMockDevice(error, opts)`
helper inside the test file (mock methods throw if called; the helper
exposes a `loseDevice()` trigger). `main()` becomes `async` so the
microtask-flush awaits work; the existing sync pins (1-6) still run
synchronously inside the async wrapper.

### Bench

Unaffected. The `BridgeGPUSource` helper itself isn't on the
microbench surface (`bench/Bridge.bench.ts` covers `push` / `pull` /
`pullLatest` on `Bridge<S>`); the onError path is heap-side error
handling, off the hot loop.

### Documentation

- `src/BridgeGPUSource.ts` — file header gains a "0.9.32 Error handling"
  section explaining the `onError` contract + the rejection-path
  state-machine fix; `GpuDeviceLike.lost?`, `BridgeGPUSourceOptions.onError`,
  and `StagingSlot.error` carry inline docstrings.
- `README.md` — new "Device-lost handling (0.9.32)" subsection under
  §BridgeGPUSource (between Diagnostics and WebGPU type compatibility)
  with the canonical caller pattern.
- `ROADMAP.md` — 0.9.32 row added to the cohort table.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/BridgeGPUSource.ts` — `GpuDeviceLike.lost?` field added,
  `BridgeGPUSourceOptions.onError?` field added, `StagingSlot.error`
  field added, constructor subscribes to `device.lost`, mapAsync
  rejection handler captures error + fires `onError`, `pollCompleted`
  routes around the error path. File header updated.
- `tests/BridgeGPUSource.writeTarget.test.ts` — 4 new pins (7-10) +
  `makeRejectingMockDevice` helper. `main()` is now `async`.
- `README.md` — new §Device-lost handling subsection.
- `package.json` — version `0.9.31` → `0.9.32`.
- `ROADMAP.md` — 0.9.32 row.
- `CHANGELOG.md` — this entry.

## [0.9.31] — 2026-05-27

### Added — `SpscRing.drainNoNotify` public promotion + cadence reset (0.9.x soak)

**Two things in one patch.** First, the planned `SpscRing.drainNoNotify`
promotion lands — a public method on `SpscRing<S>` that exposes the
amortized-notify drain primitive that previously lived inside
`BridgeInputLane.pullAll` and reached into the underscore-prefixed
`_pullNoNotify` / `_notifyReadAdvance` internals. Second, **the patch
number jumps from `0.9.3` to `0.9.31`** — a user-directed cadence reset
that opens 68 patch slots between 0.9.31 and 0.9.99 for the rest of
the 0.9.x soak before 1.0.

#### `SpscRing.drainNoNotify(out, maxCount?)`

New public method on `SpscRing<S>`:

```ts
drainNoNotify(out: FrameFor<S>[], maxCount?: number): number
```

Drains every unread frame in the ring into successive entries of `out`,
in FIFO order, until either the ring is empty or the buffer fills.
Returns the count. **One trailing `Atomics.notify` per call**, regardless
of how many frames the burst drained; empty-pull early returns skip the
notify entirely. Compared to a hand-rolled loop over public `pull()`,
the trailing-notify shape cuts the per-burst notify cost from O(N) to
O(1) while preserving the exact same per-frame protocol (acquire load
on write_index, release store on read_index, drop-oldest CAS dispatch
when policy demands it).

`BridgeInputLane.pullAll(eventBuf, maxCount?)` is now a one-line
forwarder:

```ts
pullAll(eventBuf: FrameFor<S>[], maxCount?: number): number {
  return this.ring.drainNoNotify(eventBuf, maxCount);
}
```

The cross-module `this.ring._pullNoNotify` + `this.ring._notifyReadAdvance`
references at the prior body's lines 231 + 237 are gone. The
underscore-prefixed methods on `SpscRing` (`_pullNoNotify`,
`_notifyReadAdvance`, `_pullOverrunAwareNoNotify`) stay accessible via
their existing underscore names — bench harnesses (`bench/Bridge.bench.ts`
+ `bench/notify-cost-browser/main.js`) and the
`tests/BridgeInputLane.test.ts` notify-counting instrumentation both
still reach through to them, and the bench harness is not a stability
surface per the cohort plan §0.9.3.

The validation contract from the prior `pullAll` body migrated into
`drainNoNotify` verbatim:

- `out` must be an `Array`; else throws `"SpscRing.drainNoNotify: out
  must be an array of pre-allocated frame views"`.
- Every slot in `out` up to `cap` must be defined; the first
  `undefined` slot throws with the index in the message.
- `maxCount` is coerced via `Math.min(out.length, Math.max(0, maxCount | 0))`
  — non-finite, non-integer, or negative inputs clamp to 0 / `out.length`
  rather than throwing, matching the prior `pullAll` semantics.

Callers using `BridgeInputLane<S>` see no behavior change — `pullAll`'s
external contract is byte-for-byte identical. Callers using the
composable primitives (`SpscRing<S>` directly) gain a clean public
drain primitive without needing to write the loop themselves or reach
through the underscore convention.

#### Cadence reset to 0.9.31

Per the user's direction this session, the patch number jumps from
`0.9.3` to `0.9.31`, skipping `0.9.4` through `0.9.30`. The rationale:
the 0.9.x line is the soak window before 1.0, and the version-number
distance between "we're soaking" and "we're ready" should reflect that
soak's depth. Starting at 0.9.31 leaves 68 patches (0.9.31 → 0.9.99)
for soak work — the original cohort plan's `0.9.4` → `0.9.7` items
shift right into that envelope under different numbers.

This is a numbering convention shift, not a SemVer manipulation. By
SemVer, `0.9.31 > 0.9.3` (patch number 31 > 3), so the increment is
strictly monotonic. The package's `engines.node`, exports map, and
public-API surface are all unchanged from 0.9.3 → 0.9.31 — the jump
is the **only** distinguishing change beyond the drainNoNotify
promotion.

CLAUDE.md's existing post-0.6 versioning policy already says "each
minor cohort should reach deep into the patch space before promoting"
(0.7.99 → 0.8.0 is the documented example envelope). The 0.9.31 reset
extends that envelope explicitly into the 0.9.x line: 0.9.99 is the
practical soak ceiling; 1.0.0 ships when the soak gate trips.

### Why

Two intersecting motivations:

1. **The drainNoNotify surface is the right shape for composable callers.**
   Through 0.9.3 the only way to use the amortized-notify drain
   primitive on `SpscRing<S>` directly was to reach into the underscore-
   prefixed internals — which the file header explicitly flags as unsafe
   for direct external use ("Direct external use without a matching
   trailing notify on the success branch is unsafe"). Wrapping it
   correctly is a 12-line dance with two cross-module method calls.
   Promoting `drainNoNotify` to a public method means composable-API
   users get the same one-line ergonomics that `BridgeInputLane<S>`
   callers have always had, AND get the protocol's safety
   guarantees enforced by the method itself rather than by convention.
2. **The cadence reset signals "we're not in a hurry."** The 0.8.x →
   0.9.0 cohort moved fast (12 patches over a short window). The 0.9.x
   soak deserves a different shape — many small patches, each a
   checkpoint, no pressure to consolidate. Jumping the patch number to
   0.9.31 makes the soak depth visible up front: future readers (and
   future me) see the 68-slot envelope and know that 1.0 isn't around
   the corner.

### Wire compatibility

**100% wire-compatible.** No SAB byte layout change, no schema-DSL
extension, no protocol change, no test failures. The `drainNoNotify`
method body is the prior `pullAll` body verbatim with `this.ring._*`
→ `this._*` rewrites; the producer-side protocol is unchanged.

`BridgeInputLane.pullAll`'s external behavior is byte-identical (same
return value, same throw shapes, same notify cadence). The
`tests/BridgeInputLane.test.ts` pin that instruments
`_notifyReadAdvance` on the ring to count invocations still observes
exactly one notify per non-empty burst — `drainNoNotify` calls
`_notifyReadAdvance` internally.

### Tests

21 suites green, same set + same outcomes as 0.9.3. The
`tests/BridgeInputLane.test.ts` notify-instrumentation pin is the
load-bearing regression backstop for this refactor; it stays green.
The `Bridge.concurrent.test.ts` 1M-frame cross-thread stress is the
protocol regression backstop; it stays green.

### Bench

push / pull / pullLatest medians unchanged at ~1.20 μs (N=1000). The
`pullAll (1 notify)` cell in `bench/Bridge.bench.ts` measures the
drain primitive directly; the dispatch through `drainNoNotify` adds
one extra function call on the host path that's invisible at steady
state (the per-frame work is dominated by the SAB memcpy + the scalar-
reader closure dispatch, not the function-call overhead).

### Documentation

- `src/SpscRing.ts` — new public `drainNoNotify` method with a
  ~50-line docstring covering caller contract, invariant note,
  back-pressure-policy dispatch, and a cross-reference to the
  promoted-from history (0.8.2 internal → 0.9.31 public).
- `src/BridgeInputLane.ts` — `pullAll` body collapses to one line; the
  existing docstring gains an "Implementation: forwards to
  `this.ring.drainNoNotify(...)`" paragraph at the end so callers can
  trace the surface.
- `CLAUDE.md` — "What lives where" section's `src/SpscRing.ts` line
  updated to call out the 0.9.31 drainNoNotify promotion alongside the
  prior 0.6.10 class-promotion patch.
- `ROADMAP.md` — 0.9.31 row added; cohort header reworded to call out
  the cadence reset + the 68-slot envelope; "Beyond the cohort"
  speculative header bumped to `0.9.32+`.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/SpscRing.ts` — `drainNoNotify` method added (~30 LOC body +
  ~50 LOC docstring).
- `src/BridgeInputLane.ts` — `pullAll` body shrinks from ~25 LOC to
  one line; docstring gains an implementation note.
- `CLAUDE.md` — `SpscRing.ts` line updated.
- `package.json` — version `0.9.3` → `0.9.31`.
- `ROADMAP.md` — row added; cohort header reworded.
- `CHANGELOG.md` — this entry.

## [0.9.3] — 2026-05-27

### Fixed — minimal-demo + e2e-latency worklet SAB header view (audit response, 0.9.x soak cohort)

**Real bug fix + public-API drift gate.** An external audit of the
repo (run against a stale snapshot, but one finding was real against
current `main`) identified that `examples/minimal/worklet.js` viewed
the SAB header as `BigInt64Array(sab, 0, 2)` — wrong against the
post-0.4 Int32-lane protocol that `src/SpscRing.ts` uses today. The
`bench/e2e-latency/worklet.js` harness carried the same bug. Both are
now fixed to use `Int32Array(sab, 0, 8)`, matching `RING_HEADER_INT32_LANES`.

This patch also adds `tests/readme-imports.test.ts` as a gate against
future drift between the README's documented imports and the actual
`src/index.ts` public-export surface.

#### The worklet bug

The current SAB header is 32 bytes viewed as 8 Int32 lanes (mirrored
in `src/SpscRing.ts`):

```
lane 0  write_index           (producer monotonic Int32 wrap counter)
lane 1  read_index            (consumer monotonic Int32 wrap counter)
lane 2  flow_scale            (Q16.16 consumer→producer hint, 0.5.0)
lane 3  torn_frame_counter    (Int32 monotonic wrap-counter, 0.6.0)
lane 4-5  PLL offset (Int64)  (0.6.16)
lane 6  PLL drift (Q16.16)
lane 7  PLL status word
```

Viewing the header as `BigInt64Array(sab, 0, 2)` collapses Int32
lanes 0+1 into a single 64-bit word (`indices[0]`) and Int32 lanes 2+3
into a second 64-bit word (`indices[1]`). The minimal-demo consumer's
`pullLatest()`:

- Read `writeIdx = Atomics.load(indices, 0)` → bytes 0-7 as an Int64
  = `(read_index << 32) | write_index` on little-endian. Happens to
  observe an upward-growing value because `read_index` stays 0 (see
  next bullet).
- Read `readIdx = indices[1]` → bytes 8-15 as an Int64
  = `(torn_frame << 32) | flow_scale`. Both lanes start at 0; the
  consumer thinks `readIdx === 0n` forever (or whatever those control
  lanes happen to hold).
- Compute `slot = (writeIdx - 1n) & mask` — picks the newest produced
  frame. The demo's audio output therefore came out roughly correct
  for the first few moments because the consumer was reading slot
  `(write_index - 1) % capacity`, which IS the newest frame as long
  as `write_index` advances.
- Write `Atomics.store(indices, 1, writeIdx)` → bytes 8-15. This
  corrupts the `flow_scale` (Int32 lane 2) and `torn_frame_counter`
  (Int32 lane 3) lanes by overwriting them with the low and high 32-bit
  halves of the Int64 `writeIdx` value. The `flow_scale` corruption
  feeds the producer's adaptive backpressure controller false hints;
  the `torn_frame_counter` corruption invalidates the canonical "have
  any frames torn under contention" diagnostic.

Downstream effects on the demo:

1. The actual `read_index` lane (Int32 lane 1) **never advances**
   because the consumer was writing to a different range of bytes.
   From the producer's perspective the ring fills to capacity (16
   frames at the demo's default) and then `bridge.push` rejects
   every subsequent frame — producer-side `pushRejects` grows
   unboundedly, masquerading as "the consumer can't keep up."
2. The consumer's `Atomics.notify(indices, 1, 1)` targets a different
   byte range than the lane the producer parks on, so the back-
   pressure wake protocol silently fails. (The demo uses the default
   `'reject'` policy, so this never triggers a missed wake-up
   in practice — the producer doesn't park — but it would have for
   `'block'` callers.)
3. The audible output remained roughly correct because the consumer
   kept reading `(write_index - 1) % capacity`, which IS the newest
   frame for the first 16 frames. After that the consumer kept
   reading slot 15 (the last slot the producer wrote to before it
   started rejecting) and the audio output froze on that frame's
   parameters — possibly indistinguishable from "the producer is
   running steady-state" depending on what the WGSL shader emits.

The fix is straightforward — swap `BigInt64Array(sab, 0, 2)` for
`Int32Array(sab, 0, 8)` (covering the full header), convert `mask`
from `BigInt` to `Number`, switch all index arithmetic from BigInt
subtraction to Int32 wrap (`(x - 1) | 0`). Everything else stays the
same. The producer side (`worker.js`) was already correct — it goes
through the high-level `Bridge.push(scratch)` which uses the proper
SpscRing protocol.

`bench/e2e-latency/worklet.js` had a structurally identical bug; same
fix applied. The bench's previously-reported latency numbers should
be treated as approximate (the producer-side `bridge.push` was
correctly stamping `tMacroNs`; the consumer-side read was at the
correct slot for the first 16 frames; but the back-pressure /
flow-scale corruption could have biased the bench's behavior under
sustained load — at minimum, future calibration runs should compare
against the fixed worklet).

`examples/audio-rate/worklet.js` was always correct — it uses the
high-level `BridgeBlockConsumer` class (which internally uses
`bridge.pull` against the correct protocol). `examples/fast-lane/worklet.js`
was also correct — it had been using `Int32Array(sab, 0, 2)` directly
since 0.6.19. Only the two listed files carried the bug.

#### The README-imports drift gate

External audits sometimes flag stale claims about what's actually
exported from the package root. The 0.9.3 audit's first "critical"
finding was exactly this — though against the audit's stale snapshot,
not against current `main`. `src/index.ts` exports every name the
README's `from "webgpu-audio-bridge"` blocks document, and
`package.json`'s `exports` map includes `.`, `./worklet`,
`./worklet/decoder.wasm`, and `./experimental`. The 0.9.3 audit was
based on a snapshot predating the 0.8.x cohort and missed all of
that.

But the failure mode the audit flagged is real **for future drift**:
the README is hand-maintained, `src/index.ts` is hand-maintained, and
nothing programmatically enforces consistency. A future patch could
rename or remove an export without updating the README, or document a
new symbol that's been moved to an internal file.

`tests/readme-imports.test.ts` adds that gate. It imports every name
documented in the README's `from "webgpu-audio-bridge"` blocks
(Bridge, SpscRing, BridgeProducer, BridgeConsumer, FrameSmoother,
ConsumerClockRecovery, AdaptiveFlowController, BridgeInputLane,
BridgeBlockConsumer, BridgeBlockProducer, BridgeGPUSource,
getEnvironmentReport, defineSchema, the 10 scalar + array
constructors that appear in code blocks, f64TrajectoryArray,
evaluateTrajectoryInto, physicsControlFrameSchema, and the
TelemetrySnapshot type) and verifies each resolves to a non-`undefined`
value at runtime + that the type-only references compile. The test
also performs a tiny functional smoke (defineSchema → Bridge.allocate
→ new Bridge round-trip) to catch the "exported but throws at
construction" regression class.

Adding a new public-API symbol now requires adding it to the README's
import block AND to this test's import block; the compiler enforces
the link. Removing one requires removing it from both. The test runs
in `npm test` and `npm test:unit`; CI gates on it.

### Why

Per the cohort plan §0.9.3 the planned next patch was the
`SpscRing.drainNoNotify` public promotion. That patch shifts to 0.9.4;
this 0.9.3 patch is the audit-response slot.

The audit's six findings broke down as:
- (1) README imports vs `index.ts` exports — **stale claim**; resolved
  pre-cohort. Hardened with the README-imports test in this patch
  (gate against future drift).
- (2) Test scripts run deleted `Float64RingBuffer.test.ts` — **stale
  claim**; those entries were removed at 0.9.0.
- (3) `examples/minimal/worklet.js` uses `BigInt64Array` for an Int32
  header protocol — **real bug**; this patch fixes it, plus the
  identical bug in `bench/e2e-latency/worklet.js`.
- (4) `package.json` is 0.6.18 and CHANGELOG top is 0.6.5 — **stale
  claim**; current is 0.9.2 (now 0.9.3 with this patch).
- (5) Browser smoke tests have `continue-on-error: true` — **real but
  already queued** at 0.9.5 per the cohort plan.
- (6) README overclaims platform support — **partial / subjective**;
  worth a polish pass but not in scope for this audit-response patch.

The three real issues now have closed paths: (3) fixed in this patch,
(1) hardened in this patch, (5) queued in the plan. (6) is a
documentation-polish item that will land in a future patch when the
language pass on the browser-support sections lands as part of the
broader 1.0-readiness review.

### Wire compatibility

**100% wire-compatible.** The two `*.js` files that carried the bug
were demos / bench harnesses, NOT part of the library's compiled
distribution; their behavior was wrong, but the library's wire format
and protocol were always Int32. A 0.9.2 producer feeding a 0.9.3
consumer (or vice versa) over the same SAB exchanges frames bit-
identically. The fix corrects the demo and bench to match the
protocol that was already canonical in `src/SpscRing.ts`.

The `readme-imports.test.ts` addition is test-only; it doesn't touch
the library surface.

### Tests

21 suites green (up from 20: `readme-imports.test.ts` added). The new
test asserts:

1. Every documented value-shape root import resolves to a defined value.
2. Type-only README imports (`TelemetrySnapshot`) compile.
3. The Quick start import combination (`defineSchema` + `u64` + `f64` +
   `Bridge.allocate` + `new Bridge`) round-trips functionally.
4. `physicsControlFrameSchema(8)` produces the documented 6-field shape.

The minimal-demo worklet itself runs only in a browser AudioWorklet
context; this patch verifies the fix by code-review (the diff is
textually equivalent to `examples/fast-lane/worklet.js`'s correct
Int32 protocol) and by ensuring the Bridge.concurrent test (which
already exercises the production Int32 protocol cross-thread)
remains green at 1M frames.

### Bench

push / pull / pullLatest medians unchanged at ~1.20 μs (N=1000) — the
bench harness changes don't touch the library hot path. The
`bench/e2e-latency/` harness numbers will need a fresh calibration
run against the fixed worklet; previously-reported numbers are
approximate (see file-header rework above).

### Documentation

- `examples/minimal/worklet.js` — header view migrated; comment block
  at the top rewritten to describe the post-0.4 Int32 protocol +
  call out the lanes the consumer must NOT touch (flow_scale,
  torn_frame, PLL). Explicit "Earlier versions ... fixed at 0.9.3"
  note in the header for anyone diffing across versions.
- `bench/e2e-latency/worklet.js` — header view + arithmetic migrated;
  inline comments updated.
- `tests/readme-imports.test.ts` — new file (~120 LOC including header)
  with the four pins enumerated above.
- `package.json` — `tests/readme-imports.test.ts` added to both `test`
  and `test:unit` script chains; version `0.9.2` → `0.9.3`.
- `ROADMAP.md` — 0.9.3 row added.
- `CHANGELOG.md` — this entry.

### Patch surface

- `examples/minimal/worklet.js` — full rewrite (header view +
  arithmetic + comments).
- `bench/e2e-latency/worklet.js` — header view + arithmetic fix; the
  comment block was already updated in 0.9.0 to reference the all-f64
  schema migration, so it only gets two new "0.9.3 fix" notes.
- `tests/readme-imports.test.ts` — new file.
- `package.json` — version + test/test:unit script entries.
- `ROADMAP.md` — row added.
- `CHANGELOG.md` — this entry.

## [0.9.2] — 2026-05-27

### Added — centralize invariant thresholds (0.9.x soak cohort, internal-only)

Second patch of the 0.9.x soak cohort. Pure-refactor: collapses the
duplicated `INVARIANT_OK_THRESHOLD` / `INVARIANT_SOFT_THRESHOLD` /
`INVARIANT_SOFT_ALPHA_BASE` trio (one copy each in `src/Bridge.ts` and
`src/BridgeConsumer.ts`) into a single source on `Bridge.ts`. The
companion 0.9.1 refactor closed the `newHeapTypedArray` /
`buildScratchFrame` drift surface; this patch closes the next-largest
one in the same category.

**Surface.** The three constants in `src/Bridge.ts:290-292` gain `export`
markers. `src/BridgeConsumer.ts` drops its three duplicated `const`
declarations and imports the names from `./Bridge.js` instead. The
existing `static readonly` exposes on the `Bridge` class
(`Bridge.INVARIANT_OK_THRESHOLD` etc.) are unchanged — that's still the
documented public-test pin; the named module-level exports are the
internal cross-module-share mechanism.

**Why this shape.** Per the pre-1.0 cohort plan §0.9.2, three options
were on the table: (a) extract to a new `src/_invariant.ts` (mirrors the
0.9.1 `_heap.ts` pattern), (b) hang the values off a shared base class,
(c) export named constants from `Bridge.ts` and import them in
`BridgeConsumer.ts`. (c) is the smallest diff and gives the same
single-source guarantee — Bridge.ts is the canonical home for the
classifier logic itself (`_classifyInvariant` is defined there at
~line 1276); the thresholds are part of the classifier's contract and
already documented in the file header. (a) would have added a third
internal-only file for an even smaller share than `_heap.ts`'s; (b)
would have demanded a class-extraction refactor for three numbers.

### Why

The duplication grew when `BridgeConsumer<S>` was extracted at 0.6.10:
the constants were copy-pasted out of `Bridge.ts` rather than imported.
A `BridgeFacades.test.ts` symmetry pin caught any drift downstream
(facade `pull()` behavior vs `Bridge<S>` `pull()` behavior), but the
drift surface itself — three numbers in two files — would have to
break loudly for the test to fire, and "loudly" depends on the
direction of the drift. A 0.5 → 0.6 widening of `INVARIANT_SOFT_THRESHOLD`
in one file but not the other, for example, would leave the test pass
on the OK + HARD boundaries but silently change the soft-band α
schedule. Single-source eliminates the surface entirely.

### Wire compatibility

**100% wire-compatible.** No SAB byte layout change, no schema-DSL
extension, no protocol change. The named constants are now reachable
via `import { INVARIANT_OK_THRESHOLD } from "webgpu-audio-bridge"` …
**wait — no, they are not**: `src/index.ts` does not re-export them, so
the public-API surface (everything documented in `README.md` and
exported from the package's entry) is unchanged. The constants are
importable from the package's internal subpath only (e.g.
`import { ... } from "webgpu-audio-bridge/dist/Bridge.js"`), which is
not a documented surface and not stable across patches. The `Bridge.X`
static readonlys remain the only documented public way to read these
values.

### Tests

20 suites green. The `BridgeFacades.test.ts` symmetry pin remains the
load-bearing regression backstop and stays green bit-identically — the
classifier behavior on facade vs `Bridge<S>` is now structurally
guaranteed to match (same constant source), not merely empirically
checked. The `Bridge.invariant.test.ts` pins (which assert the exact
OK / SOFT / HARD boundary values) stay green; the numbers are
unchanged.

### Bench

push / pull / pullLatest medians unchanged at ~1.20 μs (N=1000). The
constants are read-only globals; the dedup adds zero runtime cost.

### Documentation

- `src/Bridge.ts` — the comment above the constant block updated to
  spell out the single-source contract; the three `const` declarations
  gain `export` markers. The `Bridge.X` static readonly exposes
  unchanged (still the public-test pin).
- `src/BridgeConsumer.ts` — three duplicated `const` lines replaced by
  named imports from `./Bridge.js`; the comment block above reworded
  from "mirror of the constants in Bridge.ts" to "imported from
  `./Bridge.js` — single source of truth."
- `ROADMAP.md` — 0.9.2 row added.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/Bridge.ts` — three `const` → `export const` (3 lines touched);
  preceding comment block reworded.
- `src/BridgeConsumer.ts` — three `const` declarations deleted; named
  imports added to the `./Bridge.js` import block; preceding comment
  block reworded.
- `package.json` — version `0.9.1` → `0.9.2`.
- `ROADMAP.md` — row added.
- `CHANGELOG.md` — this entry.

## [0.9.1] — 2026-05-27

### Added — shared heap helpers (0.9.x soak cohort, internal-only)

First patch of the 0.9.x soak cohort. Pure-refactor: dedupes the
`newHeapTypedArray` + `scratchFrame()`-body pair that had grown to four
identical copies (one each on `Bridge<S>`, `BridgeProducer<S>`,
`BridgeConsumer<S>`, `BridgeInputLane<S>`). New module-private utility
`src/_heap.ts` is the single source of truth.

**Surface.** Two helpers on `_heap.ts`:

- `newHeapTypedArray(kind, length): AnyTypedArray` — fresh heap typed-
  array dispatched on the 10 `FieldKind` values. Used by every facade's
  `scratchFrame()` factory plus `Bridge.scratchEvaluatedFrame()`'s
  trajectory-array allocation.
- `buildScratchFrame(fields): Record<string, unknown>` — reusable
  scratch frame from a schema's `compiled.fields` list. Iteration order
  + per-kind dispatch match the prior inlined bodies bit-for-bit.

Both are module-private by convention (the `_heap.ts` filename and the
underscore mirror the `_pullNoNotify` / `_notifyReadAdvance` markers
elsewhere — "internal cross-module surface, may change without a minor
bump"). Not re-exported from `src/index.ts`.

**Sites de-duplicated.**

- `src/Bridge.ts` — drops `newHeapTypedArray`; `scratchFrame()` body
  collapses to one delegating line; `scratchEvaluatedFrame()` keeps its
  trajectory-aware loop but the inner allocator is now the imported
  helper. Local `AnyTypedArray` type preserved (used by `ctorForKind` +
  `TypedArrayCtor` elsewhere in the file).
- `src/BridgeProducer.ts` — drops local `AnyTypedArray` + local
  `newHeapTypedArray`; `scratchFrame()` body collapses to one
  delegating line. `kindTsType` / `FieldKind` imports trimmed (no
  longer referenced).
- `src/BridgeConsumer.ts` — same pattern.
- `src/BridgeInputLane.ts` — same pattern.

`src/SpscRing.ts` keeps its own local `AnyTypedArray` declaration — the
type is used in many places in that file beyond the scratch-frame path
(`arrayViews`, `ctorForKind`, the `.set(src)` casts on the push/pull
paths) and dropping the local declaration would touch ~12 unrelated
sites. The type is structurally identical to `_heap.ts`'s
`AnyTypedArray`; cross-module assignability holds via TypeScript's
structural-typing rules.

### Why

The duplication had grown by accident: when 0.6.10 extracted
`BridgeProducer<S>` / `BridgeConsumer<S>` from the monolithic
`Bridge<S>`, the `newHeapTypedArray` + `scratchFrame()` pair was
copy-pasted rather than shared. 0.6.19's `BridgeInputLane<S>` added a
fourth copy. By the 0.8.7 audit there were four identical
`newHeapTypedArray` functions and four identical `scratchFrame()`
bodies across `src/`, each ~12 LOC, each silently drifting-prone — a
classifier-shape change to `FieldKind` would have required four edits
in lockstep with no compiler help.

Per the pre-1.0 cohort plan §0.9.1, the dedup is internal-only and
wire-equivalent: callers see exactly the same `scratchFrame()` shape +
behavior, the SAB protocol is unchanged, and every facade's
public-API surface is identical. The win is purely architectural —
one source for the heap-allocation logic, fewer places where a future
`FieldKind` extension can drift.

### Wire compatibility

**100% wire-compatible.** No SAB byte layout change, no schema-DSL
extension, no protocol change, no public-API change. The
`BridgeFacades.test.ts` symmetry pin (the load-bearing test for "the
facades produce the same scratch frames + the same pull/push behavior
as `Bridge<S>`") remains green bit-identically.

### Tests

20 suites green — same set + same outcomes as 0.9.0. The
`BridgeFacades.test.ts` symmetry pin (facade-vs-Bridge bit-for-bit) is
the canonical regression backstop for this refactor; it stays green.
The `typecheck-deprecations.test.ts` pins from 0.9.0 also remain green
(no removed surface accidentally re-introduced).

### Bench

push / pull / pullLatest medians unchanged at ~1.20 μs (N=1000). The
extraction adds one function-call hop on the scratch-frame path
(`scratchFrame()` → `buildScratchFrame()`), but scratch frames are
allocated once outside hot loops by convention — never on the per-push
/ per-pull path — so the hop is invisible at steady state.

### Documentation

- `src/_heap.ts` — new file with file-header documenting the extraction
  + the wire-equivalence claim + the module-private convention.
- `src/Bridge.ts` — imports `newHeapTypedArray` + `buildScratchFrame`
  from `_heap`; local `newHeapTypedArray` deleted; `scratchFrame()`
  body collapses to one line.
- `src/BridgeProducer.ts` — local `AnyTypedArray` + `newHeapTypedArray`
  deleted; imports `buildScratchFrame` from `_heap`; `scratchFrame()`
  body collapses to one line.
- `src/BridgeConsumer.ts` — same pattern.
- `src/BridgeInputLane.ts` — same pattern.
- `ROADMAP.md` — 0.9.1 row added.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/_heap.ts` — new file (~80 LOC including header).
- `src/Bridge.ts` — drop ~14 LOC (local `newHeapTypedArray`); 
  `scratchFrame()` body shrinks by ~9 LOC.
- `src/BridgeProducer.ts` — drop ~25 LOC (local `AnyTypedArray` +
  `newHeapTypedArray`); `scratchFrame()` body shrinks by ~9 LOC.
- `src/BridgeConsumer.ts` — same shape.
- `src/BridgeInputLane.ts` — same shape.
- `package.json` — version `0.9.0` → `0.9.1`.
- `ROADMAP.md` — row added.
- `CHANGELOG.md` — this entry.

Net diff is slightly negative (`_heap.ts` adds ~80 LOC, the four call-
sites collectively drop ~120 LOC); the win is the single-source
invariant, not the line count.

## [0.9.0] — 2026-05-27

### Removed — three legacy surfaces (pre-1.0 cohort 4/N, the breaking cut)

**This is a breaking release.** Three public surfaces deprecated through
0.8.x are now deleted. The 0.9.0 → 1.0.0 patch lifetime begins from this
slimmer surface — see `ROADMAP.md` for the 0.9.x soak plan.

The three removals, in order of likely impact:

1. **`Float64RingBuffer`** (the v0.1.x hard-coded class). Removed from
   `src/Float64RingBuffer.ts` (file deleted, ~436 LOC). The
   `RING_FRAME_PRELUDE` named export, the `RingFrameHeader` type, and the
   `RingAllocation` type go with it.
2. **`legacyPhysicsControlFrameSchema(n)`** (the all-f64 byte-twin to
   `Float64RingBuffer`). Removed from `src/schemas/physics.ts`. The
   companion `LegacyPhysicsControlFrameSchema` type alias is removed too.
3. **`BridgeBlockConsumer` `underflowPolicy: 'throw'`**. The `'throw'`
   value is removed from the `BlockUnderflowPolicy` union; the matching
   branch in `_handleUnderflow` is deleted; the `BlockUnderflowPolicy`
   type is now `'zero-fill' | 'hold-last'`.

The migration paths for each are documented below in long form. There is
no `0.9.0` deprecation soak — that soak was 0.8.11 (with `console.warn`
on every construction) and 0.8.12 (continued warnings; WebNN warning
sharpened). If you have not migrated by now, **pin
`webgpu-audio-bridge@0.8.x`** while you do. The v0.1.1 npm tarball and
[Zenodo DOI](https://doi.org/10.5281/zenodo.20382407) remain available for
anyone who specifically wants the original single-file `Float64RingBuffer`
form.

### Migration

#### 1. `Float64RingBuffer` → `Bridge<Schema>`

Before (0.8.x, deprecated):

```ts
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

const { sab } = Float64RingBuffer.allocate(16, 1000);
const ring = new Float64RingBuffer(sab, 16, 1000);

// Producer:
const header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };
const vEff = new Float64Array(1000);
const jEff = new Float64Array(1000);
// (fill vEff, jEff)
ring.push(vEff, jEff, header);

// Consumer:
const outV = new Float64Array(1000);
const outJ = new Float64Array(1000);
const outHeader: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };
ring.pull(outV, outJ, outHeader);
```

After (0.9.0+):

```ts
import { Bridge, physicsControlFrameSchema } from "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(1000);
const { sab } = Bridge.allocate(16, schema);
const ring = new Bridge(sab, 16, schema);

// Producer:
const scratch = ring.scratchFrame();
scratch.seq = 1n;                  // u64 → bigint literal
scratch.tMacroNs = 0n;
scratch.vMax = 0;
scratch.jMax = 0;
// (fill scratch.vEff, scratch.jEff in place)
ring.push(scratch);

// Consumer:
const out = ring.scratchFrame();
ring.pull(out);
// out.seq, out.tMacroNs, out.vMax, out.jMax, out.vEff, out.jEff
```

Three differences to notice:

- `physicsControlFrameSchema(n)` types `seq` and `tMacroNs` as **`u64`
  (`bigint`)** instead of `f64` (`number`). Producers write `1n`, not
  `1`; consumers read a `bigint`.
- Push takes **one argument** — a frame object with named fields —
  instead of three positional args (vEff, jEff, header).
- `ring.scratchFrame()` allocates the reusable frame once; both push and
  pull mutate it in place.

If your producer specifically needs the all-f64 wire layout (e.g. for
sub-microsecond fractional `tMacroNs` precision; the e2e-latency bench
in this repo is the canonical example), declare it inline:

```ts
import { defineSchema, f64, f64Array, Bridge } from "webgpu-audio-bridge";

const schema = defineSchema({
  seq:      f64(),
  tMacroNs: f64(),
  vMax:     f64(),
  jMax:     f64(),
  vEff:     f64Array(n),
  jEff:     f64Array(n),
});
const { sab } = Bridge.allocate(capacity, schema);
const ring = new Bridge(sab, capacity, schema);
```

The resulting SAB bytes are bit-identical to what
`legacyPhysicsControlFrameSchema(n)` produced — same field order, same
types, same per-field byte offsets.

#### 2. `legacyPhysicsControlFrameSchema(n)` → inline `defineSchema`

See the inline-schema example immediately above. Concrete migration:

```ts
// Before (0.8.x):
import { Bridge, legacyPhysicsControlFrameSchema } from "webgpu-audio-bridge";
const schema = legacyPhysicsControlFrameSchema(n);

// After (0.9.0+):
import { Bridge, defineSchema, f64, f64Array } from "webgpu-audio-bridge";
const schema = defineSchema({
  seq:      f64(),
  tMacroNs: f64(),
  vMax:     f64(),
  jMax:     f64(),
  vEff:     f64Array(n),
  jEff:     f64Array(n),
});
```

The `LegacyPhysicsControlFrameSchema` type alias goes with the function;
the inline form's type is `ReturnType<typeof yourFactory>` if you want
to name it. For most callers the schema is constructed once and the
inferred `Bridge<S>` type carries through, so the named alias is
unnecessary.

#### 3. `BridgeBlockConsumer` `underflowPolicy: 'throw'` → caller-side wrapper

Before (0.8.x, deprecated):

```ts
const consumer = new BridgeBlockConsumer(bridge, { underflowPolicy: "throw" });
consumer.process(out);  // throws Error on ring-empty
```

After (0.9.0+):

```ts
const consumer = new BridgeBlockConsumer(bridge);  // default 'zero-fill'
// Strict-fail-on-underflow caller-side wrapper:
const before = consumer.underflowSamples();
consumer.process(out);
if (consumer.underflowSamples() > before) {
  throw new Error("ring underflow");
}
```

The wrapper preserves the strict-fail semantic for tests but moves the
throw out of `AudioWorklet.process()` — where an unhandled throw
permanently terminates the processor (bug-shaped for a production
policy). For production worklets, `'zero-fill'` (default) matches the
AudioWorklet `return true and emit silence` idiom and never throws; the
`underflowSamples()` counter is still available for telemetry.

The full migration in this repo's tests:
`tests/BridgeBlockConsumer.test.ts` pin 8 was renamed from
`underflow 'throw'` to `strict-on-underflow caller-side wrapper`. The
new pin asserts the same observable behavior (caller sees a throw on
ring-empty) without selecting a policy on the consumer.

### Why

The pre-1.0 audit identified three surfaces that should not survive into
the 1.0 stability contract:

1. **`Float64RingBuffer`** predates the schema DSL by two minor versions
   (0.1.x → 0.3.0). New code has used `Bridge<Schema>` since 0.3.0;
   carrying the legacy class forever inflates the 1.0 API surface, ties
   the byte format to the v0.1.x shape forever, and forces every
   internal refactor to keep both call-sites compiling. The class is also
   the largest single source file in the repo (~436 LOC) and its
   `Atomics.notify` / park-wake protocol commentary was the canonical
   "Park / wake protocol" + "Wall-clock vs CPU-shape tradeoff"
   reference for the entire codebase — that documentation now lives in
   `src/SpscRing.ts` (the production primitive).
2. **`legacyPhysicsControlFrameSchema`** exists *only* as the
   `Float64RingBuffer` byte-twin via `Bridge<Schema>`. With
   `Float64RingBuffer` gone there is no remaining motivation to ship an
   f64-via-Number schema variant in the canonical API — the all-f64 wire
   layout is a niche need (sub-µs fractional timestamps) that's better
   expressed inline at the call site.
3. **`BridgeBlockConsumer` `underflowPolicy: 'throw'`** is a footgun: an
   unhandled throw from `AudioWorklet.process()` permanently terminates
   the processor. The arm exists in case tests want a
   strict-fail-on-underflow signal, but a `'zero-fill'` + post-call
   `underflowSamples()` check does the same thing without the
   production-time hazard.

Per the cohort plan all three have zero known consumers (the survey ran
0.6.0 → 0.8.0). The 0.8.11 → 0.8.12 cohort emitted runtime
`console.warn`s from each surface as a final heads-up; 0.9.0 is the
removal.

### Wire compatibility

**Wire-compatible.** No SAB byte layout change, no schema-DSL extension,
no protocol change. `Bridge<S>` peers continue to interoperate
bit-identically across the 0.8.12 ↔ 0.9.0 boundary as long as both sides
use the surviving APIs (`physicsControlFrameSchema(n)` or any schema
defined via `defineSchema`). The removal is purely a public-API surface
prune; the runtime behavior of every remaining symbol is unchanged.

A 0.8.12 producer feeding a `physicsControlFrameSchema(n)` schema
through `Bridge.push` is bit-identical to a 0.9.0 producer doing the
same. A 0.8.12 producer using `legacyPhysicsControlFrameSchema(n)` is
bit-identical to a 0.9.0 producer using the inline `defineSchema(...)`
form documented above.

### Tests

20 suites green (down from 21: `Float64RingBuffer.test.ts` and
`Float64RingBuffer.concurrent.test.ts` deleted; `BridgeBlockConsumer.test.ts`
pin 8 migrated to the caller-side wrapper pattern; new
`typecheck-deprecations.test.ts` added with four `@ts-expect-error` pins
catching accidental re-introduction of the removed surfaces).

The 1M-frame `Bridge.concurrent.test.ts` cross-thread SPSC stress pin
remains green; the WASM equivalence suite remains green. No protocol
regressions from the removal.

The new typecheck-deprecations pins fire at TypeScript-compile time:
each `@ts-expect-error` directive lives on an access of a removed symbol
or literal. If a future patch accidentally re-introduces any of them
(re-exporting `Float64RingBuffer`, re-adding `'throw'` to
`BlockUnderflowPolicy`, etc.), the corresponding directive becomes
unused and `tsc --noEmit` fails loudly. This is the "no accidental
walkback" pin for the 0.9.x soak.

### Bench

`bench/Bridge.bench.ts` push / pull / pullLatest medians unchanged at
~1.20 μs (N=1000). The `Float64RingBuffer.bench.ts` companion is
deleted; the schema-dispatch overhead — formerly the headline comparison
cell — is now an absolute number against the memcpy baseline.

`bench/e2e-latency/` migrated from `legacyPhysicsControlFrameSchema(n)`
to an inline `defineSchema(...)` with the same all-f64 layout. Bench
wire format preserved (sub-µs fractional `tMacroNs` precision intact);
no calibration-baseline drift.

### Documentation

- `README.md` — §Legacy API section removed entirely. The
  `'throw'` row in the underflow-policy table replaced by an
  "Pre-0.9.0" callout pointing at the caller-side wrapper. The canonical
  schemas section dropped the `legacyPhysicsControlFrameSchema(n)` row;
  the all-f64 wire layout is documented as an inline-`defineSchema`
  recipe in the same place. Two file-link references in the Performance
  / Back-pressure sections pointed at `src/Float64RingBuffer.ts`;
  rewritten to point at `src/SpscRing.ts` (where the canonical
  Park/wake + Wall-clock-vs-CPU-shape commentary lives post-extract).
  Top-of-file Legacy callout reworded to past tense.
- `src/Bridge.ts` — file-header "Generalization of Float64RingBuffer"
  paragraph reworded to past tense (the class is gone; the
  generalization framing is now historical context, not a live
  reference). Attribution section reworded to point at the README's
  Acknowledgments section as the home for the full lineage.
- `src/SpscRing.ts` — Schema-dispatch overhead section reworded to drop
  the "compared to Float64RingBuffer" framing; Attribution section
  reworded to drop the `see src/Float64RingBuffer.ts for full
  attribution` line.
- `src/index.ts` — public-API tour reworded from "Three public surfaces"
  to "Two public surfaces"; the legacy paragraph replaced by a "0.9.0
  removed three legacy surfaces" callout with the pin path. Both legacy
  re-export blocks (`legacyPhysicsControlFrameSchema` + `Float64RingBuffer`)
  removed.
- `src/schemas/physics.ts` — file-header rewritten to describe one
  canonical schema. Migration footnote points at the
  `defineSchema(...)` inline pattern for the all-f64 niche.
- `src/BridgeBlockConsumer.ts` — file-header "Underflow policy" section
  rewritten to two arms; a migration footnote describes the caller-side
  wrapper pattern. `BlockUnderflowPolicy` JSDoc + `BridgeBlockConsumerOptions`
  field JSDoc lose the deprecation language.
- `MIGRATION.md` — top-of-file callout added for 0.9.0+ readers,
  explaining the doc remains the canonical migration path but the
  `Float64RingBuffer` imports below require pinning `0.8.x` to test.
- `bench/Bridge.bench.ts` — file-header reworded to describe the
  microbench in its own right rather than as a companion to the deleted
  `Float64RingBuffer.bench.ts`.
- `bench/e2e-latency/schema.js` + `worklet.js` — migrated to inline
  `defineSchema(...)` (above); comments updated.
- `examples/minimal/schema.js` — `Float64RingBuffer` callout in the
  schema's docstring removed.
- `tests/Bridge.concurrent.test.ts` — "Same reason as
  Float64RingBuffer.concurrent.test.ts" header note reworded (the
  sibling file is gone).
- `ROADMAP.md` — 0.9.0 row promoted; cohort header advanced.
- `CHANGELOG.md` — this entry.

### Patch surface

Deletions:

- `src/Float64RingBuffer.ts` (entire file, ~436 LOC).
- `tests/Float64RingBuffer.test.ts` (411 LOC).
- `tests/Float64RingBuffer.concurrent.test.ts` (599 LOC).
- `bench/Float64RingBuffer.bench.ts` (221 LOC).

Edits:

- `src/schemas/physics.ts` — strip `legacyPhysicsControlFrameSchema` +
  `LegacyPhysicsControlFrameSchema`; rewrite file header.
- `src/BridgeBlockConsumer.ts` — strip `'throw'` from `BlockUnderflowPolicy`;
  drop the warn flag + constructor branch + `_handleUnderflow` branch;
  rewrite file header section and JSDocs.
- `src/index.ts` — strip both legacy re-export blocks; rewrite the
  public-API tour.
- `src/Bridge.ts` — file-header + Attribution section reword.
- `src/SpscRing.ts` — Schema-dispatch overhead + Attribution section reword.
- `src/experimental/BridgeWebNNSource.ts` — module-private guard comment
  reword (the prior comment cross-referenced the 0.8.11 `Float64RingBuffer`
  pattern; the new comment stands on its own).
- `bench/Bridge.bench.ts` — file header + acceptance-gate comment reword.
- `bench/e2e-latency/schema.js` — migrate to inline `defineSchema(...)`.
- `bench/e2e-latency/worklet.js` — comment reword.
- `examples/minimal/schema.js` — docstring reword.
- `tests/Bridge.concurrent.test.ts` — file-header note reword.
- `tests/BridgeBlockConsumer.test.ts` — migrate pin 8 (`'throw'` →
  caller-side wrapper); drop `'throw'` from pin 13's `policies` array.
- `package.json` — drop the legacy entries from `test` / `test:unit` /
  `test:concurrent` / `bench` scripts; add `tests/typecheck-deprecations.test.ts`
  to `test` + `test:unit`; version `0.8.12` → `0.9.0`.
- `README.md` — §Legacy API removed; underflow table + canonical schemas
  reworked; two file-link references rewritten to point at SpscRing;
  top-of-file callout reworded.
- `MIGRATION.md` — 0.9.0+ top-of-file callout added.
- `ROADMAP.md` — 0.9.0 row promoted; cohort header advanced.
- `CHANGELOG.md` — this entry.

Additions:

- `tests/typecheck-deprecations.test.ts` — four `@ts-expect-error`
  pins catching accidental re-introduction of the removed surfaces.

## [0.8.12] — 2026-05-27

### Added — `BridgeWebNNSource` experimental-status warning sharpening (pre-1.0 cohort 3/N)

Third patch of the pre-1.0 cohort plan. The WebNN adapter has lived under
`src/experimental/` since 0.7.16, with the `@experimental` JSDoc tag and a
file-header stability paragraph as the only signals. The IDE-time tag fires
in VS Code / WebStorm / etc., but anyone who imported via a non-typed path
(a transitive workspace dep, a `dist/` artifact, a CDN bundle) never saw
the warning. This patch adds the runtime backstop and spells out the
graduation criteria publicly so the experimental status has a clear end
condition rather than just an open-ended warning.

**Runtime warn.** `BridgeWebNNSource`'s constructor now emits a one-shot
`console.warn` on first construction per process load. The text:

```
[webgpu-audio-bridge] BridgeWebNNSource is experimental and outside the
1.0 stability contract. The adapter's API may break across MINOR version
bumps — and, while the WebNN spec is still moving, across PATCH releases —
until WebNN MLTensor ships in ≥ 2 stable browsers (Chrome/Firefox/WebKit)
and the spec reaches W3C Recommendation status. Track
https://www.w3.org/TR/webnn/ for spec progress; see README §Experimental
— WebNN for the full graduation criteria.
```

The module-global guard pattern matches the 0.8.11 deprecation warns: one
boolean, set on first fire, branch-skip thereafter. The
`BridgeWebNNSource.test.ts` suite constructs 15 instances; the suite now
prints one informational warn per process and no others.

The warn fires unconditionally on construction, including when the
constructor will subsequently throw the WebNN-unavailable error (the
`opts.skipAvailabilityCheck !== true && !hasMLTensor()` branch). This is
deliberate: anyone touching the experimental API at all — even via the
typed-array fallback or the `skipAvailabilityCheck` opt-out — should hear
the stability caveat, and centralizing the warn at the constructor top
keeps the guard logic simple.

**README §Experimental — WebNN rework.** The section gains:

- A **bold warning block at the top** (blockquote with ⚠️ + bold header)
  instead of an inline paragraph. The blockquote makes the experimental
  status visually unmissable for anyone skimming.
- An explicit **"When this graduates"** criteria list (three numbered
  items). The previous section spelled out the *constraint* (spec is
  volatile, browsers haven't shipped) without committing to a *trigger*
  for the experimental tag coming off; the new list closes that loop:
  1. WebNN spec at W3C Recommendation (not just Candidate Recommendation).
  2. `MLTensor` shipping unflagged in ≥ 2 of {Chrome, Firefox, WebKit}.
  3. Byte-read API (`tensor.read()` vs `context.readTensor(tensor)`)
     settles at one shape in the spec.
- The "until all three trip, the export stays under `experimental/` and
  the runtime warn fires" closing line ties the criteria back to the
  observable artifacts (subpath + warn).

The graduation-criteria language mirrors the bar `BridgeGPUSource` met
for WebGPU before it landed in the main entry — two browsers shipping
unflagged was the threshold there too, so the experimental-tag
graduation policy is consistent across both adapters.

**File-header rework.** `src/experimental/BridgeWebNNSource.ts`'s
Stability contract section gets two additions: (a) explicit "patch
releases" inclusion in the breakage window (previously the file said only
"MINOR version bumps"; the README and the runtime warn now say both, so
the file header is brought in line), and (b) a "Graduation criteria"
paragraph mirroring the README list. The class-level JSDoc is unchanged
(already had `@experimental`).

### Why

The WebNN-experimental story has had three signals (`/experimental`
subpath + `@experimental` JSDoc + file-header paragraph), but no
runtime-observable one, and no public statement of when the experimental
tag would come off. The pre-1.0 audit flagged both gaps:

- The lack of a runtime signal means a consumer who imported via a
  non-typed path doesn't learn the surface is experimental until it
  actually breaks in a future patch. The one-shot warn closes that — every
  process that constructs the class sees the caveat at least once in
  stderr, the same shape the 0.8.11 deprecation warns landed on.
- The lack of a public graduation criteria means "experimental forever" is
  the default reading. Spelling out the three-condition trigger makes the
  end state visible: someone reading the README in 2027 can check the
  three boxes themselves and predict the graduation patch.

This is the final 0.8.x patch that adjusts an experimental / deprecated
surface ahead of the 0.9.0 breaking cut. The next patches (0.8.13 + the
0.9.0 cohort) shift to bench polish and the actual removals.

### Wire compatibility

100% wire-compatible. No SAB byte layout change, no schema extension, no
public-API change. The warning is a pure runtime side-effect in the
constructor; existing code keeps compiling and keeps producing bit-
identical output. A 0.8.11 producer and a 0.8.12 consumer over the same
SAB exchange frames bit-identically; same in the reverse direction.

### Tests

All 21 suites green. No test changes — `tests/BridgeWebNNSource.test.ts`
constructs 15 instances across its 10 pins and now sees one warn per
process load (instead of zero); the assertion-based test runner ignores
stderr output. The schema validation paths + the construction gate +
both push paths all continue to assert bit-identically against the prior
implementation.

### Bench

Construction-time only effect. Per-instance overhead is one branch on a
module-private boolean after the first call; not visible in the
push/pull/pullLatest medians (~1.20 μs at N=1000 unchanged).

### Documentation

- `src/experimental/BridgeWebNNSource.ts` — file-header Stability
  contract section rewritten with patch-release breakage call-out +
  graduation criteria + the runtime-warn behavior; module-global guard
  comment added; constructor warn block added (above).
- `README.md` — §Experimental — WebNN reworked: bold blockquote
  disclaimer + numbered graduation criteria + closing tie-back line
  (above).
- `ROADMAP.md` — 0.8.12 row appended to the active table; "Beyond the
  cohort" header bumped from `0.8.12+` to `0.8.13+`.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/experimental/BridgeWebNNSource.ts` — file-header + module-private
  guard + constructor warn.
- `README.md` — §Experimental — WebNN rework.
- `ROADMAP.md` — table + speculative-header bump.
- `package.json` — version `0.8.11` → `0.8.12`.
- `CHANGELOG.md` — this entry.

## [0.8.11] — 2026-05-27

### Added — deprecation-soak pass before the 0.9.0 breaking cut (pre-1.0 cohort 2/N)

Second patch of the pre-1.0 cohort plan. Three legacy surfaces are
explicitly slated for removal at the 0.9.0 breaking cut; this patch is the
one-version deprecation soak that gives any silent vendor user a runtime
heads-up before the surface disappears.

**Deprecated surfaces (all removed at 0.9.0).**

- `Float64RingBuffer` (the pre-0.3.0 hard-coded class). Already carried a
  `@deprecated 0.3.0` JSDoc; the soak adds:
  - One-shot `console.warn` from the constructor (module-global guard, fires
    at most once per process load), pointing at the 0.9.0 removal + the
    migration path + the v0.1.x pin escape hatch.
  - `@deprecated` JSDoc updated to spell out "scheduled for removal at
    0.9.0" instead of the prior vague "no earlier than 2.0" language.
- `legacyPhysicsControlFrameSchema(n)` + `LegacyPhysicsControlFrameSchema`
  type alias. Adds `@deprecated 0.8.11 — removed at 0.9.0` JSDoc on both
  the function and the type; the function logs once on first call with
  the same module-global guard pattern. The `src/index.ts` re-export
  picks up the JSDoc via a colocated tag.
- `BridgeBlockConsumer` `underflowPolicy: 'throw'`. Constructor emits a
  one-shot `console.warn` when caller selects `'throw'`. The file-header
  "Underflow policy" docstring + the `BlockUnderflowPolicy` type
  docstring + the `BridgeBlockConsumerOptions.underflowPolicy` field
  docstring all gain explicit "deprecated at 0.8.11, removed at 0.9.0"
  notes. The arm survives at 0.8.11 (existing tests + callers still
  work, just with a warning); the implementation in `_handleUnderflow`
  is unchanged.

**One-shot guard pattern.** Each warn site uses a module-private boolean
that flips on first fire. This:

- Keeps the warning visible (anyone running a fresh test suite or a
  one-shot app sees it).
- Avoids spamming stderr in apps that construct multiple instances (the
  test suite constructs 12 `Float64RingBuffer` instances — one warning
  per process is the right cadence).
- Costs nothing at steady state (one branch on a module-private boolean
  after the first call).

**Documentation updates.**

- `README.md` §Legacy API — `Float64RingBuffer` callout reworded: removal
  schedule updated from "no earlier than 2.0" to "0.9.0", explicit
  mention of the one-shot warning, explicit mention that
  `legacyPhysicsControlFrameSchema` + `underflowPolicy: 'throw'` follow
  the same schedule. Added the `webgpu-audio-bridge@0.8.x` pin
  recommendation for users who cannot migrate in time.
- `src/index.ts` — section header comments above the legacy re-exports
  updated to spell out the 0.9.0 removal + the pin escape hatch;
  per-export `@deprecated` JSDoc tags added so IDE tooling marks
  consumer usage as strikethrough.

### Why

The pre-1.0 audit identified three legacy surfaces that should not survive
into the 1.0 stability contract:

1. `Float64RingBuffer` predates the schema DSL by two minor versions; new
   code has used `Bridge<Schema>` since 0.3.0. Carrying the legacy class
   forever inflates the 1.0 API surface, ties the byte format to the v0.1.x
   shape forever, and forces every internal refactor to keep both
   call-sites compiling.
2. `legacyPhysicsControlFrameSchema` exists *only* as the
   `Float64RingBuffer` byte-twin via `Bridge<Schema>`. With the
   `Float64RingBuffer` class going away there's no remaining motivation to
   ship an f64-via-Number schema variant — `physicsControlFrameSchema`
   (u64 seq + tMacroNs) is strictly better for new code.
3. `BridgeBlockConsumer` `underflowPolicy: 'throw'` is a footgun: an
   unhandled throw from an AudioWorklet's `process()` permanently
   terminates the processor. The arm exists in case tests want a
   strict-fail-on-underflow signal, but a test-only wrapper around the
   `'zero-fill'` policy + `underflowSamples()` counter does the same thing
   without the production-time hazard.

Per user direction the cohort plan reports zero known consumers on all
three surfaces. The 0.8.11 → 0.9.0 gap is therefore the cheap-insurance
deprecation soak — a one-version window where anyone who somehow vendored
the surface gets a console warning and a clear pin path before the
removal lands.

The decision to consolidate the three on the same 0.9.0 removal lets the
0.9.0 CHANGELOG host one migration guide rather than three, and lets the
breaking-cut commit be a single coherent diff against the slimmed surface.

### Wire compatibility

100% wire-compatible. No SAB byte layout change, no schema extension, no
public-API change. The deprecation warnings are pure runtime side-effects
in the deprecated constructors / functions; existing code keeps compiling
and keeps producing bit-identical output. A 0.8.10 producer and a 0.8.11
consumer over the same SAB exchange frames bit-identically; same in the
reverse direction.

### Tests

All 21 suites green. No test changes — the existing tests that exercise
the deprecated surfaces (`tests/Float64RingBuffer.test.ts`,
`tests/Float64RingBuffer.concurrent.test.ts`,
`tests/BridgeBlockConsumer.test.ts` for the `'throw'` arm) continue to
pass with one informational `console.warn` per process in stderr. The
deprecation messages do not affect the assertion-based test runner.

### Bench

push / pull / pullLatest medians unchanged (~1.20 μs at N=1000). The
deprecation warns fire at most once per process — no hot-path cost.

### Documentation

- `src/Float64RingBuffer.ts` — header `@deprecated` JSDoc + constructor
  warn (above).
- `src/schemas/physics.ts` — function-level `@deprecated` JSDoc + once-on-
  first-call warn + type-alias `@deprecated` tag (above).
- `src/BridgeBlockConsumer.ts` — file-header policy section, type
  docstrings, constructor warn (above).
- `src/index.ts` — re-export section comments + per-export tags (above).
- `README.md` — §Legacy API callout (above).
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/Float64RingBuffer.ts` — JSDoc + constructor warn.
- `src/schemas/physics.ts` — JSDoc + function warn.
- `src/BridgeBlockConsumer.ts` — JSDoc + constructor warn.
- `src/index.ts` — re-export annotations.
- `README.md` — §Legacy API callout.
- `ROADMAP.md` — 0.8.11 row added.
- `package.json` — version `0.8.10` → `0.8.11`.
- `CHANGELOG.md` — this entry.

## [0.8.10] — 2026-05-27

### Added — `interpolationMode` union closed at 1.0 (audit cohort, pre-1.0 prune 1/N)

First patch of the **pre-1.0 cohort plan** (see internal plan
`we-want-you-to-iridescent-reef.md`). This patch is a **commitment**, not a
code-shape change: the `TrajectoryInterpolationMode` union — `'taylor' |
'hermite'` — is now declared closed at 1.0. A future quintic-Hermite path
that consumes acceleration at both endpoints for full C² continuity is
explicitly deferred to **1.x** as a separate `'quintic-hermite'` value,
landing via an additive minor bump rather than an in-place widening of the
1.0 union.

The additive-name shape lets 1.0 consumer `switch` statements stay
exhaustive without a default branch; a 1.x consumer that fails to handle the
new arm sees a compile error rather than silent fall-through.

**Documentation updates.**

- `src/schema.ts` — `TrajectoryInterpolationMode` JSDoc gains a "Stability
  commitment (0.8.10 → 1.0)" paragraph spelling out the closure rule and the
  rationale (exhaustive `switch` over default branch).
- `src/schema.ts` — `TrajectoryArrayOptions.overflowFallback` field gains an
  inline silent-equivalence note: `'linear'` collapses to `'saturate'` on
  `order=1` and `order=2` (no acceleration term to drop), so the distinction
  only matters at `order=3`. Audit-surfaced footgun made explicit at the
  call-site rather than only in the implementation comments.
- `src/schema.ts` — `TrajectoryArrayOptions.interpolationMode` field gets a
  matching docstring pointing at the 1.0 closure rule.
- `src/schema.ts` — `TrajectoryOverflowFallback` type JSDoc reworded to
  surface the same silent-equivalence note.
- `src/trajectory.ts` — file-header Hermite section gains the "union closed
  at 1.0; quintic deferred to 1.x as additive name" paragraph. The
  cubic-Hermite implementation's "future quintic plan" inline comment is
  rewritten to point at the additive-minor-bump path explicitly rather than
  leaving the timing ambiguous.
- `README.md` — §Trajectory arrays gains a new paragraph documenting the
  `interpolationMode` field, the closure-at-1.0 commitment, and the
  rationale. Also folds the silent-equivalence note for
  `overflowFallback: 'linear'` into the existing fallback-semantics
  sentence.

### Why

The pre-1.0 audit identified `interpolationMode` as one of the public
surfaces where the 1.0 stability contract had not been spelled out. The
union accepts `'taylor' | 'hermite'` today, and the cubic-Hermite
implementation has a `// future quintic plan` comment in
`src/trajectory.ts` — but nothing in the public docs or the type-level
declaration tells a consumer whether quintic would be added by widening the
current union (which would break exhaustive `switch` statements) or by
adding a new name (which would not).

Closing the union now, explicitly, makes the answer non-negotiable at 1.0:
consumer code that does `switch (spec.interpolationMode)` with the two
current arms is safe forever — a quintic arm lands at a separate name with a
TypeScript-visible additive bump, so the compiler tells the consumer they
need to extend their switch.

The silent-equivalence note on `overflowFallback: 'linear'` is the same
shape of fix: the behavior was correct (the implementation deliberately
falls through to saturate when there's nothing to drop), but the public docs
described `'linear'` as "drops the acceleration term" without spelling out
what happens when there is no acceleration term to drop. Making the
collapse explicit at the call-site removes a possible "I picked `'linear'`
on order=2 and got the same result as `'saturate'` — is that a bug?"
support question.

### Wire compatibility

100% wire-compatible. No SAB byte layout change, no schema extension, no
public-API change to `Bridge<S>`, the schema DSL, or any composable
primitive. Pure documentation patch — the type declaration
`TrajectoryInterpolationMode = "taylor" | "hermite"` was already in this
exact shape at 0.7.3 (`src/schema.ts:224`); this patch is the public
commitment that it will stay that shape through 1.0.

### Tests

All 21 suites green (count unchanged from 0.8.7). No test changes — the
existing trajectory + schema tests already pin the closed-union shape via
the schema-construction error path (`tests/schema.test.ts` rejects
unknown `interpolationMode` values) and the cubic-Hermite implementation
(`tests/Bridge.trajectory.test.ts`).

### Bench

push / pull / pullLatest medians unchanged (~1.20 μs at N=1000). The
trajectory evaluator's fast + clamped paths are bit-exact equal to 0.8.7;
no code path moved.

### Documentation

- `src/schema.ts` — type-level docstrings + field docstrings.
- `src/trajectory.ts` — file-header Hermite section + inline comment.
- `README.md` — §Trajectory arrays.
- `CHANGELOG.md` — this entry.

### Patch surface

- `src/schema.ts` — three docstring edits.
- `src/trajectory.ts` — two header-comment edits.
- `README.md` — one paragraph add + one inline note.
- `ROADMAP.md` — 0.8.10 row promoted to `✅ shipped`; speculative
  section heading updated `0.8.10+` → `0.8.11+`; one-paragraph note
  on out-of-order ship vs 0.8.8 / 0.8.9.
- `package.json` — version `0.8.7` → `0.8.10`.
- `CHANGELOG.md` — this entry.

## [0.8.7] — 2026-05-27

### Added — first npm publish + `webgpu-audio-bridge dev` CLI (audit cohort, product-polish 2/4)

Seventh patch of the audit cohort, second slice of the product-
polish sub-cohort. The cohort's ship moment: the package is on npm
as `webgpu-audio-bridge@0.8.7`, and the bundled CLI gives downstream
consumers a one-command zero-config dev server with the COOP/COEP
headers SharedArrayBuffer requires. No production library code
change — additive only.

**New CLI: `npx webgpu-audio-bridge dev`.**

- `bin/webgpu-audio-bridge.mjs` — new file (~180 lines). Node ESM,
  shebang, no transpile, zero runtime deps beyond Node core
  (`node:http`, `node:fs/promises`, `node:path`). Wired into npm's
  bin shim via `package.json` `"bin"`; available as
  `npx webgpu-audio-bridge dev` after install.
- Arguments: optional positional `path` (default `process.cwd()`),
  `-p` / `--port` (default `5173`, also `--port=N`), `-h` / `--help`,
  `-v` / `--version`. The leading `dev` subcommand is accepted (so
  both `npx webgpu-audio-bridge dev .` and `npx webgpu-audio-bridge
  .` work) — `dev` is the only subcommand and it's the default, but
  keeping the keyword reserves room for future siblings (`build`,
  `verify`, etc.) without a breaking change.
- Every response carries the three-header set used by the existing
  `examples/*/serve.mjs` files:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Cross-Origin-Resource-Policy: same-origin`
  Plus `Cache-Control: no-store` so the dev cycle never serves a
  stale file. Path-traversal safety: requests are normalized and
  containment-checked against the resolved root before any `stat` /
  `readFile`. Missing files yield 404; non-directory roots, missing
  roots, and `EADDRINUSE` exit with a clear message and a non-zero
  exit code.
- MIME table covers the file types the bridge's own demos serve
  (`html` / `js` / `mjs` / `css` / `json` / `wgsl` / `map` / `wasm`
  / image kinds / `txt`); unknowns fall through to
  `application/octet-stream`.

**`package.json` updates.**

- Version `0.8.6` → `0.8.7`.
- New `"bin": { "webgpu-audio-bridge": "./bin/webgpu-audio-bridge.mjs" }`.
- `"files"` array gains three entries: `bin`, `QUICKSTART.md`,
  `ROADMAP.md`. The two MD files were a 0.8.6 oversight (the docs
  patch added the files but didn't update `"files"`); fixed here so
  the npm tarball ships them — otherwise README's relative-link
  cross-references would silently degrade on the npm package page.
- `"prepublishOnly"` (already present) ensures the publish is gated
  on `typecheck && test && build`.

**Documentation updates.**

- `QUICKSTART.md` — `npm install webgpu-audio-bridge` line drops the
  `(once 0.8.7 publishes)` gloss; new four-line snippet at the
  AudioWorklet section shows the CLI usage
  (`npx webgpu-audio-bridge dev .`, `-p 8080`).
- `README.md` — §Quick start line rewritten: install is now the
  plain `npm install`, and a one-sentence CLI mention is folded in.
  §Enabling Turbo mode's CLI paragraph is updated from the
  speculative "(lands at 0.8.7)" form to the present-tense `npx
  webgpu-audio-bridge dev [path] [--port N]` description.
- `ROADMAP.md` — 0.8.7 slot flipped from `queued` to `✅ shipped`.

### Why

Three converging concerns:

1. **npm publish is the ship moment.** The audit cohort has been
   building toward "the package is `npm install`-able" since 0.8.0;
   `prepublishOnly`, the `"main"` / `"types"` / `"exports"`
   triple-entry shape, the `"files"` allowlist, and the polished
   README + QUICKSTART + ROADMAP were all in place by end of 0.8.6.
   What was missing was (a) the bin script the README had been
   promising since 0.7.1, and (b) the npm-side push of the bits.
   Bundling them into one patch keeps the public surface coherent:
   the first version a `npm view webgpu-audio-bridge` returns is the
   version that has the CLI it advertises.

2. **CLI removes the COOP/COEP friction point.** New users
   following the QUICKSTART hit a wall the first time they try to
   construct a `Bridge<S>` in the browser without isolation
   headers — `crossOriginIsolated` returns false and SAB either
   throws or silently degrades. The existing
   `examples/*/serve.mjs` files solve this for the bundled demos
   but downstream consumers had to copy-paste the boilerplate.
   Shipping it as a bin script means "I tried it and it didn't
   work" becomes a 30-second fix (`npx webgpu-audio-bridge dev`)
   instead of an hour spent learning the COOP/COEP / CORP /
   isolation triangle.

3. **The CLI shape is a public commitment.** `npx
   webgpu-audio-bridge dev [path] [--port N]` is the public
   contract from this version forward. The argument shape was
   chosen to match the existing serve.mjs conventions (port 5173
   default to mirror Vite + the existing `dev:demo`), to accept
   both short + long flags (`-p` / `--port`) per CLI ergonomics
   norms, and to reserve the subcommand keyword (`dev`) for future
   non-breaking additions. The implementation is intentionally
   minimal — argument parsing is a hand-rolled walk, no
   `commander` / `yargs` / `serve-static` dependencies — so the
   tarball stays lean and there's no transitive supply-chain
   surface.

### Wire compatibility

100% wire-compatible. No SAB byte layout change, no schema
extension, no public-API change to `Bridge<S>` or the composable
primitives. The CLI is a separate ESM script that never imports
the library; it's an out-of-process static server. A 0.8.6
producer and a 0.8.7 consumer over the same SAB exchange frames
bit-identically.

### Tests

All 21 suites green (count unchanged from 0.8.6):

- `tests/schema.test.ts`
- `tests/Bridge.core.test.ts` / `Bridge.smoother.test.ts` /
  `Bridge.invariant.test.ts` / `Bridge.pll.test.ts` /
  `Bridge.trajectory.test.ts` / `Bridge.backpressure.test.ts` /
  `Bridge.observability.test.ts` / `Bridge.facades.test.ts` /
  `Bridge.properties.test.ts`
- `tests/BridgeFacades.test.ts` / `BridgeInputLane.test.ts` /
  `BridgeBlockConsumer.test.ts` /
  `BridgeGPUSource.writeTarget.test.ts` /
  `BridgeWebNNSource.test.ts`
- `tests/environment.test.ts` / `Bridge.phaseLock.test.ts` /
  `Bridge.wasmEquivalence.test.ts`
- Concurrent: `Bridge.concurrent.test.ts` /
  `Float64RingBuffer.test.ts` / `Float64RingBuffer.concurrent.test.ts`

No new test files. The CLI is a separate ESM script that runs in
its own Node process; it is exercised through a smoke test (start
the server, fetch `localhost:<port>`, confirm 200 + the three
isolation headers) rather than through the unit-test runner. A
future patch may add a Playwright cell that drives a real demo
end-to-end through the CLI for regression coverage; the current
patch leaves that to the consumer-side wavefunction migration
(0.8.8) which exercises the same path.

### Bench

push / pull / pullLatest medians unchanged (~1.20 μs at N=1000;
~67 ns / ~67 ns / ~69 ns per op). The CLI does not touch library
code, so no perf delta is expected; the bench is run as a sanity
check, not because the patch can plausibly regress it.

### Documentation

- `QUICKSTART.md` — install + CLI usage updated (above).
- `README.md` — §Quick start + §Enabling Turbo mode lines updated
  to present-tense CLI mentions (above).
- `ROADMAP.md` — 0.8.7 slot flipped to shipped (above).
- **Website twin migration follow-up (recommended, not required).**
  Once 0.8.7 is on npm, the website twin at
  `..\NewProject\website\package.json` can switch its dep from
  `"webgpu-audio-bridge": "file:../../webgpu-audio-bridge"` to
  `"webgpu-audio-bridge": "^0.8.7"`. That's a one-line change in
  the website repo, not part of this patch; it can land alongside
  the 0.8.8 wavefunction migration which is the next cross-repo
  patch in the cohort.

### Patch surface

- `bin/webgpu-audio-bridge.mjs` — new.
- `package.json` — version + `bin` + `files`.
- `QUICKSTART.md` — two edits.
- `README.md` — two edits.
- `ROADMAP.md` — one edit.
- `CHANGELOG.md` — this entry.

## [0.8.6] — 2026-05-27

### Added — documentation polish (audit cohort, product-polish 1/4)

Sixth patch of the audit cohort, first slice of the product-polish
sub-cohort (0.8.6 docs → 0.8.7 publish + CLI → 0.8.8 wavefunction
migration + telemetry overlay → 0.8.9 example demo). No production
behavior change; touches two source files for annotation-only
polish (@experimental JSDoc tags + EnvironmentReport divider
comment + one stale anchor URL fix).

**New top-level docs.**

- `QUICKSTART.md` — new file. 5-minute hello-frame walkthrough.
  Install → main-thread schema + push + pull → worker producer →
  pointer to README's AudioWorklet pattern + `examples/minimal/`.
  Self-contained doorway; README's Quick start section now points
  here for the warm-up and keeps the AudioWorklet consumer
  pattern + Enabling Turbo mode for the long-form view.
- `ROADMAP.md` — new file. Extracts the prior README §Roadmap into
  a standalone doc, adds the 0.8.x audit-cohort slot table (the
  clean version-only view without remapping noise), the post-cohort
  parking lot (`BridgeReader`, WebNN MLTensor zero-copy, cache-line
  padding, second consumer surface), and an explicit "1.0 trigger"
  section restating the CLAUDE.md extended-slowdown rule for the
  public eye. README's §Roadmap is now a short pointer block to
  `ROADMAP.md` + `CHANGELOG.md`.

**README rework.**

- New **§Frame layout** section between §Quick start and §API
  reference. Annotated ASCII diagram of the 8-lane Int32 header
  (write_index / read_index / flow_scale / torn_frame /
  pll_offset lo+hi / pll_drift / pll_status) + the
  `capacity × frameByteSize` payload region. Reader can now map
  `src/Bridge.ts` lane references to the actual SAB byte layout
  without reading source.
- New **§Frame layout / Schema field types — number vs BigInt**
  cheat sheet. Per-type table: u8/i8/.../u32/i32/f32/f64 stay
  `number` (zero allocation in hot loops); u64/i64 carry the
  per-access `bigint` allocation tax. Cross-references the 0.8.2
  BigInt-free PLL publish path as the design rule of thumb.
- §Quick start trimmed from ~115 lines to ~50 lines. The
  hello-frame and worker producer slices moved to `QUICKSTART.md`;
  the AudioWorklet consumer pattern and §Enabling Turbo mode stay
  (the unique value-add the library exists to make easy).
- H2 version parentheticals stripped on shipped features:
  `## BridgeGPUSource (0.6.18)` → `## BridgeGPUSource`,
  `## Achieving pro-audio tracking latency (0.6.19)` → `…`,
  `## Audio-rate mode (0.7.13 / 0.7.14)` → `…`,
  `## Experimental — WebNN (0.7.16 / 0.7.17)` → `…`. The features
  are the headings; the version history lives in `CHANGELOG.md` /
  `ROADMAP.md`. Cross-references updated (lines that linked
  `#bridgegpusource-0618` etc. now link `#bridgegpusource`).
- `### Zero-copy roadmap (0.7.15)` renamed to
  `### Zero-copy readback — scaffold (0.7.15)` — the section is the
  scaffold for a future feature, not the feature itself, and the
  rename matches the `(scaffold)` marker pattern from CLAUDE.md.
- Two stale dangling anchors removed: `#deploying-behind-a-real-host`
  (never written) referenced at §Two transport tiers and §Enabling
  Turbo mode — replaced with a short inline mention of the
  COOP/COEP headers being universal across hosts.
- "coming in 0.7.5" / "coming in 0.8.x" inline annotations on
  shipped + reserved features updated. Where the parenthetical was
  date-of-introduction noise, it dropped; where it referred to a
  not-yet-shipped feature (Standard mode, npx CLI), the wording is
  pinned to its reserved slot ("reserved at 0.8.0", "lands at 0.8.7").

**Deferred polish (carry-over from Post-0.8.1 §Thread B).**

- **`@experimental` JSDoc tags** added to the four public exports
  in `src/experimental/BridgeWebNNSource.ts`: `MLTensorLike`,
  `WebNNTensorReader`, `BridgeWebNNSourceOptions`, and
  `BridgeWebNNSource` class itself. Going-forward convention chosen
  is `@experimental` (industry-standard); pre-0.8.6 the file had no
  per-symbol tags at all, so this is the first sweep — IDE tooltips
  on those symbols now show the badge.
- **`EnvironmentReport` divider comment.** Added a
  `// ── Experimental capability flags (0.7.15+) ──` section block
  above the `webgpuZeroCopy` / `webnn` / `mlTensor` cluster.
  **Shape unchanged** (the fields stay flat, not nested under
  `experimental: { ... }`) so consumer code is zero-impact; the
  block is purely visual grouping. Field declaration order within
  the `EnvironmentReport` interface, the internal `FeatureFlags`
  interface, and the runtime construction object literal were all
  re-synced so JSON output and IDE-rendered docs reflect the
  experimental grouping (no behavior change; pure cosmetic).
- **One stale anchor fix in `src/environment.ts`.** The
  `missing-web-midi` fix's `docUrl` pointed at
  `…#achieving-pro-audio-tracking-latency-0619`; updated to
  `…#achieving-pro-audio-tracking-latency` to match the H2
  stripped above.

**Patch surface.**

- `QUICKSTART.md` — new.
- `ROADMAP.md` — new.
- `README.md` — 1,575 → 1,519 lines (net −56). One new H2 (§Frame
  layout); two H2s stripped of version suffixes; one H3 renamed
  for scaffold marking; §Quick start trimmed; §Roadmap replaced
  with a pointer block.
- `CHANGELOG.md` — this entry.
- `package.json` — version 0.8.5 → 0.8.6.
- `src/experimental/BridgeWebNNSource.ts` — four new
  `@experimental` JSDoc tags.
- `src/environment.ts` — divider comment + field re-ordering +
  one anchor URL.

### Why

Three concerns coordinated into one patch:

1. **README scale.** At 1,575 lines the README had crossed into
   "no one reads top-to-bottom" territory. Two-thirds of a
   newcomer's first hour can be lost to the §Roadmap shipped-list
   reading, which is genuinely historical context. The
   `QUICKSTART.md` doorway + `ROADMAP.md` extract reduces what
   the README is responsible for to the present-tense product
   surface (architecture, frame layout, API reference, the
   `BridgeGPUSource` / fast-lane / audio-rate stacks, performance
   numbers, back-pressure, prior art) — the past and the future
   live in dedicated files.

2. **The version parentheticals are noise on shipped features.**
   `## BridgeGPUSource (0.6.18)` reads as "this feature is from
   0.6.18, which is some way back, so maybe it's not current."
   The 0.6.18 date is real history but it belongs in
   `CHANGELOG.md`, not in every cross-reference. Stripping the
   parentheticals also lets us strip the dangling anchor problem
   (`#deploying-behind-a-real-host` pointed at nothing).

3. **First public docs view.** The 0.8.7 npm publish is the next
   patch. Whatever the README + `QUICKSTART.md` + `ROADMAP.md`
   look like the day before publish IS what the npm registry
   serves on the package page. Landing the docs polish in 0.8.6
   keeps publish-day risk to "ship the bin script + update the
   `package.json` files array" rather than "ship the bin script
   AND do a docs rework AND audit the tarball" all at once.

### Wire compatibility

100% wire-compatible. No SAB byte layout change, no schema
extension, no public-API change to `Bridge<S>` or the composable
primitives. The `@experimental` tags + the `EnvironmentReport`
divider comment + the field-order re-sync are pure metadata;
runtime behavior of `getEnvironmentReport()` is bit-identical to
0.8.5 on every input (same suggestedMode, same fixes, same flag
values). A 0.8.5 producer and a 0.8.6 consumer over the same SAB
exchange frames bit-identically.

### Tests

All 21 suites green (count unchanged from 0.8.5):

```
schema / Bridge.core / Bridge.smoother / Bridge.invariant /
Bridge.pll / Bridge.trajectory / Bridge.backpressure /
Bridge.observability / Bridge.facades / Bridge.properties /
BridgeFacades / BridgeInputLane / BridgeBlockConsumer /
BridgeGPUSource.writeTarget / BridgeWebNNSource / environment /
Bridge.phaseLock / Bridge.wasmEquivalence / Bridge.concurrent /
Float64RingBuffer / Float64RingBuffer.concurrent
```

`tests/environment.test.ts` checks docUrls for non-empty +
URL-parseable, not for specific anchor strings, so the
`achieving-pro-audio-tracking-latency` rename is fine. JSON
round-trip pin (#10) also passes unchanged — the property re-
ordering is insertion-order-preserved by `Object.freeze`.

### Bench

Push / pull / pullLatest medians unchanged at ~1.20 μs (no
production code paths touched). `trajEval (fast)` still 1.20 μs
within budget; `flow_scale recovery` still 33 cycles within the
100-cycle envelope.

### Documentation

This patch IS the documentation patch — see §Added above for
each new file (`QUICKSTART.md`, `ROADMAP.md`), the README rework
shape (new §Frame layout, trimmed §Quick start, stripped H2
parentheticals, renamed Zero-copy scaffold, removed dangling
anchors), and the deferred-polish annotation items
(`@experimental` JSDoc tags, EnvironmentReport divider comment,
one anchor URL fix in environment.ts).

## [0.8.5] — 2026-05-27

### Added — `tests/Bridge.test.ts` 8-way feature-file split (audit cohort, testing-infra 3/3)

Fifth patch of the audit cohort, third and final slice of the
testing-infrastructure sub-cohort. Mechanically splits the
single 5,736-line `tests/Bridge.test.ts` (93 test functions
covering pins 1–92) into eight feature files. No production code
touched; no behavior change; pin numbers preserved verbatim in
the new section comments so `git log -L` / `git blame` traverse
the split cleanly.

**New file.** `tests/_bridgeHelpers.ts` — shared helpers extracted
from the old file's preamble + the inline invariant-fixture block:

- `mulberry32(seed)` — deterministic PRNG for fuzz pins.
- `PhysFrame` / `makePhysFrame(seq, n)` / `emptyPhysFrame(n)` /
  `framesEqual(a, b)` — physics-schema fixture builders shared
  by every split file that touches `physicsControlFrameSchema`.
- `makeInvariantSchema()` / `InvFrame` / `makeInvFrame(seq, vEff)`
  / `emptyInvFrame()` — `withInvariant` fixture used by the
  invariant-classifier pins (#34–40, 48, 54) AND the
  softFrames/stallRecoveries observability pins (#88–89). The
  invariant block was previously inline at the top of the
  invariant test cluster (lines 1693–1727 of the old file); it
  moved into the shared helper to avoid duplicating it across
  two split files.

Per-pin fixture builders that don't cross file boundaries stayed
local to their tests (per the handoff guidance — don't extract
beyond what's necessary).

**The 8 split files** — pin layout follows the audit-plan table
(handoff Post-0.8.4 §"What's next — 0.8.5"). Pin 3 in the
file-header docstring is compound (covers both `testEmptyPull` and
`testFullPush` — the second function counts toward core's 18-
function total even though the pin range advertised is 1–17):

| File | Function count | Pins | Topic |
|---|---|---|---|
| `tests/Bridge.core.test.ts` | 18 | 1–17 | Construction, allocate, FIFO, wrap, mixed-type schema, Int32-boundary algebra |
| `tests/Bridge.smoother.test.ts` | 13 | 18–27, 47, 55, 91 | α-smoother math, integer round, float-array blend, trajectory interop, catch-up policy, per-instance heap state |
| `tests/Bridge.observability.test.ts` | 17 | 28–33, 49, 69–71, 84–90 | Flow_scale PI controller, end-to-end latency, push/pull/skip counters, wait durations, subscribeTelemetry, soft/stall counters, BridgeGPUSource introspection |
| `tests/Bridge.invariant.test.ts` | 9 | 34–40, 48, 54 | `.withInvariant` round-trip, hard/soft/threshold classification, trajectory × invariant interop, epsilon floor |
| `tests/Bridge.pll.test.ts` | 16 | 41–43, 50–53, 72–79, 92 | Cold-start, convergence, step + reset + validation, timestamp role / sample-rate / unit conversion, Mahalanobis outlier gate, drift estimator, lane 4-5 publication, BigInt-free encoding boundary |
| `tests/Bridge.trajectory.test.ts` | 9 | 44–46, 56–60, 80 | `evaluateInto` round-trip, validation, clamps (velocity / acceleration / hold / saturate), clamp-free bit-exact, `forEachSampleInQuantum` |
| `tests/Bridge.backpressure.test.ts` | 7 | 64–68, 82–83 | Policy reject / drop-newest / drop-oldest / block fast-path / block timeout, drop-oldest CAS-commit pull bit-exact, drop-oldest pullLatest skipped accounting |
| `tests/Bridge.facades.test.ts` | 4 | 61–63, 81 | FrameSmoother / ConsumerClockRecovery / AdaptiveFlowController unit construction, BridgeGPUSource orchestration |

Each split file:
- Imports only the symbols its body actually references (the
  TypeScript `noUnusedLocals` gate enforces this).
- Preserves the original `// ── N. <title> ──...` section comment
  verbatim above each test function so `grep -n "// ── 91"` still
  finds the per-instance-heap-state pin (now in
  `Bridge.smoother.test.ts`).
- Owns a per-file `main()` that calls every test in pin-number
  order and prints `\nAll <topic> tests passed.` on success. The
  three async pins (#81 `testBridgeGpuSourceOrchestration`, #84–87
  the four `subscribeTelemetry*` pins, #90
  `testBridgeGpuSourceIntrospection`) land in files whose `main()`
  is also async (`Bridge.facades.test.ts` and
  `Bridge.observability.test.ts`).

**Patch surface (testing-infrastructure only):**

- `tests/Bridge.test.ts` — deleted.
- `tests/Bridge.core.test.ts` — new (679 lines, 18 functions).
- `tests/Bridge.smoother.test.ts` — new (741 lines, 13 functions).
- `tests/Bridge.observability.test.ts` — new (1,081 lines, 17 functions).
- `tests/Bridge.invariant.test.ts` — new (625 lines, 9 functions).
- `tests/Bridge.pll.test.ts` — new (1,233 lines, 16 functions).
- `tests/Bridge.trajectory.test.ts` — new (614 lines, 9 functions).
- `tests/Bridge.backpressure.test.ts` — new (375 lines, 7 functions).
- `tests/Bridge.facades.test.ts` — new (376 lines, 4 functions).
- `tests/_bridgeHelpers.ts` — new shared helper module.
- `package.json` — `test` and `test:unit` scripts updated:
  single `tsx tests/Bridge.test.ts` invocation replaced with eight
  sequential invocations in feature-grouped order
  (core → smoother → invariant → pll → trajectory → backpressure →
  observability → facades), preserving the
  `tests/Bridge.properties.test.ts` position (now after
  `Bridge.facades.test.ts`).

### Why

The single 5,736-line file was the largest unit in the test
directory by ~5× and the largest in the repo by ~5×. Every audit
in 0.7.x → 0.8.x noted it as a code-organization regression
relative to the surrounding files (`schema.test.ts`,
`Bridge.phaseLock.test.ts`, etc.) that already follow one-file-
per-topic. Concrete wins from the split:

- **Faster feedback during local development.** Running a single
  topic's suite (e.g. `npx tsx tests/Bridge.smoother.test.ts`)
  finishes in ~50 ms vs the previous file's ~750 ms. When
  iterating on smoother behavior you stop paying for the PLL +
  trajectory + observability pins per cycle.
- **Topic-scoped review surface.** A PR that touches
  `src/FrameSmoother.ts` now has a single test file in its diff
  (`tests/Bridge.smoother.test.ts`), not the whole monolith.
- **Pin discovery via filename.** "Where is pin #62?" used to
  require knowing it lived in `Bridge.test.ts` at line 3656; now
  the topic groupings let you guess (62 ≈ ConsumerClockRecoveryUnit
  ≈ facades file).
- **Test parallelization headroom.** Sequential `&&` chains stay
  in `package.json`'s `test` script for now (the order matters
  for the post-build:wasm step), but the 8 split files can each
  run in parallel under a future runner change without coordinating
  shared state — they're independently rooted.

The split is mechanical: no test logic changed. The
`tests/_bridgeHelpers.ts` extraction is the only behavioral
delta, and it's strictly a function move (the original definitions
were inline at the top of `Bridge.test.ts` and inline at the
invariant cluster).

**Closes the testing-infrastructure sub-cohort.** With 0.8.3
(flake fix), 0.8.4 (property pins), and 0.8.5 (file split) all
landed, the audit cohort's testing-infra slice is complete. The
remaining audit-cohort patches (0.8.6 documentation polish, 0.8.7
npm publish + CLI, 0.8.8 wavefunction migration, 0.8.9
Aubry-André example) touch product surface rather than test
infrastructure.

### Wire compatibility

**100% wire-compatible.** No production code touched; no SAB
layout, schema, or public-API change. A 0.8.4 consumer and a
0.8.5 consumer over the same SAB exchange frames bit-identically.

### Tests

21 suites green (previously 14; 8 new from the split + same 14
from before − 1 from `Bridge.test.ts` deletion = 21). Each split
file's `main()` prints its own `\nAll <topic> tests passed.`
banner so failures are localized to the offending feature.

Test-function counts per file: 18 / 13 / 17 / 9 / 16 / 9 / 7 / 4
(core / smoother / observability / invariant / pll / trajectory /
backpressure / facades) = 93 functions total. The handoff's
expected "92 pins" was off-by-one due to the file-header pin 3
being compound (`testEmptyPull` + `testFullPush` both count
toward core); the split preserves both functions in
`Bridge.core.test.ts` with their original `// ── 3.` / `// ── 5.`
section comments intact for git-blame.

**Pre-existing in-file labeling quirk preserved.** The old
`Bridge.test.ts` had two adjacent section comments both labeled
`// ── 15.` (lines 925 + 963 of the pre-split file: pin 14
"Mixed-type schema" and pin 15 "Wrap across Int32 sign boundary"
respectively, with the first comment carrying a pre-existing
typo). The split preserves both comments verbatim — fixing the
typo would change a line whose content has been stable since the
0.4.x cohort and break `git blame` on that line. Future readers
greping for "pin 14" should also try "pin 15" if the topic
matches mixed-type schemas.

### Bench

No production code touched; no bench changes. Push 1.20 μs, pull
1.20 μs, pullLatest 1.20 μs medians unchanged from the 0.8.4
baseline. Trajectory eval and flow_scale recovery cells also
unchanged.

### Documentation

CHANGELOG entry above. README untouched (the split changes test
file names but no public API). Each split file's header docstring
lists only the pins it owns, with `tests/Bridge.test.ts` (in
0.8.4) referenced as the source for the original combined per-pin
descriptions — that's where to look for the full multi-line
explanation of any pin until the next time someone audits each
split file's header.

## [0.8.4] — 2026-05-27

### Added — fast-check property pins for FrameSmoother / trajectory / PLL (audit cohort, testing-infra 2/3)

Fourth patch of the audit cohort, second slice of the testing-
infrastructure sub-cohort (0.8.3 was the concurrent flake fix;
0.8.5 will be the 92-pin `Bridge.test.ts` 8-way split). Adds a
property-based test layer for the three extracted math units that
the 0.6.9 seam split out of `Bridge.ts`.

**New devDep.** `fast-check ^4.8.0` — the first new devDep since
`wabt` in 0.7.5. Adds 2 transitive packages and ~150 KB to the dev
install footprint. No runtime dep change.

**New file.** `tests/Bridge.properties.test.ts` (9 property pins,
~530 LOC). Each pin states an algebraic invariant the unit must
satisfy and lets fast-check sweep a large random input space for
counterexamples. fast-check shrinks failing cases to a minimal
counterexample, which is the headline reason for adding a
property-based layer alongside the existing example-based pins —
when (not if) a regression hits, the counterexample surfaces at
human-readable size rather than buried inside a long fuzz log.

Pin layout (P1–P9 locally; numbered separately from `Bridge.test.ts`
1–92 so the two files' pin spaces don't collide):

- **FrameSmoother (P1–P3):**
  - P1. `α = 1 ⇒ out === curr` (float-lane idempotence). For any
    random `curr` frame and any prev state, observing at α = 1
    leaves the float fields bit-identical to curr (the
    `(1 − α) · prev = 0` term is exactly 0 for any finite prev in
    IEEE 754, so `1 · curr + 0 = curr` exact). BigInt + integer
    lanes also bit-exact.
  - P2. Monotonic convergence at α ∈ (0, 1). Observing a constant
    `curr` repeatedly through a smoother seeded with a different
    prev drives `|out − curr|` monotonically toward 0 across 50
    iterations. Per-iter slack is `1e-9 · |curr − prev| + 1e-12`
    to absorb single-ulp rounding.
  - P3. `seedFrom(s) + observe(s, α) ≈ s` for any α. The blend
    `α · s + (1 − α) · s` algebraically equals `s`, but the float
    path carries ~4 ulps of rounding error (each multiply rounds
    independently; the sum rounds once more). Integer + BigInt
    lanes are bit-exact. Pin uses an `ulpClose` helper:
    `tolerance = 4 · 2^-52 · |s| + 1e-300` so subnormal inputs
    also pass.

- **Trajectory evaluator (P4–P6):**
  - P4. order = 1 ignores dt. For any flat positions array and
    any finite dt, `out[i] === flat[i]` bit-exact.
  - P5. order = 2 is linear in dt. For any flat `[p, v, ...]` and
    any dt1, dt2 in [0, 1e3]:
    `eval(dt1 + dt2) − eval(0) === (eval(dt1) − eval(0)) + (eval(dt2) − eval(0))`
    within a ~1e-6 relative slack on the per-sample products.
    Inputs bounded to [-1e3, 1e3] so the products stay in safe
    f64 precision range.
  - P6. order = 3 matches the documented closed form
    `out[i] = p + v · dt + 0.5 · a · dt²` element-wise. The
    evaluator hoists `halfDt2 = 0.5 · dt · dt` and the test
    computes the closed form inline; both shapes carry the same
    three multiplies in different orders, so a 1-ulp relative
    slack is allowed.

- **ConsumerClockRecovery (P7–P9):**
  - P7. First observe seeds offset exactly. For any finite
    (consumerNs, producerNs), a fresh PLL's
    `observe(c, p)` sets `offsetNs === p − c` bit-exactly,
    `locked === true`, and `phaseLockedTime(x) === x + (p − c)`
    for any x.
  - P8. `phaseLockedTime` is identity when unlocked. Two paths
    covered: fresh PLL (never observed) and observed-then-reset.
    Both must return the consumerNs argument unchanged.
  - P9. Bounded jitter ⇒ bounded offset estimate. With true
    offset T and uniformly-distributed producer-side jitter
    `|ε| ≤ J`, after 200 observations at 60 Hz cadence the
    estimate stays within `5 · J + 1e-6` of T (KP^-1 = 5
    establishes the envelope; the 1e-6 floor covers the J = 0
    case). Sweeps T ∈ [-1e9, 1e9] ns and J ∈ [0, 1e6] ns. A
    deterministic mulberry32 PRNG seeded by a fast-check input
    so each (T, J) reproduces its jitter sequence.

**Patch surface (testing infrastructure only):**

- `package.json` — `fast-check ^4.8.0` added to devDependencies;
  `test` + `test:unit` scripts updated to run
  `tests/Bridge.properties.test.ts` immediately after
  `tests/Bridge.test.ts` so a property-level regression surfaces
  before the suites that compose them.
- `tests/Bridge.properties.test.ts` — new file (9 pins).

### Why

Property-based pins complement the hand-rolled example pins
`testFrameSmootherUnit` / `testConsumerClockRecoveryUnit` (#61–63
in `Bridge.test.ts`) and the trajectory pins #44–#46 / #56–#60.
The example pins assert specific numeric values at specific
inputs and catch regressions in those exact cases; the property
pins assert algebraic invariants and catch regressions in input
ranges the example pins don't reach. Both layers stay — the
property layer is purely additive.

A practical example surfaced during landing: P3's first iteration
asserted bit-exact equality of `seedFrom(s) + observe(s, α)`
against `s` on the float lane. fast-check shrunk to a 4-input
counterexample with a subnormal-tiny `s` (1.66e-17) where the
two-multiply blend differs from `s` by a single ulp — the example
pins had never exercised subnormals so this drift was invisible.
The property-pin tightening (allowing 4 ulps of slack) makes the
behavior contract explicit.

This is the second of three testing-infra patches. 0.8.5 splits
the 92-pin `Bridge.test.ts` into 8 feature files. The split is
mechanical but large; landing the property layer first means the
split inherits both a flake-free and an algebraically-pinned
gate.

### Wire compatibility

**100% wire-compatible.** No production code touched; no SAB
layout, schema, or public-API change. A 0.8.3 consumer and a
0.8.4 consumer over the same SAB exchange frames bit-identically.

### Tests

14 suites green (previously 13 — `Bridge.properties.test.ts`
added). Pin counts in `Bridge.test.ts` (92) and
`BridgeInputLane.test.ts` (11) unchanged.

`Bridge.properties.test.ts` pin counts: 9 property pins, each
running fast-check's default 100 random inputs (~900 total
randomized cases per CI run). Default seed-and-shrink path —
failing inputs auto-shrink to a minimal counterexample, which is
the headline benefit of the property layer over hand-rolled
fuzzes.

### Bench

No production code touched; no bench changes. Push 1.20 μs, pull
1.20 μs, pullLatest 1.20 μs medians unchanged from the 0.8.3
baseline.

### Documentation

CHANGELOG entry above. README untouched (the property pins
exercise documented public behavior, not new API). Each pin
header in `tests/Bridge.properties.test.ts` documents the exact
invariant + rationale so a future contributor reading the file
cold can pick up the property layer's design intent.

## [0.8.3] — 2026-05-27

### Added — concurrent-test `emptyWaitTimeouts` flake fix (audit cohort, third patch — testing infra, 1 of 3)

Third patch of the audit cohort, first slice of the testing-infra
sub-cohort (with `fast-check` property pins to follow in 0.8.4 and
the 92-pin `Bridge.test.ts` 8-way split to follow in 0.8.5). Fixes
the documented flake CLAUDE.md has been carrying since the 0.6.x
cohort.

Both concurrent stress tests (`tests/Bridge.concurrent.test.ts` and
`tests/Float64RingBuffer.concurrent.test.ts`) end with an assertion
that the consumer-side `Atomics.wait(...)` never times out across the
1 M-frame run — the lost-notify regression alarm. The assertion was
strict `=== 0`; on a loaded CI machine the OS scheduler can park the
consumer thread for >100 ms (the `CONSUMER_WAIT_TIMEOUT_MS`) even
when the producer is healthy and notifies have fired, producing the
documented "fires once on a loaded machine, re-run once if it fires"
behavior.

The 0.8.3 patch relaxes the consumer-side assertion to a soft
threshold of `ceil(TOTAL_FRAMES / 100_000)` (= 10 for the default
1 M-frame run). Rationale:

- A real lost-notify regression produces dozens-to-hundreds of
  consumer-side timeouts across a run (every consumer wait that
  paired with a dropped notify would time out at the 100 ms mark).
  10 timeouts is far below that floor and far above the typical
  healthy-machine count (0–3 across multiple local runs).
- A truly broken protocol would also stall the consumer entirely,
  which `STALL_TIMEOUT_MS = 30_000` already catches independently.
- The producer-side `fullWaitTimeouts === 0` assertion stays strict
  because `PRODUCER_WAIT_TIMEOUT_MS = 1_000` is 10× looser; CI
  jitter under 1 second doesn't trip it.
- Setting `STRICT_TIMING=1` in the environment restores the
  pre-0.8.3 strict `=== 0` check on the consumer side for local
  debugging — useful when investigating a suspected real
  regression.

The success message of each suite now surfaces the timeout count as
`Xtimeouts/N` (e.g. `0/10 timeouts`) so trend toward the threshold
is visible in normal CI output. A drift from 0–3 to 5–8 is now
inspectable without having to dig the raw count out of the
assertion failure path.

**Patch surface (testing-infrastructure only — no production code
touched):**

- **`tests/Bridge.concurrent.test.ts`** —
  - Pin #6 in the file header rewritten to describe the soft
    threshold + rationale + STRICT_TIMING escape.
  - New constants `TIMEOUT_TOLERANCE` (= `ceil(TOTAL_FRAMES /
    100_000)`) and `STRICT_TIMING` (= `process.env.STRICT_TIMING
    === "1"`) declared in the run-shape constants block.
  - End-of-suite `emptyWaitTimeouts` assertion replaced with a
    branch: under `STRICT_TIMING` the strict `=== 0` check runs;
    otherwise the soft `<= TIMEOUT_TOLERANCE` check runs with a
    clear message that names both the observed count and the
    tolerance plus the STRICT_TIMING escape hatch.
  - Success-message `ok(...)` updated to include
    `${emptyWaitTimeouts}/${TIMEOUT_TOLERANCE} timeouts`.

- **`tests/Float64RingBuffer.concurrent.test.ts`** —
  - File-header `fullWaitTimeouts and emptyWaitTimeouts` paragraph
    rewritten to mirror the Bridge file's pin #6 explanation —
    producer side stays strict (`=== 0`), consumer side becomes
    soft (`<= TIMEOUT_TOLERANCE`), STRICT_TIMING escape documented.
  - Same `TIMEOUT_TOLERANCE` / `STRICT_TIMING` constants + same
    branched assertion + same success-message format. Mechanical
    parity with the Bridge file so the two suites stay in lockstep
    if either tightens or loosens later.

### Why

The flake had been carried as a documented "re-run once if it
fires" item across the entire 0.7.x cohort. That's an acceptable
state during rapid iteration but it's the wrong default for a
project approaching 1.0 — release gates that flake degrade trust in
green CI and make real regressions harder to spot. The soft
threshold is conservative enough to still catch a real lost-notify
regression (the regression signature is order-of-magnitude larger
than the tolerance) and the STRICT_TIMING escape preserves the
strict check for anyone investigating a suspected regression.

This is also the first slice of the audit cohort's 0.8.3 → 0.8.5
testing-infrastructure sub-cohort. 0.8.4 adds `fast-check` property
pins for FrameSmoother, trajectory eval, and the PLL; 0.8.5 splits
the 92-pin `tests/Bridge.test.ts` into 8 feature files. Landing the
flake fix first means the next two patches inherit a green-only
gate rather than a green-with-flake-tolerance gate.

### Wire compatibility

**100% wire-compatible.** No production code touched; no SAB
layout, schema, or public-API change. A 0.8.2 consumer and a 0.8.3
consumer over the same SAB exchange frames bit-identically.

### Tests

Both suites stayed green across multiple local runs:

- `tests/Bridge.concurrent.test.ts` — `bridge-concurrent-spsc-
  stress (1,000,000 frames in ~1100 ms; consumer 0-3 empty-wait
  timeouts of 10 tolerated)`. The soft branch reports
  `Xtimeouts/10` in the success message, making trend toward the
  threshold visible.
- `tests/Float64RingBuffer.concurrent.test.ts` — `concurrent-spsc-
  stress (1,000,000 frames in ~500 ms; consumer 0-1 empty-wait
  timeouts of 10 tolerated)`.

All 13 test suites pass with the new branch. Pin counts in
`Bridge.test.ts` (92) and `BridgeInputLane.test.ts` (11) unchanged
— this patch is testing infrastructure only.

### Bench

No production code touched, no bench changes. Existing medians
(push 1.20 μs, pull 1.20 μs, pullLatest 1.20 μs) hold.

### Documentation

CHANGELOG entry above. README untouched (the concurrent-test
behavior isn't part of the public-facing test docs). CLAUDE.md's
"known flake" note will be revisited once the 0.8.3 → 0.8.5
testing-infra sub-cohort completes — the soft threshold removes
the flake but the note describes the strategy for the broader
class of timing-sensitive tests.

## [0.8.2] — 2026-05-27

### Added — pullAll single-trailing-notify + BigInt-free PLL publish (audit cohort, second patch)

Second patch of the audit cohort. Two heap-only performance wins,
both wire-compatible with 0.8.1. **No SAB byte change, no schema
extension, no public-API change.**

1. `BridgeInputLane.pullAll` adopts a single-trailing-notify fast
   path. Where the 0.6.19 → 0.8.1 implementation called `ring.pull`
   in a loop and paid one `Atomics.notify(read_index, 1)` per
   consumed frame, the 0.8.2 path calls a no-trailing-notify primitive
   per frame and issues **exactly one** trailing notify on the
   success branch at burst end. Empty pulls skip the notify entirely.
2. `SpscRing.publishPllState` becomes BigInt-free. The 0.6.16 →
   0.8.1 path materialized one BigInt per call
   (`BigInt(Math.round(offsetNs))`) for the atomic 8-byte offset
   store on the aliased `BigInt64Array` view. The 0.8.2 path
   decomposes the integer offset into low / high Int32 halves via
   `Math.floor(offset / 2^32)` + `(offset - hi * 2^32) | 0` and
   writes two `Atomics.store(indices, lane, ...)` calls instead.
   **SAB byte layout stays bit-identical** — little-endian Int64 is
   the same as two little-endian Int32s at lanes 4 and 5.
   `readPublishedPllState` matches with two Int32 loads + Number
   reconstruction. The aliased `indicesI64` BigInt64 view is retired.

The two changes pair: the BigInt-free split widens the offset write
window across two stores rather than one atomic 8-byte write, which
is exactly the case the 0.8.1 status-last store-order contract
already anticipated and documented. Cross-process readers that gate
on `locked === true` first observe a coherent (offset, drift)
publish point under both write shapes.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/SpscRing.ts`** —
  - `_pullNoNotify` (line ~1018) promoted from a bench-only shim to
    a documented internal helper. New header explains the two
    intentional callers (the existing 0.6.11 bench cell + the new
    `BridgeInputLane.pullAll` path) and the caller's responsibility
    to pair N pulls with one trailing notify. Body now dispatches to
    `_pullOverrunAwareNoNotify` when `_needsOverrunAware` is true,
    mirroring the `pull` dispatch shape so the no-notify primitive
    is correct under every overflow policy (including `drop-oldest`).
  - New private `_pullOverrunAwareNoNotify` (line ~1207) — the
    CAS-aware drop-oldest variant of `_pullNoNotify`, parallel to
    the existing `_pullOverrunAware`. Same retry-on-CAS-failure
    shape; only the trailing notify is elided.
  - New `_notifyReadAdvance` (line ~1275) — the trailing notify
    primitive `BridgeInputLane.pullAll` pairs with `_pullNoNotify`.
    Equivalent to the per-frame `Atomics.notify(this.indices,
    READ_IDX_LANE, 1)` the regular `pull` path issues, lifted to a
    standalone helper so the loop primitive can amortize the notify
    across N pulls.
  - `publishPllState` rewritten BigInt-free; docstring expanded
    with a `─── BigInt-free (0.8.2) ───` subsection explaining the
    decomposition + the 0.8.1 status-last contract is preserved.
  - `readPublishedPllState` matched with two Int32 loads +
    `hi * 0x100000000 + (lo >>> 0)` reconstruction. Allocation-free.
  - `indicesI64` field + constructor assignment retired. The
    constructor comment notes the aliased view is gone and the
    publish/read paths now use the existing Int32Array header view
    directly.

- **`src/BridgeInputLane.ts`** —
  - File-header `─── Notify protocol ───` section rewritten. The
    previous text flagged the per-frame notify cost as a future
    fast-path; this patch ships that fast-path, so the section now
    documents the single-trailing-notify contract explicitly +
    cross-references the empty-pull skip.
  - `pullAll` body switched to `ring._pullNoNotify` as the loop
    primitive + one `ring._notifyReadAdvance()` on the success
    branch (count > 0). Empty-pull early returns skip the notify.

- **`bench/Bridge.bench.ts`** — new 0.8.2 cell
  `pullAll notify-cost amortization`. Drives a 6-field
  input-event schema with bursts of 10 events queued at a time and
  measures `pullAll` (one notify) vs `pull-loop × 10` (ten
  notifies). Surfaces the per-burst delta as `pullAll notify-cost
  delta (pull-loop - pullAll) = X ns (10-event burst; ≈ (N-1)×
  notify saved)`. Not gated; documented in this CHANGELOG entry.

- **`tests/BridgeInputLane.test.ts`** — two new pins:
  - Pin #10 `testPullAllSingleTrailingNotify`: monkey-patches
    `ring._notifyReadAdvance` with a counting wrapper and exercises
    every branch — empty pull (zero notifies), 5-event drain (one
    notify), 3-event drain (one notify), drained-empty pull (zero
    notifies again), buffer-cap drain (one notify). Restores the
    original method in `finally`.
  - Pin #11 `testPullAllDropOldestInterop`: fills a capacity-4
    `drop-oldest` ring, kicks out the oldest frame with an extra
    push, then drains via `pullAll` and asserts the 4 surviving
    frames are bit-exact and FIFO. Exercises the new
    `_pullOverrunAwareNoNotify` dispatch.

- **`tests/Bridge.test.ts`** — new pin #92
  `testPllPublishBigIntFreeAndBoundaryRoundTrip`:
  - Monkey-patches `globalThis.BigInt` with a counting wrapper,
    runs a 10k-publish loop that sweeps offsets across the 2^32
    boundary, then asserts the BigInt constructor was never invoked
    from inside `publishPllState`. Pins the allocation-free
    contract directly.
  - Round-trips a battery of offset values near and across the
    2^32 boundary (where the two-Int32 carry math matters) plus
    legacy edge cases (0, ±1, ±2^31, ±2^53). Every value reads back
    bit-exact via `readPublishedPllState`.

### Why

The two improvements pair naturally and were earmarked together at
audit time. The `BridgeInputLane.pullAll` per-frame notify cost was
flagged in the 0.6.19 file header as future work — at a 10-event
burst the cumulative cost was ~10× a single notify, which
disappears in absolute terms (~1 µs/burst on the 0.6.11 bench
baseline) but stands out on the visible bench output once you add a
single-trailing-notify alternative to compare against. The
BigInt-free publish path removes the only known per-publish BigInt
allocation on the consumer thread — at audio-rate observe cadence
(~700 Hz on a 64-sample quantum at 48 kHz, higher for shorter
quanta) those BigInt allocations were the dominant heap traffic
from `publishPllState`. The 0.8.2 path is pure Number math, sized
to the same ±2^53 ns precision envelope the BigInt path had after
Number conversion on the reader side.

The pairing matters for the store-order contract. The 0.8.1 patch
elevated the status-last store ordering to a documented invariant
specifically anticipating the 0.8.2 split — its CHANGELOG entry
forward-referenced this patch by version number. Splitting the
offset into two stores widens the write window across the offset
itself, which is precisely why the status-last gate matters:
readers that load lane 4 between the offset-low and offset-high
stores observe an inconsistent (lo_new, hi_old) pair, but the
status lane is still old, so the reader's `locked === true` check
correctly discards the snapshot.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema extension,
no protocol change.

- `BridgeInputLane.pullAll` produces the same observable
  before/after state on the SAB (read_index advances by the same
  count; payload bytes are unchanged) and the same return value
  (frames pulled). The trailing notify is wire-equivalent to N
  individual notifies for the parked-producer wake protocol —
  `Atomics.wait` waiters take any notify count ≥ 1 as a wake-up
  signal, so collapsing N notifies to 1 is correct under SPSC.
- `publishPllState` writes the same 8 bytes at lanes 4-5 (offset)
  + the same 4 bytes at lane 6 (drift) + the same 4 bytes at lane
  7 (status) in the same order (offset-low → offset-high → drift →
  status). A 0.8.1 reader running against a 0.8.2 publisher reads
  the same bytes via the aliased BigInt64 view and reconstructs the
  same Number, bit-for-bit.
- `readPublishedPllState` returns the same `{ locked, offsetNs,
  driftPpm }` shape, bit-for-bit, against any publisher 0.6.16
  onward.

A 0.7.x / 0.8.1 consumer linking against this SAB sees identical
frames and identical PLL state.

### Tests

13 suites stay green. Two suites grow:

- `tests/BridgeInputLane.test.ts` from 9 pins to 11 pins (new pins
  #10 and #11 — see Patch surface above).
- `tests/Bridge.test.ts` from 91 pins to 92 pins (new pin #92 —
  see Patch surface above).

Pre-existing pins unchanged. The known
`tests/Bridge.concurrent.test.ts` `emptyWaitTimeouts === 0` flake
(documented in CLAUDE.md) did not fire during the 0.8.2 gate run;
the audit cohort's 0.8.3 patch is still the documented fix target.

### Bench

Push / pull / pullLatest medians unchanged from 0.8.1 (≈ 1.20 µs).
The new 0.8.2 cell shows:

```
  pullAll (1 notify) median= 2.10 μs  p99=10.20 μs  ...
  pull-loop (N notify) median= 2.50 μs  p99=11.00 μs  ...
  pullAll notify-cost delta (pull-loop - pullAll) = 400 ns
    (10-event burst; ≈ (N-1)× notify saved)
```

≈ 400 ns saved per 10-event burst is consistent with the existing
0.6.11 single-notify cell's ~100 ns/notify measurement (9 notifies
collapsed × ~50 ns/notify amortized through the loop dispatch ≈
400 ns). At realistic input-rate bursts of 5-30 events per quantum
the savings range from ~200 ns to ~1.5 µs per pullAll call.

### Documentation

CHANGELOG entry above. `BridgeInputLane.ts` file-header §Notify
protocol now documents the new contract; `SpscRing.ts`
`publishPllState` docstring's BigInt-free subsection documents the
encoding change + the store-order pairing with 0.8.1. README is
unchanged for this patch — the audit cohort's 0.8.4 patch remains
the QUICKSTART + ROADMAP + diagram-rework slot, and the deferred
0.7.15 / 0.7.17 polish items still default to folding into 0.8.4
per the Post-0.8.1 handoff doc.

### Audit cohort context

Second patch of the audit cohort plan
(`~/.claude/plans/please-draft-a-comprehensive-logical-waffle.md`).
Remaining patches in order:

- **0.8.3** — testing infrastructure (`fast-check` property pins +
  `Bridge.test.ts` feature-file split + concurrent flake fix).
- **0.8.4** — documentation polish (QUICKSTART.md + ROADMAP.md +
  README diagram + cheat-sheet callouts; default landing slot for
  the deferred 0.7.15 / 0.7.17 polish items).
- **0.8.5** — npm publish + `webgpu-audio-bridge dev` CLI
  subcommand.
- **0.8.0** — (reserved, ships when ready) `MessageChannelBridge<S>`
  + PLL offset wire-format normalization.
- **0.8.6** — wavefunction migration completion + flagship
  telemetry overlay.
- **0.8.7** — `examples/wavefunction-mini/` Aubry-André demo.

The pairing of `pullAll` single-trailing-notify + BigInt-free PLL
publish in one patch reflects the plan's groupings; each remaining
patch lands separately per CLAUDE.md's extended-slowdown rule.

## [0.8.1] — 2026-05-27

### Added — Concurrency hardening + observability docstrings (audit cohort, first patch)

First patch of the audit cohort, which owns the 0.8.x line per the
[plan](.claude/plans/please-draft-a-comprehensive-logical-waffle.md)
(externally, in `~/.claude/plans/`). Pure documentation + a single
new test pin — **no behavior change, no API change, no SAB byte
change**. Documents two cross-thread / cross-process contracts that
were previously implicit in the code:

1. The `publishPllState` / `readPublishedPllState` **status-last
   store / status-first load** ordering — the one-bit gate that lets
   cross-process observers (a DevTools panel constructing its own
   `SpscRing` over the same SAB) distinguish "publish in flight, may
   be torn" from "publish committed, fields coherent."
2. The **per-instance heap state** contract — two `Bridge<S>`
   instances over the same SAB share only the SAB-resident pull /
   notify / lane-publication state. Smoother prev, eval cache, PLL
   PI state, outlier-gate σ̂, and the soft / stall telemetry counters
   are heap-local and NOT synchronized across Bridges. Cross-instance
   observability is the published SAB lanes (lane 2 `flow_scale`,
   lane 3 `tornFrames`, lanes 4-7 PLL state) — anything else is the
   local Bridge's own observation.

Also tightens the `available()` docstring to make the
"individually-atomic, not mutually-atomic" caveat explicit and
cross-references `telemetry()` as the coherent-snapshot path.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/Bridge.ts`** — new file-header section
  `─── Per-instance heap state (0.8.1) ───` (between the existing
  per-frame evaluator section and the Attribution block). Lists
  every piece of per-instance heap state by name + line cross-
  reference, and explicitly calls out the SAB-resident lanes as the
  canonical cross-instance observability channel. ~38 LOC of
  comment, no code change.

- **`src/SpscRing.ts`** — three docstring tightenings, no body changes:

  - `available()` (lane-counter occupancy) — expanded from one
    sentence to a five-sentence paragraph documenting the
    individually-atomic-but-not-mutually-atomic semantics and
    pointing callers needing a coherent multi-field snapshot at
    `telemetry()` instead.
  - `publishPllState` — new `─── Store order contract (0.8.1) ───`
    subsection documenting the status-last write ordering as
    load-bearing for the matching read contract. The body already
    wrote status last; this patch makes the contract a documented
    invariant rather than incidental implementation order. Includes
    a forward reference to 0.8.2 (the BigInt-free split-offset
    patch) explaining why widening the write window across the
    offset stores preserves the gate semantics.
  - `readPublishedPllState` — new `─── Read order contract (0.8.1)
    ───` subsection documenting the status-first / offset / drift
    load order that pairs with the publish contract. The body
    already loaded status first; this patch makes the contract
    explicit. Also points cross-thread observers needing
    sample-accurate coherence at `bridge.telemetry()` on the
    consumer Bridge directly as the same-thread alternative.

- **`tests/Bridge.test.ts`** — new pin #91
  (`testPerInstanceHeapStateSmoother`): two `Bridge<S>` instances
  over one SAB, alternating producer/consumer pattern. Seeds each
  with a distinct first frame, drives smoothed-blend pulls through
  both, calls `resetSmoother()` on one, and proves the other's
  `smoother.prev` is untouched by checking the next smoothed pull
  blends against the other's original prev (not against the reset
  side). Header comment block updated above the file's pin list.

### Why

Two cross-thread / cross-process invariants were previously
documented only in CHANGELOG entries from earlier patches (0.6.x for
the lane layout, 0.6.16 for `readPublishedPllState` itself) — anyone
auditing the SAB read/write paths today would have to infer the
ordering contract from the code rather than read it as a documented
guarantee. The 0.7.10 audit flagged this as the
highest-leverage concurrency-category improvement: the cost is
purely documentation, but the invariants are load-bearing for any
external worker / DevTools panel building on the published-lane
surface.

The per-instance heap state contract was similarly implicit. The
0.6.x PLL extraction, the 0.6.5 evaluator cache, the 0.6.14 outlier
gate, and the 0.7.3 soft-frame / stall telemetry counters each
introduced new heap-local state without explicitly documenting that
two Bridges over the same SAB do not synchronize on it. Pin #91 is
the executable form of that contract — if a future patch were to
hoist any of those pieces into the SAB by accident, the pin would
catch it.

This patch opens the 0.8.x line. The 0.7.x cohort ended at 0.7.17
deliberately (that subject prefix was the audit cohort's gate); 0.8.0
is reserved for the upcoming `MessageChannelBridge` minor (second
transport tier, postMessage-based, ~5-50 ms latency, no
cross-origin-isolation requirement). Shipping the docstring +
pin-#91 patch as 0.8.1 leaves the 0.8.0 slot intact for that future
minor while letting the audit-cohort hygiene work land as patches in
its own version space. Per CLAUDE.md's extended-slowdown rule,
0.8.x is expected to go deep into the patch space (not race to
0.9.0) — every patch is a 1.0-readiness checkpoint.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema extension, no
protocol change. The `publishPllState` body is unchanged
byte-for-byte (status was already written last); this patch only
elevates the existing store order to a documented contract.
`readPublishedPllState` is similarly unchanged. The
`getEnvironmentReport()` shape is unchanged. The `Bridge<S>` /
`SpscRing<S>` public surfaces are unchanged.

A consumer linking against 0.7.17 and a consumer linking against
0.8.1 over the same SAB exchange frames bit-identically.

### Tests

13 suites stay green. `tests/Bridge.test.ts` is now 91 pins (the new
pin #91 is the only addition). Pre-existing pins 1-90 unchanged.

The 0.7.17 base count was 90 pins; 0.8.1 brings the file to 91. The
file's `main()` runner picks up `testPerInstanceHeapStateSmoother`
at the tail end of the new-Bridge-feature block. Suite run time
delta is negligible (the new pin allocates two Bridges over one
8-slot SAB, pushes 4 frames, pulls 4 frames — sub-millisecond
overhead).

The known `tests/Bridge.concurrent.test.ts`
`emptyWaitTimeouts === 0` flake is documented in CLAUDE.md and is
the audit cohort's 0.8.3 patch's target; not addressed here.

### Bench

Push / pull / pullLatest medians unchanged from 0.7.17 (≈1.20 μs).
`publishPllState` / `readPublishedPllState` are not on any
microbench hot path; the docstring expansion has zero runtime cost.
No new bench cell.

### Documentation

CHANGELOG entry above. The cross-thread / cross-process contracts
are now reachable from inline TSDoc on the affected methods +
the Bridge.ts file header, so editor hover surfaces them at the
point of use. README is unchanged for this patch — the audit
cohort's 0.8.4 patch is the documentation-polish slot for QUICKSTART
+ ROADMAP + the README diagram rework.

### Audit cohort context

This is the first patch of the audit cohort plan
(`~/.claude/plans/please-draft-a-comprehensive-logical-waffle.md`).
Remaining audit-cohort patches in order:

- **0.8.2** — pullAll single-trailing-notify + BigInt-free PLL
  publish (heap-only encoding change; SAB byte representation stays
  bit-identical).
- **0.8.3** — testing infrastructure (`fast-check` property pins +
  Bridge.test.ts feature-file split + concurrent flake fix).
- **0.8.4** — documentation polish (QUICKSTART.md + ROADMAP.md +
  README diagram + cheat-sheet callouts).
- **0.8.5** — npm publish + `webgpu-audio-bridge dev` CLI subcommand.
- **0.8.0** — (reserved, ships when ready) MessageChannelBridge<S>
  + PLL offset wire-format normalization.
- **0.8.6** — wavefunction migration completion + flagship telemetry
  overlay.
- **0.8.7** — `examples/wavefunction-mini/` Aubry-André demo.

The deferred-polish items the user flagged on the 0.7.15 / 0.7.17
patches (JSDoc `@experimental` tags, `EnvironmentReport` grouping
comment, README scaffold suffixes) slot in after the audit cohort
ships at least its first patch — see the
`WebsitePlans/WebAudioBridge - Post-0.7.17 Handoff.md`
"Queued — deferred polish" section.

## [0.7.17] — 2026-05-27

### Added — WebNN capability flags + README "Experimental — WebNN" section (Track 5, closeout patch)

Closes the Track 5 cohort and the broader 5-track planning effort
that started in 0.7.4. 0.7.16 shipped the experimental
`BridgeWebNNSource<S>` adapter under the
`webgpu-audio-bridge/experimental` subpath; this patch lands the
matching capability-detection surface on `getEnvironmentReport()`
plus the user-facing README section so callers can probe the
platform without throwing and find the documented opt-in import
pattern.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/environment.ts`** — adds two flags to `EnvironmentReport`:
  - `webnn: boolean` — `typeof navigator?.ml?.createContext === 'function'`.
    Interface-presence sniff for the W3C WebNN root entry point.
    Does NOT call `createContext`. Pairs with `mlTensor` below.
  - `mlTensor: boolean` — `typeof globalThis.MLTensor === 'function'`.
    Interface-presence sniff for the WebNN tensor primitive. Mirrors
    the static `BridgeWebNNSource.isAvailable()` probe — callers who
    prefer the report-style API can read this instead.

  Both return `false` everywhere today (WebNN is W3C Candidate
  Recommendation, Chrome flag-gated, Safari absent, Firefox in early
  stages). The two flags are independent so callers can distinguish
  "root API shipped" from "tensor class shipped" — some
  implementations may roll one out before the other.

- **`tests/environment.test.ts`** — adds pin #14 (`WebNN + MLTensor
  interface-presence sniffs`). Five branches:

  1. Bare environment → both flags false.
  2. `navigator.ml.createContext` present → `webnn` true,
     `mlTensor` false (split-state assertion).
  3. `globalThis.MLTensor` present → `webnn` false, `mlTensor` true.
  4. Both surfaces present → both true (the WebNN-enabled-Chrome
     case).
  5. Defensive: `navigator.ml` present but `createContext` not a
     function → `webnn` stays false (only counts when callable).

  Adds `MLTensor` to the test's mutable-global harness `KEYS` and
  `BARE_SHAPE`. Extends `fakeNavigator()` with a `webnn?: boolean`
  option that installs `ml.createContext` as a non-throwing stub.
  The bare-environment pin (#1) also asserts both new flags read
  false; the `JSON round-trip` pin (#10) implicitly covers them via
  the report-shape preservation pattern.

- **`README.md`** — new `## Experimental — WebNN (0.7.16 / 0.7.17)`
  section under the existing Audio-rate mode section, above
  Use cases. Documents:

  - The opt-in import from `webgpu-audio-bridge/experimental`.
  - The "outside the 1.0 stability contract" callout — MINOR-bump
    breakage permitted as the spec stabilizes; patch bumps preserve
    compatibility.
  - A code skeleton showing capability check → schema definition →
    `BridgeWebNNSource` construction → `pushFromTensor` /
    `pushFromTypedArray` round-trip.
  - The construction-gate semantics + the `skipAvailabilityCheck`
    opt-out for test code.
  - The two new capability flags and how to use them
    pre-construction.
  - Spec-tracking links: W3C CR, WebNN explainer,
    Chrome implementation status page.

### Why

Two reasons for landing the closeout patch separately from 0.7.16
(rather than bundling everything into one):

1. **Cohort discipline.** The 0.7.13 / 0.7.14 split applied the
   same pattern (one patch for the helper, the next for the
   capability flags + README + final docs). Mirroring that here
   keeps each patch focused and reviewable, and keeps the audit
   cohort's expected gate at a specific commit (`0.7.17 — `
   subject prefix) cleanly identifiable.

2. **Independent value.** Callers building production code against
   experimental APIs need a non-throwing capability check more than
   they need the helper itself (they may not import the helper at
   all if the flags return false). Landing the flags on
   `getEnvironmentReport()` makes the report-shape API the
   authoritative platform-introspection surface — additions to it
   don't churn the helper's signature.

The 5-track planning effort that started in 0.7.4 is now complete:

- Track 1 (Hermite cubic reconstruction) — shipped 0.7.4 as a single
  patch.
- Track 2 (WASM-SIMD AudioWorklet consumer) — shipped 0.7.5 through
  0.7.12 as an 8-patch cohort, plus CI hardening at the back end.
- Track 3 (audio-rate / block-rate consumption) — shipped 0.7.13 +
  0.7.14 (`BridgeBlockConsumer` + `BridgeBlockProducer` +
  `examples/audio-rate/`).
- Track 4 (zero-copy WebGPU scaffolding) — shipped 0.7.15 as the
  `WriteTarget` strategy + `webgpuZeroCopy` capability flag.
- Track 5 (WebNN experimental adapter) — shipped 0.7.16 + 0.7.17
  (this cohort).

What lands next is the audit cohort's reservation — the docstring
+ header-stamp + pin-#91 edits staged in the working tree
(`src/Bridge.ts`, `src/SpscRing.ts`, `tests/Bridge.test.ts`) gate
on `0.7.17` being the current commit, and become unblocked the
moment this patch ships. Their cohort owns the 0.8.x line; the
0.7.x cohort ends here.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema extension,
no protocol change. `webnn` and `mlTensor` are additive on
`EnvironmentReport`; the existing 13 environment-report pins
(1 through 13) stay green unchanged. JSON round-trip preserves
the new fields cleanly.

### Tests

13 suites stay green. `tests/environment.test.ts` is now 14 pins
(the new pin #14 + the bare-pin extension cover the new flags
across all five branches). The 0.7.16 `BridgeWebNNSource.test.ts`
10 pins remain green unchanged — they exercise the helper's
internal `hasMLTensor()` sniff which is intentionally duplicated
between the helper and `environment.ts` (no cross-module
dependency).

### Bench

Push / pull / pullLatest medians unchanged from 0.7.16 (≈1.20 μs).
No new bench cell — `getEnvironmentReport()` is a one-shot
synchronous call at module load; not part of any hot-path
microbench measurement window.

### Documentation

CHANGELOG entry above. README's new
"Experimental — WebNN (0.7.16 / 0.7.17)" section is the user-facing
reference for the cohort; the inline docstrings on `webnn` /
`mlTensor` in `src/environment.ts` document the field-level sniff
discipline and the pairing-with-`BridgeWebNNSource` rationale.

This is the **closeout patch** for the 5-track plan and the
0.7.x cohort overall. After it pushes, the working-tree reservations
(`src/Bridge.ts`, `src/SpscRing.ts`, `tests/Bridge.test.ts`)
become unblocked for the next cohort working on 0.8.x.

## [0.7.16] — 2026-05-27

### Added — `BridgeWebNNSource<S>` experimental WebNN adapter (Track 5, first patch)

Ships an experimental adapter for streaming WebNN model output
through a `Bridge<S>`. Lives at `src/experimental/BridgeWebNNSource.ts`
and is reachable via the new `webgpu-audio-bridge/experimental`
package subpath. **Outside the 1.0 stability contract** — the
underlying WebNN spec is W3C Candidate Recommendation, Chrome
flag-gated (`chrome://flags/#web-machine-learning-api`), Safari
absent, Firefox early — so this helper may break across MINOR
version bumps as the spec stabilizes. Patch bumps within a minor
preserve compatibility.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/experimental/BridgeWebNNSource.ts`** (new, ~340 LOC). A
  thin heap-side helper that takes a `Bridge<S>` whose schema
  declares exactly one `f32Array` field (the samples block) and
  exposes:

  - `pushFromTensor(tensor: MLTensorLike): Promise<boolean>` — async
    path that reads the tensor's bytes (via `tensor.read()` or the
    optional `tensorReader` override), copies into the schema's
    samples field, optionally bumps a `u64` block index, runs an
    optional `fillScalars` hook, and commits via the bridge's
    `beginPush` / `commitPush` zero-copy path.

  - `pushFromTypedArray(samples: Float32Array): boolean` — sync
    fallback path. Works on any host (no WebNN dependency on this
    code path). Useful for CPU-side models or transitional code
    while WebNN stabilizes. Same auto-increment + fillScalars
    surface as the async path.

  - Static `BridgeWebNNSource.isAvailable(): boolean` — non-throwing
    probe of `typeof globalThis.MLTensor === 'function'`.
    Interface-presence sniff, NOT UA detection.

  Constructor gates on `globalThis.MLTensor` being a function and
  throws a descriptive `"WebNN not available"` error otherwise; the
  error names the Chrome flag, points at the static probe, and
  notes the `skipAvailabilityCheck: true` opt-out for test code that
  needs the typed-array fallback path without a real WebNN runtime.

  Schema constraints mirror `BridgeBlockProducer`:
  - exactly one `f32Array` field (zero or multiple throws);
  - optional `blockIndexField` resolution rules:
    `null` disables, `'name'` validates a `u64` scalar, `undefined`
    defaults to `'blockIndex'` if present as a `u64` scalar.
  - optional `fillScalars` hook runs once per successful push after
    samples + block-index are written.

  Telemetry surface: `pushedCount()`, `droppedCount()`, `blockIndex()`.
  Public readonly fields: `bridge`, `blockSize`, `samplesByteSize`,
  `samplesField`, `blockIndexField`.

- **`src/experimental/index.ts`** (new). Re-exports
  `BridgeWebNNSource` and its public types (`BridgeWebNNSourceOptions`,
  `MLTensorLike`, `WebNNTensorReader`). Carries the stability-contract
  docstring for the subpath.

- **`package.json`** — new `exports` entry:

      "./experimental": {
        "types": "./dist/experimental/index.d.ts",
        "import": "./dist/experimental/index.js",
        "require": "./dist/experimental/index.js"
      }

  Users import via `webgpu-audio-bridge/experimental`. The subpath
  name signals "outside the 1.0 contract"; the main entry point
  (`webgpu-audio-bridge`) is unchanged.

- **`tests/BridgeWebNNSource.test.ts`** (new, 10 pins). Covers:

  1. `isAvailable()` reflects the current `globalThis` state.
  2. Constructor gates on `MLTensor` with a descriptive error
     message naming the Chrome flag + the static probe.
  3. `skipAvailabilityCheck: true` bypasses the gate.
  4. Zero-`f32Array` and multi-`f32Array` schemas throw on
     construction with informative messages.
  5. Block-index field resolution covers all four cases (default
     present, default absent, explicit string, explicit null, and
     the wrong-kind + missing-field error paths).
  6. `pushFromTypedArray` round-trips a known sample buffer through
     the bridge with bit-exact samples + correct auto-incremented
     `blockIndex` on the consumer side.
  7. Size-mismatch handling: shorter than `blockSize` throws;
     longer is accepted and only the first `blockSize` samples
     are copied (subarray semantics).
  8. Full ring → `pushFromTypedArray` returns `false`,
     `droppedCount` increments, and `blockIndex` does NOT
     advance on drop.
  9. `pushFromTensor` exercises the present-WebNN path via a
     `globalThis.MLTensor` shim installed for the test's duration;
     bytes land in the bridge correctly.
  10. `tensorReader` override is honored when the caller supplies
      the WebNN-context-side read variant.

  Wired into `test` and `test:unit` scripts alongside the existing
  test files (mirror the 0.7.13 / 0.7.15 patterns).

### Why

WebNN is positioned as the standard for AI inference in the
browser. As models like real-time voice cloning, neural reverb,
neural EQ matching, and physics-modelled instruments mature, the
output side of these models will need to land in the audio thread
with low jitter — exactly what `Bridge<S>` is built for. Shipping
an experimental adapter NOW (rather than waiting for spec
stability) does two things:

1. **Positions the library as the AI-audio bridge** — users
   evaluating "how do I get my WebNN model into AudioWorklet"
   will find a working adapter. The typed-array fallback path
   makes the helper useful even for CPU-side models that don't
   touch WebNN at all yet.

2. **Captures the design space** — the schema-validation rules,
   the block-index convention, the `tensorReader` escape hatch
   for context-side reads, the `fillScalars` hook for producer-
   side metadata — these decisions all become concrete and
   reviewable now rather than baked into a hand-rolled
   integration ten projects down the line.

Living under `src/experimental/` makes the volatility explicit.
The stable surface (`Bridge<S>.push`, schema DSL,
`getEnvironmentReport()`) remains under the 1.0 contract; this
helper does not.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema extension,
no protocol change. `BridgeWebNNSource` composes the public
`Bridge<S>` push surface (`beginPush` / `commitPush`) — a bridge
fed via this helper is bit-for-bit interoperable with one fed by
a hand-rolled push loop performing the same `Float32Array.set` +
scalar assignment + commit. The new `./experimental` exports
subpath is additive on `package.json`; the main entry point's
shape is unchanged.

### Tests

13 suites green. `tests/BridgeWebNNSource.test.ts` adds 10 pins
covering the construction gate, schema validation, the typed-
array round-trip + counters, the MLTensor-installed path via a
`globalThis` shim, and the `tensorReader` override. The 0.7.15
suites (`environment.test.ts`'s 13 pins,
`BridgeGPUSource.writeTarget.test.ts`'s 6 pins, and the
underlying `bridge-gpu-source-orchestration` pin in
`tests/Bridge.test.ts`) remain green unchanged.

### Bench

Push / pull / pullLatest medians unchanged from 0.7.15 (≈1.20 μs).
No new bench cell — `BridgeWebNNSource`'s push paths are
non-hot-path (they're called at WebNN inference cadence, dozens
of Hz at most, not the audio quantum cadence). The `trajEval
(fast)` cell is at the 1.20 μs fast-path budget boundary
(≤1.25 μs), so within budget.

### Documentation

CHANGELOG entry above. Comprehensive file header on
`src/experimental/BridgeWebNNSource.ts` documents the construction
gate, the schema constraint, the two push surfaces, the stability
contract, and the wire-compatibility guarantee. The experimental
subpath's index file carries the "outside the 1.0 contract"
docstring so callers reading their import path see the contract
immediately.

README is intentionally NOT updated in this patch — the user-
facing "Experimental — WebNN" section lands in 0.7.17 alongside
the `webnn` + `mlTensor` capability flags on
`getEnvironmentReport()`. Mirroring the 0.7.13 / 0.7.14 split:
this patch ships the helper; the next patch ships the report
flags + README documentation + final docs for the cohort.

Next patch: 0.7.17 (Track 5 closeout — `webnn` + `mlTensor`
capability flags on `getEnvironmentReport()` + README
"Experimental — WebNN" section + final docs; the completion
patch that unblocks the audit cohort's working-tree
reservations on `src/Bridge.ts`, `src/SpscRing.ts`, and
`tests/Bridge.test.ts` for the 0.8.x line).

## [0.7.15] — 2026-05-27

### Added — `WriteTarget` strategy scaffold + `webgpuZeroCopy` capability flag (Track 4 of the King roadmap)

Forward-compat scaffolding for a future zero-copy / shared-memory
WebGPU readback path. **No behavior change today** — the only
shipped `WriteTarget` implementation is the existing `mapAsync`
path, byte-for-byte unchanged from 0.7.14. The point of this patch
is to land the abstraction now so adopters writing against 0.7.15
won't need to rewrite their `BridgeGPUSource` call sites the day
the W3C lands `GPUBuffer.mapShared` (or whatever the canonical
method name turns out to be).

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/BridgeGPUSource.ts`** — factors the GPU → CPU byte-transport
  step behind a `WriteTarget` strategy interface. The existing
  `copyBufferToBuffer` + `mapAsync` + `getMappedRange` + `unmap`
  statements are relocated into a `MapAsyncWriteTarget` class
  (internal). The state machine (`idle / scheduled / in-flight / ready`),
  the `_lastReadbackUs` timing, and the bridge-push orchestration all
  stay on the host class. A future `SharedMemoryWriteTarget` slots in
  here when the W3C interface ships.

  New constructor option: `writeTarget: 'auto' | 'map-async' | 'shared'`.
  Default `'auto'`. Today `'auto'` deterministically resolves to
  `'map-async'` because no browser exposes the shared-memory interface
  AND this build does not ship a `SharedMemoryWriteTarget`. Explicit
  `'shared'` throws on construction with a descriptive error
  pointing at the capability sniff.

  New method: `BridgeGPUSource#writeTargetKind(): 'map-async' | 'shared'`.
  Returns the resolved kind (never `'auto'` — that's a selector). Today
  always `'map-async'`. Exposed for telemetry / dashboards.

  Removed unused private field `stagingBufferSize` (now owned by
  `WriteTarget.slotByteSize`). Internal-only — not on the public
  surface; no externally visible change.

- **`src/index.ts`** — exports the new types `WriteTarget` and
  `WriteTargetKind`. The strategy class itself (`MapAsyncWriteTarget`)
  remains internal; user-supplied strategy instances are not accepted
  by the constructor in 0.7.15 (enum-only `writeTarget` option). A
  future patch may add a pluggable strategy-object variant if there's
  demand.

- **`src/environment.ts`** — adds `webgpuZeroCopy: boolean` to
  `EnvironmentReport`. Interface-presence sniff on `GPUBuffer.prototype`
  (placeholder name `mapShared`); returns `false` everywhere today, no
  UA version checks. Pairs with `BridgeGPUSource`'s `WriteTarget`
  scaffold: callers can read this before passing `writeTarget: 'shared'`
  if they want to opt in to the zero-copy path explicitly when it
  becomes available. The field name is the stable label; the
  underlying predicate's sniff string is allowed to evolve to track the
  canonical W3C method name.

- **`tests/BridgeGPUSource.writeTarget.test.ts`** (new, 6 pins). The
  audit-cohort-reserved `tests/Bridge.test.ts` is left untouched per the
  Track-4 handoff; this new file covers only the new selection logic:

  1. Default `writeTarget` selects `'map-async'`.
  2. Explicit `'auto'` resolves to `'map-async'`.
  3. Explicit `'map-async'` constructs cleanly and destroys cleanly.
  4. Explicit `'shared'` throws with a descriptive error; no GPU
     buffers leaked.
  5. Validation runs before `WriteTarget` construction —
     `stagingBufferCount: 1` and `stagingBufferSize: 0` throw without
     any `device.createBuffer` side effects.
  6. `getEnvironmentReport().webgpuZeroCopy === false` on current Node.

  The pre-existing `bridge-gpu-source-orchestration` pin (#81) in
  `tests/Bridge.test.ts` covers the end-to-end mapAsync state machine
  with a mock device; it stays green after the refactor (the host
  delegates byte-by-byte to the new `MapAsyncWriteTarget`, no
  observable behavior change).

- **`tests/environment.test.ts`** — adds pin #13 (`webgpuZeroCopy`
  interface-presence sniff). Mocks `globalThis.GPUBuffer` to drive
  three branches: (a) no `GPUBuffer` → `false`; (b) `GPUBuffer` with
  empty prototype (today's Chrome shape) → `false`; (c) `GPUBuffer`
  with `mapShared` on the prototype (future-proof) → `true`. Adds the
  `GPUBuffer` key to the test's mutable-global harness so existing
  pins save+restore it across runs. Bare-environment pin also asserts
  `webgpuZeroCopy === false`.

- **`package.json`** — `test` and `test:unit` scripts gain
  `tsx tests/BridgeGPUSource.writeTarget.test.ts` (alongside the
  existing 11 / 10 entries).

- **`README.md`** — new `### Zero-copy roadmap (0.7.15)` section under
  the existing `## BridgeGPUSource (0.6.18)` heading. Documents the
  `WriteTarget` strategy, the `writeTarget` constructor option with
  its three values, the capability sniff via `webgpuZeroCopy`, and
  the no-behavior-change-today contract. Cites
  [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432) as
  the existing tracking thread; explicitly flags that a dedicated
  shared-buffer / external-memory follow-up issue is expected as the
  working group's externally-managed memory discussion matures. The
  existing "Beyond 1.0" roadmap line about the zero-copy producer
  path now points back at this new section as the shipped scaffold.

### Why

The `mapAsync` cost on the WebGPU readback path is **5–15 ms**
([Chromium 41487454](https://issues.chromium.org/issues/41487454),
[gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432)) — the
single largest remaining floor on `BridgeGPUSource`'s end-to-end
latency, and the only piece of the pipeline the library can't
optimize today. When the W3C lands the shared-memory readback
interface and a browser ships it, the floor drops materially and
adopters' existing `BridgeGPUSource` call sites should "just work"
with the new fast path — that's the design goal of this patch.

Shipping the abstraction now (rather than waiting for the spec)
costs almost nothing: the `MapAsyncWriteTarget` class is a pure
relocation of the 0.6.18-through-0.7.14 statements, the
`writeTarget: 'auto'` default reproduces 0.7.14 behavior exactly,
and the `webgpuZeroCopy` flag returns `false` on every current
environment. The cost is one `WriteTarget` indirection on the
allocation-free steady-state path — a few additional `this.x`
loads per readback, negligible against `mapAsync`'s 5–15 ms cost.
The benefit is that the day the spec lands, the upgrade is a single
patch (drop in `SharedMemoryWriteTarget`, flip the `'auto'`
resolution logic) instead of an API-breaking minor bump.

Track 4 of the King roadmap is "ship the scaffold for spec-blocked
work so adopters don't get caught flat-footed." 0.7.15 is the
entirety of that track in one patch — Track 5 (0.7.16 + 0.7.17)
closes out the roadmap with the experimental WebNN adapter.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema extension, no
protocol change. The `WriteTarget` refactor is purely heap-side; a
bridge fed by `BridgeGPUSource` with `writeTarget: 'auto'` is
bit-for-bit interoperable with a bridge fed by any pre-0.7.15
consumer (or producer). The `getEnvironmentReport().webgpuZeroCopy`
field is additive on the report shape — JSON round-trip preserves
it cleanly, and the existing 12 environment-report pins (1 through
12) remain green unchanged.

### Tests

12 suites stay green. The new `tests/BridgeGPUSource.writeTarget.test.ts`
adds 6 pins covering the selection-path logic; `tests/environment.test.ts`
gains pin #13 (and the bare-environment pin asserts
`webgpuZeroCopy === false`, so pins #1 + #13 together pin both the
default reading and the future-proof flip). The end-to-end orchestration
pin in `tests/Bridge.test.ts` (#81 — `bridge-gpu-source-orchestration`)
stays green unchanged: the refactor is a pure relocation of the
underlying statements behind the strategy interface, so the mock
device's `createBuffer` / `mapAsync` / `getMappedRange` / `unmap`
/ `destroy` are called in the same order with the same arguments
as before.

### Bench

Push / pull / pullLatest medians unchanged from 0.7.14 (≈1.20 μs).
No new bench cell — the `WriteTarget` indirection only fires inside
`BridgeGPUSource`'s `scheduleReadback` / `flushPending` /
`pollCompleted`, which are not part of the ring microbench
measurement window. The `flow_scale recovery` characterization cell
(recoveryCycles = 33) and the `trajEval (fast)` / `trajEval (clamp)`
cells (1.10 μs / 4.80 μs) are within their documented budgets.

### Documentation

CHANGELOG entry above. File header on `src/BridgeGPUSource.ts` gains
a new "WriteTarget strategy (0.7.15)" section documenting the
abstraction's intent + the today-vs-tomorrow split. `EnvironmentReport`'s
`webgpuZeroCopy` field carries an inline docstring naming the
placeholder sniff method and the spec-tracking commitment. README's
new "Zero-copy roadmap" section is the user-facing reference and
the "Beyond 1.0" line in the roadmap section now backlinks to it.

Next patches: 0.7.16 (Track 5 — `BridgeWebNNSource<S>` skeleton
under `src/experimental/` + `webgpu-audio-bridge/experimental`
subpath), 0.7.17 (Track 5 closeout — `webnn` / `mlTensor` capability
flags + final docs; the King Roadmap completion patch that unblocks
the audit cohort's working-tree reservations on `src/Bridge.ts`,
`src/SpscRing.ts`, and `tests/Bridge.test.ts`).

## [0.7.14] — 2026-05-27

### Added — `BridgeBlockProducer<S>` + `examples/audio-rate/` demo (Track 3 of the King roadmap, second patch)

Second patch in the Track 3 cohort. Closes the audio-rate /
block-rate consumption story by shipping the producer-side
companion to 0.7.13's `BridgeBlockConsumer<S>`, plus a worked
end-to-end demo (`examples/audio-rate/`) and a new README
"Audio-rate mode" section with the honest latency-floor table.
After this patch a user who wants "pure GPU synthesis" —
compute shader → bridge → AudioWorklet — has one canonical
helper on each side and a runnable reference.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/BridgeBlockProducer.ts`** (new, ~260 LOC). Wraps
  `BridgeGPUSource<S>` with a decoder that auto-copies the
  mapped staging-buffer bytes into the schema's lone `f32Array`
  field via `Float32Array.prototype.set`. Optionally
  auto-increments a `u64` block-index field on every successful
  push (default behavior: use `'blockIndex'` if present on the
  schema as a `u64` scalar, otherwise no auto-increment;
  explicit `null` disables; explicit name validates).
  An optional `fillScalars` hook runs once per readback for
  caller-side scalar fields (timestamp, frame metadata).

  Public surface:
  - `constructor(device, bridge, opts?)` with
    `stagingBufferCount`, `blockIndexField`, `fillScalars`,
    `bufferLabelPrefix`.
  - `scheduleReadback(srcBuffer, encoder, srcOffset?): boolean`
    — forwards to the wrapped source's same-named method.
  - `flushPending()`, `pollCompleted(): number`,
    `inFlight()` / `inFlightCount()` / `capacity()`,
    `pushedCount()`, `droppedCount()`, `lastReadbackUs()`,
    `destroy()` — full delegation surface for telemetry +
    lifecycle.
  - Public readonly: `bridge`, `blockSize`, `samplesByteSize`,
    `samplesField`, `blockIndexField`, `source` (the wrapped
    `BridgeGPUSource` instance, exposed for callers who want
    the underlying telemetry).

  Schema constraint: exactly one `f32Array` field — mirrors
  `BridgeBlockConsumer`. Block-index field resolution rejects
  array fields and non-`u64` scalars at construction with a
  descriptive error.

  Staging buffer size is set to `blockSize * 4` (samples bytes
  only) — not the bridge's full frame byte size. The compute
  shader output buffer's contents are the only thing copied
  across the GPU → CPU boundary; scalar fields are heap-side
  state set by the decoder closure.

- **`src/index.ts`** gains the new exports:
  `BridgeBlockProducer`, `BridgeBlockProducerOptions`.

- **`examples/audio-rate/`** (new, 6 files). Minimal end-to-end
  demo: a `DedicatedWorker` runs a WGSL additive-sine-bank
  compute shader (8 voices, 1024 samples per dispatch, time-and-
  control-modulated frequency spread), wraps a
  `BridgeBlockProducer` over `BridgeGPUSource`, and dispatches
  at 50 Hz. The `AudioWorklet` constructs a sibling `Bridge` +
  `BridgeBlockConsumer` over the same SAB and runs the canonical
  one-liner `process(outputs[0][0])` to fill each 128-sample
  quantum. CPU fallback when WebGPU isn't available. Files:
  `serve.mjs` (port 5175, COOP/COEP/CORP headers), `index.html`,
  `main.js`, `schema.js`, `worker.js`, `worklet.js`.

  The demo's structural defaults are themselves the recipe:
  capacity 4 (≈85 ms floor), 1024-sample blocks at 48 kHz,
  producer paced at 50 Hz against the 46.875 Hz consumption
  rate, consumer zero-fills on underflow. On-page status panel
  shows production rate, dropped readbacks, last-readback μs,
  frames consumed, and underflow samples.

- **`package.json`** `scripts` gains
  `"dev:audio-rate": "node examples/audio-rate/serve.mjs"`
  alongside the existing `dev:demo` / `dev:fast-lane` entries.

- **`README.md`** gains a new top-level `## Audio-rate mode
  (0.7.13 / 0.7.14)` section with: the canonical block-mode
  consumer + producer code skeletons; the honest latency-floor
  table (`D × B / R`, including the headline 64 ms at
  `D=3, B=1024, R=48 kHz` row); the pacing math (50 Hz producer
  for 46.875 Hz consumer); the three underflow policies with
  guidance on when to use each; and a pointer to
  `examples/audio-rate/`. The latency table is documented as a
  HARD FLOOR — not a target — to set caller expectations
  honestly.

### Why

The 0.7.13 patch shipped the consumer-side helper but left the
producer side to a hand-rolled `BridgeGPUSource` decoder. That's
doable — the decoder is ~10 lines — but every adopter writing
it independently reaches the same five design micro-decisions
(staging buffer size = sample bytes not frame bytes; block index
lives outside the readback path; auto-increment vs. caller-driven;
mapped-range view aliasing; what to do if the schema has multiple
f32Arrays). Bundling those decisions into one helper saves five
minutes per adopter and prevents the most common "I forgot to
increment blockIndex" footgun.

The example wasn't optional. Block mode's structural latency
floor of 60-100 ms makes it counter-intuitive — adopters
benchmarking against control mode's 5-15 ms floor see the gap
and assume something is wrong. The honest table in the README
plus the working demo together set expectations correctly: this
isn't slow, it's structurally bound by the round-trip width;
choose the helper that matches your latency budget.

The 50 Hz pacing choice in the demo deserves explicit mention.
Producer rate must slightly exceed the consumption rate
(`R / B = 46.875 Hz`) so the ring stays one-block-ahead in
steady state. Setting producer rate equal to consumption rate
makes the ring oscillate between 0 and 1 occupancy with every
jitter event consuming spare margin; producing slightly faster
gives the worklet a small buffer cushion the underflow policy
never has to engage. 50 Hz at 1024 samples = 51,200 samples/sec
generated vs. 48,000 consumed — the 6.7% surplus is absorbed by
the bridge's `'reject'` policy when the ring is at capacity (no
torn frames; the producer just sees a `false` return and pauses
for the next tick).

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema
extension, no protocol change. `BridgeBlockProducer` is a
heap-side helper on top of `BridgeGPUSource`'s existing
staging-buffer-ring + `mapAsync` orchestration. A bridge fed by
`BridgeBlockProducer` is bit-for-bit interoperable with one fed
by a hand-rolled `BridgeGPUSource` whose decoder does the same
`Float32Array.set`.

### Tests

Per the King roadmap handoff: this patch ships **no new test
file**. The 0.7.13 `tests/BridgeBlockConsumer.test.ts` (13
pins) already covers the consumer-side block + cursor +
underflow + telemetry semantics; the
`tests/Bridge.test.ts`'s `bridge-gpu-source-orchestration`
pin (#81) covers the underlying `BridgeGPUSource` state
machine. `BridgeBlockProducer` is a thin decoder-closure +
schema-validation shim over `BridgeGPUSource`; the audio-rate
demo running glitch-free at audio rate is the integration test.
This is the explicit handoff guidance — calling it out here so
the gate doesn't read as a missing test.

The full 11-suite gate runs green from 0.7.13 unchanged
(typecheck clean; all schema / Bridge / BridgeFacades /
BridgeInputLane / BridgeBlockConsumer / environment /
Bridge.phaseLock / Bridge.wasmEquivalence / Bridge.concurrent /
Float64RingBuffer / Float64RingBuffer.concurrent suites pass).

### Bench

Push / pull / pullLatest medians unchanged from 0.7.13 (≈1.20
μs). No new bench cell — `BridgeBlockProducer.scheduleReadback`
delegates to `BridgeGPUSource.scheduleReadback`; the decoder's
hot path is one `Float32Array.set(blockSize * 4 bytes)` plus
optional bigint increment, both well outside the ring
microbench's measurement window.

### Documentation

CHANGELOG entry above. Comprehensive file header on
`src/BridgeBlockProducer.ts` documents the schema constraint,
the block-index field resolution rules, the staging-buffer-size
choice, the pacing math, and the wire-compatibility guarantee.
New README "Audio-rate mode" section (above the existing
"## Use cases" section) lays out the consumer + producer
skeletons, the latency-floor table as a hard floor, the
underflow policies + when to use each, and a pointer to
`examples/audio-rate/`. The demo's `index.html` carries an
in-page version of the latency math so a user who just opens
the demo without reading the README still sees the structural
floor explicit.

This closes Track 3. Next patches: 0.7.15 (Track 4 — zero-copy
WebGPU scaffolding via `WriteTarget` strategy + `webgpuZeroCopy`
capability flag), 0.7.16 / 0.7.17 (Track 5 — WebNN experimental
adapter under `webgpu-audio-bridge/experimental` subpath +
capability flags + final docs). After 0.7.17 ships the audit
cohort's working-tree edits (`src/Bridge.ts`, `src/SpscRing.ts`,
`tests/Bridge.test.ts` — intentionally untouched here) become
unblocked for the 0.8.x line.

## [0.7.13] — 2026-05-27

### Added — `BridgeBlockConsumer<S>` (Track 3 of the King roadmap, first patch)

First patch in the Track 3 cohort (audio-rate / block-rate
consumption mode). Ships a thin consumer-side helper —
`BridgeBlockConsumer<S>` — that carves AudioWorklet-quantum-sized
chunks (128 samples by convention) out of larger producer-side
blocks (e.g. 1024 PCM samples per frame from a GPU compute
shader). The helper owns the per-sample cursor inside a checked-
out frame and FIFO-pulls the next frame on cursor exhaustion, so
a worklet's `process()` callback never has to think about frame
boundaries:

```ts
const bridge   = new Bridge(sab, capacity, blockSchema);
const consumer = new BridgeBlockConsumer(bridge);
// AudioWorklet:
process(_, outputs) {
  consumer.process(outputs[0][0]); // 128-sample quantum
  return true;
}
```

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/BridgeBlockConsumer.ts`** (new, ~200 LOC). Single
  class `BridgeBlockConsumer<S>` parameterized over any Bridge
  schema that declares **exactly one** `f32Array` field (the
  samples block). Block size derives from that field's declared
  length; zero or multiple `f32Array` fields throw a descriptive
  error at construction. Multi-channel block schemas are
  deliberately out of scope for this patch (a future patch may
  add channel naming or interleaved-stride conventions; today's
  helper is mono).

  Public surface:
  - `constructor(bridge, { underflowPolicy? })` — defaults
    `'zero-fill'`.
  - `process(out: Float32Array, count?: number): void` — fills
    `out[0 .. count]` with successive samples (default
    `out.length`); transparently crosses frame boundaries.
  - `reset(): void` — discards the in-flight frame, cursor, and
    telemetry counters.
  - `framesConsumed(): number`, `underflowSamples(): number`,
    `remainingInFrame(): number` — diagnostic accessors.
  - Public readonly fields: `bridge`, `blockSize`,
    `samplesField`, `underflowPolicy`.

- **`BlockUnderflowPolicy`** is one of three:
  - `'zero-fill'` (default) — write zeros for the unfilled
    tail. Matches the AudioWorklet "return true and emit
    silence" idiom; the worklet survives transient producer
    stalls without termination.
  - `'hold-last'` — repeat the most recently produced sample
    for the unfilled tail. Smoother audible degradation under
    brief glitches at the cost of a flat-line artifact under
    prolonged underflow. First-call underflow (no samples
    produced yet) emits zero.
  - `'throw'` — throw a descriptive `Error` from the offending
    `process()` call. Useful in tests / strict development;
    production worklets should not select this (an unhandled
    throw from `process()` permanently terminates the
    AudioWorkletProcessor).

- **`src/index.ts`** gains the new exports:
  `BridgeBlockConsumer`, `BlockUnderflowPolicy`,
  `BridgeBlockConsumerOptions`.

- **`tests/BridgeBlockConsumer.test.ts`** (new). 13 pins
  covering the entire helper surface — construction, schema
  validation (zero and multiple `f32Array` fields both throw),
  ramp continuity across 128-quantum boundaries, non-divisor
  quanta (50-sample), multi-frame spans in a single
  `process()`, each underflow policy independently, mid-quantum
  underflow (partial real + zero-fill tail), `reset()`
  semantics, telemetry counters, bounds validation, and
  underflow-policy round-trip. The headline pin produces a
  global integer ramp `0 .. F·blockSize − 1` across F frames
  and asserts every consumed sample matches its expected ramp
  value (no drop, no duplicate, no discontinuity).

- **`package.json`** `test` and `test:unit` scripts gain
  `tsx tests/BridgeBlockConsumer.test.ts` (positioned alongside
  the other consumer-helper tests).

### Why

The user's "pure GPU synthesis" use case is the flagship for
Track 3 — a compute shader writes a block of PCM samples per
producer tick and the AudioWorklet plays them back at audio
rate. Without this helper, the worklet has to track its own
cursor inside a checked-out Bridge frame, pull the next frame
when the cursor exhausts, and decide what to do on ring-empty —
all on the audio thread, where allocation, branching, and
exception handling are at their most expensive. The helper
collapses that cursor + pull + underflow protocol into one
`process(out)` call.

Underflow policy as a constructor option rather than a
caller-chosen branch matters: an AudioWorklet's `process()` runs
in a hot path where adding "if (ringEmpty) … else …" on every
quantum costs measurable branch-predictor pressure. By moving
the decision to construction time (and storing it as a single
enum field), V8's TurboFan can monomorphize the branch out of
the hot path entirely. The three options cover the canonical
audio-engine tradeoffs (silence vs. holdover vs. strict) without
forcing the user to subclass.

The "exactly one `f32Array` field" constraint is deliberate.
Multi-channel block schemas have non-trivial design questions
(channels-per-field vs. interleaved-in-one-field vs. per-channel
ring) that should be decided against a real multi-channel
consumer, not speculatively. Today's helper makes the
single-channel case bulletproof; a follow-up patch can extend it
when a flagship demo asks.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no schema
extension, no protocol change. `BridgeBlockConsumer` composes a
`Bridge<S>` instance through its public API (`bridge.pull` +
`bridge.scratchFrame`) and uses the SAB layout exactly as the
bridge does. A bridge driven through `BridgeBlockConsumer` is
bit-for-bit interoperable with one driven through `bridge.pull`
directly — useful for hybrid layouts that drive control-rate
state and audio-rate blocks through separate bridge instances on
the same audio thread.

### Tests

- `tests/BridgeBlockConsumer.test.ts` — 13 new pins as above.
  All green first-run.
- `tests/Bridge.test.ts` (63 single-thread pins) unchanged —
  no Bridge-level surface this patch touched.
- `tests/Bridge.concurrent.test.ts` (1M FIFO + 250k
  drop-oldest cross-thread stresses) unchanged — the helper
  sits above the SPSC protocol and doesn't move it.
- `tests/Bridge.wasmEquivalence.test.ts` (15 WASM-vs-JS pins)
  unchanged — the helper is pure JS, no WASM counterpart this
  patch (a worklet using the helper instantiates the JS
  `BridgeBlockConsumer` alongside the WASM decoder it already
  drives).

### Bench

Push / pull / pullLatest medians unchanged from 0.7.12 (≈1.20
μs). trajEval (fast) 1.20 μs < 1.25 μs budget. Notify-on-pull
delta 100 ns. flow_scale recovery 33 cycles ≤ 100. No new bench
cell — `BridgeBlockConsumer.process()`'s hot path is a single
`Float32Array.prototype.set` from an internal subarray view into
the caller's buffer (one `bridge.pull` per `blockSize` samples,
amortized over 8 calls at 1024/128); cumulative cost stays well
inside the audio quantum's ~2.67 ms budget at every realistic
block size.

### Documentation

CHANGELOG entry above. Comprehensive file header on
`src/BridgeBlockConsumer.ts` documents the schema constraint,
the three underflow policies + their audible/operational
tradeoffs, the cursor + checkout discipline, the latency floor
math (`D · B / R` worst-case, 64 ms at D=3 / B=1024 / R=48000),
and the wire-compatibility guarantee. README's "Audio-rate
mode" section is intentionally deferred to 0.7.14 — the
production-side `BridgeBlockProducer<S>` adapter + the
`examples/audio-rate/` demo land there and the README section
gains a worked end-to-end example alongside the latency table
in one coherent README change.

This opens Track 3. Next patch (0.7.14) ships the
`BridgeBlockProducer<S>` adapter for `BridgeGPUSource`-shaped
GPU readbacks plus the `examples/audio-rate/` demo + README
"Audio-rate mode" section. Then Track 4 (`WriteTarget`
scaffolding) and Track 5 (WebNN experimental adapter) close out
the King roadmap in 0.7.15 → 0.7.17.

## [0.7.12] — 2026-05-27

### Added — CAS-aware drop-oldest WASM commits (Track 2 of the King roadmap, eighth patch)

Eighth and final functional patch in the Track 2 cohort. Ships
the WASM-side counterparts to `_pullOverrunAware` /
`_pullLatestOverrunAware` (the JS race-free drop-oldest path
added in 0.7.2): two new commit exports that use
`i32.atomic.rmw.cmpxchg` instead of a plain release-store on
`read_index`, returning success/failure so the caller can retry
on a detected producer overrun. After this patch the WASM
consumer can drive every Bridge policy the JS consumer supports
— `block` (default release-store path, 0.7.6) and `drop-oldest`
(CAS path, this patch).

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** gains:
  - One new module-scoped global `$pendingCapturedReadIdx`
    holding the `readIdx` observed at the matching peek call.
    Set on every peek (one extra i32 store — negligible) so the
    caller chooses CAS vs release-store commit entirely at
    commit time, no `peek_cas` family needed.
  - `commit_pull_cas` — FIFO drop-oldest commit. CAS lane 1
    with expected = `$pendingCapturedReadIdx`, desired =
    `$pendingNewReadIdx` (which holds `readIdx + 1` from the
    matching `peek_pull`). Returns 1 on success (+ notify), 0
    on race (caller must re-peek and retry; the slot bytes
    were torn by a producer overrun).
  - `commit_pull_latest_cas` — `pullLatest` drop-oldest commit.
    Same CAS shape but `$pendingNewReadIdx` holds the
    `writeIdx` from `peek_pull_latest`, so the successful CAS
    advances `read_index` straight to `writeIdx` (drain-to-
    newest in one atomic step). Notify on success only.

  The CAS uses WebAssembly threads spec's
  `i32.atomic.rmw.cmpxchg`, which has acquire-release semantics
  on both success and failure branches — matches
  `Atomics.compareExchange` bit-for-bit on every spec-compliant
  engine.

  WAT binary size: 1883 bytes (0.7.11) → 2019 bytes (0.7.12).
  +136 bytes for two cmpxchg-based exports + the captured-readIdx
  global.

- **`src/worklet/index.ts`** `WorkletConsumer` interface gains
  two typed methods returning boolean:
  - `commitPullCas(): boolean` — true on success, false →
    caller must re-peek.
  - `commitPullLatestCas(): boolean` — same shape for the
    drain-to-newest variant.

  Instantiation guard now validates all 29 exports.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pin 14:
  - **14a (FIFO CAS success)** — clean peek + commit; CAS
    matches captured value, returns true, `read_index`
    advances by 1.
  - **14b (FIFO CAS race detected)** — peek, then manually
    advance `read_index` out of band (deterministic simulation
    of a producer overrun mid-read), then commitPullCas: CAS
    expected no longer matches the lane, returns false, lane
    unchanged by the failed CAS.
  - **14c (pullLatest CAS success)** — 3-frame burst, peek
    newest, commitPullLatestCas: success, `read_index`
    advances straight to `writeIdx` (consuming all 3 in one
    atomic step).
  - **14d (pullLatest CAS race detected)** — symmetric race
    simulation for the pullLatest path.

  Total pins in the file: 15 (pin 15 = the existing
  "no-invariant schema layout returns null" pin renumbered).
  All 13 prior wasmEquivalence pins still pass.

### Why

The drop-oldest policy is the only Bridge policy whose
correctness requires more than a plain release-store on
`read_index`. The producer's `_dropOldest` step advances
`read_index` past slots the consumer is still reading; without
CAS-on-commit the consumer's release-store would rewind the
lane to a stale value, breaking the SPSC invariant and tearing
the next frame.

The JS Bridge has run this CAS shape since 0.7.2 — and the
cross-thread 250k-frame `drop-oldest` stress in
`tests/Bridge.concurrent.test.ts` exercises it exhaustively
under real contention. What was missing was the WASM
counterpart: a consumer running through the WASM decoder under
drop-oldest had no way to detect the same race, so it could
only safely target `block`-policy Bridges. After this patch the
WASM consumer is a drop-in replacement for the JS pull on every
policy the library supports.

The pin's single-thread deterministic race simulation
(manually `Atomics.store` between peek and commit) is the
correct shape for unit-level CAS verification — the
cross-thread stress already covers the production contention
path via the JS consumer; here we just need to prove the WASM
CAS detects the same logical condition the JS CAS detects, and
that's exactly what manually overwriting `read_index` does.

### Wire compatibility

100%. No SAB byte change, no new SAB lanes, no
SchemaLayoutDescription field changes. Producer-side push
paths are unchanged. JS-side consumer paths are unchanged.
Only the WASM consumer module gains new exports + the shim
gains new methods — additive at every layer.

### Tests

- `tests/Bridge.wasmEquivalence.test.ts` Pin 14 (above).
  All 14 prior pins still pass. File now contains 15 pins
  total covering the entire WASM consumer surface.
- `tests/Bridge.test.ts` (63 single-thread pins) unchanged
  — no JS-side surface this patch touched.
- `tests/Bridge.concurrent.test.ts` (1M FIFO + 250k
  drop-oldest cross-thread stresses) still pass — the JS CAS
  path they exercise hasn't moved.

### Bench

Push / pull / pullLatest medians unchanged from 0.7.11 (≈1.20
μs). trajEval (fast) 1.10 μs < 1.25 μs budget. WASM consumer
hot path unaffected — the CAS commits are not on any benched
codepath (the existing bench's pull cells use the JS pull, not
the WASM commit).

### Documentation

CHANGELOG entry above. WAT inline comments document the
captured-readIdx + CAS rationale and the bit-for-bit
correspondence with `Atomics.compareExchange`. Shim JSDoc
explains the success/failure semantics and the caller's retry
obligation.

This closes Track 2's functional cohort. Remaining optional
patches in the cohort (per the King roadmap handoff doc) are
0.7.13 (`pullLatestComplete` ergonomics helper — single shim
call for peek → decode-all-fields → commit) and 0.7.14
(WASM-vs-JS `pullLatest` bench cell to capture the speedup
numbers the roadmap estimates at 1.2-1.5× scalar / 2-3× SIMD).
After those land, Track 3 (block-rate consumer) opens.

## [0.7.11] — 2026-05-27

### Added — Invariant lane visibility in `describeLayout()` (Track 2 of the King roadmap, seventh patch)

Seventh patch in the Track 2 cohort. Surfaces the hidden
`__invariant: f64` lane's byte offset on `SchemaLayoutDescription`
so worklet-side inliners — the WASM consumer in particular — can
resolve the invariant offset from the postMessage-friendly
`describeLayout()` JSON alone, without needing access to the
`Schema` object on the audio thread.

Nothing about the SAB byte layout changes (the lane has been there
since 0.6.0; the producer writes it on push, the JS consumer reads
it on pull). The patch is purely a visibility cut: one new field
on the layout descriptor, two new test pins, no new WAT exports,
no new shim methods. After this patch the WASM consumer can drive
every lane the JS Bridge supports (scalars, arrays, trajectories,
invariants) using exports that already shipped in 0.7.5 → 0.7.10.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`src/schema.ts`** `SchemaLayoutDescription` interface gains a
  new readonly field:
  - `invariantByteOffset: number | null` — the byte offset of the
    hidden `__invariant: f64` lane within a frame slot, or `null`
    when the schema has no `.withInvariant(...)` attached. Always
    8-aligned when non-null. Mirrors the existing
    `schema.compiled.invariantByteOffset` value through the
    layout-descriptor channel.

  `describeSchemaLayout(schema)` (and the `bridge.describeLayout()`
  delegator on Bridge) populates the new field from
  `schema.invariant?.byteOffset ?? null`. Existing callers that
  ignore the field are unaffected — additive.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pins 12 and 13:
  - **Pin 12 (invariant-lane decode equivalence)** — builds a
    schema with `.withInvariant(sum-of-squares)`, pushes 6 rows
    covering a 14-order-of-magnitude invariant range (0, 1, 8,
    27.02, ≈8e-14, 8e12) including the subnormal-ish band that
    exercises the absolute-epsilon floor on the classifier side.
    For each row, the WASM consumer's `readF64` at
    `layout.invariantByteOffset` MUST equal the JS-side oracle
    `Σ sample[k]²`. Also asserts the layout offset equals
    `schema.compiled.invariantByteOffset` (cross-channel
    agreement: a worklet trusting the layout JSON sees the same
    bytes the JS Bridge writes through).
  - **Pin 13 (no-invariant layout null)** — a plain
    `defineSchema({ a: f64(), b: f64() })` schema MUST surface
    `invariantByteOffset: null` so callers can branch on presence
    without inspecting the `Schema` object directly.

  All eleven 0.7.10 pins still pass.

### Why

The WASM consumer already had `read_f64` (0.7.7) sufficient to
decode any f64 in the SAB at any byte offset. What it didn't have
— through the canonical cross-thread descriptor channel — was a
way to find where the invariant lane lives. `schema.invariant.
byteOffset` is on the `Schema` object, but the standard worklet
hand-off pattern (postMessage `describeLayout()` JSON, reconstruct
on the audio thread) deliberately doesn't ship the `Schema` —
the layout descriptor is intentionally the only contract the two
ends share.

Without this patch a worklet using `.withInvariant`-bearing
schemas had to either (a) reach into the producer-side `Schema`
out-of-band (couples the worklet to the producer's import graph,
defeating the layout-descriptor pattern's whole point) or (b)
re-implement the invariant offset arithmetic from
`describeLayout().fields` (`max(byteOffset + byteSize) + padding`
— fragile and not actually publicly documented).

Exposing the offset as a single optional field on the layout
descriptor is the smallest correct fix. After 0.7.11 a worklet
can drive the full invariant lane through `describeLayout()` +
`readF64()` alone:

```ts
const layout = bridge.describeLayout();
// ... peek slot, compute slotBase ...
if (layout.invariantByteOffset !== null) {
  const stored = consumer.readF64(slotBase + layout.invariantByteOffset);
  // Bridge's heap-side classifier compares `stored` vs schema.invariant.compute(frame) AFTER release-store.
}
```

The pre-release-store read discipline (the invariant must be read
BEFORE the consumer's release-store on `read_index` so the slot
bytes are still the consumer's to read) is unchanged from 0.6.0
— the WASM peek/commit dance already enforces it.

### Wire compatibility

100%. No SAB byte change, no schema compile-pass change, no WAT
binary change (still 1883 bytes from 0.7.10), no new exports on
`WorkletConsumer`. Only the `SchemaLayoutDescription` shape
gains a new optional field, which is additive at the type level
(existing destructuring code is unaffected; existing JSON
serialization gains a new key the old reader simply ignores).

### Tests

- `tests/Bridge.wasmEquivalence.test.ts` Pins 12 & 13 (above).
  Total pins in the file: 13.
- Existing 63 single-thread pins in `tests/Bridge.test.ts` still
  pass (no API surface they touched changed).
- Concurrent stress + drop-oldest stress (`tests/Bridge.concurrent.test.ts`)
  still pass — neither was sensitive to the layout descriptor
  shape.

### Bench

Unchanged from 0.7.10 — no hot-path code moved. Confirmed
locally: push / pull / pullLatest medians stable at 1.20 μs;
trajEval (fast) median 1.10 μs < 1.25 μs budget; SIMD
trajectory cells unaffected.

### Documentation

CHANGELOG entry above. The new field is documented on the
`SchemaLayoutDescription` interface with a JSDoc block describing
the read discipline + the cross-channel agreement. No README cut
yet — the worklet subpath is still undocumented in the
user-facing README; the broader cohort docs cut is deferred per
the King roadmap handoff doc's note (probably 0.7.14 once the
end-to-end `pullLatestComplete` helper is also in).

## [0.7.10] — 2026-05-27

### Added — f32 trajectory mirrors + SIMD-vectorized order=2 paths (Track 2 of the King roadmap, sixth patch)

Sixth patch in the Track 2 cohort. Ships two things together: the
**f32 mirrors** of the f64 trajectory evaluators landed in 0.7.9, and
the **SIMD-vectorized order=2 paths** for both widths (the first
piece of WASM in the cohort that actually uses `v128` / `f32x4` /
`f64x2` ops — the file's reason for the `simd: true` build flag has
finally arrived). After this patch the WASM trajectory evaluator
covers every shape `f{32,64}TrajectoryArray` produces; only the
invariant lane (0.7.11) and the CAS-aware drop-oldest path (0.7.12)
remain before Track 2 is feature-complete.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** gains six new exports:
  - `eval_taylor_f32_o1(srcOff, dstOff, n)` — order=1 position-only
    `memory.copy` of `n × 4` bytes.
  - `eval_taylor_f32_o2(srcOff, dstOff, n, dt)` — scalar f32 order=2
    Taylor. Per-sample math runs in **f64 intermediate** (loaded
    f32 → `f64.promote_f32` → arithmetic → `f32.demote_f64` on
    store) to match the JS `evaluateTrajectoryInto`'s
    Float32Array-read → Number-arithmetic → Float32Array-store
    semantics bit-for-bit.
  - `eval_taylor_f32_o3(srcOff, dstOff, n, dt)` — scalar f32 order=3
    Taylor. Same f64 intermediate discipline. `halfDt2 = 0.5 ·
    dt · dt` precomputed once per call (matches JS).
  - `eval_hermite_f32(prevOff, currOff, dstOff, n, stride, h00,
    h10s, h01, h11s)` — scalar f32 Hermite. Basis coefficients are
    accepted as f64 and consumed unchanged in the f64-intermediate
    math; the demote-to-f32 only happens at the store.
  - `eval_taylor_f32_o2_simd(srcOff, dstOff, n, dt)` — **f32x4
    SIMD** order=2 Taylor. Processes 4 samples per iteration:
    two `v128.load`s cover one chunk of the interleaved `[p, v,
    p, v, …]` layout; an `i8x16.shuffle` pair deinterleaves
    positions from velocities; one `f32x4.mul` + `f32x4.add`
    computes the four outputs; one `v128.store` writes them.
    Scalar tail handles the trailing 0-3 samples that don't fill
    a final SIMD chunk.
  - `eval_taylor_f64_o2_simd(srcOff, dstOff, n, dt)` — **f64x2
    SIMD** order=2 Taylor. Processes 2 samples per iteration via
    `v128.load` + `i8x16.shuffle` + `f64x2.mul` + `f64x2.add` +
    `v128.store`. Scalar tail handles the trailing 0-1 samples.

  The SIMD shuffle indices (long form, 16 byte selectors per
  shuffle) are documented inline in the WAT — they pick the
  position bytes of two consecutive `[p, v]` chunks into one
  v128 and the velocity bytes into another, then proceed lane-
  parallel through the multiply-add.

  Precision note: the **f64 SIMD path is bit-identical to its
  scalar f64 counterpart** (both run all math in f64). The **f32
  SIMD path is NOT bit-identical** to the scalar f32 path:
  `f32x4.mul` necessarily stays in f32 while the scalar f32
  evaluator runs intermediate math in f64 (to match JS). The
  divergence is ≤ 1 ULP at f32 precision — documented in the WAT
  header and verified with an epsilon tolerance in the test.

- **`src/worklet/index.ts`** `WorkletConsumer` interface gains
  six typed methods mirroring the WAT exports: `evalTaylorF32O1`,
  `evalTaylorF32O2`, `evalTaylorF32O3`, `evalHermiteF32`,
  `evalTaylorF32O2Simd`, `evalTaylorF64O2Simd`. Instantiation
  guard now validates all 27 exports.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pins 10 and 11:
  - **Pin 10 (f32 trajectory equivalence)** — mirror of Pin 9 on
    f32 trajectories. Taylor sub-pin: 4 rows × 4 dts × 3 orders ×
    24 samples = 1152 bit-exact comparisons against
    `evaluateTrajectoryInto`. Hermite sub-pin: 4 (t, segS) pairs
    × 2 orders × 24 samples = 192 bit-exact comparisons.
  - **Pin 11 (SIMD vs scalar)** — drives the SAME source bytes
    through scalar and SIMD evaluators at sample counts {17, 32,
    3} to exercise both clean-SIMD and scalar-tail paths × 3
    representative dt values. The f64 SIMD comparison is
    bit-exact; the f32 SIMD comparison uses 4× ULP tolerance to
    absorb the documented f64-intermediate-vs-f32-only divergence.

  All ten 0.7.9 pins still pass.

### Why

The 0.7.9 patch shipped f64 trajectory evaluators in scalar WASM.
Two of the King roadmap's three motivating use cases (the
wavefunction twin's `vEff` / `jEff` macro surface; the modal
resonator bank's spectral envelopes) work entirely in f32 to
halve their per-frame byte budget — without the f32 mirrors
shipped here, the WASM consumer would force them back to f64 or
back to JS, defeating both ends of the win.

SIMD vectorization is the headline Track 2 cred. WebAssembly's
`f32x4.add` / `f32x4.mul` compile to a single SSE2 / NEON
instruction on every shipping engine — a 4× theoretical speedup
on the order=2 inner loop. After the shuffle overhead the
practical speedup is 2-3× per element, scaled across the full
trajectory (typical N=1000-1024) to a per-call savings of ~5-8 μs
at 48 kHz audio rate — meaningful when the audio quantum budget
is 2.67 ms and the bridge is the only thing between the GPU and
the speaker.

The f32 vs f32x4 precision split is the right trade-off here:
the JS-compatibility f32 scalar path is the rigorous one (callers
who need bit-exact JS agreement use it); the SIMD f32 path is the
fast one (callers who can absorb 1-ULP-at-f32-precision use it
when the audio output sample rate truncates worse than that
anyway).

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout unchanged.
The WASM trajectory evaluators read the EXACT same bytes the JS
evaluator reads; the scalar f64 / f32 paths produce bit-identical
output to JS; the SIMD f64 path is bit-identical to scalar f64;
the SIMD f32 path agrees to within 1 ULP at f32 precision. A
0.7.9 producer interoperates bit-for-bit with a 0.7.10 consumer.

### Tests

Pins 10 (f32 mirrors) and 11 (SIMD vs scalar) add 1152 + 192 +
varying SIMD-vs-scalar comparisons. All ten 0.7.9 pins still
green. All other suites (Bridge, BridgeFacades, BridgeInputLane,
schema, environment, Bridge.phaseLock incl. Taylor + Hermite
pins, two 1 M-frame concurrent stress runs, Float64RingBuffer
legacy) all green — purely additive.

### Bench

push/pull/pullLatest medians unchanged at 1.20 μs. The
SIMD-vs-scalar WASM bench cell lands once the full pullLatest is
end-to-end-WASM (post-0.7.12, with CAS drop-oldest and invariant
lane both ported) — that's when a meaningful WASM-vs-JS
`pullLatest` median comparison becomes possible.

### Documentation

`wasm/decoder.wat` gains two new section headers — one for the
f32 mirrors (documenting the f64-intermediate-math discipline)
and one for the SIMD-vectorized order=2 evaluators (documenting
the shuffle indices, the SIMD-vs-scalar precision contract, and
the scalar-tail discipline). `WorkletConsumer` interface
docstrings in `src/worklet/index.ts` cross-reference the WAT
contract. README integration lands once the full pullLatest is
WASM-backed (post-0.7.12).

## [0.7.9] — 2026-05-27

### Added — WASM f64 trajectory evaluators (Track 2 of the King roadmap, fifth patch)

Third payload-decode patch in the Track 2 cohort. The WASM
consumer now evaluates `f64TrajectoryArray` fields end-to-end
— both the single-frame Taylor extrapolation (orders 1, 2, 3)
and the two-frame cubic Hermite reconstruction the 0.7.4 Track
1 patch shipped. Output is bit-identical to the JS
`evaluateTrajectoryInto` / `evaluateHermiteTrajectoryInto`
helpers; spot-checked across 2088 sample comparisons
(1800 Taylor + 288 Hermite). With this patch WASM covers every
shape the public schema DSL declares except `f32`-flavored
trajectories (mirrored in 0.7.10) and the invariant lane
(0.7.11). SIMD vectorization of the order=2 paths lands in
0.7.10 alongside the f32 mirrors.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** gains four new exports:
  - `eval_taylor_f64_o1(srcOff, dstOff, n)` — order=1
    position-only. Body is a `memory.copy` of `n × 8` bytes
    (the source IS the output). The `dt` argument is omitted
    from the signature since order=1 has no extrapolation;
    matches the JS evaluator's `case 1` arm semantically.
  - `eval_taylor_f64_o2(srcOff, dstOff, n, dt)` — order=2
    linear Taylor `p + v · dt`. Scalar f64 loop over the
    `[p_0, v_0, p_1, v_1, …]` interleaved layout (16 bytes
    per sample).
  - `eval_taylor_f64_o3(srcOff, dstOff, n, dt)` — order=3
    quadratic Taylor `p + v · dt + a · (½ · dt²)`. Caches
    `halfDt2 = 0.5 · dt · dt` once per call (matches the JS
    evaluator). Scalar f64 loop over the
    `[p_0, v_0, a_0, p_1, v_1, a_1, …]` interleaved layout
    (24 bytes per sample).
  - `eval_hermite_f64(prevOff, currOff, dstOff, n, stride,
    h00, h10s, h01, h11s)` — cubic Hermite
    `h00 · P_0 + h10s · M_0 + h01 · P_1 + h11s · M_1`. Basis
    coefficients are CALLER-COMPUTED ONCE per call (JS-side
    math; lets the caller cache across multiple trajectory
    evals at the same t). `stride` accommodates both order=2
    (= 2) and order=3 (= 3, acceleration lane ignored).
    Scalar f64 loop.

  All loads use `align=1` to handle the schema's tight packing
  (a trajectory's flat array can land on any 4-byte boundary
  inside a slot). Order=2 SIMD (process 2 samples per
  `f64x2.mul` + `f64x2.add` after one shuffle pair) and the
  f32 4-wide version land in 0.7.10 — bundling them together
  lets a single patch own the SIMD authoring conventions for
  the whole evaluator family.

- **`src/worklet/index.ts`** `WorkletConsumer` interface gains
  four typed methods mirroring the WAT exports:
  `evalTaylorF64O1`, `evalTaylorF64O2`, `evalTaylorF64O3`,
  `evalHermiteF64`. The Hermite signature exposes the basis
  coefficient args (h00, h10s, h01, h11s) so JS callers can
  precompute them once per (t, segmentSeconds) and reuse
  across multiple trajectory fields in one frame pair.
  Instantiation guard now validates all 21 exports.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pin 9:
  - **Sub-pin 9a (Taylor)** — defines a 3-trajectory schema
    (order 1, 2, 3), pushes 5 rows of physics-shaped curves
    (`sin(k·θ)` positions with matching `cos` / `−sin`
    derivatives), evaluates each order at 5 representative
    `dt` values (0, 0.0008, 0.005, 0.012345, 0.0166667 — the
    last being the 60 Hz period) and asserts WASM ===
    `evaluateTrajectoryInto` bit-exactly. 5 × 5 × 3 × 24 =
    1800 sample comparisons.
  - **Sub-pin 9b (Hermite)** — pushes two consecutive frames,
    sweeps 6 (t, segmentSeconds) pairs (covering t = 0, 0.25,
    0.5, 0.75, 1 plus a tight `segS = 1 ms` case), evaluates
    cubic Hermite over both order=2 and order=3 trajectory
    fields, and asserts WASM === `evaluateHermiteTrajectoryInto`
    bit-exactly. 6 × 2 × 24 = 288 sample comparisons.

  All eight 0.7.8 pins still pass.

### Why

Trajectory evaluation is the deepest schema-decode path in
the bridge — it's where Track 1 (Hermite) landed audible
quality wins and where Track 2's eventual end-to-end-WASM
hot path makes the most sense. Today's JS evaluator pays
the typed-array-element-access tax 2-3 times per sample
(loading `flat[2i]` + `flat[2i+1]` + writing `out[i]`); each
access traverses TypedArray bounds-checking and the V8
property lookup. The WASM equivalent compiles to direct
`f64.load align=1` / `f64.store align=1` instructions —
zero JS bookkeeping, fits in the L1 cache.

The Hermite basis split (coefficients on the call signature
rather than computed inside WAT) is a deliberate design
choice: JS callers often hold (t, segmentSeconds) constant
across multiple trajectory fields in a single frame pair
(e.g., a `vEff` and `jEff` traj pair from the same physics
frame), so resolving the basis once and reusing the four
coefficients across two `evalHermiteF64` calls saves four
multiplies + three subtracts per second trajectory.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout
unchanged. The WASM trajectory evaluators read the EXACT
same bytes the JS evaluator reads via the JS-side flat
typed-array (`pushFrame.tO2`). A 0.7.8 producer interoperates
bit-for-bit with a 0.7.9 consumer using the new evaluators,
and vice-versa.

### Tests

Pin 9 covers 2088 sample comparisons across 5 dt values + 6
Hermite (t, segS) pairs + all three Taylor orders + both
Hermite stride values. All eight 0.7.8 pins still green. All
other suites (Bridge, BridgeFacades, BridgeInputLane, schema,
environment, Bridge.phaseLock incl. Taylor and Hermite pins,
two 1 M-frame concurrent stress runs, Float64RingBuffer
legacy) all green — purely additive.

### Bench

push/pull/pullLatest medians unchanged at 1.20 μs. WASM
trajectory-eval throughput vs the JS `evaluateTrajectoryInto`
becomes a meaningful benchmark only once the f32 mirrors +
SIMD vectorization land (0.7.10) and the bench can A/B both
implementations cleanly. The scalar WASM path's expected
speedup vs JS is modest (~1.2-1.5× on interleaved layouts);
the headline win arrives with the SIMD patches.

### Documentation

`wasm/decoder.wat` gains a section header documenting the
trajectory layouts the evaluators consume (the `p, v, a`
interleaving + per-order stride table), the alignment policy,
and the Hermite basis-coefficient pre-resolution rationale.
`WorkletConsumer` interface docstrings in
`src/worklet/index.ts` cross-reference the WAT contract and
spell out the canonical wiring (srcOff / dstOff math).
README integration lands once the full pullLatest is
WASM-backed (post-0.7.11).

## [0.7.8] — 2026-05-27

### Added — WASM array field bulk copy (Track 2 of the King roadmap, fourth patch)

Second payload-decode patch in the Track 2 cohort. The WASM
consumer can now bulk-copy a slot's array-field bytes into a
caller-provided destination region inside the same
`WebAssembly.Memory`. Combined with the 0.7.7 scalar decoders,
WASM now covers BOTH primitive shapes the schema DSL declares —
scalars (read element-by-element) and arrays (copy-then-view).
The remaining payload-decode patches in the cohort port the
trajectory-specific path (SIMD f64x2/f32x4) and the
CAS-aware drop-oldest mode.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** gains one export:
  - `copy_array(srcOff: i32, dstOff: i32, byteCount: i32)`
    invokes `memory.copy` (bulk-memory proposal; already
    enabled in the build). The op handles overlapping ranges
    correctly per spec (memmove semantics). The shim's
    allocated scratch region never overlaps the SAB ring (the
    scratch lives in pages above the SAB), so the overlap case
    is moot in canonical wiring.

- **`src/worklet/index.ts`** gains:
  - **`WorkletMemoryAllocationOptions`** interface — the
    options-object overload form of `allocateWorkletMemory`.
    Fields: `sabBytes: number` (required) +
    `scratchBytes?: number` (optional, default 0).
  - **`allocateWorkletMemory({ sabBytes, scratchBytes })`** —
    new overload that reserves a page-aligned consumer-side
    scratch region above the SAB ring in the same Memory.
    Returns `scratchByteOffset` + `scratchBytes` on the
    allocation. The single-`number` form still works (zero
    scratch).
  - **`WorkletMemoryAllocation.scratchByteOffset` /
    `scratchBytes`** — new optional fields, present iff
    `scratchBytes > 0` was requested. Bytes
    `[scratchByteOffset, scratchByteOffset + scratchBytes)`
    inside the Memory are reserved for the consumer's
    `copy_array` destinations; the JS caller wires its
    `Float64Array` / `Float32Array` / `Uint32Array` / … views
    over this range.
  - **`WorkletConsumer.copyArray(srcOff, dstOff, byteCount)`**
    — thin shim over the WASM export. Per-pull canonical
    wiring: `srcOff = RING_HEADER_BYTES + slot * frameByteSize
    + arrayField.byteOffset`; `dstOff = scratchByteOffset`
    (plus per-array sub-offset); `byteCount = array.length *
    elementByteSize`. The instantiation guard now validates
    all 17 exports.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pin 8:
  - Defines a schema with three array fields of different
    kinds: `vEff: f64Array(32)`, `gEff: f32Array(32)`,
    `iEff: u32Array(32)`. Allocates `{ sabBytes,
    scratchBytes: 512 }` — three contiguous scratch
    partitions for the three array kinds.
  - Pushes 6 rows of per-element patterns (`sin(r·k·0.137)`
    for vEff, `Math.fround(cos(…))` for gEff, packed `(r << 16)
    | (k + 1)` for iEff) — distinct row-by-row and
    element-by-element so any off-by-one in slot or field
    offsets surfaces.
  - Per row: WASM `peekPull` → three `copyArray` calls (one
    per array) → JS reads from `Float64Array` / `Float32Array`
    / `Uint32Array` views over the scratch partitions →
    `commitPull`. Asserts all 96 elements per row match the
    pushed values. 6 × 32 × 3 = 576 element-level equivalences.
  - Cross-check: JS Bridge.pull on a fresh push of distinct
    arrays produces the exact same values via its umbrella
    TypedArray views.

  All seven 0.7.7 pins still pass.

### Why

Array decode is the second-largest chunk of JS hot-path work
in a typical Bridge consumer (after the per-slot atomic dance,
which 0.7.6 already moved into WASM). Each `frame.fieldName.set(
arrayView[slot])` call pays:
  - One umbrella-view lookup (array indexing into the
    pre-computed views array).
  - One TypedArray `.set()` call (the bulk copy itself —
    JS-engine-implemented, fast but still a JS call).
  - One property-write on the scratch frame object (the
    `frame.fieldName = …`).

The `copy_array` WASM export retires the umbrella lookup and the
property write — the bulk copy itself becomes a single
`memory.copy` instruction, which compiles to a native memcpy
intrinsic on every modern engine. The scratch region pattern
also makes the destination layout EXPLICIT to the caller, so
the inspector / audio worklet can read whichever subset of
arrays it needs without paying for the others.

The page-aligned scratch above the SAB ring keeps the producer's
view of the SAB unchanged. The producer never touches the
scratch pages (its push goes through `Bridge.push` which only
writes within `[0, sabBytes)`), and the consumer's scratch is
private to the consumer.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout unchanged.
The scratch region lives OUTSIDE the SAB-bytes the Bridge
declares it owns, so a producer that does not allocate via
`allocateWorkletMemory` (e.g., a plain `new SharedArrayBuffer(
Bridge.byteLength(...))`) is byte-identical to one that does.
The shim's overloaded allocator preserves the original
single-`number` form so 0.7.5/0.7.6/0.7.7 callers continue to
work unchanged.

### Tests

Pin 8 covers 576 array-element equivalences across three array
kinds (f64/f32/u32) plus the JS cross-check. All seven 0.7.7
pins still green. All other suites green — purely additive.

### Bench

push/pull/pullLatest medians unchanged at 1.20 μs. The WASM
end-to-end pullLatest is now ONE patch away from feature parity
with the JS path (trajectory SIMD remaining); the headline
bench (WASM vs JS pullLatest median) lands alongside that
patch when the comparison becomes meaningful.

### Documentation

`wasm/decoder.wat` gains a section header documenting the
`copy_array` operand order (the WASM spec puts `dst` first;
the export accepts `(src, dst, byteCount)` for readability and
swaps inside), the spec's overlap semantics (memmove), and the
endianness invariance of byte-level copies.
`WorkletMemoryAllocationOptions` and the overload form are
documented at the type definition. README integration lands
once the full pullLatest is WASM-backed.

## [0.7.7] — 2026-05-27

### Added — WASM scalar field decoders (Track 2 of the King roadmap, third patch)

First payload-decode patch in the Track 2 cohort. The WASM
consumer now decodes every scalar `FieldKind` the schema DSL
declares — `f64`, `f32`, `i64`, `u64`, `i32`, `u32`, `i16`, `u16`,
`i8`, `u8` — via the matching WebAssembly load instruction
flavor. Each reader takes the absolute byte offset within the
SAB and returns the typed scalar value; the caller composes
`RING_HEADER_BYTES + slot * frameByteSize + field.byteOffset`
once per (slot × field) pair.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** grows ten new exports:
  - `read_f64(off) → f64` (uses `f64.load align=1`).
  - `read_f32(off) → f32` (`f32.load align=1`).
  - `read_i64(off) → i64`, `read_u64(off) → i64`
    (both `i64.load align=1`; the unsigned cast happens JS-side).
  - `read_i32(off) → i32`, `read_u32(off) → i32`
    (both `i32.load align=1`; unsigned cast JS-side).
  - `read_i16(off) → i32` (`i32.load16_s align=1`).
  - `read_u16(off) → i32` (`i32.load16_u align=1`).
  - `read_i8(off)  → i32` (`i32.load8_s`).
  - `read_u8(off)  → i32` (`i32.load8_u`).

  All loads use `align=1` to accept arbitrary field
  alignment without trapping — the Bridge's schema compile
  packs fields tightly without natural-alignment padding,
  so a `u64` field can land on any 4-byte boundary.

- **`src/worklet/index.ts`** `WorkletConsumer` interface grows
  ten typed methods: `readF64`, `readF32`, `readI64`, `readU64`,
  `readI32`, `readU32`, `readI16`, `readU16`, `readI8`, `readU8`.
  Each accepts the absolute byte offset. The unsigned-cast shim
  helpers (`BigInt.asUintN(64, …)` for u64, `value >>> 0` for u32)
  live in the JS shim so the WASM instructions stay minimal.
  The instantiation guard now validates all 16 exports.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds Pin 7:
  - Defines a 10-field schema (one per kind) and pushes 5 rows
    of carefully-chosen edge-case values: i32 with high bit set
    (signed −1 vs unsigned 4 294 967 295), i64 spanning the
    signed/unsigned boundary, the 53-bit `Number.MAX_SAFE_INTEGER`
    pivot for BigInt boundary, i8/u8 at ±extremes, f64 with full
    precision and f32 with `Math.fround`-roundtrip equivalence.
  - For each frame: WASM `peekPull` → ten per-field WASM scalar
    reads via the new methods → `commitPull`. Asserts every
    read equals the pushed value.
  - Cross-check: JS Bridge.pull on a fresh push of the same
    edge-case row produces the EXACT same scalars, confirming
    JS-side decode and WASM-side decode agree on the bytes.

  All six 0.7.6 pins still pass.

### Why

The atomic dance (shipped in 0.7.6) routes through WASM but the
slot's payload still lives in the JS hot path — every field read
goes through a typed-array umbrella view + a property assignment
on the scratch frame object. The scalar decoders move the first
chunk of that work to WASM. Combined with subsequent patches
(array fields, SIMD trajectory) they progressively retire the
JS-side decode loop until the only JS hot-path work left is the
two WASM calls (`peekPullLatest` / `commitPullLatest`) plus the
post-decode interpretation step the caller chooses.

The split also makes the WASM decoder COMPOSABLE — a future
inspector that wants only the timestamp from a frame can call
just `readU64` for `tMacroNs` without paying for the rest of
the payload decode. The JS Bridge's `pull` decodes the whole
frame eagerly; WASM's per-field readers are lazy by design.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout unchanged.
The WASM load instructions produce bit-identical reads to the
JS Bridge's umbrella TypedArray views (little-endian, no
signedness disagreement after the JS-side cast shim). A 0.7.6
producer interoperates bit-for-bit with a 0.7.7 consumer using
the new readers, and vice-versa.

### Tests

Pin 7 covers all 10 scalar kinds × 5 edge-case rows = 50
field-level equivalences plus the JS cross-check. All seven
0.7.6 pins still green. The Bridge / BridgeFacades /
BridgeInputLane / schema / environment / phaseLock (incl.
Hermite) / concurrent stress / Float64RingBuffer legacy
suites all green — purely additive.

### Bench

push/pull/pullLatest medians unchanged at 1.20 μs. The WASM
path still has no end-to-end JS replacement, so no bench
delta to report. Headline bench (WASM vs JS pullLatest)
lands alongside the array + SIMD trajectory patches, when
WASM owns the full decode loop and the comparison becomes
meaningful.

### Documentation

`wasm/decoder.wat` gains a section header for the scalar
decoders documenting the alignment policy (`align=1`),
endianness contract (LE matching JS TypedArray views), and
signedness/instruction mapping per kind. `WorkletConsumer`
interface docstrings in `src/worklet/index.ts` cross-reference
the WAT contract. README integration lands once the full
pullLatest is WASM-backed.

## [0.7.6] — 2026-05-27

### Added — WASM-owned SPSC pull dance (Track 2 of the King roadmap, second patch)

The WASM consumer now owns the consumer-side atomic discipline for
both `pull` (FIFO) and `pullLatest` (drain-to-newest). The hot
path's most ordering-sensitive lines — the acquire-load of
`write_index`, the empty/non-empty arbitration, the
release-store of the advanced `read_index`, and the always-notify
that wakes a parked producer — execute inside WebAssembly, while
the slot's payload read (the schema-driven decode) stays JS-side
via the existing typed-array umbrella views. The split preserves
the load-bearing SPSC invariant: the producer cannot overwrite a
slot until the consumer releases its read on it.

**Patch surface (additive, wire-compatible — no SAB byte change):**

- **`wasm/decoder.wat`** grows four new exports:
  - **`peek_pull_latest(mask: i32) → i32`** — acquire-loads
    `write_index`, returns the slot index of the newest available
    frame (or `-1` on empty). Saves the observed `write_index`
    into a module-scoped i32 global so the matching commit knows
    what to release to. **No mutation of `read_index`** — the JS
    caller reads the slot bytes BETWEEN this peek and the commit.
  - **`commit_pull_latest()`** — release-stores `read_index ←
    saved write_index`, then `memory.atomic.notify` on lane 1 to
    wake a parked producer (always-notify; matches JS Bridge's
    unconditional discipline).
  - **`peek_pull(mask: i32) → i32`** — FIFO variant. Returns
    slot of the oldest unread frame (or `-1`). Saves
    `read_index + 1` for the matching commit.
  - **`commit_pull()`** — release-stores `read_index ← (saved
    readIdx + 1)`, then notifies.

  Empty-peek safety: both peeks SAFE-DEFAULT the pending-commit
  global to the CURRENT `read_index` before deciding empty vs
  non-empty. That makes commit-after-empty-peek (and
  commit-without-any-prior-peek) a true no-op store rather than
  rewinding the lane — important for defensive callers and for
  the smoke-test loops that mix peek and commit unconditionally.

- **`src/worklet/index.ts`** `WorkletConsumer` interface grows
  four typed methods: `peekPullLatest(mask)`, `commitPullLatest()`,
  `peekPull(mask)`, `commitPull()`. The instantiation guard
  in `instantiateConsumer` now validates ALL six exports
  (the 0.7.5 two plus these four) at construction time, so a
  stale/mis-built binary surfaces at instantiation rather than
  as a cryptic deep-in-audio-thread `is not a function`.

- **`tests/Bridge.wasmEquivalence.test.ts`** adds two pins:
  - **Pin 5 — FIFO pull equivalence.** Drives 150 push/peek/
    JS-read/commit cycles (9+ ring wraps at capacity=16),
    asserts every slot index agrees with `readIdx & mask`,
    asserts the DataView-read slot bytes match what was pushed
    (`seq: u64`, `tMacroNs: u64`, `value: f64` per frame),
    and asserts `read_index` advances by exactly one per commit.
  - **Pin 6 — pullLatest skip equivalence.** Drives bursts of
    1, 2, 5, 15, and 16 (= capacity) pushes without intermediate
    draining; a single peek+commit per burst must return the
    slot of the LAST frame and advance `read_index` ALL THE WAY
    to `write_index` (consuming K-1 older frames in one shot).
    Verifies the slot data matches the burst's tail frame.

  The two existing 0.7.5 header-readback pins still pass —
  purely additive.

### Why

The atomic dance is the consumer-side hot-path-critical
portion of `pullLatest`. Today's JS implementation pays a
property-access tax (six fields on the `SpscRing` instance:
`this.indices`, `this.mask`, the four counter-lane constants)
plus the per-call function-call overhead from the outer
`Bridge.pullLatest → SpscRing.pullLatest → Atomics.*` chain.
The WASM consumer eliminates all of it — the four exports
compile to single-digit instruction counts each.

The PEEK/COMMIT split is what lets us defer the schema-driven
payload decode (the JS-side `.set()` calls on the umbrella
typed-array views) to subsequent patches WITHOUT giving up the
WASM atomic-discipline win. Each later patch can move one decode
kind into WASM at a time (scalar → array → SIMD-vectorized
trajectory) and the equivalence corpus grows accordingly.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout unchanged.
The WASM-side atomic ops (`i32.atomic.load`, `i32.atomic.store`,
`memory.atomic.notify`) emit the exact same memory-model
guarantees as the JS-side `Atomics.load` / `Atomics.store` /
`Atomics.notify` they replace, so the SPSC invariant holds
identically. A producer running 0.7.5 (JS Bridge) interoperates
bit-for-bit with a 0.7.6 consumer using the WASM peek/commit
dance, and vice-versa.

### Tests

The two new equivalence pins land alongside the four 0.7.5
pins in `Bridge.wasmEquivalence.test.ts`; all six green.
All 0.7.5 suites (Bridge, BridgeFacades, BridgeInputLane,
schema, environment, Bridge.phaseLock incl. the Hermite pin,
two 1 M-frame concurrent stress runs, Float64RingBuffer
legacy) all green — purely additive change.

### Bench

push/pull/pullLatest medians unchanged (the JS path is what
the bench measures; the WASM path has no bench coverage yet).
Bench gates for WASM vs JS pullLatest land alongside the full
end-to-end WASM port (a later 0.7.x patch where the schema-
driven decode also lives inside WASM and the JS shim has no
hot-path work beyond the two WASM calls).

### Documentation

`wasm/decoder.wat` carries a self-contained section header
documenting the PEEK/COMMIT contract, the SPSC invariant the
split preserves, the memory-ordering guarantees of each
`i32.atomic.*` op vs its JS-side counterpart, and the empty-
peek safe-default discipline. `WorkletConsumer` interface
docstrings in `src/worklet/index.ts` mirror the WAT contract.
README integration lands once the full pullLatest is WASM-
backed.

## [0.7.5] — 2026-05-27

### Added — WASM consumer scaffolding (Track 2 of the King roadmap, first patch)

First cut of the WebAssembly fast-path consumer described in
Track 2 of the King roadmap. Today it ships the toolchain, the
shared-memory plumbing, the feature-detect probes, and a
smoke-test decoder that proves WASM-side atomic reads of the
Bridge SAB header agree bit-for-bit with the JS-side
`Atomics.load` of the same lanes. **Subsequent patches port the
full pullLatest protocol one decode kind at a time** (scalar →
array → trajectory → SIMD-vectorized trajectory → CAS-aware
drop-oldest). The pure-JS consumer path remains the canonical
default; the WASM path is opt-in via the new
`webgpu-audio-bridge/worklet` exports subpath.

**What landed in 0.7.5:**

- **`wasm/decoder.wat`** — minimal WebAssembly Text module
  exporting `read_write_index()` and `read_read_index()`, both
  `i32.atomic.load` operations over byte offsets 0 / 4 (the
  SPSC counter lanes of the SAB header). Imports `env.memory`
  with `(1 16384 shared)` bounds (1 page up to 1 GiB shared
  memory, matching the WebAssembly threads spec max). Smoke
  shape only — the SPSC protocol and the schema decode arrive
  in later patches. 101-byte binary.

- **`wasm/build.mjs`** — `wabt`-based WAT → WASM compiler.
  Both the `simd` and `threads` features are enabled at parse
  time so the later patches' f64x2 / f32x4 / `i32.atomic.*`
  ops compile without per-source flag drift. Outputs to
  `dist/worklet/<name>.wasm`. Discoverable by adding `.wat`
  files to `wasm/`; no entry-list edit required. Direct port
  of the website's `wasm/build.mjs` pattern (Phase 4b modal
  DSP infrastructure) — keeps the two pipelines in lockstep.

- **`src/worklet/wasmSimdSupport.ts`** — three feature probes:
  - `hasWasmSimd()` — validates a known-good 31-byte
    simd128-only module (same probe as the
    `wasm-feature-detect` npm package + Chrome's SIMD rollout
    docs).
  - `hasWasmThreads()` — validates a 14-byte shared-memory
    module + checks `SharedArrayBuffer` is in scope. The
    smoke-test decoder needs threads even before SIMD enters
    the picture.
  - `hasWasmConsumerSupport()` — conjunction of the two.
  All three cache per-process. Ported from the website's
  `src/lib/dimensional/wasmSimdSupport.ts` with the threads
  probe added.

- **`src/worklet/index.ts`** — the consumer-side JS shim:
  - `allocateWorkletMemory(byteLength)` — owner-side
    `WebAssembly.Memory({ shared: true })` allocator. Rounds
    up to the nearest 64 KiB page. Returns
    `{ memory, sab, byteLength, pages }` where `sab` IS
    `memory.buffer` — pass `sab` to `new Bridge(...)` and
    `memory` to `instantiateConsumer(...)` so the producer
    and consumer share one underlying buffer.
  - `instantiateConsumer(wasmBytes, memory)` — synchronous
    `WebAssembly.Instance` construction with the caller's
    shared memory as the `env.memory` import. Synchronous
    (NOT `WebAssembly.instantiate`, which is async and
    illegal in `AudioWorkletGlobalScope.process()`). Returns
    a typed `WorkletConsumer` handle.
  - `WorkletConsumer` interface — today exposes
    `readWriteIndex()` / `readReadIndex()` plus the raw
    `instance` for debugging. Grows the full pullLatest
    surface in later patches.

- **`webgpu-audio-bridge/worklet` exports subpath** —
  `package.json` now lists the consumer shim under the
  `./worklet` key with the standard `types` / `import` /
  `require` conditions, plus a direct `./worklet/decoder.wasm`
  entry for callers that need the binary URL. The root
  `webgpu-audio-bridge` export is unchanged.

- **`build:wasm` npm script + `build` chains it** — every
  `npm run build` now produces `dist/worklet/decoder.wasm`
  alongside the TS dist. `wabt` is a new devDep (~700 KiB
  pure-JS toolkit, no native deps).

- **`tests/Bridge.wasmEquivalence.test.ts`** — four pins:
  1. Feature-probe consistency (`hasWasmConsumerSupport ===
     hasWasmSimd && hasWasmThreads`).
  2. Binary loads in this runtime (`readFileSync` on the
     built `decoder.wasm` is non-empty and instantiates).
  3. WASM/JS header equivalence — 200 push/pull cycles
     against a `defineSchema({seq:u64, tMacroNs:u64,
     value:f64})` Bridge, asserting
     `consumer.readWriteIndex() === Atomics.load(int32View, 0)`
     and `consumer.readReadIndex() === Atomics.load(int32View, 1)`
     at every step. Headline guarantee.
  4. Memory identity — `memory.buffer === sab` and `sab
     instanceof SharedArrayBuffer`.

### Why

WASM-driven decode is the headline Track 2 cred from the King
roadmap: it eliminates the last credible source of audio
glitches (JS object allocation + V8 GC pauses on the audio
thread) and unlocks SIMD-vectorized trajectory decode for the
hot path. Shipping the scaffolding as a self-contained patch
gives every subsequent patch a stable target to grow against:
the build pipeline works, the toolchain decision (hand-written
WAT, harvested from the website's `modal-dsp.wat`
infrastructure) is settled, the feature-detect surface exists,
the shim's allocator + instantiator can be re-used as the
exports expand.

### Wire compatibility

Fully back- and forward-compatible. SAB byte layout
unchanged; the WASM module reads the EXACT same lanes JS does
via the EXACT same atomic primitives. A producer running 0.7.4
interoperates bit-for-bit with a 0.7.5 consumer using the
WASM shim, and vice-versa.

### Tests

- New `Bridge.wasmEquivalence.test.ts` (4 pins above).
- The new test is appended to the `npm test` and `npm run
  test:unit` scripts; both prepend `npm run build:wasm` so a
  fresh checkout's first test run produces the binary
  automatically.
- All 0.7.4 suites (Bridge, BridgeFacades, BridgeInputLane,
  schema, environment, Bridge.phaseLock incl. the Hermite
  pin, two 1 M-frame concurrent stress runs, Float64RingBuffer
  legacy) all green — purely additive change.

### Bench

push/pull/pullLatest medians unchanged. The WASM path has no
hot-loop integration yet, so there is no bench delta to
report this patch. Bench gates land alongside the
`pullLatest` WASM port (a later 0.7.x patch) where the
push/pull WASM-vs-JS median comparison becomes meaningful.

### Documentation

- `wasm/decoder.wat`, `wasm/build.mjs`, and
  `src/worklet/index.ts` each carry self-contained file
  headers documenting the SAB layout assumptions, the
  WebAssembly page-bounds math, the threads-vs-SIMD probe
  rationale, and the eventual full-decoder surface.
- README rewrite to introduce the `webgpu-audio-bridge/worklet`
  subpath lands in a follow-up alongside the first functional
  `pullLatest` WASM port (when the surface is meaningful
  enough to warrant the README real estate).

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
