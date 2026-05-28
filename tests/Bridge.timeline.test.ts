/**
 * Timeline record/replay — record-replay-timeline track.
 *
 * TimelineRecorder<S> / TimelinePlayer<S>: deterministic capture of pushed
 * frames as (tMacroNs, frameSnapshot) tuples, serialize()/deserialize() to a
 * compact schema-tagged ArrayBuffer container, and faster-than-real-time,
 * bit-identical offline bounce via the PLL-free synthesized consumer clock.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.timeline.test.ts
 *
 * Pins:
 *  1. testRoundTripDeterminism      — two renders byte-identical; in-memory == deserialized
 *  2. testFasterThanRealTime        — render seconds >> wall seconds; count == totalSamples()
 *  3. testRejection                 — schema-tag mismatch + bad magic + bad version + non-monotonic
 *  4. testForwardExtrapolation      — evaluation past the last frame uses Taylor extrapolation
 *  5. testRecordViaTimestampRole    — record(frame) reads tMacroNs from the default role
 *  6. testInvariantSchemaRejected   — .withInvariant(...) schema rejected at construction
 */

import { assert, assertEq, ok } from "./_assert.js";
import { mulberry32 } from "./_bridgeHelpers.js";
import {
  defineSchema,
  f64,
  f64Array,
  f64TrajectoryArray,
  u64,
} from "../src/schema.js";
import {
  TimelineRecorder,
  TimelinePlayer,
  deserialize,
  TimelineFormatError,
  TimelineSchemaMismatchError,
  type TimelineTuple,
} from "../src/TimelineRecorder.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A control schema with an order-2 trajectory (the extrapolated field), a
 *  scalar, a plain array, and a u64 macro-timestamp role. */
function makeTimelineSchema(n: number) {
  return defineSchema({
    seq:      u64(),
    tMacroNs: u64(),
    gain:     f64(),
    env:      f64Array(4),
    vEff:     f64TrajectoryArray(n, { order: 2 }),
  }).withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } });
}

type TLFrame = {
  seq: bigint;
  tMacroNs: bigint;
  gain: number;
  env: Float64Array;
  vEff: Float64Array;
};

function makeFrame(seq: number, tMacroNs: number, n: number): TLFrame {
  const env = new Float64Array(4);
  for (let k = 0; k < 4; k++) env[k] = seq * 10 + k;
  const vEff = new Float64Array(n * 2); // order-2: [p0,v0,p1,v1,...]
  for (let i = 0; i < n; i++) {
    vEff[i * 2] = seq + i * 0.1;       // position
    vEff[i * 2 + 1] = 0.5 + i * 0.01;  // velocity
  }
  return {
    seq: BigInt(seq),
    tMacroNs: BigInt(tMacroNs),
    gain: seq * 0.25,
    env,
    vEff,
  };
}

const N = 8;
const FRAME_NS = 16_666_667; // ~60 Hz macro frames

/** Build a recorder seeded with `count` frames at FRAME_NS spacing. */
function recordSession(count: number, rng = mulberry32(7)): TimelineRecorder<ReturnType<typeof makeTimelineSchema>> {
  const schema = makeTimelineSchema(N);
  const rec = new TimelineRecorder(schema, { epochNs: 0 });
  for (let s = 0; s < count; s++) {
    const f = makeFrame(s, s * FRAME_NS, N);
    // Perturb velocity a touch so the trajectory genuinely varies per frame.
    f.vEff[1] = 0.5 + rng() * 0.01;
    rec.record(f as any);
  }
  return rec;
}

/** Render the player fully into a flat Float64Array of vEff[0] per sample. */
function renderTrace(player: TimelinePlayer<ReturnType<typeof makeTimelineSchema>>): Float64Array {
  const total = player.totalSamples();
  const out = new Float64Array(total);
  const frame = player.scratchFrame() as unknown as { vEff: Float64Array };
  let count = 0;
  player.renderInto(player.scratchFrame() as any, 0, total, (n, fr) => {
    const v = (fr as unknown as { vEff: Float64Array }).vEff;
    out[n] = v[0]!;
    count++;
  });
  void frame;
  assertEq(count, total, "renderTrace: callback count == totalSamples()");
  return out;
}

// ── 1. Round-trip determinism ────────────────────────────────────────────

