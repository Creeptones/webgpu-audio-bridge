/**
 * SpmcRing.test.ts — single-thread API pins for the wait-free SP→MC broadcast
 * primitive (Apollo Frontier 3, Stage 4.1, 0.9.911). Exercises the REAL
 * src/SpmcRing.ts class through deterministic single-thread sequences. The
 * exhaustive interleaving proof lives in SpmcRing.interleaving.test.ts; the
 * cross-thread stress in SpmcRing.concurrent.test.ts. No test framework.
 *
 * Pins (numbered; append new ones at the end + register in main()):
 *   1.  byteLength / create round-trip + layout sanity.
 *   2.  construction guards (capacity, consumerCount, consumerIndex, SAB size).
 *   3.  push/pull bit-exact round-trip across every FieldKind + array fields.
 *   4.  broadcast: one producer → N consumers, each sees every frame in FIFO
 *       order, independent cursors.
 *   5.  independent cursors: a slow (lapped) consumer drops oldest counted via
 *       the overload net while a fast consumer keeps up (white-box).
 *   6.  head-not-yet-written rides over (white-box: regress the head generation
 *       → empty, cursor does NOT advance; once re-written it delivers FIFO).
 *   7.  busy-ride (white-box: d==1 Busy(D) → empty, cursor does NOT advance).
 *   8.  lapped-skip (white-box: d>=2 → counted drop, cursor advances).
 *   9.  peer mount: bare ctor does NOT re-init; a consumer peer sees a frame the
 *       producer peer pushed (initLayout-not-re-called discipline).
 *  10.  observers: per-consumer available/dropped/tornGuarded + out-of-range
 *       consumerIndex throws; consumerIndex bound via ctor is the pull default.
 *  11.  flow_scale per-consumer lane + producer MIN-reduce (0.9.943, DAG
 *       back-pressure Stage 1c): seeded 1.0; a high-occupancy consumer drives its
 *       OWN flowScale[c] below 0.5 (widened clamp) while another's stays seeded;
 *       flowScaleHint() returns the MIN over the cells (the one genuinely-new
 *       op), order-independent + in [DAG_FLOW_SCALE_MIN, 2.0]; a low-occupancy
 *       consumer drives its cell up toward 2.0. No tear/drop on the side channel.
 */

import { assert, assertEq } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array,
} from "../src/index.js";
import { SpmcRing, SPMC_HEADER_BYTES } from "../src/SpmcRing.js";
import { AdaptiveFlowController, DAG_FLOW_SCALE_MIN } from "../src/AdaptiveFlowController.js";

// Silence (and capture) the one-shot experimental warning so it doesn't pollute
// the suite output, while still pinning that it fires.
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

const HEADER_LANES = 8;
// PER_CONSUMER_LANES = 4 (dequeuePos/dropped/tornGuarded/flowScale; lane 3 added
// at 0.9.943, DAG back-pressure Stage 1c).
const PER_CONSUMER_LANES = 4;
function align8(b: number): number { return (b + 7) & ~7; }
function genByteOffset(consumerCount: number): number {
  return SPMC_HEADER_BYTES + align8(consumerCount * PER_CONSUMER_LANES * 4);
}

let passed = 0;
function pass(name: string): void {
  passed++;
  console.log(`  ok ${name}`);
}

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
  const nc = 3;
  const len = SpmcRing.byteLength(allKinds, cap, nc);
  // header(32) + consumer(align8(nc*PER_CONSUMER_LANES*4)) + gen(align8(cap*4)) + payload
  const consumerBytes = align8(nc * PER_CONSUMER_LANES * 4);
  const genBytes = align8(cap * 4);
  const expected = 32 + consumerBytes + genBytes + cap * allKinds.frameByteSize;
  assertEq(len, expected, "byteLength matches documented layout");
  assert(SPMC_HEADER_BYTES === 32, "header is 32 bytes");

  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: nc });
  assertEq(sab.byteLength, len, "create allocates exactly byteLength");
  assertEq(ring.capacity, cap, "capacity getter");
  assertEq(ring.consumerCount, nc, "consumerCount getter");
  assertEq(ring.consumerIndex, -1, "producer peer is unbound (consumerIndex -1)");
  for (let c = 0; c < nc; c++) {
    assertEq(ring.available(c), 0, `consumer ${c}: fresh ring empty`);
    assertEq(ring.dropped(c), 0, `consumer ${c}: no drops`);
    assertEq(ring.tornGuarded(c), 0, `consumer ${c}: no torn-guard`);
  }
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  pass("pin1: byteLength / create / layout sanity");
}

