/**
 * HotSwapConsumer pins (0.9.88 — Apollo Frontier 4, God-Node Stage 2).
 *
 * The two-bridge hot-swap orchestration over the Stage-1 crossfade. These pins
 * commit the `tmp-hotswap-probe` findings:
 *
 *   1. Pre-arm: `idle`, weight 0, only `a` reconstructed (`outB` untouched).
 *   2. Priming gap: after `armSwap`, while `b` is not yet ready, phase stays
 *      `priming`, weight 0, window not started — output stays exactly `a`.
 *   3. THE timing decision: the window clock anchors to b-ready, so the weight
 *      starts at exactly 0 (no jump). Drove the whole design.
 *   4. Sample-accurate fade: `weightAt(perSampleNs)` is the C^k schedule,
 *      monotone 0→1 across the window.
 *   5. Endpoint-exact completion: weight reaches exactly 1, phase `complete`,
 *      `a` retired (no longer pulled — `outA` untouched).
 *   6. Famine ride-through: `a`'s producer stops mid-fade; `a.pullHermiteLatest`
 *      holds its cached pair; reconstruction stays finite and smooth.
 *   7. Guards + lifecycle: double-arm throws, reset re-arms, bad opts throw.
 *
 * Single-sample order-3 quintic-Hermite trajectory schema (like the phaseLock
 * pins). `tsx` script; `assert`/`assertEq`/`ok` from `_assert.ts`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import { defineSchema, f64TrajectoryArray, u64 } from "../src/schema.js";
import { HotSwapConsumer } from "../src/HotSwapConsumer.js";

const SR = 48_000;

function makeBridge() {
  const schema = defineSchema({
    seq: u64(),
    t: u64(),
    sig: f64TrajectoryArray(1, { order: 3, interpolationMode: "quintic-hermite" }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
  const { sab, capacity } = Bridge.allocate(64, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.setSampleRate(SR);
  return bridge;
}
type Br = ReturnType<typeof makeBridge>;

/** Push an analytic sine (p, v, a) frame at producer time `tNs`. */
function pushSine(br: Br, seq: bigint, tNs: number, freq: number, amp: number): void {
  const t = tNs * 1e-9;
  const w = 2 * Math.PI * freq;
  const fr = br.scratchFrame();
  fr.seq = seq;
  fr.t = BigInt(Math.round(tNs));
  fr.sig[0] = amp * Math.sin(w * t);
  fr.sig[1] = amp * w * Math.cos(w * t);
  fr.sig[2] = -amp * w * w * Math.sin(w * t);
  assert(br.push(fr), `push seq=${seq}`);
}

// ─── 1. Pre-arm: idle, weight 0, only `a` reconstructed ─────────────────────

function testIdlePreArm(): void {
  const a = makeBridge();
  const b = makeBridge();
  pushSine(a, 0n, 0, 220, 1);
  pushSine(a, 1n, 1e6, 220, 1);
  const swap = new HotSwapConsumer(a, b);
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();
  outB.sig[0] = 12345; // sentinel — must stay untouched in idle

  const r = swap.pullLatest(outA, outB, 2e6);
  assertEq(r.phase, "idle", "phase idle pre-arm");
  assertEq(r.weight, 0, "weight 0 pre-arm");
  assertEq(r.bSkipped, -1, "b not pulled in idle");
  assertEq(outB.sig[0], 12345, "outB untouched in idle");
  assert(r.aSkipped >= 0, "a reconstructed in idle");
  ok("hotswap idle pre-arm (only a pulled, weight 0, outB untouched)");
}

// ─── 2 + 3. Priming gap, then window anchors to b-ready (weight starts at 0) ─

