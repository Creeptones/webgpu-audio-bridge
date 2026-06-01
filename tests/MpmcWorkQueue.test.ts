/**
 * MpmcWorkQueue.test.ts — single-thread API pins for the wait-free MP→MC
 * competing-consumer work queue (Apollo Frontier 3, MP→MC Work-Queue Stage 1,
 * 0.9.934). Exercises the REAL src/MpmcWorkQueue.ts class through deterministic
 * single-thread sequences. The exhaustive interleaving proof lives in
 * MpmcWorkQueue.interleaving.test.ts; the cross-thread partition stress in
 * MpmcWorkQueue.concurrent.test.ts. No test framework.
 *
 * Pins (numbered; append new ones at the end + register in main()):
 *   1.  byteLength / create round-trip + layout sanity + experimental warning.
 *   2.  construction guards (capacity power-of-two/range, producerCount, slack).
 *   3.  push/pull bit-exact round-trip across every FieldKind + array fields.
 *   4.  drop-newest-when-full is counted; no payload mutation, no ticket hole;
 *       reuse-after-consume frees the slot (a consumed slot accepts the next lap).
 *   5.  empty-pull returns false; available() reflects claimable frames.
 *   6.  held-claim (white-box): a claimed-but-unpublished frame is HELD (pull
 *       returns false, isHolding() true, the claim is not skipped), rides over,
 *       and delivers once its slot reads Complete — FIFO by ticket.
 *   7.  two competing consumers PARTITION the stream: every frame to exactly one
 *       consumer, union == the producer stream, no duplicate.
 *   8.  producerCount > 1 reserves SLACK (usable depth = CAPACITY − SLACK).
 *   9.  Stage-3 end-of-stream: close()/isClosed()/isDrained() + a held claim
 *       D < enqueueTicket KEEPS riding after close (never falsely stranded). The
 *       genuine strand-release (D ≥ enqueueTicket) is a multi-consumer race, so
 *       it is proven in the interleaving fuzzer + the concurrent test, not here.
 */

import { assert, assertEq } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array,
} from "../src/index.js";
import { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";

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
  const len = MpmcWorkQueue.byteLength(allKinds, cap);
  const genBytes = (cap * 4 + 7) & ~7;
  const expected = 32 + genBytes + cap * allKinds.frameByteSize;
  assertEq(len, expected, "byteLength matches documented layout");
  assert(MPMC_WQ_HEADER_BYTES === 32, "header is 32 bytes");

  const { queue, sab } = MpmcWorkQueue.create(allKinds, cap, { producerCount: 3 });
  assertEq(sab.byteLength, len, "create allocates exactly byteLength");
  assertEq(queue.capacity, cap, "capacity getter");
  assertEq(queue.producerCount, 3, "producerCount getter");
  assertEq(queue.available(), 0, "fresh queue is empty");
  assertEq(queue.droppedFrames(), 0, "fresh queue has no drops");
  assertEq(queue.strandedClaims(), 0, "fresh queue has no strands");
  assertEq(queue.tornGuarded(), 0, "fresh queue has no torn-guard");
  assert(!queue.isHolding(), "fresh queue holds nothing");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  pass("pin1: byteLength / create / layout sanity");
}