// Pin 2 — construction guards.
function pin2_guards(): void {
  const sabBig = new SharedArrayBuffer(SpmcRing.byteLength(allKinds, 8, 2));
  assertThrows(() => new SpmcRing(sabBig, allKinds, 6, { consumerCount: 2 }), /power of two/, "non-pow2 capacity");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 1, { consumerCount: 2 }), /power of two/, "capacity 1");
  assertThrows(() => new SpmcRing(sabBig, allKinds, (1 << 29) * 2, { consumerCount: 2 }), /power of two/, "capacity too big");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 8, { consumerCount: 0 }), /consumerCount/, "consumerCount 0");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 8, { consumerCount: 65 }), /consumerCount/, "consumerCount over max");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 8, { consumerCount: 1.5 }), /consumerCount/, "consumerCount non-int");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 8, { consumerCount: 2, consumerIndex: 2 }), /consumerIndex/, "consumerIndex out of range");
  assertThrows(() => new SpmcRing(sabBig, allKinds, 8, { consumerCount: 2, consumerIndex: -2 }), /consumerIndex/, "consumerIndex negative");
  const tiny = new SharedArrayBuffer(16);
  assertThrows(() => new SpmcRing(tiny, allKinds, 8, { consumerCount: 2 }), /too small/, "SAB too small");
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
  const { ring } = SpmcRing.create(allKinds, 4, { consumerCount: 1 });
  const frame = makeFrame();
  ring.push(frame as any);
  assertEq(ring.available(0), 1, "one in flight");
  const out = ring.createFrame();
  assert(ring.pull(out, 0), "pull delivers");
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
  assertEq(ring.available(0), 0, "drained");
  assert(!ring.pull(out, 0), "empty pull returns false");
  pass("pin3: bit-exact round-trip across all FieldKinds");
}

// Pin 4 — broadcast: one producer → N consumers, each sees every frame in FIFO,
// independent cursors.
function pin4_broadcast(): void {
  const cap = 8;
  const nc = 3;
  const { ring } = SpmcRing.create(allKinds, cap, { consumerCount: nc });
  const vals = [11, 22, 33, 44];
  for (const v of vals) {
    const f = makeFrame();
    (f as any).a_i32 = v;
    ring.push(f as any);
  }
  // Each consumer independently drains all four, in FIFO order, bit-exact.
  for (let c = 0; c < nc; c++) {
    const out = ring.createFrame();
    for (let i = 0; i < vals.length; i++) {
      assert(ring.pull(out, c), `consumer ${c}: pull ${i} delivers`);
      assertEq((out as any).a_i32, vals[i], `consumer ${c}: FIFO frame ${i}`);
      assertEq((out as any).a_u64, makeFrame().a_u64, `consumer ${c}: payload bit-exact ${i}`);
    }
    assert(!ring.pull(out, c), `consumer ${c}: drained`);
    assertEq(ring.dropped(c), 0, `consumer ${c}: no drops in keep-up regime`);
    assertEq(ring.tornGuarded(c), 0, `consumer ${c}: no torn-guard in keep-up regime`);
  }
  pass("pin4: broadcast — every consumer sees every frame (independent cursors)");
}

