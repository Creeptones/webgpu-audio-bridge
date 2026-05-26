/**
 * FrameSmoother<Schema> — extracted α-smoother heap state machine (0.6.9).
 *
 * This file is **internal-only** as of 0.6.9. It is not exported from
 * `src/index.ts`; only `Bridge.ts` consumes it. The 0.6.10 patch will widen
 * the surface and promote `FrameSmoother` (alongside `SpscRing` /
 * `ConsumerClockRecovery` / `AdaptiveFlowController`) to the public
 * composable API. This patch is a seam-only step — every public Bridge<S>
 * method continues to work bit-identically and no exported symbol is added.
 *
 * What lives here vs. what lives on Bridge:
 *
 *   FrameSmoother  (this file):
 *     - The unified consumer-side `prev` frame buffer + valid flag (used by
 *       both `pullSmoothed`/`pullLatestSmoothed` and the schema-invariant
 *       hard-error recovery path under `.withInvariant` schemas — same buffer
 *       in both roles, per the 0.6.0 unification).
 *     - The trajectory-aware one-pole blend (`observe(out, alpha)`): blends
 *       position lanes per the standard `out_i ← α·curr_i + (1−α)·prev_i`
 *       rule; copies derivative lanes (velocity, acceleration) verbatim from
 *       curr; passes BigInt-typed fields through verbatim; blends integer-
 *       typed numeric fields in float then `Math.round` back. See 0.6.4 for
 *       the trajectory-aware fix and Bridge.ts file header "Smoothed pulls"
 *       for the rationale.
 *     - Precomputed per-field classification tables: `scalarIsBigInt`,
 *       `scalarIsInteger`, `arrayIsBigInt`, `arrayIsInteger`,
 *       `arrayTrajectoryOrder`. Built at construction in scalar/array layout
 *       order so the blend loops are a tight indexed walk.
 *     - The explicit `seedFrom(src)` (used by the schema-invariant
 *       ok-branch) and `fallbackInto(out)` (used by the hard-error branch)
 *       helpers. Both touch only the heap-side prev buffer.
 *
 *   Bridge<S>  (./Bridge.ts):
 *     - The invariant classifier (`_classifyInvariant` + epsilon floor) and
 *       the `ok` / `soft` / `hard` dispatch. The classifier decides which of
 *       `seedFrom` / `observe` / `fallbackInto` to call on FrameSmoother; the
 *       smoother itself does not know about invariants.
 *     - The `pull*` methods that orchestrate the ring read + (optional)
 *       invariant dispatch + smoother call.
 *
 * The smoother is allocation-free in steady state. It lazily allocates the
 * `prev` buffer on the first `seedFrom` / `observe` / `fallbackInto` call
 * that needs it (via the `allocateFrame` factory supplied at construction —
 * typically `bridge.scratchFrame.bind(bridge)`). Subsequent calls reuse the
 * same buffer.
 *
 * Lifecycle of the `prev` buffer:
 *   - Raw pull (no invariant): valid → false on every raw pull. Buffer
 *     retained for the next smoothed call to re-seed without allocation.
 *   - Raw pull (with invariant): on ok, out is copied into prev (valid=true).
 *     On soft error, observe() runs (prev gets the blended output). On hard
 *     error, prev → out via fallbackInto, valid unchanged.
 *   - Smoothed pull: observe() runs every time, prev = blended output. On
 *     invariant hard error, prev → out via fallbackInto, valid unchanged.
 *
 * See Bridge.ts file headers "Smoothed pulls" + "Schema invariants" for the
 * full caller-side contract.
 */

import {
  kindTsType,
  type CompiledField,
  type FieldsObject,
  type FrameFor,
  type Schema,
} from "./schema.js";

/** Frame view used internally — opaque to the smoother (only walks fields). */
type FrameRecord = Record<string, unknown>;

/**
 * FrameSmoother<S> — internal α-smoother prev buffer + blender for Bridge<S>
 * (0.6.9 extract). Internal as of 0.6.9 — not exported from index.ts.
 */
export class FrameSmoother<S extends Schema<FieldsObject, any>> {
  /** Compiled scalar fields, in declared order — indexes match the
   *  classification tables below. */
  private readonly scalarLayout: ReadonlyArray<CompiledField>;
  /** Compiled array fields, in declared order — indexes match the
   *  classification tables below. */
  private readonly arrayLayout: ReadonlyArray<CompiledField>;

