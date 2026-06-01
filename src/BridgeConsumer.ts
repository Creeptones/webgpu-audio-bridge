/**
 * BridgeConsumer<Schema> — additive consumer-side facade (0.6.10).
 *
 * 0.6.10 promotes the four heap state machines extracted in 0.6.8 / 0.6.9
 * (`SpscRing`, `FrameSmoother`, `ConsumerClockRecovery`,
 * `AdaptiveFlowController`) to the public composable API. `BridgeConsumer` is
 * the alternative consumer-side surface for users who want explicit control
 * over which primitives are composed and which invariant-recovery policy is
 * active — `Bridge<S>` continues to work unchanged and is still the
 * recommended monolithic entry point.
 *
 * Wire compatibility. Zero change. `BridgeConsumer` and `Bridge<S>` use the
 * identical SAB layout (the one `SpscRing<S>` owns), the identical
 * always-notify park/wake protocol, the identical Q16.16 flow-scale
 * encoding, and the identical f64 `__invariant` lane format. A consumer
 * built with either class can pull frames a producer built with either
 * class pushed.
 *
 * Behavior compatibility. With default options
 * (`onInvariantFailure: 'fallback-to-previous'`, default-constructed
 * `FrameSmoother` and `ConsumerClockRecovery`), `BridgeConsumer` is
 * bit-identical to `Bridge<S>` on the same SAB — same blend math, same
 * recovery dispatch, same PLL convergence. The `tests/BridgeFacades.test.ts`
 * symmetry pin enforces this against a `Bridge<S>` reference.
 *
 * Composition shape:
 *
 *     const ring = new SpscRing(sab, capacity, schema);
 *     const consumer = new BridgeConsumer(ring, {
 *       smoother: new FrameSmoother(schema, () => consumer.scratchFrame()),
 *       pll: new ConsumerClockRecovery(),
 *       onInvariantFailure: 'fallback-to-previous',
 *     });
 *
 * Or just:
 *
 *     const ring = new SpscRing(sab, capacity, schema);
 *     const consumer = new BridgeConsumer(ring);   // defaults match Bridge<S>
 *
 * Opt-out of a primitive by passing `null`:
 *
 *     new BridgeConsumer(ring, { smoother: null, pll: null });
 *
 * A null smoother makes `pullSmoothed` / `pullLatestSmoothed` throw — the
 * caller asked for an unsmoothed-only consumer. A null PLL makes
 * `observeConsumerTime` / `phaseLockedTime` / `resetPll` throw — the caller
 * asked for a clock-recovery-free consumer.
 *
 * Invariant-failure policy. `onInvariantFailure` controls only the HARD
 * branch (the soft / ok branches are protocol-defined). Default
 * `'fallback-to-previous'` mirrors `Bridge<S>` — copy the smoother's prev
 * frame into `out` if valid, otherwise let the corrupt payload through.
 * `'throw'` raises an Error from the pull call. `'pass-through'` skips the
 * fallback and lets the corrupt payload through unchanged. A function
 * `(out, computed, stored) => void` lets the user inspect / mutate `out`
 * however they want. In all four cases the ring's `tornFrameCount` lane is
 * incremented so the failure surfaces in telemetry.
 *
 * Lifetime. `BridgeConsumer` holds the ring and the two heap state machines
 * by reference — it does not allocate the SAB or own the schema. Multiple
 * BridgeConsumers over the same `SpscRing` are NOT supported (SPSC rules:
 * one consumer per ring).
 *
 * Telemetry (0.9.35). `telemetry()` returns the same `TelemetrySnapshot`
 * shape `Bridge<S>.telemetry()` returns — same field set, same types,
 * same semantics. Drift between the two implementations is gated by
 * `tests/BridgeFacades.test.ts`'s `facade-telemetry-symmetry` pin
 * (5/5 in the BridgeFacades suite). When the consumer was constructed
 * with `pll: null`, the four PLL fields + `stallRecoveries` report
 * `false` / `0` — matching `Bridge<S>`'s fresh-PLL output. The
 * heap-side `softFrames` counter (added in 0.9.35) ticks identically
 * to `Bridge._softFrames` on every soft-classified invariant
 * deviation, so dashboards reading `telemetry().softFrames` on a
 * `BridgeConsumer` see the same value they'd see on a `Bridge<S>`
 * over the same traffic.
 */

