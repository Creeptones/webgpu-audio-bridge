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
 *   8. Strict-fail-on-underflow caller-side wrapper — empty ring;
 *      caller observes underflowSamples() delta after process() and throws
 *      from caller code. This is the 0.9.0 replacement for the removed
 *      `underflowPolicy: 'throw'` arm; the bug-shaped semantics of throwing
 *      from inside AudioWorklet process() are eliminated by moving the
 *      throw to caller code that runs outside the audio thread.
 *   9. Mid-quantum underflow — consume part of a frame, exhaust it,
 *      ring empty for the rest; the consumed portion is real samples
 *      and the rest is zero-filled.
 *  10. reset() — discards the in-flight frame + cursor; subsequent
 *      process pulls fresh from the ring.
 *  11. Telemetry counters (framesConsumed, underflowSamples) track the
 *      observed lifecycle.
 *  12. Bounds: count > out.length throws; negative count throws.
 *  14. processAdd ramp continuity — carrier pre-filled with C; residual ramp;
 *      after F frames consumed at gain=1.0 every output sample is C + ramp.
 *  15. processAdd gain scaling — carrier zero, gain=2.5; output is 2.5*ramp.
 *  16. processAdd hybrid underflow preservation — ring empty; out pre-filled
 *      with sentinel survives the call untouched (carrier survives).
 *  17. processAdd mid-quantum hybrid underflow — head receives real adds,
 *      tail is preserved (NOT zero-filled / NOT hold-last filled).
 *  18. processAdd telemetry parity — framesConsumed + underflowSamples track
 *      identically to process().
 *  19. processAdd gain=0 cursor advance — out untouched, cursor still
 *      advances, telemetry still increments.
 *  20. processAdd bounds + finiteness — count out of range throws; non-
 *      finite gain throws.
 *  21. process / processAdd cursor interop — interleaved calls on the same
 *      consumer share the cursor; sample stream is monotonic.
 *  22. Stereo (0.9.48) mono backward-compat — channels:1 / omitted construct
 *      identically; output byte-identical to the legacy path.
 *  23. Interleaved construction — channels:2 → blockSize === arrayLength/2;
 *      channels / layout introspection.
 *  24. Construction validation — non-divisible length, channels>1 + 'mono',
 *      'planar', and channels:3 all throw.
 *  25. processAddStereo cursor advancement (headline) — L gets channel-0's
 *      de-interleaved ramp, R channel-1's, one cursor advance per call,
 *      across frame boundaries; non-divisor quantum variant.
 *  26. processAddChannel single-channel + advance-on-every-call contract.
 *  27. Interleaved underflow preserves the carrier per channel — full + mid-
 *      window; underflowSamples in per-channel units.
 *  28. Legacy process()/processAdd() throw under channels>1.
 *  29. Telemetry parity — framesConsumed counts ring pulls regardless of
 *      channels; underflowSamples per-channel; reset() zeroes both.
 *  30. (0.9.51) underflowRate(windowMs) — 0 when no underflow; ≈1 over a
 *      recent all-underflow window; ≈ the true fraction over a mixed window;
 *      clamps windowMs to underflowWindowMs; throws without a sampleRate.
 *  31. (0.9.51) lastSuccessfulPullTime / elapsedSeconds — advance on a pull,
 *      stall across an underflow run; stall age grows by quantum ÷ sampleRate.
 *  32. (0.9.51) reset() zeroes the new audio-domain clock + history.
 *  33. (0.9.51) instrument-every-path — the new telemetry tracks identically
 *      across process / processAdd / processAddStereo.
 *  34. (0.9.55) process() copy equivalence — the explicit cached-locals loop
 *      that replaced out.set(samples.subarray(...)) is byte-for-byte faithful
 *      across an irregular straddling chunk schedule, and holdSample read off
 *      the same copy still tracks the final value (verified via hold-last).
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

// ── Interleaved (multi-channel) helpers (0.9.48) ──────────────────────────
//
// An interleaved schema is still ONE f32Array — `f32Array(channels*blockSize)`.
// Flat layout: [ch0[0], ch1[0], …, ch0[1], …]. Channel `c` at per-channel
// index `j` lives at flat index `j*C + c`.
function makeInterleavedSchema(blockSize: number, channels: number) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(channels * blockSize),
  });
}

function makeInterleavedBridge(
  capacity: number,
  blockSize: number,
  channels: number,
) {
  const schema = makeInterleavedSchema(blockSize, channels);
  const { sab } = Bridge.allocate(capacity, schema);
  const bridge = new Bridge(sab, capacity, schema);
  return { bridge, schema, sab };
}

/** Push an interleaved ramp frame: the lone array is the contiguous flat ramp
 *  [frameIdx*C*B, +1, …]. By interleave arithmetic this makes channel `c`'s
 *  de-interleaved per-channel stream the value `gj*C + c` at per-channel
 *  global index `gj` — so channel 0 is the even ramp, channel 1 the odd ramp
 *  (distinguishable, integer-valued → bit-exact in f32). */
