/**
 * Bridge WGSL struct codegen — schema-derived WGSL struct generator.
 *
 * Covers `emitWgslStruct(input, opts?)` and its testable spine
 * `computeWgslLayout`: the emitted struct's member offsets equal the schema's
 * compiled byteOffsets, the struct size equals frameByteSize (the alignment-trap
 * guarantee, proven arithmetically without a WGSL compiler), sub-32-bit kinds
 * fail-fast, 64-bit kinds map to vec2<u32>, trailing padding is forced, and
 * trajectory helpers interleave correctly.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.wgsl.test.ts
 *
 * Pins:
 *  1. testRejectsSub32BitKinds   — u8/i8/u16/i16 → WgslUnsupportedKindError
 *  2. testOffsetsMatchSchema     — member.offset === compiled byteOffset
 *  3. testStructSizeMatchesFrame — structSize === frameByteSize (all shapes)
 *  4. testAllF32TrailingPad      — all-f32 schema gets a _wab_pad to reach 8
 *  5. test64BitMapsToVec2u32     — f64/u64/i64 → vec2<u32>, size 8
 *  6. testTrajectoryArrayAndHelper — flat array<f32,n*order> + interleaved helper
 *  7. testInvariantOptIn         — default folds lane into pad; opt-in exposes it
 *  8. testBannerFingerprint      — DO-NOT-EDIT banner + frameByteSize fingerprint
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  describeSchemaLayout,
  f32,
  u32,
  i32,
  u64,
  i64,
  f64,
  u8,
  i8,
  u16,
  i16,
  f32Array,
  f32TrajectoryArray,
} from "../src/schema.js";
import {
  emitWgslStruct,
  computeWgslLayout,
  WgslUnsupportedKindError,
} from "../src/emitWgslStruct.js";

/** Assert that `fn` throws an instance of `ctor`. */
function assertThrows(fn: () => unknown, ctor: new (...a: never[]) => Error, msg: string): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof ctor, `${msg} (expected ${ctor.name}, got ${String(threw)})`);
}

// A rich 32-/64-bit schema exercising scalars, arrays, and a trajectory.
function makeMixedSchema() {
  return defineSchema({
    a_u64: u64(),
    b_f64: f64(),
    c_i64: i64(),
    d_f32: f32(),
    e_u32: u32(),
    f_i32: i32(),
    arr: f32Array(5),
    traj: f32TrajectoryArray(3, { order: 2 }), // flat length = 3*2 = 6
  });
}

// ── 1. Sub-32-bit kinds are rejected ──────────────────────────────────────
function testRejectsSub32BitKinds(): void {
  const cases = [
    defineSchema({ ok: f32(), bad: u8() }),
    defineSchema({ ok: f32(), bad: i8() }),
    defineSchema({ ok: f32(), bad: u16() }),
    defineSchema({ ok: f32(), bad: i16() }),
  ];
  for (const schema of cases) {
    assertThrows(
      () => emitWgslStruct(schema),
      WgslUnsupportedKindError,
      "emitWgslStruct rejects sub-32-bit kind",
    );
    // computeWgslLayout (the spine) fails the same way.
    assertThrows(
      () => computeWgslLayout(schema),
      WgslUnsupportedKindError,
      "computeWgslLayout rejects sub-32-bit kind",
    );
  }
  ok("1 sub-32-bit kinds (u8/i8/u16/i16) fail-fast with WgslUnsupportedKindError");
}

// ── 2. Member offsets match the compiled schema byteOffsets ────────────────
function testOffsetsMatchSchema(): void {
  const schema = makeMixedSchema();
  const desc = describeSchemaLayout(schema);
  const layout = computeWgslLayout(schema);

  const fieldNames = Object.keys(desc.fields);
  const real = layout.members.filter((m) => !m.isPad && m.name !== "__invariant");
  assertEq(
    real.map((m) => m.name).join(","),
    fieldNames.join(","),
    "members appear in compiled field order",
  );
  for (const m of real) {
    assertEq(
      m.offset,
      desc.fields[m.name]!.byteOffset,
      `WGSL member '${m.name}' offset matches schema byteOffset`,
    );
  }
  ok("2 every WGSL member offset equals the schema's compiled byteOffset");
}

// ── 3. struct size === frameByteSize across schema shapes ──────────────────
function testStructSizeMatchesFrame(): void {
  const schemas = [
    makeMixedSchema(),
    defineSchema({ x: f32(), y: f32(), z: f32() }), // all-32-bit, needs pad
    defineSchema({ big: u64(), small: f32() }), // mixed align, 8-rounded
    defineSchema({ only: f64() }),
    defineSchema({ arr: f32Array(64) }),
  ];
  for (const schema of schemas) {
    const desc = describeSchemaLayout(schema);
    const layout = computeWgslLayout(schema);
    assertEq(
      layout.structSize,
      desc.frameByteSize,
      `structSize equals frameByteSize (${desc.frameByteSize})`,
    );
    // Slot stride must be a multiple of struct alignment for array<Struct>.
    assertEq(layout.structSize % layout.structAlign, 0, "structSize multiple of structAlign");
  }
  ok("3 emitted struct size equals schema frameByteSize for every shape");
}

