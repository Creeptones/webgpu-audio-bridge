/**
 * Float64RingBuffer — property tests for the SPSC SAB ring.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Float64RingBuffer.test.ts
 *
 * Pins:
 *   1. Construction validation (capacity must be POT, n positive int, SAB sized)
 *   2. Empty pull / full push contract
 *   3. Header round-trip (seq, tMacroNs, vMax, jMax)
 *   4. Payload round-trip (V_eff / J_eff bit-stable)
 *   5. FIFO ordering across many push/pull cycles
 *   6. Wrap correctness past capacity (slot reuse)
 *   7. pullLatest drain semantics + skipped count
 *   8. Torn-frame detection (simulated producer-lap mid-pull)
 *   9. available() counter
 *  10. 10k mulberry32-seeded fuzz vs an oracle queue
 *
 * Every pin uses assertEq (===) not assertNear — these are bit-exact contracts.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Float64RingBuffer,
  RING_FRAME_PRELUDE,
  RING_HEADER_BYTES,
  type RingFrameHeader,
} from "../src/Float64RingBuffer.js";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Frame {
  header: RingFrameHeader;
  vEff: Float64Array;
  jEff: Float64Array;
}

function emptyHeader(): RingFrameHeader {
  return { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };
}

/** Make a deterministic frame keyed by seq so equality is unambiguous. */
function makeFrame(seq: number, n: number): Frame {
  const vEff = new Float64Array(n);
  const jEff = new Float64Array(n);
  let vMax = 0;
  let jMax = 0;
  for (let k = 0; k < n; k++) {
    vEff[k] = seq + k * 0.001;
    jEff[k] = -seq + k * 0.001;
    if (Math.abs(vEff[k]!) > vMax) vMax = Math.abs(vEff[k]!);
    if (Math.abs(jEff[k]!) > jMax) jMax = Math.abs(jEff[k]!);
  }
  return {
    header: {
      seq,
      tMacroNs: seq * 16_666_667, // pretend 60Hz cadence
      vMax,
      jMax,
    },
    vEff,
    jEff,
  };
}

function framesEqual(
  a: Frame,
  outV: Float64Array,
  outJ: Float64Array,
  outH: RingFrameHeader,
): boolean {
  if (a.header.seq !== outH.seq) return false;
  if (a.header.tMacroNs !== outH.tMacroNs) return false;
  if (a.header.vMax !== outH.vMax) return false;
  if (a.header.jMax !== outH.jMax) return false;
  if (a.vEff.length !== outV.length) return false;
  for (let k = 0; k < a.vEff.length; k++) {
    if (a.vEff[k] !== outV[k]) return false;
    if (a.jEff[k] !== outJ[k]) return false;
  }
  return true;
}

// ── 1. Construction validation ─────────────────────────────────────────────
function testConstructionValidation(): void {
  let threw = false;
  try {
    new Float64RingBuffer(new SharedArrayBuffer(1024), 6, 4); // 6 not POT
  } catch {
    threw = true;
  }
  assert(threw, "non-power-of-two capacity throws");

  threw = false;
  try {
    new Float64RingBuffer(new SharedArrayBuffer(1024), 8, 0);
  } catch {
    threw = true;
  }
  assert(threw, "non-positive n throws");

  threw = false;
  try {
    new Float64RingBuffer(new SharedArrayBuffer(64), 8, 1000);
  } catch {
    threw = true;
  }
  assert(threw, "too-small SAB throws");

  ok("construction-validation");
}

