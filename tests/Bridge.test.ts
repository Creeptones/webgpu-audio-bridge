/**
 * Bridge — property tests for the schema-driven SPSC SAB ring.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.test.ts
 *
 * Pins:
 *   1. Construction validation (capacity must be POT, SAB sized for schema).
 *   2. byteLength / allocate / scratchFrame correctness.
 *   3. Empty pull / full push contract.
 *   4. Header + payload round-trip on the physics schema (u64 + f64).
 *   5. FIFO ordering across many push/pull cycles.
 *   6. Wrap correctness past capacity (slot reuse).
 *   7. pullLatest drain semantics + skipped count.
 *   8. available() counter under push/pull mix.
 *   9. beginPush / commitPush two-step zero-copy path.
 *  10. abortPush discards without publishing.
 *  11. pushChecked validation (throws on type / length mismatch).
 *  12. 10k mulberry32-seeded fuzz vs oracle queue.
 *  13. describeLayout returns a usable byte-offset table.
 *  14. Mixed-type schema (u64 + u8Array + f32) round-trip — exercises the
 *      alignment-grouping path (3 type-families, declared order != physical
 *      order).
 *  15. Wrap across the Int32 sign boundary (post-0.4 counter representation).
 *  16. Full-fill behavior straddling the Int32 sign boundary.
 *  17. Signed-32 counter algebra vs BigInt oracle across 10k randomized increments.
 *  18. Smoothed pulls on an empty ring return false / -1; state untouched.
 *  19. First smoothed call returns curr verbatim (no prev to blend with).
 *  20. α_base=1.0 in steady state (skipped=0) reproduces raw pullLatest values.
 *  21. Two-step seed-then-blend matches hand-computed α·B + (1-α)·A; BigInts
 *      pass through verbatim.
 *  22. Skipped-count exponentially scales α_eff via α_base · 2^(-skipped).
 *  23. pullSmoothed (single-frame) blends with α_eff = α_base (no skip scale).
 *  24. Raw pull / pullLatest invalidates the smoother's prev → next smoothed
 *      call behaves as first-call (verbatim).
 *  25. resetSmoother() — explicit invalidation path.
 *  26. Integer-kind blends Math.round through to integer (u8 scalar, u32
 *      scalar, u8Array elements); float fields are not rounded.
 *  27. f64 array blends elementwise (cross-checks the array path).
 *
 * The single-threaded scope mirrors tests/Float64RingBuffer.test.ts. Real
 * cross-thread memory ordering is covered by tests/Bridge.concurrent.test.ts.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f32,
  f64,
  u64,
  u32,
  u8,
  u8Array,
  f64Array,
  type FrameFor,
} from "../src/schema.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";

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

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

/** Make a deterministic frame keyed by seq so equality is unambiguous. */
function makePhysFrame(seq: number, n: number): PhysFrame {
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
    seq: BigInt(seq),
    tMacroNs: BigInt(seq) * 16_666_667n,
    vMax,
    jMax,
    vEff,
    jEff,
  };
}

function emptyPhysFrame(n: number): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(n),
    jEff: new Float64Array(n),
  };
}

function framesEqual(expected: PhysFrame, got: PhysFrame): boolean {
  if (expected.seq !== got.seq) return false;
  if (expected.tMacroNs !== got.tMacroNs) return false;
  if (expected.vMax !== got.vMax) return false;
  if (expected.jMax !== got.jMax) return false;
  if (expected.vEff.length !== got.vEff.length) return false;
  for (let k = 0; k < expected.vEff.length; k++) {
    if (expected.vEff[k] !== got.vEff[k]) return false;
    if (expected.jEff[k] !== got.jEff[k]) return false;
  }
  return true;
}

// ── 1. Construction validation ─────────────────────────────────────────────
function testConstructionValidation(): void {
  const schema = physicsControlFrameSchema(4);
  let threw = false;
  try {
    new Bridge(new SharedArrayBuffer(1024), 6, schema); // 6 not POT
  } catch {
    threw = true;
  }
  assert(threw, "non-power-of-two capacity throws");

  threw = false;
  try {
    new Bridge(new SharedArrayBuffer(64), 8, schema); // SAB too small
  } catch {
    threw = true;
  }
  assert(threw, "too-small SAB throws");

  ok("construction-validation");
}