// Pin 5 — independent cursors: a slow (lapped) consumer drops oldest counted via
// the overload net while a fast consumer keeps up (white-box: bump writeTicket).
function pin5_independentOverload(): void {
  const cap = 4;
  const nc = 2;
  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: nc });
  const vals = [10, 20, 30, 40];
  for (const v of vals) {
    const f = makeFrame();
    (f as any).a_i32 = v;
    ring.push(f as any);
  }
  // Consumer 0 (fast) keeps up: drains all four bit-exact, no drops.
  const out = ring.createFrame();
  for (let i = 0; i < vals.length; i++) {
    assert(ring.pull(out, 0), `fast consumer pull ${i}`);
    assertEq((out as any).a_i32, vals[i], `fast consumer FIFO ${i}`);
  }
  assertEq(ring.dropped(0), 0, "fast consumer: no drops");

  // Now simulate the producer lapping consumer 1: pretend two more tickets (4,5)
  // were written by bumping writeTicket to 6 (slots 0,1 still hold the LIVE
  // gens for tickets 0,1 — but they are now outside consumer 1's live window).
  const header = new Int32Array(sab, 0, HEADER_LANES);
  Atomics.store(header, 0, 6); // writeTicket = 6
  // Consumer 1 at D=0: W − D = 6 > CAPACITY(4) → catch-up target = 2, drop 0,1.
  assert(ring.pull(out, 1), "slow consumer delivers after catch-up");
  assertEq((out as any).a_i32, 30, "slow consumer: delivered oldest LIVE frame (ticket 2)");
  assertEq(ring.dropped(1), 2, "slow consumer: counted exactly 2 lapped losses");
  assert(ring.pull(out, 1), "slow consumer delivers next live frame");
  assertEq((out as any).a_i32, 40, "slow consumer: delivered ticket 3");
  assert(!ring.pull(out, 1), "slow consumer: tickets 4,5 read as not-yet-written");
  assertEq(ring.tornGuarded(1), 0, "overload net never tears");
  pass("pin5: independent cursors — slow consumer counted-drops, fast keeps up");
}

// Pin 6 — head-not-yet-written rides over (white-box). Regress the head slot's
// generation to "not committed"; pull returns false WITHOUT advancing; once
// re-committed it delivers in FIFO order.
function pin6_headOfLineGap(): void {
  const cap = 4;
  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: 1 });
  const fA = makeFrame(); (fA as any).a_i32 = 111;
  const fB = makeFrame(); (fB as any).a_i32 = 222;
  ring.push(fA as any); // ticket 0 → slot 0, gen[0] = complete(0) = 0
  ring.push(fB as any); // ticket 1 → slot 1, gen[1] = complete(1) = 2

  const gen = new Int32Array(sab, genByteOffset(1), cap);
  const savedGen0 = gen[0]!;
  // Regress slot 0 to "lap before lap 0" → head ticket 0 reads as not committed.
  Atomics.store(gen, 0, (2 * (0 - cap)) | 0);

  const out = ring.createFrame();
  assert(!ring.pull(out, 0), "uncommitted head → empty (gap rides over)");
  assertEq(ring.available(0), 2, "cursor did NOT advance over the gap");

  Atomics.store(gen, 0, savedGen0); // re-commit the head
  assert(ring.pull(out, 0), "head re-committed → delivers");
  assertEq((out as any).a_i32, 111, "delivered ticket 0 first (FIFO)");
  assert(ring.pull(out, 0), "delivers next");
  assertEq((out as any).a_i32, 222, "delivered ticket 1 second (FIFO)");
  assert(!ring.pull(out, 0), "drained");
  assertEq(ring.dropped(0), 0, "no drops");
  assertEq(ring.tornGuarded(0), 0, "no torn-guard");
  pass("pin6: head-not-yet-written rides over (FIFO preserved)");
}

