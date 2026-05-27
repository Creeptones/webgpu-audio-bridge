/**
 * Bridge backpressure — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * Policy reject / drop-newest / drop-oldest / block fast-path / block timeout, drop-oldest CAS-commit pull bit-exact, drop-oldest pullLatest skipped accounting.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.backpressure.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  64. testBackpressurePolicyReject
 *  65. testBackpressurePolicyDropNewest
 *  66. testBackpressurePolicyDropOldest
 *  67. testBackpressurePolicyBlockFastPath
 *  68. testBackpressurePolicyBlockTimeout
 *  82. testDropOldestPullBitExactVsReject
 *  83. testDropOldestPullLatestSkippedAccounting
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  emptyPhysFrame,
  framesEqual,
  makePhysFrame,
} from "./_bridgeHelpers.js";
import { Bridge } from "../src/Bridge.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";


// ── 64. Backpressure policy 'reject' preserves 0.6.11 behavior (0.6.12) ──
function testBackpressurePolicyReject(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(8, schema);
  // Default constructor (no opts) and explicit {policy:'reject'} should be
  // bit-identical to the pre-0.6.12 behavior.
  const bridgeDefault = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assertEq(bridgeDefault.telemetry().policy, "reject", "default policy is 'reject'");
  assertEq(bridgeDefault.telemetry().droppedFrames, 0, "default droppedFrames = 0");

  // Fill the ring; the next push must return false.
  for (let i = 0; i < 8; i++) {
    const ok = bridgeDefault.push(makePhysFrame(i, n));
    assert(ok, `default ring push #${i} fits`);
  }
  assertEq(bridgeDefault.push(makePhysFrame(99, n)), false, "default full push returns false");
  assertEq(bridgeDefault.telemetry().droppedFrames, 0, "reject never increments dropped");

  // Explicit {policy:'reject'} — same SAB shape, so reuse fresh allocation.
  const alloc2 = Bridge.allocate(8, schema);
  const bridgeExplicit = new Bridge(alloc2.sab, alloc2.capacity, alloc2.schema, {
    policy: "reject",
  });
  assertEq(bridgeExplicit.telemetry().policy, "reject", "explicit policy round-trips");
  for (let i = 0; i < 8; i++) bridgeExplicit.push(makePhysFrame(i, n));
  assertEq(bridgeExplicit.push(makePhysFrame(99, n)), false, "explicit reject returns false on full");
  assertEq(bridgeExplicit.telemetry().droppedFrames, 0, "explicit reject droppedFrames = 0");

  // Unknown policy throws at construction.
  const alloc3 = Bridge.allocate(8, schema);
  let threw = false;
  try {
    new Bridge(alloc3.sab, alloc3.capacity, alloc3.schema, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policy: "bogus" as any,
    });
  } catch {
    threw = true;
  }
  assert(threw, "unknown policy throws at construction");

  ok("backpressure-policy-reject");
}


// ── 65. Backpressure policy 'drop-newest' (0.6.12) ───────────────────────
function testBackpressurePolicyDropNewest(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-newest",
  });
  assertEq(bridge.telemetry().policy, "drop-newest", "policy round-trips");

  // Fill the ring with seqs 0..3.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `push ${i} fits`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops while filling");

  // Three pushes that all should drop silently.
  assertEq(bridge.push(makePhysFrame(100, n)), true, "drop-newest push #1 returns true");
  assertEq(bridge.push(makePhysFrame(101, n)), true, "drop-newest push #2 returns true");
  assertEq(bridge.push(makePhysFrame(102, n)), true, "drop-newest push #3 returns true");
  assertEq(bridge.telemetry().droppedFrames, 3, "droppedFrames = 3 after 3 drops");

  // Consumer pulls — must see the originally-oldest (seqs 0..3) bit-exact,
  // not the dropped ones (100..102).
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) {
    assert(bridge.pull(out), `pull #${i} succeeds`);
    assertEq(out.seq, BigInt(i), `pull #${i} returns original seq=${i}`);
    assert(framesEqual(makePhysFrame(i, n), out), `pull #${i} bit-exact`);
  }
  assertEq(bridge.pull(out), false, "ring is now empty");

  ok("backpressure-policy-drop-newest");
}


// ── 66. Backpressure policy 'drop-oldest' (0.6.12) ───────────────────────
function testBackpressurePolicyDropOldest(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-oldest",
  });
  assertEq(bridge.telemetry().policy, "drop-oldest", "policy round-trips");

  // Fill the ring with seqs 0..3.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `push ${i} fits`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops while filling");

  // Push 3 more — each evicts the oldest. Final ring should hold seqs 3..6
  // (original 0,1,2 evicted; original 3 + new 4,5,6 retained).
  assertEq(bridge.push(makePhysFrame(4, n)), true, "drop-oldest push #1 returns true");
  assertEq(bridge.push(makePhysFrame(5, n)), true, "drop-oldest push #2 returns true");
  assertEq(bridge.push(makePhysFrame(6, n)), true, "drop-oldest push #3 returns true");
  assertEq(bridge.telemetry().droppedFrames, 3, "droppedFrames = 3 after 3 evictions");
  // Available is still capacity (we wrote new frames into the evicted slots).
  assertEq(bridge.telemetry().available, 4, "available stays at capacity after drop-oldest");

  // Consumer pulls — sees seqs 3..6 in FIFO order; originally-oldest 0,1,2
  // are gone forever.
  const out = emptyPhysFrame(n);
  for (let i = 3; i <= 6; i++) {
    assert(bridge.pull(out), `pull seq=${i} succeeds`);
    assertEq(out.seq, BigInt(i), `pull returns seq=${i}`);
    assert(framesEqual(makePhysFrame(i, n), out), `pull seq=${i} bit-exact`);
  }
  assertEq(bridge.pull(out), false, "ring is now empty");

  ok("backpressure-policy-drop-oldest");
}


// ── 67. Backpressure policy 'block' fast path (0.6.12) ───────────────────
function testBackpressurePolicyBlockFastPath(): void {
  // Single-thread pin: validate the fast path (not-full → no waitForSpace
  // call → push returns true immediately). The actual park-and-wake path
  // is covered by tests/Bridge.concurrent.test.ts existing infrastructure
  // (which uses Atomics.wait extensively); no need to fork a Worker for
  // this single-thread pin.
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "block",
    blockTimeoutMs: 50,
  });
  assertEq(bridge.telemetry().policy, "block", "policy round-trips");

  // With space available, push must NOT block — returns true synchronously.
  const startNs = process.hrtime.bigint();
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `block fast-path push ${i} fits`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  // Generous bound — 4 pushes of a 4-element physics schema must be well
  // under the 50 ms block timeout, even on a slow CI box.
  assert(elapsedMs < 25, `block fast-path completes quickly (${elapsedMs.toFixed(1)} ms < 25 ms)`);
  assertEq(bridge.telemetry().droppedFrames, 0, "block fast path drops nothing");

  // Sanity: pulls and re-pushes also stay on the fast path.
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) {
    assert(bridge.pull(out), `block fast-path pull ${i}`);
  }
  for (let i = 100; i < 104; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `block fast-path re-push ${i}`);
  }

  ok("backpressure-policy-block-fast-path");
}


// ── 68. Backpressure policy 'block' with timeout (0.6.12) ────────────────
function testBackpressurePolicyBlockTimeout(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "block",
    blockTimeoutMs: 5,
  });
  // Fill the ring.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `fill push ${i}`);
  }

  // Next push blocks for ~5 ms then returns false. No consumer is draining
  // — single-threaded test.
  const startNs = process.hrtime.bigint();
  const result = bridge.push(makePhysFrame(99, n));
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  assertEq(result, false, "block timeout returns false");
  // Lower bound: the block must actually wait. Bound loose for timer jitter.
  assert(elapsedMs >= 3, `block waited at least ~3 ms (${elapsedMs.toFixed(2)} ms)`);
  // Upper bound: don't block forever. 250 ms is way past any reasonable
  // 5 ms timeout overshoot.
  assert(elapsedMs < 250, `block returned within bound (${elapsedMs.toFixed(2)} ms < 250 ms)`);

  // Construction-time validation: bad timeout values throw.
  let threw = false;
  try {
    new Bridge(Bridge.allocate(4, schema).sab, 4, schema, {
      policy: "block",
      blockTimeoutMs: -1,
    });
  } catch {
    threw = true;
  }
  assert(threw, "negative blockTimeoutMs throws");
  threw = false;
  try {
    new Bridge(Bridge.allocate(4, schema).sab, 4, schema, {
      policy: "block",
      blockTimeoutMs: NaN,
    });
  } catch {
    threw = true;
  }
  assert(threw, "NaN blockTimeoutMs throws");

  ok("backpressure-policy-block-timeout");
}


// ── 82. Drop-oldest CAS-commit pull — bit-exact equivalence with reject ──
//      (0.7.2). Two Bridges on independent SABs, same schema, same N
//      pushes (N < capacity, no overflow). The drop-oldest bridge runs
//      through `_pullOverrunAware` while the reject bridge runs the
//      classic fast path. The two pulled-frame sequences must be
//      bit-exact; any regression in the new CAS-commit code path would
//      surface as a divergence here on the happy path.
function testDropOldestPullBitExactVsReject(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);

  const allocReject = Bridge.allocate(8, schema);
  const allocDrop   = Bridge.allocate(8, schema);
  const reject = new Bridge(allocReject.sab, allocReject.capacity, allocReject.schema, {
    policy: "reject",
  });
  const drop   = new Bridge(allocDrop.sab,   allocDrop.capacity,   allocDrop.schema, {
    policy: "drop-oldest",
  });

  // Push 5 frames into each — well under capacity 8, so no overflow,
  // no producer-side _dropOldest, no race for the consumer-side CAS.
  // This is purely the no-race happy path through the new code.
  const N = 5;
  for (let i = 0; i < N; i++) {
    assertEq(reject.push(makePhysFrame(i, n)), true, `reject push ${i}`);
    assertEq(drop.push(makePhysFrame(i, n)),   true, `drop-oldest push ${i}`);
  }
  assertEq(reject.telemetry().droppedFrames, 0, "reject: no drops");
  assertEq(drop.telemetry().droppedFrames,   0, "drop-oldest: no drops on happy path");
  assertEq(reject.telemetry().available, drop.telemetry().available, "available equal");

  // Pull both and assert bit-exact frame equality.
  const outR = emptyPhysFrame(n);
  const outD = emptyPhysFrame(n);
  for (let i = 0; i < N; i++) {
    assertEq(reject.pull(outR), true, `reject pull ${i}`);
    assertEq(drop.pull(outD),   true, `drop-oldest pull ${i}`);
    assert(framesEqual(outR, outD), `pull ${i} bit-exact between policies`);
  }
  assertEq(reject.pull(outR), false, "reject ring drained");
  assertEq(drop.pull(outD),   false, "drop-oldest ring drained");

  // pullLatest with no-overflow / no-skipped path — drop-oldest's
  // `_pullLatestOverrunAware` should match reject's fast-path output
  // bit-for-bit when nothing was skipped.
  assertEq(reject.push(makePhysFrame(42, n)), true, "reject re-push");
  assertEq(drop.push(makePhysFrame(42, n)),   true, "drop-oldest re-push");
  assertEq(reject.pullLatest(outR), 0, "reject pullLatest skipped=0");
  assertEq(drop.pullLatest(outD),   0, "drop-oldest pullLatest skipped=0");
  assert(framesEqual(outR, outD), "pullLatest bit-exact between policies (skipped=0)");

  ok("drop-oldest-pull-bit-exact-vs-reject");
}


// ── 83. Drop-oldest pullLatest with skipped > 0 (0.7.2) ──────────────────
//      Fill the ring to capacity, then push past capacity under
//      drop-oldest so the producer-side `_dropOldest` evicts the
//      oldest unread frames. Consumer's pullLatest drains down to
//      the newest in one go via `_pullLatestOverrunAware`. Asserts:
//        - newest frame seq returned bit-exact,
//        - skipped count reflects the in-ring older drain (not the
//          producer-side drops, which are separately accounted),
//        - droppedFrames matches the producer-side eviction count,
//        - pulledFrames increments by exactly 1, skippedFrames by
//          the drain count.
function testDropOldestPullLatestSkippedAccounting(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-oldest",
  });

  // Fill ring with seqs 0..3 (capacity = 4).
  for (let i = 0; i < 4; i++) {
    assertEq(bridge.push(makePhysFrame(i, n)), true, `fill push ${i}`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops during fill");

  // Push 3 more under drop-oldest — producer's _dropOldest evicts
  // seqs 0,1,2. Ring after: seqs 3,4,5,6 (oldest→newest).
  for (let i = 4; i <= 6; i++) {
    assertEq(bridge.push(makePhysFrame(i, n)), true, `evicting push ${i}`);
  }
  const tPostEvict = bridge.telemetry();
  assertEq(tPostEvict.droppedFrames, 3, "3 producer-side drops");
  assertEq(tPostEvict.available,     4, "ring still full after evictions");

  // pullLatest under drop-oldest runs _pullLatestOverrunAware — advances
  // READ_IDX from R0 straight to W via CAS. The drain skips the older 3
  // (seqs 3,4,5) and surfaces only seq 6.
  const out = emptyPhysFrame(n);
  const skipped = bridge.pullLatest(out);
  assertEq(skipped, 3, "pullLatest skipped = 3 (drained seqs 3,4,5)");
  assertEq(out.seq, 6n, "pullLatest returned newest seq=6");
  assert(framesEqual(out, makePhysFrame(6, n)), "newest frame bit-exact");

  const tPostPull = bridge.telemetry();
  assertEq(tPostPull.droppedFrames, 3, "droppedFrames unchanged by pullLatest");
  assertEq(tPostPull.skippedFrames, 3, "skippedFrames += 3 from the drain");
  assertEq(tPostPull.pulledFrames,  1, "pulledFrames += 1 for the surfaced frame");
  assertEq(tPostPull.available,     0, "ring drained");

  // Ring is empty — next pullLatest reports -1.
  assertEq(bridge.pullLatest(out), -1, "pullLatest -1 on empty ring");

  ok("drop-oldest-pullLatest-skipped-accounting");
}

function main(): void {
  testBackpressurePolicyReject();
  testBackpressurePolicyDropNewest();
  testBackpressurePolicyDropOldest();
  testBackpressurePolicyBlockFastPath();
  testBackpressurePolicyBlockTimeout();
  testDropOldestPullBitExactVsReject();
  testDropOldestPullLatestSkippedAccounting();
  console.log("\nAll Bridge backpressure tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