// ── 2. byteLength + allocate + scratchFrame ────────────────────────────────
function testAllocateAndByteLength(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  // frameByteSize: 2 u64 (16) + 2 f64 (16) + 2*4 f64 array (64) = 96 bytes.
  // Header is 32 bytes. capacity=16 → 32 + 16*96 = 1568 bytes.
  assertEq(schema.frameByteSize, 96, "physics(4) schema frame is 96 bytes");
  assertEq(Bridge.byteLength(16, schema), 1568, "byteLength(16, physics(4))");
  const alloc = Bridge.allocate(16, schema);
  assertEq(alloc.sab.byteLength, 1568, "allocate sized SAB");
  assertEq(alloc.capacity, 16, "alloc.capacity");
  assertEq(alloc.schema, schema, "alloc.schema");
  const ring = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assertEq(ring.capacity, 16, "ring.capacity");
  assertEq(ring.frameByteSize, 96, "ring.frameByteSize");

  const scratch = ring.scratchFrame();
  assertEq(typeof scratch.seq, "bigint", "scratch.seq is bigint");
  assertEq(scratch.seq, 0n, "scratch.seq initialized to 0n");
  assertEq(typeof scratch.vMax, "number", "scratch.vMax is number");
  assertEq(scratch.vEff.length, n, "scratch.vEff length matches schema");
  assert(scratch.vEff instanceof Float64Array, "scratch.vEff is Float64Array");
  ok("allocate-and-bytelength");
}

// ── 3. Empty pull returns false ────────────────────────────────────────────
function testEmptyPull(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = ring.scratchFrame();
  assertEq(ring.pull(out), false, "empty pull returns false");
  assertEq(ring.pullLatest(out), -1, "empty pullLatest returns -1");
  assertEq(ring.available(), 0, "empty available() === 0");
  ok("empty-pull-returns-false");
}

// ── 4. Push/pull header + payload round-trip ───────────────────────────────
function testRoundTrip(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const frame = makePhysFrame(42, n);
  assertEq(ring.push(frame), true, "push to empty returns true");
  assertEq(ring.available(), 1, "available === 1 after push");
  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull returns true");
  assertEq(out.seq, 42n, "seq round-trip (bigint)");
  assertEq(out.tMacroNs, frame.tMacroNs, "tMacroNs round-trip");
  assertEq(out.vMax, frame.vMax, "vMax round-trip");
  assertEq(out.jMax, frame.jMax, "jMax round-trip");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], frame.vEff[k], `vEff[${k}] round-trip`);
    assertEq(out.jEff[k], frame.jEff[k], `jEff[${k}] round-trip`);
  }
  assertEq(ring.available(), 0, "available === 0 after drain");
  ok("round-trip");
}

// ── 5. Full push returns false ─────────────────────────────────────────────
function testFullPush(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.push(makePhysFrame(i, n)), true, `push ${i} succeeds`);
  }
  assertEq(
    ring.push(makePhysFrame(capacity, n)),
    false,
    "push when full returns false",
  );
  assertEq(ring.available(), capacity, "available === capacity when full");
  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull from full succeeds");
  assertEq(out.seq, 0n, "drained the oldest frame");
  assertEq(
    ring.push(makePhysFrame(capacity, n)),
    true,
    "push after drain succeeds",
  );
  ok("full-push-returns-false");
}

// ── 6. FIFO ordering across many cycles ────────────────────────────────────
function testFifoOrdering(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) ring.push(makePhysFrame(i, n));
  for (let i = 0; i < 4; i++) {
    assertEq(ring.pull(out), true, `fifo pull ${i} succeeds`);
    assertEq(out.seq, BigInt(i), `fifo pull ${i} seq matches`);
    assertEq(out.vEff[0], i, `fifo pull ${i} vEff[0] matches`);
  }
  ok("fifo-ordering");
}

// ── 7. Wrap correctness past capacity ──────────────────────────────────────
function testWrapAcrossCapacity(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < capacity * 5 + 3; i++) {
    assertEq(ring.push(makePhysFrame(i, n)), true, `wrap push ${i}`);
    assertEq(ring.pull(out), true, `wrap pull ${i}`);
    assertEq(out.seq, BigInt(i), `wrap order preserved at i=${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.push(makePhysFrame(1000 + i, n)), true, `wrap fill ${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.pull(out), true, `wrap drain ${i}`);
    assertEq(out.seq, BigInt(1000 + i), `wrap drain order at ${i}`);
  }
  ok("wrap-across-capacity");
}

// ── 8. pullLatest drains and reports skipped ───────────────────────────────
function testPullLatest(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.pullLatest(out), -1, "pullLatest on empty");
  ring.push(makePhysFrame(7, n));
  assertEq(ring.pullLatest(out), 0, "single frame → 0 skipped");
  assertEq(out.seq, 7n, "single frame returns seq=7");
  assertEq(ring.available(), 0, "single frame fully drained");
  for (let i = 0; i < 5; i++) ring.push(makePhysFrame(100 + i, n));
  assertEq(ring.pullLatest(out), 4, "5 frames → 4 skipped");
  assertEq(out.seq, 104n, "5 frames returns newest seq=104");
  assertEq(out.vEff[0], 104, "5 frames returns newest vEff[0]");
  assertEq(ring.available(), 0, "5 frames fully drained");
  ok("pull-latest");
}