import {
  type FieldsObject,
  type FrameFor,
  type Schema,
} from "./schema.js";
import { SpscRing } from "./SpscRing.js";
import { FrameSmoother } from "./FrameSmoother.js";
import { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import {
  INVARIANT_OK_THRESHOLD,
  INVARIANT_SOFT_THRESHOLD,
  INVARIANT_SOFT_ALPHA_BASE,
  type SmoothedPullOptions,
  type TelemetrySnapshot,
} from "./Bridge.js";
import { buildScratchFrame } from "./_heap.js";

export type { SmoothedPullOptions };

// Schema-invariant recovery thresholds are imported from `./Bridge.js`
// as of 0.9.2 — single source of truth. Previously these were duplicated
// module-private constants, with the `BridgeFacades` symmetry test as
// the only drift backstop.

/** Callback variant of `onInvariantFailure`. The handler runs on the HARD
 *  branch AFTER the ring's `tornFrameCount` has been incremented; mutate
 *  `out` as needed (e.g. zero it, log it, raise telemetry). `computed` is
 *  the value the schema's invariant function produced from the just-pulled
 *  frame; `stored` is the value the producer wrote into the slot. */
export type InvariantFailureCallback = (
  out: Record<string, unknown>,
  computed: number,
  stored: number,
) => void;

/** Policy controlling the HARD branch of the invariant classifier. The OK
 *  and SOFT branches are protocol-defined and not configurable. */
export type InvariantFailurePolicy =
  | "fallback-to-previous"
  | "throw"
  | "pass-through"
  | InvariantFailureCallback;

export interface BridgeConsumerOptions<S extends Schema<FieldsObject, any>> {
  /** Heap-state α-smoother. Default: a fresh `FrameSmoother` wired to this
   *  consumer's `scratchFrame()` factory. Pass `null` to opt out — smoothed
   *  pulls then throw, raw pulls still work. */
  smoother?: FrameSmoother<S> | null;
  /** Heap-state PLL. Default: a fresh `ConsumerClockRecovery`. Pass `null`
   *  to opt out — PLL methods then throw. */
  pll?: ConsumerClockRecovery | null;
  /** Behavior on a HARD-classified invariant failure. Default
   *  `'fallback-to-previous'` matches `Bridge<S>`. See class header for the
   *  full policy table. */
  onInvariantFailure?: InvariantFailurePolicy;
}

export class BridgeConsumer<S extends Schema<FieldsObject, any>> {
  /** The composed ring. Multiple `BridgeConsumer` instances over the same
   *  ring are NOT supported (SPSC: one consumer per ring). */
  public readonly ring: SpscRing<S>;
  public readonly schema: S;
  public readonly capacity: number;
  /** The composed smoother, or `null` if the caller opted out. */
  public readonly smoother: FrameSmoother<S> | null;
  /** The composed PLL, or `null` if the caller opted out. */
  public readonly pll: ConsumerClockRecovery | null;

  private readonly onInvariantFailure: InvariantFailurePolicy;
  private readonly invariantAbsoluteEpsilon: number;

  /** Cumulative soft-classified invariant deviations that drove the
   *  α-smoother rather than the hard-fallback path. Heap-side; consumer-
   *  thread. Increments inside `_invariantHandleRaw` / `_invariantHandleSmoothed`
   *  on the soft branch. Mirrors `Bridge<S>._softFrames`. Exposed via
   *  `telemetry().softFrames`. (0.9.35) */
  private _softFrames: number = 0;

  constructor(ring: SpscRing<S>, opts: BridgeConsumerOptions<S> = {}) {
    this.ring = ring;
    this.schema = ring.schema;
    this.capacity = ring.capacity;

    // Smoother default: build one wired to this consumer's scratchFrame.
    // Explicit `null` opts out; `undefined` (omitted) takes the default.
    if (opts.smoother === null) {
      this.smoother = null;
    } else if (opts.smoother !== undefined) {
      this.smoother = opts.smoother;
    } else {
      this.smoother = new FrameSmoother<S>(ring.schema, () => this.scratchFrame());
    }

    if (opts.pll === null) {
      this.pll = null;
    } else if (opts.pll !== undefined) {
      this.pll = opts.pll;
    } else {
      this.pll = new ConsumerClockRecovery();
    }

    this.onInvariantFailure = opts.onInvariantFailure ?? "fallback-to-previous";
    this.invariantAbsoluteEpsilon = ring.schema.invariant !== null
      ? ring.schema.invariant.absoluteEpsilon
      : 0;
  }

  /** Allocate a reusable frame view. Array fields are pre-allocated heap-side
   *  typed arrays of the right kind and length; scalar fields are
   *  initialized to 0 / 0n. Use this once outside hot loops and reuse the
   *  returned object on every pull call. Mirror of `Bridge<S>.scratchFrame`. */
  scratchFrame(): FrameFor<S> {
    return buildScratchFrame(this.schema.compiled.fields) as FrameFor<S>;
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Returns false on empty. Identical semantics to
   * `Bridge<S>.pull` — under an invariant schema, runs the classifier and
   * dispatches OK / soft / hard onto the smoother (or the configured
   * failure policy).
   */
  pull(out: FrameFor<S>): boolean {
    const r = this.ring.pull(out);
    if (!r.ok) return false;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else if (this.smoother !== null) {
      this.smoother.reset();
    }
    return true;
  }

  /**
   * Drain to the newest available frame into `out`. Returns the number of
   * frames skipped, or -1 on empty. Identical semantics to
   * `Bridge<S>.pullLatest`.
   */
  pullLatest(out: FrameFor<S>): number {
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else if (this.smoother !== null) {
      this.smoother.reset();
    }
    return r.skipped;
  }

  /**
   * Consumer-side smoothed single-frame pull. Throws if the consumer was
   * built with `smoother: null`. See `Bridge<S>.pullSmoothed` for the full
   * blend contract.
   */
  pullSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    _opts?: SmoothedPullOptions,
  ): boolean {
    if (this.smoother === null) {
      throw new Error("BridgeConsumer.pullSmoothed: smoother was opted out (smoother: null)");
    }
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
   * Consumer-side smoothed drain-to-latest. Throws if the consumer was
   * built with `smoother: null`. See `Bridge<S>.pullLatestSmoothed` for the
   * full skip-policy contract.
   */
  pullLatestSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    opts?: SmoothedPullOptions,
  ): number {
    if (this.smoother === null) {
      throw new Error("BridgeConsumer.pullLatestSmoothed: smoother was opted out (smoother: null)");
    }
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    const skipped = r.skipped;
    let alphaEff: number;
    if (opts !== undefined && opts.skipPolicy === "catch-up") {
      alphaEff = 1 - Math.pow(1 - alphaBase, skipped + 1);
    } else {
      alphaEff = alphaBase * Math.pow(2, -skipped);
    }
    this._invariantHandleSmoothed(
      out as unknown as Record<string, unknown>,
      r.invariantStored,
      alphaEff,
    );
    return skipped;
  }

  /** Forget the consumer-side cached prev frame. No-op if `smoother: null`. */
  resetSmoother(): void {
    if (this.smoother !== null) this.smoother.reset();
  }

  /** PLL observation. Throws if the consumer was built with `pll: null`. */
  observeConsumerTime(consumerNs: number, producerNs: number): void {
    if (this.pll === null) {
      throw new Error("BridgeConsumer.observeConsumerTime: pll was opted out (pll: null)");
    }
    this.pll.observe(consumerNs, producerNs);
  }

  /** Map a consumer-clock reading to the producer-clock frame of reference.
   *  Throws if `pll: null`. */
  phaseLockedTime(consumerNs: number): number {
    if (this.pll === null) {
      throw new Error("BridgeConsumer.phaseLockedTime: pll was opted out (pll: null)");
    }
    return this.pll.phaseLockedTime(consumerNs);
  }

  /** Reset the PLL to the unlocked state. No-op if `pll: null`. */
  resetPll(): void {
    if (this.pll !== null) this.pll.reset();
  }

  /** Frames currently buffered in the ring. */
  available(): number {
    return this.ring.available();
  }

  /** Current consumer→producer flow_scale hint (Q16.16-decoded). */
  flowScaleHint(): number {
    return this.ring.flowScaleHint();
  }

  /** Hard-error invariant fallback count (read directly from lane 3). */
  tornFrameCount(): number {
    return this.ring.tornFrameCount();
  }

  /**
   * Point-in-time `TelemetrySnapshot` for this consumer (0.9.35). Mirrors
   * `Bridge<S>.telemetry()`'s field-for-field shape: ring state from the
   * composed `SpscRing`, PLL state from the composed `ConsumerClockRecovery`
   * (or zeros / `false` when the caller opted out with `pll: null`), and
   * heap-side counters (`softFrames`) tracked on this facade.
   *
   * The returned object is `Object.freeze`d and safe to retain — every
   * field is a primitive snapshot, no aliasing into mutable consumer
   * state. The `tests/BridgeFacades.test.ts` symmetry pin asserts that
   * a `BridgeConsumer<S>` and a `Bridge<S>` over the same SAB return
   * field-for-field identical snapshots when driven through the same
   * operations — that's the regression backstop for the
   * `BridgeConsumer.telemetry === Bridge.telemetry` invariant.
   *
   * When `pll: null` was passed at construction: `pllLocked: false`,
   * `pllOffsetNs: 0`, `pllOutliersRejected: 0`, `pllDriftPpm: 0`,
   * `stallRecoveries: 0`. Same shape `Bridge<S>` reports on a freshly-
   * constructed `ConsumerClockRecovery` before any `observeConsumerTime`
   * call lands.
   *
   * All reads are O(1) and use `Atomics.load` underneath — safe to call
   * from any thread. Under live producer / consumer activity the values
   * are individually consistent but not mutually atomic. For diagnostic /
   * dashboard use only.
   */
  telemetry(): TelemetrySnapshot {
    return Object.freeze({
      tornFrames: this.ring.tornFrameCount(),
      softFrames: this._softFrames,
      stallRecoveries: this.pll === null ? 0 : this.pll.stallRecoveries,
      // 0.9.935 — angular monodromy counter; 0 when the smoother is opted out.
      cycleSlips: this.smoother === null ? 0 : this.smoother.cycleSlips,
      flowScale: this.ring.flowScaleHint(),
      available: this.ring.available(),
      capacity: this.capacity,
      writeIndex: this.ring.writeIndexUnsigned(),
      readIndex: this.ring.readIndexUnsigned(),
      pllLocked: this.pll === null ? false : this.pll.locked,
      pllOffsetNs: this.pll === null ? 0 : this.pll.offsetNs,
      pllOutliersRejected: this.pll === null ? 0 : this.pll.outliersRejected,
      pllDriftPpm: this.pll === null ? 0 : this.pll.driftPpm,
      policy: this.ring.policy,
      droppedFrames: this.ring.droppedCount(),
      pushedFrames: this.ring.pushedCount(),
      pulledFrames: this.ring.pulledCount(),
      skippedFrames: this.ring.skippedCount(),
      lastFullWaitNs: this.ring.lastFullWaitNanos(),
      lastEmptyWaitNs: this.ring.lastEmptyWaitNanos(),
      maxOccupancyEverSeen: this.ring.maxOccupancy(),
    });
  }

  // ── Invariant classifier + dispatch (mirrors Bridge<S>) ──────────────────

  private _classifyInvariant(
    computed: number,
    stored: number,
  ): { kind: "ok" | "soft" | "hard"; alpha: number } {
    if (!Number.isFinite(computed) || !Number.isFinite(stored)) {
      return { kind: "hard", alpha: 0 };
    }
    const absErr = Math.abs(computed - stored);
    if (absErr === 0) return { kind: "ok", alpha: 1 };
    const eps = this.invariantAbsoluteEpsilon;
    const absStored = Math.abs(stored);
    const okBand = eps > INVARIANT_OK_THRESHOLD * absStored
      ? eps
      : INVARIANT_OK_THRESHOLD * absStored;
    if (absErr < okBand) return { kind: "ok", alpha: 1 };
    if (stored === 0) {
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

  private _invariantHandleRaw(
    out: Record<string, unknown>,
    invariantStored: number,
  ): void {
    const inv = this.schema.invariant;
    if (inv === null) return;
    const computed = inv.compute(out);
    const { kind, alpha } = this._classifyInvariant(computed, invariantStored);
    if (kind === "ok") {
      if (this.smoother !== null) this.smoother.seedFrom(out);
    } else if (kind === "soft") {
      // 0.9.35: count the soft branch (parity with Bridge<S>._softFrames).
      // Exposed via telemetry().softFrames so a Bridge Inspector visualises
      // soft "ride-over" events distinctly from hard fallbacks
      // (telemetry().tornFrames).
      this._softFrames = (this._softFrames + 1) | 0;
      if (this.smoother !== null) this.smoother.observe(out, alpha);
    } else {
      this.ring.incrementTornFrameCount();
      this._invokeHardPolicy(out, computed, invariantStored);
    }
  }

  private _invariantHandleSmoothed(
    out: Record<string, unknown>,
    invariantStored: number,
    alpha: number,
  ): void {
    const smoother = this.smoother!; // guarded at the public-method seam
    if (this.schema.invariant === null) {
      smoother.observe(out, alpha);
      return;
    }
    const computed = this.schema.invariant.compute(out);
    const { kind } = this._classifyInvariant(computed, invariantStored);
    if (kind === "hard") {
      this.ring.incrementTornFrameCount();
      this._invokeHardPolicy(out, computed, invariantStored);
      return;
    }
    if (kind === "soft") {
      // 0.9.35: count the soft branch on the smoothed path too, matching
      // Bridge<S>'s unified counter across raw + smoothed pulls.
      this._softFrames = (this._softFrames + 1) | 0;
    }
    smoother.observe(out, alpha);
  }

  private _invokeHardPolicy(
    out: Record<string, unknown>,
    computed: number,
    stored: number,
  ): void {
    const policy = this.onInvariantFailure;
    if (typeof policy === "function") {
      policy(out, computed, stored);
      return;
    }
    switch (policy) {
      case "fallback-to-previous":
        if (this.smoother !== null) this.smoother.fallbackInto(out);
        // null smoother → no prev to fall back to; pass corrupt through.
        return;
      case "throw":
        throw new Error(
          `BridgeConsumer: invariant hard-error (computed=${computed}, stored=${stored})`,
        );
      case "pass-through":
        return;
    }
  }
}