// Pin 7 — busy-ride (white-box): d==1 (Busy(D), producer mid-writing my head) →
// empty, cursor does NOT advance, no drop / no torn-guard. Once Complete, deliver.
function pin7_busyRide(): void {
  const cap = 4;
  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: 1 });
  const f = makeFrame(); (f as any).a_i32 = 777;
  ring.push(f as any); // ticket 0 → slot 0, gen[0] = complete(0) = 0

  const gen = new Int32Array(sab, genByteOffset(1), cap);
  Atomics.store(gen, 0, (2 * 0 + 1) | 0); // Busy(0) = 1

  const out = ring.createFrame();
  assert(!ring.pull(out, 0), "Busy head → empty (ride)");
  assertEq(ring.available(0), 1, "cursor did NOT advance over a busy head");
  assertEq(ring.dropped(0), 0, "busy-ride is not a drop");
  assertEq(ring.tornGuarded(0), 0, "busy-ride is not a torn-guard");

  Atomics.store(gen, 0, (2 * 0) | 0); // Complete(0) = 0
  assert(ring.pull(out, 0), "Complete head → delivers");
  assertEq((out as any).a_i32, 777, "delivered the frame once complete");
  pass("pin7: busy-ride (d==1 → empty, no advance)");
}

// Pin 8 — lapped-skip (white-box): d>=2 (slot reused by a newer lap) → counted
// drop, cursor advances.
function pin8_lappedSkip(): void {
  const cap = 4;
  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: 1 });
  const f = makeFrame();
  ring.push(f as any); // ticket 0 → slot 0, gen[0] = complete(0) = 0, writeTicket = 1

  const gen = new Int32Array(sab, genByteOffset(1), cap);
  // Stamp slot 0 with Complete(CAPACITY) = 2*4 = 8 → d = signedDiff(8, 0) = 8 ≥ 2
  // (a later-lap occupant). writeTicket stays 1 so the overload net does NOT fire.
  Atomics.store(gen, 0, (2 * cap) | 0);

  const out = ring.createFrame();
  assert(!ring.pull(out, 0), "lapped slot → empty (counted drop)");
  assertEq(ring.dropped(0), 1, "lapped-skip counted exactly one drop");
  // Cursor advanced to ticket 1 (slot 1, never written) → still empty.
  assert(!ring.pull(out, 0), "after skip, head 1 not written → empty");
  assertEq(ring.tornGuarded(0), 0, "lapped-skip is not a torn-guard");
  pass("pin8: lapped-skip (d>=2 → counted drop, cursor advances)");
}

// Pin 9 — peer mount: a bare ctor does NOT re-init the SAB; a consumer peer
// reconstructed over an already-initialized SAB sees a frame the producer peer
// pushed (initLayout-not-re-called discipline).
function pin9_peerMount(): void {
  const cap = 4;
  const { ring: producer, sab } = SpmcRing.create(allKinds, cap, { consumerCount: 2 });
  const f = makeFrame(); (f as any).a_i32 = 909;
  producer.push(f as any); // writeTicket now 1

  // Consumer peers attach via the BARE ctor (no initLayout — must not wipe state).
  const c0 = new SpmcRing(sab, allKinds, cap, { consumerCount: 2, consumerIndex: 0 });
  const c1 = new SpmcRing(sab, allKinds, cap, { consumerCount: 2, consumerIndex: 1 });
  assertEq(c0.available(), 1, "peer mount preserved the in-flight frame (no re-init)");
  const out0 = c0.createFrame();
  const out1 = c1.createFrame();
  assert(c0.pull(out0), "consumer peer 0 delivers via bound index");
  assertEq((out0 as any).a_i32, 909, "consumer 0 sees the producer's frame");
  assert(c1.pull(out1), "consumer peer 1 delivers via bound index");
  assertEq((out1 as any).a_i32, 909, "consumer 1 sees the same frame (broadcast)");
  pass("pin9: peer mount — bare ctor does not re-init");
}