// ── 9. available() counter under push/pull mix ────────────────────────────
function testAvailableCounter(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.available(), 0, "available 0 at start");
  ring.push(makePhysFrame(1, n));
  assertEq(ring.available(), 1, "available 1 after 1 push");
  ring.push(makePhysFrame(2, n));
  assertEq(ring.available(), 2, "available 2 after 2 pushes");
  ring.pull(out);
  assertEq(ring.available(), 1, "available 1 after 1 pull");
  ring.pull(out);
  assertEq(ring.available(), 0, "available 0 after drain");
  ok("available-counter");
}

// ── 10. beginPush / commitPush two-step path ──────────────────────────────
function testBeginCommitPush(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const slot = ring.beginPush();
  assert(slot !== null, "beginPush returns a slot when ring is empty");
  slot!.seq = 999n;
  slot!.tMacroNs = 12345n;
  slot!.vMax = 0.5;
  slot!.jMax = 0.25;
  for (let k = 0; k < n; k++) {
    slot!.vEff[k] = k * 2 + 1;
    slot!.jEff[k] = -k - 0.5;
  }
  ring.commitPush();

  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull after commit");
  assertEq(out.seq, 999n, "begin/commit: seq round-trip");
  assertEq(out.tMacroNs, 12345n, "begin/commit: tMacroNs round-trip");
  assertEq(out.vMax, 0.5, "begin/commit: vMax round-trip");
  assertEq(out.jMax, 0.25, "begin/commit: jMax round-trip");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], k * 2 + 1, `begin/commit: vEff[${k}]`);
    assertEq(out.jEff[k], -k - 0.5, `begin/commit: jEff[${k}]`);
  }

  // commitPush without beginPush throws.
  let threw = false;
  try { ring.commitPush(); } catch { threw = true; }
  assert(threw, "commitPush without beginPush throws");

  // Two beginPush in a row throws.
  ring.beginPush();
  threw = false;
  try { ring.beginPush(); } catch { threw = true; }
  assert(threw, "double beginPush throws");
  ring.abortPush();
  ok("begin-commit-push");
}

// ── 11. abortPush discards without publishing ──────────────────────────────
function testAbortPush(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const before = ring.available();
  const slot = ring.beginPush();
  assert(slot !== null, "beginPush returns a slot");
  slot!.seq = 7n;
  ring.abortPush();
  assertEq(ring.available(), before, "abortPush does not advance write_index");

  // We can now beginPush again.
  const slot2 = ring.beginPush();
  assert(slot2 !== null, "beginPush after abort succeeds");
  ring.abortPush();
  ok("abort-push");
}