  /** Per-scalar-field classification. Precomputed at construction:
   *    `isBigInt` ⇒ verbatim pass-through (BigInt-typed kinds u64 / i64).
   *    `isInteger` ⇒ blend in float then `Math.round` back to integer
   *                  (numeric integer kinds u8…u32 / i8…i32).
   *    neither    ⇒ float-domain blend (f32 / f64). */
  private readonly scalarIsBigInt: ReadonlyArray<boolean>;
  private readonly scalarIsInteger: ReadonlyArray<boolean>;
  /** Per-array-field classification — same semantics as the scalar variants. */
  private readonly arrayIsBigInt: ReadonlyArray<boolean>;
  private readonly arrayIsInteger: ReadonlyArray<boolean>;
  /** Per-array-field trajectory order. 0 for non-trajectory arrays and
   *  order=1 trajectories (both blend every element identically). 2 / 3 for
   *  higher-order trajectories: blend only position lanes (every Nth element
   *  starting at 0) and copy derivative lanes (velocity, acceleration)
   *  verbatim from curr. The compiled `arrayTrajectoryOrder` table drives
   *  the dispatch — no per-call branch on field metadata. See Bridge.ts
   *  file header "Smoothed pulls" for the rationale. */
  private readonly arrayTrajectoryOrder: ReadonlyArray<number>;

  /** Factory for the lazily-allocated `prev` buffer. Typically
   *  `bridge.scratchFrame.bind(bridge)` so the smoother and the rest of the
   *  bridge use a single allocation path; the smoother itself does not
   *  duplicate scratchFrame logic. */
  private readonly allocateFrame: () => FrameFor<S>;

  /** The cached prev frame — null until the first call that needs it. Once
   *  allocated, the buffer is reused for the lifetime of the smoother. */
  private prev: FrameFor<S> | null = null;
  private prevValid: boolean = false;

  constructor(schema: S, allocateFrame: () => FrameFor<S>) {
    this.allocateFrame = allocateFrame;

    // Split compiled fields into scalars and arrays, preserve declared order.
    // Same partition the inner SpscRing maintains for its own hot path; this
    // is an independent mirror so the blend loops don't reach across the seam.
    const scalars: CompiledField[] = [];
    const arrays: CompiledField[] = [];
    for (const f of schema.compiled.fields) {
      if (f.isArray) arrays.push(f);
      else scalars.push(f);
    }
    this.scalarLayout = Object.freeze(scalars);
    this.arrayLayout = Object.freeze(arrays);

    // Precompute classification flags. f64 / f32 ⇒ float-domain blend;
    // integer-typed numeric kinds ⇒ blend in float then Math.round;
    // BigInt kinds (u64 / i64) ⇒ skip blending, pass through verbatim.
    this.scalarIsBigInt = Object.freeze(
      scalars.map((f) => kindTsType(f.kind) === "bigint"),
    );
    this.scalarIsInteger = Object.freeze(
      scalars.map((f) => f.kind !== "f64" && f.kind !== "f32" && kindTsType(f.kind) !== "bigint"),
    );
    this.arrayIsBigInt = Object.freeze(
      arrays.map((f) => kindTsType(f.kind) === "bigint"),
    );
    this.arrayIsInteger = Object.freeze(
      arrays.map((f) => f.kind !== "f64" && f.kind !== "f32" && kindTsType(f.kind) !== "bigint"),
    );
    // Trajectory order per array field. 0 means "blend every element" —
    // used for non-trajectory arrays and for order=1 trajectories
    // (positions only, byte-identical to a plain array). ≥2 selects the
    // strided-blend path in `observe` so velocity / acceleration lanes
    // pass through verbatim.
    this.arrayTrajectoryOrder = Object.freeze(
      arrays.map((f) => {
        const order = f.trajectory?.order ?? 0;
        return order >= 2 ? order : 0;
      }),
    );
  }

  /** True iff the prev buffer holds a valid blend / seed reference. */
  currentPrevValid(): boolean {
    return this.prevValid;
  }

