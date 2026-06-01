/**
 * MpmcRing.test.ts — single-thread API pins for the wait-free MP→SC primitive
 * (Apollo Frontier 3, Stage 1, 0.9.907). Exercises the REAL src/MpmcRing.ts
 * class through deterministic single-thread sequences. The exhaustive
 * interleaving proof lives in MpmcRing.interleaving.test.ts; the cross-thread
 * stress in MpmcRing.concurrent.test.ts. No test framework.
 *
 * Pins (numbered; append new ones at the end + register in main()):
 *   1.  byteLength / create round-trip + layout sanity.
 *   2.  construction guards (capacity power-of-two/range, producerCount, slack).
 *   3.  push/pull bit-exact round-trip across every FieldKind + array fields.
 *   4.  drop-newest-when-full is counted; no payload mutation, no ticket hole.
 *   5.  empty-pull returns false; available() reflects in-flight.
 *   6.  head-of-line gap rides over (white-box: an uncommitted head → empty,
 *       cursor does NOT skip; once committed it delivers in FIFO order).
 *   7.  overload-net counted-loss path (white-box: W − D > CAPACITY → catch up,
 *       count loss, deliver the oldest live frame, never tear).
 *   8.  producerCount > 1 reserves SLACK (usable depth = CAPACITY − SLACK).
 *   9.  flow_scale lane (0.9.941, DAG back-pressure Stage 1a): seeded 1.0 before
 *       the first pull; sustained-full occupancy drives the hint DOWN past 0.5
 *       (proving the WIDENED DAG clamp is active — a default [0.5,2.0]
 *       controller would pin at 0.5); sustained-low occupancy drives it UP
 *       toward 2.0; every sample stays in [DAG_FLOW_SCALE_MIN, 2.0]; the lane
 *       is a pure side channel (no tear/overrun). The behavioral "drops
 *       collapse across a multi-hop DAG" is the Stage-0 probe's deliverable
 *       (bench/dag-backpressure-probe.mjs, same controller); this pin proves
 *       the lane MECHANICS deterministically through the real pull path.
 */

import { assert, assertEq } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array,
} from "../src/index.js";
import { MpmcRing, MPMC_HEADER_BYTES } from "../src/MpmcRing.js";
import { DAG_FLOW_SCALE_MIN } from "../src/AdaptiveFlowController.js";

// Silence (and capture) the one-shot experimental warning so it doesn't
// pollute the suite output, while still pinning that it fires.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

const allKinds = defineSchema({
  a_u64: u64(),
  a_i64: i64(),
  a_f64: f64(),
  a_u32: u32(),
  a_i32: i32(),
  a_f32: f32(),
  a_u16: u16(),
  a_i16: i16(),
  a_u8: u8(),
  a_i8: i8(),
  arr: f64Array(4),
  iarr: i32Array(3),
});

let passed = 0;
function pass(name: string): void {
  passed++;
  console.log(`  ok ${name}`);
}

/** Local "throws and message matches" helper (the shared _assert has none). */
function assertThrows(fn: () => unknown, re: RegExp, msg: string): void {
  let threw: unknown;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== undefined, `${msg}: expected throw, got none`);
  const text = threw instanceof Error ? threw.message : String(threw);
  assert(re.test(text), `${msg}: message ${JSON.stringify(text)} !~ ${re}`);
}

// Pin 1 — byteLength / create round-trip + layout sanity.
function pin1_layout(): void {
  const cap = 8;
  const len = MpmcRing.byteLength(allKinds, cap);
  // header(32) + gen(align8(cap*4)) + payload(cap*frameByteSize)
  const genBytes = (cap * 4 + 7) & ~7;
  const expected = 32 + genBytes + cap * allKinds.frameByteSize;
  assertEq(len, expected, "byteLength matches documented layout");
  assert(MPMC_HEADER_BYTES === 32, "header is 32 bytes");

  const { ring, sab } = MpmcRing.create(allKinds, cap, { producerCount: 3 });
  assertEq(sab.byteLength, len, "create allocates exactly byteLength");
  assertEq(ring.capacity, cap, "capacity getter");
  assertEq(ring.producerCount, 3, "producerCount getter");
  assertEq(ring.available(), 0, "fresh ring is empty");
  assertEq(ring.droppedFrames(), 0, "fresh ring has no drops");
  assertEq(ring.overrunLostFrames(), 0, "fresh ring has no overrun loss");
  assertEq(ring.tornFrameCount(), 0, "fresh ring has no torn frames");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  pass("pin1: byteLength / create / layout sanity");
}