// ── 12. pushChecked validation ─────────────────────────────────────────────
function testPushChecked(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  // Wrong scalar type — passing number where bigint expected.
  let threw = false;
  try {
    ring.pushChecked({
      seq: 1 as unknown as bigint,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float64Array(n),
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects number where bigint expected");

  // Wrong array length.
  threw = false;
  try {
    ring.pushChecked({
      seq: 1n,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float64Array(n - 1),
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects wrong-length array");

  // Wrong array type (Float32Array where Float64Array expected).
  threw = false;
  try {
    ring.pushChecked({
      seq: 1n,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float32Array(n) as unknown as Float64Array,
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects wrong typed-array kind");

  // Correct frame passes.
  assertEq(ring.pushChecked(makePhysFrame(1, n)), true, "pushChecked accepts a valid frame");
  ok("push-checked");
}

// ── 13. 10k mulberry32 fuzz vs oracle queue ───────────────────────────────
function testFuzzVsOracle(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const rng = mulberry32(0xc0ffee);
  const oracle: PhysFrame[] = [];
  const out = emptyPhysFrame(n);
  let nextSeq = 0;
  let pushes = 0;
  let pulls = 0;
  let fullRejects = 0;
  let emptyRejects = 0;
  for (let iter = 0; iter < 10_000; iter++) {
    const op = rng() < 0.5 ? "push" : "pull";
    if (op === "push") {
      const f = makePhysFrame(nextSeq++, n);
      const want = oracle.length < capacity;
      const got = ring.push(f);
      assertEq(got, want, `fuzz iter ${iter} push outcome`);
      if (got) {
        oracle.push(f);
        pushes++;
      } else {
        fullRejects++;
      }
    } else {
      const want = oracle.length > 0;
      const got = ring.pull(out);
      assertEq(got, want, `fuzz iter ${iter} pull outcome`);
      if (got) {
        const expected = oracle.shift()!;
        assert(
          framesEqual(expected, out),
          `fuzz iter ${iter} pull payload matches oracle (expected seq ${expected.seq}, got ${out.seq})`,
        );
        pulls++;
      } else {
        emptyRejects++;
      }
    }
    assertEq(ring.available(), oracle.length, `fuzz iter ${iter} available()`);
  }
  while (oracle.length > 0) {
    assertEq(ring.pull(out), true, "drain pull");
    const expected = oracle.shift()!;
    assert(framesEqual(expected, out), `drain pull matches oracle seq ${expected.seq}`);
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

// ── 14. describeLayout returns a usable byte-offset table ──────────────────
function testDescribeLayout(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);
  const desc = ring.describeLayout();
  assertEq(desc.headerBytes, 32, "header bytes constant");
  assertEq(desc.frameByteSize, schema.frameByteSize, "frame size echoed");
  // Every schema field is present in the description.
  assert("seq" in desc.fields, "seq in layout");
  assert("vEff" in desc.fields, "vEff in layout");
  // Push one frame, then read it back using only the layout description —
  // proves the description is self-sufficient for an inlined consumer.
  ring.push(makePhysFrame(123, n));
  const f64View = new Float64Array(sab, desc.headerBytes, capacity * (desc.frameByteSize / 8));
  const seqDesc = desc.fields.seq!;
  const u64View = new BigUint64Array(sab, desc.headerBytes, capacity * (desc.frameByteSize / 8));
  const seqElemIdx = seqDesc.byteOffset / 8;
  assertEq(u64View[seqElemIdx], 123n, "inlined read sees seq=123n at the right offset");
  const vEffDesc = desc.fields.vEff!;
  const vEffElemIdx = vEffDesc.byteOffset / 8;
  assertEq(
    f64View[vEffElemIdx],
    123,
    "inlined read sees vEff[0] = 123 at the right offset",
  );
  ok("describe-layout");
}

// ── 15. Mixed-type schema (u64 + u8Array + f32) round-trip ────────────────
function testMixedTypeSchema(): void {
  // Declared order: ts (u64), label (u8Array(16)), value (f32).
  // Physical order after alignment grouping: ts (8) → value (4) → label (1).
  const schema = defineSchema({
    ts: u64(),
    label: u8Array(16),
    value: f32(),
  });
  // Frame size: 8 + 4 + 16 = 28, padded to 32.
  assertEq(schema.frameByteSize, 32, "mixed-type frame padded to 32");

  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const label = new Uint8Array(16);
  for (let i = 0; i < 16; i++) label[i] = (i * 7) & 0xff;
  const frame: FrameFor<typeof schema> = {
    ts: 0xdeadbeefcafef00dn,
    label,
    value: Math.fround(3.14159),
  };
  assertEq(ring.push(frame), true, "mixed push succeeds");

  const out: FrameFor<typeof schema> = {
    ts: 0n,
    label: new Uint8Array(16),
    value: 0,
  };
  assertEq(ring.pull(out), true, "mixed pull succeeds");
  assertEq(out.ts, 0xdeadbeefcafef00dn, "u64 round-trip preserves all 64 bits");
  assertEq(out.value, Math.fround(3.14159), "f32 round-trip");
  for (let i = 0; i < 16; i++) {
    assertEq(out.label[i], (i * 7) & 0xff, `u8Array[${i}] round-trip`);
  }
  ok("mixed-type-schema");
}

// ── 15. Wrap across the Int32 sign boundary ────────────────────────────────
//
// Post-0.4 the ring counters are Int32 wrapping mod 2^32, with the signed-32
// diff `(a - b) | 0` carrying the true delta for any |delta| < 2^31. This
// test seeds both counters just below INT32_MAX so a small loop pushes them
// across the sign boundary (0x7FFFFFFF → 0x80000000, which is -2^31 signed).
// Each cycle must still: (a) accept push, (b) compute the right slot via
// `(idx >>> 0) & mask`, (c) compute the right available count via signed
// subtraction, (d) round-trip every schema field.
function testWrapAcrossInt32Boundary(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  // Seed both counters to (INT32_MAX - 2). Ring is empty (write === read).
  const seed = ((1 << 31) - 3) | 0; // 0x7FFFFFFD
  const idx = new Int32Array(sab, 0, 2);
  Atomics.store(idx, 0, seed);
  Atomics.store(idx, 1, seed);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.available(), 0, "wrap-seeded ring is empty");
  const out = emptyPhysFrame(n);
  // Walk push/pull 20 times. Counters cross 0x7FFFFFFF → 0x80000000 (negative
  // signed). The signed diff and unsigned mask must both stay correct.
  for (let i = 0; i < 20; i++) {
    assertEq(ring.push(makePhysFrame(2000 + i, n)), true, `wrap-i32 push ${i}`);
    assertEq(ring.available(), 1, `wrap-i32 available after push ${i}`);
    assertEq(ring.pull(out), true, `wrap-i32 pull ${i}`);
    assertEq(out.seq, BigInt(2000 + i), `wrap-i32 seq round-trip ${i}`);
    assertEq(out.vEff[0], 2000 + i, `wrap-i32 vEff[0] round-trip ${i}`);
    assertEq(ring.available(), 0, `wrap-i32 available after pull ${i}`);
  }
  // Sanity: the counters actually crossed the sign boundary.
  const finalWrite = Atomics.load(idx, 0);
  assert(
    finalWrite < 0,
    `wrap-i32: writeIdx is now negative (=${finalWrite}); confirms the sign bit crossed`,
  );
  ok("wrap-across-int32-boundary");
}

// ── 16. Full-fill straddling Int32 sign boundary ───────────────────────────
//
// Fill to capacity while the counters cross INT32_MAX → INT32_MIN. Verifies
// the full-check (signed-32 diff >= capacity) keeps working when writeIdx is
// negative and readIdx is positive.
function testFullPushAtInt32Boundary(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  // Seed so writeIdx wraps mid-fill: starting at INT32_MAX - 1, after 4
  // pushes it's at INT32_MAX + 3, which signed-32 is INT32_MIN + 2 (negative).
  const seed = ((1 << 31) - 2) | 0; // 0x7FFFFFFE
  const idx = new Int32Array(sab, 0, 2);
  Atomics.store(idx, 0, seed);
  Atomics.store(idx, 1, seed);
  const ring = new Bridge(sab, capacity, schema);
  for (let i = 0; i < capacity; i++) {
    assertEq(
      ring.push(makePhysFrame(3000 + i, n)),
      true,
      `wrap-full push ${i}`,
    );
  }
  assertEq(ring.available(), capacity, "available === capacity across boundary");
  assertEq(
    ring.push(makePhysFrame(3999, n)),
    false,
    "full push rejected across boundary",
  );
  // Drain in order — FIFO must hold across wrap.
  const out = emptyPhysFrame(n);
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.pull(out), true, `wrap-full pull ${i}`);
    assertEq(out.seq, BigInt(3000 + i), `wrap-full seq order ${i}`);
  }
  ok("full-push-at-int32-boundary");
}

// ── 17. Signed-32 counter algebra vs BigInt oracle ────────────────────────
//
// Mirrors the methodology of the wavefunction-synth's doubleSingle.test.ts
// (the DS-f32 validator that drives WGSL): randomized stream of pushes/pulls
// under both an i32-wrapping counter and a BigInt-monotonic oracle, asserting
// the signed-32 diff `(a - b) | 0` and the unsigned-mask slot `(a >>> 0) & mask`
// match the oracle bit-exactly at every step. Seeded near INT32_MAX so the
// run covers the sign boundary. The integer algebra is exact, so we assert
// === (not assertNear).
function testCounterArithmeticVsOracle(): void {
  const rng = mulberry32(0xdeadbeef);
  const capacity = 16;
  const mask = capacity - 1;
  // Seed near INT32_MAX so the wrap fires within the 10k-iter budget.
  const seed = ((1 << 31) - 100) | 0;
  let writeOracle = BigInt(seed);
  let readOracle = BigInt(seed);
  let writeI32 = seed | 0;
  let readI32 = seed | 0;
  let crossedBoundary = false;
  for (let iter = 0; iter < 10_000; iter++) {
    // Property 1: signed-32 diff matches the oracle's true diff.
    // Holds for any |true_diff| < 2^31; in this test |diff| ≤ capacity.
    const oracleDiff = writeOracle - readOracle;
    const i32Diff = ((writeI32 - readI32) | 0);
    if (BigInt(i32Diff) !== oracleDiff) {
      throw new Error(
        `iter ${iter}: i32 diff=${i32Diff} vs oracle=${oracleDiff} ` +
          `(write i32=${writeI32}/oracle=${writeOracle}, read i32=${readI32}/oracle=${readOracle})`,
      );
    }
    // Property 2: unsigned-mask slot matches the oracle's mod-capacity slot.
    // Holds for any writeIdx regardless of signed-ness because the low
    // log2(capacity) bits are sign-invariant.
    const slotOracle = Number(writeOracle & BigInt(mask));
    const slotI32 = (writeI32 >>> 0) & mask;
    if (slotI32 !== slotOracle) {
      throw new Error(
        `iter ${iter}: i32 slot=${slotI32} vs oracle=${slotOracle} (writeI32=${writeI32}, writeOracle=${writeOracle})`,
      );
    }
    if (writeI32 < 0) crossedBoundary = true;
    // Pick op: 50% push (gated by oracle-not-full), 50% pull (gated by oracle-not-empty).
    const op = rng();
    if (op < 0.5 && oracleDiff < BigInt(capacity)) {
      writeOracle += 1n;
      writeI32 = (writeI32 + 1) | 0;
    } else if (oracleDiff > 0n) {
      readOracle += 1n;
      readI32 = (readI32 + 1) | 0;
    }
  }
  assert(crossedBoundary, "fuzz crossed the Int32 sign boundary (writeI32 went negative)");
  ok(`counter-arithmetic-vs-oracle (10k iters, sign boundary crossed)`);
}

// ── 18. Smoothed pulls — empty-ring behavior ───────────────────────────────
//
// On an empty ring, pullSmoothed returns false and pullLatestSmoothed returns
// -1 (matching pull / pullLatest). No payload is read; the smoother's prev
// state is untouched.
function testSmoothedEmpty(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.pullSmoothed(out, 0.5), false, "empty pullSmoothed returns false");
  assertEq(ring.pullLatestSmoothed(out, 0.5), -1, "empty pullLatestSmoothed returns -1");
  // Push, smoothed-pull, then drain to empty, then smoothed-pull empty again:
  // the second smoothed empty must still return false / -1 (the prior state
  // doesn't leak into an empty-pull return value).
  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "post-empty pullLatestSmoothed succeeds");
  assertEq(ring.pullSmoothed(out, 0.5), false, "back-to-empty pullSmoothed returns false");
  ok("smoothed-empty");
}

// ── 19. First smoothed call returns curr verbatim (no prev to blend with) ──
//
// The first pullSmoothed / pullLatestSmoothed seeds the smoother's prev with
// the fresh frame and returns it unchanged regardless of α. This is the
// "warm-up" guarantee: callers don't have to special-case the first quantum.
function testSmoothedFirstCallNoBlend(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  const F = makePhysFrame(42, n);
  ring.push(F);
  assertEq(ring.pullLatestSmoothed(out, 0.1), 0, "first pullLatestSmoothed returns 0 skipped");
  // Even with a tiny α (would normally blend heavily with prev) — because
  // there is no prev, the fresh value is returned verbatim.
  assertEq(out.seq, F.seq, "first-call seq verbatim");
  assertEq(out.vMax, F.vMax, "first-call vMax verbatim");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], F.vEff[k], `first-call vEff[${k}] verbatim`);
  }

  // pullSmoothed first-call case on a separate Bridge instance.
  const { sab: sab2, capacity: cap2 } = Bridge.allocate(8, schema);
  const ring2 = new Bridge(sab2, cap2, schema);
  const out2 = emptyPhysFrame(n);
  const G = makePhysFrame(7, n);
  ring2.push(G);
  assertEq(ring2.pullSmoothed(out2, 0.05), true, "first pullSmoothed returns true");
  assertEq(out2.seq, G.seq, "first pullSmoothed seq verbatim");
  assertEq(out2.vMax, G.vMax, "first pullSmoothed vMax verbatim");
  ok("smoothed-first-call-no-blend");
}

// ── 20. α=1.0 in steady state ⇒ equivalent to raw pullLatest ──────────────
//
// For pullLatestSmoothed, α_eff = α_base · 2^(-skipped). At α_base=1.0 with
// skipped=0, α_eff = 1.0 and blend(curr, prev, 1) = curr. So a sequence of
// α=1.0 pulls at steady-state cadence reproduces raw pullLatest values
// bit-exactly. (At α_base=1.0 with skipped>0, α_eff < 1, which is the
// expected skip-scaled blend — covered separately below.)
function testSmoothedAlphaOneEqualsRawSteadyState(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 10; i++) {
    const F = makePhysFrame(100 + i, n);
    ring.push(F);
    assertEq(ring.pullLatestSmoothed(out, 1.0), 0, `α=1 cycle ${i} skipped=0`);
    assertEq(out.seq, F.seq, `α=1 cycle ${i} seq verbatim`);
    assertEq(out.vMax, F.vMax, `α=1 cycle ${i} vMax verbatim`);
    for (let k = 0; k < n; k++) {
      assertEq(out.vEff[k], F.vEff[k], `α=1 cycle ${i} vEff[${k}] verbatim`);
    }
  }
  ok("smoothed-alpha-one-equals-raw-steady-state");
}

// ── 21. Two-step blend — hand-computed expected values ────────────────────
//
// Push frame A (vMax=10), pullLatestSmoothed(α=0.5) → out=A verbatim, prev=A.
// Push frame B (vMax=20), pullLatestSmoothed(α=0.5) → expected blend:
//   out_i = 0.5·B_i + 0.5·A_i
// for each numeric field. BigInt fields (seq, tMacroNs) are NOT blended —
// they pass through as B verbatim.
function testSmoothedHandComputedBlend(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(10, n);
  ring.push(A);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "seed call");
  assertEq(out.vMax, A.vMax, "seed vMax = A.vMax");

  const B = makePhysFrame(20, n);
  ring.push(B);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "blend call skipped=0");
  // BigInt verbatim (no blend).
  assertEq(out.seq, B.seq, "blend: seq passes through as B");
  assertEq(out.tMacroNs, B.tMacroNs, "blend: tMacroNs passes through as B");
  // Float fields: 0.5·B + 0.5·A.
  assertEq(out.vMax, 0.5 * B.vMax + 0.5 * A.vMax, "blend: vMax = 0.5·B + 0.5·A");
  assertEq(out.jMax, 0.5 * B.jMax + 0.5 * A.jMax, "blend: jMax = 0.5·B + 0.5·A");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], 0.5 * B.vEff[k]! + 0.5 * A.vEff[k]!, `blend: vEff[${k}]`);
    assertEq(out.jEff[k], 0.5 * B.jEff[k]! + 0.5 * A.jEff[k]!, `blend: jEff[${k}]`);
  }
  ok("smoothed-hand-computed-blend");
}