// ── 2. byteLength + allocate helpers ───────────────────────────────────────
function testAllocateAndByteLength(): void {
  // FRAME_LEN = 4 + 2*N = 4 + 8 = 12 f64
  // payload = 16 * 12 * 8 = 1536 bytes
  // total = 32 + 1536 = 1568 bytes
  assertEq(Float64RingBuffer.byteLength(16, 4), 1568, "byteLength(16, 4)");
  const alloc = Float64RingBuffer.allocate(16, 4);
  assertEq(alloc.sab.byteLength, 1568, "allocate returns matching SAB size");
  assertEq(alloc.capacity, 16, "allocation reports capacity");
  assertEq(alloc.n, 4, "allocation reports n");
  const ring = new Float64RingBuffer(alloc.sab, alloc.capacity, alloc.n);
  assertEq(ring.capacity, 16, "ring capacity");
  assertEq(ring.n, 4, "ring n");
  assertEq(ring.frameLen, 4 + 2 * 4, "ring frameLen");
  ok("allocate-and-bytelength");
}

// ── 3. Empty pull returns false ────────────────────────────────────────────
function testEmptyPull(): void {
  const { sab, capacity, n } = Float64RingBuffer.allocate(8, 4);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.pull(outV, outJ, outH), false, "empty pull returns false");
  assertEq(ring.pullLatest(outV, outJ, outH), -1, "empty pullLatest returns -1");
  assertEq(ring.available(), 0, "empty available() === 0");
  ok("empty-pull-returns-false");
}

// ── 4. Push/pull header + payload round-trip ───────────────────────────────
function testRoundTrip(): void {
  const { sab, capacity, n } = Float64RingBuffer.allocate(8, 4);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const frame = makeFrame(42, n);
  assertEq(
    ring.push(frame.vEff, frame.jEff, frame.header),
    true,
    "push to empty returns true",
  );
  assertEq(ring.available(), 1, "available === 1 after push");
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.pull(outV, outJ, outH), true, "pull returns true");
  assertEq(outH.seq, 42, "seq round-trip");
  assertEq(outH.tMacroNs, frame.header.tMacroNs, "tMacroNs round-trip");
  assertEq(outH.vMax, frame.header.vMax, "vMax round-trip");
  assertEq(outH.jMax, frame.header.jMax, "jMax round-trip");
  for (let k = 0; k < n; k++) {
    assertEq(outV[k], frame.vEff[k], `vEff[${k}] round-trip`);
    assertEq(outJ[k], frame.jEff[k], `jEff[${k}] round-trip`);
  }
  assertEq(ring.available(), 0, "available === 0 after drain");
  ok("round-trip");
}

// ── 5. Full push returns false ─────────────────────────────────────────────
function testFullPush(): void {
  const capacity = 4;
  const n = 2;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  for (let i = 0; i < capacity; i++) {
    const f = makeFrame(i, n);
    assertEq(ring.push(f.vEff, f.jEff, f.header), true, `push ${i} succeeds`);
  }
  const overflow = makeFrame(capacity, n);
  assertEq(
    ring.push(overflow.vEff, overflow.jEff, overflow.header),
    false,
    "push when full returns false",
  );
  assertEq(ring.available(), capacity, "available === capacity when full");
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.pull(outV, outJ, outH), true, "pull from full succeeds");
  assertEq(outH.seq, 0, "drained the oldest frame");
  assertEq(
    ring.push(overflow.vEff, overflow.jEff, overflow.header),
    true,
    "push after drain succeeds",
  );
  ok("full-push-returns-false");
}

// ── 6. FIFO ordering across many cycles ────────────────────────────────────
function testFifoOrdering(): void {
  const capacity = 8;
  const n = 4;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  for (let i = 0; i < 4; i++) {
    const f = makeFrame(i, n);
    ring.push(f.vEff, f.jEff, f.header);
  }
  for (let i = 0; i < 4; i++) {
    assertEq(ring.pull(outV, outJ, outH), true, `fifo pull ${i} succeeds`);
    assertEq(outH.seq, i, `fifo pull ${i} seq matches`);
    assertEq(outV[0], i, `fifo pull ${i} vEff[0] matches`);
  }
  ok("fifo-ordering");
}

