/**
 * SpscRing<Schema> — extracted SAB / Atomics core of the bridge (0.6.8).
 *
 * This file is **internal-only** as of 0.6.8–0.6.9. It is not exported from
 * `src/index.ts`; only `Bridge.ts` consumes it. The 0.6.9 patch carved the
 * heap-side smoother / PLL / flow controller into dedicated state classes
 * (`FrameSmoother`, `ConsumerClockRecovery`, `AdaptiveFlowController`) —
 * SpscRing now composes one `AdaptiveFlowController` for the lane-2 PI
 * tick and exposes a slim test-hook `_updateFlowScale(writeIdx, readIdx)`
 * that wraps the controller. 0.6.10 promotes all four primitives to the
 * public composable API. Through 0.6.9 every public Bridge<S> method
 * continues to work bit-identically and no exported symbol is added.
 *
 * What lives here vs. what lives on Bridge:
 *
 *   SpscRing  (this file):
 *     - SAB allocation + layout constants (`byteLength`, `allocate`,
 *       `RING_HEADER_BYTES`, lane constants).
 *     - Header lanes 0..3 (write_index, read_index, flow_scale,
 *       torn_frame_counter) + lanes 4..7 carrying published PLL state
 *       (offset / drift / status; 0.6.16). All 8 lanes are now active —
 *       see the canonical lane table at the lane-index constants below.
 *     - `push` / `beginPush` / `commitPush` / `abortPush` / `pull` /
 *       `pullLatest` mechanics with the unconditional `Atomics.notify`
 *       protocol preserved as-is for 0.6.x (the lane-4 wait-flag wake
 *       protocol is 0.7.0 territory).
 *     - `available()`, `flowScaleHint()`, `tornFrameCount()` /
 *       `incrementTornFrameCount()`, `waitForData` / `waitForSpace`,
 *       `describeLayout()`.
 *     - The lane-2 adaptive flow-scale PI controller tick. The integrator
 *       state + math live on the composed `AdaptiveFlowController`
 *       (0.6.9); the ring writes the encoded result into lane 2.
 *
 *   Bridge<S>  (./Bridge.ts):
 *     - α-smoother dispatch (`pullSmoothed` / `pullLatestSmoothed`,
 *       `resetSmoother`) and the named skip policies. The blend itself
 *       lives on the composed `FrameSmoother` (0.6.9).
 *     - Schema-invariant classifier (`_classifyInvariant` + epsilon floor).
 *     - PLL dispatch (`observeConsumerTime`, `phaseLockedTime`,
 *       `resetPll`). The PI loop + offset state live on the composed
 *       `ConsumerClockRecovery` (0.6.9).
 *     - Per-frame evaluator (`evaluateInto`, `pullEvaluatedLatest`,
 *       `evaluateAtSampleOffset`, `setSampleRate`, `resetEvalCache`,
 *       `scratchEvaluatedFrame`).
 *     - `telemetry()` snapshot (gathers from Bridge state, the inner ring,
 *       and the three 0.6.9 internals).
 *
 * Bridge<S> holds one `SpscRing<S>` as `this.ring` and delegates every
 * ring-mechanic call. The pull-family methods on Bridge orchestrate the
 * ring pull + (optional) invariant handling + (optional) smoother blend.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     [byte 0..3]    write_index   producer counter (Atomics, release; wraps mod 2^32)
 *     [byte 4..7]    read_index    consumer counter (Atomics, release; wraps mod 2^32)
 *     [byte 8..11]   flow_scale    consumer→producer PI hint (Q16.16; 0.5..2.0)
 *                                  default 65536 = 1.0 (no scaling). Independent
 *                                  atomic — best-effort, no ordering vs the
 *                                  counter lanes. See "Adaptive backpressure"
 *                                  section below.
 *     [byte 12..15]  torn_frame_counter  monotonic Int32 wrap-counter; the
 *                                  consumer-side invariant handler on Bridge
 *                                  increments via incrementTornFrameCount on
 *                                  hard-error invariant failure. Read via
 *                                  bridge.telemetry().tornFrames. See "Schema
 *                                  invariants" in Bridge.ts.
 *                                  Lane table (canonical copy at the
 *                                  lane-index constants below):
 *                                    lane 0: write_index            (active, 0.4.0)
 *                                    lane 1: read_index             (active, 0.4.0)
 *                                    lane 2: flow_scale             (active, 0.5.0)
 *                                    lane 3: torn_frame_counter     (active, 0.6.0)
 *                                    lanes 4-5: PLL offset (Int64 ns) (active, 0.6.16)
 *                                    lane 6: PLL drift (Q16.16 ppm)   (active, 0.6.16)
 *                                    lane 7: PLL status word          (active, 0.6.16)
 *     [byte 16..31]  PLL state (16 bytes — lanes 4..7). Published by the
 *                              consumer's Bridge on every observeConsumerTime /
 *                              resetPll when publishPllToSab is on (default);
 *                              read cross-process via readPublishedPllState.
 *                              Were reserved through 0.6.15; the all-zero
 *                              default reads as "no published state".
 *
 *   Payload region (typed-array umbrella views at SAB byte 32):
 *     For each FieldKind present in the schema, one umbrella view spanning
 *     the entire payload region:
 *       new Float64Array(sab, 32, capacity * frameByteSize / 8)
 *       new Uint32Array (sab, 32, capacity * frameByteSize / 4)
 *       ... etc per type-family present
 *     Plus, per array field per slot, a precomputed typed-array view sized
 *     to the field's length pointing at that slot's bytes. These are used
 *     for zero-allocation .set()-style copies on push/pull.
 *
 *   Frame layout per slot:
 *     Fields are sorted by alignment class (8-byte first, then 4, then 2,
 *     then 1) with declared order preserved within a class — see
 *     defineSchema in ./schema.ts. Frame size is padded up to 8 so slot
 *     boundaries stay 8-aligned for the BigInt64/Float64 umbrella views.
 *
 * ─── Memory ordering ─────────────────────────────────────────────────────
 *
 * Producer push:
 *   1. Plain-read own write_index (single-producer guarantee).
 *   2. Acquire-load read_index. If write_index - read_index >= CAPACITY → full.
 *   3. Write payload (non-atomic typed-array stores via per-field writers
 *      and per-slot array views).
 *   4. Release-store write_index + 1. The release barrier guarantees the
 *      non-atomic payload stores happen-before any consumer acquire-load.
 *   5. Atomics.notify(write_index, 1) wakes any consumer parked via
 *      waitForData. Unconditional — see "Park / wake protocol" below.
 *
 * Consumer pull:
 *   1. Plain-read own read_index (single-consumer guarantee).
 *   2. Acquire-load write_index. If equal → empty.
 *   3. Read payload (non-atomic typed-array loads).
 *   4. Release-store read_index + 1.
 *   5. Atomics.notify(read_index, 1) wakes any producer parked via
 *      waitForSpace. Unconditional.
 *
 * No torn-frame re-check is needed. The strict push contract guarantees the
 * producer cannot be writing the slot the consumer is reading: push()
 * rejects when `write_index - read_index >= CAPACITY`, so the producer's
 * write_index cannot advance past read_index + CAPACITY, and the slot
 * indices `(write_index & mask)` and `(read_index & mask)` cannot collide
 * while there is an unread frame. The producer's release-store on
 * write_index establishes happens-before for the payload writes; the
 * consumer's acquire-load on write_index observes them. That is the full
 * synchronization the protocol needs.
 *
 * ─── Counter representation (0.4.0) ──────────────────────────────────────
 *
 * Counters are plain Int32 wrapping mod 2^32, computed via the standard
 * SPSC modular trick:
 *
 *   diff = (writeIdx - readIdx) | 0       // signed-32 subtraction
 *   slot = (idx >>> 0) & mask              // unsigned-then-mask
 *
 * The signed-32 diff is correct for any |true_diff| < 2^31. Capacity is
 * power-of-two and bounded (default: 16; max: 2^30), so the diff is always
 * small and the wrap is invisible. Slot mask is wrap-correct because the
 * low log2(capacity) bits don't depend on signed-ness.
 *
 * Wrap clock: 2^32 / 48000 ≈ 24h at audio rate; 2^32 / 60 ≈ 2.27 years at
 * a 60 Hz control-rate producer. The SEMANTIC monotonic seq is whatever
 * your schema declares (e.g. `physicsControlFrameSchema(n)` declares `seq:
 * u64` which is exact through 2^64) — the ring's INTERNAL counter only
 * needs to indicate "which slot is next" and "how full is the ring," both
 * of which are wrap-invariant operations.
 *
 * ─── Park / wake protocol (Atomics.wait / Atomics.notify) ─────────────────
 *
 * Always-notify (not edge-triggered). Push and pull unconditionally issue
 * Atomics.notify on the peer's lane after the release-store. An earlier
 * iteration of this protocol used an edge-trigger (notify only on the
 * empty→non-empty / full→non-full transition); under genuine 2-thread
 * contention that protocol misses wake-ups because the producer's wasEmpty
 * check almost always reads false (write_index > read_index while the
 * consumer is mid-drain), so the consumer ends up reliant on its
 * Atomics.wait timeout to make any progress at all. Always-notify is
 * correct by construction: a parked peer is guaranteed to be woken on the
 * next state change, and the syscall cost when nobody is parked is
 * dominated by the write itself (~100ns on Windows / Linux per
 * Atomics.notify with zero waiters).
 *
 * Atomics.wait correctness under the load-then-park race is provided by
 * the spec itself: Atomics.wait atomically compare-and-parks against the
 * expected value, so a producer that observed readIdx = X and then issues
 * Atomics.wait(indices, 1, X) is safe even if the consumer advances readIdx
 * between the two operations — the wait sees the new value and returns
 * "not-equal" immediately rather than parking forever.
 *
 * waitForData is NOT real-time safe (it blocks the calling thread up to
 * the timeout) and MUST NOT be called from an AudioWorklet's process()
 * method. The AudioWorklet always polls via pullLatest() and tolerates
 * misses. The notify on push is still emitted for the benefit of non-
 * realtime consumers (concurrent stress tests, bench harnesses, non-audio
 * downstream readers).
 *
 * ─── Adaptive backpressure (CFL-style, 0.5.0) ─────────────────────────────
 *
 * The ring exposes a soft rate-control signal on lane 2 (`flow_scale`,
 * Q16.16 fixed-point in [0.5, 2.0]; default 1.0 = no scaling). The
 * consumer runs a PI controller against pre-pull occupancy (`(write -
 * read) / capacity`) on every successful pull and stores the controller's
 * output into the lane. The producer reads it via `flowScaleHint()` and
 * may voluntarily honor it — by scaling its `dt`, dropping frames,
 * sleeping a fraction of its interval, etc. The ring does NOT enforce:
 * the lane is a hint, not a gate. The existing capacity-based push reject
 * (`push` returns false when full) is the hard contract; `flow_scale` is
 * the soft layer that, when honored, keeps the producer/consumer rate
 * match continuous so the hard reject is reached only under genuine
 * overload.
 *
 * Math. With `err = occupancy - 0.5`, controller state `integral += err`
 * (clamped to ±20 for anti-windup), and gains `Kp = 0.5`, `Ki = 0.05`:
 *
 *   scale = clamp(1 - Kp·err - Ki·integral, 0.5, 2.0)
 *
 * Sign: positive err (consumer is overfull) gives `scale < 1` (producer
 * should slow down); negative err (consumer is starved) gives `scale > 1`
 * (producer should speed up). The integrator removes steady-state offset.
 *
 * Where it runs. `_updateFlowScale(writeIdx, readIdx)` is called inline
 * from `pull` / `pullLatest` AFTER the release-store on read_index but
 * only on the successful path (an empty-pull early-return does NOT update
 * the lane; its "occupancy = 0" reading would misleadingly say "producer
 * too slow" when in fact the consumer hasn't actually consumed).
 * `available()` is a pure observer and never touches the lane.
 *
 * 0.6.9: the controller math + integrator state moved into a dedicated
 * `AdaptiveFlowController` class (`./AdaptiveFlowController.ts`). SpscRing
 * holds one as `this.flowController` and `_updateFlowScale` is now a
 * three-line bridge: compute `buffered`, call `flowController.tick(...)`,
 * `Atomics.store` the encoded result into lane 2. The PI gains, the
 * anti-windup limit, and the Q16.16 encode all live on the controller.
 *
 * ─── Schema-dispatch overhead ─────────────────────────────────────────────
 *
 * Compared to a hand-rolled single-shape code path, SpscRing<S> pays a
 * small dispatch cost on the hot path: a per-scalar-field closure call
 * (each closure captures one umbrella view + one offset + one stride +
 * the field name). Closures are precomputed at construction; the call
 * site is an indexed-loop over a small array of writer closures. For
 * typical schemas (5-10 scalars + a handful of arrays) the overhead is
 * ~50-150ns/op on top of the ~1.1μs Atomics.notify-dominated baseline.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * Paul Adenot's `ringbuf.js` (2018) is the canonical SPSC-over-SAB
 * technique that this library extends. See README §Acknowledgments for
 * the full lineage. (Earlier releases had a hand-rolled `Float64RingBuffer`
 * class that hosted the in-source attribution; that file was removed at
 * 0.9.0 — the attribution lives in the README now.)
 */

