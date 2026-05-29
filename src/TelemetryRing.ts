/**
 * TelemetryRing — a fixed-size, allocation-free rolling history of telemetry
 * samples. Harvested from the website's `src/lib/universe/debug/telemetryRing.ts`
 * (the 60-second HUD trace), generalized off the modal-engine sample shape into
 * a `TelemetryRing<T>` for any sample type.
 *
 * The bridge already has `Bridge<S>.subscribeTelemetry((snap) => …)` — a
 * push-callback that fires a fresh `TelemetrySnapshot` per tick. What it lacks
 * is *history*: when a glitch feels timing-dependent, you want the last N ticks,
 * not just the current one. This ring is that history layer; it composes with
 * the existing subscription in one line:
 *
 *     const ring = new TelemetryRing<TelemetrySnapshot>({ capacity: 120 });
 *     const unsub = bridge.subscribeTelemetry((snap) => ring.push(snap));
 *     // …later, when something looks wrong:
 *     console.table(ring.export());   // oldest-first, last ≤120 ticks
 *
 * It is deliberately decoupled from `Bridge` (no import) so it works for ANY
 * telemetry stream — a worklet's `BenchTimer` reports, a producer's frame-rate
 * samples, application-level metrics — and is unit-testable in isolation.
 *
 * Allocation discipline: the backing array of slots is allocated once at
 * construction; `push` overwrites in place (O(1), zero allocation). The only
 * allocation is in `export()`, which builds a fresh oldest-first array on
 * demand — call it off the hot path (a diagnostic dump), never per tick.
 *
 * Clock: `push` stamps each sample with a monotonic millisecond timestamp from
 * `performance.now()` when available, falling back to a per-push counter when
 * no clock exists (Node without the perf hook). A caller that already has a
 * timestamp can pass it explicitly to `push(sample, t)`.
 */

/** One stored sample: the value plus the push-time timestamp (ms, or the push
 *  counter when no clock is available). */
export interface TelemetryRingSample<T> {
  /** `performance.now()` ms at push time, the caller-supplied `t`, or the push
   *  ordinal when no clock exists. Monotonic non-decreasing within a ring. */
  readonly t: number;
  /** The sample value as handed to `push`. Stored by reference — if the caller
   *  mutates the object after pushing, the ring sees the mutation. Pass frozen
   *  snapshots (as `subscribeTelemetry` already does) to avoid surprises. */
  readonly sample: T;
}

function resolveClock(): (() => number) | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === "function" ? () => perf.now!() : null;
}

export interface TelemetryRingOptions {
  /** Number of samples retained. Default 120 (= 60 s at a 2 Hz HUD cadence,
   *  the website's window). Must be a positive integer. */
  readonly capacity?: number;
  /** Override the clock (tests inject a deterministic one). Receives nothing,
   *  returns a monotonic millisecond value. */
  readonly clock?: () => number;
}

export class TelemetryRing<T> {
  /** Max samples retained. */
  readonly capacity: number;

  private readonly slots: Array<TelemetryRingSample<T> | null>;
  private readonly clock: (() => number) | null;
  private writeIdx = 0;      // next slot to overwrite
  private filled = 0;        // number of valid slots (≤ capacity)
  private pushCounter = 0;   // fallback timestamp when no clock

  constructor(opts: TelemetryRingOptions = {}) {
    const { capacity = 120, clock } = opts;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`TelemetryRing: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.slots = new Array<TelemetryRingSample<T> | null>(capacity).fill(null);
    this.clock = clock ?? resolveClock();
  }

  /** Number of samples currently retained (rises to `capacity`, then stays). */
  get size(): number {
    return this.filled;
  }

  /** True iff this runtime provided a monotonic clock (else timestamps are
   *  push ordinals). */
  get hasClock(): boolean {
    return this.clock !== null;
  }

  /**
   * Append a sample. O(1), allocation-free (overwrites the oldest slot once
   * full). `t` defaults to `performance.now()` (or the push ordinal when no
   * clock is available); pass it explicitly when you already have a timestamp
   * correlated to the sample.
   */
  push(sample: T, t?: number): void {
    const stamp = t !== undefined
      ? t
      : this.clock !== null ? this.clock() : this.pushCounter;
    this.pushCounter += 1;
    this.slots[this.writeIdx] = { t: stamp, sample };
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /**
   * Snapshot the retained samples, **oldest first**. Allocates a fresh array
   * (length = `size`); call off the hot path. Empty ring → empty array. The
   * returned samples are the stored objects (not deep-copied).
   */
  export(): Array<TelemetryRingSample<T>> {
    const out = new Array<TelemetryRingSample<T>>(this.filled);
    // When not yet full, valid samples are slots[0 .. filled-1] in order.
    // When full, the oldest is at writeIdx (the next-to-overwrite slot).
    const start = this.filled < this.capacity ? 0 : this.writeIdx;
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.slots[(start + i) % this.capacity]!;
    }
    return out;
  }

  /** Most recent sample, or `null` if the ring is empty. O(1), no allocation. */
  latest(): TelemetryRingSample<T> | null {
    if (this.filled === 0) return null;
    const idx = (this.writeIdx - 1 + this.capacity) % this.capacity;
    return this.slots[idx] ?? null;
  }

  /** Drop all retained samples (keeps capacity). The slots are nulled so
   *  retained sample objects become eligible for GC. */
  clear(): void {
    this.slots.fill(null);
    this.writeIdx = 0;
    this.filled = 0;
    this.pushCounter = 0;
  }
}