function pushInterleavedRampFrame(
  bridge: any,
  scratch: any,
  frameIdx: number,
  channels: number,
  blockSize: number,
): boolean {
  scratch.blockIndex = BigInt(frameIdx);
  const flat = channels * blockSize;
  const base = frameIdx * flat;
  for (let k = 0; k < flat; k++) scratch.samples[k] = base + k;
  return bridge.push(scratch);
}

/** Expected de-interleaved value for channel `c` at per-channel global index
 *  `gj` under the `pushInterleavedRampFrame` convention. */
function expectedChannelValue(gj: number, c: number, channels: number): number {
  return gj * channels + c;
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

// ── 8. Strict-fail-on-underflow caller-side wrapper ───────────────────────
function testStrictUnderflowWrapper(): void {
  // Replaces the pre-0.9.0 `underflowPolicy: 'throw'` arm. The wrapper
  // observes the `underflowSamples()` counter delta after process() and
  // throws from caller code — same strict-fail signal, without the bug-
  // shaped semantics of throwing from inside AudioWorklet process().
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const out = new Float32Array(QUANTUM);
  let threw = false;
  try {
    const before = cons.underflowSamples();
    cons.process(out);
    if (cons.underflowSamples() > before) {
      throw new Error(
        `BridgeBlockConsumer caller-side strict mode: ring underflow ` +
        `(${cons.underflowSamples() - before} samples zero-filled).`,
      );
    }
  } catch { threw = true; }
  assert(threw, "caller-side wrapper detects ring-empty mid-process");
  ok("8. strict-on-underflow caller-side wrapper");
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
  const policies: BlockUnderflowPolicy[] = ["zero-fill", "hold-last"];
  for (const policy of policies) {
    const cons = new BridgeBlockConsumer(bridge, { underflowPolicy: policy });
    assertEq(cons.underflowPolicy, policy, `policy ${policy} round-trips`);
  }
  ok("13. underflow policy round-trip");
}

// ── 14. processAdd ramp continuity (additive hybrid headline) ─────────────
function testProcessAddRampContinuity(): void {
  const { bridge } = makeBridge(8);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();

  // Push 4 ramp frames (4 * 1024 = 4096 samples — well under f32 mantissa
  // precision so integer-valued ramp values are bit-exact).
  const F = 4;
  for (let f = 0; f < F; f++) {
    assert(pushRampFrame(bridge, scratch, f), `frame ${f} pushed`);
  }

  // Carrier value. processAdd should produce out[i] = CARRIER + ramp[i].
  const CARRIER = 100;
  const out = new Float32Array(QUANTUM);
  const quantaPerRun = (F * BLOCK_SIZE) / QUANTUM;
  let observed = 0;
  for (let q = 0; q < quantaPerRun; q++) {
    out.fill(CARRIER); // refresh carrier every quantum (worklet-style)
    cons.processAdd(out);
    for (let i = 0; i < QUANTUM; i++) {
      assertEq(out[i], CARRIER + observed, `q=${q} i=${i} additive ramp`);
      observed++;
    }
  }
  assertEq(observed, F * BLOCK_SIZE, "all samples additively consumed");
  assertEq(cons.framesConsumed(), F, "framesConsumed === F (processAdd path)");
  assertEq(cons.underflowSamples(), 0, "no underflow during the run");
  ok("14. processAdd ramp continuity (additive hybrid)");
}

// ── 15. processAdd gain scaling ───────────────────────────────────────────
function testProcessAddGain(): void {
  const { bridge } = makeBridge(4);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  assert(pushRampFrame(bridge, scratch, 0), "frame 0 pushed");

  const GAIN = 2.5;
  const out = new Float32Array(QUANTUM);
  out.fill(0);
  cons.processAdd(out, GAIN);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], GAIN * i, `gain=${GAIN} sample ${i}`);
  }
  ok("15. processAdd gain scaling");
}

// ── 16. processAdd hybrid underflow preservation ──────────────────────────
function testProcessAddUnderflowPreservation(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const SENTINEL = 0xdead;
  const out = new Float32Array(QUANTUM);
  out.fill(SENTINEL);

  cons.processAdd(out); // ring empty from the start
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], SENTINEL, `hybrid underflow sample ${i} preserved`);
  }
  assertEq(cons.underflowSamples(), QUANTUM, "underflow counter increments");
  assertEq(cons.framesConsumed(), 0, "no frame consumed under full underflow");
  ok("16. processAdd hybrid underflow preservation");
}

