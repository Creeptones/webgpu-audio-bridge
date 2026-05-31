/**
 * JitKernelSwap — the pure dual-kernel live-swap state machine
 * (0.9.914 — Apollo Frontier 5, The Autonomous JIT, Stage 1b).
 *
 * Stage 1a shipped the compiler: `compileKernel` proves a vectorized WASM kernel
 * bit-exact (f64) / within-ULP (f32) to its scalar reference and returns it as
 * `accepted`. This file is the FIRST half of the runtime that gets such a kernel
 * into the live audio thread without a click: the swap STATE MACHINE.
 *
 * It is the single-bridge, DUAL-KERNEL sibling of `HotSwapConsumer` (which is
 * dual-BRIDGE). There, two bridges reconstruct two frames and the fade blends
 * them; here, ONE data source feeds TWO kernels — the developer's permanent JS
 * fallback (A) and the JIT-compiled SIMD kernel (B) — and the fade blends their
 * two outputs. This class owns only the phase + the weight SCHEDULE; the actual
 * kernel calls + the blend live in `JitKernelConsumer` (so this half is pure
 * math, no WASM, no audio, no DOM — fully Node-testable, exactly like the
 * crossfade core).
 *
 * ─── Why the swap is a CROSSFADE, not a hard switch ─────────────────────────
 *
 * The Stage-1a stress soak measured the f32 SIMD deliverable bit-exact to its
 * scalar reference but diverging from the user's naive JS by up to ~2677 f32-ULP
 * near cancellation — because JS has no f32 arithmetic (it computes f32 kernels
 * with f64 intermediates and rounds only at the `Float32Array` store, whereas
 * the SIMD path rounds every intermediate). The absolute error is ~1 ULP of the
 * operand magnitude (inaudible), but a HARD switch from the JS kernel to the
 * SIMD kernel can step the signal and click on a cancelling waveform. A C^k
 * weight over a short window makes the seam C^k-continuous regardless of the ULP
 * gap. The two kernels are strongly correlated (they differ only by ULP), so the
 * consumer blends with `crossfade`'s AMPLITUDE law — the rare correct case where
 * a linear blend has no −3 dB power notch.
 *
 * ─── The state machine ─────────────────────────────────────────────────────
 *
 *   idle      — no swap armed. The consumer runs ONLY the current kernel (the JS
 *               fallback at first, or a previously-promoted SIMD kernel). Weight 0.
 *   priming   — a swap is armed (the SIMD kernel is compiled, gate-PASSED, and
 *               synchronously instantiated), but the window clock has NOT started.
 *               Output stays exactly the current kernel (weight 0). This phase is
 *               the sub-quantum gap between `armSwap()` (called in the worklet's
 *               `port.onmessage`, BETWEEN quanta — no reliable audio clock there)
 *               and the first `process()` quantum that supplies an audio-clock
 *               anchor.
 *   fading    — the window clock is running. Weight sweeps 0 → 1 across
 *               `windowSeconds` on the audio clock via the C^k schedule. The
 *               consumer runs BOTH kernels and amplitude-blends them per sample.
 *   complete  — weight reached 1. Output is exactly the new (SIMD) kernel; the
 *               old one is retired. (The JS fallback closure is never freed — it
 *               is retained forever as the safety net; only a superseded SIMD
 *               `Instance` is dropped.)
 *
 * ─── The one critical timing law (copied from `HotSwapConsumer`) ────────────
 *
 * The window clock anchors to the first `beginQuantum` AFTER `armSwap`, NOT to
 * the `armSwap` call itself. `armSwap` runs in `port.onmessage`, between audio
 * quanta, where `currentTime` is the PREVIOUS quantum's (stale) render time;
 * anchoring there would make the weight already > 0 at the first faded sample
 * and JUMP — a click. By anchoring at the first quantum, the weight begins at
 * exactly 0 with vanishing derivatives (the crossfade C^k property), so the fade
 * onset is seamless. This is the JIT analogue of HotSwap anchoring to b-ready
 * (not arm-time).
 *
 * @experimental — exported from `webgpu-audio-bridge/experimental`, NOT the 1.0
 * core. Mirrors the `compileKernel` surface it sits above.
 */

import { crossfadeWeight, type CrossfadeContinuity } from "../crossfade.js";

/** Live phase of the JIT kernel swap. */
export type JitSwapPhase = "idle" | "priming" | "fading" | "complete";

/** Construction options for `JitKernelSwap`. */
export interface JitKernelSwapOptions {
  /** Continuity order of the crossfade weight schedule (the C^k seam class).
   *  Default `"quintic"` (C²) — the recommended seam for the JS→SIMD swap. */
  continuity?: CrossfadeContinuity;
  /** Default fade-window duration (seconds) used when `armSwap()` is called with
   *  no argument. Default `0.01` (10 ms) — short, because the two kernels differ
   *  only by ULP (a long window buys nothing). Within the 5–20 ms design band. */
  windowSeconds?: number;
}

