/**
 * Schema DSL — describes the byte layout of a single frame in a Bridge ring.
 *
 * A schema is built from named field constructors:
 *
 *   const s = defineSchema({
 *     seq:  u64(),
 *     tNs:  u64(),
 *     vMax: f64(),
 *     vEff: f64Array(64),
 *   });
 *
 * Each field has a kind (one of f64/f32/u64/i64/u32/i32/u16/i16/u8/i8) and an
 * optional `length` (omitted = scalar; positive integer = fixed-length array).
 *
 * `defineSchema` validates the field set, computes a packed layout grouped by
 * alignment class (8-aligned types first, then 4-, then 2-, then 1-aligned),
 * and returns a frozen Schema<F> that the Bridge class consumes. Alignment
 * grouping is required because SAB-backed typed-array constructors
 * (`new Float32Array(sab, byteOffset, length)`) throw if `byteOffset` is not
 * aligned to the element size. Sorting by alignment class lets us pack tightly
 * without padding between fields of the same class.
 *
 * The frame size is padded to 8 bytes so the next ring slot starts 8-aligned
 * (the f64/u64/i64 umbrella view of the SAB requires it; the ring header is
 * already 32 bytes = 8-aligned, so slot 0 starts aligned too).
 *
 * Field-level TypeScript inference is driven by the phantom `_t?: T` slot on
 * `FieldSpec<T>`. Each constructor returns `FieldSpec<T>` for the concrete TS
 * type that field carries on a frame (e.g. `u64()` returns `FieldSpec<bigint>`,
 * `f64Array(n)` returns `FieldSpec<Float64Array>`). The `FrameFor<S>` mapped
 * type extracts those `T`s into the shape `Bridge.push`/`pull` accept.
 *
 * ─── Schema invariants (0.6.0; epsilon floor added in 0.6.6) ──────────────
 *
 * `defineSchema(...).withInvariant(fn, opts?)` builds a new schema with a
 * hidden `__invariant: f64` lane appended at the end of each frame slot. The
 * Bridge auto-computes the invariant on push (caller-supplied fn) and
 * verifies on pull; mismatches are classified as soft (smoother recovery) or
 * hard (last-known-good fallback + lane-3 tornFrameCounter increment). See
 * the `Schema invariants` section of `src/Bridge.ts` for the runtime
 * protocol and recovery thresholds. `opts.absoluteEpsilon` (0.6.6, default
 * `1e-12`) sets the lower floor on the OK band so subnormal-zero and tiny
 * rounding residues classify as OK instead of HARD; see
 * `WithInvariantOptions`.
 *
 * The invariant fn must be O(payload size), allocation-free, and pure (same
 * input → same output bit-exactly). Sum-of-squares is the canonical choice
 * for f64-dominant schemas; xxhash / CRC32 work for byte-oriented payloads.
 * BigInt and integer fields can be coerced into the sum or run through a
 * separate accumulator — the bridge doesn't constrain the choice.
 *
 * Type erasure: schemas with and without invariants share the `Schema<F>`
 * type. `FrameFor<S>` does NOT include the hidden `__invariant` field — it's
 * bridge-managed, never exposed to user-side reads/writes.
 *
 * ─── Trajectory arrays (0.6.1 — Pillar 1 scaffolding) ──────────────────────
 *
 * `f64TrajectoryArray(n, { order })` and `f32TrajectoryArray(n, { order })`
 * are *labeled* array constructors. Byte-wise they are identical to
 * `f64Array(n * order)` / `f32Array(n * order)` — the underlying storage is
 * an interleaved typed-array of `n * order` elements laid out as
 *
 *     order=1:  [p0, p1, ..., p_{n-1}]                       — position only
 *     order=2:  [p0, v0, p1, v1, ..., p_{n-1}, v_{n-1}]      — pos + velocity
 *     order=3:  [p0, v0, a0, p1, v1, a1, ..., p_{n-1}, v_{n-1}, a_{n-1}]
 *     order=4:  [p0, v0, a0, j0, p1, v1, a1, j1, ...]      — jerk lane (0.9.80)
 *
 * `layout: "interleaved"` (default) preserves this layout. `layout: "planar"`
 * stores contiguous lanes as `[p0, p1, ...], [v0, v1, ...], [a0, a1, ...], ...`.
 *
 * The interleaved layout (rather than concatenated `[p…, v…, a…]`) keeps
 * each sample's position and derivatives cache-line adjacent so a downstream
 * Taylor/Hermite evaluator can walk the trajectory in one pass with minimal
 * L1 misses for typical N=128–2048 voice grids.
 *
 * Trajectory fields carry a `trajectory: { order, sampleCount }` tag on
 * both the FieldSpec and the CompiledField. The tag is descriptive
 * metadata — the codec writes/reads the flat element count
 * (`length = n * order`) like any other array. The metadata is for
 * downstream consumers (a future `evaluateInto` evaluator, worklet
 * inliners) to detect that a field is a trajectory and treat its elements
 * as `(p, v, [a])` tuples instead of opaque samples.
 *
 * Order is restricted to 1 | 2 | 3:
 *   - order=1 is byte-compatible with `f{32,64}Array(n)` (positions only,
 *     equivalent to today's behavior).
 *   - order=2 enables linear Taylor extrapolation: `value(dt) = p + v·dt`.
 *   - order=3 enables quadratic Taylor / cubic Hermite:
 *     `value(dt) = p + v·dt + ½·a·dt²`.
 * Higher orders on a unitary stepper are an open research direction —
 * deferred until there's a concrete consumer for them.
 *
 * Wire compatibility: trajectory fields are byte-compatible with the
 * equivalent plain array. A schema that swaps `f64Array(64)` for
 * `f64TrajectoryArray(64, { order: 1 })` produces identical SAB bytes;
 * only the field's compiled metadata changes.
 *
 * ─── Trajectory safety clamps (0.6.7) ─────────────────────────────────────
 *
 * `f{32,64}TrajectoryArray(n, opts)` accepts optional safety clamps that
 * make order-2/3 Taylor extrapolation robust against transient producer
 * values (a spurious huge velocity / acceleration sample). Clamps are
 * schema metadata and never change the SAB byte layout — a clamp-equipped
 * schema and its clamp-free twin produce identical bytes, so a 0.6.7 peer
 * and a 0.6.6 peer interoperate transparently.
 *
 *   - `velocityClamp`     — `|v_i|` capped pre-evaluation (both signs).
 *   - `accelerationClamp` — `|a_i|` capped pre-evaluation (order=3 only).
 *   - `maxDeltaPerSample` — `|out[i] - out[i-1]|` capped post-evaluation.
 *   - `overflowFallback`  — `'hold' | 'linear' | 'saturate'` (default
 *                           `'saturate'`); consulted only when
 *                           `maxDeltaPerSample` fires.
 *
 * When no clamp is set, `evaluateTrajectoryInto` uses the 0.6.6 fast path
 * bit-exactly. When any clamp is set the evaluator switches to a clamped
 * path that pre-resolves the spec into a small per-spec config so the hot
 * loop stays branch-free per call.
 *
 * ─── Timestamp roles (0.6.5) ───────────────────────────────────────────────
 *
 * `defineSchema({...}).withTimestamps({ roleName: { field, unit, default? } })`
 * declares one or more named *timestamp roles* on the schema. Each role
 * points at an existing numeric scalar field and labels its unit. The
 * Bridge's `pullEvaluatedLatest` / `evaluateAtSampleOffset` sugar (0.6.5)
 * reads the timestamp value from the role's `field` and converts to
 * nanoseconds internally for the PLL + per-sample dt math.
 *
 *     const schema = defineSchema({
 *       seq: u64(),
 *       tMacroNs: u64(),
 *       tGpuNs:   u64(),
 *       vEff: f64TrajectoryArray(64, { order: 2 }),
 *     }).withTimestamps({
 *       macro: { field: "tMacroNs", unit: "ns", default: true },
 *       gpu:   { field: "tGpuNs",   unit: "ns" },
 *     });
 *
 *     bridge.pullEvaluatedLatest(out, baseNs, sampleRate);
 *                                         // uses macro (the default)
 *     bridge.pullEvaluatedLatest(out, baseNs, sampleRate, { timestamp: "gpu" });
 *                                         // selects gpu instead
 *
 * Why roles rather than a raw field-name string: roles are declared once
 * at schema-author time, type-checked at call sites (the `timestamp`
 * option only accepts declared role names), and carry the unit alongside
 * — callers never re-convert. A producer that ships several timestamp
 * fields (a macro clock, a GPU clock, an audio-frame index) declares all
 * three; each consumer picks the role most natural for its math.
 *
 * Supported units: `'ns' | 'us' | 'ms' | 's' | 'samples'`. The Bridge
 * converts to ns via the obvious factor (samples uses the per-call
 * `sampleRate`). A future `{ unit: 'custom', toNs: number }` escape
 * hatch is anticipated but deferred — not shipped until a concrete
 * caller asks for it. (When you do need it, the conversion is a single
 * multiply inside `_resolveTimestampNs` in src/Bridge.ts.)
 *
 * Validation at builder time:
 *   - Every `field` must exist on the schema and be a scalar numeric
 *     kind (u64/i64/u32/i32/u16/i16/u8/i8/f64/f32). Array fields cannot
 *     be timestamps; neither can BigInt-but-non-integer kinds (there
 *     are none currently, but the kind whitelist is checked).
 *   - Unit must be one of the supported strings.
 *   - At most one role may set `default: true`. If none does, the first
 *     declared role becomes the default.
 *
 * Wire compatibility: descriptive only. Timestamp roles do NOT change
 * frame byte layout — they label existing fields. A 0.6.4 peer and a
 * 0.6.5 peer share a SAB transparently; the timestamps spec lives on
 * the consumer's `Schema` object (heap), never in the SAB header.
 *
 * ─── Circular (angular) lanes (0.9.935) ────────────────────────────────────
 *
 * `f64Phase()` / `f32Phase()` (scalar) and `f64PhaseArray(n)` /
 * `f32PhaseArray(n)` (array) declare a field whose value(s) live on the
 * circle ℝ/2πℤ — audio phase. `f{32,64}Circular({ period })` and
 * `f{32,64}CircularArray(n, { period })` generalize to any finite positive
 * period (1 for normalized [0,1) phase, 360 for degrees, 12 for pitch
 * classes). `f{32,64}CircularTrajectoryArray(n, { order, period })` composes
 * an angular position lane with ordinary derivative lanes.
 *
 * These attach a `circular: { period }` tag (see `CircularSpec`) and are
 * byte-identical to the plain f64/f32 field of the same flat length. The tag
 * tells topology-aware consumers — `FrameSmoother`'s geodesic blend and the
 * circular Taylor / Hermite evaluators — to operate along the SHORTER ARC of
 * the circle and re-wrap at output, instead of blending/extrapolating in flat
 * ℝ (which corrupts the lane whenever it crosses the ±period/2 branch cut).
 * See src/circular.ts for the math and docs/topological-lanes-design.md.
 *
 * Wire compatibility: descriptive only, like trajectories and timestamps. A
 * circular lane and its plain f64/f32 twin produce identical SAB bytes; a
 * pre-0.9.935 peer and a 0.9.935 peer interoperate transparently. Only the
 * consumer-side reconstruction differs.
 */