function testRoundTripDeterminism(): void {
  const rec = recordSession(20);
  const buf = rec.serialize();

  // In-memory player (deserialize from this recorder's own bytes).
  const schema = makeTimelineSchema(N);
  const playerA = deserialize(buf, schema);
  playerA.setSampleRate(48000);

  // Second deserialize from the SAME bytes — independent player object.
  const playerB = deserialize(buf, schema);
  playerB.setSampleRate(48000);

  assertEq(playerA.totalSamples(), playerB.totalSamples(), "round-trip: totalSamples equal");

  const traceA = renderTrace(playerA);
  const traceB = renderTrace(playerB);
  assertEq(traceA.length, traceB.length, "round-trip: trace lengths equal");
  for (let i = 0; i < traceA.length; i++) {
    // Bit-identical: use Object.is so -0/NaN compare structurally.
    assert(Object.is(traceA[i], traceB[i]), `round-trip: sample ${i} bit-identical`);
  }

  // Re-render playerA a SECOND time — same player, same bytes out.
  const traceA2 = renderTrace(playerA);
  for (let i = 0; i < traceA.length; i++) {
    assert(Object.is(traceA[i], traceA2[i]), `round-trip: re-render sample ${i} bit-identical`);
  }

  // Snapshot bytes survive the serialize→deserialize round trip exactly: the
  // first tuple's stored frame decodes back to the recorded scalar/array.
  const t0: TimelineTuple<typeof schema> = playerA.tuples[0]!;
  assertEq(t0.tMacroNs, 0, "round-trip: tuple0 tMacroNs");
  assertEq((t0.frame as any).seq, 0n, "round-trip: tuple0 seq decoded");
  assertEq((t0.frame as any).gain, 0, "round-trip: tuple0 gain decoded");

  ok("round-trip determinism (two renders + two deserializes byte-identical)");
}

// ── 2. Faster-than-real-time replay ───────────────────────────────────────

function testFasterThanRealTime(): void {
  // A long-ish recording: 600 frames ≈ 10 s of macro time at 60 Hz.
  const rec = recordSession(600);
  const buf = rec.serialize();
  const player = deserialize(buf, makeTimelineSchema(N));
  player.setSampleRate(48000);

  const total = player.totalSamples();
  const renderSeconds = total / 48000;
  assert(renderSeconds > 9, `faster-than-real-time: rendered ${renderSeconds}s of audio (>9s)`);

  const frame = player.scratchFrame();
  let count = 0;
  const wallStart = performance.now();
  player.renderInto(frame as any, 0, total, () => {
    count++;
  });
  const wallSeconds = (performance.now() - wallStart) / 1000;

  assertEq(count, total, "faster-than-real-time: count == totalSamples()");
  assert(
    wallSeconds < renderSeconds,
    `faster-than-real-time: wall ${wallSeconds.toFixed(4)}s << audio ${renderSeconds.toFixed(2)}s`,
  );
  // Sanity: should be dramatically faster — at least 10x. (Typically >100x.)
  assert(
    wallSeconds * 10 < renderSeconds,
    `faster-than-real-time: at least 10x real time (wall ${wallSeconds.toFixed(4)}s vs ${renderSeconds.toFixed(2)}s)`,
  );

  ok(`faster-than-real-time replay (${renderSeconds.toFixed(2)}s audio in ${wallSeconds.toFixed(4)}s wall)`);
}

// ── 3. Rejection: schema tag, magic, version, non-monotonic ────────────────