/** Result of advancing the state machine for one audio quantum. */
export interface JitSwapQuantum {
  /** Phase AFTER this quantum's advance. */
  readonly phase: JitSwapPhase;
  /** Crossfade weight at the quantum's base time (0 idle/priming, 0→1 fading,
   *  1 complete). For a sample-accurate fade use `weightAt(perSampleNs)` rather
   *  than this single per-quantum value. */
  readonly weight: number;
  /** Audio-clock time (ns) the fade window started, or null if not yet anchored. */
  readonly windowStartNs: number | null;
  /** True on the single quantum the fade transitions `fading → complete` (so the
   *  consumer can retire the old kernel exactly once). */
  readonly justCompleted: boolean;
}

export class JitKernelSwap {
  private readonly weightFn: (s: number) => number;
  private readonly continuity: CrossfadeContinuity;
  private readonly defaultWindowSeconds: number;

  private _phase: JitSwapPhase = "idle";
  private _windowNs = 0;
  private _windowStartNs: number | null = null;

  constructor(opts?: JitKernelSwapOptions) {
    this.continuity = opts?.continuity ?? "quintic";
    this.weightFn = crossfadeWeight(this.continuity);
    const w = opts?.windowSeconds ?? 0.01;
    if (!Number.isFinite(w) || w <= 0) {
      throw new Error(
        `JitKernelSwap: windowSeconds must be finite and > 0, got ${w}`,
      );
    }
    this.defaultWindowSeconds = w;
  }

  /** Current phase of the state machine. */
  phase(): JitSwapPhase {
    return this._phase;
  }

  /** The configured continuity order of the weight schedule. */
  continuityOrder(): CrossfadeContinuity {
    return this.continuity;
  }

  /** Audio-clock time (ns) the fade window started, or null if not anchored. */
  windowStartNs(): number | null {
    return this._windowStartNs;
  }

  /** True while a swap is armed but not yet complete (priming or fading). */
  isSwapping(): boolean {
    return this._phase === "priming" || this._phase === "fading";
  }

  /**
   * Arm a swap to the newly-installed kernel. Transitions `idle`/`complete` →
   * `priming`. The window does NOT start until the first `beginQuantum` (see the
   * class header — the timing law). Until then output stays exactly the current
   * kernel (weight 0). Re-arming while a swap is in progress (`priming`/`fading`)
   * throws — call `reset()` first (the consumer does this to replace an
   * in-flight incoming kernel). Re-arming after `complete` is allowed (the just-
   * promoted kernel becomes the new "current" and a fresh fade to the next
   * kernel begins).
   *
   * @param windowSeconds  Fade duration; defaults to the constructor's
   *                       `windowSeconds`. Must be finite and > 0.
   */
  armSwap(windowSeconds?: number): void {
    if (this._phase === "priming" || this._phase === "fading") {
      throw new Error(
        `JitKernelSwap.armSwap: a swap is already in progress (${this._phase}); reset() before re-arming`,
      );
    }
    const w = windowSeconds ?? this.defaultWindowSeconds;
    if (!Number.isFinite(w) || w <= 0) {
      throw new Error(
        `JitKernelSwap.armSwap: windowSeconds must be finite and > 0, got ${w}`,
      );
    }
    this._windowNs = w * 1e9;
    this._windowStartNs = null;
    this._phase = "priming";
  }

  /**
   * Reset to `idle`, clearing the window. Does not itself drop any kernel — the
   * consumer owns kernel lifetimes. Called to abort an in-flight fade (snap back
   * to the current kernel) or before re-arming a replacement.
   */
  reset(): void {
    this._phase = "idle";
    this._windowStartNs = null;
    this._windowNs = 0;
  }

  /**
   * The crossfade weight for an absolute audio-clock time `consumerNs`. PURE —
   * does not advance the state machine (call it per sample inside a quantum for a
   * sample-accurate fade). Returns 0 before the window opens (idle/priming), the
   * C^k weight while within the window, and 1 at/after the window end.
   */
  weightAt(consumerNs: number): number {
    if (this._windowStartNs === null) return 0;
    const s = (consumerNs - this._windowStartNs) / this._windowNs;
    if (s <= 0) return 0;
    if (s >= 1) return 1;
    return this.weightFn(s);
  }

  /**
   * Advance the state machine for one audio quantum at base time `baseConsumerNs`
   * (e.g. `currentTime * 1e9`). On the FIRST quantum after `armSwap` this anchors
   * the window to NOW (priming → fading), so the weight starts at exactly 0. When
   * the quantum-base weight reaches 1, transitions to `complete` and flags
   * `justCompleted` once. Idempotent thereafter (stays `complete`, weight 1).
   *
   * Call this ONCE per quantum, then call `weightAt(perSampleNs)` per sample for
   * the actual fade.
   */
  beginQuantum(baseConsumerNs: number): JitSwapQuantum {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `JitKernelSwap.beginQuantum: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }

    // Open the window on the first quantum after arm (priming → fading),
    // anchoring the swap clock to NOW — never to arm-time.
    if (this._phase === "priming") {
      this._windowStartNs = baseConsumerNs;
      this._phase = "fading";
    }

    let weight = 0;
    let justCompleted = false;
    if (this._phase === "fading") {
      weight = this.weightAt(baseConsumerNs);
      if (weight >= 1) {
        weight = 1;
        this._phase = "complete";
        justCompleted = true;
      }
    } else if (this._phase === "complete") {
      weight = 1;
    }

    return {
      phase: this._phase,
      weight,
      windowStartNs: this._windowStartNs,
      justCompleted,
    };
  }
}
