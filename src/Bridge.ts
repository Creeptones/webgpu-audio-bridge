/**
 * Bridge<Schema> — schema-driven lock-free SPSC SAB ring.
 *
 * Generalization of Float64RingBuffer. The ring protocol, memory ordering,
 * and park/wake semantics are identical — only the payload codec is now
 * driven by a user-supplied `Schema` (see ./schema.ts) instead of the
 * hard-coded `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` frame.
 *
 * ─── 0.6.8 / 0.6.9 architecture note ─────────────────────────────────────
 *
 * The SAB allocation, header lane layout, push / pull mechanics, park / wake
 * protocol, and the lane-2 adaptive flow-scale PI controller all live in a
 * dedicated `SpscRing<S>` class (`./SpscRing.ts`). The 0.6.9 patch further
 * carved the consumer-side heap state machines into three dedicated
 * classes:
 *
 *   - `FrameSmoother<S>` (`./FrameSmoother.ts`) — owns the unified
 *     consumer-side `prev` buffer + the trajectory-aware one-pole blender
 *     + the per-field classification tables (BigInt / integer / float, and
 *     `arrayTrajectoryOrder` for the strided derivative-skip). Used by
 *     both `pullSmoothed`/`pullLatestSmoothed` and the schema-invariant
 *     hard-error recovery path.
 *   - `ConsumerClockRecovery` (`./ConsumerClockRecovery.ts`) — owns the
 *     PLL: gains, integral term, offset estimate.
 *   - `AdaptiveFlowController` (`./AdaptiveFlowController.ts`) — owns the
 *     flow-scale PI loop + the Q16.16 encode. Composed by SpscRing, not
 *     Bridge.
 *
 * Bridge<S> holds one `SpscRing<S>` as `this.ring`, one `FrameSmoother<S>`
 * as `this.smoother`, and one `ConsumerClockRecovery` as `this.pll`. It
 * orchestrates the ring pull + (optional) invariant dispatch + smoother /
 * PLL call. The protocol-level documentation lives at the top of each
 * extracted class.
 *
 * Bridge<S> retains the orchestration-only surface that is NOT a single
 * heap state machine:
 *
 *   - The pull-family methods (`pull`, `pullLatest`, `pullSmoothed`,
 *     `pullLatestSmoothed`) and named skip-policy resolution.
 *   - Schema-invariant classifier (`_classifyInvariant` + epsilon floor)
 *     and the raw / smoothed invariant handlers (which dispatch onto
 *     FrameSmoother).
 *   - PLL dispatch (`observeConsumerTime`, `phaseLockedTime`, `resetPll`).
 *   - Per-frame trajectory evaluator (`evaluateInto`, `scratchEvaluatedFrame`,
 *     `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `setSampleRate`,
 *     `resetEvalCache`).
 *   - `telemetry()` snapshot (gathers from the ring + the PLL + the
 *     smoother + the ring's flow controller via existing accessors).
 *
 * SpscRing, FrameSmoother, ConsumerClockRecovery, and AdaptiveFlowController
 * are all **internal-only** through 0.6.9 — not exported from `src/index.ts`.
 * 0.6.10 is the deliberate promotion patch that lifts them to the public
 * composable API.
 *
 * ─── Smoothed pulls (α-smoother as first-class API) ─────────────────────
 *
 * `pullSmoothed` / `pullLatestSmoothed` are opt-in variants of `pull` /
 * `pullLatest` that blend the freshly-read frame with the previous
 * smoothed-call output using a one-pole low-pass:
 *
 *   out_i ← α_eff · curr_i + (1 − α_eff) · prev_i
 *
 * For `pullLatestSmoothed`, the skip-scaling of `α_eff` is selected per call
 * by `opts.skipPolicy` (`SmootherSkipPolicy`, default `'stall-smooth'`):
 *
 *   'stall-smooth' (default, 0.4.1..present, bit-exact-preserved at 0.6.6):
 *     `α_eff = α_base · 2^(−skipped)`. A big jump (producer stalled then
 *     caught up) gets MORE smoothing; the steady-state case with no skips
 *     gets `α_eff = α_base`. Click-suppression-first.
 *
 *   'catch-up' (opt-in, 0.6.6):
 *     `α_eff = 1 − (1 − α_base)^(skipped + 1)` — closed form of applying
 *     the one-pole filter (skipped + 1) times in a row. Large skips drive
 *     α→1, snapping to the new frame. Chase-latency-first. For skipped=0
 *     this reduces to `α_eff = α_base` exactly (no behavioral change
 *     unless a stall actually occurred).
 *
 * For `pullSmoothed`, skipped is always 0, so both policies yield
 * `α_eff = α_base` — the option is accepted for API symmetry but is a no-op.
 *
 * Lineage: the wavefunction-synth project's 60 → 48 kHz boundary smoother;
 * same one-pole shape, lifted into the ring as a first-class consumer-side
 * primitive. BigInt-typed fields are passed through verbatim — there is
 * no meaningful blend on monotonic sequence counters or timestamps.
 * Integer-typed numeric fields (u8…u32, i8…i32) blend in floating-point
 * then `Math.round` back to integer.
 *
 * Trajectory fields (`f{32,64}TrajectoryArray(n, { order })`): the smoother
 * blends ONLY the position lanes and copies derivative lanes (velocity,
 * acceleration) verbatim from curr. Velocity is a derivative — time-
 * averaging it across frames collapses the very signal the trajectory ships
 * to preserve (a perfectly linear ramp would yield velocity → 0 under a
 * naive elementwise blend). For order=1 the layout is positions-only and
 * the rule reduces to plain array blending; for order=2 the smoother
 * blends elements at indices 0, 2, 4, … and copies 1, 3, 5, …; for
 * order=3 it blends 0, 3, 6, … and copies the other six per triple. The
 * compiled `arrayTrajectoryOrder` table drives the dispatch — no per-call
 * branch on field metadata.
 *
 * The smoother's `prev` is held heap-side on the Bridge instance. It is
 * lazily allocated on the first smoothed call and persists across calls.
 * Any non-smoothed `pull` / `pullLatest` invalidates the prev (the next
 * smoothed call behaves as a first-call: no blending, seed prev with the
 * fresh frame). `resetSmoother()` is the explicit equivalent.
 *
 * Memory ordering matches `pull` / `pullLatest`: SpscRing handles the
 * acquire-load of writeIdx, the payload read, the release-store of
 * readIdx, and the notify; the blend math runs AFTER the release-store
 * (heap-only on `out` and `prev`, never the SAB) so the slot can be
 * released back to the producer as early as possible.
 *
 * ─── Schema invariants (0.6.0, opt-in via `.withInvariant(fn)`) ───────────
 *
 * Cross-IPC bit-rot detection as a protocol concern. When a schema is built
 * with `.withInvariant(fn)`, the schema layout grows by 8 bytes per slot
 * for a hidden `__invariant: f64` field. SpscRing auto-computes the
 * invariant via `fn(frame)` on every push (right before the release-store
 * on write_index) and reads the stored invariant on every pull (right
 * after payload read, before the release-store on read_index). The Bridge
 * layer runs the classifier + recovery on the value SpscRing surfaces via
 * `pullResult.invariantStored`.
 *
 * Recovery classification, against `delta = |computed − stored|`:
 *
 *   ok:    delta < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)   pass through
 *   soft:  delta < INVARIANT_SOFT_THRESHOLD · |stored|                       smoother fires with computed α
 *   hard:  otherwise, or NaN/Infinity on either side                         fallback to FrameSmoother's prev + tornFrames++
 *
 * `absoluteEpsilon` is set per-schema via `.withInvariant(fn, { absoluteEpsilon })`
 * (default `1e-12`); relative error stays primary, the absolute floor catches
 * subnormal-zero rounding residues.
 *
 * Soft errors invoke `smoother.observe(out, α)` against the unified prev
 * buffer with `α = clamp(INVARIANT_SOFT_ALPHA_BASE / |ratio−1|, 0, 1)`. The
 * curve picks α near the OK boundary so tiny deviations pass through
 * essentially raw, and α near 0 at the hard boundary so the smoother
 * basically trusts prev when the corruption is severe. The smoother is the
 * same FrameSmoother instance the smoothed-pull family uses (0.6.9 extract)
 * — single field-type-dispatched blend loop, no extra surface.
 *
 * Hard errors invoke `smoother.fallbackInto(out)` (copies prev into out
 * when valid; pass-through when prev not yet seeded) and increment the
 * torn_frame_counter via `ring.incrementTornFrameCount()`. The producer
 * is unaffected; the consumer's downstream sees a stale-but-trusted frame
 * instead of a corrupt one. If prev is not yet valid (first pull ever was
 * a hard error), the raw payload passes through and tornFrames still
 * increments so the failure is visible in telemetry.
 *
 * Cost when not opted in. Zero. Schemas without `.withInvariant(...)` have
 * `schema.invariant === null`; the push/pull paths short-circuit the
 * invariant block in a single null-check. The FrameSmoother allocates its
 * prev buffer lazily on first use, so no-invariant schemas that never call
 * a smoothed pull never pay the allocation either.
 *
 * ─── Phase-locked loop (0.6.2, Pillar 2 first cut — offset only) ────────
 *
 * Consumer-side PLL that tracks the offset between the producer's
 * `tMacroNs` (the timestamp the producer writes into each frame) and the
 * consumer's wall-clock (typically `AudioContext.currentTime * 1e9`).
 *
 * API:
 *   observeConsumerTime(consumerNs, producerNs) — run one PI cycle pairing
 *     a producer-stamped time with the consumer's wall-clock at the
 *     observation moment. The first call seeds the offset exactly
 *     (`pllOffsetNs = producerNs - consumerNs`, `pllLocked = true`);
 *     subsequent calls run the PI math:
 *       residual = (producerNs - consumerNs) - pllOffsetNs
 *       integral = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
 *       pllOffsetNs += PLL_KP · residual + PLL_KI · integral
 *
 *   phaseLockedTime(consumerNs) — returns `consumerNs + pllOffsetNs` once
 *     locked, else `consumerNs` unchanged. Safe at audio rate.
 *
 *   resetPll() — flip back to unlocked. Use after suspend/resume, an
 *     AudioContext epoch change, or when the producer reconnects with
 *     a different `tMacroNs` epoch.
 *
 *   telemetry().pllLocked / .pllOffsetNs — point-in-time snapshot.
 *
 * Convergence: with `PLL_KP = 0.2`, a fresh constant offset converges to
 * within 1 μs in ~30 observations. With `PLL_KI = 0.01`, a constant drift
 * (e.g. 50 ppm) settles within a few seconds.
 *
 * Anti-windup: `pllIntegral` is clamped to ±`PLL_INT_LIMIT_NS` (1 ms in
 * residual units).
 *
 * ─── Per-frame evaluator (0.6.3, Pillar 3) ────────────────────────────────
 *
 * `bridge.evaluateInto(srcFrame, dt, outFrame)` walks `compiled.fields`
 * and applies the trajectory evaluator per trajectory field; non-trajectory
 * fields pass through. Heap-only — never touches the SAB.
 *
 * 0.6.5 sugar: `pullEvaluatedLatest` + `evaluateAtSampleOffset` collapse
 * the canonical pull + observe + per-sample dt + evaluate loop into two
 * method calls per quantum. See README §Per-frame evaluator.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * Same lineage as Float64RingBuffer — Paul Adenot's `ringbuf.js` (2018) is
 * the canonical SPSC-over-SAB technique that this library extends.
 */