function testRejection(): void {
  const rec = recordSession(5);
  const buf = rec.serialize();

  // (a) schema-tag mismatch — a structurally different schema.
  const wrongSchema = defineSchema({
    seq:  u64(),
    gain: f64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  let mismatch: TimelineSchemaMismatchError | null = null;
  try {
    deserialize(buf, wrongSchema as any);
  } catch (e) {
    if (e instanceof TimelineSchemaMismatchError) mismatch = e;
    else throw e;
  }
  assert(mismatch !== null, "rejection: schema-tag mismatch throws TimelineSchemaMismatchError");
  assert(
    mismatch!.expectedSchemaTag !== mismatch!.actualSchemaTag ||
      mismatch!.expectedFrameByteSize !== mismatch!.actualFrameByteSize,
    "rejection: mismatch carries expected/actual diagnostics",
  );

  // The correct schema still deserializes fine (the tag is not over-broad).
  const okPlayer = deserialize(buf, makeTimelineSchema(N));
  assert(okPlayer.tuples.length === 5, "rejection: correct schema still deserializes");

  // (b) bad magic.
  const badMagic = buf.slice(0);
  new DataView(badMagic).setUint32(0, 0xdeadbeef, true);
  let magicErr: TimelineFormatError | null = null;
  try {
    deserialize(badMagic, makeTimelineSchema(N));
  } catch (e) {
    if (e instanceof TimelineFormatError) magicErr = e;
    else throw e;
  }
  assert(magicErr !== null, "rejection: bad magic throws TimelineFormatError");

  // (c) bad version.
  const badVersion = buf.slice(0);
  new DataView(badVersion).setUint32(4, 999, true);
  let versionErr: TimelineFormatError | null = null;
  try {
    deserialize(badVersion, makeTimelineSchema(N));
  } catch (e) {
    if (e instanceof TimelineFormatError) versionErr = e;
    else throw e;
  }
  assert(versionErr !== null, "rejection: bad version throws TimelineFormatError");
  assertEq(versionErr!.actualVersion, 999, "rejection: version error carries actualVersion");

  // (d) non-monotonic times at record() time.
  const rec2 = new TimelineRecorder(makeTimelineSchema(N), { epochNs: 0 });
  rec2.recordAt(makeFrame(0, 0, N) as any, 1000);
  let monoErr = false;
  try {
    rec2.recordAt(makeFrame(1, 0, N) as any, 500); // earlier than previous
  } catch {
    monoErr = true;
  }
  assert(monoErr, "rejection: non-monotonic recordAt throws");

  ok("rejection (schema-tag mismatch + bad magic + bad version + non-monotonic)");
}

// ── 4. Forward extrapolation past the last frame ───────────────────────────

function testForwardExtrapolation(): void {
  // Single frame with a known position + velocity; evaluate well past it.
  const schema = makeTimelineSchema(N);
  const rec = new TimelineRecorder(schema, { epochNs: 0 });
  const f = makeFrame(3, 0, N);
  // Deterministic p0=3, v0=2.0 (units/sec) at sample 0.
  f.vEff[0] = 3.0;
  f.vEff[1] = 2.0;
  rec.record(f as any);

  const player = deserialize(rec.serialize(), schema);
  player.setSampleRate(1000); // 1 ms / sample → easy dt arithmetic
  const out = player.scratchFrame() as unknown as { vEff: Float64Array };

  // At sample 0, dt = 0 → out = p0 = 3.0.
  player.evaluateAtSample(out as any, 0);
  assert(Math.abs(out.vEff[0]! - 3.0) < 1e-12, "extrapolation: sample 0 == p0");

  // At sample 2000, consumerNs = 2000/1000*1e9 = 2e9 ns = 2.0 s past the last
  // (only) frame; dt = 2.0 s. Taylor: p0 + v0*dt = 3.0 + 2.0*2.0 = 7.0.
  player.evaluateAtSample(out as any, 2000);
  assert(
    Math.abs(out.vEff[0]! - 7.0) < 1e-9,
    `extrapolation: sample 2000 extrapolated to 7.0, got ${out.vEff[0]}`,
  );

  ok("forward extrapolation past the last frame (Taylor p + v·dt)");
}

// ── 5. Record via timestamp role ───────────────────────────────────────────

function testRecordViaTimestampRole(): void {
  const schema = makeTimelineSchema(N);
  const rec = new TimelineRecorder(schema, { epochNs: 0 });
  // tMacroNs role field is u64; record() must Number()-coerce it.
  rec.record(makeFrame(0, 1_000_000, N) as any);
  rec.record(makeFrame(1, 2_000_000, N) as any);
  rec.record(makeFrame(2, 3_500_000, N) as any);
  assertEq(rec.length, 3, "timestamp-role: three tuples recorded");

  const player = deserialize(rec.serialize(), schema);
  assertEq(player.tuples[0]!.tMacroNs, 1_000_000, "timestamp-role: tuple0 time from role");
  assertEq(player.tuples[2]!.tMacroNs, 3_500_000, "timestamp-role: tuple2 time from role");

  ok("record via default timestamp role (u64 Number-coerced)");
}

// ── 6. Invariant schema rejected at construction ───────────────────────────

function testInvariantSchemaRejected(): void {
  const invSchema = defineSchema({
    seq:  u64(),
    vEff: f64Array(4),
  }).withInvariant((frame) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += frame.vEff[k]! * frame.vEff[k]!;
    return s;
  });
  let threw = false;
  try {
    new TimelineRecorder(invSchema as any);
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, "invariant-schema: TimelineRecorder rejects .withInvariant schema with TypeError");

  ok("invariant schema rejected at construction");
}

// ─── Harness ────────────────────────────────────────────────────────────

function main(): void {
  testRoundTripDeterminism();
  testFasterThanRealTime();
  testRejection();
  testForwardExtrapolation();
  testRecordViaTimestampRole();
  testInvariantSchemaRejected();
  console.log("\nAll timeline record/replay tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