// ── 22. Skipped-count exponentially scales α_eff ──────────────────────────
//
// α_eff = α_base · 2^(-skipped). Seed with A; push frames B0..B3; one
// pullLatestSmoothed sees skipped=3, α_eff = α_base / 8. The blended out
// matches the hand-computed alpha-scaled blend with B3 as curr and A as prev.
function testSmoothedSkipScaling(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(0, n);
  ring.push(A);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "skip-scaling seed");

  ring.push(makePhysFrame(1, n));
  ring.push(makePhysFrame(2, n));
  ring.push(makePhysFrame(3, n));
  const Bnewest = makePhysFrame(4, n); // matches what producer #4 will push
  ring.push(Bnewest);

  const alphaBase = 0.5;
  // 4 frames after seed: write_index = 5, read_index = 1 (we consumed A).
  // newestIdx = 4, skipped = newestIdx - readIdx = 3.
  assertEq(ring.pullLatestSmoothed(out, alphaBase), 3, "skip-scaling sees 3 skipped");
  const alphaEff = alphaBase * Math.pow(2, -3); // 0.0625
  assertEq(out.seq, Bnewest.seq, "skip-scaling seq verbatim");
  // Hand-compute vMax: α·curr + (1-α)·prev where prev came from seed call (= A).
  const expectedVMax = alphaEff * Bnewest.vMax + (1 - alphaEff) * A.vMax;
  assertEq(out.vMax, expectedVMax, "skip-scaling vMax matches α_eff·B + (1-α_eff)·A");
  for (let k = 0; k < n; k++) {
    const want = alphaEff * Bnewest.vEff[k]! + (1 - alphaEff) * A.vEff[k]!;
    assertEq(out.vEff[k], want, `skip-scaling vEff[${k}]`);
  }
  ok("smoothed-skip-scaling");
}