import {
  kindTsType,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
  type TimestampRoleOf,
  type TimestampUnit,
} from "./schema.js";
import {
  RING_HEADER_BYTES as SPSC_RING_HEADER_BYTES,
  RING_HEADER_LANES as SPSC_RING_HEADER_LANES,
  RING_HEADER_INT32_LANES as SPSC_RING_HEADER_INT32_LANES,
  SpscRing,
  type BridgeAllocation as SpscBridgeAllocation,
} from "./SpscRing.js";
import { FrameSmoother } from "./FrameSmoother.js";
import { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import { evaluateTrajectoryInto } from "./trajectory.js";

// Re-export the header constants from SpscRing so existing callers (and
// tests) that import them from "./Bridge.js" continue to compile. The
// canonical home is SpscRing.ts as of 0.6.8.
export const RING_HEADER_BYTES = SPSC_RING_HEADER_BYTES;
export const RING_HEADER_LANES = SPSC_RING_HEADER_LANES;
export const RING_HEADER_INT32_LANES = SPSC_RING_HEADER_INT32_LANES;

// Re-export the allocation type from the Bridge module so the public-API
// surface stays bit-identical to 0.6.7. Internal-only `SpscRing` itself is
// not re-exported.
export type BridgeAllocation<S extends Schema<FieldsObject, any>> = SpscBridgeAllocation<S>;

// Schema-invariant recovery thresholds. See the "Schema invariants" section
// of the file header for the classification semantics and the smoother α
// curve. All three are exported on the Bridge class as static readonly
// constants so tests / callers can pin against them without reaching into
// private state.
const INVARIANT_OK_THRESHOLD = 1e-3;
const INVARIANT_SOFT_THRESHOLD = 1.0;
const INVARIANT_SOFT_ALPHA_BASE = 0.1; // α ≈ INVARIANT_SOFT_ALPHA_BASE / |ratio−1|

// PLL controller gains + anti-windup constants now live on
// `ConsumerClockRecovery` (see `./ConsumerClockRecovery.ts`). Bridge holds
// one as `this.pll` and delegates observe / phaseLockedTime / reset.

/** Skip-scaling policy for `pullLatestSmoothed` (0.6.6). Controls how the
 *  effective α responds when the consumer drains more than one frame in a
 *  single call (i.e. `skipped > 0`). For `pullSmoothed` (always
 *  `skipped === 0`) both policies yield `α_eff = α_base`; the option is
 *  accepted for API symmetry but has no behavioral effect.
 *
 *  - `'stall-smooth'` (default — preserves 0.4.1..0.6.5 behavior bit-exact):
 *    `α_eff = α_base · 2^(-skipped)`. Large skips drive α→0, so the smoother
 *    mostly trusts `prev` and drifts slowly toward the post-stall value.
 *
 *  - `'catch-up'` (0.6.6, opt-in): `α_eff = 1 - (1 - α_base)^(skipped + 1)`,
 *    the closed form of applying the one-pole filter `skipped + 1` times
 *    in a row.
 *
 *  See file header "Smoothed pulls" for the per-policy curve rationale. */
export type SmootherSkipPolicy = "stall-smooth" | "catch-up";

/** Optional opts bag accepted by `pullSmoothed` / `pullLatestSmoothed` from
 *  0.6.6 onward. `skipPolicy` selects how `α_eff` responds to drained
 *  backlog; omit (or pass `undefined`) for the legacy `'stall-smooth'`
 *  default that preserves all pre-0.6.6 behavior bit-exact. */
export interface SmoothedPullOptions {
  readonly skipPolicy?: SmootherSkipPolicy;
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

function newHeapTypedArray(kind: FieldKind, length: number): AnyTypedArray {
  switch (kind) {
    case "u64": return new BigUint64Array(length);
    case "i64": return new BigInt64Array(length);
    case "f64": return new Float64Array(length);
    case "u32": return new Uint32Array(length);
    case "i32": return new Int32Array(length);
    case "f32": return new Float32Array(length);
    case "u16": return new Uint16Array(length);
    case "i16": return new Int16Array(length);
    case "u8":  return new Uint8Array(length);
    case "i8":  return new Int8Array(length);
  }
}

export class Bridge<S extends Schema<FieldsObject, any>> {
  public readonly capacity: number;
  public readonly schema: S;
  /** Frame size in bytes; matches schema.frameByteSize. */
  public readonly frameByteSize: number;

  /** The extracted SAB / Atomics core (0.6.8). Owns push / pull mechanics,
   *  the always-notify protocol, the lane-2 flow-scale PI controller, and
   *  the wait helpers. Bridge delegates every ring-mechanic call here and
   *  layers the smoother / PLL / invariant classifier / evaluator on top. */
  private readonly ring: SpscRing<S>;

  /** Consumer-side α-smoother + unified prev buffer (0.6.9 extract). Owns
   *  the trajectory-aware blender, the BigInt / integer / float
   *  classification tables, and the prev frame that backs both the
   *  smoothed-pull path and the schema-invariant hard-error fallback. See
   *  `./FrameSmoother.ts`. */
  private readonly smoother: FrameSmoother<S>;

  /** Consumer-side PLL (0.6.9 extract). Owns the offset estimate, the PI
   *  integrator, and the lock flag. Bridge delegates `observeConsumerTime`,
   *  `phaseLockedTime`, and `resetPll` here; `telemetry()` reads
   *  `pll.locked` / `pll.offsetNs` for the snapshot. See
   *  `./ConsumerClockRecovery.ts`. */
  private readonly pll: ConsumerClockRecovery = new ConsumerClockRecovery();

  /** Cached raw frame for `pullEvaluatedLatest` / `evaluateAtSampleOffset`.
   *  Lazily allocated on first `pullEvaluatedLatest`. Persists across calls.
   *  Independent of the FrameSmoother's prev buffer — that has its own
   *  lifecycle for the α-smoother and invariant fallback. (0.6.5) */
  private cachedRawFrame: FrameFor<S> | null = null;
  /** True iff `cachedRawFrame` holds a valid pulled frame and the
   *  cachedTimestampNs / cachedBaseConsumerNs / cachedSampleRate triple is
   *  set. */
  private cachedEvalValid: boolean = false;
  /** Producer timestamp from the most recent successful `pullEvaluatedLatest`,
   *  converted to nanoseconds via the active role's unit. */
  private cachedTimestampNs: number = 0;
  /** Consumer wall-clock (ns) at the start of the active quantum. */
  private cachedBaseConsumerNs: number = 0;
  /** Active sample rate for the current quantum's evaluations. */
  private cachedSampleRate: number = 0;
  /** Optional default sample rate registered via `setSampleRate(rate)`. */
  private defaultSampleRate: number = 0;

  /** Lower floor on the classifier's OK band — `_classifyInvariant` uses
   *  `max(invariantAbsoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`. Set
   *  from `schema.invariant.absoluteEpsilon` at construction (defaulting to
   *  `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` for no-invariant schemas, where it
   *  is never read). See file header "Schema invariants" + 0.6.6 CHANGELOG. */
  private readonly invariantAbsoluteEpsilon: number;

  /** Public, frozen recovery thresholds — exported for tests and callers
   *  that want to pin against the exact boundaries. */
  static readonly INVARIANT_OK_THRESHOLD = INVARIANT_OK_THRESHOLD;
  static readonly INVARIANT_SOFT_THRESHOLD = INVARIANT_SOFT_THRESHOLD;
  static readonly INVARIANT_SOFT_ALPHA_BASE = INVARIANT_SOFT_ALPHA_BASE;

  constructor(sab: SharedArrayBuffer, capacity: number, schema: S) {
    this.ring = new SpscRing<S>(sab, capacity, schema);
    this.capacity = this.ring.capacity;
    this.schema = this.ring.schema;
    this.frameByteSize = this.ring.frameByteSize;

    this.invariantAbsoluteEpsilon = schema.invariant !== null
      ? schema.invariant.absoluteEpsilon
      : 0;

    // FrameSmoother owns the consumer-side prev buffer + classification
    // tables + the trajectory-aware blender. Pass `scratchFrame` as the
    // allocate-factory so the smoother and the rest of the bridge share a
    // single allocation path (scratchFrame is the canonical heap-side
    // frame allocator).
    this.smoother = new FrameSmoother<S>(schema, () => this.scratchFrame());
  }

  /** Byte size needed for a ring of `(capacity, schema)`. */
  static byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): number {
    return SpscRing.byteLength(capacity, schema);
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): BridgeAllocation<S> {
    return SpscRing.allocate(capacity, schema);
  }

  /**
   * Allocate a reusable frame view. Array fields are pre-allocated heap-side
   * typed arrays of the right kind and length; scalar fields are initialized
   * to 0 / 0n. Use this once outside hot loops and reuse the returned object
   * on every push/pull call.
   */
  scratchFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
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
    return this.ring.push(view);
  }

  /**
   * Same as `push` but validates `view` per the schema first. Throws TypeError
   * on the first field mismatch. Use in tests / debug builds; the production
   * hot path should call `push` and trust caller-side construction (typically
   * via `scratchFrame()` reuse).
   */
  pushChecked(view: FrameFor<S>): boolean {
    this._validateFrame(view, "push");
    return this.push(view);
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only one
   * begin/commit pair can be in flight at a time per Bridge instance.
   */
  beginPush(): FrameFor<S> | null {
    return this.ring.beginPush();
  }

  /** Publish the frame opened by beginPush. */
  commitPush(): void {
    this.ring.commitPush();
  }

  /** Discard the frame opened by beginPush without publishing. */
  abortPush(): void {
    this.ring.abortPush();
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Returns false on empty.
   */
  pull(out: FrameFor<S>): boolean {
    const r = this.ring.pull(out);
    if (!r.ok) return false;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else {
      // No invariant: raw pull invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer retained.
      this.smoother.reset();
    }
    return true;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames are
   * discarded. Returns the number of frames skipped (0 if a single frame was
   * waiting, N if N+1 frames were buffered), or -1 if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): number {
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else {
      // No invariant: raw pullLatest invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer is retained.
      this.smoother.reset();
    }
    return r.skipped;
  }

  /**
   * Consumer-side smoothed single-frame pull. Equivalent to `pull` but blends
   * the freshly-read frame against the previously-returned smoothed frame
   * using a one-pole low-pass:
   *
   *   out_i ← α_base · curr_i + (1 − α_base) · prev_i
   *
   * α_base ∈ [0, 1]: 1.0 = no smoothing (≡ raw pull); smaller = more inertia.
   * On the first smoothed call (or the first after any non-smoothed pull /
   * `resetSmoother()`) there is no prev — the fresh frame is returned
   * verbatim and stored as the new prev.
   *
   * BigInt-typed fields (u64 / i64) are passed through verbatim regardless of
   * α — there is no meaningful blend on monotonic sequence counters /
   * timestamps. Integer-typed numeric fields are blended in float then
   * `Math.round`-ed back. Float fields blend in float.
   *
   * Returns false on empty (no payload read; smoother state untouched).
   *
   * `opts.skipPolicy` (0.6.6) is accepted for API symmetry with
   * `pullLatestSmoothed` but has no behavioral effect: `pullSmoothed` always
   * has `skipped === 0`, where both policies degenerate to `α_eff = α_base`.
   *
   * Memory ordering matches `pull`. See file header "Smoothed pulls".
   */
  pullSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    _opts?: SmoothedPullOptions,
  ): boolean {
    const r = this.ring.pull(out);
    if (!r.ok) return false;
    this._invariantHandleSmoothed(
      out as unknown as Record<string, unknown>,
      r.invariantStored,
      alphaBase,
    );
    return true;
  }

  /**
   * Consumer-side smoothed drain-to-latest. Equivalent to `pullLatest` but
   * blends the freshly-read newest frame against the previously-returned
   * smoothed frame using a skip-scaled one-pole low-pass.
   *
   * `α_eff` is selected by `opts.skipPolicy` (default `'stall-smooth'`,
   * preserves 0.4.1..0.6.5 behavior bit-exact):
   *
   *   'stall-smooth':  α_eff = α_base · 2^(−skipped)
   *   'catch-up'    :  α_eff = 1 − (1 − α_base)^(skipped + 1)
   *
   * Then `out_i ← α_eff · curr_i + (1 − α_eff) · prev_i`.
   *
   * Returns -1 on empty, else the number of frames skipped (0 if a single
   * frame was waiting). Same field-type rules as `pullSmoothed`. Memory
   * ordering matches `pullLatest`. See file header "Smoothed pulls".
   */
  pullLatestSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    opts?: SmoothedPullOptions,
  ): number {
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    const skipped = r.skipped;
    // Skip-scaling policy (0.6.6 — see SmootherSkipPolicy). Default
    // 'stall-smooth' is bit-exact equal to the pre-0.6.6 formula on every
    // skipped value: at skipped=0 both branches yield alphaBase exactly;
    // for skipped>0 only the explicit 'catch-up' option diverges.
    let alphaEff: number;
    if (opts !== undefined && opts.skipPolicy === "catch-up") {
      // Closed form of (skipped + 1) applications of the one-pole filter.
      // At skipped=0 this is `1 - (1 - alphaBase)` = alphaBase exactly.
      alphaEff = 1 - Math.pow(1 - alphaBase, skipped + 1);
    } else {
      // 2^(-skipped) via Math.pow; V8 special-cases integer exponents.
      // For skipped=0 this is 1.0 → alphaEff = alphaBase exactly.
      alphaEff = alphaBase * Math.pow(2, -skipped);
    }
    this._invariantHandleSmoothed(
      out as unknown as Record<string, unknown>,
      r.invariantStored,
      alphaEff,
    );
    return skipped;
  }

  /**
   * Forget the consumer-side cached prev frame. The buffer is used by both
   * the α-smoother (`pullSmoothed` / `pullLatestSmoothed`) and the schema-
   * invariant hard-error recovery path (under `.withInvariant` schemas):
   *
   *   - Next `pullSmoothed` / `pullLatestSmoothed` behaves as a first-call:
   *     no blending, fresh frame returned verbatim and stored as the new
   *     prev.
   *   - Next invariant hard-error has no last-known-good to fall back to,
   *     so the raw (possibly corrupt) payload passes through. `tornFrames`
   *     still increments so the failure is visible in `telemetry()`.
   */
  resetSmoother(): void {
    this.smoother.reset();
  }

  /**
   * PLL observation — consumer-side. Pair the timestamp the producer wrote
   * into a recently-pulled frame (`producerNs`) with the consumer's
   * wall-clock reading at the moment that frame was pulled or evaluated
   * (`consumerNs`).
   *
   * The first call seeds the offset estimate exactly (`pllOffsetNs =
   * producerNs - consumerNs`) and flips `pllLocked=true`. Subsequent calls
   * run one PI cycle each:
   *
   *     residual = (producerNs - consumerNs) - pllOffsetNs
   *     pllIntegral = clamp(pllIntegral + residual, ±PLL_INT_LIMIT_NS)
   *     pllOffsetNs += PLL_KP · residual + PLL_KI · pllIntegral
   *
   * Cost: ~5 arithmetic ops + 2 compares. Allocation-free. Safe to call
   * from an AudioWorklet's `process()` loop.
   */
  observeConsumerTime(consumerNs: number, producerNs: number): void {
    this.pll.observe(consumerNs, producerNs);
  }

  /**
   * PLL evaluation — map a consumer-clock reading to the producer-clock
   * frame of reference using the current offset estimate. Returns
   * `consumerNs + pllOffsetNs` once `observeConsumerTime` has been called
   * at least once; before that, returns `consumerNs` unchanged.
   */
  phaseLockedTime(consumerNs: number): number {
    return this.pll.phaseLockedTime(consumerNs);
  }

  /**
   * Reset the PLL to the unlocked state. The next `observeConsumerTime`
   * call seeds the offset from scratch.
   */
  resetPll(): void {
    this.pll.reset();
  }

  /**
   * Per-frame trajectory evaluator (0.6.3, Pillar 3 first cut). Walks every
   * field of the schema and applies the Pillar 1 evaluator to trajectory
   * fields; everything else passes through into `outFrame` verbatim. Heap-
   * only — no SAB access, no internal state.
   */
  evaluateInto(srcFrame: FrameFor<S>, dt: number, outFrame: FrameFor<S>): void {
    if (!Number.isFinite(dt)) {
      throw new Error(`evaluateInto: dt must be finite, got ${dt}`);
    }
    const src = srcFrame as unknown as Record<string, unknown>;
    const out = outFrame as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const name = field.name;
      if (field.trajectory) {
        // Trajectory field. evaluateTrajectoryInto throws on length
        // mismatch — we don't pre-validate, the helper's message is clearer.
        if (field.kind === "f64") {
          evaluateTrajectoryInto(
            src[name] as Float64Array,
            field.trajectory,
            dt,
            out[name] as Float64Array,
          );
        } else if (field.kind === "f32") {
          evaluateTrajectoryInto(
            src[name] as Float32Array,
            field.trajectory,
            dt,
            out[name] as Float32Array,
          );
        } else {
          // Defensive — the DSL only allows trajectory tags on f64/f32.
          throw new Error(
            `evaluateInto: trajectory field '${name}' has unexpected kind '${field.kind}'`,
          );
        }
      } else if (field.isArray) {
        // Non-trajectory array — verbatim .set(). TypedArray.set throws
        // RangeError if out is shorter than src; we let that surface.
        (out[name] as { set(s: ArrayLike<unknown>): void }).set(
          src[name] as ArrayLike<unknown>,
        );
      } else {
        // Scalar (number or BigInt) — direct copy.
        out[name] = src[name];
      }
    }
  }

  /**
   * Allocate a reusable output frame shaped for evaluateInto. Trajectory
   * fields are sized to `sampleCount` (post-Taylor-evaluation positions);
   * everything else matches scratchFrame() — non-trajectory arrays at
   * their full length, scalars zero-initialized.
   */
  scratchEvaluatedFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.trajectory) {
        // Post-evaluation: extrapolated positions only, length = sampleCount.
        out[field.name] = newHeapTypedArray(
          field.kind,
          field.trajectory.sampleCount,
        );
      } else if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /**
   * Register a default sample rate so subsequent `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` calls can omit the per-call sample-rate
   * argument. (0.6.5)
   */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `setSampleRate: rate must be a positive finite number, got ${rate}`,
      );
    }
    this.defaultSampleRate = rate;
  }

  /**
   * Drain to the newest available frame, observe its producer-stamped
   * timestamp against the consumer wall-clock, evaluate sample 0 of the
   * quantum into `out`, and cache state so subsequent
   * `evaluateAtSampleOffset(out, i)` calls reconstruct samples 1..N − 1
   * without further SAB access. The canonical AudioWorklet entry point
   * for Pillars 1 + 2 + 3 stacked. (0.6.5)
   */
  pullEvaluatedLatest(
    out: FrameFor<S>,
    baseConsumerNs: number,
    sampleRate?: number,
    opts?: { timestamp?: TimestampRoleOf<S> },
  ): number {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `pullEvaluatedLatest: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }
    const sr = sampleRate ?? this.defaultSampleRate;
    if (!Number.isFinite(sr) || sr <= 0) {
      throw new Error(
        `pullEvaluatedLatest: sampleRate not provided and no default set via setSampleRate(rate)`,
      );
    }
    if (this.schema.timestamps === null) {
      throw new Error(
        `pullEvaluatedLatest: schema has no .withTimestamps(...) attached`,
      );
    }
    const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
    const role = this.schema.timestamps.roles[roleName];
    if (!role) {
      throw new Error(
        `pullEvaluatedLatest: unknown timestamp role '${String(roleName)}'`,
      );
    }
    if (this.cachedRawFrame === null) {
      this.cachedRawFrame = this.scratchFrame();
    }
    const skipped = this.pullLatest(this.cachedRawFrame);
    if (skipped >= 0) {
      // Fresh frame — update timestamp cache and drive the PLL. Observing
      // is gated on a fresh pull because feeding the PLL a repeated
      // producer stamp at increasing consumer times would poison the
      // residual (the producer's true clock is advancing, it just hasn't
      // pushed yet).
      const rawValue = (this.cachedRawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.cachedTimestampNs = this._timestampToNs(numericRaw, role.unit, sr);
      this.observeConsumerTime(baseConsumerNs, this.cachedTimestampNs);
      this.cachedEvalValid = true;
    } else if (!this.cachedEvalValid) {
      // Ring is empty and we've never pulled a frame — nothing to evaluate.
      return -1;
    }
    // Either case (fresh-pull or cache-only): update the quantum context
    // so sample-offset arithmetic uses this quantum's base/rate, then
    // evaluate sample 0 into `out`.
    this.cachedBaseConsumerNs = baseConsumerNs;
    this.cachedSampleRate = sr;
    this.evaluateAtSampleOffset(out, 0);
    return skipped;
  }

  /**
   * Evaluate sample `sampleOffset` of the active quantum (set up by the
   * most recent successful `pullEvaluatedLatest`) into `out`. Computes
   * `consumerNs = base + sampleOffset / sampleRate · 1e9`, runs the PLL
   * to map into producer-clock space, computes `dt = (producerEstimate −
   * cachedTimestampNs) · 1e−9` (seconds), and calls `evaluateInto` against
   * the cached raw frame. Heap-only — never touches the SAB. (0.6.5)
   */
  evaluateAtSampleOffset(out: FrameFor<S>, sampleOffset: number): void {
    if (!this.cachedEvalValid) {
      throw new Error(
        `evaluateAtSampleOffset: no cached frame; call pullEvaluatedLatest first`,
      );
    }
    if (!Number.isFinite(sampleOffset)) {
      throw new Error(
        `evaluateAtSampleOffset: sampleOffset must be finite, got ${sampleOffset}`,
      );
    }
    const consumerNs =
      this.cachedBaseConsumerNs + (sampleOffset / this.cachedSampleRate) * 1e9;
    const producerNs = this.phaseLockedTime(consumerNs);
    const dt_s = (producerNs - this.cachedTimestampNs) * 1e-9;
    this.evaluateInto(this.cachedRawFrame as FrameFor<S>, dt_s, out);
  }

  /**
   * Invalidate the cache shared by `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset`. (0.6.5)
   */
  resetEvalCache(): void {
    this.cachedEvalValid = false;
  }

  /**
   * Convert a timestamp value (read from the schema's role field, in the
   * role's declared unit) into nanoseconds.
   */
  private _timestampToNs(
    value: number,
    unit: TimestampUnit,
    sampleRate: number,
  ): number {
    switch (unit) {
      case "ns":      return value;
      case "us":      return value * 1e3;
      case "ms":      return value * 1e6;
      case "s":       return value * 1e9;
      case "samples": return (value / sampleRate) * 1e9;
    }
  }

  /**
   * Classify a stored vs computed invariant ratio into ok / soft / hard +
   * the soft-recovery α.
   *
   * The OK band is `max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`
   * compared against `|computed − stored|` (0.6.6). For non-trivial `stored`
   * the relative term dominates and behavior is bit-identical to 0.6.5's
   * pure-ratio check; the absolute floor only matters when `stored` is
   * subnormal-tiny or exactly zero.
   *
   *   ok:    |computed − stored| < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)
   *   soft:  delta < INVARIANT_SOFT_THRESHOLD   (relative; only when stored ≠ 0)
   *   hard:  otherwise, or NaN/Infinity on either side
   *
   * For soft, α = clamp(INVARIANT_SOFT_ALPHA_BASE / delta, 0, 1) — small
   * deviations get α≈1 (trust curr); deviations near the hard boundary get
   * α near INVARIANT_SOFT_ALPHA_BASE (trust prev). See file header "Schema
   * invariants" for the curve rationale.
   */
  private _classifyInvariant(
    computed: number,
    stored: number,
  ): { kind: "ok" | "soft" | "hard"; alpha: number } {
    if (!Number.isFinite(computed) || !Number.isFinite(stored)) {
      return { kind: "hard", alpha: 0 };
    }
    const absErr = Math.abs(computed - stored);
    // Bit-identical pre-0.6.6 short-circuit: exact equality is always OK,
    // even under absoluteEpsilon = 0 (which would otherwise collapse the OK
    // band to a half-open zero-width interval and miss the 0/0 case).
    if (absErr === 0) return { kind: "ok", alpha: 1 };
    const eps = this.invariantAbsoluteEpsilon;
    const absStored = Math.abs(stored);
    const okBand = eps > INVARIANT_OK_THRESHOLD * absStored
      ? eps
      : INVARIANT_OK_THRESHOLD * absStored;
    if (absErr < okBand) return { kind: "ok", alpha: 1 };
    if (stored === 0) {
      // OK band failed and stored is zero — relative-ratio classifier
      // undefined, so anything outside the absolute floor is hard.
      return { kind: "hard", alpha: 0 };
    }
    const delta = absErr / absStored;
    if (delta < INVARIANT_SOFT_THRESHOLD) {
      const alpha = Math.min(
        1,
        Math.max(0, INVARIANT_SOFT_ALPHA_BASE / delta),
      );
      return { kind: "soft", alpha };
    }
    return { kind: "hard", alpha: 0 };
  }

  /**
   * Invariant handler for raw pulls (`pull` / `pullLatest`) under an
   * invariant-enabled schema. Called after release-store and notify (both
   * issued by SpscRing). Only touches heap state (the FrameSmoother's prev
   * buffer, the ring's tornFrameCounter lane via
   * `ring.incrementTornFrameCount`).
   */
  private _invariantHandleRaw(
    out: Record<string, unknown>,
    invariantStored: number,
  ): void {
    const inv = this.schema.invariant;
    if (inv === null) return; // defensive — caller already checked.
    const computed = inv.compute(out);
    const { kind, alpha } = this._classifyInvariant(computed, invariantStored);
    if (kind === "ok") {
      this.smoother.seedFrom(out);
    } else if (kind === "soft") {
      this.smoother.observe(out, alpha);
    } else {
      // hard
      this.ring.incrementTornFrameCount();
      // If prev is valid, replace `out` with the last-known-good frame.
      // If not (first pull ever was a hard error), pass through unchanged
      // and don't seed prev with corrupt data. The smoother's
      // `fallbackInto` encapsulates both branches.
      this.smoother.fallbackInto(out);
    }
  }

  /**
   * Invariant handler for smoothed pulls (`pullSmoothed` /
   * `pullLatestSmoothed`). Always runs the smoother on ok / soft / no-
   * invariant; on hard error, falls back via `smoother.fallbackInto(out)`
   * (copies prev when valid; pass-through when no prev). Soft-error α is
   * the USER's α — the smoother is already smoothing; layering recovery-α
   * on top is unnecessary (the smoother's α gate handles minor deviations).
   */
  private _invariantHandleSmoothed(
    out: Record<string, unknown>,
    invariantStored: number,
    alpha: number,
  ): void {
    if (this.schema.invariant === null) {
      // No invariant: behavior identical to 0.5.0 smoothed pull.
      this.smoother.observe(out, alpha);
      return;
    }
    const computed = this.schema.invariant.compute(out);
    const { kind } = this._classifyInvariant(computed, invariantStored);
    if (kind === "hard") {
      this.ring.incrementTornFrameCount();
      // If prev is valid, replace `out` with the last-known-good frame.
      // If not, pass through unchanged. Either way, don't seed prev with
      // corrupt data.
      this.smoother.fallbackInto(out);
      return;
    }
    // ok or soft: smoother handles both. Identical to no-invariant path.
    this.smoother.observe(out, alpha);
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    return this.ring.available();
  }

  /**
   * Producer-side adaptive backpressure hint. Returns the consumer's most
   * recent flow_scale value in [0.5, 2.0]:
   *
   *   1.0  no scaling — producer/consumer rates are matched
   *   <1.0 consumer is overfull — producer should slow down (push less)
   *   >1.0 consumer is starved  — producer should speed up (push more)
   *
   * Best-effort: the bridge does NOT enforce this. The producer voluntarily
   * honors the hint by scaling its `dt`, dropping frames, sleeping a
   * fraction of its interval, etc. See SpscRing.ts header "Adaptive
   * backpressure" for the controller math.
   */
  flowScaleHint(): number {
    return this.ring.flowScaleHint();
  }

  /**
   * Observability snapshot. Returns a frozen object with the current state
   * of every bridge-managed counter / hint:
   *
   *   tornFrames  — monotonic count of hard-error invariant fallbacks since
   *                 SAB allocation (0 if the schema has no invariant or if
   *                 no hard error has ever occurred). Wraps mod 2^32 like
   *                 the other Int32 lanes.
   *   flowScale   — current consumer→producer adaptive backpressure hint,
   *                 in [0.5, 2.0]. Same value `flowScaleHint()` returns.
   *   available   — number of frames currently buffered.
   *   capacity    — total ring capacity (constant per Bridge instance).
   *   writeIndex  — current producer counter (Int32, wraps mod 2^32).
   *   readIndex   — current consumer counter (Int32, wraps mod 2^32).
   *
   * All reads are O(1) and use Atomics.load — safe to call from any
   * thread. The snapshot is a point-in-time sample; under live producer/
   * consumer activity the values are individually consistent but not
   * mutually atomic. For diagnostic / dashboard use only.
   */
  telemetry(): {
    readonly tornFrames: number;
    readonly flowScale: number;
    readonly available: number;
    readonly capacity: number;
    readonly writeIndex: number;
    readonly readIndex: number;
    readonly pllLocked: boolean;
    readonly pllOffsetNs: number;
  } {
    return Object.freeze({
      tornFrames: this.ring.tornFrameCount(),
      flowScale: this.ring.flowScaleHint(),
      available: this.ring.available(),
      capacity: this.capacity,
      writeIndex: this.ring.writeIndexUnsigned(),
      readIndex: this.ring.readIndexUnsigned(),
      // PLL fields are heap-only on this Bridge instance (gathered from
      // the composed ConsumerClockRecovery as of 0.6.9). A peer reading
      // their own Bridge's telemetry sees their own PLL state. Lanes 4-5
      // are still reserved; cross-process observability lands in a follow-up.
      pllLocked: this.pll.locked,
      pllOffsetNs: this.pll.offsetNs,
    });
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return this.ring.waitForSpace(timeoutMs);
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
    return this.ring.waitForData(timeoutMs);
  }

  /**
   * Returns a JSON-able description of the schema's frame byte layout, for
   * worklets that want to inline the read protocol without importing the
   * Bridge class on the audio thread. The worklet can postMessage this
   * object across via `processorOptions` and reconstruct the per-field
   * typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return this.ring.describeLayout();
  }

  /**
   * Test-only hook (underscore-prefixed): drive the inner ring's flow-scale
   * PI controller directly with a synthetic (writeIdx, readIdx) pair. Used
   * by `tests/Bridge.test.ts#testFlowScalePIStepResponse` to pin the gain
   * shape + anti-windup behavior without running an actual SPSC round-trip.
   * Delegates to `SpscRing._updateFlowScale` (the same method the ring's
   * own pull-path invokes). NOT part of the public API; subject to change
   * without notice. The underscore prefix is the project's "internal but
   * reflectable" convention — TypeScript would flag a `private` modifier
   * unused since the call site is via a test-only `as unknown as { ... }`
   * cast.
   */
  _updateFlowScale(writeIdx: number, readIdx: number): void {
    this.ring._updateFlowScale(writeIdx, readIdx);
  }

  // ─── Validation (used by pushChecked) ────────────────────────────────────

  private _validateFrame(view: FrameFor<S>, ctx: string): void {
    const frame = view as unknown as Record<string, unknown>;
    for (const field of this.schema.compiled.fields) {
      const val = frame[field.name];
      if (field.isArray) {
        const Ctor = ctorForKind(field.kind);
        if (!(val instanceof Ctor)) {
          const got = val === null || val === undefined
            ? String(val)
            : (val as { constructor?: { name?: string } }).constructor?.name ?? typeof val;
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${Ctor.name}(${field.length}), got ${got}`,
          );
        }
        const len = (val as { length: number }).length;
        if (len !== field.length) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected length ${field.length}, got ${len}`,
          );
        }
      } else {
        const expected = kindTsType(field.kind);
        if (typeof val !== expected) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${expected}, got ${typeof val}`,
          );
        }
      }
    }
  }
}
