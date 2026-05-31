/**
 * JitKernelSwap pins (0.9.914 — Apollo Frontier 5, The Autonomous JIT, Stage 1b).
 *
 * The pure dual-kernel live-swap state machine — the JIT analogue of
 * `Bridge.hotswap.test.ts`, with the two BRIDGES replaced by two KERNELS (the
 * developer's JS fallback and the JIT-compiled SIMD kernel). These pins commit
 * the same invariants the HotSwap pins do, adapted to the kernel-swap timing:
 *
 *   1. Pre-arm: `idle`, weight 0; `weightAt` is 0 everywhere (no window).
 *   2. THE timing law: `armSwap` (in onmessage) → `priming`, window NOT anchored;
 *      the FIRST `beginQuantum` anchors the window to NOW, so the weight at the
 *      anchor instant is EXACTLY 0 (no jump → no click at fade onset).
 *   3. Sample-accurate schedule: `weightAt(perSampleNs)` is the C^k weight,
 *      monotone 0→1 across the window, endpoints exact.
 *   4. Endpoint-exact completion: the quantum-base weight reaches exactly 1,
 *      phase `complete`, and `justCompleted` fires EXACTLY once (so the consumer
 *      retires the old kernel exactly once).
 *   5. Re-arm after complete (the promoted kernel becomes the new "current") and
 *      reset → idle.
 *   6. Guards: bad window throws (ctor + armSwap), double-arm throws,
 *      non-finite baseConsumerNs throws.
 *
 * `tsx` script; `assert`/`assertEq`/`ok` from `_assert.ts`. No framework.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { JitKernelSwap } from "../src/jit/JitKernelSwap.js";

// ─── 1. Pre-arm: idle, weight 0, no window ──────────────────────────────────

function testIdlePreArm(): void {
  const swap = new JitKernelSwap();
  assertEq(swap.phase(), "idle", "phase idle pre-arm");
  assertEq(swap.windowStartNs(), null, "no window pre-arm");
  assertEq(swap.weightAt(0), 0, "weight 0 at t=0 pre-arm");
  assertEq(swap.weightAt(1e12), 0, "weight 0 at large t pre-arm");
  const q = swap.beginQuantum(5e6);
  assertEq(q.phase, "idle", "beginQuantum stays idle pre-arm");
  assertEq(q.weight, 0, "quantum weight 0 pre-arm");
  assertEq(q.justCompleted, false, "not completed pre-arm");
  assert(!swap.isSwapping(), "not swapping pre-arm");
  ok("jitswap idle pre-arm (weight 0 everywhere, no window)");
}

// ─── 2. THE timing law: window anchors to the first quantum (weight starts 0) ─

function testArmAnchorsAtFirstQuantum(): void {
  const swap = new JitKernelSwap({ continuity: "quintic", windowSeconds: 0.01 });

  // Arm (happens in onmessage, between quanta). Priming, window NOT yet anchored.
  swap.armSwap();
  assertEq(swap.phase(), "priming", "phase priming right after arm");
  assertEq(swap.windowStartNs(), null, "window not anchored while priming");
  assert(swap.isSwapping(), "isSwapping true while priming");
  // No window ⇒ weight 0 regardless of the time we ask about.
  assertEq(swap.weightAt(9.9e9), 0, "weight 0 while priming (no window yet)");

  // The FIRST quantum after arm anchors the window to NOW and enters fading; the
  // weight at the anchor instant is EXACTLY 0 — the headline (no jump → no click).
  const anchorNs = 123.456e6;
  const q = swap.beginQuantum(anchorNs);
  assertEq(q.phase, "fading", "fading on the first quantum after arm");
  assertEq(q.windowStartNs, anchorNs, "window anchored to the first quantum, not arm-time");
  assertEq(q.weight, 0, "weight is EXACTLY 0 at the fade anchor (the key timing decision)");
  assertEq(swap.weightAt(anchorNs), 0, "weightAt(anchor) is exactly 0");
  ok("jitswap arm→priming→fading anchors window to first quantum (weight starts exactly 0)");
}

// ─── 3. Sample-accurate weight schedule: C^k, monotone 0→1, endpoints exact ──

function testWeightSchedule(): void {
  const windowSeconds = 0.02;
  const swap = new JitKernelSwap({ continuity: "septic", windowSeconds });
  swap.armSwap();
  const t0Ns = 7e6;
  const open = swap.beginQuantum(t0Ns);
  assertEq(open.phase, "fading", "fading after arm+first quantum");
  const t0 = open.windowStartNs!;
  const windowNs = windowSeconds * 1e9;

  // Endpoints exact + clamped outside the window.
  assertEq(swap.weightAt(t0), 0, "weight exactly 0 at window start");
  assertEq(swap.weightAt(t0 + windowNs), 1, "weight exactly 1 at window end");
  assertEq(swap.weightAt(t0 - 1e6), 0, "weight 0 before window");
  assertEq(swap.weightAt(t0 + windowNs + 1e6), 1, "weight 1 past window");

  // Monotone, in [0,1] across the window (pure — does not advance the machine).
  let prev = -Infinity;
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const w = swap.weightAt(t0 + (i / N) * windowNs);
    assert(w >= -1e-12 && w <= 1 + 1e-12, `weight in [0,1] at i=${i}: ${w}`);
    assert(w >= prev - 1e-12, `weight monotone at i=${i} (${w} < ${prev})`);
    prev = w;
  }
  // weightAt did not advance the state machine.
  assertEq(swap.phase(), "fading", "weightAt is pure (still fading)");
  assertEq(swap.continuityOrder(), "septic", "continuity order reported");
  ok("jitswap weight schedule (septic, pure weightAt monotone 0→1, endpoints exact)");
}

// ─── 4. Endpoint-exact completion: weight 1, complete, justCompleted once ────

function testCompletion(): void {
  const windowSeconds = 0.01;
  const swap = new JitKernelSwap({ windowSeconds });
  swap.armSwap();
  const open = swap.beginQuantum(0); // anchor at t0=0
  assertEq(open.phase, "fading", "fading opened");
  const windowNs = windowSeconds * 1e9;

  // A mid-window quantum: still fading, weight in (0,1).
  const mid = swap.beginQuantum(windowNs * 0.5);
  assertEq(mid.phase, "fading", "mid quantum still fading");
  assert(mid.weight > 0 && mid.weight < 1, `mid weight strictly interior: ${mid.weight}`);
  assertEq(mid.justCompleted, false, "not completed mid-window");

  // Past the window end → weight clamps to 1, phase complete, justCompleted fires.
  const done = swap.beginQuantum(windowNs + 1e3);
  assertEq(done.phase, "complete", "phase complete past window end");
  assertEq(done.weight, 1, "weight exactly 1 at completion");
  assertEq(done.justCompleted, true, "justCompleted fires on the completing quantum");

  // Subsequent quanta stay complete, weight 1, and justCompleted does NOT re-fire.
  const after = swap.beginQuantum(windowNs * 3);
  assertEq(after.phase, "complete", "stays complete");
  assertEq(after.weight, 1, "weight stays 1 after completion");
  assertEq(after.justCompleted, false, "justCompleted fires exactly once (old kernel retired once)");
  assert(!swap.isSwapping(), "not swapping after complete");
  ok("jitswap completion (weight exactly 1, complete, justCompleted exactly once)");
}

// ─── 5. Re-arm after complete + reset ───────────────────────────────────────

function testReArmAndReset(): void {
  const swap = new JitKernelSwap({ windowSeconds: 0.01 });
  swap.armSwap();
  swap.beginQuantum(0);
  swap.beginQuantum(2e7); // past 10 ms → complete
  assertEq(swap.phase(), "complete", "complete after first swap");

  // Re-arm from complete is allowed (the promoted kernel becomes the new current).
  swap.armSwap();
  assertEq(swap.phase(), "priming", "re-arm from complete → priming");
  const q = swap.beginQuantum(3e7);
  assertEq(q.phase, "fading", "second swap fades");
  assertEq(q.weight, 0, "second swap weight starts at 0 (re-anchored)");

  // reset → idle, window cleared.
  swap.reset();
  assertEq(swap.phase(), "idle", "reset → idle");
  assertEq(swap.windowStartNs(), null, "reset clears the window");
  assertEq(swap.weightAt(3e7), 0, "weight 0 after reset");
  ok("jitswap re-arm after complete + reset → idle");
}

// ─── 6. Guards ──────────────────────────────────────────────────────────────

function testGuards(): void {
  // Bad constructor window.
  let threw = false;
  try { new JitKernelSwap({ windowSeconds: 0 }); } catch { threw = true; }
  assert(threw, "ctor windowSeconds=0 throws");
  threw = false;
  try { new JitKernelSwap({ windowSeconds: -1 }); } catch { threw = true; }
  assert(threw, "ctor windowSeconds<0 throws");
  threw = false;
  try { new JitKernelSwap({ windowSeconds: Number.NaN }); } catch { threw = true; }
  assert(threw, "ctor windowSeconds=NaN throws");

  const swap = new JitKernelSwap();
  // Bad armSwap window.
  threw = false;
  try { swap.armSwap(0); } catch { threw = true; }
  assert(threw, "armSwap(0) throws");
  threw = false;
  try { swap.armSwap(-1); } catch { threw = true; }
  assert(threw, "armSwap(negative) throws");

  // Double-arm while in progress throws.
  swap.armSwap(0.01);
  assertEq(swap.phase(), "priming", "armed → priming");
  threw = false;
  try { swap.armSwap(0.01); } catch { threw = true; }
  assert(threw, "double-arm while priming throws");
  swap.beginQuantum(0); // → fading
  threw = false;
  try { swap.armSwap(0.01); } catch { threw = true; }
  assert(threw, "double-arm while fading throws");

  // reset re-enables arming.
  swap.reset();
  swap.armSwap(0.01);
  assertEq(swap.phase(), "priming", "re-arm after reset ok");

  // Non-finite baseConsumerNs throws.
  threw = false;
  try { swap.beginQuantum(Number.NaN); } catch { threw = true; }
  assert(threw, "beginQuantum(NaN) throws");
  threw = false;
  try { swap.beginQuantum(Infinity); } catch { threw = true; }
  assert(threw, "beginQuantum(Infinity) throws");
  ok("jitswap guards (bad window throws, double-arm throws, non-finite quantum throws)");
}

function main(): void {
  testIdlePreArm();
  testArmAnchorsAtFirstQuantum();
  testWeightSchedule();
  testCompletion();
  testReArmAndReset();
  testGuards();
  console.log("\nAll JitKernelSwap tests passed.");
}

main();