// ── 7. Wrap correctness past capacity ──────────────────────────────────────
function testWrapAcrossCapacity(): void {
  const capacity = 4;
  const n = 2;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  for (let i = 0; i < capacity * 5 + 3; i++) {
    const f = makeFrame(i, n);
    assertEq(ring.push(f.vEff, f.jEff, f.header), true, `wrap push ${i}`);
    assertEq(ring.pull(outV, outJ, outH), true, `wrap pull ${i}`);
    assertEq(outH.seq, i, `wrap order preserved at i=${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    const f = makeFrame(1000 + i, n);
    assertEq(ring.push(f.vEff, f.jEff, f.header), true, `wrap fill ${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.pull(outV, outJ, outH), true, `wrap drain ${i}`);
    assertEq(outH.seq, 1000 + i, `wrap drain order at ${i}`);
  }
  ok("wrap-across-capacity");
}

// ── 8. pullLatest drains and reports skipped ───────────────────────────────
function testPullLatest(): void {
  const capacity = 8;
  const n = 4;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.pullLatest(outV, outJ, outH), -1, "pullLatest on empty");
  const f7 = makeFrame(7, n);
  ring.push(f7.vEff, f7.jEff, f7.header);
  assertEq(ring.pullLatest(outV, outJ, outH), 0, "single frame → 0 skipped");
  assertEq(outH.seq, 7, "single frame returns seq=7");
  assertEq(ring.available(), 0, "single frame fully drained");
  for (let i = 0; i < 5; i++) {
    const f = makeFrame(100 + i, n);
    ring.push(f.vEff, f.jEff, f.header);
  }
  assertEq(ring.pullLatest(outV, outJ, outH), 4, "5 frames → 4 skipped");
  assertEq(outH.seq, 104, "5 frames returns newest seq=104");
  assertEq(outV[0], 104, "5 frames returns newest vEff[0]");
  assertEq(ring.available(), 0, "5 frames fully drained");
  ok("pull-latest");
}

// ── 9. Torn-frame detection ────────────────────────────────────────────────
//
// Two distinct hazards, two different checks:
//
//   pull() torn-check fires when the producer's write_index has lapped the
//   CONSUMER'S read_index by more than capacity (the slot the consumer is
//   reading has been overwritten). This is single-thread-testable: bumping
//   write_index before pull() runs makes the FIRST load see the lapped value.
//
//   pullLatest() torn-check fires when the producer laps the NEWEST frame
//   BETWEEN the consumer's two atomic loads. In a single-threaded test we
//   cannot interleave between those two loads, so the trigger condition is
//   unobservable here. We document the asymmetry and assert the consistent
//   outcome: under a pre-bump, pullLatest succeeds with skipped > 0 (the
//   slot data is stale but not detected as torn, which is the documented
//   "fresh-slot-only" semantic of pullLatest).
function testTornFrameDetection(): void {
  const capacity = 4;
  const n = 2;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  for (let i = 0; i < capacity; i++) {
    const f = makeFrame(i, n);
    ring.push(f.vEff, f.jEff, f.header);
  }
  const indices = new BigInt64Array(sab, 0, 2);
  const writeIdxBefore = Atomics.load(indices, 0);
  const readIdxBefore = Atomics.load(indices, 1);
  Atomics.store(indices, 0, writeIdxBefore + 2n); // simulated producer-lap
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.pull(outV, outJ, outH), false, "torn pull returns false");
  assertEq(
    Atomics.load(indices, 1),
    readIdxBefore,
    "torn pull did not advance read_index",
  );
  const skipped = ring.pullLatest(outV, outJ, outH);
  assertEq(
    skipped,
    Number(writeIdxBefore + 2n - readIdxBefore - 1n),
    "pullLatest after pre-bump succeeds with expected skipped count",
  );
  assertEq(
    Atomics.load(indices, 1),
    writeIdxBefore + 2n,
    "pullLatest after pre-bump drained to writeIdx",
  );
  ok("torn-frame-detection");
}

