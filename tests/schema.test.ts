/**
 * schema — property tests for the FrameSchema DSL and compile pass.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/schema.test.ts
 *
 * Pins:
 *   1. Scalar + array field constructors produce well-formed FieldSpecs.
 *   2. defineSchema rejects empty / duplicate / bad-identifier / non-FieldSpec
 *      field sets at construction time (single source of error noise).
 *   3. Alignment-class grouping packs fields by size desc, preserves declared
 *      order within a class, and the resulting byteOffsets are aligned to each
 *      field's element size (the SAB typed-array constructor contract).
 *   4. Frame size is padded up to 8 so consecutive slots stay 8-aligned.
 *   5. describeSchemaLayout serializes the compiled layout for postMessage.
 *   9. withInvariant builder appends a hidden __invariant f64 lane: frame
 *      size grows by 8, f64 joins typesPresent, invariantByteOffset is
 *      set to the (8-aligned) userEnd. No invariant → invariantByteOffset
 *      is null. Schema is still frozen.
 *  10. f{32,64}TrajectoryArray(n, { order }) — Pillar 1 scaffolding (0.6.1).
 *      Byte-compatible with f{32,64}Array(n * order); trajectory tag
 *      propagates to FieldSpec, CompiledField, and SchemaLayoutFieldDescription.
 *      Invalid order / sampleCount rejected; schema stays frozen.
 *  11. evaluateTrajectoryInto — Pillar 1 consumer-side Taylor evaluator
 *      (0.6.1). Order=1 copies positions (dt ignored); order=2 is exact
 *      `p + v·dt`; order=3 is exact `p + v·dt + ½·a·dt²`. f64 and f32
 *      input variants. Bounds-checked. Allocation-free against caller's
 *      pre-allocated `out` buffer.
 *  12. .withTimestamps(...) builder (0.6.5). Declares one or more named
 *      timestamp roles pointing at numeric scalar fields with unit tags.
 *      Builder validates field exists + numeric + scalar + unit valid;
 *      enforces at-most-one-default flag; first declared role is default
 *      if none flagged. Spec propagates onto Schema.timestamps and
 *      through describeSchemaLayout for worklet inliners. Composes with
 *      withInvariant in either order. Schema stays frozen.
 *  13. .withInvariant(fn, { absoluteEpsilon }) opts (0.6.6). Default-omit
 *      path attaches DEFAULT_INVARIANT_ABSOLUTE_EPSILON (1e-12); explicit
 *      opt threads through onto Schema.invariant.absoluteEpsilon. Validates
 *      the value is a finite non-negative number; rejects NaN, Infinity,
 *      negative, or non-numeric. Opts object itself must be undefined or an
 *      object (no other primitives). Schema stays frozen and behavior is
 *      otherwise identical to the no-opts builder.
 *
 * These pins cover the DSL/compile surface in isolation — Bridge integration
 * is exercised by tests/Bridge.test.ts.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
  defineSchema,
  describeSchemaLayout,
  f32,
  f32TrajectoryArray,
  f64,
  f64Array,
  f64TrajectoryArray,
  i16,
  kindByteSize,
  u32,
  u64,
  u8,
  u8Array,
  type FieldSpec,
  type FrameFor,
  type Schema,
  type TrajectoryOrder,
  type TrajectorySpec,
  type WithInvariantOptions,
} from "../src/schema.js";
import { evaluateTrajectoryInto } from "../src/trajectory.js";

// ── 1. Scalar + array constructors ─────────────────────────────────────────
function testConstructors(): void {
  const a = u64();
  assertEq(a.kind, "u64", "u64 kind");
  assertEq(a.byteSize, 8, "u64 byteSize");
  assertEq(a.length, undefined, "u64 length omitted (scalar)");

  const b = f32();
  assertEq(b.kind, "f32", "f32 kind");
  assertEq(b.byteSize, 4, "f32 byteSize");

  const c = u8();
  assertEq(c.kind, "u8", "u8 kind");
  assertEq(c.byteSize, 1, "u8 byteSize");

  const d = f64Array(64);
  assertEq(d.kind, "f64", "f64Array kind");
  assertEq(d.length, 64, "f64Array length");
  assertEq(d.byteSize, 8 * 64, "f64Array byteSize");

  const e = u8Array(17);
  assertEq(e.kind, "u8", "u8Array kind");
  assertEq(e.length, 17, "u8Array length");
  assertEq(e.byteSize, 17, "u8Array byteSize");

  // FieldSpec is frozen so users can't mutate the spec under the schema.
  let threwOnMutate = false;
  try {
    (a as { kind: string }).kind = "f64";
  } catch {
    threwOnMutate = true;
  }
  assert(threwOnMutate, "FieldSpec is frozen (strict-mode TypeError on mutate)");

  // Array length must be a positive integer.
  let threw = false;
  try { f64Array(0); } catch { threw = true; }
  assert(threw, "f64Array(0) throws");
  threw = false;
  try { f64Array(-1); } catch { threw = true; }
  assert(threw, "f64Array(-1) throws");
  threw = false;
  try { f64Array(1.5); } catch { threw = true; }
  assert(threw, "f64Array(1.5) throws");

  ok("constructors");
}

// ── 2. defineSchema validation ─────────────────────────────────────────────
function testValidation(): void {
  let threw = false;
  try {
    defineSchema({});
  } catch {
    threw = true;
  }
  assert(threw, "empty schema throws");

  threw = false;
  try {
    defineSchema({ "bad-name": u64() });
  } catch {
    threw = true;
  }
  assert(threw, "non-identifier field name throws (hyphen)");

  threw = false;
  try {
    defineSchema({ "1leading": u64() });
  } catch {
    threw = true;
  }
  assert(threw, "non-identifier field name throws (leading digit)");

  threw = false;
  try {
    // Passing a string instead of a FieldSpec — common plain-JS typo.
    defineSchema({ seq: "u64" as unknown as FieldSpec });
  } catch {
    threw = true;
  }
  assert(threw, "non-FieldSpec field value throws");

  threw = false;
  try {
    defineSchema({
      seq: { kind: "not-a-kind", byteSize: 4 } as unknown as FieldSpec,
    });
  } catch {
    threw = true;
  }
  assert(threw, "unknown kind throws");

  ok("validation");
}

// ── 3. Alignment-class grouping + offset correctness ───────────────────────
function testAlignmentGrouping(): void {
  // Declared order intentionally mixed; expect physical order to be
  // 8-aligned (a:u64, c:f64) → 4-aligned (b:f32, e:u32) → 2-aligned (d:i16)
  // → 1-aligned (f:u8) with declared order preserved within each class.
  const s = defineSchema({
    a: u64(),
    b: f32(),
    c: f64(),
    d: i16(),
    e: u32(),
    f: u8(),
  });

  const byName: Record<string, number> = {};
  for (const f of s.compiled.fields) byName[f.name] = f.byteOffset;

  // Within each alignment class, declared order is preserved.
  // a (u64) declared before c (f64) → a first.
  assert(byName.a! < byName.c!, "a:u64 before c:f64 (declared order within class)");
  // b (f32) declared before e (u32) → b first.
  assert(byName.b! < byName.e!, "b:f32 before e:u32 (declared order within class)");

  // Each field's byteOffset must align to its element size.
  for (const f of s.compiled.fields) {
    const align = kindByteSize(f.kind);
    assertEq(
      f.byteOffset % align,
      0,
      `field '${f.name}' byteOffset ${f.byteOffset} aligned to ${align}`,
    );
  }

  // Classes are grouped: 8-aligned fields all have lower offsets than 4-aligned,
  // which have lower offsets than 2-aligned, etc.
  const maxBy = (k: number) =>
    Math.max(
      ...s.compiled.fields
        .filter((f) => kindByteSize(f.kind) === k)
        .map((f) => f.byteOffset),
    );
  const minBy = (k: number) =>
    Math.min(
      ...s.compiled.fields
        .filter((f) => kindByteSize(f.kind) === k)
        .map((f) => f.byteOffset),
    );
  assert(maxBy(8) < minBy(4), "all 8-aligned before any 4-aligned");
  assert(maxBy(4) < minBy(2), "all 4-aligned before any 2-aligned");
  assert(maxBy(2) < minBy(1), "all 2-aligned before any 1-aligned");

  ok("alignment-grouping");
}

// ── 4. Frame size padding ──────────────────────────────────────────────────
function testFramePadding(): void {
  // 3 bytes of u8 → raw 3 bytes, padded to 8.
  const s1 = defineSchema({ a: u8(), b: u8(), c: u8() });
  assertEq(s1.frameByteSize, 8, "3 u8 → padded to 8");
  assertEq(s1.frameByteSize % 8, 0, "frame size 8-aligned");

  // 1 f64 → 8 bytes exact, no pad.
  const s2 = defineSchema({ x: f64() });
  assertEq(s2.frameByteSize, 8, "1 f64 → 8 (no pad)");

  // 1 f64 + 1 u8 → 9 → padded to 16.
  const s3 = defineSchema({ x: f64(), y: u8() });
  assertEq(s3.frameByteSize, 16, "f64 + u8 → 9 padded to 16");

  // Physics shape: 4 f64 scalars + 2 f64 arrays of n → exactly (4 + 2n)*8.
  const n = 64;
  const sP = defineSchema({
    seq: f64(),
    tMacroNs: f64(),
    vMax: f64(),
    jMax: f64(),
    vEff: f64Array(n),
    jEff: f64Array(n),
  });
  assertEq(
    sP.frameByteSize,
    (4 + 2 * n) * 8,
    "all-f64 physics shape matches (4 + 2n) f64",
  );

  ok("frame-padding");
}

// ── 5. typesPresent + per-field metadata ───────────────────────────────────
function testCompiledMetadata(): void {
  const s = defineSchema({
    seq: u64(),
    tag: u8Array(4),
    val: f32(),
  });
  // typesPresent reflects the set of kinds actually used (order is insertion).
  const tp = [...s.compiled.typesPresent].sort();
  assertEq(tp.length, 3, "typesPresent has 3 entries");
  assert(tp.includes("u64"), "typesPresent includes u64");
  assert(tp.includes("u8"), "typesPresent includes u8");
  assert(tp.includes("f32"), "typesPresent includes f32");

  const fSeq = s.compiled.fields.find((f) => f.name === "seq")!;
  assertEq(fSeq.length, 1, "scalar length normalized to 1");
  assertEq(fSeq.isArray, false, "scalar isArray=false");

  const fTag = s.compiled.fields.find((f) => f.name === "tag")!;
  assertEq(fTag.length, 4, "array length preserved");
  assertEq(fTag.isArray, true, "array isArray=true");

  ok("compiled-metadata");
}

// ── 6. describeSchemaLayout output ─────────────────────────────────────────
function testDescribeLayout(): void {
  const s = defineSchema({
    seq: u64(),
    vEff: f64Array(8),
  });
  const desc = describeSchemaLayout(s);
  assertEq(desc.headerBytes, 32, "headerBytes hardcoded to 32 (ring header)");
  assertEq(desc.frameByteSize, s.frameByteSize, "frame size matches schema");
  assertEq(desc.fields.seq!.kind, "u64", "seq kind in layout description");
  assertEq(desc.fields.seq!.length, undefined, "scalar omits length in layout");
  assertEq(desc.fields.vEff!.kind, "f64", "vEff kind in layout description");
  assertEq(desc.fields.vEff!.length, 8, "array length in layout description");
  ok("describe-layout");
}

// ── 7. FrameFor<S> inference (compile-time only — assigns to typed vars) ───
function testFrameForInference(): void {
  // The point of this "test" is the TS compiler — if it accepts this code,
  // FrameFor<S> is wiring scalar bigint / scalar number / typed-array fields
  // correctly. The runtime asserts are nominal.
  const s = defineSchema({
    seq: u64(),
    vMax: f64(),
    vEff: f64Array(4),
  });
  type S = typeof s;
  // Compile-time check: assignability of a literal frame to FrameFor<S>.
  const frame: FrameFor<S> = {
    seq: 1n,
    vMax: 0.5,
    vEff: new Float64Array([1, 2, 3, 4]),
  };
  assertEq(typeof frame.seq, "bigint", "FrameFor: seq is bigint");
  assertEq(typeof frame.vMax, "number", "FrameFor: vMax is number");
  assert(frame.vEff instanceof Float64Array, "FrameFor: vEff is Float64Array");
  ok("frame-for-inference");
}

// ── 8. Schema is frozen end-to-end ─────────────────────────────────────────
function testSchemaFrozen(): void {
  const s: Schema = defineSchema({ x: f64() });
  let threw = false;
  try {
    (s as { frameByteSize: number }).frameByteSize = 999;
  } catch {
    threw = true;
  }
  assert(threw, "Schema is frozen");

  threw = false;
  try {
    (s.compiled as { frameByteSize: number }).frameByteSize = 999;
  } catch {
    threw = true;
  }
  assert(threw, "CompiledLayout is frozen");
  ok("schema-frozen");
}

// ── 9. withInvariant builder ───────────────────────────────────────────────
//
// Calling `.withInvariant(fn)` on a base schema produces a new schema with
// the hidden `__invariant: f64` lane appended at the (8-aligned) end of the
// user fields. Frame size grows by exactly 8; `f64` is in `typesPresent`
// even if the base schema had no f64 fields; `invariantByteOffset` is set.
// The original schema is unchanged (immutable builder).
function testWithInvariant(): void {
  // Base schema with no f64 (just u64) — verify f64 gets added to
  // typesPresent purely from the invariant requirement.
  const base = defineSchema({
    seq: u64(),
    label: u8Array(7), // odd-byte to force userEnd padding
  });
  // base layout: u64 at 0 (8B), u8Array(7) at 8 (7B), userEnd raw = 15,
  // padded to 16. f64 NOT in typesPresent.
  assertEq(base.frameByteSize, 16, "base frame size 16");
  assertEq(base.invariant, null, "base has no invariant attached");
  assertEq(base.compiled.invariantByteOffset, null, "base invariantByteOffset null");
  assert(
    !base.compiled.typesPresent.includes("f64"),
    "base typesPresent does NOT include f64",
  );

  const withInv = base.withInvariant((frame) => {
    // Trivial invariant — sum the label bytes interpreted as u8s.
    let s = 0;
    for (let k = 0; k < 7; k++) s += frame.label[k]!;
    return s;
  });

  assertEq(
    withInv.frameByteSize,
    24,
    "withInvariant frame size = base + 8 (hidden invariant lane)",
  );
  assertEq(
    withInv.compiled.invariantByteOffset,
    16,
    "invariantByteOffset = padded userEnd (16)",
  );
  assert(
    withInv.compiled.typesPresent.includes("f64"),
    "withInvariant adds f64 to typesPresent",
  );
  assert(withInv.invariant !== null, "withInvariant.invariant is non-null");
  assertEq(withInv.invariant?.byteOffset, 16, "invariant byteOffset matches");

  // Original is unchanged.
  assertEq(base.frameByteSize, 16, "base unchanged after withInvariant");
  assertEq(base.invariant, null, "base invariant still null");

  // Type validation.
  let threw = false;
  try {
    (base as unknown as { withInvariant: (x: unknown) => unknown }).withInvariant("not-a-fn");
  } catch {
    threw = true;
  }
  assert(threw, "withInvariant rejects non-function argument");

  // Sanity: schemas with existing f64 also work — typesPresent stays correct.
  const withF64 = defineSchema({ x: f64(), y: f64Array(3) }).withInvariant(
    (frame) => {
      let s = frame.x * frame.x;
      for (let k = 0; k < 3; k++) s += frame.y[k]! * frame.y[k]!;
      return s;
    },
  );
  assertEq(withF64.frameByteSize, 8 + 24 + 8, "f64 schema + invariant = 40B");
  assertEq(
    withF64.compiled.typesPresent.filter((k) => k === "f64").length,
    1,
    "f64 listed exactly once in typesPresent",
  );

  // Frozen.
  let threw2 = false;
  try {
    (withInv as { frameByteSize: number }).frameByteSize = 99;
  } catch {
    threw2 = true;
  }
  assert(threw2, "withInvariant schema is frozen");

  ok("with-invariant");
}

// ── 10. Trajectory array constructors (0.6.1 — Pillar 1) ───────────────────
//
// `f{32,64}TrajectoryArray(n, { order })` is byte-compatible with the
// equivalent flat `f{32,64}Array(n * order)`. The `trajectory` tag is the
// only difference: it labels the field so a downstream evaluator can
// interpret the interleaved stream as (p, v, [a]) tuples.
function testTrajectoryArrays(): void {
  // order=1 is byte-compatible with f64Array(n) — same kind, same byteSize,
  // same length. Only difference is the trajectory tag.
  const t1 = f64TrajectoryArray(64, { order: 1 });
  const a1 = f64Array(64);
  assertEq(t1.kind, a1.kind, "order=1 kind == f64Array");
  assertEq(t1.byteSize, a1.byteSize, "order=1 byteSize == f64Array(n)");
  assertEq(t1.length, a1.length, "order=1 length == f64Array(n)");
  assertEq(t1.trajectory?.order, 1, "order=1 tag.order");
  assertEq(t1.trajectory?.sampleCount, 64, "order=1 tag.sampleCount");
  assertEq(a1.trajectory, undefined, "plain f64Array has no trajectory tag");

  // order=2 doubles the storage: 64 samples * 2 components = 128 elements.
  const t2 = f64TrajectoryArray(64, { order: 2 });
  assertEq(t2.byteSize, 8 * 64 * 2, "order=2 byteSize = 8 * n * 2");
  assertEq(t2.length, 128, "order=2 flat length = n * 2");
  assertEq(t2.trajectory?.order, 2, "order=2 tag.order");
  assertEq(t2.trajectory?.sampleCount, 64, "order=2 tag.sampleCount");

  // f32 variant + order=3.
  const t3 = f32TrajectoryArray(32, { order: 3 });
  assertEq(t3.kind, "f32", "f32 trajectory kind");
  assertEq(t3.byteSize, 4 * 32 * 3, "f32 order=3 byteSize = 4 * n * 3");
  assertEq(t3.length, 96, "f32 order=3 flat length = n * 3");
  assertEq(t3.trajectory?.order, 3, "f32 order=3 tag.order");
  assertEq(t3.trajectory?.sampleCount, 32, "f32 order=3 tag.sampleCount");

  // Validation: order must be 1 | 2 | 3.
  let threw = false;
  try { f64TrajectoryArray(8, { order: 0 as unknown as TrajectoryOrder }); } catch { threw = true; }
  assert(threw, "order=0 rejected");
  threw = false;
  try { f64TrajectoryArray(8, { order: 4 as unknown as TrajectoryOrder }); } catch { threw = true; }
  assert(threw, "order=4 rejected");
  threw = false;
  try { f64TrajectoryArray(8, { order: 2.5 as unknown as TrajectoryOrder }); } catch { threw = true; }
  assert(threw, "non-integer order rejected");

  // Validation: sampleCount must be a positive integer.
  threw = false;
  try { f64TrajectoryArray(0, { order: 2 }); } catch { threw = true; }
  assert(threw, "sampleCount=0 rejected");
  threw = false;
  try { f64TrajectoryArray(-1, { order: 2 }); } catch { threw = true; }
  assert(threw, "negative sampleCount rejected");
  threw = false;
  try { f64TrajectoryArray(1.5, { order: 2 }); } catch { threw = true; }
  assert(threw, "fractional sampleCount rejected");

  // FieldSpec + trajectory tag are frozen.
  let mutated = false;
  try {
    (t2 as { byteSize: number }).byteSize = 0;
  } catch {
    mutated = true;
  }
  assert(mutated, "trajectory FieldSpec is frozen");
  mutated = false;
  try {
    (t2.trajectory as { order: number }).order = 99;
  } catch {
    mutated = true;
  }
  assert(mutated, "trajectory tag is frozen");

  // Round-trip through defineSchema: trajectory tag propagates to
  // CompiledField, and the schema is byte-identical to the flat equivalent.
  const N = 128;
  const traj = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const flat = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64Array(N * 2),
  });
  assertEq(
    traj.frameByteSize,
    flat.frameByteSize,
    "trajectory schema is byte-identical to flat f64Array(n*order) equivalent",
  );
  const cf = traj.compiled.fields.find((f) => f.name === "vEff")!;
  assertEq(cf.kind, "f64", "compiled field kind preserved");
  assertEq(cf.length, N * 2, "compiled field length = sampleCount * order");
  assertEq(cf.isArray, true, "compiled field marked as array");
  assertEq(cf.trajectory?.order, 2, "compiled field carries trajectory.order");
  assertEq(
    cf.trajectory?.sampleCount,
    N,
    "compiled field carries trajectory.sampleCount",
  );

  // Plain array fields don't grow a trajectory tag.
  const flatCf = flat.compiled.fields.find((f) => f.name === "vEff")!;
  assertEq(
    flatCf.trajectory,
    undefined,
    "plain f64Array CompiledField has no trajectory tag",
  );

  // describeSchemaLayout carries the tag through to worklet-side inliners.
  const desc = describeSchemaLayout(traj);
  assertEq(desc.fields.vEff!.kind, "f64", "layout description kind");
  assertEq(desc.fields.vEff!.length, N * 2, "layout description flat length");
  assertEq(
    desc.fields.vEff!.trajectory?.order,
    2,
    "layout description carries trajectory.order",
  );
  assertEq(
    desc.fields.vEff!.trajectory?.sampleCount,
    N,
    "layout description carries trajectory.sampleCount",
  );

  // FrameFor<S> infers Float64Array / Float32Array for the trajectory field
  // (compile-time check — runtime asserts are nominal).
  type T = typeof traj;
  const frame: FrameFor<T> = {
    seq: 0n,
    tMacroNs: 0n,
    vEff: new Float64Array(N * 2),
  };
  assert(frame.vEff instanceof Float64Array, "FrameFor: vEff is Float64Array");

  ok("trajectory-arrays");
}

// ── 11. evaluateTrajectoryInto — consumer-side Taylor evaluator ────────────
//
// Pillar 1 ships the trajectory tag AND a single consumer-side helper that
// reads it. Until Pillar 2 (PLL) and Pillar 3 (`pullEvaluated`) land,
// `evaluateTrajectoryInto` is the bridge between a pulled trajectory frame
// and an audio-rate consumer. Three orders, two precisions, bounds checks.
function testEvaluateTrajectory(): void {
  // order=1: positions only; dt is ignored (no derivative to extrapolate).
  // The flat array is just [p0, p1, p2, ...].
  {
    const flat = new Float64Array([10, 20, 30, 40]);
    const spec: TrajectorySpec = { order: 1, sampleCount: 4 };
    const out = new Float64Array(4);
    evaluateTrajectoryInto(flat, spec, 1234.5, out);
    assertEq(out[0], 10, "order=1 out[0]");
    assertEq(out[1], 20, "order=1 out[1]");
    assertEq(out[2], 30, "order=1 out[2]");
    assertEq(out[3], 40, "order=1 out[3]");
  }

  // order=2: linear Taylor. `[p0, v0, p1, v1, ...]`; out[i] = p_i + v_i·dt.
  // Choose nice integers so the assertion is bit-exact under IEEE-754.
  {
    const flat = new Float64Array([
      1.0, 2.0,   // sample 0: p=1, v=2
      10.0, -5.0, // sample 1: p=10, v=-5
      100.0, 0.0, // sample 2: p=100, v=0 (stays put)
    ]);
    const spec: TrajectorySpec = { order: 2, sampleCount: 3 };
    const out = new Float64Array(3);
    evaluateTrajectoryInto(flat, spec, 0.5, out);
    assertEq(out[0], 1.0 + 2.0 * 0.5, "order=2 dt=0.5 out[0] = p+v·dt");
    assertEq(out[1], 10.0 + -5.0 * 0.5, "order=2 dt=0.5 out[1] = p+v·dt");
    assertEq(out[2], 100.0, "order=2 dt=0.5 out[2] = p (v=0)");

    // dt=0 must return positions exactly (sanity: no NaN/extrapolation drift).
    evaluateTrajectoryInto(flat, spec, 0, out);
    assertEq(out[0], 1.0, "order=2 dt=0 returns p exactly");
    assertEq(out[1], 10.0, "order=2 dt=0 returns p exactly");
    assertEq(out[2], 100.0, "order=2 dt=0 returns p exactly");
  }

  // order=3: quadratic Taylor. `[p, v, a, ...]`; out = p + v·dt + ½·a·dt².
  // Pick values where ½·a·dt² is an integer multiple to keep bit-exact.
  {
    const flat = new Float64Array([
      0.0, 1.0, 4.0,    // sample 0: p=0, v=1, a=4
      -1.0, 0.0, -2.0,  // sample 1: p=-1, v=0, a=-2
    ]);
    const spec: TrajectorySpec = { order: 3, sampleCount: 2 };
    const out = new Float64Array(2);
    const dt = 0.5;
    const halfDt2 = 0.5 * dt * dt; // 0.125
    evaluateTrajectoryInto(flat, spec, dt, out);
    assertEq(
      out[0],
      0.0 + 1.0 * 0.5 + 4.0 * halfDt2,
      "order=3 dt=0.5 out[0] = p+v·dt+½a·dt²",
    );
    assertEq(
      out[1],
      -1.0 + 0.0 * 0.5 + -2.0 * halfDt2,
      "order=3 dt=0.5 out[1] = p+v·dt+½a·dt²",
    );
  }

  // f32 variant: overload selects Float32Array-typed paths.
  // The element-write truncates to f32 precision automatically.
  {
    const flat = new Float32Array([1.5, 2.5, 3.5, -1.0]);
    const spec: TrajectorySpec = { order: 2, sampleCount: 2 };
    const out = new Float32Array(2);
    evaluateTrajectoryInto(flat, spec, 1.0, out);
    // f32 of (1.5 + 2.5*1.0) = 4.0 exact, (3.5 + -1.0*1.0) = 2.5 exact.
    assertEq(out[0], 4.0, "f32 order=2 out[0]");
    assertEq(out[1], 2.5, "f32 order=2 out[1]");
    assert(out instanceof Float32Array, "f32 out remains Float32Array");
  }

  // Bounds: `out` too small → throw.
  {
    const flat = new Float64Array(4); // order=2, sampleCount=2 → flat needs 4
    const spec: TrajectorySpec = { order: 2, sampleCount: 2 };
    let threw = false;
    try {
      evaluateTrajectoryInto(flat, spec, 0, new Float64Array(1));
    } catch {
      threw = true;
    }
    assert(threw, "out length < sampleCount rejected");
  }

  // Bounds: `flat` too small → throw.
  {
    const spec: TrajectorySpec = { order: 3, sampleCount: 4 };
    let threw = false;
    try {
      evaluateTrajectoryInto(
        new Float64Array(8), // need 12 = 4 * 3
        spec,
        0,
        new Float64Array(4),
      );
    } catch {
      threw = true;
    }
    assert(threw, "flat length < sampleCount * order rejected");
  }

  // Out-buffer aliasing reuse — the function writes into the caller's out
  // buffer in-place (no replacement). Verify a second call mutates the same
  // backing Float64Array reference.
  {
    const flat = new Float64Array([1.0, 0.5]);
    const spec: TrajectorySpec = { order: 2, sampleCount: 1 };
    const out = new Float64Array(1);
    const sameRef = out;
    evaluateTrajectoryInto(flat, spec, 2.0, out);
    assertEq(out[0], 1.0 + 0.5 * 2.0, "in-place write #1");
    assert(sameRef === out, "out reference unchanged after call");
    evaluateTrajectoryInto(flat, spec, 4.0, out);
    assertEq(out[0], 1.0 + 0.5 * 4.0, "in-place write #2 reuses out buffer");
  }

  // End-to-end with the DSL: pull `spec` straight off a CompiledField,
  // confirming evaluator + DSL round-trip with no manual TrajectorySpec
  // construction. This is the pattern downstream consumers will use.
  {
    const N = 8;
    const s = defineSchema({
      seq: u64(),
      vEff: f64TrajectoryArray(N, { order: 2 }),
    });
    const cf = s.compiled.fields.find((f) => f.name === "vEff")!;
    assert(cf.trajectory !== undefined, "DSL provides trajectory tag");
    const flat = new Float64Array(N * 2);
    for (let i = 0; i < N; i++) {
      flat[i * 2] = i * 10;       // position
      flat[i * 2 + 1] = 1.0;      // velocity (all samples drift at 1.0)
    }
    const out = new Float64Array(N);
    evaluateTrajectoryInto(flat, cf.trajectory!, 0.25, out);
    for (let i = 0; i < N; i++) {
      assertEq(
        out[i]!,
        i * 10 + 1.0 * 0.25,
        `DSL→evaluator round-trip sample ${i}`,
      );
    }
  }

  ok("evaluate-trajectory");
}

// ── 12. .withTimestamps builder (0.6.5) ────────────────────────────────────
function testWithTimestamps(): void {
  // Happy path: declare two roles, one flagged default.
  const schema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    tGpuNs: u64(),
    tFrameMs: f64(),
    vEff: f64Array(4),
  }).withTimestamps({
    macro: { field: "tMacroNs", unit: "ns", default: true },
    gpu:   { field: "tGpuNs",   unit: "ns" },
    frame: { field: "tFrameMs", unit: "ms" },
  });

  assert(schema.timestamps !== null, "timestamps spec attached");
  const ts = schema.timestamps!;
  assertEq(ts.defaultRole, "macro", "default role = macro (flagged)");
  assertEq(Object.keys(ts.roles).length, 3, "three roles");
  assertEq(ts.roles.macro!.field, "tMacroNs", "macro.field");
  assertEq(ts.roles.macro!.unit, "ns", "macro.unit");
  assertEq(ts.roles.macro!.isBigInt, true, "macro.isBigInt (u64)");
  assertEq(ts.roles.frame!.isBigInt, false, "frame.isBigInt (f64) === false");
  assertEq(ts.roles.frame!.unit, "ms", "frame.unit");
  assert(Object.isFrozen(ts), "timestamps spec frozen");
  assert(Object.isFrozen(ts.roles), "timestamps.roles frozen");
  assert(Object.isFrozen(ts.roles.macro), "role descriptor frozen");

  // Default-role fallback: no flag → first declared wins.
  const schema2 = defineSchema({
    seq: u64(),
    a: u64(),
    b: u64(),
  }).withTimestamps({
    aRole: { field: "a", unit: "ns" },
    bRole: { field: "b", unit: "ns" },
  });
  assertEq(schema2.timestamps!.defaultRole, "aRole", "first declared = default");

  // describeSchemaLayout propagates timestamps.
  const layout = describeSchemaLayout(schema);
  assert(layout.timestamps !== null, "layout.timestamps non-null");
  assertEq(layout.timestamps!.defaultRole, "macro", "layout default = macro");
  assertEq(layout.timestamps!.roles.gpu!.field, "tGpuNs", "layout role roundtrip");

  // No-timestamps schema → layout.timestamps === null.
  const bare = defineSchema({ seq: u64(), v: f64() });
  assertEq(bare.timestamps, null, "bare.timestamps === null");
  assertEq(describeSchemaLayout(bare).timestamps, null, "bare layout.timestamps null");

  // Composition with withInvariant: either order works; timestamps spec
  // survives a subsequent withInvariant call.
  const withBoth = defineSchema({
    seq: u64(),
    tNs: u64(),
    vEff: f64Array(2),
  })
    .withTimestamps({ macro: { field: "tNs", unit: "ns", default: true } })
    .withInvariant((f) => f.vEff[0]! * f.vEff[0]!);
  assert(withBoth.timestamps !== null, "timestamps survives withInvariant");
  assert(withBoth.invariant !== null, "invariant attached");

  const withBoth2 = defineSchema({
    seq: u64(),
    tNs: u64(),
    vEff: f64Array(2),
  })
    .withInvariant((f) => f.vEff[0]! * f.vEff[0]!)
    .withTimestamps({ macro: { field: "tNs", unit: "ns" } });
  assert(withBoth2.timestamps !== null && withBoth2.invariant !== null,
    "both orders compose");

  // ─── Validation errors ─────────────────────────────────────────────────
  const baseFields = {
    seq: u64(),
    tNs: u64(),
    vEff: f64Array(4),
    label: u8(),
  };

  function throws(label: string, fn: () => void): void {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, `expected throw: ${label}`);
  }

  // Unknown field.
  throws("unknown field", () =>
    defineSchema(baseFields).withTimestamps({
      bogus: { field: "nope" as keyof typeof baseFields & string, unit: "ns" },
    }),
  );
  // Array field rejected.
  throws("array field rejected", () =>
    defineSchema(baseFields).withTimestamps({
      bad: { field: "vEff", unit: "ns" },
    }),
  );
  // Invalid unit.
  throws("invalid unit", () =>
    defineSchema(baseFields).withTimestamps({
      bad: { field: "tNs", unit: "minutes" as unknown as "ns" },
    }),
  );
  // Two defaults.
  throws("two defaults", () =>
    defineSchema(baseFields).withTimestamps({
      a: { field: "tNs", unit: "ns", default: true },
      b: { field: "seq", unit: "ns", default: true },
    }),
  );
  // Empty config.
  throws("empty config", () =>
    defineSchema(baseFields).withTimestamps({}),
  );
  // Invalid identifier as role name.
  throws("bad role name", () =>
    defineSchema(baseFields).withTimestamps({
      "bad-name": { field: "tNs", unit: "ns" },
    }),
  );
  // Non-object arg.
  throws("non-object arg", () =>
    (defineSchema(baseFields).withTimestamps as unknown as (x: unknown) => unknown)(null),
  );

  ok("with-timestamps");
}

// ── 13. withInvariant({ absoluteEpsilon }) opts (0.6.6) ────────────────────
//
// The second-argument opts bag threads `absoluteEpsilon` onto
// `Schema.invariant.absoluteEpsilon`. Validation rejects NaN / Infinity /
// negative / non-numeric values; default-omit yields
// `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` (1e-12). The Bridge-side behavioral
// half — subnormal-stored invariant accepted under the floor — lives in
// `tests/Bridge.test.ts` pin 54.
function testWithInvariantOpts(): void {
  const base = defineSchema({ x: f64() });
  const fn = (frame: { x: number }) => frame.x * frame.x;

  // Default — no opts: absoluteEpsilon === DEFAULT_INVARIANT_ABSOLUTE_EPSILON.
  const a = base.withInvariant(fn);
  assert(a.invariant !== null, "default-opts: invariant attached");
  assertEq(
    a.invariant?.absoluteEpsilon,
    DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
    "default opts ⇒ DEFAULT_INVARIANT_ABSOLUTE_EPSILON",
  );
  assertEq(
    DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
    1e-12,
    "exported default constant is 1e-12",
  );

  // Explicit absoluteEpsilon propagates onto the spec.
  const b = base.withInvariant(fn, { absoluteEpsilon: 1e-9 });
  assertEq(
    b.invariant?.absoluteEpsilon,
    1e-9,
    "explicit absoluteEpsilon threaded onto spec",
  );

  // 0 is a permitted value — reproduces pre-0.6.6 pure-ratio behavior.
  const c = base.withInvariant(fn, { absoluteEpsilon: 0 });
  assertEq(c.invariant?.absoluteEpsilon, 0, "absoluteEpsilon = 0 accepted");

  // Empty opts object falls through to the default.
  const d = base.withInvariant(fn, {} as WithInvariantOptions);
  assertEq(
    d.invariant?.absoluteEpsilon,
    DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
    "empty opts ⇒ default",
  );

  // explicit `undefined` field also falls through.
  const e = base.withInvariant(fn, { absoluteEpsilon: undefined });
  assertEq(
    e.invariant?.absoluteEpsilon,
    DEFAULT_INVARIANT_ABSOLUTE_EPSILON,
    "undefined absoluteEpsilon ⇒ default",
  );

  // Validation: NaN, Infinity, negative, non-numeric all rejected.
  const throws = (label: string, fnRun: () => unknown): void => {
    let threw = false;
    try { fnRun(); } catch { threw = true; }
    assert(threw, `withInvariant opts: ${label} should throw`);
  };
  throws("NaN", () => base.withInvariant(fn, { absoluteEpsilon: NaN }));
  throws("Infinity", () => base.withInvariant(fn, { absoluteEpsilon: Infinity }));
  throws("-Infinity", () => base.withInvariant(fn, { absoluteEpsilon: -Infinity }));
  throws("negative", () => base.withInvariant(fn, { absoluteEpsilon: -1e-15 }));
  throws(
    "non-numeric",
    () =>
      (base.withInvariant as unknown as (
        fn: unknown,
        opts: unknown,
      ) => unknown)(fn, { absoluteEpsilon: "1e-12" }),
  );
  // Non-object opts (other than undefined) is rejected.
  throws(
    "opts = null",
    () =>
      (base.withInvariant as unknown as (
        fn: unknown,
        opts: unknown,
      ) => unknown)(fn, null),
  );
  throws(
    "opts = 0",
    () =>
      (base.withInvariant as unknown as (
        fn: unknown,
        opts: unknown,
      ) => unknown)(fn, 0),
  );

  // Schema with explicit opts is still frozen.
  let frozeThrew = false;
  try {
    (b as { frameByteSize: number }).frameByteSize = 99;
  } catch {
    frozeThrew = true;
  }
  assert(frozeThrew, "schema with absoluteEpsilon is still frozen");

  ok("with-invariant-opts");
}

function main(): void {
  testConstructors();
  testValidation();
  testAlignmentGrouping();
  testFramePadding();
  testCompiledMetadata();
  testDescribeLayout();
  testFrameForInference();
  testSchemaFrozen();
  testWithInvariant();
  testTrajectoryArrays();
  testEvaluateTrajectory();
  testWithTimestamps();
  testWithInvariantOpts();
  console.log("ALL PASS schema");
}

main();