import { TWO_PI } from "./circular.js";

export type FieldKind =
  | "u64" | "i64"
  | "u32" | "i32"
  | "u16" | "i16"
  | "u8"  | "i8"
  | "f64" | "f32";

/** Byte size of one element of `kind`. Exhaustive over FieldKind. */
export function kindByteSize(kind: FieldKind): number {
  switch (kind) {
    case "u64": case "i64": case "f64": return 8;
    case "u32": case "i32": case "f32": return 4;
    case "u16": case "i16": return 2;
    case "u8":  case "i8":  return 1;
  }
}

/** Runtime `typeof` tag of values of `kind` — used by pushChecked validation. */
export function kindTsType(kind: FieldKind): "bigint" | "number" {
  switch (kind) {
    case "u64": case "i64": return "bigint";
    default: return "number";
  }
}

/** Trajectory order — number of derivative components stored per sample.
 *  1 = position only (byte-compatible with a plain array).
 *  2 = position + velocity (linear Taylor extrapolation / cubic Hermite).
 *  3 = position + velocity + acceleration (quadratic Taylor / quintic Hermite).
 *  4 = position + velocity + acceleration + jerk (cubic Taylor / septic Hermite,
 *      0.9.80). The order-4 jerk lane is interleaved as `[p, v, a, j, …]`; it is
 *      an **additive** widening — order 1/2/3 producers are byte-unchanged. */
export type TrajectoryOrder = 1 | 2 | 3 | 4;
/** Storage layout for trajectory arrays. */
export type TrajectoryLayout = "interleaved" | "planar";

/** Behavior of the clamped trajectory evaluator when a per-sample clamp band is
 *  exceeded (0.6.7). Only consulted when `maxDeltaPerSample` is set.
 *    'hold'     — use the previous sample's output value (freeze the signal
 *                 when extrapolation goes out of band).
 *    'linear'   — fall back to order-2 (`p + v·dt`) ignoring acceleration.
 *                 **Silent-equivalence note:** on `order=1` (no velocity)
 *                 and `order=2` (no acceleration term to drop) `'linear'`
 *                 has nothing to drop and collapses to `'saturate'`. The
 *                 distinction only matters at `order=3`. Pick `'linear'`
 *                 deliberately when you want the order-3 evaluator to
 *                 degrade to its order-2 result on band violations rather
 *                 than to a flat saturate clamp.
 *    'saturate' — clamp the would-be output into
 *                 `[out[i-1] - maxDelta, out[i-1] + maxDelta]`. */
export type TrajectoryOverflowFallback = "hold" | "linear" | "saturate";

