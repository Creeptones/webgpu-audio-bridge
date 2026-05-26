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
 *
 * These pins cover the DSL/compile surface in isolation — Bridge integration
 * is exercised by tests/Bridge.test.ts.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  describeSchemaLayout,
  f32,
  f64,
  f64Array,
  i16,
  kindByteSize,
  u32,
  u64,
  u8,
  u8Array,
  type FieldSpec,
  type FrameFor,
  type Schema,
} from "../src/schema.js";

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
  console.log("ALL PASS schema");
}

main();
