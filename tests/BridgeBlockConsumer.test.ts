/**
 * BridgeBlockConsumer — pins for the 0.7.13 audio-rate / block-rate
 * consumption helper (Track 3 of the King roadmap, first patch).
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/BridgeBlockConsumer.test.ts
 *
 * What BridgeBlockConsumer<S> is, in one sentence: a thin wrapper over
 * `Bridge<S>` that owns a per-sample cursor inside a checked-out frame
 * and lets an AudioWorklet `process()` callback ask for a 128-sample
 * quantum on every invocation; the helper transparently FIFO-pulls the
 * next frame when the cursor exhausts.
 *
 * Pins:
 *   1. Construction: blockSize, samplesField, underflowPolicy default,
 *      bridge accessor.
 *   2. Schema validation: zero f32Array fields throws; two f32Array
 *      fields throws (no auto-disambiguation).
 *   3. Ramp continuity (the headline pin) — produce a global sample
 *      ramp across F frames, consume per 128-sample quantum, assert
 *      every output sample matches the expected ramp value (no drop,
 *      no duplicate, continuous across frame boundaries).
 *   4. Quantum != divisor of blockSize — request a 50-sample quantum
 *      (not a divisor of 1024); cursor must pick up correctly on the
 *      next call and still produce the unbroken ramp.
 *   5. Multi-frame span in one process() call — count > blockSize so a
 *      single call straddles two or more frames.
 *   6. Underflow default 'zero-fill' — empty ring; process(out, 128)
 *      writes zeros and increments underflowSamples by 128.
 *   7. Underflow 'hold-last' — consume one frame fully, then call
 *      process again while ring is empty; assert output is filled with
 *      the last sample value of the consumed frame.
 *   8. Underflow 'throw' — empty ring; process call throws.
 *   9. Mid-quantum underflow — consume part of a frame, exhaust it,
 *      ring empty for the rest; the consumed portion is real samples
 *      and the rest is zero-filled.
 *  10. reset() — discards the in-flight frame + cursor; subsequent
 *      process pulls fresh from the ring.
 *  11. Telemetry counters (framesConsumed, underflowSamples) track the
 *      observed lifecycle.
 *  12. Bounds: count > out.length throws; negative count throws.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  BridgeBlockConsumer,
  type BlockUnderflowPolicy,
} from "../src/BridgeBlockConsumer.js";
import {
  defineSchema,
  f32Array,
  u32,
  u64,
  type FrameFor,
} from "../src/schema.js";

// ── Canonical block schema for the audio-rate pattern. ────────────────────
//
// One u64 "block index" lane (lets the consumer correlate the produced
// block stream against producer-side timing) plus one f32Array of
// `blockSize` samples — the block itself. Exactly one f32Array field, as
// the BridgeBlockConsumer construction contract requires.
const BLOCK_SIZE = 1024;
const QUANTUM = 128;

function makeBlockSchema(blockSize: number = BLOCK_SIZE) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(blockSize),
  });
}

type BlockFrame = FrameFor<ReturnType<typeof makeBlockSchema>>;

function makeBridge(capacity: number = 8, blockSize: number = BLOCK_SIZE) {
  const schema = makeBlockSchema(blockSize);
  const { sab } = Bridge.allocate(capacity, schema);
  const bridge = new Bridge(sab, capacity, schema);
  return { bridge, schema, sab };
}

/** Push frame index `frameIdx` whose samples form the contiguous global
 *  ramp [frameIdx * blockSize, frameIdx * blockSize + 1, ..., +blockSize-1]. */
function pushRampFrame(
  bridge: Bridge<ReturnType<typeof makeBlockSchema>>,
  scratch: BlockFrame,
  frameIdx: number,
  blockSize: number = BLOCK_SIZE,
): boolean {
  scratch.blockIndex = BigInt(frameIdx);
  const base = frameIdx * blockSize;
  for (let k = 0; k < blockSize; k++) scratch.samples[k] = base + k;
  return bridge.push(scratch);
}

// ── 1. Construction surface ────────────────────────────────────────────────
function testConstruction(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  assertEq(cons.bridge, bridge, "exposes bridge");
  assertEq(cons.blockSize, BLOCK_SIZE, "blockSize derived from f32Array length");
  assertEq(cons.samplesField, "samples", "samplesField auto-detected");
  assertEq(cons.underflowPolicy, "zero-fill", "underflowPolicy defaults to zero-fill");
  ok("1. construction surface");
}

// ── 2. Schema validation — zero or multiple f32Array fields ───────────────
function testSchemaValidation(): void {
  // No f32Array field at all.
  const noBlockSchema = defineSchema({ idx: u64(), label: u32() });
  const { sab: sab1 } = Bridge.allocate(4, noBlockSchema);
  const bridgeNone = new Bridge(sab1, 4, noBlockSchema);
  let threw = false;
  try { new BridgeBlockConsumer(bridgeNone as any); } catch { threw = true; }
  assert(threw, "no f32Array field → throws");

  // Two f32Array fields — ambiguous, must throw.
  const dualSchema = defineSchema({
    idx: u64(),
    a:   f32Array(64),
    b:   f32Array(64),
  });
  const { sab: sab2 } = Bridge.allocate(4, dualSchema);
  const bridgeDual = new Bridge(sab2, 4, dualSchema);
  threw = false;
  try { new BridgeBlockConsumer(bridgeDual as any); } catch { threw = true; }
  assert(threw, "two f32Array fields → throws (no auto-disambiguation)");

  ok("2. schema validation");
}

