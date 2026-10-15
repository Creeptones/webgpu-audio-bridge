/**
 * Shared `TelemetrySnapshot` builder (0.9.951) for `Bridge<S>.telemetry()` and
 * the composable `BridgeConsumer<S>.telemetry()`.
 *
 * The two methods used to build the same 22-field frozen literal by hand —
 * `tests/BridgeFacades.test.ts`'s field-for-field symmetry pin was the only
 * thing keeping them in sync. One builder makes drift structurally impossible.
 * Field semantics are documented on `TelemetrySnapshot` (src/Bridge.ts):
 *
 *   - every field except `tornFrames` is per-instance heap state (two peers
 *     over one SAB each see their own counters);
 *   - the PLL fields come from the heap-side `ConsumerClockRecovery` (for
 *     cross-process PLL state use `readPublishedPllState()`);
 *   - a facade that opted out of the PLL / smoother (`null`) reports
 *     `false` / `0` for those fields.
 *
 * Allocates one frozen object per call — `telemetry()` is a documented
 * allocating observability helper, not a per-quantum path.
 */

import type { TelemetrySnapshot } from "./Bridge.js";
import type { SpscRing } from "./SpscRing.js";
import type { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import type { FrameSmoother } from "./FrameSmoother.js";
import type { FieldsObject, Schema } from "./schema.js";

export function buildTelemetrySnapshot<S extends Schema<FieldsObject, any>>(
  ring: SpscRing<S>,
  softFrames: number,
  pll: ConsumerClockRecovery | null,
  smoother: FrameSmoother<S> | null,
): TelemetrySnapshot {
  return Object.freeze({
    tornFrames: ring.tornFrameCount(),
    softFrames,
    stallRecoveries: pll === null ? 0 : pll.stallRecoveries,
    cycleSlips: smoother === null ? 0 : smoother.cycleSlips,
    flowScale: ring.flowScaleHint(),
    available: ring.available(),
    capacity: ring.capacity,
    writeIndex: ring.writeIndexUnsigned(),
    readIndex: ring.readIndexUnsigned(),
    pllLocked: pll === null ? false : pll.locked,
    pllOffsetNs: pll === null ? 0 : pll.offsetNs,
    pllOutliersRejected: pll === null ? 0 : pll.outliersRejected,
    pllDriftPpm: pll === null ? 0 : pll.driftPpm,
    policy: ring.policy,
    droppedFrames: ring.droppedCount(),
    pushedFrames: ring.pushedCount(),
    pulledFrames: ring.pulledCount(),
    skippedFrames: ring.skippedCount(),
    lastFullWaitNs: ring.lastFullWaitNanos(),
    lastEmptyWaitNs: ring.lastEmptyWaitNanos(),
    maxOccupancyEverSeen: ring.maxOccupancy(),
  });
}