// Pin 2 — construction guards.
function pin2_guards(): void {
  const sabBig = new SharedArrayBuffer(MpmcRing.byteLength(allKinds, 8));
  assertThrows(() => new MpmcRing(sabBig, allKinds, 6), /power of two/, "non-pow2 capacity");
  assertThrows(() => new MpmcRing(sabBig, allKinds, 1), /power of two/, "capacity 1");
  assertThrows(() => new MpmcRing(sabBig, allKinds, (1 << 30) * 2), /power of two/, "capacity too big");
  assertThrows(() => new MpmcRing(sabBig, allKinds, 8, { producerCount: 0 }), /producerCount/, "producerCount 0");
  assertThrows(() => new MpmcRing(sabBig, allKinds, 8, { producerCount: 1.5 }), /producerCount/, "producerCount non-int");
  const sabSmallCap = new SharedArrayBuffer(MpmcRing.byteLength(allKinds, 2));
  assertThrows(() => new MpmcRing(sabSmallCap, allKinds, 2, { producerCount: 4 }), /SLACK/, "capacity <= slack");
  const tiny = new SharedArrayBuffer(16);
  assertThrows(() => new MpmcRing(tiny, allKinds, 8), /too small/, "SAB too small");
  pass("pin2: construction guards");
}

function makeFrame() {
  return {
    a_u64: 0xfedcba9876543210n,
    a_i64: -1234567890123456n,
    a_f64: -3.141592653589793,
    a_u32: 0xdeadbeef,
    a_i32: -2000000000,
    a_f32: Math.fround(2.5),
    a_u16: 0xbeef,
    a_i16: -12345,
    a_u8: 0xff,
    a_i8: -120,
    arr: new Float64Array([1.5, -2.25, 1e300, -0]),
    iarr: new Int32Array([-1, 2147483647, -2147483648]),
  };
}

// Pin 3 — push/pull bit-exact round-trip across every FieldKind.
function pin3_bitExact(): void {
  const { ring } = MpmcRing.create(allKinds, 4, { producerCount: 1 });
  const frame = makeFrame();
  assert(ring.push(frame as any), "push succeeds");
  assertEq(ring.available(), 1, "one in flight");
  const out = ring.createFrame();
  assert(ring.pull(out), "pull delivers");
  const o = out as any;
  assertEq(o.a_u64, frame.a_u64, "u64 bit-exact");
  assertEq(o.a_i64, frame.a_i64, "i64 bit-exact");
  assertEq(o.a_f64, frame.a_f64, "f64 bit-exact");
  assertEq(o.a_u32, frame.a_u32, "u32 bit-exact");
  assertEq(o.a_i32, frame.a_i32, "i32 bit-exact");
  assertEq(o.a_f32, frame.a_f32, "f32 bit-exact");
  assertEq(o.a_u16, frame.a_u16, "u16 bit-exact");
  assertEq(o.a_i16, frame.a_i16, "i16 bit-exact");
  assertEq(o.a_u8, frame.a_u8, "u8 bit-exact");
  assertEq(o.a_i8, frame.a_i8, "i8 bit-exact");
  assertEq((o.arr as Float64Array).join(","), "1.5,-2.25,1e+300,0", "f64 array bit-exact");
  assertEq((o.iarr as Int32Array).join(","), "-1,2147483647,-2147483648", "i32 array bit-exact");
  assertEq(ring.available(), 0, "drained");
  assert(!ring.pull(out), "empty pull returns false");
  pass("pin3: bit-exact round-trip across all FieldKinds");
}

// Pin 4 — drop-newest-when-full is counted (producerCount 1 → slack 0 →
// envelope = in-flight < CAPACITY).
function pin4_dropFull(): void {
  const cap = 4;
  const { ring } = MpmcRing.create(allKinds, cap, { producerCount: 1 });
  const f = makeFrame();
  for (let i = 0; i < cap; i++) assert(ring.push(f as any), `push ${i} fits`);
  assertEq(ring.available(), cap, "ring full at capacity");
  assert(!ring.push(f as any), "push when full returns false");
  assert(!ring.push(f as any), "second over-full push also false");
  assertEq(ring.droppedFrames(), 2, "two drops counted");
  assertEq(ring.available(), cap, "no ticket consumed by a drop (no hole)");
  const out = ring.createFrame();
  let n = 0;
  while (ring.pull(out)) n++;
  assertEq(n, cap, "exactly capacity frames delivered, none lost");
  assertEq(ring.overrunLostFrames(), 0, "envelope held: no overrun loss");
  assertEq(ring.tornFrameCount(), 0, "no torn frames");
  pass("pin4: drop-newest-when-full counted, no hole");
}