// ── 17. processAdd mid-quantum hybrid underflow ───────────────────────────
function testProcessAddMidQuantumUnderflow(): void {
  // Small block lets us straddle the underflow boundary mid-quantum.
  const smallBlock = 80;
  const { bridge } = makeBridge(4, smallBlock);
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  scratch.blockIndex = 0n;
  for (let k = 0; k < smallBlock; k++) scratch.samples[k] = k + 1; // 1..80
  assert(bridge.push(scratch), "small-block frame pushed");

  const CARRIER = 7;
  const out = new Float32Array(QUANTUM);
  out.fill(CARRIER);
  cons.processAdd(out, 1.0, QUANTUM);

  // First 80 samples should be carrier + real ramp.
  for (let i = 0; i < smallBlock; i++) {
    assertEq(out[i], CARRIER + (i + 1), `mid-quantum additive sample ${i}`);
  }
  // Remaining 48 should be the untouched carrier (NOT zero-fill, NOT hold-last).
  for (let i = smallBlock; i < QUANTUM; i++) {
    assertEq(out[i], CARRIER, `mid-quantum carrier-survives sample ${i}`);
  }
  assertEq(
    cons.underflowSamples(),
    QUANTUM - smallBlock,
    "mid-quantum underflow tally"
  );
  ok("17. processAdd mid-quantum hybrid underflow");
}

// ── 18. processAdd telemetry parity with process() ────────────────────────
function testProcessAddTelemetryParity(): void {
  // Two consumers driven over identical bridges with identical traffic;
  // one uses process(), one uses processAdd. framesConsumed and
  // underflowSamples should track identically.
  const { bridge: bA } = makeBridge();
  const { bridge: bB } = makeBridge();
  const consA = new BridgeBlockConsumer(bA);
  const consB = new BridgeBlockConsumer(bB);
  const sA = bA.scratchFrame();
  const sB = bB.scratchFrame();

  // Push 2 frames into each.
  pushRampFrame(bA, sA, 0); pushRampFrame(bA, sA, 1);
  pushRampFrame(bB, sB, 0); pushRampFrame(bB, sB, 1);

  const outA = new Float32Array(QUANTUM);
  const outB = new Float32Array(QUANTUM);
  // Drain both fully (16 quanta) then one extra → underflow on both.
  for (let q = 0; q < 2 * BLOCK_SIZE / QUANTUM + 1; q++) {
    outA.fill(0); outB.fill(0);
    consA.process(outA);
    consB.processAdd(outB);
  }
  assertEq(
    consA.framesConsumed(),
    consB.framesConsumed(),
    "framesConsumed parity"
  );
  assertEq(
    consA.underflowSamples(),
    consB.underflowSamples(),
    "underflowSamples parity"
  );
  ok("18. processAdd telemetry parity with process()");
}

// ── 19. processAdd gain=0 advances cursor without modifying out ───────────
function testProcessAddGainZero(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  pushRampFrame(bridge, scratch, 0);

  const SENTINEL = 0xbeef;
  const out = new Float32Array(QUANTUM);
  out.fill(SENTINEL);
  cons.processAdd(out, 0.0);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], SENTINEL, `gain=0 leaves out[${i}] alone`);
  }
  // Cursor should have advanced: framesConsumed === 1 after one quantum
  // of the first frame (cursor at 128 of 1024, frame still in flight).
  assertEq(cons.framesConsumed(), 1, "frame pulled despite gain=0");
  assertEq(cons.remainingInFrame(), BLOCK_SIZE - QUANTUM, "cursor advanced");
  ok("19. processAdd gain=0 cursor advance");
}

// ── 20. processAdd bounds + finite-gain validation ────────────────────────
function testProcessAddBounds(): void {
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const out = new Float32Array(QUANTUM);
  let threw = false;
  try { cons.processAdd(out, 1.0, QUANTUM + 1); } catch { threw = true; }
  assert(threw, "count > out.length throws");
  threw = false;
  try { cons.processAdd(out, 1.0, -1); } catch { threw = true; }
  assert(threw, "negative count throws");
  threw = false;
  try { cons.processAdd(out, Number.NaN); } catch { threw = true; }
  assert(threw, "NaN gain throws");
  threw = false;
  try { cons.processAdd(out, Number.POSITIVE_INFINITY); } catch { threw = true; }
  assert(threw, "Infinity gain throws");
  ok("20. processAdd bounds + finite-gain validation");
}

// ── 21. process / processAdd cursor interop ───────────────────────────────
function testProcessAddCursorInterop(): void {
  // Interleaving process() and processAdd() on the same consumer should
  // produce a continuous ramp — the cursor is shared state.
  const { bridge } = makeBridge();
  const cons = new BridgeBlockConsumer(bridge);
  const scratch = bridge.scratchFrame();
  pushRampFrame(bridge, scratch, 0);
  pushRampFrame(bridge, scratch, 1);

  const out = new Float32Array(QUANTUM);
  // Quantum 1: process() — out[i] = ramp[i] = i.
  out.fill(0);
  cons.process(out);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], i, `mixed q=0 sample ${i}`);
  }
  // Quantum 2: processAdd onto carrier 1000 — out[i] = 1000 + ramp[i].
  out.fill(1000);
  cons.processAdd(out);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], 1000 + (QUANTUM + i), `mixed q=1 sample ${i}`);
  }
  // Quantum 3: back to process() — out[i] = ramp[i].
  out.fill(99);
  cons.process(out);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], 2 * QUANTUM + i, `mixed q=2 sample ${i}`);
  }
  ok("21. process / processAdd cursor interop");
}