// ── 4. All-f32 schema forces a trailing pad ────────────────────────────────
function testAllF32TrailingPad(): void {
  const schema = defineSchema({ x: f32(), y: f32(), z: f32() });
  const desc = describeSchemaLayout(schema);
  assertEq(desc.frameByteSize, 16, "three f32 frame pads to 16 bytes");
  const layout = computeWgslLayout(schema);
  const pad = layout.members.find((m) => m.isPad);
  assert(pad !== undefined, "all-f32 schema gets a trailing pad member");
  assertEq(pad!.size, 4, "pad closes the 12→16 gap (4 bytes)");
  assertEq(pad!.wgslType, "array<u32, 1>", "pad is array<u32, 1>");

  const src = emitWgslStruct(schema);
  assert(src.includes("_wab_pad: array<u32, 1>"), "emitted struct includes the pad member");
  ok("4 all-f32 schema gets a _wab_pad member stretching the struct to frameByteSize");
}

// ── 5. 64-bit kinds map to vec2<u32> byte transport ────────────────────────
function test64BitMapsToVec2u32(): void {
  const schema = defineSchema({ a: u64(), b: i64(), c: f64() });
  const layout = computeWgslLayout(schema);
  for (const name of ["a", "b", "c"]) {
    const m = layout.members.find((x) => x.name === name)!;
    assertEq(m.wgslType, "vec2<u32>", `${name} maps to vec2<u32>`);
    assertEq(m.size, 8, `${name} is 8 bytes`);
    assertEq(m.align, 8, `${name} aligns to 8`);
  }
  const src = emitWgslStruct(schema);
  assert(src.includes("a: vec2<u32>"), "emitted u64 renders as vec2<u32>");
  ok("5 f64/u64/i64 byte-transport as vec2<u32> (align/size 8)");
}

// ── 6. Trajectory array flattens + emits an interleaved helper ─────────────
function testTrajectoryArrayAndHelper(): void {
  const schema = defineSchema({ traj: f32TrajectoryArray(3, { order: 2 }) });
  const src = emitWgslStruct(schema, { structName: "MacroState" });
  assert(src.includes("traj: array<f32, 6>"), "trajectory flattens to array<f32, sampleCount*order>");
  assert(
    src.includes("fn MacroState_set_traj(state: ptr<function, MacroState>, idx: u32, p: f32, v: f32)"),
    "emits the tuple-writer helper signature",
  );
  assert(src.includes("(*state).traj[idx * 2u] = p;"), "writes p at idx*order");
  assert(src.includes("(*state).traj[idx * 2u + 1u] = v;"), "writes v at idx*order+1");

  // includeHelpers:false suppresses the helper.
  const noHelp = emitWgslStruct(schema, { structName: "MacroState", includeHelpers: false });
  assert(!noHelp.includes("_set_traj"), "includeHelpers:false omits the helper");
  ok("6 f32TrajectoryArray emits flat array + interleaved tuple-writer helper");
}

// ── 7. Invariant lane: folded by default, exposed on opt-in ────────────────
function testInvariantOptIn(): void {
  const schema = defineSchema({ amp: f32(), buf: f32Array(4) }).withInvariant(
    (frame) => {
      let s = 0;
      for (let i = 0; i < frame.buf.length; i++) s += frame.buf[i]! * frame.buf[i]!;
      return s;
    },
  );
  const desc = describeSchemaLayout(schema);
  assert(desc.invariantByteOffset !== null, "schema has an invariant lane");

  // Default: lane is folded into the trailing pad, not a named member.
  const def = computeWgslLayout(schema);
  assert(
    def.members.every((m) => m.name !== "__invariant"),
    "default does not expose __invariant",
  );
  assertEq(def.structSize, desc.frameByteSize, "default struct still spans the full frame");

  // Opt-in: lane is a named vec2<u32> member at invariantByteOffset.
  const opt = computeWgslLayout(schema, { includeInvariant: true });
  const inv = opt.members.find((m) => m.name === "__invariant");
  assert(inv !== undefined, "includeInvariant exposes __invariant");
  assertEq(inv!.offset, desc.invariantByteOffset!, "__invariant sits at invariantByteOffset");
  assertEq(inv!.wgslType, "vec2<u32>", "__invariant byte-transports as vec2<u32>");
  assertEq(opt.structSize, desc.frameByteSize, "opt-in struct spans the full frame");

  const src = emitWgslStruct(schema, { includeInvariant: true });
  assert(src.includes("__invariant: vec2<u32>"), "emitted struct exposes the invariant member");
  ok("7 invariant lane folds into pad by default, exposes as vec2<u32> on opt-in");
}

// ── 8. Banner / fingerprint present and stable ─────────────────────────────
function testBannerFingerprint(): void {
  const schema = makeMixedSchema();
  const desc = describeSchemaLayout(schema);
  const src = emitWgslStruct(schema, { structName: "MacroState" });
  assert(
    src.includes("GENERATED by emitWgslStruct — DO NOT EDIT"),
    "banner marks the output generated/do-not-edit",
  );
  assert(
    src.includes(`frameByteSize=${desc.frameByteSize}`),
    "banner fingerprints frameByteSize",
  );
  assert(src.includes("struct MacroState {"), "emits the named struct");
  assert(src.trimEnd().endsWith("}") || src.includes("};"), "struct is closed");
  ok("8 emitted struct carries a DO-NOT-EDIT banner with a frameByteSize fingerprint");
}

function main(): void {
  testRejectsSub32BitKinds();
  testOffsetsMatchSchema();
  testStructSizeMatchesFrame();
  testAllF32TrailingPad();
  test64BitMapsToVec2u32();
  testTrajectoryArrayAndHelper();
  testInvariantOptIn();
  testBannerFingerprint();
  console.log("\nAll Bridge.wgsl tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