// Pin 5 — empty-pull + available().
function pin5_emptyAndAvailable(): void {
  const { ring } = MpmcRing.create(allKinds, 4, { producerCount: 1 });
  const out = ring.createFrame();
  assert(!ring.pull(out), "pull on empty returns false");
  assertEq(ring.available(), 0, "available 0 when empty");
  const f = makeFrame();
  ring.push(f as any);
  ring.push(f as any);
  assertEq(ring.available(), 2, "available reflects two in flight");
  ring.pull(out);
  assertEq(ring.available(), 1, "available decremented after pull");
  pass("pin5: empty-pull + available()");
}

// Pin 6 — head-of-line gap rides over (white-box). Push two frames (slots 0,1
// published, gens 0,1), consume neither, then simulate an uncommitted head by
// regressing slot 0's generation to "not committed". pull() must return false
// WITHOUT advancing the cursor; once the head is re-committed it delivers in
// FIFO order.
function pin6_headOfLineGap(): void {
  const cap = 4;
  const { ring, sab } = MpmcRing.create(allKinds, cap, { producerCount: 2 });
  const fA = makeFrame();
  const fB = makeFrame();
  (fA as any).a_i32 = 111;
  (fB as any).a_i32 = 222;
  assert(ring.push(fA as any), "push ticket 0 → slot 0");
  assert(ring.push(fB as any), "push ticket 1 → slot 1");

  const gen = new Int32Array(sab, MPMC_HEADER_BYTES, cap);
  const savedGen0 = gen[0]!;
  // Regress slot 0 to "lap before lap 0" → head ticket 0 reads as uncommitted.
  Atomics.store(gen, 0, (0 - cap) | 0);

  const out = ring.createFrame();
  assert(!ring.pull(out), "uncommitted head → pull returns empty (gap rides over)");
  assertEq(ring.available(), 2, "cursor did NOT skip the gap");

  // Re-commit the head; now FIFO delivery resumes.
  Atomics.store(gen, 0, savedGen0);
  assert(ring.pull(out), "head re-committed → delivers");
  assertEq((out as any).a_i32, 111, "delivered ticket 0 first (FIFO)");
  assert(ring.pull(out), "delivers next");
  assertEq((out as any).a_i32, 222, "delivered ticket 1 second (FIFO)");
  assert(!ring.pull(out), "drained");
  assertEq(ring.tornFrameCount(), 0, "no torn frames");
  pass("pin6: head-of-line gap rides over (FIFO preserved)");
}

// Pin 7 — overload-net counted-loss path (white-box). Fill the ring, then poke
// the enqueueTicket far ahead so W − D > CAPACITY (an envelope violation). The
// consumer's catch-up must count the lapped loss, jump the cursor to W −
// CAPACITY, and deliver the oldest *live* frame — never tear.
function pin7_overloadNet(): void {
  const cap = 4;
  const { ring, sab } = MpmcRing.create(allKinds, cap, { producerCount: 1 });
  const frames = [10, 20, 30, 40];
  for (const v of frames) {
    const f = makeFrame();
    (f as any).a_i32 = v;
    assert(ring.push(f as any), `push ${v}`);
  }
  // Slots 0..3 hold gens 0..3 (frames 10,20,30,40). Pretend two more tickets
  // (4,5) were claimed and lapped: bump enqueueTicket to 6, leave dequeuePos 0.
  const header = new Int32Array(sab, 0, 8);
  Atomics.store(header, 0, 6); // enqueueTicket = 6
  // Now W − D = 6 > CAPACITY(4): catch-up target = 6 − 4 = 2 → drop tickets 0,1.
  const out = ring.createFrame();
  assert(ring.pull(out), "delivers after catch-up");
  assertEq((out as any).a_i32, 30, "delivered the oldest LIVE frame (ticket 2)");
  assertEq(ring.overrunLostFrames(), 2, "counted exactly the 2 lapped losses");
  assert(ring.pull(out), "delivers next live frame");
  assertEq((out as any).a_i32, 40, "delivered ticket 3");
  assert(!ring.pull(out), "no more live frames (slots 0,1 read as uncommitted)");
  assertEq(ring.tornFrameCount(), 0, "overload net never tears");
  pass("pin7: overload-net counted-loss path");
}