/** Reconstruction strategy used by the consumer-side trajectory evaluator
 *  (0.7.3). Wire-compatible: pure schema metadata, no SAB byte change.
 *    'taylor' — single-frame extrapolation of the producer-stamped
 *               derivatives. Default; bit-exact equal to 0.7.2 behavior.
 *               `Bridge.evaluateInto(frame, dt, out)` is the entry point.
 *    'hermite' — C¹-continuous cubic interpolation between two consecutive
 *               frames using endpoint positions + velocities as the
 *               Hermite spline tangents. Requires `order >= 2` (velocities
 *               at both endpoints). Entry point is the two-frame
 *               `Bridge.evaluateHermiteInto(prev, curr, t, segmentSec, out)`.
 *               Tightens the spectral rolloff of the reconstructed signal
 *               (continuous tangent at frame boundaries → no first-derivative
 *               step), eliminating the "zipper" sound on slowly-varying
 *               envelopes.
 *    'quintic-hermite' — C²-continuous degree-5 interpolation matching endpoint
 *               position + velocity + acceleration (0.9.80). Requires
 *               `order >= 3` (the order-3 acceleration lane already exists, so
 *               this is wire-compatible — pure consumer-side reconstruction).
 *               Removes the second-derivative step at frame boundaries.
 *    'septic-hermite' — C³-continuous degree-7 interpolation matching endpoint
 *               position + velocity + acceleration + jerk (0.9.80). Requires
 *               `order == 4` (the additive jerk lane). Removes the
 *               third-derivative step. Both higher-order modes use the same
 *               two-frame `Bridge.evaluateHermiteInto` entry point.
 *
 *  **Stability commitment (0.8.10 → 0.9.80 → 1.0):** the original 0.8.10 note
 *  closed this union at `'taylor' | 'hermite'` and deferred quintic-Hermite to
 *  a post-1.0 additive bump. 0.9.80 brought that forward: the higher-order
 *  modes landed **additively and wire-compatibly inside the 0.9.x line**
 *  (quintic over the existing order-3 wire; septic over the additive order-4
 *  jerk lane). The union is now closed at 1.0 at
 *  `'taylor' | 'hermite' | 'quintic-hermite' | 'septic-hermite'`. Adding a mode
 *  remains always additive — a new arm is a deliberate compile error for
 *  exhaustive consumer `switch`es, never a silent fall-through. */
export type TrajectoryInterpolationMode =
  | "taylor"
  | "hermite"
  | "quintic-hermite"
  | "septic-hermite";

/** Descriptive metadata attached to fields built via
 *  `f{32,64}TrajectoryArray(n, { order })`. The underlying storage is a flat
 *  interleaved array of `sampleCount * order` elements; this tag tells
 *  downstream consumers how to interpret those elements as (p, v, [a]) tuples.
 *
 *  0.6.7 adds optional safety clamps. They are schema metadata only — the SAB
 *  bytes are identical with or without clamps set, so a 0.6.7 producer and a
 *  0.6.6 consumer (or vice versa) interoperate transparently. The clamps act
 *  consumer-side in `evaluateTrajectoryInto`'s clamped path and are dormant on
 *  the fast path when none are set. */
export interface TrajectorySpec {
  readonly order: TrajectoryOrder;
  /** Number of logical samples. Underlying typed-array length = sampleCount * order. */
  readonly sampleCount: number;
  /** Optional trajectory layout for `sampleCount` samples.
   *  Omitted means `interleaved` for backward compatibility.
   *  `planar` stores each derivative lane contiguously. */
  readonly layout?: TrajectoryLayout;
  /** Upper bound on `|v_i|` pre-evaluation. When set the clamped evaluator
   *  clamps each loaded velocity to `[-velocityClamp, +velocityClamp]` before
   *  the Taylor multiply. Must be finite + positive. */
  readonly velocityClamp?: number;
  /** Upper bound on `|a_i|` pre-evaluation. Only meaningful at `order: 3`.
   *  Must be finite + positive. */
  readonly accelerationClamp?: number;
  /** Upper bound on `|out[i] - out[i-1]|`. When set, the clamped evaluator
   *  observes successive output samples and consults `overflowFallback` on the
   *  first violation (sample 0 is always allowed since there is no previous
   *  output). Must be finite + positive. */
  readonly maxDeltaPerSample?: number;
  /** Behavior when `maxDeltaPerSample` is exceeded. Default `'saturate'`. When
   *  only `velocityClamp` / `accelerationClamp` are set (no per-sample delta
   *  band), the clamped evaluator uses the clamped derivatives as-is and never
   *  consults this field. */
  readonly overflowFallback?: TrajectoryOverflowFallback;
  /** Consumer-side reconstruction strategy (0.7.3). Default `'taylor'` is
   *  bit-exact equal to 0.7.2 behavior; `'hermite'` switches the consumer
   *  to two-frame C¹ cubic interpolation (requires `order >= 2`). Pure
   *  metadata — producer SAB bytes are identical for both modes. */
  readonly interpolationMode?: TrajectoryInterpolationMode;
}

/** Descriptive metadata attached to fields built via the circular
 *  constructors (`f{32,64}Phase` / `f{32,64}Circular` and their `*Array`
 *  variants, 0.9.935). Marks the field's value(s) as living on the circle
 *  ℝ/`period`ℤ rather than the real line, so topology-aware consumers
 *  (FrameSmoother's geodesic blend, the circular Taylor / Hermite
 *  evaluators) operate along the shorter arc and re-wrap at output instead
 *  of corrupting the lane across the ±period/2 branch cut.
 *
 *  Wire-compatible: pure schema metadata, identical SAB bytes to the plain
 *  f64/f32 array of the same flat length. A circular lane and its plain twin
 *  interoperate transparently; only the consumer-side interpretation differs.
 *  Composes with `trajectory` — a `f64CircularTrajectoryArray` carries BOTH
 *  tags (the position lanes are angular; the derivative lanes are ordinary
 *  rates, blended/copied as usual). */
export interface CircularSpec {
  /** The circle's period. A full turn. Default `2π` (`f64Phase`); any finite
   *  positive value is allowed (`1` for a normalized [0,1) phase, `360` for
   *  degrees, `12` for pitch classes). */
  readonly period: number;
}

export interface FieldSpec<T = unknown> {
  readonly kind: FieldKind;
  /** Omitted = scalar; positive integer = fixed-length array. */
  readonly length?: number;
  /** Total bytes occupied by this field within a frame. */
  readonly byteSize: number;
  /** Phantom type tag — drives FrameFor<S> inference; never set at runtime. */
  readonly _t?: T;
  /** Present iff this field was built via `f{32,64}TrajectoryArray`. */
  readonly trajectory?: TrajectorySpec;
  /** Present iff this field was built via a circular constructor
   *  (`f{32,64}Phase` / `f{32,64}Circular` / their array + trajectory
   *  variants). Marks the value(s) as angular — see `CircularSpec`. */
  readonly circular?: CircularSpec;
}

// ─── Scalar field constructors ─────────────────────────────────────────────

function scalar<T>(kind: FieldKind): FieldSpec<T> {
  return Object.freeze({ kind, byteSize: kindByteSize(kind) }) as FieldSpec<T>;
}

