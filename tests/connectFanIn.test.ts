/**
 * connectFanIn.test.ts — single-thread API pins for the MP→SC fan-in topology
 * constructor (src/connectFanIn.ts, Apollo Frontier 3, Stage 3, 0.9.909).
 *
 * Exercises the `connectFanIn(spec) → handle → mountFanIn(handle, opts)` recipe:
 * the Turbo-only env gate (no Standard fallback — throws isolation-required),
 * producerCount validation, the sizing + envelope guard (usableDepth /
 * reservedSlack, capacity > producerCount), the allocate-once / mount-many
 * bit-exact round-trip over ONE shared SAB, drop-newest counting through the
 * mount surface, the critical initLayout-not-re-called discipline (a late peer
 * mount must NOT reset the ring), and the layout-skew guard.
 *
 * The environment is INJECTED via `spec.environment` so the suite is
 * deterministic under Node/tsx (where `crossOriginIsolated` is undefined but
 * `SharedArrayBuffer` is present), exactly like tests/connect.test.ts.
 *
 * The exhaustive interleaving proof of the underlying primitive lives in
 * tests/MpmcRing.interleaving.test.ts; the cross-thread fan-in stress (the
 * wiring under real parallelism) in tests/connectFanIn.concurrent.test.ts.
 *
 * Standalone tsx script — no test framework. Run: `tsx tests/connectFanIn.test.ts`.
 *
 * Pins (this suite opens its own list at 1):
 *   1. Turbo handle shape (kind:'mpmc', sab, producerCount, layout, sizing, empty transfer).
 *   2. Turbo-only env gate: standard → isolation-required, unsupported → unsupported,
 *      NO MessageChannel fallback; producerCount validation.
 *   3. sizing + envelope guard: enum hint usableDepth ≥ backlog, capacity > producerCount,
 *      reservedSlack/usableDepth correct; capacity override respected (pow2, floored).
 *   4. allocate-once / mount-many: bit-exact round-trip every FieldKind, two producers
 *      + one consumer over one SAB, FIFO-by-ticket, every producer's frames delivered.
 *   5. drop-newest-when-full counted through the mount surface (slack reserved).
 *   6. initLayout-not-re-called: a peer mounted AFTER frames are buffered sees them
 *      (the bare ctor must NOT reset header/gen).
 *   7. layout-skew guard: different frameByteSize AND same-byteSize-different-shape throw.
 *   8. LatencyBudget (block schema) sizes usableDepth from the budget + reports latency.
 *   9. topology.mount() (allocator's own thread) is symmetric with free mountFanIn().
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array, f32Array,
} from "../src/index.js";
import { ConnectUnsupportedError } from "../src/connect.js";
import { connectFanIn, mountFanIn } from "../src/connectFanIn.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { MpmcRing } from "../src/MpmcRing.js";

// Silence (and capture) the one-shot experimental warning from MpmcRing.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

// ── EnvironmentReport fixtures (mirrors tests/connect.test.ts) ───────────────
const baseReport = getEnvironmentReport();
function turbo(): EnvironmentReport {
  return {
    ...baseReport,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    atomics: true,
    suggestedMode: "turbo",
    fixes: [],
  } as EnvironmentReport;
}
function standard(): EnvironmentReport {
  return { ...baseReport, crossOriginIsolated: false, suggestedMode: "standard" } as EnvironmentReport;
}
function unsupported(): EnvironmentReport {
  return { ...baseReport, suggestedMode: "unsupported" } as EnvironmentReport;
}

const allKinds = defineSchema({
  producerId: u32(),
  seq: u32(),
  a_u64: u64(),
  a_i64: i64(),
  a_f64: f64(),
  a_i32: i32(),
  a_f32: f32(),
  a_u16: u16(),
  a_i16: i16(),
  a_u8: u8(),
  a_i8: i8(),
  arr: f64Array(4),
  iarr: i32Array(3),
});
type AllKinds = typeof allKinds;

/** Local "throws + message matches" helper (the shared _assert has none). */
function assertThrows(fn: () => unknown, re: RegExp, msg: string): void {
  let threw: unknown;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== undefined, `${msg}: expected throw, got none`);
  const text = threw instanceof Error ? threw.message : String(threw);
  assert(re.test(text), `${msg}: message ${JSON.stringify(text)} !~ ${re}`);
}