// Pin 8 — producerCount > 1 reserves SLACK: usable depth = CAPACITY − SLACK.
function pin8_slackReserve(): void {
  const cap = 8;
  const producerCount = 3; // slack = 2 → usable depth 6
  const { ring } = MpmcRing.create(allKinds, cap, { producerCount });
  const f = makeFrame();
  let n = 0;
  while (ring.push(f as any)) n++;
  assertEq(n, cap - (producerCount - 1), "usable depth = CAPACITY − SLACK");
  assertEq(ring.available(), cap - (producerCount - 1), "in-flight == usable depth");
  assert(ring.droppedFrames() >= 1, "further pushes dropped");
  pass("pin8: producerCount reserves SLACK");
}

// Pin 9 — flow_scale lane (DAG back-pressure Stage 1a). Deterministic, drives
// the REAL consumer pull path (no white-box poking of lane 5) so the
// AdaptiveFlowController runs exactly as it will in production.
function pin9_flowScale(): void {
  const cap = 16;
  const f = makeFrame();
  // The encode is Q16.16 floor, so a decoded value can sit up to one quantum
  // (1/65536 ≈ 1.5e-5) BELOW the controller's clamped real value — e.g. the
  // 0.05 floor decodes to floor(0.05·65536)/65536 = 0.049987… Allow one quantum
  // of slack on the bounds check.
  const Q_EPS = 1 / 65536 + 1e-9;
  const inBounds = (x: number) =>
    x >= DAG_FLOW_SCALE_MIN - Q_EPS && x <= 2.0 + Q_EPS;

  // (a) Seeded neutral 1.0 before any pull → a producer reading the hint early
  //     sees "go at nominal rate", not the 0 a bare zero-fill would leave.
  const { ring } = MpmcRing.create(allKinds, cap, { producerCount: 1 });
  const out = ring.createFrame();
  assertEq(ring.flowScaleHint(), 1.0, "flow_scale seeded 1.0 (nominal) before first pull");

  // (b) Sustained-FULL occupancy → hint DOWN past 0.5. Fill to capacity, then
  //     steady pull-one/refill-one so each pull ticks the controller at
  //     occupancy ≈ 1.0. Crossing below 0.5 is only reachable with the WIDENED
  //     DAG clamp — the inherited [0.5, 2.0] would pin at the 0.5 floor.
  for (let i = 0; i < cap; i++) assert(ring.push(f as any), `fill ${i}`);
  for (let i = 0; i < 200; i++) {
    assert(ring.pull(out), "steady pull");
    assert(inBounds(ring.flowScaleHint()), "hint in [MIN, 2.0] while draining full");
    assert(ring.push(f as any), "steady refill");
  }
  const fullHint = ring.flowScaleHint();
  assert(fullHint < 0.5, `sustained-full drives hint below 0.5 (widened clamp active): got ${fullHint}`);
  assert(fullHint >= DAG_FLOW_SCALE_MIN - Q_EPS, `hint never below the widened floor: got ${fullHint}`);
  while (ring.pull(out)) { /* drain */ }
  assertEq(ring.tornFrameCount(), 0, "full-occupancy run never tears");
  assertEq(ring.overrunLostFrames(), 0, "full-occupancy run no overrun loss");

  // (c) Sustained-LOW occupancy (push one / pull one) → hint UP toward 2.0.
  const { ring: ring2 } = MpmcRing.create(allKinds, cap, { producerCount: 1 });
  const out2 = ring2.createFrame();
  for (let i = 0; i < 200; i++) {
    assert(ring2.push(f as any), "push one");
    assert(ring2.pull(out2), "pull one (low occupancy)");
    assert(inBounds(ring2.flowScaleHint()), "hint in [MIN, 2.0] at low occupancy");
  }
  const lowHint = ring2.flowScaleHint();
  assert(lowHint > 1.0, `sustained-low occupancy drives hint above 1.0: got ${lowHint}`);
  assertEq(ring2.tornFrameCount(), 0, "side channel never tears the protocol");
  assertEq(ring2.overrunLostFrames(), 0, "side channel no overrun loss");

  pass("pin9: flow_scale lane (seed 1.0, widened clamp < 0.5, bounds, side-channel)");
}

function main(): void {
  console.log("MpmcRing — single-thread API pins");
  pin1_layout();
  pin2_guards();
  pin3_bitExact();
  pin4_dropFull();
  pin5_emptyAndAvailable();
  pin6_headOfLineGap();
  pin7_overloadNet();
  pin8_slackReserve();
  pin9_flowScale();
  console.warn = realWarn;
  console.log(`\nMpmcRing: ${passed} pins passed.`);
}

main();