// Pin 2 — construction guards.
function pin2_guards(): void {
  const sabBig = new SharedArrayBuffer(MpmcWorkQueue.byteLength(allKinds, 8));
  assertThrows(() => new MpmcWorkQueue(sabBig, allKinds, 6), /power of two/, "non-pow2 capacity");
  assertThrows(() => new MpmcWorkQueue(sabBig, allKinds, 1), /power of two/, "capacity 1");
  assertThrows(() => new MpmcWorkQueue(sabBig, allKinds, (1 << 29) * 2), /power of two/, "capacity too big");
  assertThrows(() => new MpmcWorkQueue(sabBig, allKinds, 8, { producerCount: 0 }), /producerCount/, "producerCount 0");
  assertThrows(() => new MpmcWorkQueue(sabBig, allKinds, 8, { producerCount: 1.5 }), /producerCount/, "producerCount non-int");
  const sabSmallCap = new SharedArrayBuffer(MpmcWorkQueue.byteLength(allKinds, 2));
  assertThrows(() => new MpmcWorkQueue(sabSmallCap, allKinds, 2, { producerCount: 4 }), /SLACK/, "capacity <= slack");
  const tiny = new SharedArrayBuffer(16);
  assertThrows(() => new MpmcWorkQueue(tiny, allKinds, 8), /too small/, "SAB too small");
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
  const { queue } = MpmcWorkQueue.create(allKinds, 4, { producerCount: 1 });
  const frame = makeFrame();
  assert(queue.push(frame as any), "push succeeds");
  assertEq(queue.available(), 1, "one claimable");
  const out = queue.createFrame();
  assert(queue.pull(out), "pull delivers");
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
  assertEq(queue.available(), 0, "drained");
  assert(!queue.pull(out), "empty pull returns false");
  pass("pin3: bit-exact round-trip across all FieldKinds");
}

// Pin 4 — drop-newest-when-full counted (producerCount 1 → slack 0 → usable
// depth = CAPACITY); a consumed slot frees for the next lap.
function pin4_dropFullAndReuse(): void {
  const cap = 4;
  const { queue } = MpmcWorkQueue.create(allKinds, cap, { producerCount: 1 });
  const f = makeFrame();
  for (let i = 0; i < cap; i++) assert(queue.push(f as any), `push ${i} fits`);
  assertEq(queue.available(), cap, "queue full at capacity");
  assert(!queue.push(f as any), "push when full returns false");
  assert(!queue.push(f as any), "second over-full push also false");
  assertEq(queue.droppedFrames(), 2, "two drops counted");
  assertEq(queue.available(), cap, "no ticket consumed by a drop (no hole)");
  const out = queue.createFrame();
  let n = 0;
  while (queue.pull(out)) n++;
  assertEq(n, cap, "exactly capacity frames delivered, none lost");
  // Reuse: the consumed slots are freed for the next lap; another full round fits.
  for (let i = 0; i < cap; i++) assert(queue.push(f as any), `reuse push ${i} fits`);
  let m = 0;
  while (queue.pull(out)) m++;
  assertEq(m, cap, "next lap delivered after slots were freed by consume");
  assertEq(queue.tornGuarded(), 0, "no torn-guard");
  assertEq(queue.strandedClaims(), 0, "no strands");
  pass("pin4: drop-newest-when-full counted + reuse-after-consume");
}

// Pin 5 — empty-pull + available().
function pin5_emptyAndAvailable(): void {
  const { queue } = MpmcWorkQueue.create(allKinds, 4, { producerCount: 1 });
  const out = queue.createFrame();
  assert(!queue.pull(out), "pull on empty returns false");
  assertEq(queue.available(), 0, "available 0 when empty");
  const f = makeFrame();
  queue.push(f as any);
  queue.push(f as any);
  assertEq(queue.available(), 2, "available reflects two claimable");
  queue.pull(out);
  assertEq(queue.available(), 1, "available decremented after a claim+deliver");
  pass("pin5: empty-pull + available()");
}