export const u64 = (): FieldSpec<bigint> => scalar<bigint>("u64");
export const i64 = (): FieldSpec<bigint> => scalar<bigint>("i64");
export const f64 = (): FieldSpec<number> => scalar<number>("f64");
export const u32 = (): FieldSpec<number> => scalar<number>("u32");
export const i32 = (): FieldSpec<number> => scalar<number>("i32");
export const f32 = (): FieldSpec<number> => scalar<number>("f32");
export const u16 = (): FieldSpec<number> => scalar<number>("u16");
export const i16 = (): FieldSpec<number> => scalar<number>("i16");
export const u8  = (): FieldSpec<number> => scalar<number>("u8");
export const i8  = (): FieldSpec<number> => scalar<number>("i8");

// ─── Array field constructors ──────────────────────────────────────────────

function array<T>(kind: FieldKind, n: number): FieldSpec<T> {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Schema: array length must be a positive integer, got ${n}`,
    );
  }
  return Object.freeze({
    kind,
    length: n,
    byteSize: kindByteSize(kind) * n,
  }) as FieldSpec<T>;
}

export const u64Array = (n: number): FieldSpec<BigUint64Array> => array<BigUint64Array>("u64", n);
export const i64Array = (n: number): FieldSpec<BigInt64Array>  => array<BigInt64Array>("i64", n);
export const f64Array = (n: number): FieldSpec<Float64Array>   => array<Float64Array>("f64", n);
export const f32Array = (n: number): FieldSpec<Float32Array>   => array<Float32Array>("f32", n);
export const u32Array = (n: number): FieldSpec<Uint32Array>    => array<Uint32Array>("u32", n);
export const i32Array = (n: number): FieldSpec<Int32Array>     => array<Int32Array>("i32", n);
export const u16Array = (n: number): FieldSpec<Uint16Array>    => array<Uint16Array>("u16", n);
export const i16Array = (n: number): FieldSpec<Int16Array>     => array<Int16Array>("i16", n);
export const u8Array  = (n: number): FieldSpec<Uint8Array>     => array<Uint8Array>("u8",  n);
export const i8Array  = (n: number): FieldSpec<Int8Array>      => array<Int8Array>("i8",  n);

// ─── Trajectory array constructors (0.6.1) ─────────────────────────────────
//
// Byte-wise identical to `f{32,64}Array(n * order)`. The `trajectory` tag
// labels the field so downstream consumers (a future `evaluateInto`
// evaluator, worklet inliners) can detect that the flat element stream is
// a trajectory `(p, v, [a], [j])` sequence rather than opaque samples. See the
// "Trajectory arrays" section at the top of this file for the layout.

/** Options accepted by `f{32,64}TrajectoryArray(n, opts)`. The `order` field
 *  is required; clamp fields are optional and trigger the clamped evaluator
 *  path in `evaluateTrajectoryInto` (0.6.7). */
export interface TrajectoryArrayOptions {
  readonly order: TrajectoryOrder;
  /** Storage layout. Omitted or `"interleaved"` stores `[p,v,[a],[j]]`
   *  samples together. `"planar"` stores each derivative plane contiguously.
   *  Defaults to `"interleaved"` for backward compatibility. */
  readonly layout?: TrajectoryLayout;
  readonly velocityClamp?: number;
  readonly accelerationClamp?: number;
  readonly maxDeltaPerSample?: number;
  /** See `TrajectoryOverflowFallback` for semantics. Note: `'linear'`
   *  collapses to `'saturate'` on `order=1` and `order=2` (there is no
   *  acceleration term to drop); the distinction only matters at
   *  `order=3`. */
  readonly overflowFallback?: TrajectoryOverflowFallback;
  /** Reconstruction strategy passed through to the consumer-side evaluator
   *  (0.7.3, extended 0.9.80). `'hermite'` requires `order >= 2`,
   *  `'quintic-hermite'` (C²) requires `order >= 3`, `'septic-hermite'` (C³)
   *  requires `order == 4`. The union is **closed at 1.0** at
   *  `'taylor' | 'hermite' | 'quintic-hermite' | 'septic-hermite'` (so consumer
   *  `switch` statements can stay exhaustive without a default branch).
   *  Default `'taylor'`. */
  readonly interpolationMode?: TrajectoryInterpolationMode;
}

const VALID_INTERPOLATION_MODES: ReadonlySet<TrajectoryInterpolationMode> = new Set<
  TrajectoryInterpolationMode
>(["taylor", "hermite", "quintic-hermite", "septic-hermite"]);

const VALID_OVERFLOW_FALLBACKS: ReadonlySet<TrajectoryOverflowFallback> = new Set<
  TrajectoryOverflowFallback
>(["hold", "linear", "saturate"]);
const VALID_TRAJECTORY_LAYOUTS: ReadonlySet<TrajectoryLayout> = new Set<
  TrajectoryLayout
>(["interleaved", "planar"]);

function validatePositiveFiniteClamp(label: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(
      `Schema: trajectory ${label} must be a finite positive number, got ${String(v)}`,
    );
  }
}

function trajectoryArray<T>(
  kind: "f64" | "f32",
  sampleCount: number,
  opts: TrajectoryArrayOptions,
): FieldSpec<T> {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new Error(
      `Schema: trajectory sampleCount must be a positive integer, got ${sampleCount}`,
    );
  }
  const { order } = opts;
  if (order !== 1 && order !== 2 && order !== 3 && order !== 4) {
    throw new Error(
      `Schema: trajectory order must be 1 | 2 | 3 | 4, got ${String(order)}`,
    );
  }
  if (opts.velocityClamp !== undefined) {
    validatePositiveFiniteClamp("velocityClamp", opts.velocityClamp);
  }
  if (opts.accelerationClamp !== undefined) {
    validatePositiveFiniteClamp("accelerationClamp", opts.accelerationClamp);
  }
  if (opts.maxDeltaPerSample !== undefined) {
    validatePositiveFiniteClamp("maxDeltaPerSample", opts.maxDeltaPerSample);
  }
  if (
    opts.overflowFallback !== undefined &&
    !VALID_OVERFLOW_FALLBACKS.has(opts.overflowFallback)
  ) {
    throw new Error(
      `Schema: trajectory overflowFallback must be 'hold' | 'linear' | 'saturate', got ${String(opts.overflowFallback)}`,
    );
  }
  if (
    opts.interpolationMode !== undefined &&
    !VALID_INTERPOLATION_MODES.has(opts.interpolationMode)
  ) {
    throw new Error(
      `Schema: trajectory interpolationMode must be 'taylor' | 'hermite' | 'quintic-hermite' | 'septic-hermite', got ${String(opts.interpolationMode)}`,
    );
  }
  if (opts.interpolationMode === "hermite" && order < 2) {
    throw new Error(
      `Schema: trajectory interpolationMode 'hermite' requires order >= 2 (need endpoint velocities), got order=${order}`,
    );
  }
  if (opts.interpolationMode === "quintic-hermite" && order < 3) {
    throw new Error(
      `Schema: trajectory interpolationMode 'quintic-hermite' requires order >= 3 (need endpoint accelerations for C² continuity), got order=${order}`,
    );
  }
  if (opts.interpolationMode === "septic-hermite" && order !== 4) {
    throw new Error(
      `Schema: trajectory interpolationMode 'septic-hermite' requires order == 4 (need endpoint jerk for C³ continuity), got order=${order}`,
    );
  }
  const layout = opts.layout ?? "interleaved";
  if (!VALID_TRAJECTORY_LAYOUTS.has(layout)) {
    throw new Error(
      `Schema: trajectory layout must be 'interleaved' | 'planar', got ${String(layout)}`,
    );
  }
  const flatLength = sampleCount * order;
  const trajectory: TrajectorySpec = Object.freeze({
    order,
    sampleCount,
    ...(layout !== "interleaved" ? { layout } : {}),
    ...(opts.velocityClamp !== undefined ? { velocityClamp: opts.velocityClamp } : {}),
    ...(opts.accelerationClamp !== undefined ? { accelerationClamp: opts.accelerationClamp } : {}),
    ...(opts.maxDeltaPerSample !== undefined ? { maxDeltaPerSample: opts.maxDeltaPerSample } : {}),
    ...(opts.overflowFallback !== undefined ? { overflowFallback: opts.overflowFallback } : {}),
    ...(opts.interpolationMode !== undefined ? { interpolationMode: opts.interpolationMode } : {}),
  });
  return Object.freeze({
    kind,
    length: flatLength,
    byteSize: kindByteSize(kind) * flatLength,
    trajectory,
  }) as FieldSpec<T>;
}

export const f64TrajectoryArray = (
  n: number,
  opts: TrajectoryArrayOptions,
): FieldSpec<Float64Array> =>
  trajectoryArray<Float64Array>("f64", n, opts);

/** f32 variant — preferred for memory-tight high-order cases (order=3 at
 *  large N). Loses ~7 decimal digits of precision per sample vs f64; only
 *  use when the producer's PDE doesn't need double precision in the
 *  derivatives. */
export const f32TrajectoryArray = (
  n: number,
  opts: TrajectoryArrayOptions,
): FieldSpec<Float32Array> =>
  trajectoryArray<Float32Array>("f32", n, opts);

// ─── Circular (angular) field constructors (0.9.935) ───────────────────────
//
// Byte-wise identical to the plain f64/f32 scalar/array of the same flat
// length; the `circular` tag marks the value(s) as living on the circle
// ℝ/periodℤ so topology-aware consumers blend along the shorter arc and
// re-wrap at output. `f{32,64}Phase` fixes period = 2π (the audio-phase
// case); `f{32,64}Circular({ period })` lets the caller pick any finite
// positive period. See src/circular.ts for the math and
// docs/topological-lanes-design.md for the design.

/** Options for the general circular constructors. `period` defaults to 2π. */
export interface CircularOptions {
  /** The circle's period (a full turn). Default `2π`. Must be finite > 0. */
  readonly period?: number;
}

function resolvePeriod(period: number | undefined, label: string): number {
  const p = period ?? TWO_PI;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    throw new Error(`Schema: ${label} period must be a finite positive number, got ${String(p)}`);
  }
  return p;
}

function circularScalar<T>(kind: "f64" | "f32", period: number): FieldSpec<T> {
  return Object.freeze({
    kind,
    byteSize: kindByteSize(kind),
    circular: Object.freeze({ period }),
  }) as FieldSpec<T>;
}

function circularArray<T>(kind: "f64" | "f32", n: number, period: number): FieldSpec<T> {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Schema: circular array length must be a positive integer, got ${n}`);
  }
  return Object.freeze({
    kind,
    length: n,
    byteSize: kindByteSize(kind) * n,
    circular: Object.freeze({ period }),
  }) as FieldSpec<T>;
}