function testPrimingThenAnchoredOnset(): void {
  const a = makeBridge();
  const b = makeBridge();
  // `a` fully primed and streaming from t=0.
  for (let k = 0; k < 6; k++) pushSine(a, BigInt(k), k * 1e6, 220, 1);
  const swap = new HotSwapConsumer(a, b, { continuity: "quintic", windowSeconds: 0.01 });
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();

  // Arm at t=5ms. `b` has NO frames yet → priming.
  swap.armSwap();
  let r = swap.pullLatest(outA, outB, 5e6);
  assertEq(r.phase, "priming", "phase priming right after arm (b empty)");
  assertEq(r.weight, 0, "weight 0 while priming");
  assertEq(r.windowStartNs, null, "window not started while priming");

  // `b` gets its FIRST frame — still only one distinct frame → not ready
  // (default minBFramesForReady=2), still priming.
  pushSine(b, 0n, 5e6, 330, 1);
  r = swap.pullLatest(outA, outB, 5.5e6);
  assertEq(r.phase, "priming", "still priming after b's first frame (needs 2)");
  assertEq(r.weight, 0, "weight still 0 (one b frame)");

  // `b`'s SECOND distinct frame arrives → ready → window anchors to NOW, phase
  // fading, and the weight at the anchor instant is EXACTLY 0 (the headline).
  pushSine(b, 1n, 6e6, 330, 1);
  const anchorNs = 6.5e6;
  r = swap.pullLatest(outA, outB, anchorNs);
  assertEq(r.phase, "fading", "fading once b has 2 frames");
  assert(r.bReady, "b reported ready");
  assertEq(r.windowStartNs, anchorNs, "window anchored to the b-ready quantum, not arm-time");
  assertEq(r.weight, 0, "weight is EXACTLY 0 at the fade anchor — no jump (the key timing decision)");
  ok("hotswap priming→fading anchors window to b-ready (weight starts exactly 0)");
}

// ─── 4. Sample-accurate weight schedule: C^k, monotone 0→1 ──────────────────

function testWeightSchedule(): void {
  const a = makeBridge();
  const b = makeBridge();
  const swap = new HotSwapConsumer(a, b, { continuity: "septic", windowSeconds: 0.02 });
  // Drive into fading. `b` frames must arrive across TWO pull windows — one
  // pull drains the whole queue (pullHermiteLatest skips to newest), so two
  // distinct fresh pulls (the prev+curr the interpolator needs) require a
  // second frame to land between the pulls.
  for (let k = 0; k < 3; k++) pushSine(a, BigInt(k), k * 1e6, 220, 1);
  pushSine(b, 0n, 0, 330, 1);
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();
  swap.armSwap();
  swap.pullLatest(outA, outB, 0);          // b fresh pull #1 (priming)
  pushSine(b, 1n, 1e6, 330, 1);
  const r = swap.pullLatest(outA, outB, 1e6); // b fresh pull #2 → ready → fading
  assertEq(r.phase, "fading", "fading after b ready");
  const t0 = r.windowStartNs!;
  const windowNs = 0.02 * 1e9;

  // weightAt is pure: sample across the window, assert monotone 0→1 and the
  // endpoints exact.
  assertEq(swap.weightAt(t0), 0, "weight exactly 0 at window start");
  assertEq(swap.weightAt(t0 + windowNs), 1, "weight exactly 1 at window end");
  assertEq(swap.weightAt(t0 - 1e6), 0, "weight 0 before window");
  assertEq(swap.weightAt(t0 + windowNs + 1e6), 1, "weight 1 past window");
  let prev = -Infinity;
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const w = swap.weightAt(t0 + (i / N) * windowNs);
    assert(w >= -1e-12 && w <= 1 + 1e-12, `weight in [0,1] at i=${i}: ${w}`);
    assert(w >= prev - 1e-12, `weight monotone at i=${i} (${w} < ${prev})`);
    prev = w;
  }
  ok("hotswap weight schedule (septic, pure weightAt monotone 0→1, endpoints exact)");
}

// ─── 5. Endpoint-exact completion: weight 1, phase complete, a retired ───────

function testCompletionRetiresA(): void {
  const a = makeBridge();
  const b = makeBridge();
  for (let k = 0; k < 3; k++) pushSine(a, BigInt(k), k * 1e6, 220, 1);
  pushSine(b, 0n, 0, 330, 1);
  const swap = new HotSwapConsumer(a, b, { windowSeconds: 0.005 });
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();
  swap.armSwap();
  swap.pullLatest(outA, outB, 0);          // b fresh pull #1
  pushSine(b, 1n, 1e6, 330, 1);
  const open = swap.pullLatest(outA, outB, 0.1e6); // b fresh pull #2 → fading, window @ 0.1ms
  assertEq(open.phase, "fading", "fading opened");
  const t0 = open.windowStartNs!;

  // Jump the audio clock past the window end → weight clamps to 1, complete.
  const done = swap.pullLatest(outA, outB, t0 + 0.005e9 + 1e6);
  assertEq(done.phase, "complete", "phase complete past window end");
  assertEq(done.weight, 1, "weight exactly 1 at completion");

  // Once complete, `a` is retired: outA must be left untouched on later pulls.
  outA.sig[0] = -999;
  const after = swap.pullLatest(outA, outB, t0 + 0.005e9 + 3e6);
  assertEq(after.phase, "complete", "stays complete");
  assertEq(after.aSkipped, -1, "a not pulled after completion (retired)");
  assertEq(outA.sig[0], -999, "outA untouched after completion");
  assertEq(after.weight, 1, "weight stays 1 after completion");
  ok("hotswap completion (weight exactly 1, phase complete, a retired/untouched)");
}

