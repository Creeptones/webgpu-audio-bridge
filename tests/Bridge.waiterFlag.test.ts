/**
 * Bridge — waiter-flag (conditional) notify mode (0.9.70, experimental).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.waiterFlag.test.ts
 *
 * Covers the guarded, opt-in `notify: 'waiter-flag'` protocol scaffolded in
 * 0.9.70. The abstract correctness (race-freedom of release-then-check-flag,
 * and the lost-wake hazard of the naive ordering) is modeled+proven in
 * tests/Bridge.interleaving.test.ts pins 11-13; this file pins the concrete
 * SpscRing/Bridge implementation:
 *
 *  W1. testDefaultModeWireIdentical — `notify: 'always'` (and the no-option
 *      default) produce a byte-identical SAB size AND identical header +
 *      payload bytes vs each other; waiter-flag adds exactly 8 tail bytes.
 *      This is the wire-safety guarantee (the whole reason the flags live at
 *      the tail).
 *  W2. testNotifyModeGetter — `notifyMode()` reflects the constructed mode on
 *      both Bridge and the inner ring; unknown values throw at construction.
 *  W3. testSkipNotifyWhenNoWaiter — in waiter-flag mode a push with no parked
 *      consumer (WAITING_FOR_DATA == 0) issues NO `Atomics.notify`; flipping
 *      the tail flag to 1 makes the next push notify. Always mode always
 *      notifies. (Spies the global `Atomics.notify`.)
 *  W4. testWaitForDataFlagLifecycle — `waitForData` sets WAITING_FOR_DATA
 *      BEFORE the `Atomics.wait` compare-and-park and clears it in `finally`.
 *      (Spies `Atomics.wait` to capture the flag value at park time without
 *      actually blocking — the single-thread witness of the StoreLoad
 *      ordering the design relies on.)
 *  W5. testWaitForSpaceFlagLifecycle — mirror of W4 for the producer side
 *      (WAITING_FOR_SPACE, ring filled to capacity first).
 *
 * The strongest real-machine proof — a parked cross-thread peer is actually
 * woken under waiter-flag mode — lives in tests/Bridge.concurrent.test.ts,
 * which now runs its 1 M-frame SPSC stress in BOTH notify modes.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge, RING_HEADER_BYTES } from "../src/Bridge.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";
import { emptyPhysFrame, makePhysFrame } from "./_bridgeHelpers.js";

const N = 8;
const CAPACITY = 16;
const SCHEMA = physicsControlFrameSchema(N);

/** Int32 view over the two tail flag lanes of a waiter-flag SAB.
 *  [0] = WAITING_FOR_DATA, [1] = WAITING_FOR_SPACE. */
function tailFlags(sab: SharedArrayBuffer): Int32Array {
  const tailByteOffset = RING_HEADER_BYTES + CAPACITY * SCHEMA.frameByteSize;
  return new Int32Array(sab, tailByteOffset, 2);
}

// ─── W1 ───────────────────────────────────────────────────────────────────
function testDefaultModeWireIdentical(): void {
  const base = Bridge.byteLength(CAPACITY, SCHEMA);
  const always = Bridge.byteLength(CAPACITY, SCHEMA, { notify: "always" });
  const waiter = Bridge.byteLength(CAPACITY, SCHEMA, { notify: "waiter-flag" });

  assertEq(always, base, "notify:'always' byteLength === no-option byteLength");
  assertEq(
    waiter,
    base + 8,
    "notify:'waiter-flag' byteLength === default + 8 tail bytes",
  );

  // Allocate both via the opts-aware allocator and confirm SAB sizes.
  const allocDefault = Bridge.allocate(CAPACITY, SCHEMA);
  const allocWaiter = Bridge.allocate(CAPACITY, SCHEMA, { notify: "waiter-flag" });
  assertEq(allocDefault.sab.byteLength, base, "default SAB byteLength");
  assertEq(allocWaiter.sab.byteLength, base + 8, "waiter-flag SAB byteLength");

  // Header + payload bytes must be identical after the same single push in
  // both modes — the tail flags are the ONLY layout difference.
  const bDefault = new Bridge(allocDefault.sab, CAPACITY, SCHEMA);
  const bWaiter = new Bridge(allocWaiter.sab, CAPACITY, SCHEMA, {
    notify: "waiter-flag",
  });
  const frame = makePhysFrame(42, N);
  assert(bDefault.push(frame), "default push ok");
  assert(bWaiter.push(makePhysFrame(42, N)), "waiter-flag push ok");

  const u8Default = new Uint8Array(allocDefault.sab);
  const u8Waiter = new Uint8Array(allocWaiter.sab, 0, base);
  for (let i = 0; i < base; i++) {
    if (u8Default[i] !== u8Waiter[i]) {
      throw new Error(
        `header+payload byte ${i} differs between modes: ` +
          `default=${u8Default[i]} waiter-flag=${u8Waiter[i]}`,
      );
    }
  }
  ok("W1 default-mode wire-identical (header+payload bytes match; +8 tail only)");
}

// ─── W2 ───────────────────────────────────────────────────────────────────
function testNotifyModeGetter(): void {
  const bDefault = new Bridge(
    new SharedArrayBuffer(Bridge.byteLength(CAPACITY, SCHEMA)),
    CAPACITY,
    SCHEMA,
  );
  assertEq(bDefault.notifyMode(), "always", "default notifyMode() === 'always'");

  const alloc = Bridge.allocate(CAPACITY, SCHEMA, { notify: "waiter-flag" });
  const bWaiter = new Bridge(alloc.sab, CAPACITY, SCHEMA, {
    notify: "waiter-flag",
  });
  assertEq(
    bWaiter.notifyMode(),
    "waiter-flag",
    "waiter-flag notifyMode() === 'waiter-flag'",
  );

  let threw = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Bridge(
      new SharedArrayBuffer(Bridge.byteLength(CAPACITY, SCHEMA)),
      CAPACITY,
      SCHEMA,
      { notify: "nonsense" as any },
    );
  } catch {
    threw = true;
  }
  assert(threw, "unknown notify mode throws at construction");
  ok("W2 notifyMode() getter + construction-time validation");
}