// ── 3. Ramp continuity (headline pin) ──────────────────────────────────────
function testRampContinuity(): void {
  const { bridge } = makeBridge(8);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();

  // Push 4 ramp frames (4 × 1024 = 4096 samples total, well under f32 24-bit
  // mantissa precision so the integer-valued ramp is bit-exact).
  const F = 4;
  for (let f = 0; f < F; f++) {
    assert(pushRampFrame(bridge, scratch, f), `frame ${f} pushed`);
  }

  // Consume in 128-sample quanta.
  const out = new Float32Array(QUANTUM);
  const quantaPerRun = (F * BLOCK_SIZE) / QUANTUM;
  let observed = 0;
  for (let q = 0; q < quantaPerRun; q++) {
    cons.process(out);
    for (let i = 0; i < QUANTUM; i++) {
      assertEq(out[i], observed, `quantum ${q}, sample ${i}: ramp value`);
      observed++;
    }
  }
  assertEq(observed, F * BLOCK_SIZE, "total samples consumed = F * blockSize");
  assertEq(cons.framesConsumed(), F, "framesConsumed === F");
  assertEq(cons.underflowSamples(), 0, "no underflow during the run");

  ok("3. ramp continuity over 128-quantum");
}

// ── 4. Non-divisor quantum (cursor mid-frame) ──────────────────────────────
function testNonDivisorQuantum(): void {
  const { bridge } = makeBridge(4);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  for (let f = 0; f < 3; f++) {
    assert(pushRampFrame(bridge, scratch, f), `frame ${f} pushed`);
  }

  // 1024 / 50 = 20.48 → cursor straddles frame boundaries mid-quantum.
  const Q = 50;
  const out = new Float32Array(Q);
  let observed = 0;
  // Consume 3 frames worth = 3 * 1024 = 3072 samples, in 50-sample quanta.
  const totalSamples = 3 * BLOCK_SIZE;
  const totalQuanta = Math.floor(totalSamples / Q);
  for (let q = 0; q < totalQuanta; q++) {
    cons.process(out);
    for (let i = 0; i < Q; i++) {
      assertEq(out[i], observed, `q=${q} i=${i} mid-frame ramp`);
      observed++;
    }
  }
  // Final partial quantum: drain the rest with a smaller request.
  const tail = totalSamples - observed;
  if (tail > 0) {
    cons.process(out, tail);
    for (let i = 0; i < tail; i++) {
      assertEq(out[i], observed, `tail sample ${i}`);
      observed++;
    }
  }
  assertEq(observed, totalSamples, "consumed every produced sample");
  ok("4. non-divisor quantum");
}

// ── 5. Multi-frame span in one process() ───────────────────────────────────
function testMultiFrameSpan(): void {
  const { bridge } = makeBridge(8);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  for (let f = 0; f < 3; f++) {
    assert(pushRampFrame(bridge, scratch, f), `frame ${f} pushed`);
  }

  // One process() call asks for 2.5 frames worth (1024 * 2.5 = 2560).
  const N = BLOCK_SIZE * 2 + BLOCK_SIZE / 2;
  const out = new Float32Array(N);
  cons.process(out);
  for (let i = 0; i < N; i++) {
    assertEq(out[i], i, `multi-frame span sample ${i}`);
  }
  assertEq(cons.framesConsumed(), 3, "3 frames pulled to cover 2.5 frames worth");
  ok("5. multi-frame span in one process() call");
}

// ── 6. Underflow default 'zero-fill' ───────────────────────────────────────
function testUnderflowZeroFill(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  // Pre-fill the output buffer with nonzero sentinels to verify zero-fill
  // actually writes zeros (not leaving stale data behind).
  const out = new Float32Array(QUANTUM);
  out.fill(0xdead);
  cons.process(out);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], 0, `zero-fill sample ${i}`);
  }
  assertEq(cons.underflowSamples(), QUANTUM, "underflow counter incremented");
  assertEq(cons.framesConsumed(), 0, "no frame consumed during full underflow");
  ok("6. underflow 'zero-fill' (default)");
}

// ── 7. Underflow 'hold-last' ───────────────────────────────────────────────
function testUnderflowHoldLast(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge, { underflowPolicy: "hold-last" });
  const scratch = bridge.scratchFrame();
  pushRampFrame(bridge, scratch, 7); // samples = [7168, 7169, ..., 8191].

  // Drain the frame fully via 1024 / 128 = 8 quanta.
  const out = new Float32Array(QUANTUM);
  for (let q = 0; q < BLOCK_SIZE / QUANTUM; q++) cons.process(out);

  // Now ring is empty. Last sample of consumed frame was 7 * 1024 + 1023 = 8191.
  const expectedHold = 7 * BLOCK_SIZE + (BLOCK_SIZE - 1);
  out.fill(0); // sentinel
  cons.process(out);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], expectedHold, `hold-last sample ${i}`);
  }
  ok("7. underflow 'hold-last'");
}