// ── 22. Stereo: mono backward-compat ──────────────────────────────────────
function testStereoMonoBackcompat(): void {
  // channels omitted and channels:1 must construct identically and produce
  // byte-identical output to the legacy path (the pin-3 ramp).
  for (const opts of [undefined, { channels: 1 as const }]) {
    const { bridge } = makeBridge(8);
    const cons = new BridgeBlockConsumer(bridge, opts);
    assertEq(cons.blockSize, BLOCK_SIZE, "mono blockSize === arrayLength");
    assertEq(cons.channels, 1, "channels === 1");
    assertEq(cons.layout, "mono", "layout === 'mono'");
    const scratch = bridge.scratchFrame();
    const F = 3;
    for (let f = 0; f < F; f++) pushRampFrame(bridge, scratch, f);
    const out = new Float32Array(QUANTUM);
    let observed = 0;
    for (let q = 0; q < (F * BLOCK_SIZE) / QUANTUM; q++) {
      cons.process(out);
      for (let i = 0; i < QUANTUM; i++) {
        assertEq(out[i], observed, `mono backcompat sample ${observed}`);
        observed++;
      }
    }
  }
  // layout:'interleaved' with channels:1 normalizes to mono (harmless).
  {
    const { bridge } = makeBridge(4);
    const cons = new BridgeBlockConsumer(bridge, { channels: 1, layout: "interleaved" });
    assertEq(cons.layout, "mono", "channels:1 + interleaved normalizes to mono");
  }
  ok("22. stereo mono backward-compat");
}

// ── 23. Interleaved construction ───────────────────────────────────────────
function testInterleavedConstruction(): void {
  const { bridge } = makeInterleavedBridge(8, 1024, 2);
  const cons = new BridgeBlockConsumer(bridge, { channels: 2, layout: "interleaved" });
  assertEq(cons.blockSize, 1024, "blockSize === arrayLength / channels");
  assertEq(cons.channels, 2, "channels === 2");
  assertEq(cons.layout, "interleaved", "layout === 'interleaved'");
  assertEq(cons.samplesField, "samples", "samplesField surfaced");
  // layout omitted defaults to interleaved for channels>1.
  const cons2 = new BridgeBlockConsumer(bridge, { channels: 2 });
  assertEq(cons2.layout, "interleaved", "channels>1 defaults layout to interleaved");
  ok("23. interleaved construction");
}

// ── 24. Construction validation ────────────────────────────────────────────
function testInterleavedValidation(): void {
  // arrayLength not divisible by channels (1025 % 2 !== 0).
  {
    const schema = defineSchema({ blockIndex: u64(), samples: f32Array(1025) });
    const { sab } = Bridge.allocate(4, schema);
    const bridge = new Bridge(sab, 4, schema);
    let threw = false;
    try { new BridgeBlockConsumer(bridge, { channels: 2 }); } catch { threw = true; }
    assert(threw, "non-divisible arrayLength throws");
  }
  // channels>1 with layout:'mono' throws.
  {
    const { bridge } = makeInterleavedBridge(4, 512, 2);
    let threw = false;
    try { new BridgeBlockConsumer(bridge, { channels: 2, layout: "mono" }); } catch { threw = true; }
    assert(threw, "channels>1 + layout:'mono' throws");
    // layout:'planar' throws (not-yet-implemented).
    threw = false;
    try { new BridgeBlockConsumer(bridge, { channels: 2, layout: "planar" }); } catch { threw = true; }
    assert(threw, "layout:'planar' throws");
  }
  // channels:3 (not in the allowed set) throws.
  {
    const { bridge } = makeInterleavedBridge(4, 512, 1);
    let threw = false;
    try { new BridgeBlockConsumer(bridge, { channels: 3 as any }); } catch { threw = true; }
    assert(threw, "channels:3 (not allowed) throws");
  }
  ok("24. interleaved construction validation");
}