// ── 10. available() counter under push/pull mix ────────────────────────────
function testAvailableCounter(): void {
  const capacity = 4;
  const n = 2;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  assertEq(ring.available(), 0, "available 0 at start");
  const f1 = makeFrame(1, n);
  ring.push(f1.vEff, f1.jEff, f1.header);
  assertEq(ring.available(), 1, "available 1 after 1 push");
  const f2 = makeFrame(2, n);
  ring.push(f2.vEff, f2.jEff, f2.header);
  assertEq(ring.available(), 2, "available 2 after 2 pushes");
  ring.pull(outV, outJ, outH);
  assertEq(ring.available(), 1, "available 1 after 1 pull");
  ring.pull(outV, outJ, outH);
  assertEq(ring.available(), 0, "available 0 after drain");
  ok("available-counter");
}

// ── 11. 10k mulberry32-seeded fuzz vs oracle queue ─────────────────────────
function testFuzzVsOracle(): void {
  const capacity = 8;
  const n = 4;
  const { sab } = Float64RingBuffer.allocate(capacity, n);
  const ring = new Float64RingBuffer(sab, capacity, n);
  const rng = mulberry32(0xc0ffee);
  const oracle: Frame[] = [];
  const outV = new Float64Array(n);
  const outJ = new Float64Array(n);
  const outH = emptyHeader();
  let nextSeq = 0;
  let pushes = 0;
  let pulls = 0;
  let fullRejects = 0;
  let emptyRejects = 0;
  for (let iter = 0; iter < 10_000; iter++) {
    const op = rng() < 0.5 ? "push" : "pull";
    if (op === "push") {
      const f = makeFrame(nextSeq++, n);
      const want = oracle.length < capacity;
      const got = ring.push(f.vEff, f.jEff, f.header);
      assertEq(got, want, `fuzz iter ${iter} push outcome`);
      if (got) {
        oracle.push(f);
        pushes++;
      } else {
        fullRejects++;
      }
    } else {
      const want = oracle.length > 0;
      const got = ring.pull(outV, outJ, outH);
      assertEq(got, want, `fuzz iter ${iter} pull outcome`);
      if (got) {
        const expected = oracle.shift()!;
        assert(
          framesEqual(expected, outV, outJ, outH),
          `fuzz iter ${iter} pull payload matches oracle (expected seq ${expected.header.seq}, got ${outH.seq})`,
        );
        pulls++;
      } else {
        emptyRejects++;
      }
    }
    assertEq(ring.available(), oracle.length, `fuzz iter ${iter} available()`);
  }
  while (oracle.length > 0) {
    assertEq(ring.pull(outV, outJ, outH), true, "drain pull");
    const expected = oracle.shift()!;
    assert(
      framesEqual(expected, outV, outJ, outH),
      `drain pull payload matches oracle (seq ${expected.header.seq})`,
    );
  }
  assertEq(ring.available(), 0, "fully drained");
  assert(
    pushes > 0 && pulls > 0 && fullRejects > 0 && emptyRejects > 0,
    `fuzz exercised all arms (pushes=${pushes}, pulls=${pulls}, fullRejects=${fullRejects}, emptyRejects=${emptyRejects})`,
  );
  ok(
    `fuzz-vs-oracle (10k ops: ${pushes} pushes, ${pulls} pulls, ${fullRejects} full-rejects, ${emptyRejects} empty-rejects)`,
  );
}

// ── 12. SAB header layout sanity ───────────────────────────────────────────
function testSabLayoutSanity(): void {
  assertEq(RING_HEADER_BYTES, 32, "header is 32 bytes");
  assertEq(RING_FRAME_PRELUDE, 4, "frame prelude is 4 floats");
  assertEq(32 % 8, 0, "payload byte offset is 8-aligned");
  ok("sab-layout-sanity");
}

function main(): void {
  testConstructionValidation();
  testAllocateAndByteLength();
  testEmptyPull();
  testRoundTrip();
  testFullPush();
  testFifoOrdering();
  testWrapAcrossCapacity();
  testPullLatest();
  testTornFrameDetection();
  testAvailableCounter();
  testSabLayoutSanity();
  testFuzzVsOracle();
  console.log("\nAll Float64RingBuffer tests passed.");
}

main();
