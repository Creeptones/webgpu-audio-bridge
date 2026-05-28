/**
 * Bridge codegen — schema-derived zero-import worklet reader.
 *
 * Covers `emitWorkletReader(input, opts?)`: the emitted source compiles, reads
 * a known SAB slot bit-exactly vs the library `Bridge.pull`, is import-free,
 * covers every FieldKind + array/trajectory fields with folded strides, and
 * omits the hidden __invariant lane unless opted in.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.codegen.test.ts
 *
 * Pins:
 *  1. testEmittedSourceParses        — emitted string parses via `new Function`
 *  2. testBitExactVsLibraryPull      — every kind + f64 array + trajectory,
 *                                       peek slot 0 === Bridge.pull decode
 *  3. testImportFree                 — no `import` / `require` in the string
 *  4. testAllKindsCoveredAndStrides  — accessor per kind + folded elemSize stride
 *  5. testInvariantOptIn             — default omits __invariant; opt-in emits it
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64Array,
  f64TrajectoryArray,
  u64,
  i64,
  u32,
  i32,
  u16,
  i16,
  u8,
  i8,
  f64,
  f32,
  type FrameFor,
} from "../src/schema.js";
import {
  emitWorkletReader,
  type EmitWorkletReaderOptions,
} from "../src/emitWorkletReader.js";

// All-kinds schema: one scalar of every FieldKind, one f64 array, and one
// trajectory array (byte-identical to a plain f64 array of sampleCount*order).
function makeAllKindsSchema() {
  return defineSchema({
    a_u64: u64(),
    b_i64: i64(),
    c_f64: f64(),
    d_u32: u32(),
    e_i32: i32(),
    f_f32: f32(),
    g_u16: u16(),
    h_i16: i16(),
    i_u8: u8(),
    j_i8: i8(),
    arr_f64: f64Array(3),
    traj: f64TrajectoryArray(2, { order: 2 }), // flat length = 2*2 = 4
  });
}

type AllKindsFrame = FrameFor<ReturnType<typeof makeAllKindsSchema>>;

function makeAllKindsFrame(): AllKindsFrame {
  return {
    a_u64: 0xdead_beef_0000_0001n,
    b_i64: -1234567890123n,
    c_f64: Math.PI,
    d_u32: 0xdead_beef,
    e_i32: -2_000_111_222,
    f_f32: Math.fround(-0.5),
    g_u16: 0xbeef,
    h_i16: -12345,
    i_u8: 250,
    j_i8: -42,
    arr_f64: new Float64Array([1.5, -2.25, Math.E]),
    traj: new Float64Array([10, 11, 12, 13]),
  };
}

function emptyAllKindsFrame(): AllKindsFrame {
  return {
    a_u64: 0n,
    b_i64: 0n,
    c_f64: 0,
    d_u32: 0,
    e_i32: 0,
    f_f32: 0,
    g_u16: 0,
    h_i16: 0,
    i_u8: 0,
    j_i8: 0,
    arr_f64: new Float64Array(3),
    traj: new Float64Array(4),
  };
}

/** Build a reader function from the emitted source via `new Function`. */
function compileReader(
  src: string,
  opts: EmitWorkletReaderOptions,
): (view: DataView, slot: number, out: AllKindsFrame) => void {
  const fnName = opts.functionName ?? "readFrame";
  // The emitted string is a full `function name(...) {}` declaration; wrap so
  // `new Function` returns the inner reader.
  const factory = new Function(`${src}\nreturn ${fnName};`);
  return factory() as (view: DataView, slot: number, out: AllKindsFrame) => void;
}

// ── 1. Emitted source parses ──────────────────────────────────────────────
function testEmittedSourceParses(): void {
  const schema = makeAllKindsSchema();
  const src = emitWorkletReader(schema);
  // Parses without throwing.
  const reader = compileReader(src, {});
  assertEq(typeof reader, "function", "emitted reader is a function");
  ok("emitted source parses via new Function");
}