// ── 25. processAddStereo cursor advancement (headline) ─────────────────────
function testProcessAddStereo(): void {
  const C = 2, B = 1024;
  const { bridge } = makeInterleavedBridge(8, B, C);
  const cons = new BridgeBlockConsumer(bridge, { channels: 2, layout: "interleaved" });
  const scratch = bridge.scratchFrame();
  const F = 3;
  for (let f = 0; f < F; f++) {
    assert(pushInterleavedRampFrame(bridge, scratch, f, C, B), `frame ${f} pushed`);
  }

  const L = new Float32Array(QUANTUM);
  const R = new Float32Array(QUANTUM);
  let gj = 0; // per-channel global index
  const quanta = (F * B) / QUANTUM;
  for (let q = 0; q < quanta; q++) {
    L.fill(0); R.fill(0);
    const mixed = cons.processAddStereo(L, R);
    assertEq(mixed, QUANTUM, `q=${q} full window mixed`);
    for (let i = 0; i < QUANTUM; i++) {
      assertEq(L[i], expectedChannelValue(gj, 0, C), `q=${q} L sample (gj=${gj})`);
      assertEq(R[i], expectedChannelValue(gj, 1, C), `q=${q} R sample (gj=${gj})`);
      gj++;
    }
  }
  // One cursor advance per call → one frame pulled per B per-channel samples,
  // NOT per B*C. F frames cover F*B per-channel samples.
  assertEq(cons.framesConsumed(), F, "framesConsumed === F (one pull per per-channel block)");
  assertEq(cons.underflowSamples(), 0, "no underflow");

  // Non-divisor quantum variant: 50-sample quanta straddle frame boundaries.
  {
    const { bridge: b2 } = makeInterleavedBridge(4, B, C);
    const c2 = new BridgeBlockConsumer(b2, { channels: 2 });
    const s2 = b2.scratchFrame();
    for (let f = 0; f < 2; f++) pushInterleavedRampFrame(b2, s2, f, C, B);
    const Q = 50;
    const l2 = new Float32Array(Q), r2 = new Float32Array(Q);
    let g = 0;
    const total = 2 * B;
    const nQ = Math.floor(total / Q);
    for (let q = 0; q < nQ; q++) {
      l2.fill(0); r2.fill(0);
      c2.processAddStereo(l2, r2);
      for (let i = 0; i < Q; i++) {
        assertEq(l2[i], expectedChannelValue(g, 0, C), `nd L g=${g}`);
        assertEq(r2[i], expectedChannelValue(g, 1, C), `nd R g=${g}`);
        g++;
      }
    }
  }
  ok("25. processAddStereo cursor advancement");
}

// ── 26. processAddChannel single-channel + advance-on-every-call ──────────
function testProcessAddChannel(): void {
  const C = 2, B = 1024;
  const { bridge } = makeInterleavedBridge(8, B, C);
  const cons = new BridgeBlockConsumer(bridge, { channels: 2 });
  const scratch = bridge.scratchFrame();
  for (let f = 0; f < 2; f++) pushInterleavedRampFrame(bridge, scratch, f, C, B);

  const out = new Float32Array(QUANTUM);
  // First call: channel 1, window [0, QUANTUM).
  out.fill(0);
  const m1 = cons.processAddChannel(out, 1);
  assertEq(m1, QUANTUM, "first call mixes full window");
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], expectedChannelValue(i, 1, C), `ch1 first window sample ${i}`);
  }
  // Second call advances to the NEXT window — proves advance-on-every-call.
  out.fill(0);
  cons.processAddChannel(out, 1);
  for (let i = 0; i < QUANTUM; i++) {
    assertEq(out[i], expectedChannelValue(QUANTUM + i, 1, C), `ch1 second window sample ${i}`);
  }
  // channelIndex out of range throws.
  let threw = false;
  try { cons.processAddChannel(out, 2); } catch { threw = true; }
  assert(threw, "channelIndex >= channels throws");
  threw = false;
  try { cons.processAddChannel(out, -1); } catch { threw = true; }
  assert(threw, "negative channelIndex throws");
  ok("26. processAddChannel single-channel + advance contract");
}

// ── 27. Interleaved underflow preserves the carrier per channel ────────────
function testInterleavedUnderflow(): void {
  const C = 2, B = 1024;
  // Full-window underflow: ring empty from the start.
  {
    const { bridge } = makeInterleavedBridge(4, B, C);
    const cons = new BridgeBlockConsumer(bridge, { channels: 2 });
    const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
    L.fill(111); R.fill(222);
    const mixed = cons.processAddStereo(L, R);
    assertEq(mixed, 0, "nothing mixed under full underflow");
    for (let i = 0; i < QUANTUM; i++) {
      assertEq(L[i], 111, `L carrier preserved ${i}`);
      assertEq(R[i], 222, `R carrier preserved ${i}`);
    }
    // Per-channel units: K window samples → +K (NOT 2K).
    assertEq(cons.underflowSamples(), QUANTUM, "underflowSamples per-channel units");
    assertEq(cons.framesConsumed(), 0, "no frame consumed");
  }
  // Mid-window underflow with a small block: head gets real adds, both tails
  // keep their carrier.
  {
    const smallB = 80;
    const { bridge } = makeInterleavedBridge(4, smallB, C);
    const cons = new BridgeBlockConsumer(bridge, { channels: 2 });
    const scratch = bridge.scratchFrame();
    pushInterleavedRampFrame(bridge, scratch, 0, C, smallB); // one frame only
    const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
    L.fill(111); R.fill(222);
    const mixed = cons.processAddStereo(L, R, 1.0, QUANTUM);
    assertEq(mixed, smallB, "mid-window mixes one block worth");
    for (let i = 0; i < smallB; i++) {
      assertEq(L[i], 111 + expectedChannelValue(i, 0, C), `L head add ${i}`);
      assertEq(R[i], 222 + expectedChannelValue(i, 1, C), `R head add ${i}`);
    }
    for (let i = smallB; i < QUANTUM; i++) {
      assertEq(L[i], 111, `L tail carrier ${i}`);
      assertEq(R[i], 222, `R tail carrier ${i}`);
    }
    assertEq(cons.underflowSamples(), QUANTUM - smallB, "mid-window per-channel tally");
  }
  ok("27. interleaved underflow preserves carrier per channel");
}