import {
  describeSchemaLayout,
  kindByteSize,
  kindTsType,
  type CompiledField,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";
import { AdaptiveFlowController } from "./AdaptiveFlowController.js";
import { buildScratchFrame } from "./_heap.js";

export const RING_HEADER_BYTES = 32;
/** Active SPSC counter lanes: write_index (Int32 lane 0), read_index (Int32
 *  lane 1). Other active control lanes (flow_scale on lane 2, torn_frame on
 *  lane 3) are accounted for separately — this constant counts only SPSC
 *  counters. Exported for back-compat with consumers that imported it from
 *  Bridge.ts. */
export const RING_HEADER_LANES = 2;
/** 32-byte header viewed as Int32 = 8 lanes total. */
export const RING_HEADER_INT32_LANES = 8;

// Internal lane indices into the Int32 header view.
//   lanes 0-1: SPSC counters (acquire/release ordering, wrap-mod-2^32)
//   lane 2:    flow_scale — Q16.16 consumer→producer hint (0.5.0)
//   lane 3:    torn_frame_counter — Int32 monotonic wrap-counter (0.6.0)
//   lanes 4-5: PLL offset (Int64 ns, atomic via aliased BigInt64Array; 0.6.16)
//   lane 6:    PLL drift (Q16.16 ppm signed Int32; 0.6.16)
//   lane 7:    PLL status word (bit 0 = locked, bits 1-31 reserved; 0.6.16)
export const WRITE_IDX_LANE = 0;
export const READ_IDX_LANE = 1;
export const FLOW_SCALE_LANE = 2;
export const TORN_FRAME_LANE = 3;
export const PLL_OFFSET_LANE_LOW = 4;
export const PLL_OFFSET_LANE_HIGH = 5;
export const PLL_DRIFT_LANE = 6;
export const PLL_STATUS_LANE = 7;
// PLL status word bit positions.
const PLL_STATUS_LOCKED_BIT = 1; // bit 0
// Q16.16 conversion factor for drift ppm publication. Drift range is
// effectively ±32768 ppm, which dwarfs any realistic clock drift (≤ 200 ppm).
const PLL_DRIFT_Q16_16 = 65536;

// Flow-scale fixed-point constant. Q16.16 encoding lives on
// AdaptiveFlowController (controller math + encode), but SpscRing keeps a
// local copy of the Q quantum for the `flowScaleHint()` decode (Atomics
// load + divide). Range [0.5, 2.0] maps to [32768, 131072], all within
// positive signed-32 → Atomics.load on Int32Array returns the stored
// value bit-for-bit (no sign weirdness).
const FLOW_SCALE_Q = AdaptiveFlowController.Q;

export interface BridgeAllocation<S extends Schema<FieldsObject, any>> {
  sab: SharedArrayBuffer;
  capacity: number;
  schema: S;
}

/**
 * Producer-side overflow disposition (0.6.12). Selects what `push` does when
 * the ring is full.
 *
 *  - `'reject'` (default, preserves 0.4.0..0.6.11 behavior bit-exact): push
 *    returns false; the caller decides. With 0.5.0's soft `flowScaleHint`
 *    already driving the producer's cadence, hard reject is rare in practice
 *    — it covers only the cases where the producer cannot honor the hint at
 *    all.
 *
 *  - `'drop-newest'`: push returns true but does NOT write. The frame the
 *    producer was about to send is silently dropped; the ring's existing
 *    older frames survive. Useful for telemetry-style streams where the
 *    older context is more valuable than the newest update, e.g. an audit
 *    log that must not lose state transitions even if the latest tick is
 *    skipped. The drop counter increments; no SAB mutation; no race with
 *    the consumer.
 *
 *  - `'drop-oldest'`: push CAS-advances `read_index` by one (atomically
 *    kicking out the oldest unread frame), then writes the new frame into
 *    the freed slot, advances `write_index`, and notifies. Returns true.
 *    Useful for freshness-wins streams where the newest update matters
 *    most.
 *
 *    Multi-thread safety. SPSC's normal invariant — only the consumer
 *    writes `read_index` — is relaxed: under drop-oldest the producer
 *    also CAS-writes `read_index` on overflow. **As of 0.7.2, the
 *    consumer-side pull path under drop-oldest is overrun-aware**: it
 *    captures `R0 = Atomics.load(READ_IDX_LANE)` before reading the
 *    slot, then commits the read via `Atomics.compareExchange(R0,
 *    R0+1)`. On CAS failure the producer overran us mid-read; the
 *    consumer discards the (potentially torn) payload and retries. No
 *    torn frame reaches the caller. Pairing with `.withInvariant(...)`
 *    is no longer required for correctness under drop-oldest — the
 *    invariant lane remains useful for cross-IPC bit-rot detection
 *    (separate concern; see §Cross-IPC bit-rot detection in the
 *    README), but is no longer a defensive bolt-on against this race.
 *
 *    Cost: the overrun-aware pull pays one extra Atomics op per call
 *    vs the reject hot path (plain index read → Atomics.load; plain
 *    Atomics.store → compareExchange). Per-policy bench in
 *    `bench/Bridge.bench.ts` keeps drop-oldest's medians honest;
 *    reject / drop-newest / block fast paths are byte-identical to
 *    0.7.1 (the variant is selected via a construct-time boolean
 *    check that V8 constant-folds per-instance).
 *
 *    Single-thread use (test code, sequential producer/consumer
 *    alternation) has no race at all; drop-oldest behaves exactly as
 *    documented with the new frame replacing the oldest unread one.
 *    The CAS-commit branch in the consumer is taken in both single-
 *    and multi-thread settings — there's no producer/consumer alternation
 *    optimization, just one consistent code path.
 *
 *  - `'block'`: push parks the producer via `waitForSpace(blockTimeoutMs)`
 *    when full, then retries once. If `waitForSpace` returns `'ok'` or
 *    `'not-equal'` (consumer drained), push proceeds and returns true. If
 *    `waitForSpace` returns `'timed-out'`, push returns false — same
 *    failure surface as `'reject'` but only after exhausting the wait.
 *
 *    Producer MUST be on a thread where `Atomics.wait` is permitted (not
 *    the browser main thread, not the AudioWorklet's `process()`). The
 *    'block' policy is a convenience over the existing `flowScaleHint` +
 *    manual `waitForSpace` loop the README documents for critical-data
 *    streams; bake it in once at construction time and the per-push
 *    decision goes away.
 *
 * Picked at SpscRing / Bridge / BridgeConsumer construction time. The
 * choice is immutable for the lifetime of the ring — the SAB protocol
 * cannot safely change mid-flight (a producer half-way through a
 * drop-oldest CAS sequence cannot coordinate with a peer that thinks the
 * policy is `'reject'`).
 */
export type BackpressurePolicy =
  | "reject"
  | "drop-newest"
  | "drop-oldest"
  | "block";

/** Optional opts bag for the `SpscRing` constructor (0.6.12). All fields
 *  optional; omitted fields default as documented per-field.
 *
 *  Forward-compatible shape — future patches can add fields here without
 *  breaking the constructor signature. */
export interface SpscRingOptions {
  /** Producer-side overflow disposition. See `BackpressurePolicy` for the
   *  full per-policy contract. Default: `'reject'` (preserves
   *  0.4.0..0.6.11 behavior bit-exact). */
  readonly policy?: BackpressurePolicy;
  /** Timeout (milliseconds) for the `'block'` policy's internal
   *  `waitForSpace` call. `undefined` means "wait indefinitely" (matches
   *  `Atomics.wait`'s default). Ignored for non-`'block'` policies.
   *  Default: `undefined`. */
  readonly blockTimeoutMs?: number;
}

type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array
  | BigInt64Array
  | BigUint64Array;

interface TypedArrayCtor<T extends AnyTypedArray> {
  new (sab: SharedArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
}

function ctorForKind(kind: FieldKind): TypedArrayCtor<AnyTypedArray> {
  switch (kind) {
    case "u64": return BigUint64Array as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i64": return BigInt64Array  as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f64": return Float64Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u32": return Uint32Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i32": return Int32Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f32": return Float32Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u16": return Uint16Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i16": return Int16Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u8":  return Uint8Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i8":  return Int8Array      as unknown as TypedArrayCtor<AnyTypedArray>;
  }
}

function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

type ScalarOp = (slot: number, frame: Record<string, unknown>) => void;

/** Per-call result mutated by SpscRing.pull / pullLatest. The ring owns this
 *  scratch object so each call mutates it in place — no per-call allocation.
 *  Bridge reads the fields immediately after the call returns; nothing else
 *  on SpscRing touches them between calls. Internal — not exported from
 *  index.ts. */
export interface SpscPullResult {
  /** True iff a frame was consumed (payload written into `out`). */
  ok: boolean;
  /** For `pullLatest`: number of older frames discarded (≥ 0 on ok).
   *  For `pull`: always 0 on ok. Undefined on ok=false. */
  skipped: number;
  /** Stored invariant value read from the slot under an invariant schema;
   *  meaningless under a no-invariant schema. Read BEFORE the release-store
   *  on read_index so the slot bytes are still ours; the Bridge-side
   *  classifier runs after, on heap state only. */
  invariantStored: number;
  /** writeIdx observed at pull time (post-acquire). Used by tests / future
   *  observability paths; the ring's flow-scale tick has already consumed it. */
  preWriteIdx: number;
  /** readIdx observed at pull time (pre-release). Used by tests / future
   *  observability paths. */
  preReadIdx: number;
}

/**
 * SpscRing<S> — internal SAB / Atomics core for Bridge<S> (0.6.8 extract).
 *
 * Internal as of 0.6.8 — not exported from index.ts. The full surface is
 * documented in the file header above.
 */
export class SpscRing<S extends Schema<FieldsObject, any>> {
  public readonly capacity: number;
  public readonly schema: S;
  /** Frame size in bytes; matches schema.frameByteSize. */
  public readonly frameByteSize: number;

  /** Whole-SAB byte view, cached once for the zero-decode `pushRaw` memcpy
   *  so the hot path never re-allocates a destination view. */
  private readonly _sabU8: Uint8Array;
  /** Reusable scratch frame for recomputing the invariant on the `pushRaw`
   *  path (decode slot bytes → run the JS invariant fn). Pre-allocated with a
   *  heap typed array per array field. Null for no-invariant schemas, where
   *  `pushRaw` stays a pure memcpy + publish. */
  private readonly _invariantScratch: Record<string, unknown> | null;
  /** Out-param scratch for `_applyOverflowPolicy`: the (possibly advanced)
   *  readIdx to use after a drop-oldest / block decision. Instance field so the
   *  shared overflow helper allocates nothing on the drop-heavy path. */
  private _ovfReadIdx = 0;

  private readonly indices: Int32Array;
  private readonly mask: number;

  /** Per array field per slot: a typed-array view pointing at that slot's
   *  bytes for that field. Used for zero-alloc .set() on push/pull. */
  private readonly arrayViews: AnyTypedArray[][];
  /** Compiled array fields, in order — index matches arrayViews. */
  private readonly arrayLayout: ReadonlyArray<CompiledField>;
  /** Compiled scalar fields, in order — index matches scalarWriters/Readers. */
  private readonly scalarLayout: ReadonlyArray<CompiledField>;

  /** Per-scalar-field write closure: writes frame[name] into the slot. */
  private readonly scalarWriters: ReadonlyArray<ScalarOp>;
  /** Per-scalar-field read closure: copies slot value into outFrame[name]. */
  private readonly scalarReaders: ReadonlyArray<ScalarOp>;

  /** One pre-built `beginPush` frame per ring slot (0.9.68). Each frame's
   *  array fields alias the slot's stable SAB-backed views (which never change
   *  for the life of the ring), so `beginPush` hands back the cached object and
   *  only resets scalars — no object allocation on the hot path. Keeps the
   *  closure-decoder (non-`"raw"` `BridgeGPUSource`) steady state allocation-
   *  free, matching the `pushRaw` / `"raw"` story. The array CONTAINER is
   *  frozen; the per-slot frame objects stay mutable (scalars reset on acquire,
   *  fields written by the caller). */
  private readonly slotPushFrames: ReadonlyArray<Record<string, unknown>>;
  /** Zero value per scalar field, aligned to `scalarLayout` (0.9.68).
   *  Precomputed so `beginPush`'s scalar reset avoids a per-call `kindTsType`
   *  branch. `0n` for bigint kinds, `0` otherwise. */
  private readonly scalarZeros: ReadonlyArray<number | bigint>;

  /** Active beginPush/commitPush handle, or null. */
  private pendingPushFrame: Record<string, unknown> | null = null;
  private pendingPushSlot: number = -1;

  /** F64 umbrella view used to read/write the hidden `__invariant` lane on
   *  invariant-enabled schemas. Null when `schema.invariant === null`, in
   *  which case the invariant block in push/pull is a single null-check.
   *  The classifier itself lives on Bridge — SpscRing only handles the
   *  SAB read/write of the lane. */
  private readonly invariantView: Float64Array | null;
  /** Per-slot stride in f64 elements (= `frameByteSize / 8`). Used only
   *  when `invariantView` is non-null. */
  private readonly invariantSlotStrideF64: number;
  /** Element offset within a slot of the `__invariant` lane in f64 units.
   *  Used only when `invariantView` is non-null. */
  private readonly invariantElemOffsetF64: number;

  /** Adaptive flow-scale PI controller (0.6.9 extract). Owns the integral
   *  state and the controller math; the ring is responsible only for
   *  writing the encoded result into lane 2. See AdaptiveFlowController.ts
   *  for the controller contract. */
  private readonly flowController: AdaptiveFlowController = new AdaptiveFlowController();

  /** Producer-side overflow disposition (0.6.12). See `BackpressurePolicy`
   *  for the per-policy contract. Frozen at construction; baking it in
   *  once avoids a per-push policy dispatch on the fast path (the
   *  `'reject'` default takes a single `if (full) return false` branch
   *  that V8 inlines well). */
  public readonly policy: BackpressurePolicy;

  /** Timeout for the `'block'` policy's internal `waitForSpace` call.
   *  Captured at construction; immutable. `undefined` = wait forever
   *  (matches `Atomics.wait` default). */
  private readonly blockTimeoutMs: number | undefined;

  /** True iff the consumer-side pull path must use the CAS-commit
   *  overrun-aware variant (0.7.2). Set at construction from
   *  `policy === 'drop-oldest'`. Frozen for the ring's lifetime so V8
   *  can constant-fold the branch per-instance: a reject / drop-newest
   *  / block ring's `pull` sees `if (false)` and the existing fast path
   *  inlines unchanged.
   *
   *  Why a boolean cache rather than `this.policy === 'drop-oldest'`
   *  inline: the field is monomorphic-shape friendly. V8 can read it
   *  as a single Smi/oddball compare instead of a string equality
   *  on the policy enum. The bench gate (10 μs hard budget, ~1.2 μs
   *  reject median) catches any deopt either way. */
  private readonly _needsOverrunAware: boolean;

  /** Heap-side counter of frames the policy dropped at the producer
   *  (`'drop-newest'` increments on every overflow; `'drop-oldest'`
   *  increments on every successful CAS advance of `read_index`). Read
   *  via `droppedCount()` for `telemetry().droppedFrames`. Heap-only —
   *  not a SAB lane — because it tracks a producer-side decision and
   *  cross-process observability is not in scope for 0.6.12. The
   *  per-thread counter is exact for the producer that owns this ring;
   *  a consumer's separate `SpscRing` instance over the same SAB sees
   *  its own (zero) counter, which is correct: drops are a producer
   *  fact, not a wire-format fact. */
  private droppedFrames: number = 0;

  /** Heap-side telemetry counters (0.6.13). Each is per-instance and
   *  monotonic from construction until the ring is discarded. Same
   *  "per-thread, not cross-process" caveat as `droppedFrames`: a
   *  consumer's separate `SpscRing` over the same SAB sees its own
   *  (zero) counters for the producer-side ones and vice-versa, which
   *  is correct — these track a specific peer's behavior, not a
   *  wire-format fact. */
  /** Frames successfully written into the ring. `'drop-newest'` does
   *  NOT increment (the frame never made it in); `'drop-oldest'`
   *  DOES (a new frame was written + an old one was evicted, both
   *  counted on their respective lanes); `'block'` DOES on the
   *  eventual write; `'reject'` DOES on each true-return. */
  private pushedFrames: number = 0;
  /** Frames returned to the consumer via `pull` / `pullLatest`. One
   *  increment per ok=true result, regardless of how many frames
   *  `pullLatest` skipped past — the skipped frames live on
   *  `skippedFrames`. */
  private pulledFrames: number = 0;
  /** Frames consumed-and-discarded by `pullLatest` (the `skipped`
   *  count, summed over all calls). Useful as the explicit "freshness
   *  cost" alongside `pulledFrames` — together they reconstruct the
   *  total drain rate the consumer is sustaining. */
  private skippedFrames: number = 0;
  /** Duration in nanoseconds of the most recent `waitForSpace` call
   *  that actually parked (`Atomics.wait` returned `'ok'` or
   *  `'timed-out'`). Zero if `waitForSpace` has not parked since
   *  construction or always returned the immediate `'not-equal'`
   *  path (i.e., the queue was never full at the wait moment). */
  private lastFullWaitNs: number = 0;
  /** Duration in nanoseconds of the most recent `waitForData` call
   *  that actually parked. Same semantics as `lastFullWaitNs`. */
  private lastEmptyWaitNs: number = 0;
  /** High-water mark of `(writeIdx - readIdx)` observed at any
   *  push/pull moment since construction. Producer push records the
   *  post-write buffered count; consumer pull/pullLatest record the
   *  pre-pull buffered count. The maximum across both observation
   *  points is the deepest the ring has ever been seen by either
   *  peer, which is the "did your sizing match your traffic?"
   *  diagnostic that drives dashboard sizing. */
  private maxOccupancyEverSeen: number = 0;

  /** Reused scratch for pull / pullLatest results. SpscRing mutates this in
   *  place each call; Bridge reads it immediately after the call returns.
   *  No external lifetime — do not retain references across pull calls. */
  public readonly pullResult: SpscPullResult = {
    ok: false,
    skipped: 0,
    invariantStored: 0,
    preWriteIdx: 0,
    preReadIdx: 0,
  };

  constructor(
    sab: SharedArrayBuffer,
    capacity: number,
    schema: S,
    opts: SpscRingOptions = {},
  ) {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(
        `SpscRing: capacity must be power of two, got ${capacity}`,
      );
    }
    // Cap at 2^30 so the signed-32 diff used by the counter algebra never
    // approaches 2^31 even under malformed peers — the wrap-invisible
    // subtraction needs headroom. (Practically, capacity is small: the
    // canonical control-rate ring is 16.)
    if (capacity > (1 << 30)) {
      throw new Error(
        `SpscRing: capacity must be ≤ 2^30 (signed-32 diff headroom), got ${capacity}`,
      );
    }
    const expectedBytes = SpscRing.byteLength(capacity, schema);
    if (sab.byteLength < expectedBytes) {
      throw new Error(
        `SpscRing: SAB too small (${sab.byteLength} bytes, need ${expectedBytes} for capacity=${capacity}, schema.frameByteSize=${schema.frameByteSize})`,
      );
    }

    this.capacity = capacity;
    this.schema = schema;
    this.frameByteSize = schema.frameByteSize;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
    this._sabU8 = new Uint8Array(sab);
    this.mask = capacity - 1;
    // PLL offset lanes 4-5 live at bytes 16-23 of the same Int32Array
    // header. As of 0.8.2 the publish path writes them as two Int32 stores
    // (BigInt-free); the legacy aliased BigInt64 view was retired then.
    // SAB byte layout unchanged.

    // Policy + block-timeout from opts. Validated here so invalid configs
    // surface at construction rather than as a confusing branch-miss later.
    const policy = opts.policy ?? "reject";
    if (
      policy !== "reject" &&
      policy !== "drop-newest" &&
      policy !== "drop-oldest" &&
      policy !== "block"
    ) {
      throw new Error(
        `SpscRing: unknown backpressure policy '${String(policy)}'; ` +
          `expected 'reject' | 'drop-newest' | 'drop-oldest' | 'block'`,
      );
    }
    this.policy = policy;
    this._needsOverrunAware = policy === "drop-oldest";
    const t = opts.blockTimeoutMs;
    if (t !== undefined && !(Number.isFinite(t) && t >= 0)) {
      throw new Error(
        `SpscRing: blockTimeoutMs must be a non-negative finite number or undefined, got ${String(t)}`,
      );
    }
    this.blockTimeoutMs = t;
    // Seed flow_scale = 1.0 so any producer that reads `flowScaleHint()`
    // before the consumer has issued a single pull sees "no scaling." Both
    // peers construct their own ring over the SAB; this CAS sets the lane
    // ONLY if it's still 0 (fresh SAB), so a late-constructed peer cannot
    // clobber a consumer's already-running controller state.
    Atomics.compareExchange(
      this.indices,
      FLOW_SCALE_LANE,
      0,
      AdaptiveFlowController.DEFAULT_Q,
    );

    // Build one umbrella view per type-family present in the schema. These
    // are captured by the per-scalar-field writer/reader closures below; we
    // don't keep them on `this` because nothing else uses them.
    const payloadBytes = capacity * schema.frameByteSize;
    const umbrellas: Partial<Record<FieldKind, AnyTypedArray>> = {};
    for (const kind of schema.compiled.typesPresent) {
      const Ctor = ctorForKind(kind);
      const elemSize = kindByteSize(kind);
      umbrellas[kind] = new Ctor(sab, RING_HEADER_BYTES, payloadBytes / elemSize);
    }

    // Split compiled fields into scalars and arrays, preserve order.
    const scalars: CompiledField[] = [];
    const arrays: CompiledField[] = [];
    for (const f of schema.compiled.fields) {
      if (f.isArray) arrays.push(f);
      else scalars.push(f);
    }
    this.scalarLayout = Object.freeze(scalars);
    this.arrayLayout = Object.freeze(arrays);

    // Precompute per-array-field, per-slot typed-array views.
    const arrayViews: AnyTypedArray[][] = arrays.map((field) => {
      const Ctor = ctorForKind(field.kind);
      const views: AnyTypedArray[] = new Array(capacity);
      for (let s = 0; s < capacity; s++) {
        const byteOffset =
          RING_HEADER_BYTES + s * schema.frameByteSize + field.byteOffset;
        views[s] = new Ctor(sab, byteOffset, field.length);
      }
      return views;
    });
    this.arrayViews = arrayViews;

    // 0.9.68 — pre-build one beginPush frame per ring slot + the scalar zero
    // table. The array fields alias the slot's stable SAB views (built just
    // above, fixed for the ring's life), so beginPush only resets scalars and
    // never allocates. Frames are built arrays-then-scalars in the same order
    // the old inline beginPush used, so every slot frame shares one hidden
    // class.
    const scalarZeros: (number | bigint)[] = scalars.map((f) =>
      kindTsType(f.kind) === "bigint" ? 0n : 0,
    );
    this.scalarZeros = Object.freeze(scalarZeros);
    const slotPushFrames: Record<string, unknown>[] = new Array(capacity);
    for (let s = 0; s < capacity; s++) {
      const frame: Record<string, unknown> = {};
      for (let i = 0; i < arrays.length; i++) {
        frame[arrays[i]!.name] = arrayViews[i]![s]!;
      }
      for (let i = 0; i < scalars.length; i++) {
        frame[scalars[i]!.name] = scalarZeros[i]!;
      }
      slotPushFrames[s] = frame;
    }
    this.slotPushFrames = Object.freeze(slotPushFrames);

    // Invariant umbrella + stride / offset. Schema's invariant spec guarantees
    // byteOffset is 8-aligned and frameByteSize is a multiple of 8 (compile
    // step pads userEnd up to 8 before appending the f64 invariant lane).
    if (schema.invariant !== null) {
      // F64 umbrella was added to typesPresent by compileLayout for invariant
      // schemas, so umbrellas['f64'] is guaranteed populated.
      this.invariantView = umbrellas.f64 as Float64Array;
      this.invariantSlotStrideF64 = schema.frameByteSize / 8;
      this.invariantElemOffsetF64 = schema.invariant.byteOffset / 8;
      // Pre-allocate the pushRaw invariant-recompute scratch: heap typed
      // arrays per array field, 0/0n scalars (filled by scalarReaders on
      // decode). Same shape as `Bridge<S>.scratchFrame()`.
      this._invariantScratch = buildScratchFrame(schema.compiled.fields);
    } else {
      this.invariantView = null;
      this.invariantSlotStrideF64 = 0;
      this.invariantElemOffsetF64 = 0;
      this._invariantScratch = null;
    }

    // Build per-scalar-field writer / reader closures. Each closure captures
    // its umbrella view, stride, in-frame element offset, and field name.
    // The closures are per-(schema instance) monomorphic; V8 keeps them
    // inline-cached per call site.
    const writers: ScalarOp[] = [];
    const readers: ScalarOp[] = [];
    for (const field of scalars) {
      const elemSize = kindByteSize(field.kind);
      const stride = schema.frameByteSize / elemSize; // integer; frame is padded to 8
      const elemOffsetInFrame = field.byteOffset / elemSize; // integer; field is class-aligned
      const view = umbrellas[field.kind]!;
      const name = field.name;
      if (kindTsType(field.kind) === "bigint") {
        const v = view as BigInt64Array | BigUint64Array;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as bigint;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      } else {
        // All number-typed kinds: Float64/Float32/Uint32/Int32/Uint16/Int16/Uint8/Int8.
        // The TypedArray subscript-assign coerces / clamps appropriately at the runtime layer.
        const v = view as Exclude<AnyTypedArray, BigInt64Array | BigUint64Array>;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as number;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      }
    }
    this.scalarWriters = Object.freeze(writers);
    this.scalarReaders = Object.freeze(readers);
  }

  /** Byte size needed for a ring of `(capacity, schema)`. */
  static byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): number {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`SpscRing.byteLength: capacity must be power of two`);
    }
    return RING_HEADER_BYTES + capacity * schema.frameByteSize;
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): BridgeAllocation<S> {
    const sab = new SharedArrayBuffer(SpscRing.byteLength(capacity, schema));
    return { sab, capacity, schema };
  }

  /**
   * Shared cold-path backpressure dispatch for `push` and `pushRaw`. Called
   * ONLY when the ring is full, so it never touches the hot success path —
   * extracting it keeps the two producers from drifting (the concurrent test
   * relies on identical semantics) at zero hot-path cost. Allocation-free: the
   * advanced readIdx is returned via `this._ovfReadIdx`, the decision as a code:
   *   0 → return false (reject, or block timed-out / still-full)
   *   1 → return true  (drop-newest: counted, write skipped)
   *   2 → proceed to write using `this._ovfReadIdx` (drop-oldest / block-ok)
   *
   * Note `beginPush` deliberately does NOT use this — its drop-newest returns
   * null (surfaces the rejection) rather than the silent-success `push` gives.
   */
  private _applyOverflowPolicy(writeIdx: number, readIdx: number): 0 | 1 | 2 {
    // The reject branch (default) is the common case and lands as a single
    // forward-predicted branch for V8.
    const p = this.policy;
    if (p === "reject") {
      return 0;
    }
    if (p === "drop-newest") {
      this.droppedFrames = (this.droppedFrames + 1) | 0;
      return 1;
    }
    if (p === "drop-oldest") {
      // Post-_dropOldest the ring has space (either we CAS-advanced or the
      // consumer raced and drained). Proceed to the normal write path.
      this._ovfReadIdx = this._dropOldest(readIdx, writeIdx);
      return 2;
    }
    // 'block': park until consumer drains or timeout. On timeout, surface the
    // same false-return that 'reject' would, so callers can distinguish "could
    // not be enqueued" from "enqueued".
    const status = this.waitForSpace(this.blockTimeoutMs);
    if (status === "timed-out") {
      return 0;
    }
    // Re-load readIdx; the consumer advanced.
    const r = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - r) | 0) >= this.capacity) {
      // Pathological: waitForSpace returned ok but the ring is somehow still
      // full. Cannot happen in SPSC (consumer is the only one that decreases
      // buffered) but defensive return surfaces it rather than corrupting state.
      return 0;
    }
    this._ovfReadIdx = r;
    return 2;
  }

  /**
   * Producer side. Copies `view`'s fields into the next free slot, advances
   * write_index, and notifies any parked consumer. Returns false if the ring
   * is full.
   *
   * Hot path: per scalar field, one closure call (precomputed at construction);
   * per array field, one typed-array .set() into the slot's pre-cached view.
   * No per-call allocations.
   */
  push(view: FrameFor<S>): boolean {
    // SPSC: own counter is plain-read (sole producer), peer counter
    // acquire-loaded. Both i32, wrap-mod-2^32; the signed-32 subtraction
    // `(a - b) | 0` gives the correct true diff for |true_diff| < 2^31.
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    let readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      const action = this._applyOverflowPolicy(writeIdx, readIdx);
      if (action === 0) return false; // reject / block-timeout
      if (action === 1) return true; // drop-newest (counted, no write)
      readIdx = this._ovfReadIdx; // drop-oldest / block: proceed to write
    }
    // Unsigned-then-mask: the low log2(capacity) bits don't depend on
    // signed-ness, so this is wrap-invariant.
    const slot = (writeIdx >>> 0) & this.mask;
    const sw = this.scalarWriters;
    const frame = view as unknown as Record<string, unknown>;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      // Each av[i][slot] is the precomputed per-slot view for field al[i].
      // The .set() copies from the user's view into the SAB slot.
      (av[i]![slot] as { set: (src: ArrayLike<number> | ArrayLike<bigint>) => void })
        .set(frame[al[i]!.name] as ArrayLike<number> | ArrayLike<bigint>);
    }
    // Compute + store invariant BEFORE release-store so the consumer's
    // acquire-load on writeIdx observes both the payload and the invariant
    // bytes as a single happens-before unit. See Bridge.ts "Schema
    // invariants" for the classifier protocol detail.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    const nextWrite = (writeIdx + 1) | 0;
    Atomics.store(this.indices, WRITE_IDX_LANE, nextWrite); // release
    // Unconditional notify — see file header on the always-notify protocol.
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    this.pushedFrames = (this.pushedFrames + 1) | 0;
    this._recordOccupancy((nextWrite - readIdx) | 0);
    return true;
  }

  /**
   * Zero-decode push. Copies exactly one frame's bytes (`frameByteSize`) from
   * `src` straight into the next free slot via a single native `Uint8Array.set`
   * (memcpy) — no per-field encode loop — then publishes with the same
   * release-store + notify protocol as `push`. The consumer cannot distinguish
   * a `pushRaw` frame from a `push` frame: identical slot bytes, identical
   * invariant lane, identical happens-before ordering.
   *
   * Intended for GPU readback (`BridgeGPUSource` "raw" mode), where the mapped
   * buffer is already laid out byte-for-byte as the SAB frame — guaranteed when
   * the producing shader's struct came from `emitWgslStruct(schema)`.
   *
   * Honesty: this is "zero-decode" (one memcpy, no JS field-dispatch loop), not
   * "zero-copy" — the bytes still move — and it is O(frameByteSize) in the copy,
   * O(1) in JS field-dispatch. For no-invariant schemas it is a pure memcpy +
   * publish. For invariant schemas the bytes are decoded into a cached scratch
   * frame solely to recompute the JS invariant before publish (the contract of
   * `.withInvariant(fn)` is preserved); the no-invariant fast path is untouched.
   *
   * @param src        one frame of bytes — an `ArrayBuffer` or any typed-array /
   *                   DataView whose backing buffer holds the frame.
   * @param srcOffset  byte offset into `src` where the frame begins (default 0).
   * @returns          true if published; false if the ring was full and the
   *                   policy declined (reject / block-timeout). drop-newest
   *                   returns true (counted, not written), drop-oldest evicts.
   * @throws RangeError if `src` has fewer than `frameByteSize` bytes at offset.
   */
  pushRaw(src: ArrayBuffer | ArrayBufferView, srcOffset = 0): boolean {
    const srcU8 =
      src instanceof ArrayBuffer
        ? new Uint8Array(src)
        : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    if (
      srcOffset < 0 ||
      srcOffset + this.frameByteSize > srcU8.byteLength
    ) {
      throw new RangeError(
        `SpscRing.pushRaw: source too small — need ${this.frameByteSize} bytes ` +
          `at offset ${srcOffset}, have ${srcU8.byteLength}`,
      );
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    let readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      const action = this._applyOverflowPolicy(writeIdx, readIdx);
      if (action === 0) return false;
      if (action === 1) return true;
      readIdx = this._ovfReadIdx;
    }
    const slot = (writeIdx >>> 0) & this.mask;
    const dest = RING_HEADER_BYTES + slot * this.frameByteSize;
    // The single native byte copy. subarray is a view (no copy); .set memcpys.
    this._sabU8.set(
      srcU8.subarray(srcOffset, srcOffset + this.frameByteSize),
      dest,
    );
    // Compute + store invariant BEFORE the release-store (same ordering as
    // push). The memcpy above may have written garbage into the slot's
    // invariant lane; this overwrites it with the authoritative value.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      const scratch = this._invariantScratch!;
      this._decodeSlotInto(slot, scratch);
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(scratch);
    }
    const nextWrite = (writeIdx + 1) | 0;
    Atomics.store(this.indices, WRITE_IDX_LANE, nextWrite); // release
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    this.pushedFrames = (this.pushedFrames + 1) | 0;
    this._recordOccupancy((nextWrite - readIdx) | 0);
    return true;
  }

  /**
   * Decode one slot's user fields into `outFrame` (scalars via scalarReaders,
   * arrays copied from the slot's SAB view into `outFrame`'s pre-allocated typed
   * arrays). Used only by `pushRaw`'s invariant-recompute path; the hidden
   * invariant lane is not decoded (the caller recomputes it).
   */
  private _decodeSlotInto(slot: number, outFrame: Record<string, unknown>): void {
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, outFrame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      (outFrame[al[i]!.name] as { set: (s: AnyTypedArray) => void }).set(
        av[i]![slot]!,
      );
    }
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only
   * one begin/commit pair can be in flight at a time per ring instance.
   *
   * Allocation (0.9.68). The returned frame is the slot's PRE-BUILT cached
   * object (`slotPushFrames[slot]`), not a fresh allocation — array fields
   * already alias this slot's SAB views, and only the scalars are reset to
   * zero on each call. The steady-state path therefore allocates nothing,
   * keeping the closure-decoder readback (non-`"raw"` `BridgeGPUSource`) GC-
   * free. Consequence: the frame is only valid between `beginPush` and the
   * matching `commitPush`/`abortPush`; two `beginPush` calls that land on the
   * same slot (one ring revolution apart) return the SAME object identity.
   * Do not retain the frame past `commitPush` — its array views point at a
   * slot the producer will overwrite, exactly as before.
   *
   * Policy interaction (0.6.12). `beginPush` honors the same backpressure
   * policy as `push`: under `'drop-newest'` it returns null (the producer
   * can detect and increment its own counters); under `'drop-oldest'` it
   * CAS-advances readIdx before opening the slot; under `'block'` it
   * parks via `waitForSpace`. The `'drop-newest'` null-return is
   * deliberate — the two-step path lets the caller do work between
   * `beginPush` and `commitPush`, and silently swallowing the push as
   * `push` does would be a surprise. Use `push` for the silent-drop
   * semantics or check the `null` return + read `droppedCount()`.
   */
  beginPush(): FrameFor<S> | null {
    if (this.pendingPushFrame !== null) {
      throw new Error(
        "SpscRing.beginPush: a previous beginPush is still pending; call commitPush or abortPush first",
      );
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    let readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      const p = this.policy;
      if (p === "reject") {
        return null;
      }
      if (p === "drop-newest") {
        // Silent drop is not appropriate when the caller is about to
        // build a frame; surface the rejection.
        this.droppedFrames = (this.droppedFrames + 1) | 0;
        return null;
      }
      if (p === "drop-oldest") {
        readIdx = this._dropOldest(readIdx, writeIdx);
      } else {
        const status = this.waitForSpace(this.blockTimeoutMs);
        if (status === "timed-out") return null;
        readIdx = Atomics.load(this.indices, READ_IDX_LANE);
        if (((writeIdx - readIdx) | 0) >= this.capacity) return null;
      }
    }
    const slot = (writeIdx >>> 0) & this.mask;
    // 0.9.68 — hand back the slot's pre-built frame (array fields already alias
    // this slot's SAB views) and reset only the scalars to their zero value.
    // No object/view allocation on the steady-state push path.
    const frame = this.slotPushFrames[slot]!;
    const sl = this.scalarLayout;
    const sz = this.scalarZeros;
    for (let i = 0; i < sl.length; i++) frame[sl[i]!.name] = sz[i]!;
    this.pendingPushFrame = frame;
    this.pendingPushSlot = slot;
    return frame as FrameFor<S>;
  }

  /** Publish the frame opened by beginPush. */
  commitPush(): void {
    if (this.pendingPushFrame === null) {
      throw new Error("SpscRing.commitPush: no beginPush in flight");
    }
    const slot = this.pendingPushSlot;
    const frame = this.pendingPushFrame;
    const sw = this.scalarWriters;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    // Array writes happened in place via the user's `.set(...)` calls into
    // the SAB-backed views handed out by beginPush. Nothing to copy here.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const nextWrite = (writeIdx + 1) | 0;
    Atomics.store(this.indices, WRITE_IDX_LANE, nextWrite);
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
    this.pushedFrames = (this.pushedFrames + 1) | 0;
    // Re-load readIdx for the high-water mark; the consumer may have
    // advanced between beginPush and commitPush.
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    this._recordOccupancy((nextWrite - readIdx) | 0);
  }

  /** Discard the frame opened by beginPush without publishing. */
  abortPush(): void {
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Mutates and returns the shared `pullResult` scratch:
   * `ok=false` on empty (nothing else valid), else `ok=true` with
   * `skipped=0`, the stored invariant value (meaningful under an invariant
   * schema), and the observed pre-pull writeIdx / readIdx.
   *
   * The release-store on read_index and the trailing notify happen inline.
   * The flow-scale PI tick runs only on the success path (see header).
   *
   * The Bridge layer reads `pullResult.invariantStored` and dispatches to
   * the classifier; SpscRing itself never inspects the value.
   */
  pull(out: FrameFor<S>): SpscPullResult {
    if (this._needsOverrunAware) return this._pullOverrunAware(out);
    const r = this.pullResult;
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
    if (writeIdx === readIdx) {
      r.ok = false; // empty — exact i32 equality is wrap-correct
      return r;
    }
    const slot = (readIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    // Read stored invariant BEFORE release-store so the slot bytes are still
    // ours. The classifier on Bridge only touches heap state so it can
    // safely run AFTER release.
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    this._updateFlowScale(writeIdx, readIdx);
    this._recordOccupancy((writeIdx - readIdx) | 0);
    this.pulledFrames = (this.pulledFrames + 1) | 0;
    r.ok = true;
    r.skipped = 0;
    r.invariantStored = invariantStored;
    r.preWriteIdx = writeIdx;
    r.preReadIdx = readIdx;
    return r;
  }

  /**
   * Internal helper. Mirrors `pull` exactly minus the trailing
   * `Atomics.notify(this.indices, READ_IDX_LANE, 1)`. The underscore prefix
   * marks it as internal-only (same convention as `_updateFlowScale`) — it
   * is NOT part of the public surface and is not re-exported from
   * `index.ts`.
   *
   * Two intentional callers:
   *
   *   1. `bench/Bridge.bench.ts` uses this to isolate the per-pull notify
   *      cost from the rest of the pull path (the 0.6.11 measurement cell).
   *
   *   2. `BridgeInputLane.pullAll` uses this as the inner-loop primitive
   *      (0.8.2): the loop drains N frames via `_pullNoNotify`, then on the
   *      success branch (count > 0) the caller issues ONE
   *      `_notifyReadAdvance()` to wake any parked producer. The
   *      cumulative per-frame notify cost ~10 µs/burst that the
   *      BridgeInputLane file header used to flag as future work is now
   *      folded into a single trailing notify — empty-pull early returns
   *      skip the notify entirely.
   *
   * Both callers are SAFE because the caller takes responsibility for
   * waking the producer. **Direct external use without a matching trailing
   * notify on the success branch is unsafe**: a parked producer would
   * miss the wake. Use `pull` (which bundles the notify) for everything
   * else.
   *
   * Dispatches to `_pullOverrunAwareNoNotify` when `_needsOverrunAware`
   * is true (drop-oldest policy) so the no-notify primitive remains
   * correct under every overflow policy. Mirrors the dispatch shape of
   * `pull`.
   *
   * Added in 0.6.11 as a bench shim; promoted to documented internal
   * helper in 0.8.2 when `BridgeInputLane.pullAll` adopted it.
   */
  _pullNoNotify(out: FrameFor<S>): SpscPullResult {
    if (this._needsOverrunAware) return this._pullOverrunAwareNoNotify(out);
    const r = this.pullResult;
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
    if (writeIdx === readIdx) {
      r.ok = false;
      return r;
    }
    const slot = (readIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release
    // NB: Atomics.notify deliberately omitted — that's the whole point of
    // this shim. Flow-scale tick still runs so the bench compares like for
    // like on the post-release work; the occupancy + pulled counters also
    // stay in sync with the public `pull` path so the bench's stats
    // surface matches.
    this._updateFlowScale(writeIdx, readIdx);
    this._recordOccupancy((writeIdx - readIdx) | 0);
    this.pulledFrames = (this.pulledFrames + 1) | 0;
    r.ok = true;
    r.skipped = 0;
    r.invariantStored = invariantStored;
    r.preWriteIdx = writeIdx;
    r.preReadIdx = readIdx;
    return r;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames
   * are discarded. Mutates and returns `pullResult` with `skipped` ≥ 0 on
   * success (0 if a single frame was waiting, N if N+1 frames were
   * buffered), `ok=false` if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): SpscPullResult {
    if (this._needsOverrunAware) return this._pullLatestOverrunAware(out);
    const r = this.pullResult;
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) {
      r.ok = false;
      return r;
    }
    const newestIdx = (writeIdx - 1) | 0;
    const skipped = ((newestIdx - readIdx) | 0); // ≥ 0 by the empty-check above
    const slot = (newestIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0); // consume everything up to writeIdx
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    this._updateFlowScale(writeIdx, readIdx);
    this._recordOccupancy((writeIdx - readIdx) | 0);
    this.pulledFrames = (this.pulledFrames + 1) | 0;
    this.skippedFrames = (this.skippedFrames + skipped) | 0;
    r.ok = true;
    r.skipped = skipped;
    r.invariantStored = invariantStored;
    r.preWriteIdx = writeIdx;
    r.preReadIdx = readIdx;
    return r;
  }

  /**
   * `pull` variant that survives the producer racing the same `read_index`
   * lane (0.7.2). Selected at construction when `policy === 'drop-oldest'`.
   *
   * Under drop-oldest, the producer's `_dropOldest` advances `read_index`
   * itself to evict the oldest unread frame. That breaks the strict-SPSC
   * "only the consumer writes `read_index`" invariant — a consumer mid-read
   * on the slot the producer just stole would observe torn bytes (the
   * producer's new payload write overlaps the consumer's read).
   *
   * The CAS-commit pattern detects exactly that race and recovers:
   *
   *   1. `R0 = Atomics.load(READ_IDX_LANE)` — must be Atomics (not the
   *      plain index read used in the reject hot path) because the
   *      producer is now also a writer of this lane.
   *   2. Snapshot `W = Atomics.load(WRITE_IDX_LANE)`; empty-check.
   *   3. Read payload (scalars + arrays + invariant) into `out` from
   *      slot `R0 & mask`.
   *   4. `Atomics.compareExchange(READ_IDX_LANE, R0, R0+1)` to commit
   *      the read. If the CAS succeeds, no one advanced `read_index`
   *      between our `R0` capture and the commit — the bytes we read
   *      correspond to the slot we accounted for, return success.
   *      If the CAS fails, the producer advanced `R0` past our slot
   *      while we were mid-read — discard `out` (potentially torn)
   *      and retry the whole loop.
   *
   * Bounded retries. Under SPSC, only the producer can advance
   * `read_index` other than us; each advance is paired with a slot
   * eviction that opens space. So the producer's CAS-advance rate is
   * bounded by its push rate. Even under pathological contention, the
   * loop terminates within ~`capacity` iterations (after which the
   * producer has cycled the entire ring and must wait for genuine
   * pull progress).
   *
   * Correctness pin: the concurrent stress test under drop-oldest
   * (added in 0.7.2 — see `tests/Bridge.concurrent.test.ts`) asserts
   * every consumed frame is bit-exact against the producer's recipe
   * AND `pushed === consumed + dropped`. Any torn frame slipping
   * through trips that bit-exact gate immediately.
   *
   * Cost: roughly one extra Atomics op per pull vs the reject hot
   * path (the plain index read becomes an Atomics.load; the plain
   * Atomics.store becomes a compareExchange). The bench separates
   * this in its 0.7.2 per-policy section.
   */
  private _pullOverrunAware(out: FrameFor<S>): SpscPullResult {
    const r = this.pullResult;
    // Bounded retry — see method header. capacity + 1 is the worst-case
    // bound under SPSC; in practice the loop body runs once per pull.
    for (let attempt = 0; attempt <= this.capacity; attempt++) {
      const readIdx = Atomics.load(this.indices, READ_IDX_LANE);  // acquire
      const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
      if (writeIdx === readIdx) {
        r.ok = false; // empty
        return r;
      }
      const slot = (readIdx >>> 0) & this.mask;
      const frame = out as unknown as Record<string, unknown>;
      const sr = this.scalarReaders;
      for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
      const al = this.arrayLayout;
      const av = this.arrayViews;
      for (let i = 0; i < al.length; i++) {
        const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
        dst.set(av[i]![slot]!);
      }
      const invariantStored = this.invariantView !== null
        ? this.invariantView[
            slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
          ]!
        : 0;
      // CAS-commit: claim slot `readIdx` only if no one (i.e. the
      // producer's `_dropOldest`) advanced READ_IDX past us mid-read.
      const prev = Atomics.compareExchange(
        this.indices,
        READ_IDX_LANE,
        readIdx,
        (readIdx + 1) | 0,
      );
      if (prev !== readIdx) continue; // producer overran — retry whole pull
      Atomics.notify(this.indices, READ_IDX_LANE, 1);
      this._updateFlowScale(writeIdx, readIdx);
      this._recordOccupancy((writeIdx - readIdx) | 0);
      this.pulledFrames = (this.pulledFrames + 1) | 0;
      r.ok = true;
      r.skipped = 0;
      r.invariantStored = invariantStored;
      r.preWriteIdx = writeIdx;
      r.preReadIdx = readIdx;
      return r;
    }
    // Unreachable under SPSC for the same reason as `_dropOldest`'s
    // defensive return: the producer cannot infinitely advance
    // `read_index` without the consumer also advancing it. Defensive
    // return surfaces any future protocol change as `ok = false`.
    const r2 = this.pullResult;
    r2.ok = false;
    return r2;
  }

  /**
   * `pullLatest` variant matching `_pullOverrunAware` (0.7.2). Same
   * CAS-commit shape, advancing `read_index` from the snapshotted
   * `R0` to the snapshotted `W` (consuming everything up to writeIdx
   * at once), and discarding torn reads via CAS failure → retry.
   *
   * The `skipped` counter is computed inside the loop from the
   * snapshotted `R0` and `W` so it stays consistent with the read
   * that actually succeeded — if the CAS fails and we retry with
   * fresh values, the new iteration's skipped count is recomputed
   * against the new snapshot.
   */
  private _pullLatestOverrunAware(out: FrameFor<S>): SpscPullResult {
    const r = this.pullResult;
    for (let attempt = 0; attempt <= this.capacity; attempt++) {
      const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
      const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
      if (writeIdx === readIdx) {
        r.ok = false;
        return r;
      }
      const newestIdx = (writeIdx - 1) | 0;
      const skipped = ((newestIdx - readIdx) | 0);
      const slot = (newestIdx >>> 0) & this.mask;
      const frame = out as unknown as Record<string, unknown>;
      const sr = this.scalarReaders;
      for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
      const al = this.arrayLayout;
      const av = this.arrayViews;
      for (let i = 0; i < al.length; i++) {
        const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
        dst.set(av[i]![slot]!);
      }
      const invariantStored = this.invariantView !== null
        ? this.invariantView[
            slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
          ]!
        : 0;
      // CAS-commit advances READ_IDX from `readIdx` straight to
      // `writeIdx` — drains everything older than the newest in one
      // atomic step, matching the reject-path semantics. On CAS
      // failure, retry the whole drain.
      const prev = Atomics.compareExchange(
        this.indices,
        READ_IDX_LANE,
        readIdx,
        writeIdx | 0,
      );
      if (prev !== readIdx) continue;
      Atomics.notify(this.indices, READ_IDX_LANE, 1);
      this._updateFlowScale(writeIdx, readIdx);
      this._recordOccupancy((writeIdx - readIdx) | 0);
      this.pulledFrames = (this.pulledFrames + 1) | 0;
      this.skippedFrames = (this.skippedFrames + skipped) | 0;
      r.ok = true;
      r.skipped = skipped;
      r.invariantStored = invariantStored;
      r.preWriteIdx = writeIdx;
      r.preReadIdx = readIdx;
      return r;
    }
    const r2 = this.pullResult;
    r2.ok = false;
    return r2;
  }

  /**
   * `_pullNoNotify` variant for the drop-oldest CAS-commit path (0.8.2).
   * Selected at construction when `policy === 'drop-oldest'` via the same
   * `_needsOverrunAware` flag that gates `_pullOverrunAware` / `_pullLatestOverrunAware`.
   *
   * Identical to `_pullOverrunAware` minus the trailing
   * `Atomics.notify(READ_IDX_LANE, 1)` — caller (`BridgeInputLane.pullAll`)
   * issues ONE notify at burst end via `_notifyReadAdvance()` on the
   * success branch. The CAS-commit retry loop is preserved verbatim from
   * `_pullOverrunAware`; only the per-frame notify is elided.
   *
   * Same correctness pin applies: the concurrent stress test under
   * drop-oldest (`tests/Bridge.concurrent.test.ts`) asserts every consumed
   * frame is bit-exact against the producer's recipe. The retry-on-CAS-
   * failure shape protects against the producer racing the same
   * `read_index` lane while the consumer is mid-read; the omitted notify
   * doesn't widen that window — it just defers the wake-up signal.
   */
  private _pullOverrunAwareNoNotify(out: FrameFor<S>): SpscPullResult {
    const r = this.pullResult;
    for (let attempt = 0; attempt <= this.capacity; attempt++) {
      const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
      const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
      if (writeIdx === readIdx) {
        r.ok = false;
        return r;
      }
      const slot = (readIdx >>> 0) & this.mask;
      const frame = out as unknown as Record<string, unknown>;
      const sr = this.scalarReaders;
      for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
      const al = this.arrayLayout;
      const av = this.arrayViews;
      for (let i = 0; i < al.length; i++) {
        const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
        dst.set(av[i]![slot]!);
      }
      const invariantStored = this.invariantView !== null
        ? this.invariantView[
            slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
          ]!
        : 0;
      const prev = Atomics.compareExchange(
        this.indices,
        READ_IDX_LANE,
        readIdx,
        (readIdx + 1) | 0,
      );
      if (prev !== readIdx) continue;
      // Notify deliberately omitted — caller pairs N pulls with one
      // `_notifyReadAdvance()` on the success branch.
      this._updateFlowScale(writeIdx, readIdx);
      this._recordOccupancy((writeIdx - readIdx) | 0);
      this.pulledFrames = (this.pulledFrames + 1) | 0;
      r.ok = true;
      r.skipped = 0;
      r.invariantStored = invariantStored;
      r.preWriteIdx = writeIdx;
      r.preReadIdx = readIdx;
      return r;
    }
    const r2 = this.pullResult;
    r2.ok = false;
    return r2;
  }

  /**
   * Trailing notify primitive for amortized-notify consumer patterns
   * (0.8.2). Pairs with `_pullNoNotify`: the caller drains N frames via
   * `_pullNoNotify` in a loop, then issues ONE `_notifyReadAdvance()` at
   * burst end on the success branch (count > 0) to wake any parked
   * producer. Empty-pull early returns must NOT call this — there's no
   * state change to signal.
   *
   * Equivalent to the per-frame trailing
   * `Atomics.notify(this.indices, READ_IDX_LANE, 1)` that the regular
   * `pull` path issues on every successful frame, lifted to a standalone
   * helper so the inner-loop primitive can be paired with a single
   * trailing notify across N pulls. Wake-count = 1: under SPSC the parked
   * producer is unique, one wake is sufficient.
   *
   * The underscore prefix marks this as internal-only. Not re-exported.
   */
  _notifyReadAdvance(): void {
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
  }

  /**
   * Drain every unread frame in the ring into successive entries of `out`,
   * in FIFO order, until either the ring is empty or the buffer fills.
   * Returns the number of frames written.
   *
   * Headline consumer primitive for the **event-burst** access pattern —
   * one `Atomics.notify` per call (at burst end on the success branch),
   * not per frame. Compared to a hand-rolled loop over public `pull()`,
   * the trailing-notify shape cuts the per-burst notify cost from O(N)
   * to O(1) while preserving the exact same per-frame protocol (acquire
   * load on write_index, release store on read_index, drop-oldest CAS
   * dispatch when policy demands it).
   *
   * Promoted from a `BridgeInputLane.pullAll`-internal pattern in 0.9.31
   * (was 0.9.3 in the original cohort plan; renumbered when the cadence
   * slowed). The body folds in the prior `pullAll` loop verbatim;
   * `BridgeInputLane.pullAll` is now a one-line forwarder that
   * preserves the input-lane facade's external contract.
   *
   * ─── Caller contract ────────────────────────────────────────────────
   *
   * - `out` must be an array of pre-allocated frame views (one per slot
   *   the caller is prepared to handle this call). Use
   *   `BridgeInputLane.scratchEventBuffer(n)` for the canonical shape,
   *   or hand-roll with `bridge.scratchFrame()` × n.
   * - `maxCount`, if provided, caps the drain
   *   (`min(out.length, maxCount)`). Useful when the caller wants to
   *   time-slice events across multiple quanta even if more are buffered.
   * - Frames beyond the drain limit stay in the ring and are returned on
   *   the next call. The ring's normal back-pressure (`'reject'` /
   *   `'drop-oldest'` / `'drop-newest'` / `'block'`) applies on the
   *   producer side if the consumer chronically under-drains.
   *
   * ─── Invariant note ─────────────────────────────────────────────────
   *
   * If the schema was declared with `.withInvariant(...)`, the stored
   * invariant value is read but NOT classified — `drainNoNotify` is the
   * raw-pull primitive and doesn't run the OK / SOFT / HARD classifier.
   * Callers who want classification should use `BridgeConsumer.pull`
   * one frame at a time (with the per-frame notify), or wrap the
   * classifier around each drained frame here.
   *
   * ─── Backpressure-policy dispatch ────────────────────────────────────
   *
   * Internally dispatches to `_pullNoNotify` (which itself dispatches to
   * `_pullOverrunAwareNoNotify` when `_needsOverrunAware` is true, i.e.
   * the ring is configured with `'drop-oldest'`). Both fast paths share
   * the same trailing-notify protocol; the difference is the CAS-commit
   * retry loop on the drop-oldest path, not the notify shape.
   */
  drainNoNotify(out: FrameFor<S>[], maxCount?: number): number {
    if (!Array.isArray(out)) {
      throw new Error(
        "SpscRing.drainNoNotify: out must be an array of pre-allocated frame views",
      );
    }
    const bufLen = out.length;
    const cap = maxCount === undefined
      ? bufLen
      : Math.min(bufLen, Math.max(0, maxCount | 0));
    let count = 0;
    while (count < cap) {
      const slot = out[count];
      if (slot === undefined) {
        throw new Error(
          `SpscRing.drainNoNotify: out[${count}] is undefined ` +
          `(pre-allocate every slot before calling drainNoNotify; ` +
          `BridgeInputLane.scratchEventBuffer(n) produces the canonical shape)`,
        );
      }
      const r = this._pullNoNotify(slot);
      if (!r.ok) break;
      count++;
    }
    // Single trailing notify on the success branch. Empty-pull early
    // returns skip — there's no state change to publish.
    if (count > 0) this._notifyReadAdvance();
    return count;
  }

  /**
   * Run one PI controller cycle against the pre-pull occupancy and publish
   * the new flow_scale on lane 2. Called from `pull` / `pullLatest` after
   * the release-store on read_index, only on the successful branch — empty-
   * pull early-returns skip this so the controller never sees a misleading
   * "occupancy = 0 because nobody pulled" sample.
   *
   * Pre-pull buffered count = `(writeIdx - readIdx) | 0`, where readIdx is
   * the value BEFORE the consumer's increment — i.e. "how full was the ring
   * when the consumer arrived to take a frame." The wrap-invariant signed
   * subtraction `(a - b) | 0` is the same trick used throughout for the
   * SPSC counters. The controller's `tick` computes occupancy = buffered /
   * capacity internally; the ring is responsible only for the wrap-correct
   * subtraction and the SAB write.
   *
   * See AdaptiveFlowController.ts for the PI math + anti-windup design;
   * see file header "Adaptive backpressure" for the producer-side
   * honor semantics. The 0.6.9 extract moves the controller state and
   * math off SpscRing while preserving this method as the test-hook seam
   * (`Bridge._updateFlowScale` → `SpscRing._updateFlowScale` →
   * `AdaptiveFlowController.tick`).
   *
   * Public on SpscRing only because `SpscRing` is internal-only at 0.6.9;
   * Bridge delegates the public `_updateFlowScale` private test-hook
   * through to this method. Not exported from `index.ts`.
   */
  _updateFlowScale(writeIdx: number, readIdx: number): void {
    const buffered = (writeIdx - readIdx) | 0;
    const encoded = this.flowController.tick(buffered, this.capacity);
    Atomics.store(this.indices, FLOW_SCALE_LANE, encoded);
  }

  /**
   * Producer-side `'drop-oldest'` (0.6.12). CAS-advances `read_index` to
   * kick out the oldest unread frame and open one slot for the new push.
   *
   * Loop semantics. Each iteration:
   *   1. Compute the proposed new `read_index = observedRead + 1`.
   *   2. `Atomics.compareExchange(readLane, observedRead, observedRead+1)`.
   *      - On success: the producer "won" — slot at `observedRead & mask`
   *        is now considered consumed; the producer can write at
   *        `writeIdx & mask` (which aliases to the same slot in a
   *        capacity-equals-buffered ring). Return the new readIdx.
   *      - On failure: the consumer raced and advanced readIdx itself.
   *        Re-load readIdx. If we now have space (buffered < capacity),
   *        return without dropping — the consumer's drain already made
   *        room. Otherwise loop and retry.
   *
   * Bounded iteration. Under SPSC, only the consumer can advance readIdx
   * (other than us). Each consumer advance opens one slot of space. So
   * the loop terminates in at most `capacity + 1` iterations even under
   * adversarial racing — long before that the consumer has drained the
   * ring entirely and we have free space without needing to drop.
   *
   * Multi-thread race window — closed in 0.7.2. The CAS guarantees
   * readIdx atomicity. A consumer mid-pull on the just-stolen slot
   * would historically observe torn bytes because the producer's
   * subsequent payload write overlaps the consumer's read. As of
   * 0.7.2 the consumer-side pull under drop-oldest uses the CAS-commit
   * pattern (`_pullOverrunAware` / `_pullLatestOverrunAware`): the
   * consumer captures `R0 = Atomics.load(READ_IDX_LANE)` before
   * reading the slot, then `Atomics.compareExchange(R0, R0+1)` to
   * commit. If the producer's `_dropOldest` advanced READ_IDX past
   * `R0` while the consumer was mid-read, the CAS fails and the
   * consumer discards the (potentially torn) payload and retries.
   * No torn frame ever reaches the caller. `.withInvariant(...)`
   * pairing is no longer required for correctness — the invariant
   * lane remains useful for cross-IPC bit-rot detection (separate
   * concern), but the drop-oldest race itself no longer needs it
   * as a defense.
   *
   * Caller contract. Only invoked from the `push` / `beginPush` overflow
   * branches under `policy === 'drop-oldest'`. Returns the post-CAS
   * `readIdx` so the caller can confirm capacity headroom; the caller
   * proceeds to write at `writeIdx & mask` knowing the slot is free
   * (modulo the documented race).
   */
  private _dropOldest(observedRead: number, writeIdx: number): number {
    let readIdx = observedRead;
    // Bounded retry — see the loop semantics block above.
    for (let attempt = 0; attempt <= this.capacity; attempt++) {
      // Re-check capacity each iteration; the consumer may have drained
      // since the caller observed readIdx.
      if (((writeIdx - readIdx) | 0) < this.capacity) {
        return readIdx;
      }
      const next = (readIdx + 1) | 0;
      const prev = Atomics.compareExchange(
        this.indices,
        READ_IDX_LANE,
        readIdx,
        next,
      );
      if (prev === readIdx) {
        // Won the CAS — we own the slot eviction. Update counter.
        this.droppedFrames = (this.droppedFrames + 1) | 0;
        return next;
      }
      // Lost the CAS — consumer raced. Re-load and retry.
      readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    }
    // Unreachable under SPSC (consumer can only advance readIdx; after
    // `capacity` advances the ring is empty), but defensive return makes
    // the type system happy and surfaces any future protocol change.
    return readIdx;
  }

  /** Number of frames the policy has dropped at the producer side since
   *  construction. Read for `telemetry().droppedFrames`. Heap-only
   *  counter — per-instance, not synchronized across peers. (0.6.12) */
  droppedCount(): number {
    return this.droppedFrames;
  }

  /** Successful writes counter (0.6.13). See field doc. */
  pushedCount(): number {
    return this.pushedFrames;
  }

  /** Successful reads counter (0.6.13). One increment per ok=true
   *  pull/pullLatest, regardless of skipped. See field doc. */
  pulledCount(): number {
    return this.pulledFrames;
  }

  /** Cumulative `pullLatest`-discarded frames (0.6.13). See field doc. */
  skippedCount(): number {
    return this.skippedFrames;
  }

  /** Nanoseconds of the most recent `waitForSpace` that parked. Zero
   *  if never parked or always took the `'not-equal'` fast path. (0.6.13) */
  lastFullWaitNanos(): number {
    return this.lastFullWaitNs;
  }

  /** Nanoseconds of the most recent `waitForData` that parked. Zero
   *  if never parked or always took the `'not-equal'` fast path. (0.6.13) */
  lastEmptyWaitNanos(): number {
    return this.lastEmptyWaitNs;
  }

  /** High-water mark of buffered count `(writeIdx - readIdx)` since
   *  construction. See field doc. (0.6.13) */
  maxOccupancy(): number {
    return this.maxOccupancyEverSeen;
  }

  /** Update the high-water-mark counter. Called inline from push (with
   *  post-write buffered) and from pull/pullLatest (with pre-pull
   *  buffered). Wrap-correct: `buffered` here is always the signed
   *  subtraction `(writeIdx - readIdx) | 0`, which is the true diff
   *  for any |true_diff| < 2^31 (capped at capacity, so well-bounded).
   *  (0.6.13) */
  private _recordOccupancy(buffered: number): void {
    if (buffered > this.maxOccupancyEverSeen) {
      this.maxOccupancyEverSeen = buffered;
    }
  }

  /** Number of frames currently buffered (≤ capacity).
   *
   *  Two individually-atomic Int32 loads. The pair is NOT a mutually-atomic
   *  snapshot: under live producer/consumer contention the writeIdx and
   *  readIdx readings can land on either side of a peer's release-store, so
   *  the returned count may be off by ±1 from any single instantaneous state.
   *  This is harmless for the documented uses (occupancy hints, dashboards,
   *  loose backpressure) but inadequate as a basis for synchronization.
   *
   *  Callers that need a coherent multi-field snapshot of ring state should
   *  use `telemetry()` instead, which gathers writeIndex / readIndex /
   *  available / flowScale via the same individually-atomic loads but bundles
   *  them into a single frozen object so downstream consumers can reason
   *  about "what was true at one observation point" without re-loading. The
   *  bundled snapshot has the same atomicity caveats as the underlying loads
   *  but at least guarantees the fields agree with each other in the result. */
  available(): number {
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    return ((writeIdx - readIdx) | 0);
  }

  /**
   * Producer-side adaptive backpressure hint. Returns the consumer's most
   * recent flow_scale value in [0.5, 2.0]. See file header "Adaptive
   * backpressure" for the contract.
   */
  flowScaleHint(): number {
    return (Atomics.load(this.indices, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q;
  }

  /** Monotonic count (unsigned 32-bit) of hard-error invariant fallbacks
   *  since SAB allocation. Read via Bridge.telemetry().tornFrames. */
  tornFrameCount(): number {
    return Atomics.load(this.indices, TORN_FRAME_LANE) >>> 0;
  }

  /** Atomically increment the torn-frame counter on lane 3. Called by the
   *  Bridge-side invariant classifier on the hard-error branch. Wraps mod
   *  2^32 like the other Int32 lanes. */
  incrementTornFrameCount(): void {
    Atomics.add(this.indices, TORN_FRAME_LANE, 1);
  }

  /**
   * Publish PLL state to lanes 4-7 for cross-process observability
   * (0.6.16). Called by the Bridge from `observeConsumerTime` /
   * `resetPll` when `publishPllToSab` is enabled. A second worker / DevTools
   * panel can read these lanes via `readPublishedPllState()` on its own
   * `SpscRing` instance over the same SAB without IPC.
   *
   * - Lanes 4-5 are written as two Int32 atomic stores carrying the low
   *   and high halves of the signed Int64 ns offset, little-endian (low at
   *   lane 4, high at lane 5). SAB byte representation stays bit-identical
   *   to the legacy single-Int64 BigInt store the 0.6.16-0.8.1 path used
   *   — both write the same 8 bytes in the same order; only the writer's
   *   allocation profile changed.
   * - Lane 6 (drift) is an Int32 atomic store of the Q16.16-encoded
   *   ppm value.
   * - Lane 7 (status) is an Int32 atomic store with bit 0 = locked.
   *
   * Four atomic stores total. Allocation-free (no BigInt boxing; see the
   * "BigInt-free" section below). Safe to call from an AudioWorklet's
   * `process()` body.
   *
   * ─── Store order contract (0.8.1, widened in 0.8.2) ───────────────────
   *
   * The status lane (7) is ALWAYS written last. This is load-bearing for
   * the matching `readPublishedPllState` contract: readers gate on `locked`
   * first, so once they observe `locked === true` they can trust that the
   * offset + drift lanes belong to a publish point where the producer had
   * locked = true. The protocol is not a full seqlock — a publish in flight
   * concurrently with a read can still produce a snapshot stitched across
   * two publishes — but the documented invariant ("status changes only on
   * lock/unlock transitions; offset/drift change every observe") makes the
   * stitched snapshot a valid publish point in practice, not a synthesis of
   * incompatible halves.
   *
   * In 0.8.2 the single Int64 offset store became two Int32 stores (low at
   * lane 4, high at lane 5). That widens the write window across the
   * offset itself — readers that load lane 4 between the low and high
   * stores observe an inconsistent (lo_new, hi_old) pair. The status-last
   * ordering remains the same one-bit gate: a reader that observes
   * `locked === true` AFTER the status store landed observes an offset
   * from either the most recent fully-committed publish OR a publish
   * whose status-store has already landed (and whose hi-store therefore
   * landed before it, since stores are released in program order on every
   * mainstream JS engine for atomic stores). Both are valid publish
   * points; neither is a torn synthesis. Pre-status-store snapshots
   * read `locked === false` and are correctly discarded by the reader
   * contract.
   *
   * ─── BigInt-free (0.8.2) ──────────────────────────────────────────────
   *
   * Pre-0.8.2 publish allocated one BigInt per call
   * (`BigInt(Math.round(offsetNs))`) which V8 boxes on the heap. At
   * audio-rate observe cadence (~700 Hz on a 16-sample quantum at 48 kHz,
   * or higher for shorter quanta) the BigInt allocations were the
   * dominant heap traffic on the consumer thread — a documented hot spot
   * since 0.6.16 that the 0.6.11 notify bench flagged tangentially.
   *
   * 0.8.2 decomposes the integer offset into low/high halves via
   * `Math.floor(offset / 2^32)` (high) and `(offset - hi*2^32) | 0` (low).
   * The two halves store via two `Atomics.store(indices, lane, ...)` calls
   * on the Int32Array — no BigInt object is ever materialized. Heap
   * snapshots before/after a 10k-publish loop show zero growth (pinned by
   * the 0.8.2 test). Within ±2^53 ns (≈ 104 days), the decomposition is
   * exact; offsets larger than that lose precision the same way the old
   * BigInt path did when converting back to Number on the read side.
   */
  publishPllState(offsetNs: number, driftPpm: number, locked: boolean): void {
    // Round to nearest ns. The offset's f64 precision (~15 sig figs) is
    // sub-ns at any realistic wall-clock scale, so Math.round here is
    // essentially a no-op for typical inputs.
    const offsetRounded = Math.round(offsetNs);
    // Decompose to signed Int32 halves (BigInt-free, no heap allocation).
    // Math.floor handles negative offsets correctly: e.g. for offsetNs = -1,
    // hi = -1 and lo = (-1 - (-1)*2^32) | 0 = (2^32-1) | 0 = -1, which
    // reconstructs to (-1)*2^32 + (-1 >>> 0) = -1 on read. Exact within
    // ±2^53 ns (≈ 104 days).
    const hi = Math.floor(offsetRounded / 0x100000000);
    const lo = (offsetRounded - hi * 0x100000000) | 0;
    Atomics.store(this.indices, PLL_OFFSET_LANE_LOW, lo);
    Atomics.store(this.indices, PLL_OFFSET_LANE_HIGH, hi | 0);
    // Drift as signed Q16.16 ppm. Range ±32768 ppm clamped — any
    // realistic clock drift (single-digit to tens of ppm) sits well
    // inside this envelope.
    let driftQ = Math.round(driftPpm * PLL_DRIFT_Q16_16) | 0;
    const MAX_Q = 0x7fffffff;
    const MIN_Q = -0x80000000;
    if (driftQ > MAX_Q) driftQ = MAX_Q;
    else if (driftQ < MIN_Q) driftQ = MIN_Q;
    Atomics.store(this.indices, PLL_DRIFT_LANE, driftQ);
    Atomics.store(
      this.indices,
      PLL_STATUS_LANE,
      locked ? PLL_STATUS_LOCKED_BIT : 0,
    );
  }

  /**
   * Read the published PLL state from lanes 4-7 (0.6.16). Returns the
   * snapshot a peer last wrote via `publishPllState`. If no peer has
   * published since SAB allocation, the status lane reads 0 and
   * `locked` is false (the SAB starts zero-filled).
   *
   * For cross-process observability: a second worker / DevTools panel
   * constructs its own `SpscRing` / `Bridge` over the SAME SAB the
   * consumer Bridge is using, and calls this method to inspect the
   * consumer's PLL state without postMessage or other IPC.
   *
   * ─── Read order contract (0.8.1) ──────────────────────────────────────
   *
   * The status lane is read FIRST, then offset, then drift. This pairs
   * with `publishPllState`'s status-last write order to form a one-bit
   * gate: a reader that observes `locked === false` knows the
   * offset/drift fields may be stale or zero (no PLL has published yet,
   * or the producer just reset) and should ignore them; a reader that
   * observes `locked === true` knows the offset/drift fields belong to a
   * publish point where the producer had locked. The protocol does NOT
   * implement a full seqlock — concurrent publish/read interleaving can
   * still produce a snapshot stitched across two publishes — but the
   * documented invariants (status changes only on lock/unlock
   * transitions; offset/drift change every observe) ensure the stitched
   * snapshot is a valid publish point in practice, not a synthesis of
   * incompatible halves.
   *
   * The four lanes (status / offset-low / offset-high / drift) are
   * individually atomic; the tuple is not mutually atomic. Live observer
   * activity that needs sample-accurate coherence should instead call
   * `bridge.telemetry()` on the consumer Bridge directly (same-thread
   * loads, gated against the heap state). The published-lane path exists
   * for the cross-thread / cross-process case where direct Bridge access
   * isn't available.
   *
   * Four atomic loads + one ppm decode + one offset reconstruction.
   * Allocation-free (no BigInt boxing; see `publishPllState` for the
   * 0.8.2 BigInt-free encoding).
   */
  readPublishedPllState(): { locked: boolean; offsetNs: number; driftPpm: number } {
    const status = Atomics.load(this.indices, PLL_STATUS_LANE);
    const locked = (status & PLL_STATUS_LOCKED_BIT) !== 0;
    // Two Int32 loads + Number reconstruction (0.8.2). Bit-equivalent to
    // reading the same 8 bytes as a BigInt64 then converting to Number,
    // but allocation-free on the hot reader path. `(lo >>> 0)` casts the
    // low half from signed Int32 to its unsigned interpretation; the
    // signed high half multiplies by 2^32 to reconstruct the full Int64
    // as a JavaScript Number. Within ±2^53 ns this is exact.
    const lo = Atomics.load(this.indices, PLL_OFFSET_LANE_LOW);
    const hi = Atomics.load(this.indices, PLL_OFFSET_LANE_HIGH);
    const offsetNs = hi * 0x100000000 + (lo >>> 0);
    const driftQ = Atomics.load(this.indices, PLL_DRIFT_LANE);
    const driftPpm = driftQ / PLL_DRIFT_Q16_16;
    return { locked, offsetNs, driftPpm };
  }

  /** Current producer counter (unsigned-decoded for telemetry). */
  writeIndexUnsigned(): number {
    return Atomics.load(this.indices, WRITE_IDX_LANE) >>> 0;
  }

  /** Current consumer counter (unsigned-decoded for telemetry). */
  readIndexUnsigned(): number {
    return Atomics.load(this.indices, READ_IDX_LANE) >>> 0;
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * Atomics.wait performs an atomic compare-and-park against the value at
   * indices[1] (read_index) — if the consumer advanced read_index between
   * our load and the wait, the wait returns "not-equal" immediately rather
   * than parking forever. This closes the load-then-park race window.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) < this.capacity) return "not-equal";
    // 0.6.13 — record the wait duration into `lastFullWaitNs` for
    // telemetry. `performance.now()` returns milliseconds with sub-ms
    // precision in both Node and browsers; multiply to get ns. We time
    // only the paths that actually parked (`'ok'` or `'timed-out'`).
    const t0 = performance.now();
    const status = Atomics.wait(this.indices, READ_IDX_LANE, readIdx, timeoutMs);
    this.lastFullWaitNs = Math.round((performance.now() - t0) * 1e6);
    return status;
  }

  /**
   * Consumer-side park: block until the producer advances write_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has data. Mirror of waitForSpace.
   *
   * NOT real-time safe — see waitForSpace for the threading rules. An
   * AudioWorklet's per-quantum read path MUST NOT call this; it should poll
   * via pullLatest() and tolerate misses.
   */
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx !== readIdx) return "not-equal";
    // 0.6.13 — mirror of `waitForSpace` timing. Records the actual parked
    // duration into `lastEmptyWaitNs` for telemetry.
    const t0 = performance.now();
    const status = Atomics.wait(this.indices, WRITE_IDX_LANE, writeIdx, timeoutMs);
    this.lastEmptyWaitNs = Math.round((performance.now() - t0) * 1e6);
    return status;
  }

  /**
   * Returns a JSON-able description of the schema's frame byte layout, for
   * worklets that want to inline the read protocol without importing the
   * Bridge / SpscRing classes on the audio thread. The worklet can
   * postMessage this object across via `processorOptions` and reconstruct
   * the per-field typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema);
  }
}