// ─── W3 ───────────────────────────────────────────────────────────────────
function testSkipNotifyWhenNoWaiter(): void {
  const realNotify = Atomics.notify;
  let notifyCalls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Atomics as any).notify = (...args: any[]) => {
    notifyCalls++;
    return (realNotify as any).apply(Atomics, args);
  };
  try {
    // Waiter-flag mode, no parked consumer → push must NOT notify.
    const alloc = Bridge.allocate(CAPACITY, SCHEMA, { notify: "waiter-flag" });
    const ring = new Bridge(alloc.sab, CAPACITY, SCHEMA, {
      notify: "waiter-flag",
    });
    const flags = tailFlags(alloc.sab);

    notifyCalls = 0;
    assert(ring.push(makePhysFrame(0, N)), "waiter push #1 ok");
    assertEq(notifyCalls, 0, "no notify when WAITING_FOR_DATA == 0");

    // Simulate a parked consumer by raising the flag → next push notifies.
    Atomics.store(flags, 0, 1);
    notifyCalls = 0;
    assert(ring.push(makePhysFrame(1, N)), "waiter push #2 ok");
    assertEq(notifyCalls, 1, "exactly one notify when WAITING_FOR_DATA == 1");
    Atomics.store(flags, 0, 0);

    // Always mode → every push notifies regardless of any flag.
    const aAlloc = Bridge.allocate(CAPACITY, SCHEMA);
    const aRing = new Bridge(aAlloc.sab, CAPACITY, SCHEMA);
    notifyCalls = 0;
    assert(aRing.push(makePhysFrame(0, N)), "always push ok");
    assertEq(notifyCalls, 1, "always mode notifies unconditionally");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Atomics as any).notify = realNotify;
  }
  ok("W3 skip-notify-when-no-waiter (conditional gate reads the tail flag)");
}

// ─── W4 ───────────────────────────────────────────────────────────────────
function testWaitForDataFlagLifecycle(): void {
  const alloc = Bridge.allocate(CAPACITY, SCHEMA, { notify: "waiter-flag" });
  const ring = new Bridge(alloc.sab, CAPACITY, SCHEMA, { notify: "waiter-flag" });
  const flags = tailFlags(alloc.sab);

  const realWait = Atomics.wait;
  let flagAtPark = -1;
  // Spy: capture WAITING_FOR_DATA at the moment Atomics.wait is entered, then
  // return without actually blocking. This is the single-thread witness that
  // the flag store precedes the wait's compare-and-park (program order).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Atomics as any).wait = () => {
    flagAtPark = Atomics.load(flags, 0);
    return "timed-out";
  };
  try {
    assertEq(flags[0], 0, "WAITING_FOR_DATA starts cleared");
    const status = ring.waitForData(1);
    assertEq(status, "timed-out", "waitForData returns the (spied) wait status");
    assertEq(flagAtPark, 1, "WAITING_FOR_DATA == 1 at park time (set before wait)");
    assertEq(flags[0], 0, "WAITING_FOR_DATA cleared in finally after wait");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Atomics as any).wait = realWait;
  }
  ok("W4 waitForData flag lifecycle (set-before-park, clear-in-finally)");
}

// ─── W5 ───────────────────────────────────────────────────────────────────
function testWaitForSpaceFlagLifecycle(): void {
  const alloc = Bridge.allocate(CAPACITY, SCHEMA, { notify: "waiter-flag" });
  const ring = new Bridge(alloc.sab, CAPACITY, SCHEMA, { notify: "waiter-flag" });
  const flags = tailFlags(alloc.sab);

  // Fill the ring so waitForSpace actually reaches the park path.
  for (let i = 0; i < CAPACITY; i++) {
    assert(ring.push(makePhysFrame(i, N)), `fill push ${i} ok`);
  }
  assertEq(ring.available(), CAPACITY, "ring full before waitForSpace");

  const realWait = Atomics.wait;
  let flagAtPark = -1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Atomics as any).wait = () => {
    flagAtPark = Atomics.load(flags, 1);
    return "timed-out";
  };
  try {
    assertEq(flags[1], 0, "WAITING_FOR_SPACE starts cleared");
    const status = ring.waitForSpace(1);
    assertEq(status, "timed-out", "waitForSpace returns the (spied) wait status");
    assertEq(flagAtPark, 1, "WAITING_FOR_SPACE == 1 at park time (set before wait)");
    assertEq(flags[1], 0, "WAITING_FOR_SPACE cleared in finally after wait");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Atomics as any).wait = realWait;
  }
  // Sanity: a non-full ring returns 'not-equal' without touching the flag.
  const out = emptyPhysFrame(N);
  ring.pull(out);
  assertEq(
    ring.waitForSpace(1),
    "not-equal",
    "waitForSpace returns 'not-equal' immediately when space exists",
  );
  assertEq(flags[1], 0, "WAITING_FOR_SPACE stays 0 on the not-equal fast path");
  ok("W5 waitForSpace flag lifecycle (set-before-park, clear-in-finally)");
}

function main(): void {
  testDefaultModeWireIdentical();
  testNotifyModeGetter();
  testSkipNotifyWhenNoWaiter();
  testWaitForDataFlagLifecycle();
  testWaitForSpaceFlagLifecycle();
  console.log("\nAll Bridge.waiterFlag tests passed.");
}

main();