// ── 28. Legacy methods guarded under multichannel ──────────────────────────
function testLegacyGuardedMultichannel(): void {
  const { bridge } = makeInterleavedBridge(4, 512, 2);
  const cons = new BridgeBlockConsumer(bridge, { channels: 2 });
  const out = new Float32Array(QUANTUM);
  let threw = false;
  try { cons.process(out); } catch { threw = true; }
  assert(threw, "process() throws under channels>1");
  threw = false;
  try { cons.processAdd(out); } catch { threw = true; }
  assert(threw, "processAdd() throws under channels>1");
  // processAddStereo requires channels>=2 — fine here; a mono consumer throws.
  {
    const { bridge: bm } = makeBridge(4);
    const cm = new BridgeBlockConsumer(bm);
    const l = new Float32Array(QUANTUM), r = new Float32Array(QUANTUM);
    threw = false;
    try { cm.processAddStereo(l, r); } catch { threw = true; }
    assert(threw, "processAddStereo throws when channels < 2");
  }
  ok("28. legacy methods guarded under multichannel");
}

// ── 29. Telemetry parity + reset() ─────────────────────────────────────────
function testInterleavedTelemetry(): void {
  const C = 2, B = 256;
  const { bridge } = makeInterleavedBridge(4, B, C);
  const cons = new BridgeBlockConsumer(bridge, { channels: 2 });
  const scratch = bridge.scratchFrame();
  pushInterleavedRampFrame(bridge, scratch, 0, C, B);
  pushInterleavedRampFrame(bridge, scratch, 1, C, B);

  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  // Drain both frames fully (2*B per-channel samples / QUANTUM quanta).
  for (let q = 0; q < (2 * B) / QUANTUM; q++) {
    L.fill(0); R.fill(0);
    cons.processAddStereo(L, R);
  }
  assertEq(cons.framesConsumed(), 2, "framesConsumed counts ring pulls (2)");
  assertEq(cons.underflowSamples(), 0, "no underflow during the run");

  // One more quantum → full underflow, per-channel units.
  cons.processAddStereo(L, R);
  assertEq(cons.underflowSamples(), QUANTUM, "underflow per-channel units");

  // reset() zeroes both and discards the in-flight interleaved frame.
  cons.reset();
  assertEq(cons.framesConsumed(), 0, "reset zeroes framesConsumed");
  assertEq(cons.underflowSamples(), 0, "reset zeroes underflowSamples");
  assertEq(cons.remainingInFrame(), 0, "reset discards in-flight frame");
  ok("29. interleaved telemetry parity + reset");
}

// ── 0.9.51 underflow telemetry helpers ─────────────────────────────────────
function approx(actual: number, expected: number, eps: number, msg: string): void {
  assert(Math.abs(actual - expected) <= eps,
    `${msg}\n  expected ≈ ${expected}\n  actual    ${actual}`);
}

// ── 30. underflowRate(windowMs) (0.9.51) ────────────────────────────────────
function testUnderflowRate(): void {
  const SR = 48000;
  const B = 128; // blockSize === quantum → exactly one pull per process() call.
  const { bridge } = makeBridge(64, B);
  const cons = new BridgeBlockConsumer(bridge, {
    sampleRate: SR,
    underflowWindowMs: 1000,
  });
  assertEq(cons.sampleRate, SR, "sampleRate resolved from opt");
  assertEq(cons.underflowWindowMs, 1000, "underflowWindowMs resolved from opt");

  const scratch = bridge.scratchFrame();
  const out = new Float32Array(B);

  // 40 successful quanta → no underflow, rate 0.
  for (let f = 0; f < 40; f++) pushRampFrame(bridge, scratch, f, B);
  for (let q = 0; q < 40; q++) cons.process(out);
  assertEq(cons.underflowSamples(), 0, "no underflow during the fed run");
  approx(cons.underflowRate(1000), 0, 1e-9, "rate is 0 when nothing underflowed");

  // 40 starved quanta → recent window is all underflow.
  for (let q = 0; q < 40; q++) cons.process(out);
  // A ~50 ms window (≈18.75 quanta) lands entirely inside the underflow run.
  const recent = cons.underflowRate(50);
  approx(recent, 1.0, 1e-9, "recent all-underflow window → rate 1");

  // Full 1 s window spans 40 fed + 40 starved quanta → ≈ half underflow.
  const mixed = cons.underflowRate(1000);
  approx(mixed, 0.5, 0.05, "mixed window → ≈ half underflow");

  // windowMs clamps to underflowWindowMs (1000): a 100 s query equals 1 s.
  assertEq(cons.underflowRate(100000), cons.underflowRate(1000),
    "windowMs clamps to underflowWindowMs");

  // No sampleRate → the ms-based getters throw.
  const { bridge: b2 } = makeBridge(4, B);
  const noRate = new BridgeBlockConsumer(b2);
  assertEq(noRate.sampleRate, 0, "no sampleRate resolves to 0");
  let threw = false;
  try { noRate.underflowRate(1000); } catch { threw = true; }
  assert(threw, "underflowRate throws without a sampleRate");

  // Bad windowMs throws.
  threw = false;
  try { cons.underflowRate(0); } catch { threw = true; }
  assert(threw, "windowMs <= 0 throws");

  ok("30. underflowRate(windowMs)");
}