/** Scalar audio phase: a circular f64 with period 2π. */
export const f64Phase = (): FieldSpec<number> => circularScalar<number>("f64", TWO_PI);
/** Scalar audio phase: a circular f32 with period 2π. */
export const f32Phase = (): FieldSpec<number> => circularScalar<number>("f32", TWO_PI);
/** Scalar circular f64 with a caller-chosen period (default 2π). */
export const f64Circular = (opts: CircularOptions = {}): FieldSpec<number> =>
  circularScalar<number>("f64", resolvePeriod(opts.period, "f64Circular"));
/** Scalar circular f32 with a caller-chosen period (default 2π). */
export const f32Circular = (opts: CircularOptions = {}): FieldSpec<number> =>
  circularScalar<number>("f32", resolvePeriod(opts.period, "f32Circular"));

/** Array of audio phases: circular f64 array, period 2π. */
export const f64PhaseArray = (n: number): FieldSpec<Float64Array> =>
  circularArray<Float64Array>("f64", n, TWO_PI);
/** Array of audio phases: circular f32 array, period 2π. */
export const f32PhaseArray = (n: number): FieldSpec<Float32Array> =>
  circularArray<Float32Array>("f32", n, TWO_PI);
/** Array of circular f64 values with a caller-chosen period (default 2π). */
export const f64CircularArray = (n: number, opts: CircularOptions = {}): FieldSpec<Float64Array> =>
  circularArray<Float64Array>("f64", n, resolvePeriod(opts.period, "f64CircularArray"));
/** Array of circular f32 values with a caller-chosen period (default 2π). */
export const f32CircularArray = (n: number, opts: CircularOptions = {}): FieldSpec<Float32Array> =>
  circularArray<Float32Array>("f32", n, resolvePeriod(opts.period, "f32CircularArray"));

// Circular trajectory arrays — the composition of an angular position lane
// with ordinary derivative lanes. Position lanes (`j % order === 0`) are
// angular (shorter-arc blend / unwrap-extrapolate-rewrap); velocity /
// acceleration / jerk lanes are ordinary RATES (radians per unit time), blended
// and extrapolated linearly as usual. Carries BOTH the `trajectory` and
// `circular` tags. Byte-identical to the plain trajectory array of the same
// (n, order).

/** Options for the circular trajectory constructors: the trajectory options
 *  plus a `period` (default 2π) for the angular position lanes. */
export interface CircularTrajectoryArrayOptions extends TrajectoryArrayOptions {
  /** Period of the angular position lanes. Default `2π`. Must be finite > 0. */
  readonly period?: number;
}

function circularTrajectoryArray<T>(
  kind: "f64" | "f32",
  n: number,
  opts: CircularTrajectoryArrayOptions,
): FieldSpec<T> {
  const period = resolvePeriod(opts.period, `${kind}CircularTrajectoryArray`);
  const base = trajectoryArray<T>(kind, n, opts);
  return Object.freeze({
    kind: base.kind,
    length: base.length,
    byteSize: base.byteSize,
    trajectory: base.trajectory,
    circular: Object.freeze({ period }),
  }) as FieldSpec<T>;
}

export const f64CircularTrajectoryArray = (
  n: number,
  opts: CircularTrajectoryArrayOptions,
): FieldSpec<Float64Array> => circularTrajectoryArray<Float64Array>("f64", n, opts);

export const f32CircularTrajectoryArray = (
  n: number,
  opts: CircularTrajectoryArrayOptions,
): FieldSpec<Float32Array> => circularTrajectoryArray<Float32Array>("f32", n, opts);

// ─── Schema container + inference ──────────────────────────────────────────

export type FieldsObject = Record<string, FieldSpec<unknown>>;