function makeFrame(producerId: number, seq: number) {
  return {
    producerId,
    seq,
    a_u64: 0xfedcba9876543210n,
    a_i64: -1234567890123456n,
    a_f64: -3.141592653589793,
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

// ── 1. Turbo handle shape ───────────────────────────────────────────────────
function pin1_handleShape(): void {
  const topo = connectFanIn<AllKinds>({
    schema: allKinds,
    producerCount: 3,
    environment: turbo(),
  });
  assertEq(topo.handle.kind, "mpmc", "handle marked kind 'mpmc'");
  assert(topo.handle.sab instanceof SharedArrayBuffer, "handle carries a SharedArrayBuffer");
  assertEq(topo.handle.producerCount, 3, "producerCount carried in handle");
  assertEq(
    topo.handle.layout.frameByteSize,
    allKinds.frameByteSize,
    "handle layout frameByteSize matches the schema",
  );
  assertEq(topo.transferList.length, 0, "transferList empty (SABs are shared, not transferred)");
  assertEq(topo.handle.sizing.reservedSlack, 2, "reservedSlack = producerCount − 1");
  assertEq(
    topo.handle.sizing.usableDepth,
    topo.handle.capacity - 2,
    "usableDepth = capacity − reservedSlack",
  );
  assertEq(topo.handle.sab.byteLength, MpmcRing.byteLength(allKinds, topo.handle.capacity),
    "SAB sized exactly to MpmcRing.byteLength");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  ok("1 connectFanIn() Turbo handle shape");
}

// ── 2. Turbo-only env gate + producerCount validation ───────────────────────
function pin2_envGateAndValidation(): void {
  // Standard (non-isolated) → isolation-required, NOT a MessageChannel fallback.
  let threw: unknown;
  try {
    connectFanIn<AllKinds>({ schema: allKinds, producerCount: 1, environment: standard() });
  } catch (e) { threw = e; }
  assert(threw instanceof ConnectUnsupportedError, "standard env throws ConnectUnsupportedError");
  assertEq((threw as ConnectUnsupportedError).reason, "isolation-required",
    "reason is isolation-required (no Standard fallback)");
  assert(/no Standard-mode|Turbo-only|fan-in/i.test((threw as Error).message),
    "error message states the no-fallback rationale");

  // Unsupported (no AudioWorklet at all) → unsupported.
  let threw2: unknown;
  try {
    connectFanIn<AllKinds>({ schema: allKinds, producerCount: 1, environment: unsupported() });
  } catch (e) { threw2 = e; }
  assert(threw2 instanceof ConnectUnsupportedError, "unsupported env throws");
  assertEq((threw2 as ConnectUnsupportedError).reason, "unsupported", "reason is unsupported");

  // producerCount validation.
  assertThrows(
    () => connectFanIn<AllKinds>({ schema: allKinds, producerCount: 0, environment: turbo() }),
    /producerCount/, "producerCount 0 rejected");
  assertThrows(
    () => connectFanIn<AllKinds>({ schema: allKinds, producerCount: 2.5, environment: turbo() }),
    /producerCount/, "non-integer producerCount rejected");
  ok("2 Turbo-only env gate + producerCount validation");
}

// ── 3. sizing + envelope guard ──────────────────────────────────────────────
function pin3_sizing(): void {
  // Enum hint: usableDepth ≥ the backlog the hint requests, capacity > producerCount.
  const mk = (hint: "tracking" | "balanced" | "throughput", producerCount: number) =>
    connectFanIn<AllKinds>({ schema: allKinds, producerCount, latencyHint: hint, environment: turbo() });

  for (const [hint, backlog] of [["tracking", 64], ["balanced", 256], ["throughput", 1024]] as const) {
    const topo = mk(hint, 4);
    const { capacity } = topo.handle;
    const { reservedSlack, usableDepth } = topo.handle.sizing;
    assertEq(reservedSlack, 3, `${hint}: reservedSlack = producerCount − 1`);
    assertEq(usableDepth, capacity - 3, `${hint}: usableDepth = capacity − slack`);
    assert(usableDepth >= backlog, `${hint}: usableDepth (${usableDepth}) ≥ backlog (${backlog})`);
    assert(capacity > 4, `${hint}: capacity (${capacity}) > producerCount`);
    assert((capacity & (capacity - 1)) === 0, `${hint}: capacity is pow2`);
  }

  // Default hint is "balanced".
  const def = connectFanIn<AllKinds>({ schema: allKinds, producerCount: 1, environment: turbo() });
  assert(def.handle.sizing.usableDepth >= 256, "default hint == balanced (usableDepth ≥ 256)");

  // Capacity override: rounded up to pow2, floored above producerCount.
  const over = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 2, capacity: 9, environment: turbo(),
  });
  assertEq(over.handle.capacity, 16, "capacity override 9 → nextPow2 16");
  assertEq(over.handle.sizing.usableDepth, 16 - 1, "override usableDepth = capacity − slack");

  // Override below the ctor floor is raised so the ctor never throws.
  const tiny = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 4, capacity: 2, environment: turbo(),
  });
  assert(tiny.handle.capacity > 4, "tiny override floored above producerCount");
  ok("3 sizing + envelope guard (usableDepth, capacity > producerCount)");
}

