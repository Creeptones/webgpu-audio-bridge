/**
 * HotSwapConsumer<S> — two-bridge live hot-swap orchestration
 * (0.9.88 — Apollo Frontier 4, God-Node Stage 2).
 *
 * Stage 1 (`crossfadeWeight` / `crossfadeInto`, 0.9.87) shipped the click-free
 * seam math. This stage is the orchestration above it: hold the OLD bridge
 * (`a`, currently audible) and a NEW bridge (`b`, the incoming patch),
 * reconstruct both per quantum, and crossfade `a → b` over a configurable
 * window — driven by the AUDIO clock so the swap is sample-accurate and
 * click-free.
 *
 * Both bridges share one schema `S` here — this is the foundational slice:
 * a PARAMETER / same-schema EMITTER hot-swap. Cross-schema migration (field
 * add/remove/rename, default-seeding) is Stage 3's `migratePlan`.
 *
 * ─── The state machine ─────────────────────────────────────────────────────
 *
 *   idle      — no swap requested. `pullLatest` reconstructs only `a`; weight 0.
 *   priming   — swap armed, but `b` is not yet reconstructable. The window clock
 *               has NOT started; output stays exactly `a` (weight 0). `b`'s
 *               producer may still be filling its ring; Hermite needs two
 *               distinct frames before it interpolates (one before it can even
 *               hold a position).
 *   fading    — `b` is ready; the window clock is running. Weight sweeps 0 → 1
 *               across `windowSeconds` on the audio clock via the C^k schedule.
 *   complete  — weight reached 1. Output is exactly `b`; `a` is retired (no
 *               longer pulled). The caller can tear `a` down.
 *
 * ─── The one critical timing decision ──────────────────────────────────────
 *
 * The window clock anchors to **when `b` becomes ready**, NOT to when
 * `armSwap` was called. If it anchored to arm-time, the weight would advance
 * during priming while output was pinned to `a` (weight forced 0), then JUMP
 * from 0 to `w(s_now)` the instant `b` went ready — a click. By starting the
 * window at b-ready, the weight begins at exactly 0 with vanishing derivatives
 * (the Stage-1 C^k property), so the fade onset is seamless. The
 * `tmp-hotswap-probe` finding that drove this is pinned in the test.
 *
 * ─── Readiness ─────────────────────────────────────────────────────────────
 *
 * `b` is "ready" after `minBFramesForReady` fresh pulls (each call to
 * `b.pullHermiteLatest` that returns ≥ 0 — i.e. consumed a new frame). Default
 * 2 → `b` interpolates between two distinct frames on the very first faded
 * sample (the C² interior). Set 1 to start as soon as `b` can hold a single
 * frame's position (lower latency, but the first fade samples hold rather than
 * interpolate `b`).
 *
 * ─── Single responsibility ─────────────────────────────────────────────────
 *
 * This class owns the swap STATE MACHINE + dual reconstruction + the weight
 * SCHEDULE. It does NOT blend signals itself — the caller reads the two
 * reconstructed frames (`outA`, `outB`), synthesizes its per-sample audio from
 * each as usual, and blends with `crossfadeInto` (Stage 1) using
 * `weightAt(sampleConsumerNs)` per sample for a sample-accurate fade. Keeping
 * the blend at the caller means the class is agnostic to how the frame becomes
 * audio (direct trajectory field, partial-bank synthesis, filter drive, …) and
 * the amplitude-vs-equal-power choice stays a per-call decision.
 *
 *     const r = swap.pullLatest(outA, outB, baseNs);
 *     for (let i = 0; i < 128; i++) {
 *       const w = swap.weightAt(baseNs + i * nsPerSample);
 *       aBuf[i] = synth(outA, i);   // caller's synthesis from a's frame
 *       bBuf[i] = w === 0 ? 0 : synth(outB, i);
 *     }
 *     crossfadeInto(aBuf, bBuf, /* one w, or loop per-sample *​/ w, out, { mode });
 *
 * Heap-only after construction; `pullLatest` allocates nothing (it delegates to
 * each bridge's allocation-free `pullHermiteLatest`).
 */

import type { FieldsObject, FrameFor, Schema } from "./schema.js";
import type { Bridge } from "./Bridge.js";
import { crossfadeWeight, type CrossfadeContinuity } from "./crossfade.js";