// Pin 10 — observers + bound consumerIndex default + out-of-range throws.
function pin10_observers(): void {
  const { ring, sab } = SpmcRing.create(allKinds, 4, { consumerCount: 2 });
  // Out-of-range consumerIndex throws on pull + observers.
  const out = ring.createFrame();
  assertThrows(() => ring.pull(out, 2), /consumerIndex/, "pull out-of-range throws");
  assertThrows(() => ring.dropped(5), /consumerIndex/, "dropped out-of-range throws");
  assertThrows(() => ring.available(-1), /consumerIndex/, "available out-of-range throws");
  // The producer peer (consumerIndex -1) cannot pull without an explicit index.
  assertThrows(() => ring.pull(out), /consumerIndex/, "unbound pull throws");

  // A ring bound to a consumerIndex uses it as the pull/observer default.
  const f = makeFrame(); (f as any).a_i32 = 1234;
  ring.push(f as any);
  const bound = new SpmcRing(sab, allKinds, 4, { consumerCount: 2, consumerIndex: 1 });
  assertEq(bound.consumerIndex, 1, "bound consumerIndex getter");
  assertEq(bound.available(), 1, "bound available() uses the ctor index");
  const bout = bound.createFrame();
  assert(bound.pull(bout), "bound pull() (no arg) uses the ctor index");
  assertEq((bout as any).a_i32, 1234, "bound consumer delivered the frame");
  assertEq(bound.dropped(), 0, "bound dropped() uses the ctor index");
  assertEq(bound.tornGuarded(), 0, "bound tornGuarded() uses the ctor index");
  pass("pin10: observers + bound default + out-of-range guards");
}