// Pin 6 — held-claim (white-box). Publish ticket 0, then simulate a producer
// that has CLAIMED ticket 1 but not yet published it (poke enqueueTicket ahead,
// leave gen[1] = Free(1)). A consumer that claims D=1 must HOLD (pull false,
// isHolding true, no skip); once slot 1 reads Complete(1) it delivers. FIFO by
// ticket is preserved.
function pin6_heldClaim(): void {
  const cap = 4;
  const { queue, sab } = MpmcWorkQueue.create(allKinds, cap, { producerCount: 2 });
  const fA = makeFrame();
  (fA as any).a_i32 = 111;
  assert(queue.push(fA as any), "push ticket 0 → slot 0 (published)");

  const header = new Int32Array(sab, 0, 8);
  const gen = new Int32Array(sab, MPMC_WQ_HEADER_BYTES, cap);
  // Phantom producer claims ticket 1 (slot 1) but does not publish: bump
  // enqueueTicket to 2, leave gen[1] = Free(1) = 1.
  Atomics.store(header, 0, 2);
  assertEq(gen[1], 1, "slot 1 still Free(1) (unpublished)");

  const out = queue.createFrame();
  // Deliver ticket 0 (claim D=0 → Complete(0) → deliver).
  assert(queue.pull(out), "delivers ticket 0");
  assertEq((out as any).a_i32, 111, "ticket 0 payload");
  assert(!queue.isHolding(), "not holding after a clean delivery");

  // Claim ticket 1 → its slot is Free(1), not Complete → HOLD, ride.
  assert(!queue.pull(out), "claimed ticket 1 is unpublished → pull rides (false)");
  assert(queue.isHolding(), "consumer is now holding the unpublished claim");
  assertEq(queue.available(), 0, "ticket 1 claimed → nothing else claimable");
  // Polling again does NOT re-claim (still holding the same D) and still rides.
  assert(!queue.pull(out), "still holding → still rides");
  assert(queue.isHolding(), "still holding");

  // Publish ticket 1: slot 1 reads Complete(1) = 2. (White-box: the payload is
  // left as init zeros; this pin asserts the HOLD→deliver transition + FIFO,
  // payload bit-exactness is pin 3.)
  Atomics.store(gen, 1, 2);
  assert(queue.pull(out), "held claim delivers once its slot reads Complete");
  assert(!queue.isHolding(), "no longer holding after delivery");
  assert(!queue.pull(out), "drained");
  assertEq(queue.tornGuarded(), 0, "no torn-guard");
  pass("pin6: held-claim rides over an unpublished frame then delivers (FIFO)");
}

// Pin 7 — two competing consumers PARTITION the stream. Six published frames,
// two consumer instances over the same SAB alternate pulling; the union of what
// they deliver is exactly the producer stream, each frame to exactly one
// consumer, no duplicate.
function pin7_partition(): void {
  const cap = 8;
  const { queue, sab } = MpmcWorkQueue.create(allKinds, cap, { producerCount: 1 });
  const N = 6;
  for (let i = 0; i < N; i++) {
    const f = makeFrame();
    (f as any).a_i32 = i;
    assert(queue.push(f as any), `push ${i}`);
  }
  // A second consumer instance over the SAME SAB (a competing consumer). It must
  // NOT call initLayout (the SAB is already initialized).
  const c2 = new MpmcWorkQueue(sab, allKinds, cap, { producerCount: 1 });
  const o1 = queue.createFrame();
  const o2 = c2.createFrame();
  const seen = new Set<number>();
  const owner: Record<number, number> = {};
  let pulls = 0;
  // Alternate; once both are empty we stop.
  for (let round = 0; round < N * 2 && seen.size < N; round++) {
    if (queue.pull(o1)) { const v = (o1 as any).a_i32 as number; assert(!seen.has(v), `c1 dup ${v}`); seen.add(v); owner[v] = 1; pulls++; }
    if (c2.pull(o2)) { const v = (o2 as any).a_i32 as number; assert(!seen.has(v), `c2 dup ${v}`); seen.add(v); owner[v] = 2; pulls++; }
  }
  assertEq(pulls, N, "every frame delivered exactly once (no duplicate)");
  assertEq(seen.size, N, "union covers the whole producer stream");
  for (let i = 0; i < N; i++) assert(seen.has(i), `frame ${i} delivered by some consumer`);
  // Both consumers participated in the partition (alternating claim cursor).
  const owners = new Set(Object.values(owner));
  assert(owners.size === 2, "both consumers took a share of the partition");
  assert(!queue.pull(o1) && !c2.pull(o2), "both drained");
  pass("pin7: two competing consumers partition the stream");
}

// Pin 8 — producerCount > 1 reserves SLACK: usable depth = CAPACITY − SLACK.
function pin8_slackReserve(): void {
  const cap = 8;
  const producerCount = 3; // slack = 2 → usable depth 6
  const { queue } = MpmcWorkQueue.create(allKinds, cap, { producerCount });
  const f = makeFrame();
  let n = 0;
  while (queue.push(f as any)) n++;
  assertEq(n, cap - (producerCount - 1), "usable depth = CAPACITY − SLACK");
  assertEq(queue.available(), cap - (producerCount - 1), "claimable == usable depth");
  assert(queue.droppedFrames() >= 1, "further pushes dropped");
  pass("pin8: producerCount reserves SLACK");
}