/** Live phase of the swap state machine. */
export type HotSwapPhase = "idle" | "priming" | "fading" | "complete";

/** Construction options for `HotSwapConsumer`. */
export interface HotSwapConsumerOptions {
  /** Continuity order of the crossfade weight schedule (the C^k seam class).
   *  Default `"quintic"` (C²) — match it to your reconstruction order for a
   *  fully C^k swap. See `crossfadeWeight`. */
  continuity?: CrossfadeContinuity;
  /** Default fade-window duration (seconds) used when `armSwap()` is called
   *  with no argument. Default `0.05` (50 ms). */
  windowSeconds?: number;
  /** Fresh `b` pulls required before the fade starts. Default 2 (interpolation-
   *  ready). 1 = hold-ready (lower latency, holds `b`'s first frame at onset).
   *  Must be ≥ 1. */
  minBFramesForReady?: number;
}

/** Result of one `pullLatest` quantum. */
export interface HotSwapPullResult {
  /** Phase AFTER this quantum's state-machine advance. */
  phase: HotSwapPhase;
  /** Crossfade weight at the quantum's base time `baseConsumerNs` (0 idle/
   *  priming, 0→1 fading, 1 complete). For a sample-accurate fade use
   *  `weightAt(perSampleNs)` instead of this single value. */
  weight: number;
  /** Audio-clock time the fade window started (b-ready), or null if not yet. */
  windowStartNs: number | null;
  /** `a.pullHermiteLatest` return (frames skipped ≥ 0, or -1 empty/never). */
  aSkipped: number;
  /** `b.pullHermiteLatest` return, or -1 when `b` was not pulled this quantum
   *  (idle phase). */
  bSkipped: number;
  /** Whether `b` has reached readiness as of this quantum. */
  bReady: boolean;
}

export class HotSwapConsumer<S extends Schema<FieldsObject, any>> {
  private readonly a: Bridge<S>;
  private readonly b: Bridge<S>;
  private readonly weightFn: (s: number) => number;
  private readonly continuity: CrossfadeContinuity;
  private readonly defaultWindowSeconds: number;
  private readonly minBFramesForReady: number;

  private _phase: HotSwapPhase = "idle";
  private _windowNs = 0;
  private _windowStartNs: number | null = null;
  private _bFreshPulls = 0;

  /**
   * @param a  The OLD bridge — currently audible. Must carry a
   *           `.withTimestamps(...)` schema (Hermite reconstruction needs it).
   * @param b  The NEW bridge — the incoming patch. Same schema `S` and the
   *           same timestamp role as `a`.
   */
  constructor(a: Bridge<S>, b: Bridge<S>, opts?: HotSwapConsumerOptions) {
    this.a = a;
    this.b = b;
    this.continuity = opts?.continuity ?? "quintic";
    this.weightFn = crossfadeWeight(this.continuity);
    this.defaultWindowSeconds = opts?.windowSeconds ?? 0.05;
    const minB = opts?.minBFramesForReady ?? 2;
    if (!Number.isInteger(minB) || minB < 1) {
      throw new Error(
        `HotSwapConsumer: minBFramesForReady must be an integer ≥ 1, got ${minB}`,
      );
    }
    this.minBFramesForReady = minB;
  }

  /** Current phase of the state machine. */
  phase(): HotSwapPhase {
    return this._phase;
  }

  /** The configured continuity order of the weight schedule. */
  continuityOrder(): CrossfadeContinuity {
    return this.continuity;
  }

  /** Audio-clock time (ns) the fade window started (b-ready), or null. */
  windowStartNs(): number | null {
    return this._windowStartNs;
  }

  /**
   * Arm a swap from `a` to `b`. Transitions `idle → priming`. The fade window
   * does not start until `b` is ready (see the class header); until then output
   * stays exactly `a`. Throws if a swap is already in progress (`priming` /
   * `fading`) — call `reset()` first to re-arm. Re-arming after `complete` is
   * allowed (a no-op-ish: it simply re-enters priming, though `b` is already
   * primed so the window starts on the next pull).
   *
   * @param windowSeconds  Fade duration; defaults to the constructor's
   *                       `windowSeconds`. Must be finite and > 0.
   */
  armSwap(windowSeconds?: number): void {
    if (this._phase === "priming" || this._phase === "fading") {
      throw new Error(
        `HotSwapConsumer.armSwap: a swap is already in progress (${this._phase}); reset() before re-arming`,
      );
    }
    const w = windowSeconds ?? this.defaultWindowSeconds;
    if (!Number.isFinite(w) || w <= 0) {
      throw new Error(
        `HotSwapConsumer.armSwap: windowSeconds must be finite and > 0, got ${w}`,
      );
    }
    this._windowNs = w * 1e9;
    this._windowStartNs = null;
    this._phase = "priming";
    // Note: `_bFreshPulls` is NOT reset — if `b` was already primed by a prior
    // arm/complete cycle, it stays ready so the window can start immediately.
  }