/** Compiled per-field layout consumed by Bridge — internal but exposed for tests. */
export interface CompiledField {
  readonly name: string;
  readonly kind: FieldKind;
  /** Flat element count. 1 for scalar, ≥1 for array. For trajectory fields
   *  this is `sampleCount * order` — the codec walks the flat stream. */
  readonly length: number;
  readonly isArray: boolean;
  /** Byte offset within a single frame (not within the SAB). */
  readonly byteOffset: number;
  /** Present iff this field was built via `f{32,64}TrajectoryArray`.
   *  Descriptive only — does not affect SAB byte layout. */
  readonly trajectory?: TrajectorySpec;
  /** Present iff this field was built via a circular constructor (0.9.935).
   *  Descriptive only — does not affect SAB byte layout. */
  readonly circular?: CircularSpec;
}

export interface CompiledLayout {
  readonly frameByteSize: number;
  readonly typesPresent: ReadonlyArray<FieldKind>;
  readonly fields: ReadonlyArray<CompiledField>;
  /** Byte offset of the hidden `__invariant: f64` field within a frame, or
   *  null if the schema has no invariant attached. When non-null the
   *  bridge writes the f64 invariant here on push and reads/verifies on
   *  pull. Always 8-aligned. */
  readonly invariantByteOffset: number | null;
}

/** Caller-supplied invariant function. Receives a user-shaped frame object
 *  (no `__invariant` field exposed) and returns a finite f64 scalar that the
 *  bridge stores per-frame for verification on pull. Must be O(payload size),
 *  allocation-free, and pure. */
export type InvariantFn<F extends FieldsObject> = (
  frame: { -readonly [K in keyof F]: F[K] extends FieldSpec<infer T> ? T : never },
) => number;

/** Optional second argument to `.withInvariant(fn, opts?)` (0.6.6).
 *
 *  `absoluteEpsilon` (default `1e-12`) is the lower floor on the OK band used
 *  by Bridge's invariant classifier. The OK band is
 *  `max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`; relative error
 *  stays primary for non-trivial `stored`, the absolute floor catches
 *  subnormal-zero and near-zero rounding noise that the original pure-ratio
 *  check misclassified as hard. Must be a finite non-negative number; 0 is
 *  permitted and reproduces the pre-0.6.6 strict-ratio behavior. */
export interface WithInvariantOptions {
  readonly absoluteEpsilon?: number;
}

/** Default for `WithInvariantOptions.absoluteEpsilon` (0.6.6). Below `2^-40 ≈ 9e-13`
 *  most f64 sums are dominated by rounding noise, so 1e-12 is the smallest
 *  band that's still useful as a "treat as zero" floor for typical sum-of-
 *  squares invariants while staying conservative against real corruption. */
export const DEFAULT_INVARIANT_ABSOLUTE_EPSILON = 1e-12;

/** Type-erased invariant spec consumed by Bridge. */
export interface SchemaInvariantSpec {
  /** Type-erased invariant compute fn (Bridge passes Record<string, unknown>). */
  readonly compute: (frame: Record<string, unknown>) => number;
  /** Byte offset of the hidden `__invariant: f64` field within a frame. */
  readonly byteOffset: number;
  /** Absolute floor on the OK band — see `WithInvariantOptions.absoluteEpsilon`.
   *  Always finite and non-negative; defaults to
   *  `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` when the caller passed no opts. */
  readonly absoluteEpsilon: number;
}

// ─── Timestamp roles (0.6.5) ───────────────────────────────────────────────

/** Supported timestamp units. The Bridge converts to nanoseconds internally
 *  for PLL + per-sample dt math. `samples` is converted using the caller's
 *  per-call `sampleRate`. A future `{ unit: 'custom', toNs }` escape hatch
 *  is anticipated; until shipped, callers can multiply their value at the
 *  producer side and use 'ns'. */
export type TimestampUnit = "ns" | "us" | "ms" | "s" | "samples";

/** Per-role spec on `.withTimestamps({ roleName: { ... } })`. */
export interface TimestampRoleSpec<F extends FieldsObject = FieldsObject> {
  /** Name of the scalar numeric field that carries this timestamp. Must
   *  exist on the schema and not be an array. */
  readonly field: keyof F & string;
  /** Unit the producer stamps the field in. */
  readonly unit: TimestampUnit;
  /** Set on exactly one role to mark it as the default for
   *  `pullEvaluatedLatest` when the caller omits `{ timestamp }`.
   *  At most one role may set this. If none does, the first declared role
   *  becomes the default. */
  readonly default?: true;
}

/** The shape `.withTimestamps(...)` accepts: a record of role name → spec. */
export type TimestampsConfig<F extends FieldsObject> =
  Record<string, TimestampRoleSpec<F>>;

/** Type-erased, runtime-shaped timestamps spec consumed by Bridge. */
export interface SchemaTimestampsSpec {
  /** Map of role name → resolved role descriptor. `isBigInt` flags whether
   *  the field is u64/i64 (Bridge reads via Number(frame[name]) coercion
   *  for those). `byteOffset` and `kind` are useful for worklet-side
   *  inliners reading SchemaLayoutDescription. */
  readonly roles: Readonly<Record<string, {
    readonly field: string;
    readonly unit: TimestampUnit;
    readonly kind: FieldKind;
    readonly byteOffset: number;
    readonly isBigInt: boolean;
  }>>;
  /** Name of the default role (always one of the keys in `roles`). */
  readonly defaultRole: string;
}

/** Type-level helper: extracts the role-name union from a Schema's second
 *  generic argument. Used by Bridge.ts to type the `{ timestamp }` option
 *  on `pullEvaluatedLatest`. */
export type TimestampRoleOf<S> = S extends Schema<infer _F, infer T>
  ? T extends Record<string, TimestampRoleSpec<infer _G>>
    ? Extract<keyof T, string>
    : never
  : never;

export interface Schema<
  F extends FieldsObject = FieldsObject,
  // Second generic carries the timestamps config so role names are
  // compile-time visible at call sites. Defaults to null (no timestamps);
  // backwards-compatible with all pre-0.6.5 Schema<F> usage.
  T extends TimestampsConfig<F> | null = null,
> {
  readonly fields: F;
  readonly frameByteSize: number;
  readonly compiled: CompiledLayout;
  readonly _brand: "wab/Schema";
  /** Attached invariant spec, or null if none. */
  readonly invariant: SchemaInvariantSpec | null;
  /** Attached timestamps spec, or null if none. Compile-time role-name
   *  information lives on the `T` generic; this runtime view is the
   *  type-erased structure Bridge reads. */
  readonly timestamps: SchemaTimestampsSpec | null;
  /** Builder: returns a new Schema with the invariant attached. The frame
   *  byte size grows by 8 to accommodate the hidden `__invariant: f64`
   *  field; the f64 type-family is added to `compiled.typesPresent` if not
   *  already present. Optional `opts.absoluteEpsilon` (0.6.6, default `1e-12`)
   *  sets the lower floor on the classifier's OK band — see
   *  `WithInvariantOptions`. */
  withInvariant(
    fn: InvariantFn<F>,
    opts?: WithInvariantOptions,
  ): Schema<F, T>;
  /** Builder: returns a new Schema with one or more named timestamp roles
   *  attached. Validates each role's `field` exists on the schema and is a
   *  scalar numeric kind. At most one role may carry `default: true`; if
   *  none does, the first declared role is the default. Does NOT change
   *  the frame byte layout — timestamps are descriptive metadata on
   *  existing fields. See file header "Timestamp roles" for the rules. */
  withTimestamps<U extends TimestampsConfig<F>>(config: U): Schema<F, U>;
}