// ── 4. allocate-once / mount-many bit-exact round-trip ──────────────────────
function pin4_mountManyBitExact(): void {
  const topo = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 2, capacity: 16, environment: turbo(),
  });
  // Two producers + one consumer, all over the SAME handle.
  const prodA = mountFanIn<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  const prodB = mountFanIn<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  const consumer = topo.mount({ role: "consumer", schema: allKinds });
  assert(prodA instanceof MpmcRing && consumer instanceof MpmcRing, "mounts return MpmcRing");

  // Interleave pushes from both producers (single-thread, so deterministic FIFO
  // by ticket order). Producer 0 → seq 0,1; producer 1 → seq 0,1; interleaved.
  assert(prodA.push(makeFrame(0, 0) as never), "A seq0");
  assert(prodB.push(makeFrame(1, 0) as never), "B seq0");
  assert(prodA.push(makeFrame(0, 1) as never), "A seq1");
  assert(prodB.push(makeFrame(1, 1) as never), "B seq1");
  assertEq(consumer.available(), 4, "four frames in flight");

  const expected = [[0, 0], [1, 0], [0, 1], [1, 1]]; // FIFO by ticket
  const out = consumer.createFrame() as Record<string, unknown>;
  for (let i = 0; i < expected.length; i++) {
    assert(consumer.pull(out as never), `pull ${i}`);
    assertEq(out.producerId as number, expected[i]![0], `frame ${i} producerId (FIFO)`);
    assertEq(out.seq as number, expected[i]![1], `frame ${i} seq (FIFO)`);
    // Bit-exact payload across all FieldKinds.
    assertEq(out.a_u64 as bigint, 0xfedcba9876543210n, `frame ${i} u64`);
    assertEq(out.a_i64 as bigint, -1234567890123456n, `frame ${i} i64`);
    assertEq(out.a_f64 as number, -3.141592653589793, `frame ${i} f64`);
    assertEq(out.a_i32 as number, -2000000000, `frame ${i} i32`);
    assertEq(out.a_f32 as number, Math.fround(2.5), `frame ${i} f32`);
    assertEq(out.a_u16 as number, 0xbeef, `frame ${i} u16`);
    assertEq(out.a_i16 as number, -12345, `frame ${i} i16`);
    assertEq(out.a_u8 as number, 0xff, `frame ${i} u8`);
    assertEq(out.a_i8 as number, -120, `frame ${i} i8`);
    assertEq((out.arr as Float64Array).join(","), "1.5,-2.25,1e+300,0", `frame ${i} f64 array`);
    assertEq((out.iarr as Int32Array).join(","), "-1,2147483647,-2147483648", `frame ${i} i32 array`);
  }
  assert(!consumer.pull(out as never), "drained");
  assertEq(consumer.tornFrameCount(), 0, "no torn frames");
  assertEq(consumer.overrunLostFrames(), 0, "envelope held");
  ok("4 allocate-once / mount-many bit-exact round-trip (2 producers, 1 consumer)");
}

// ── 5. drop-newest-when-full counted through the mount surface ──────────────
function pin5_dropCounted(): void {
  const producerCount = 3; // slack 2
  const topo = connectFanIn<AllKinds>({
    schema: allKinds, producerCount, capacity: 8, environment: turbo(),
  });
  const prod = mountFanIn<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  let pushed = 0;
  while (prod.push(makeFrame(0, pushed) as never)) pushed++;
  const usable = topo.handle.capacity - (producerCount - 1);
  assertEq(pushed, usable, "pushed exactly usableDepth frames");
  assert(prod.droppedFrames() >= 1, "further pushes dropped + counted");
  assertEq(prod.overrunLostFrames(), 0, "no overrun loss");
  assertEq(prod.tornFrameCount(), 0, "no torn frames");
  ok("5 drop-newest-when-full counted (slack reserved)");
}