// ── 8. Underflow 'throw' ───────────────────────────────────────────────────
function testUnderflowThrow(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge, { underflowPolicy: "throw" });
  let threw = false;
  try { cons.process(new Float32Array(QUANTUM)); }
  catch { threw = true; }
  assert(threw, "underflow 'throw' policy throws on empty ring");
  ok("8. underflow 'throw'");
}

// ── 9. Mid-quantum underflow (partial real + zero-fill tail) ──────────────
function testMidQuantumUnderflow(): void {
  // Use a smaller block size so we can exhaust the frame within a single
  // quantum and exercise the mid-quantum underflow branch.
  const smallBlock = 80;
  const { bridge } = makeBridge(4, smallBlock);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  scratch.blockIndex = 0n;
  for (let k = 0; k < smallBlock; k++) scratch.samples[k] = k + 1; // 1..80
  assert(bridge.push(scratch), "small-block frame pushed");

  const out = new Float32Array(QUANTUM);
  out.fill(-1); // sentinel
  cons.process(out, QUANTUM);
  // First 80 samples should be the real ramp 1..80.
  for (let i = 0; i < smallBlock; i++) {
    assertEq(out[i], i + 1, `mid-quantum real sample ${i}`);
  }
  // Remaining 48 should be zero (default underflow policy).
  for (let i = smallBlock; i < QUANTUM; i++) {
    assertEq(out[i], 0, `mid-quantum zero-fill sample ${i}`);
  }
  assertEq(cons.underflowSamples(), QUANTUM - smallBlock, "mid-quantum underflow tally");
  ok("9. mid-quantum underflow");
}

// ── 10. reset() discards in-flight frame + cursor ─────────────────────────
function testReset(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  pushRampFrame(bridge, scratch, 0);
  pushRampFrame(bridge, scratch, 1);

  // Consume half of frame 0.
  const out = new Float32Array(BLOCK_SIZE / 2);
  cons.process(out);
  assertEq(out[0], 0, "pre-reset: first sample is ramp[0]");

  cons.reset();

  // After reset, next process() should pull fresh — which means we lose
  // the second half of frame 0 (it stays unread in the ring) and start
  // at frame 1's first sample. (Frame 0's second half is still in scratch
  // but is now discarded.) Wait — actually `reset()` discards the
  // checked-out frame's remaining cursor but doesn't push the half-read
  // frame back; the next pull advances to frame 1. So out[0] should be
  // 1 * BLOCK_SIZE = 1024.
  cons.process(out);
  assertEq(out[0], BLOCK_SIZE, "post-reset: cursor restarts at the next frame");
  ok("10. reset() discards in-flight frame + cursor");
}

// ── 11. Telemetry counters ─────────────────────────────────────────────────
function testTelemetry(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  pushRampFrame(bridge, scratch, 0);
  pushRampFrame(bridge, scratch, 1);

  const out = new Float32Array(QUANTUM);
  // Consume both frames fully = 16 quanta.
  for (let q = 0; q < 2 * BLOCK_SIZE / QUANTUM; q++) cons.process(out);
  assertEq(cons.framesConsumed(), 2, "framesConsumed === 2");
  assertEq(cons.underflowSamples(), 0, "no underflow");

  // One more quantum → all underflow.
  cons.process(out);
  assertEq(cons.underflowSamples(), QUANTUM, "underflow counter increments by quantum");
  ok("11. telemetry counters");
}

// ── 12. Bounds: count > out.length / negative count ────────────────────────
function testBounds(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const out = new Float32Array(QUANTUM);
  let threw = false;
  try { cons.process(out, QUANTUM + 1); } catch { threw = true; }
  assert(threw, "count > out.length throws");
  threw = false;
  try { cons.process(out, -1); } catch { threw = true; }
  assert(threw, "negative count throws");
  ok("12. bounds validation");
}

// ── 13. Symmetry: matches `underflowPolicy` round-trip on the class ───────
function testPolicyRoundtrip(): void {
  const { bridge } = makeBridge();
  const policies: BlockUnderflowPolicy[] = ["zero-fill", "hold-last", "throw"];
  for (const policy of policies) {
    const cons = new BridgeBlockConsumer(bridge, { underflowPolicy: policy });
    assertEq(cons.underflowPolicy, policy, `policy ${policy} round-trips`);
  }
  ok("13. underflow policy round-trip");
}

function main(): void {
  testConstruction();
  testSchemaValidation();
  testRampContinuity();
  testNonDivisorQuantum();
  testMultiFrameSpan();
  testUnderflowZeroFill();
  testUnderflowHoldLast();
  testUnderflowThrow();
  testMidQuantumUnderflow();
  testReset();
  testTelemetry();
  testBounds();
  testPolicyRoundtrip();
  console.log("all BridgeBlockConsumer pins green");
}

main();