/** Map a Schema to the frame object shape used by Bridge push/pull.
 *  Does NOT include the hidden `__invariant` field — that's bridge-managed
 *  and never exposed to user-side reads/writes. The `any` on the second
 *  generic lets this match schemas with or without `.withTimestamps(...)`
 *  attached (the timestamps spec doesn't change frame shape). */
export type FrameFor<S> = S extends Schema<infer F, any>
  ? { -readonly [K in keyof F]: F[K] extends FieldSpec<infer T> ? T : never }
  : never;

// ─── Layout description (postMessageable; consumed by worklet inliners) ────

export interface SchemaLayoutFieldDescription {
  readonly kind: FieldKind;
  readonly byteOffset: number;
  readonly length?: number;
  /** Present iff the field was declared as a trajectory. Carried over from
   *  the FieldSpec so worklet-side inliners can do the same (p, v, [a])
   *  interpretation as the main-thread Bridge. */
  readonly trajectory?: TrajectorySpec;
  /** Present iff the field was declared circular (0.9.935). Carried over so
   *  worklet-side inliners apply the same angular shorter-arc handling. */
  readonly circular?: CircularSpec;
}

export interface SchemaLayoutDescription {
  readonly headerBytes: 32;
  readonly frameByteSize: number;
  readonly fields: Readonly<Record<string, SchemaLayoutFieldDescription>>;
  /** Timestamps spec carried over from `Schema.timestamps` so worklet-side
   *  inliners that consume only `describeSchemaLayout` can resolve role
   *  names without re-importing the Schema object. Null when no
   *  `.withTimestamps(...)` was attached. (0.6.5) */
  readonly timestamps: SchemaTimestampsSpec | null;
  /** Byte offset of the hidden `__invariant: f64` lane within a frame slot,
   *  or null if the schema has no `.withInvariant(...)` attached. Exposed
   *  in the layout description (0.7.11) so worklet-side inliners — the
   *  WASM consumer in particular — can resolve the invariant offset from
   *  the postMessage-friendly `describeLayout()` JSON alone, without
   *  needing access to the `Schema` object. A WASM consumer pulls the
   *  stored f64 via `readF64(slotBase + invariantByteOffset)` BEFORE the
   *  release-store on `read_index`, then the Bridge's heap-side
   *  classifier compares it against `schema.invariant.compute(frame)`
   *  AFTER. See `src/Bridge.ts` "Schema invariants". Always 8-aligned
   *  when non-null. */
  readonly invariantByteOffset: number | null;
}

// ─── Validation + compile ──────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isFieldKind(x: unknown): x is FieldKind {
  return (
    x === "u64" || x === "i64" ||
    x === "u32" || x === "i32" ||
    x === "u16" || x === "i16" ||
    x === "u8"  || x === "i8"  ||
    x === "f64" || x === "f32"
  );
}

function compileLayout(
  fields: FieldsObject,
  options: { invariant: boolean },
): CompiledLayout {
  const names = Object.keys(fields);
  // Stable sort by alignment class descending: 8-byte first, then 4, then 2, then 1.
  // Within an alignment class preserve declared order. Dense packing within
  // class then guarantees every field's byteOffset is a multiple of its
  // element size — no SAB typed-array constructor will reject the alignment.
  const decl = names.map((name, i) => {
    const spec = fields[name]!;
    return { name, spec, declOrder: i, align: kindByteSize(spec.kind) };
  });
  decl.sort((a, b) => {
    if (a.align !== b.align) return b.align - a.align;
    return a.declOrder - b.declOrder;
  });

  const compiledFields: CompiledField[] = [];
  const typesPresentSet = new Set<FieldKind>();
  let offset = 0;
  for (const { name, spec } of decl) {
    const length = spec.length ?? 1;
    const isArray = spec.length !== undefined;
    const align = kindByteSize(spec.kind);
    if (offset % align !== 0) {
      throw new Error(
        `Schema: internal alignment error for field '${name}' (offset ${offset} not aligned to ${align})`,
      );
    }
    compiledFields.push(
      Object.freeze({
        name,
        kind: spec.kind,
        length,
        isArray,
        byteOffset: offset,
        ...(spec.trajectory ? { trajectory: spec.trajectory } : {}),
        ...(spec.circular ? { circular: spec.circular } : {}),
      }),
    );
    typesPresentSet.add(spec.kind);
    offset += spec.byteSize;
  }

  // Pad user-fields end up to 8 so the next slot starts 8-aligned (matches
  // the ring header which is also 32 = multiple of 8).
  const userEnd = (offset + 7) & ~7;

  if (!options.invariant) {
    return Object.freeze({
      frameByteSize: userEnd,
      typesPresent: Object.freeze([...typesPresentSet]) as ReadonlyArray<FieldKind>,
      fields: Object.freeze(compiledFields) as ReadonlyArray<CompiledField>,
      invariantByteOffset: null,
    });
  }

  // Append the hidden __invariant: f64 field at userEnd. userEnd is already
  // 8-aligned. Frame size grows by 8. f64 must be in typesPresent so the
  // Bridge has a Float64 umbrella view to read/write the lane through.
  typesPresentSet.add("f64");
  return Object.freeze({
    frameByteSize: userEnd + 8,
    typesPresent: Object.freeze([...typesPresentSet]) as ReadonlyArray<FieldKind>,
    fields: Object.freeze(compiledFields) as ReadonlyArray<CompiledField>,
    invariantByteOffset: userEnd,
  });
}

const VALID_TIMESTAMP_UNITS: ReadonlySet<TimestampUnit> = new Set<TimestampUnit>([
  "ns", "us", "ms", "s", "samples",
]);

/** Compile a user-supplied timestamps config into the type-erased runtime
 *  shape consumed by Bridge. Validates every role; throws on the first
 *  violation. See file header "Timestamp roles" for the rules. */