// ── 2. Bit-exact vs library pull ──────────────────────────────────────────
function testBitExactVsLibraryPull(): void {
  const schema = makeAllKindsSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  const frame = makeAllKindsFrame();
  assert(bridge.push(frame), "push known frame succeeded");

  // Pure-peek decode of slot 0 via the emitted reader against the SAB bytes.
  // The SAB starts at the ring header; the emitted reader bakes in the +32
  // header offset, so the DataView spans the whole SAB.
  const dv = new DataView(sab);
  const src = emitWorkletReader(schema);
  const reader = compileReader(src, {});
  const peeked = emptyAllKindsFrame();
  reader(dv, 0, peeked); // peek slot 0 — does NOT advance read_index

  // Library decode of the SAME physical slot. pull() consumes slot 0.
  const pulled = emptyAllKindsFrame();
  assert(bridge.pull(pulled), "pull of slot 0 succeeded");

  // Bigints — exact ===.
  assertEq(peeked.a_u64, pulled.a_u64, "u64 bit-exact");
  assertEq(peeked.b_i64, pulled.b_i64, "i64 bit-exact");
  // Numbers — Object.is catches -0 / NaN edges (none here, but be strict).
  assert(Object.is(peeked.c_f64, pulled.c_f64), "f64 bit-exact");
  assert(Object.is(peeked.d_u32, pulled.d_u32), "u32 bit-exact");
  assert(Object.is(peeked.e_i32, pulled.e_i32), "i32 bit-exact");
  assert(Object.is(peeked.f_f32, pulled.f_f32), "f32 bit-exact");
  assert(Object.is(peeked.g_u16, pulled.g_u16), "u16 bit-exact");
  assert(Object.is(peeked.h_i16, pulled.h_i16), "i16 bit-exact");
  assert(Object.is(peeked.i_u8, pulled.i_u8), "u8 bit-exact");
  assert(Object.is(peeked.j_i8, pulled.j_i8), "i8 bit-exact");
  for (let k = 0; k < 3; k++) {
    assert(
      Object.is(peeked.arr_f64[k], pulled.arr_f64[k]),
      `arr_f64[${k}] bit-exact`,
    );
  }
  for (let k = 0; k < 4; k++) {
    assert(
      Object.is(peeked.traj[k], pulled.traj[k]),
      `traj[${k}] bit-exact (trajectory is byte-transparent)`,
    );
  }

  // Also confirm the peek matched the originally-pushed values.
  assertEq(peeked.a_u64, frame.a_u64, "peek matches pushed u64");
  assert(Object.is(peeked.c_f64, frame.c_f64), "peek matches pushed f64");
  ok("emitted reader is bit-exact vs Bridge.pull across every kind");
}

// ── 3. Import-free ────────────────────────────────────────────────────────
function testImportFree(): void {
  const schema = makeAllKindsSchema();
  const src = emitWorkletReader(schema, { includeInvariant: true });
  assert(!/\bimport\b/.test(src), "emitted source has no `import`");
  assert(!/\brequire\b/.test(src), "emitted source has no `require`");
  ok("emitted source is import-free / require-free");
}

// ── 4. All-kinds coverage + folded strides ────────────────────────────────
function testAllKindsCoveredAndStrides(): void {
  const schema = makeAllKindsSchema();
  const src = emitWorkletReader(schema);

  // Every DataView getter appears exactly where its kind is declared.
  const expectGetters: Array<[string, string]> = [
    ["a_u64", "getBigUint64"],
    ["b_i64", "getBigInt64"],
    ["c_f64", "getFloat64"],
    ["d_u32", "getUint32"],
    ["e_i32", "getInt32"],
    ["f_f32", "getFloat32"],
    ["g_u16", "getUint16"],
    ["h_i16", "getInt16"],
    ["i_u8", "getUint8"],
    ["j_i8", "getInt8"],
  ];
  for (const [name, getter] of expectGetters) {
    assert(
      new RegExp(`out\\.${name} = view\\.${getter}\\(`).test(src),
      `${name} uses ${getter}`,
    );
  }

  // 1-byte kinds emit NO endianness flag (getUint8/getInt8 take none).
  assert(/getUint8\(b \+ \d+\);/.test(src), "u8 omits LE flag");
  assert(/getInt8\(b \+ \d+\);/.test(src), "i8 omits LE flag");
  // Multi-byte kinds DO emit the LE flag.
  assert(/getFloat64\(b \+ \d+, true\);/.test(src), "f64 emits LE flag");

  // Array stride is folded at emit time: f64 array strides by *8, traj too.
  assert(
    /a\[i\] = view\.getFloat64\(b \+ \d+ \+ i \* 8, true\);/.test(src),
    "f64 array folds elemSize 8 stride",
  );
  // Loop bounds inlined as literals (arr_f64 length 3, traj flat length 4).
  assert(/for \(let i = 0; i < 3; i\+\+\)/.test(src), "arr_f64 loop bound 3");
  assert(/for \(let i = 0; i < 4; i\+\+\)/.test(src), "traj flat loop bound 4");

  // Header offset baked in as literal 32.
  assert(/const b = 32 \+ slot \* \d+;/.test(src), "slot base bakes header 32");
  ok("all kinds covered, strides + loop bounds folded as literals");
}

// ── 5. Invariant opt-in ───────────────────────────────────────────────────
function testInvariantOptIn(): void {
  const invSchema = defineSchema({
    seq: u64(),
    vEff: f64Array(4),
  }).withInvariant((f) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += f.vEff[k]! * f.vEff[k]!;
    return s;
  });

  const defaultSrc = emitWorkletReader(invSchema);
  assert(
    !/__invariant/.test(defaultSrc),
    "default emission omits the __invariant lane",
  );

  const optInSrc = emitWorkletReader(invSchema, { includeInvariant: true });
  assert(
    /out\.__invariant = view\.getFloat64\(b \+ \d+, true\);/.test(optInSrc),
    "includeInvariant emits the __invariant f64 read",
  );

  // A schema with NO invariant must not emit one even when asked.
  const plain = makeAllKindsSchema();
  const plainOptIn = emitWorkletReader(plain, { includeInvariant: true });
  assert(
    !/__invariant/.test(plainOptIn),
    "no-invariant schema never emits __invariant even with opt-in",
  );
  ok("invariant lane is opt-in and only when the schema has one");
}

function main(): void {
  testEmittedSourceParses();
  testBitExactVsLibraryPull();
  testImportFree();
  testAllKindsCoveredAndStrides();
  testInvariantOptIn();
  console.log("\nAll Bridge.codegen tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