  /**
   * Reset to `idle`. Clears the window and (optionally) the `b`-readiness
   * counter. Does not touch either bridge's internal pull state.
   *
   * @param forgetBReadiness  When true (default), the next `armSwap` re-primes
   *   `b` from scratch (counts fresh pulls again). Pass false to keep `b`
   *   considered primed across the reset.
   */
  reset(forgetBReadiness = true): void {
    this._phase = "idle";
    this._windowStartNs = null;
    this._windowNs = 0;
    if (forgetBReadiness) this._bFreshPulls = 0;
  }

  /** True once `b` has had ≥ `minBFramesForReady` fresh pulls. */
  isBReady(): boolean {
    return this._bFreshPulls >= this.minBFramesForReady;
  }

  /**
   * The crossfade weight for an absolute audio-clock time `consumerNs`. Pure —
   * does not advance the state machine (call it per sample inside a quantum for
   * a sample-accurate fade). Returns 0 before the window opens (idle/priming),
   * the C^k weight while fading, and 1 at/after the window end.
   */
  weightAt(consumerNs: number): number {
    if (this._windowStartNs === null) return 0;
    const s = (consumerNs - this._windowStartNs) / this._windowNs;
    if (s <= 0) return 0;
    if (s >= 1) return 1;
    return this.weightFn(s);
  }

  /**
   * Reconstruct both bridges for this quantum and advance the swap state
   * machine. Always pulls `a` (until `complete`, after which `a` is retired and
   * left untouched). Pulls `b` once armed. On the first quantum `b` is ready,
   * anchors the window to `baseConsumerNs` and enters `fading`; when the
   * quantum-base weight reaches 1, enters `complete`.
   *
   * @param outA  Evaluated-shape frame for `a` (from `a.scratchEvaluatedFrame()`).
   *              Left untouched once the swap is `complete`.
   * @param outB  Evaluated-shape frame for `b`. Untouched while `idle`.
   * @param baseConsumerNs  The quantum's audio-render time in ns (e.g.
   *              `currentTime * 1e9`). Drives both the PLLs and the swap clock.
   * @param sampleRate  Optional; forwarded to `pullHermiteLatest` (omit if both
   *              bridges have `setSampleRate`).
   */
  pullLatest(
    outA: FrameFor<S>,
    outB: FrameFor<S>,
    baseConsumerNs: number,
    sampleRate?: number,
  ): HotSwapPullResult {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `HotSwapConsumer.pullLatest: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }

    // `a` is reconstructed every quantum until retired at `complete`.
    let aSkipped = -1;
    if (this._phase !== "complete") {
      aSkipped = this.a.pullHermiteLatest(outA, baseConsumerNs, sampleRate);
    }

    // `b` is reconstructed once armed (priming / fading / complete).
    let bSkipped = -1;
    if (this._phase !== "idle") {
      bSkipped = this.b.pullHermiteLatest(outB, baseConsumerNs, sampleRate);
      if (bSkipped >= 0) this._bFreshPulls += 1;
    }

    // Open the window the first quantum `b` is ready (priming → fading),
    // anchoring the swap clock to NOW (not to arm-time).
    if (this._phase === "priming" && this.isBReady()) {
      this._windowStartNs = baseConsumerNs;
      this._phase = "fading";
    }

    // Advance / close the fade.
    let weight = 0;
    if (this._phase === "fading") {
      weight = this.weightAt(baseConsumerNs);
      if (weight >= 1) {
        weight = 1;
        this._phase = "complete";
      }
    } else if (this._phase === "complete") {
      weight = 1;
    }

    return {
      phase: this._phase,
      weight,
      windowStartNs: this._windowStartNs,
      aSkipped,
      bSkipped,
      bReady: this.isBReady(),
    };
  }
}