function compileTimestamps<F extends FieldsObject>(
  config: TimestampsConfig<F>,
  fields: F,
  compiled: CompiledLayout,
): SchemaTimestampsSpec {
  if (typeof config !== "object" || config === null) {
    throw new TypeError(
      "Schema.withTimestamps: argument must be a non-null object of role specs",
    );
  }
  const roleNames = Object.keys(config);
  if (roleNames.length === 0) {
    throw new Error("Schema.withTimestamps: must declare at least one role");
  }
  let defaultRole: string | null = null;
  const roles: Record<string, {
    field: string;
    unit: TimestampUnit;
    kind: FieldKind;
    byteOffset: number;
    isBigInt: boolean;
  }> = {};
  for (const role of roleNames) {
    if (!IDENT_RE.test(role)) {
      throw new Error(
        `Schema.withTimestamps: role name '${role}' is not a valid JS identifier`,
      );
    }
    const spec = config[role];
    if (!spec || typeof spec !== "object" || typeof spec.field !== "string") {
      throw new Error(
        `Schema.withTimestamps: role '${role}' must be { field, unit, default? }`,
      );
    }
    const fieldSpec = fields[spec.field];
    if (!fieldSpec) {
      throw new Error(
        `Schema.withTimestamps: role '${role}' references unknown field '${spec.field}'`,
      );
    }
    if (fieldSpec.length !== undefined) {
      throw new Error(
        `Schema.withTimestamps: role '${role}' references array field '${spec.field}'; timestamps must be scalar`,
      );
    }
    if (!VALID_TIMESTAMP_UNITS.has(spec.unit)) {
      throw new Error(
        `Schema.withTimestamps: role '${role}' has invalid unit '${String(spec.unit)}'; expected one of ${[...VALID_TIMESTAMP_UNITS].join(" / ")}`,
      );
    }
    if (spec.default !== undefined && spec.default !== true) {
      throw new Error(
        `Schema.withTimestamps: role '${role}' default flag must be omitted or === true`,
      );
    }
    if (spec.default === true) {
      if (defaultRole !== null) {
        throw new Error(
          `Schema.withTimestamps: roles '${defaultRole}' and '${role}' both set default:true; at most one may`,
        );
      }
      defaultRole = role;
    }
    const compiledField = compiled.fields.find((f) => f.name === spec.field);
    if (!compiledField) {
      // Defensive — should be unreachable since fields[spec.field] passed above.
      throw new Error(
        `Schema.withTimestamps: internal — field '${spec.field}' missing from compiled layout`,
      );
    }
    roles[role] = Object.freeze({
      field: spec.field,
      unit: spec.unit,
      kind: compiledField.kind,
      byteOffset: compiledField.byteOffset,
      isBigInt: kindTsType(compiledField.kind) === "bigint",
    });
  }
  if (defaultRole === null) {
    defaultRole = roleNames[0]!;  // first declared role wins per the contract
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    defaultRole,
  });
}

function makeSchema<F extends FieldsObject, T extends TimestampsConfig<F> | null>(
  fields: F,
  compiled: CompiledLayout,
  invariantFn: InvariantFn<F> | null,
  invariantAbsoluteEpsilon: number,
  timestamps: SchemaTimestampsSpec | null,
): Schema<F, T> {
  const invariant: SchemaInvariantSpec | null =
    invariantFn === null || compiled.invariantByteOffset === null
      ? null
      : Object.freeze({
          compute: invariantFn as unknown as (
            frame: Record<string, unknown>,
          ) => number,
          byteOffset: compiled.invariantByteOffset,
          absoluteEpsilon: invariantAbsoluteEpsilon,
        });
  return Object.freeze({
    fields,
    frameByteSize: compiled.frameByteSize,
    compiled,
    _brand: "wab/Schema" as const,
    invariant,
    timestamps,
    withInvariant(
      fn: InvariantFn<F>,
      opts?: WithInvariantOptions,
    ): Schema<F, T> {
      if (typeof fn !== "function") {
        throw new TypeError(
          "Schema.withInvariant: argument must be a function (frame → number)",
        );
      }
      let epsilon = DEFAULT_INVARIANT_ABSOLUTE_EPSILON;
      if (opts !== undefined) {
        if (typeof opts !== "object" || opts === null) {
          throw new TypeError(
            "Schema.withInvariant: opts must be an object or undefined",
          );
        }
        if (opts.absoluteEpsilon !== undefined) {
          const eps = opts.absoluteEpsilon;
          if (typeof eps !== "number" || !Number.isFinite(eps) || eps < 0) {
            throw new TypeError(
              `Schema.withInvariant: opts.absoluteEpsilon must be a finite non-negative number, got ${String(eps)}`,
            );
          }
          epsilon = eps;
        }
      }
      const newCompiled = compileLayout(fields, { invariant: true });
      // Re-resolve the timestamps spec against the new compiled layout so
      // role-field byteOffsets are accurate even if invariant changed
      // anything (today it appends the hidden lane and doesn't reorder
      // user fields, but a future repack would).
      const newTimestamps = timestamps === null
        ? null
        : compileTimestamps(
            // Reconstruct a config-shape view of the runtime spec so
            // validation runs against the new compiled layout.
            Object.fromEntries(
              Object.entries(timestamps.roles).map(([role, r]) => [
                role,
                {
                  field: r.field as keyof F & string,
                  unit: r.unit,
                  ...(role === timestamps.defaultRole ? { default: true as const } : {}),
                },
              ]),
            ) as TimestampsConfig<F>,
            fields,
            newCompiled,
          );
      return makeSchema<F, T>(fields, newCompiled, fn, epsilon, newTimestamps);
    },
    withTimestamps<U extends TimestampsConfig<F>>(config: U): Schema<F, U> {
      const spec = compileTimestamps(config, fields, compiled);
      return makeSchema<F, U>(
        fields,
        compiled,
        invariantFn,
        invariantAbsoluteEpsilon,
        spec,
      );
    },
  }) as Schema<F, T>;
}

export function defineSchema<F extends FieldsObject>(fields: F): Schema<F> {
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new Error("Schema: must declare at least one field");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Schema: duplicate field name '${name}'`);
    }
    seen.add(name);
    if (!IDENT_RE.test(name)) {
      throw new Error(
        `Schema: field name '${name}' is not a valid JS identifier`,
      );
    }
    const spec = fields[name];
    if (!spec || typeof spec !== "object" || !("kind" in spec)) {
      throw new Error(
        `Schema: field '${name}' is not a FieldSpec — use u64() / f64Array(n) / etc.`,
      );
    }
    if (!isFieldKind(spec.kind)) {
      throw new Error(
        `Schema: field '${name}' has unknown kind '${String(spec.kind)}'`,
      );
    }
    if (
      spec.length !== undefined &&
      (!Number.isInteger(spec.length) || spec.length <= 0)
    ) {
      throw new Error(
        `Schema: field '${name}' has invalid length ${spec.length}`,
      );
    }
  }

  const compiled = compileLayout(fields, { invariant: false });
  return makeSchema<F, null>(
    fields,
    compiled,
    null,
    DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
    null,
  );
}

/** Produce a postMessage-safe layout description for worklet inliners. */
export function describeSchemaLayout(
  schema: Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>,
): SchemaLayoutDescription {
  const fields: Record<string, SchemaLayoutFieldDescription> = {};
  for (const f of schema.compiled.fields) {
    const base: SchemaLayoutFieldDescription = f.isArray
      ? { kind: f.kind, byteOffset: f.byteOffset, length: f.length }
      : { kind: f.kind, byteOffset: f.byteOffset };
    const withTraj = f.trajectory ? { ...base, trajectory: f.trajectory } : base;
    fields[f.name] = f.circular ? { ...withTraj, circular: f.circular } : withTraj;
  }
  return Object.freeze({
    headerBytes: 32,
    frameByteSize: schema.frameByteSize,
    fields: Object.freeze(fields),
    timestamps: schema.timestamps,
    invariantByteOffset: schema.invariant !== null
      ? schema.invariant.byteOffset
      : null,
  });
}