// ─── 6. Famine ride-through: a's producer stops mid-fade ────────────────────

function testFamineRideThrough(): void {
  const a = makeBridge();
  const b = makeBridge();
  // Prime both; then stop pushing to `a` (famine) while the fade runs.
  for (let k = 0; k < 3; k++) pushSine(a, BigInt(k), k * 1e6, 220, 1);
  pushSine(b, 0n, 0, 330, 1);
  const swap = new HotSwapConsumer(a, b, { windowSeconds: 0.05 });
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();
  swap.armSwap();
  swap.pullLatest(outA, outB, 0);          // b fresh pull #1
  pushSine(b, 1n, 1e6, 330, 1);
  const open = swap.pullLatest(outA, outB, 1e6); // b fresh pull #2 → fading
  assertEq(open.phase, "fading", "fading");

  // No more pushes to `a`. Advance the clock through the fade; `a` rides its
  // cached pair — reconstruction must stay finite (no NaN/throw) every quantum.
  let allFinite = true;
  const t0 = open.windowStartNs!;
  for (let q = 0; q < 20; q++) {
    const r = swap.pullLatest(outA, outB, t0 + q * 2.5e6);
    if (!Number.isFinite(outA.sig[0]!) || !Number.isFinite(outB.sig[0]!)) allFinite = false;
    if (!Number.isFinite(r.weight)) allFinite = false;
  }
  assert(allFinite, "a/b reconstructions + weight stay finite through a-famine");
  ok("hotswap famine ride-through (a holds its cached pair, output stays finite)");
}

// ─── 7. Guards + lifecycle ──────────────────────────────────────────────────

function testGuardsAndLifecycle(): void {
  const a = makeBridge();
  const b = makeBridge();

  // Bad options.
  let threw = false;
  try { new HotSwapConsumer(a, b, { minBFramesForReady: 0 }); } catch { threw = true; }
  assert(threw, "minBFramesForReady < 1 throws");

  const swap = new HotSwapConsumer(a, b);
  // Bad window.
  threw = false;
  try { swap.armSwap(0); } catch { threw = true; }
  assert(threw, "armSwap(0) throws");
  threw = false;
  try { swap.armSwap(-1); } catch { threw = true; }
  assert(threw, "armSwap(negative) throws");

  // Double-arm throws while in progress.
  swap.armSwap(0.01);
  assertEq(swap.phase(), "priming", "armed → priming");
  threw = false;
  try { swap.armSwap(0.01); } catch { threw = true; }
  assert(threw, "double-arm while priming throws");

  // reset returns to idle and allows re-arm.
  swap.reset();
  assertEq(swap.phase(), "idle", "reset → idle");
  swap.armSwap(0.01);
  assertEq(swap.phase(), "priming", "re-arm after reset ok");

  // Non-finite baseConsumerNs throws.
  threw = false;
  const outA = a.scratchEvaluatedFrame();
  const outB = b.scratchEvaluatedFrame();
  try { swap.pullLatest(outA, outB, Number.NaN); } catch { threw = true; }
  assert(threw, "non-finite baseConsumerNs throws");

  // minBFramesForReady=1 → ready after a single b frame (hold-ready).
  const a2 = makeBridge();
  const b2 = makeBridge();
  pushSine(a2, 0n, 0, 220, 1);
  pushSine(b2, 0n, 0, 330, 1);
  const swap2 = new HotSwapConsumer(a2, b2, { minBFramesForReady: 1, windowSeconds: 0.01 });
  const oA = a2.scratchEvaluatedFrame();
  const oB = b2.scratchEvaluatedFrame();
  swap2.armSwap();
  const r = swap2.pullLatest(oA, oB, 0);
  assertEq(r.phase, "fading", "minB=1 → fading after a single b frame");
  ok("hotswap guards + lifecycle (bad opts/window throw, double-arm throws, reset re-arms, minB=1 hold-ready)");
}

function main(): void {
  testIdlePreArm();
  testPrimingThenAnchoredOnset();
  testWeightSchedule();
  testCompletionRetiresA();
  testFamineRideThrough();
  testGuardsAndLifecycle();
  console.log("\nAll Bridge.hotswap tests passed.");
}

main();