// ── 23. pullSmoothed (single-frame) blends with α_base (no skip scaling) ──
//
// pullSmoothed consumes one frame per call; skipped is always 0 conceptually,
// so α_eff = α_base. Verify a two-step seed-then-blend matches the hand
// computation.
function testSmoothedPullSymmetricToPull(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(5, n);
  ring.push(A);
  assertEq(ring.pullSmoothed(out, 0.25), true, "pullSmoothed seed");
  assertEq(out.vMax, A.vMax, "pullSmoothed seed verbatim");

  const B = makePhysFrame(15, n);
  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.25), true, "pullSmoothed blend");
  // α_eff = α_base = 0.25 (no skip scaling for pullSmoothed).
  assertEq(out.vMax, 0.25 * B.vMax + 0.75 * A.vMax, "pullSmoothed: vMax = 0.25·B + 0.75·A");
  assertEq(out.seq, B.seq, "pullSmoothed: seq verbatim (BigInt)");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], 0.25 * B.vEff[k]! + 0.75 * A.vEff[k]!, `pullSmoothed vEff[${k}]`);
  }
  ok("smoothed-pull-symmetric-to-pull");
}

// ── 24. Non-smoothed pull invalidates smoother state ──────────────────────
//
// pull / pullLatest set smoothPrevValid=false. The next pullSmoothed /
// pullLatestSmoothed must behave as a first-call (no blending, just seed
// prev with curr). Validates the file-header guarantee.
function testNonSmoothedPullInvalidatesSmoother(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  // Seed the smoother.
  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullSmoothed(out, 0.5), true, "seed pullSmoothed");
  // Invalidate via raw pull.
  ring.push(makePhysFrame(2, n));
  assertEq(ring.pull(out), true, "raw pull invalidates smoother");
  // Next smoothed must behave like first call (verbatim).
  const F99 = makePhysFrame(99, n);
  ring.push(F99);
  assertEq(ring.pullSmoothed(out, 0.01), true, "post-invalidate pullSmoothed");
  // With α=0.01 a blend would heavily favor prev; verbatim ⇒ value == F99.
  assertEq(out.vMax, F99.vMax, "post-invalidate pullSmoothed returns curr verbatim");
  assertEq(out.seq, F99.seq, "post-invalidate pullSmoothed seq verbatim");

  // Same with pullLatest.
  ring.push(makePhysFrame(100, n));
  ring.push(makePhysFrame(101, n));
  assertEq(ring.pullLatest(out), 1, "raw pullLatest invalidates smoother");
  const F50 = makePhysFrame(50, n);
  ring.push(F50);
  assertEq(ring.pullLatestSmoothed(out, 0.01), 0, "post-invalidate pullLatestSmoothed");
  assertEq(out.vMax, F50.vMax, "post-invalidate pullLatestSmoothed verbatim");
  ok("non-smoothed-pull-invalidates-smoother");
}