  /**
   * Apply the one-pole blend in-place on `out` and update prev.
   *
   * On the first call (or the first call after `reset()` / a raw-pull
   * invalidation), there is no prev — `out` is left untouched (raw fresh
   * frame), copied into prev verbatim, and `prevValid` flips true. On
   * subsequent calls the blend runs:
   *
   *   out_i ← α · curr_i + (1 − α) · prev_i
   *
   * Field-type rules:
   *   - BigInt scalars / arrays: pass through verbatim (no meaningful blend
   *     on monotonic counters / timestamps); prev synced to curr.
   *   - Integer-typed numeric scalars / arrays: blend in float, then
   *     `Math.round` back to integer.
   *   - Float scalars / arrays (f32 / f64): float-domain blend.
   *   - Trajectory arrays of order ≥ 2: blend ONLY position lanes
   *     (`j % order === 0`); copy derivative lanes verbatim from curr.
   *     See Bridge.ts file header "Smoothed pulls" for the rationale.
   *
   * Memory: never touches the SAB — the smoother runs after the inner
   * SpscRing's release-store on read_index, on heap state only. The slot
   * is released back to the producer as early as possible.
   */
  observe(out: FrameRecord, alpha: number): void {
    if (!this.prevValid) {
      // First call (or first after invalidation): no blend, just seed prev
      // with the current fresh frame. Allocate prev if needed.
      if (this.prev === null) {
        this.prev = this.allocateFrame();
      }
      this._copyFrameInto(out, this.prev as unknown as FrameRecord);
      this.prevValid = true;
      return;
    }
    const prev = this.prev as unknown as FrameRecord;
    const oneMinusAlpha = 1 - alpha;
    // Scalars.
    const sl = this.scalarLayout;
    const sbi = this.scalarIsBigInt;
    const sii = this.scalarIsInteger;
    for (let i = 0; i < sl.length; i++) {
      const name = sl[i]!.name;
      if (sbi[i]) {
        // BigInt — verbatim pass-through. `out` already holds curr; sync prev.
        prev[name] = out[name];
      } else {
        const curr = out[name] as number;
        const p = prev[name] as number;
        let blended = alpha * curr + oneMinusAlpha * p;
        if (sii[i]) blended = Math.round(blended);
        out[name] = blended;
        prev[name] = blended;
      }
    }
    // Arrays.
    const al = this.arrayLayout;
    const abi = this.arrayIsBigInt;
    const aii = this.arrayIsInteger;
    const ato = this.arrayTrajectoryOrder;
    for (let i = 0; i < al.length; i++) {
      const name = al[i]!.name;
      if (abi[i]) {
        const currArr = out[name] as { set(s: ArrayLike<bigint>): void } & ArrayLike<bigint>;
        const prevArr = prev[name] as { set(s: ArrayLike<bigint>): void };
        prevArr.set(currArr);
      } else {
        const cA = out[name] as { length: number; [j: number]: number };
        const pA = prev[name] as { length: number; [j: number]: number };
        const isInt = aii[i];
        const L = cA.length;
        const order = ato[i]!;
        if (order === 0) {
          // Plain array (or order=1 trajectory): blend every element.
          for (let j = 0; j < L; j++) {
            let b = alpha * cA[j]! + oneMinusAlpha * pA[j]!;
            if (isInt) b = Math.round(b);
            cA[j] = b;
            pA[j] = b;
          }
        } else {
          // Trajectory order=2 or order=3. Layout is interleaved:
          //   order=2 → [p, v, p, v, ...]; order=3 → [p, v, a, p, v, a, ...].
          // Blend positions (`j % order === 0`) and copy derivative slots
          // verbatim from curr. Velocity and acceleration are snapshots of
          // the producer's instantaneous state — time-averaging them across
          // frames corrupts the very signal the trajectory ships to preserve.
          for (let j = 0; j < L; j++) {
            if ((j % order) === 0) {
              let b = alpha * cA[j]! + oneMinusAlpha * pA[j]!;
              if (isInt) b = Math.round(b);
              cA[j] = b;
              pA[j] = b;
            } else {
              // Derivative slot: out already holds curr; sync prev to match.
              pA[j] = cA[j]!;
            }
          }
        }
      }
    }
  }

  /**
   * Explicit seed of prev from `src`. Used by the invariant ok-branch on raw
   * pulls (the just-pulled frame's integrity is verified, so it becomes the
   * new last-known-good for the next hard-error fallback). Allocates the
   * prev buffer on demand via the factory passed at construction.
   */
  seedFrom(src: FrameRecord): void {
    if (this.prev === null) this.prev = this.allocateFrame();
    this._copyFrameInto(src, this.prev as unknown as FrameRecord);
    this.prevValid = true;
  }

  /**
   * Hard-error fallback. If prev is valid, copy it into `out` (replacing the
   * caller's corrupt-but-just-pulled bytes with the last-known-good frame)
   * and return true. If prev is not yet valid (first pull ever was a hard
   * error), leave `out` untouched and return false — caller passes the raw
   * payload through. In both cases `prevValid` is unchanged: a corrupt
   * payload never seeds prev.
   */
  fallbackInto(out: FrameRecord): boolean {
    if (!this.prevValid || this.prev === null) return false;
    this._copyFrameInto(this.prev as unknown as FrameRecord, out);
    return true;
  }

  /**
   * Invalidate prev (preserves the buffer for re-seeding without
   * allocation). Next `observe` / `seedFrom` behaves as a first-call.
   */
  reset(): void {
    this.prevValid = false;
  }

  /** Copy `src` into `dst` field-by-field. Scalars are plain assigns;
   *  arrays use typed-array `.set()` so length / element-kind validation
   *  happens at the runtime layer (`dst` is always a freshly-allocated
   *  frame from `allocateFrame()`). */
  private _copyFrameInto(src: FrameRecord, dst: FrameRecord): void {
    for (const f of this.scalarLayout) {
      dst[f.name] = src[f.name];
    }
    for (const f of this.arrayLayout) {
      (dst[f.name] as { set: (s: ArrayLike<number> | ArrayLike<bigint>) => void }).set(
        src[f.name] as ArrayLike<number> | ArrayLike<bigint>,
      );
    }
  }
}