// Pin 9 — Stage-3 end-of-stream: close()/isClosed()/isDrained() + the sub-W ride.
// White-box: two phantom producers CLAIMED tickets 0 and 1 (enqueueTicket=2) but
// have not published. A consumer claims D=0 → its slot is Free(0) → it HOLDS and
// rides. After close(), D=0 < enqueueTicket=2 ⇒ a guaranteed-to-publish claim, NOT
// a strand → it keeps riding (strandedClaims stays 0). Once ticket 0 publishes it
// delivers; once both tickets drain the consumer reports isDrained(). (A genuine
// strand needs D ≥ enqueueTicket, a multi-consumer stale-read race — proven in the
// interleaving fuzzer's close-release pin + the concurrent test.)
function pin9_endOfStream(): void {
  const cap = 4;
  const { queue, sab } = MpmcWorkQueue.create(allKinds, cap, { producerCount: 2 });
  const header = new Int32Array(sab, 0, 8);
  const gen = new Int32Array(sab, MPMC_WQ_HEADER_BYTES, cap);
  const out = queue.createFrame();

  assert(!queue.isClosed(), "fresh queue is open");
  assert(!queue.isDrained(), "open queue with no claim is not drained");

  // Phantom producers claim tickets 0 and 1 (enqueueTicket=2); neither published
  // (gen[0]=Free(0)=0, gen[1]=Free(1)=1 from initLayout).
  Atomics.store(header, 0, 2);
  assertEq(gen[0], 0, "slot 0 Free(0)");
  assertEq(gen[1], 1, "slot 1 Free(1)");

  // Consumer claims D=0 → unpublished → HOLD + ride.
  assert(!queue.pull(out), "D=0 unpublished → rides (false)");
  assert(queue.isHolding(), "holding D=0");

  // Close the stream. enqueueTicket (=2) is now final.
  queue.close();
  assert(queue.isClosed(), "isClosed() true after close()");
  assert(!queue.isDrained(), "not drained while holding a claim");

  // D=0 < enqueueTicket=2 → a claimed-and-will-publish ticket, NOT a strand. The
  // closed pull must KEEP riding, not release.
  assert(!queue.pull(out), "closed: sub-enqueueTicket held claim keeps riding");
  assert(queue.isHolding(), "still holding D=0 (not stranded)");
  assertEq(queue.strandedClaims(), 0, "no strand released for a D < enqueueTicket");

  // Publish ticket 0 → the held claim delivers.
  Atomics.store(gen, 0, 1); // Complete(0)
  assert(queue.pull(out), "held D=0 delivers once published");
  assert(!queue.isHolding(), "not holding after delivery");
  assert(!queue.isDrained(), "ticket 1 still claimable → not drained");
  assertEq(queue.available(), 1, "one claimable (ticket 1)");

  // Publish + drain ticket 1; then the consumer is fully drained.
  Atomics.store(gen, 1, 2); // Complete(1)
  assert(queue.pull(out), "delivers ticket 1");
  assert(queue.isDrained(), "closed + nothing claimable + not holding → drained");
  assertEq(queue.strandedClaims(), 0, "no strands in the single-consumer path");
  assertEq(queue.tornGuarded(), 0, "no torn-guard");
  pass("pin9: close()/isClosed()/isDrained() + sub-enqueueTicket ride");
}

function main(): void {
  console.log("MpmcWorkQueue — single-thread API pins");
  pin1_layout();
  pin2_guards();
  pin3_bitExact();
  pin4_dropFullAndReuse();
  pin5_emptyAndAvailable();
  pin6_heldClaim();
  pin7_partition();
  pin8_slackReserve();
  pin9_endOfStream();
  console.warn = realWarn;
  console.log(`\nMpmcWorkQueue: ${passed} pins passed.`);
}

main();