// ── 25. resetSmoother() forgets prev ──────────────────────────────────────
//
// Explicit reset path. Same observable behavior as raw-pull invalidation
// but without consuming a frame.
function testResetSmoother(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullSmoothed(out, 0.5), true, "seed");
  ring.resetSmoother();
  const F99 = makePhysFrame(99, n);
  ring.push(F99);
  // With α=0.001 a blend would barely move from prev. Verbatim ⇒ vMax = F99.vMax.
  assertEq(ring.pullSmoothed(out, 0.001), true, "post-reset pull");
  assertEq(out.vMax, F99.vMax, "resetSmoother: next smoothed call is verbatim");
  ok("reset-smoother");
}

// ── 26. Integer-kind smoothing rounds via Math.round ──────────────────────
//
// For numeric integer kinds (u8, u16, u32, i8, i16, i32 and their *Array
// variants), the blend runs in float and the result is Math.round-ed back
// before being stored. Use a u8 + u32 + u8Array schema with a 0.5 blend
// between values that produce a half-integer raw blend; verify rounding.
function testSmoothedIntegerRounding(): void {
  const schema = defineSchema({
    a8: u8(),
    a32: u32(),
    arr: u8Array(4),
    fv: f64(), // float field for completeness — should not be rounded
  });
  type Frame = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const A: Frame = { a8: 10, a32: 100, arr: new Uint8Array([0, 10, 20, 30]), fv: 1.0 };
  const B: Frame = { a8: 11, a32: 101, arr: new Uint8Array([1, 11, 21, 31]), fv: 2.0 };
  const out: Frame = { a8: 0, a32: 0, arr: new Uint8Array(4), fv: 0 };

  ring.push(A);
  assertEq(ring.pullSmoothed(out, 0.5), true, "int seed");
  assertEq(out.a8, A.a8, "int seed a8");

  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.5), true, "int blend");
  // 0.5·11 + 0.5·10 = 10.5 → Math.round(10.5) = 11 (banker's? no — JS Math.round rounds half-away-from-zero positive = 11).
  assertEq(out.a8, Math.round(0.5 * B.a8 + 0.5 * A.a8), "u8 scalar rounded");
  assertEq(out.a32, Math.round(0.5 * B.a32 + 0.5 * A.a32), "u32 scalar rounded");
  for (let k = 0; k < 4; k++) {
    const want = Math.round(0.5 * B.arr[k]! + 0.5 * A.arr[k]!);
    assertEq(out.arr[k], want, `u8Array[${k}] rounded`);
  }
  // Float field NOT rounded.
  assertEq(out.fv, 0.5 * B.fv + 0.5 * A.fv, "f64 scalar not rounded");
  ok("smoothed-integer-rounding");
}