// ── 6. initLayout NOT re-called by a late peer mount ────────────────────────
function pin6_initOnce(): void {
  const topo = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 1, capacity: 8, environment: turbo(),
  });
  // Producer mounts and pushes BEFORE the consumer ever mounts.
  const prod = mountFanIn<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  for (let i = 0; i < 3; i++) assert(prod.push(makeFrame(0, i) as never), `push ${i}`);

  // A consumer mounting LATE must attach via the bare ctor (no initLayout) — if
  // it re-inited, the header/gen would zero and these 3 frames would vanish.
  const consumer = mountFanIn<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  assertEq(consumer.available(), 3, "late consumer mount did NOT reset the ring");
  const out = consumer.createFrame() as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    assert(consumer.pull(out as never), `late pull ${i}`);
    assertEq(out.seq as number, i, `late frame ${i} intact + FIFO`);
  }
  assert(!consumer.pull(out as never), "drained");
  ok("6 initLayout not re-called by a late peer mount (frames survive)");
}

// ── 7. layout-skew guard ────────────────────────────────────────────────────
function pin7_layoutSkew(): void {
  const topo = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 1, environment: turbo(),
  });
  // Different frameByteSize → caught by the cheap byte-size check.
  const bigger = defineSchema({ a: f64(), b: f64(), c: f64() });
  assertThrows(
    () => mountFanIn(topo.handle, { role: "producer", schema: bigger as never }),
    /frameByteSize/, "different frameByteSize rejected");

  // Same frameByteSize, different field SHAPE → caught by the full-layout walk.
  // allKinds packs to some size; build a schema that pads to the same size but
  // with a single array field, guaranteeing a different shape.
  const sameSize = defineSchema({
    blob: f32Array(allKinds.frameByteSize / 4),
  });
  assert(sameSize.frameByteSize === allKinds.frameByteSize, "fixture: same frameByteSize");
  assertThrows(
    () => mountFanIn(topo.handle, { role: "consumer", schema: sameSize as never }),
    /field shape|field set|disagrees/, "same-byteSize different-shape rejected");
  ok("7 layout-skew guard (byteSize + full-shape)");
}

// ── 8. LatencyBudget (block schema) sizes from the budget ───────────────────
function pin8_latencyBudget(): void {
  // A block schema: one lone PCM array → audioFramesPerSlot detects samples.
  const block = defineSchema({ pcm: f32Array(1024) });
  const topo = connectFanIn({
    schema: block,
    producerCount: 2,
    latencyHint: { latencyMs: 60, sampleRate: 48000 },
    environment: turbo(),
  });
  const s = topo.handle.sizing;
  assert(s.resolvedFromBudget, "block schema budget honored");
  assert(s.frameAudioMs !== undefined && Math.abs(s.frameAudioMs - (1000 * 1024) / 48000) < 1e-9,
    "frameAudioMs ≈ 21.3 ms");
  // usableDepth · frameAudioMs ≥ 60 ms budget (the slack reservation preserves it).
  assert(s.usableDepth * s.frameAudioMs! >= 60, "usableDepth honors the latency budget");
  assert(Number.isFinite(s.estimatedLatencyMs), "estimatedLatencyMs computed");
  assertEq(s.reservedSlack, 1, "reservedSlack = producerCount − 1");
  ok("8 LatencyBudget block-schema sizing");
}

// ── 9. topology.mount() symmetric with free mountFanIn() ────────────────────
function pin9_mountSymmetry(): void {
  const topo = connectFanIn<AllKinds>({
    schema: allKinds, producerCount: 1, capacity: 8, environment: turbo(),
  });
  const viaTopo = topo.mount({ role: "producer", schema: allKinds });
  const viaFree = mountFanIn<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  assert(viaTopo.push(makeFrame(0, 7) as never), "push via topo.mount producer");
  const out = viaFree.createFrame() as Record<string, unknown>;
  assert(viaFree.pull(out as never), "pull via free mountFanIn consumer (same SAB)");
  assertEq(out.seq as number, 7, "frame crosses between the two mounts over one SAB");
  ok("9 topology.mount() symmetric with free mountFanIn()");
}

function main(): void {
  console.log("connectFanIn — single-thread API pins");
  pin1_handleShape();
  pin2_envGateAndValidation();
  pin3_sizing();
  pin4_mountManyBitExact();
  pin5_dropCounted();
  pin6_initOnce();
  pin7_layoutSkew();
  pin8_latencyBudget();
  pin9_mountSymmetry();
  console.warn = realWarn;
  console.log("\nconnectFanIn: 9 pins passed.");
}

main();
