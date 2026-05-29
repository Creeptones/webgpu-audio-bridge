/**
 * benchTimer — allocation-free per-quantum self-timing for an AudioWorklet
 * decode loop. Harvested from the website's modal-voice-bank worklet bench
 * (`../NewProject/website/public/worklets/modal-voice-bank.js`), generalized
 * to time any hot-path region rather than a modal DSP loop.
 *
 * The pattern: bracket the region you want to measure with `begin()` /
 * `end()` (both read `performance.now()` once — ~tens of ns), accumulate the
 * elapsed time, and every `reportEvery` quanta emit a rolling average back to
 * the host via the caller-supplied `post` callback. Off by default — flip
 * `enabled` from the host so the steady-state audio path pays nothing when no
 * one is watching.
 *
 * Why a class and not inline `performance.now()` math in the worklet: the
 * rolling-window bookkeeping (accumulator + count + windowed reset) is easy to
 * get subtly wrong (e.g. dividing total-since-load instead of total-in-window,
 * which hides a slow drift), and three separate consumers want it — the
 * decode-path comparator bench, the wasm-decode example HUD, and any future
 * worklet that wants a cheap "how long did my quantum take" readout. One
 * tested implementation, three call sites.
 *
 * Allocation discipline: after construction the hot path (`begin`/`end`)
 * allocates nothing. `flush()` builds one small report object on the window
 * boundary only (every `reportEvery` quanta), so the per-quantum amortized
 * allocation is one object per ~20 quanta when enabled, zero when disabled.
 *
 * Clock: uses `performance.now()` when available (it is, in an
 * `AudioWorkletGlobalScope` and in the main thread), falling back to a
 * monotonic counter that disables timing if no clock exists (Node without the
 * perf hook). The fallback never throws — a missing clock degrades to
 * "timing unavailable" (`avgUsPerQuantum: null`) rather than crashing the
 * audio thread.
 */

/** One rolling-window report emitted on the window boundary. The host
 *  typically forwards `avgUsPerQuantum` to a telemetry ring / HUD. */
export interface BenchReport {
  /** Always the string `"benchReport"` so a host `onmessage` switch can
   *  discriminate it from other worklet messages. */
  readonly type: "benchReport";
  /** Mean microseconds spent inside `begin`/`end` per quantum across the
   *  window just closed. `null` if no clock is available in this runtime. */
  readonly avgUsPerQuantum: number | null;
  /** Number of quanta the average was taken over (= `reportEvery`, except a
   *  short final window if `flush()` is called early). */
  readonly nQuanta: number;
  /** Peak single-quantum microseconds observed in the window. `null` when no
   *  clock is available. Surfaces the worst case the mean would otherwise
   *  hide — the number that actually predicts a glitch. */
  readonly worstUsPerQuantum: number | null;
}

/** Resolve a monotonic millisecond clock, or `null` if none exists. Reading
 *  it through a captured reference avoids a `typeof` branch on every call. */
function resolveClock(): (() => number) | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") {
    return () => perf.now!();
  }
  return null;
}

export interface BenchTimerOptions {
  /** Quanta per rolling window before a report is emitted. Default 20
   *  (~53 ms at 48 kHz / 128-frame quanta — matches the website's cadence:
   *  frequent enough to track, sparse enough to be free). Must be ≥ 1. */
  readonly reportEvery?: number;
  /** Start enabled. Default false — the host flips `enabled = true` when it
   *  wants measurements, so production paths pay nothing. */
  readonly enabled?: boolean;
  /** Sink for window-boundary reports. In a worklet, pass
   *  `(r) => this.port.postMessage(r)`. Omitted = reports are dropped (the
   *  rolling state still updates, useful if the host polls `lastReport`). */
  readonly post?: (report: BenchReport) => void;
}

export class BenchTimer {
  /** Flip from the host to start/stop timing. When false, `begin`/`end` are
   *  near-free (one boolean check) and no report is ever emitted. */
  enabled: boolean;

  private readonly clock: (() => number) | null;
  private readonly reportEvery: number;
  private readonly post: ((report: BenchReport) => void) | null;

  private startMs = 0;
  private accMs = 0;
  private worstMs = 0;
  private quanta = 0;
  /** Last report emitted (or built by `flush`). Lets a polling host read the
   *  latest average without wiring a `post` callback. `null` until the first
   *  window closes. */
  lastReport: BenchReport | null = null;

  constructor(opts: BenchTimerOptions = {}) {
    const { reportEvery = 20, enabled = false, post } = opts;
    if (!Number.isInteger(reportEvery) || reportEvery < 1) {
      throw new Error(
        `BenchTimer: reportEvery must be a positive integer, got ${reportEvery}`,
      );
    }
    this.reportEvery = reportEvery;
    this.enabled = enabled;
    this.post = post ?? null;
    this.clock = resolveClock();
  }

  /** True iff this runtime provided a usable monotonic clock. When false,
   *  timing is inert (`avgUsPerQuantum` reports come back `null`) but the
   *  quantum counter still advances so window cadence is preserved. */
  get hasClock(): boolean {
    return this.clock !== null;
  }

  /** Mark the start of the timed region. No-op when disabled or clockless. */
  begin(): void {
    if (!this.enabled || this.clock === null) return;
    this.startMs = this.clock();
  }

  /** Mark the end of the timed region and advance the window. Emits a report
   *  (via `post`) when the window fills. No-op when disabled. */
  end(): void {
    if (!this.enabled) return;
    if (this.clock !== null) {
      const dt = this.clock() - this.startMs;
      // Guard against a non-monotonic clock reading (clamp negatives to 0)
      // so one bad sample can't poison the accumulator with a huge negative.
      const safe = dt > 0 ? dt : 0;
      this.accMs += safe;
      if (safe > this.worstMs) this.worstMs = safe;
    }
    this.quanta += 1;
    if (this.quanta >= this.reportEvery) this.flush();
  }

  /** Close the current window early (e.g. on a mode switch), emitting a
   *  report for however many quanta have accumulated. Safe to call with zero
   *  accumulated quanta — it becomes a no-op (no empty report). Resets the
   *  rolling state regardless. */
  flush(): void {
    if (this.quanta === 0) return;
    const hasClock = this.clock !== null;
    const report: BenchReport = {
      type: "benchReport",
      avgUsPerQuantum: hasClock ? (this.accMs / this.quanta) * 1000 : null,
      nQuanta: this.quanta,
      worstUsPerQuantum: hasClock ? this.worstMs * 1000 : null,
    };
    this.lastReport = report;
    if (this.post !== null) this.post(report);
    this.accMs = 0;
    this.worstMs = 0;
    this.quanta = 0;
  }

  /** Discard the current window without emitting. Use when toggling
   *  `enabled` off so a stale partial window doesn't leak into the next
   *  measurement session. */
  reset(): void {
    this.accMs = 0;
    this.worstMs = 0;
    this.quanta = 0;
  }
}
