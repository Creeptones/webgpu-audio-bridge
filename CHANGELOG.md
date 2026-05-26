# Changelog

All notable changes to this project will be documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
