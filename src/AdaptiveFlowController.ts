/**
 * AdaptiveFlowController — extracted flow-scale PI controller (0.6.9).
 *
 * This file is **internal-only** as of 0.6.9. It is not exported from
 * `src/index.ts`; only `SpscRing.ts` consumes it. The 0.6.10 patch will
 * widen the surface and promote `AdaptiveFlowController` (alongside
 * `SpscRing` / `FrameSmoother` / `ConsumerClockRecovery`) to the public
 * composable API. This patch is a seam-only step — every public Bridge<S>
 * method continues to work bit-identically and the SAB lane layout / Q16.16
 * encoding are unchanged.
 *
 * What it does. Encapsulates the CFL-style PI controller from 0.5.0 that
 * SpscRing previously inlined as `_updateFlowScale`. The ring still writes
 * the Q16.16-encoded result into lane 2 (`flow_scale`) — this class owns
 * only the heap-side controller state (the integral term) and the math;
 * it never touches the SAB.
 *
 * Math. With `err = occupancy − 0.5`, controller state `integral += err`
 * (clamped to ±`INT_LIMIT` for anti-windup), and gains `Kp = 0.5`,
 * `Ki = 0.05`:
 *
 *     scale = clamp(1 − Kp·err − Ki·integral, 0.5, 2.0)
 *
 * Sign: positive `err` (consumer is overfull) gives `scale < 1` (producer
 * should slow down); negative `err` (consumer is starved) gives `scale > 1`
 * (producer should speed up). The integrator removes steady-state offset.
 *
 * API. `tick(buffered, capacity) → Q16.16-encoded scale`. Caller passes
 * the pre-pull buffered-frame count and the ring capacity; the controller
 * computes `occupancy = buffered / capacity` internally and returns the
 * encoded value the caller stores into lane 2. SpscRing's `_updateFlowScale`
 * is now a two-line bridge: `tick(...)` + `Atomics.store(...)`.
 *
 * Q16.16: `encoded = floor(scale * 65536)`. Range [0.5, 2.0] maps to
 * [32768, 131072], all within positive signed-32 → `Atomics.load` on an
 * `Int32Array` returns the stored value bit-for-bit. `floor` (not `round`)
 * preserves the boundary semantics documented in `flowScaleHint()`.
 *
 * Where it runs. SpscRing calls `tick(...)` inline from `pull` /
 * `pullLatest` AFTER the release-store on read_index but only on the
 * successful path (an empty-pull early-return does NOT update the
 * controller; its "occupancy = 0" reading would misleadingly say "producer
 * too slow" when in fact the consumer hasn't actually consumed). The
 * `_updateFlowScale` method on SpscRing remains the test-hook seam (driven
 * from `Bridge._updateFlowScale` for `tests/Bridge.test.ts#testFlowScalePI*`).
 *
 * See SpscRing.ts file header "Adaptive backpressure" for the contract
 * shape and the producer-side honor semantics; this class only owns the
 * controller, not the lane.
 */

// Q16.16 fixed-point + range constants.
const FLOW_SCALE_Q = 65536;
const FLOW_SCALE_MIN = 0.5;
const FLOW_SCALE_MAX = 2.0;

// PI gains. See file header for the derivation.
const FLOW_SCALE_KP = 0.5;
const FLOW_SCALE_KI = 0.05;
// Anti-windup: cap |integral| so Ki·integral alone covers the full half-
// extent of scale's range (1.0). Past this, the integrator would saturate
// the output and recovery from a long stall would be unable to back off.
const FLOW_SCALE_INT_LIMIT = 20; // = 1.0 / FLOW_SCALE_KI

/**
 * AdaptiveFlowController — flow-scale PI controller for SpscRing's lane 2.
 * Internal as of 0.6.9 — not exported from index.ts.
 */
export class AdaptiveFlowController {
  /** PI controller integral state. Persists across `tick` calls; clamped to
   *  ±`INT_LIMIT` for anti-windup. */
  private integral: number = 0;

  /** Q16.16 quantum (1.0 → 65536). */
  static readonly Q = FLOW_SCALE_Q;
  /** Q16.16-encoded default scale (1.0). Used by SpscRing to seed lane 2
   *  on construction so a producer reading `flowScaleHint()` before any
   *  pull sees "no scaling." */
  static readonly DEFAULT_Q = FLOW_SCALE_Q;
  /** Clamp lower bound in real units. */
  static readonly MIN = FLOW_SCALE_MIN;
  /** Clamp upper bound in real units. */
  static readonly MAX = FLOW_SCALE_MAX;
  /** Proportional gain. */
  static readonly KP = FLOW_SCALE_KP;
  /** Integral gain. */
  static readonly KI = FLOW_SCALE_KI;
  /** Anti-windup bound on |integral|. */
  static readonly INT_LIMIT = FLOW_SCALE_INT_LIMIT;

  /**
   * Run one PI cycle and return the Q16.16-encoded scale. Caller passes
   * the pre-pull `buffered` frame count (= `(writeIdx − readIdx) | 0`) and
   * the ring `capacity`. Returns an Int32-storable integer in
   * [`MIN · Q`, `MAX · Q`] = [32768, 131072] that the caller writes into
   * `flow_scale` via `Atomics.store`.
   *
   * Cost: ~6 arithmetic ops + 4 compares. Allocation-free.
   */
  tick(buffered: number, capacity: number): number {
    const occupancy = buffered / capacity;
    const err = occupancy - 0.5;
    let integral = this.integral + err;
    // Anti-windup: bound the integrator so a long stall can't trap the
    // controller in permanent over-correction.
    if (integral > FLOW_SCALE_INT_LIMIT) integral = FLOW_SCALE_INT_LIMIT;
    else if (integral < -FLOW_SCALE_INT_LIMIT) integral = -FLOW_SCALE_INT_LIMIT;
    this.integral = integral;
    // Sign: err > 0 (consumer overfull) → scale < 1 (producer slow down);
    // err < 0 (consumer starved) → scale > 1 (producer speed up).
    let scale = 1 - FLOW_SCALE_KP * err - FLOW_SCALE_KI * integral;
    if (scale < FLOW_SCALE_MIN) scale = FLOW_SCALE_MIN;
    else if (scale > FLOW_SCALE_MAX) scale = FLOW_SCALE_MAX;
    // Q16.16 encode. floor not round — preserves the boundary semantics
    // documented in flowScaleHint().
    return Math.floor(scale * FLOW_SCALE_Q);
  }

  /**
   * Reset the integrator to zero. The next `tick` runs with a fresh
   * controller state.
   */
  reset(): void {
    this.integral = 0;
  }

  /** Current integral term. Exposed for tests / observability. */
  get integralState(): number {
    return this.integral;
  }
}