// ── 31. lastSuccessfulPullTime / elapsedSeconds (0.9.51) ────────────────────
function testStallClock(): void {
  const SR = 48000;
  const B = 128; // one pull per process() call.
  const { bridge } = makeBridge(16, B);
  const cons = new BridgeBlockConsumer(bridge, { sampleRate: SR });
  const scratch = bridge.scratchFrame();
  const out = new Float32Array(B);

  for (let f = 0; f < 5; f++) pushRampFrame(bridge, scratch, f, B);
  for (let q = 0; q < 5; q++) cons.process(out);

  // After 5 successful quanta: emitted = 5*128 = 640; the last pull happened
  // at the start of call #5, when emitted-so-far was 4*128 = 512.
  approx(cons.elapsedSeconds(), 640 / SR, 1e-12, "elapsedSeconds = emitted/SR");
  approx(cons.lastSuccessfulPullTime(), 512 / SR, 1e-12,
    "lastSuccessfulPullTime = emitted-at-pull / SR");
  approx(cons.elapsedSeconds() - cons.lastSuccessfulPullTime(), 128 / SR, 1e-12,
    "stall age = one quantum just after a pull");

  // 3 starved quanta: elapsed keeps advancing, last-pull-time stalls.
  for (let q = 0; q < 3; q++) cons.process(out);
  approx(cons.elapsedSeconds(), 1024 / SR, 1e-12, "elapsed advances across starve");
  approx(cons.lastSuccessfulPullTime(), 512 / SR, 1e-12,
    "lastSuccessfulPullTime stalls across the underflow run");
  approx(cons.elapsedSeconds() - cons.lastSuccessfulPullTime(), 512 / SR, 1e-12,
    "stall age grows by quantum ÷ sampleRate per starved call");

  // throws without a rate.
  const { bridge: b2 } = makeBridge(4, B);
  const noRate = new BridgeBlockConsumer(b2);
  let threw = false;
  try { noRate.lastSuccessfulPullTime(); } catch { threw = true; }
  assert(threw, "lastSuccessfulPullTime throws without a sampleRate");
  threw = false;
  try { noRate.elapsedSeconds(); } catch { threw = true; }
  assert(threw, "elapsedSeconds throws without a sampleRate");

  ok("31. lastSuccessfulPullTime / elapsedSeconds");
}

// ── 32. reset() zeroes the new telemetry state (0.9.51) ─────────────────────
function testResetTelemetry(): void {
  const SR = 48000;
  const B = 128;
  const { bridge } = makeBridge(16, B);
  const cons = new BridgeBlockConsumer(bridge, { sampleRate: SR });
  const scratch = bridge.scratchFrame();
  const out = new Float32Array(B);
  for (let f = 0; f < 5; f++) pushRampFrame(bridge, scratch, f, B);
  for (let q = 0; q < 5; q++) cons.process(out);
  for (let q = 0; q < 3; q++) cons.process(out); // some underflow too

  assert(cons.elapsedSeconds() > 0, "clock advanced before reset");
  cons.reset();
  approx(cons.elapsedSeconds(), 0, 1e-12, "reset zeroes elapsedSeconds");
  approx(cons.lastSuccessfulPullTime(), 0, 1e-12, "reset zeroes last-pull-time");
  approx(cons.underflowRate(1000), 0, 1e-12, "reset clears underflow history");
  ok("32. reset() zeroes the new telemetry state");
}