// Pin 11 — flow_scale per-consumer lane + producer MIN-reduce (DAG back-pressure
// Stage 1c). Deterministic; drives the REAL pull path for the lane writes and
// exercises the real flowScaleHint() min-reduce. Reads the raw per-consumer cells
// (no public per-consumer reader) only to assert each consumer wrote its OWN cell.
function pin11_flowScaleMinReduce(): void {
  const cap = 16;
  const Q = AdaptiveFlowController.Q; // 65536
  const Q_EPS = 1 / Q + 1e-9;
  const inBounds = (x: number) => x >= DAG_FLOW_SCALE_MIN - Q_EPS && x <= 2.0 + Q_EPS;
  const f = makeFrame();

  // Raw per-consumer flowScale[c] reader (lane 3 of 4). Decodes Q16.16.
  const rawScale = (sab: SharedArrayBuffer, c: number): number => {
    const cl = new Int32Array(sab, SPMC_HEADER_BYTES, 2 * PER_CONSUMER_LANES);
    return (cl[c * PER_CONSUMER_LANES + 3]! | 0) / Q;
  };

  // (a) Seeded neutral 1.0 → the producer's min-reduce reads "go at nominal rate"
  //     before any consumer has pulled (a bare zero-fill would decode to 0.0).
  const { ring, sab } = SpmcRing.create(allKinds, cap, { consumerCount: 2 });
  const out = ring.createFrame();
  assertEq(ring.flowScaleHint(), 1.0, "producer min-reduce seeded 1.0 before any pull");
  assertEq(rawScale(sab, 0), 1.0, "flowScale[0] seeded 1.0");
  assertEq(rawScale(sab, 1), 1.0, "flowScale[1] seeded 1.0");

  // (b) Sustained-FULL occupancy on consumer 0 only → its OWN cell DOWN past 0.5
  //     (only reachable with the widened DAG clamp). Maintain backlog == capacity:
  //     fill the ring, then steady pull-one(c0)/push-one so each c0 pull sees
  //     (W − D0) == capacity (occupancy 1.0). Consumer 1 never pulls → its cell
  //     stays seeded 1.0. The producer min must then track consumer 0.
  for (let i = 0; i < cap; i++) ring.push(f as any);
  for (let i = 0; i < 200; i++) {
    assert(ring.pull(out, 0), "steady c0 pull (full backlog)");
    assert(inBounds(rawScale(sab, 0)), "flowScale[0] in bounds while full");
    ring.push(f as any); // refill → keep c0's backlog at capacity
  }
  const c0Hint = rawScale(sab, 0);
  assert(c0Hint < 0.5, `sustained-full drives flowScale[0] below 0.5 (widened clamp): got ${c0Hint}`);
  assert(c0Hint >= DAG_FLOW_SCALE_MIN - Q_EPS, `flowScale[0] never below the floor: got ${c0Hint}`);
  assertEq(rawScale(sab, 1), 1.0, "consumer 1 never pulled → its cell untouched (per-consumer, no shared race)");
  // The producer MIN-reduce picks the lower of the two cells == consumer 0's.
  assert(Math.abs(ring.flowScaleHint() - c0Hint) < Q_EPS, `flowScaleHint() == min == flowScale[0] (${ring.flowScaleHint()} vs ${c0Hint})`);
  assert(ring.flowScaleHint() < 0.5, "producer paces to the backed-up consumer (min < 0.5)");
  assertEq(ring.tornGuarded(0), 0, "no torn candidate on the full consumer");
  assertEq(ring.dropped(0), 0, "no drop on the maintained-backlog consumer");

  // (c) The MIN-reduce is a true min over the cells, order-independent + bounded.
  //     White-box stores into the raw cells (the reduction reads live atomics).
  const cl = new Int32Array(sab, SPMC_HEADER_BYTES, 2 * PER_CONSUMER_LANES);
  const enc = (x: number) => Math.floor(x * Q);
  cl[0 * PER_CONSUMER_LANES + 3] = enc(2.0);
  cl[1 * PER_CONSUMER_LANES + 3] = enc(0.3);
  assert(Math.abs(ring.flowScaleHint() - 0.3) < 1e-4, `min(2.0, 0.3) = 0.3, got ${ring.flowScaleHint()}`);
  cl[0 * PER_CONSUMER_LANES + 3] = enc(0.3); // swap → order-independent
  cl[1 * PER_CONSUMER_LANES + 3] = enc(2.0);
  assert(Math.abs(ring.flowScaleHint() - 0.3) < 1e-4, `min is order-independent, got ${ring.flowScaleHint()}`);
  cl[0 * PER_CONSUMER_LANES + 3] = enc(1.5);
  cl[1 * PER_CONSUMER_LANES + 3] = enc(1.5);
  assert(Math.abs(ring.flowScaleHint() - 1.5) < 1e-4, `min(1.5, 1.5) = 1.5, got ${ring.flowScaleHint()}`);
  assert(inBounds(ring.flowScaleHint()), "min-reduce in bounds");

  // (d) Sustained-LOW occupancy on a fresh ring drives a consumer's cell UP toward
  //     2.0 (push-one/pull-one keeps backlog == 1). The min stays bounded.
  const { ring: r2, sab: sab2 } = SpmcRing.create(allKinds, cap, { consumerCount: 2 });
  const out2 = r2.createFrame();
  for (let i = 0; i < 200; i++) {
    r2.push(f as any);
    assert(r2.pull(out2, 0), "c0 pull (low occupancy)");
    assert(inBounds(rawScale(sab2, 0)), "flowScale[0] in bounds at low occupancy");
  }
  const lowHint = rawScale(sab2, 0);
  assert(lowHint > 1.0, `sustained-low occupancy drives flowScale[0] above 1.0: got ${lowHint}`);
  // min(high c0, seeded-1.0 c1) == 1.0 (consumer 1 still the floor of the two).
  assert(Math.abs(r2.flowScaleHint() - 1.0) < Q_EPS, `min picks the seeded consumer 1: got ${r2.flowScaleHint()}`);
  assertEq(r2.tornGuarded(0), 0, "side channel never tears the protocol");

  pass("pin11: flow_scale per-consumer lane + producer MIN-reduce (widened clamp, order-independent, bounds)");
}

function main(): void {
  console.log("SpmcRing — single-thread API pins");
  pin1_layout();
  pin2_guards();
  pin3_bitExact();
  pin4_broadcast();
  pin5_independentOverload();
  pin6_headOfLineGap();
  pin7_busyRide();
  pin8_lappedSkip();
  pin9_peerMount();
  pin10_observers();
  pin11_flowScaleMinReduce();
  console.warn = realWarn;
  console.log(`\nSpmcRing: ${passed} pins passed.`);
}

main();