// ── 27. Mixed scalar/array schema with float array round-trips a blend ────
//
// Cross-check that an array of f64 blends elementwise without any quirks
// from the typed-array set() path interfering. Uses a 16-element f64 array.
function testSmoothedFloatArrayBlend(): void {
  const schema = defineSchema({
    seq: u64(),
    sig: f64Array(16),
  });
  type Frame = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const mk = (base: number): Frame => {
    const sig = new Float64Array(16);
    for (let k = 0; k < 16; k++) sig[k] = base + k * 0.1;
    return { seq: BigInt(base), sig };
  };
  const out: Frame = { seq: 0n, sig: new Float64Array(16) };

  const A = mk(1);
  ring.push(A);
  ring.pullSmoothed(out, 0.3); // seed

  const B = mk(2);
  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.3), true, "float-array blend");
  assertEq(out.seq, B.seq, "float-array seq verbatim");
  for (let k = 0; k < 16; k++) {
    const want = 0.3 * B.sig[k]! + 0.7 * A.sig[k]!;
    assertEq(out.sig[k], want, `float-array sig[${k}]`);
  }
  ok("smoothed-float-array-blend");
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
  testAvailableCounter();
  testBeginCommitPush();
  testAbortPush();
  testPushChecked();
  testFuzzVsOracle();
  testDescribeLayout();
  testMixedTypeSchema();
  testWrapAcrossInt32Boundary();
  testFullPushAtInt32Boundary();
  testCounterArithmeticVsOracle();
  testSmoothedEmpty();
  testSmoothedFirstCallNoBlend();
  testSmoothedAlphaOneEqualsRawSteadyState();
  testSmoothedHandComputedBlend();
  testSmoothedSkipScaling();
  testSmoothedPullSymmetricToPull();
  testNonSmoothedPullInvalidatesSmoother();
  testResetSmoother();
  testSmoothedIntegerRounding();
  testSmoothedFloatArrayBlend();
  console.log("\nAll Bridge tests passed.");
}

main();