// ── 33. instrument-every-path (0.9.51) ──────────────────────────────────────
function testTelemetryEveryPath(): void {
  const SR = 48000;
  const B = 128;

  // process()
  {
    const { bridge } = makeBridge(8, B);
    const cons = new BridgeBlockConsumer(bridge, { sampleRate: SR });
    const scratch = bridge.scratchFrame();
    pushRampFrame(bridge, scratch, 0, B);
    const out = new Float32Array(B);
    cons.process(out);                 // 1 successful
    cons.process(out);                 // 1 starved
    approx(cons.elapsedSeconds(), (2 * B) / SR, 1e-12, "process: clock += 2 quanta");
    approx(cons.lastSuccessfulPullTime(), 0, 1e-12, "process: pull at emitted 0");
    assert(cons.underflowRate(50) > 0, "process: underflowRate reflects starve");
  }
  // processAdd()
  {
    const { bridge } = makeBridge(8, B);
    const cons = new BridgeBlockConsumer(bridge, { sampleRate: SR });
    const scratch = bridge.scratchFrame();
    pushRampFrame(bridge, scratch, 0, B);
    const out = new Float32Array(B);
    cons.processAdd(out);
    cons.processAdd(out);
    approx(cons.elapsedSeconds(), (2 * B) / SR, 1e-12, "processAdd: clock += 2 quanta");
    approx(cons.lastSuccessfulPullTime(), 0, 1e-12, "processAdd: pull at emitted 0");
    assert(cons.underflowRate(50) > 0, "processAdd: underflowRate reflects starve");
  }
  // processAddStereo()
  {
    const C = 2;
    const { bridge } = makeInterleavedBridge(8, B, C);
    const cons = new BridgeBlockConsumer(bridge, { channels: 2, sampleRate: SR });
    const scratch = bridge.scratchFrame();
    pushInterleavedRampFrame(bridge, scratch, 0, C, B);
    const L = new Float32Array(B), R = new Float32Array(B);
    cons.processAddStereo(L, R);       // successful
    cons.processAddStereo(L, R);       // starved
    // Per-channel units: each call emits B per-channel samples.
    approx(cons.elapsedSeconds(), (2 * B) / SR, 1e-12, "stereo: clock += 2 quanta");
    approx(cons.lastSuccessfulPullTime(), 0, 1e-12, "stereo: pull at emitted 0");
    assert(cons.underflowRate(50) > 0, "stereo: underflowRate reflects starve");
  }
  ok("33. instrument-every-path telemetry");
}

// ── 34. (0.9.55) process() copy equivalence — explicit loop == subarray ─────
// The 0.9.55 patch replaced `out.set(samples.subarray(...))` with an explicit
// cached-locals loop to drop the per-chunk typed-array view allocation. This
// pin proves the substitution is byte-for-byte faithful across an irregular
// chunk schedule (exact-multiple, non-divisor, 1-sample, and a > blockSize
// multi-frame straddle — each lands the cursor at a different phase relative to
// the 1024 block boundary) AND that the hold-last sample read off the same copy
// still tracks the final value.
function testProcessCopyEquivalence(): void {
  const { bridge } = makeBridge(8);
  const cons = new BridgeBlockConsumer(bridge, { underflowPolicy: "hold-last" });
  const scratch = bridge.scratchFrame();

  const F = 3;
  const total = F * BLOCK_SIZE;
  // Mirror of every pushed sample — the faithful-copy reference (exactly what
  // the old `out.set(subarray(...))` would have produced).
  const ref = new Float32Array(total);
  for (let f = 0; f < F; f++) {
    assert(pushRampFrame(bridge, scratch, f), `frame ${f} pushed`);
    for (let k = 0; k < BLOCK_SIZE; k++) ref[f * BLOCK_SIZE + k] = f * BLOCK_SIZE + k;
  }

  const chunkPattern = [128, 50, 1, 1000, 333, 7, 1024, 200];
  let observed = 0;
  let pi = 0;
  while (observed < total) {
    const take = Math.min(chunkPattern[pi % chunkPattern.length]!, total - observed);
    pi++;
    const out = new Float32Array(take);
    cons.process(out, take);
    for (let i = 0; i < take; i++) {
      assertEq(out[i], ref[observed + i], `chunk@${observed} (size ${take}) sample ${i} matches faithful copy`);
    }
    observed += take;
  }
  assertEq(observed, total, "consumed exactly F*blockSize samples");
  assertEq(cons.underflowSamples(), 0, "no underflow while real samples remained");

  // hold-last underflow after the stream is drained must reflect the final
  // copied sample — proving holdSample tracked through the explicit-loop copy.
  const lastCopied = ref[total - 1] as number;
  const tail = new Float32Array(16);
  cons.process(tail, 16);
  for (let i = 0; i < 16; i++) {
    assertEq(tail[i], lastCopied, `hold-last fill ${i} == final copied sample`);
  }

  ok("34. (0.9.55) process() explicit-loop copy is byte-identical + holdSample intact");
}

function main(): void {
  testConstruction();
  testSchemaValidation();
  testRampContinuity();
  testNonDivisorQuantum();
  testMultiFrameSpan();
  testUnderflowZeroFill();
  testUnderflowHoldLast();
  testStrictUnderflowWrapper();
  testMidQuantumUnderflow();
  testReset();
  testTelemetry();
  testBounds();
  testPolicyRoundtrip();
  testProcessAddRampContinuity();
  testProcessAddGain();
  testProcessAddUnderflowPreservation();
  testProcessAddMidQuantumUnderflow();
  testProcessAddTelemetryParity();
  testProcessAddGainZero();
  testProcessAddBounds();
  testProcessAddCursorInterop();
  testStereoMonoBackcompat();
  testInterleavedConstruction();
  testInterleavedValidation();
  testProcessAddStereo();
  testProcessAddChannel();
  testInterleavedUnderflow();
  testLegacyGuardedMultichannel();
  testInterleavedTelemetry();
  testUnderflowRate();
  testStallClock();
  testResetTelemetry();
  testTelemetryEveryPath();
  testProcessCopyEquivalence();
  console.log("all BridgeBlockConsumer pins green");
}

main();
