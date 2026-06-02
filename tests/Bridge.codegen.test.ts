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
 *  6. testCompileWorkletReaderRoundTrip — compiled fn (not just string) ===
 *                                      Bridge.pull bit-for-bit
 *  7. testProcessorModuleShape       — emitWorkletProcessorModule: one
 *                                      registerProcessor, embeds reader,
 *                                      import-free, parses via new Function
 *  8. testToWorkletModuleURL         — throws when createObjectURL absent;
 *                                      returns blob: url + revoke when stubbed
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
  emitWorkletProcessorModule,
  toWorkletModuleURL,
  compileWorkletReader,
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

// ── 6. compileWorkletReader round-trips the COMPILED fn vs Bridge.pull ──────
function testCompileWorkletReaderRoundTrip(): void {
  const schema = makeAllKindsSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  const frame = makeAllKindsFrame();
  assert(bridge.push(frame), "push known frame succeeded");

  // The existing pin #2 proves the emitted STRING is bit-exact; this proves the
  // convenience-compiled FUNCTION (the helper callers actually use on the main
  // thread / in tests) is too.
  const reader = compileWorkletReader(schema);
  assertEq(typeof reader, "function", "compileWorkletReader returns a function");
  const dv = new DataView(sab);
  const peeked = emptyAllKindsFrame();
  reader(dv, 0, peeked); // peek slot 0 — does NOT advance read_index

  const pulled = emptyAllKindsFrame();
  assert(bridge.pull(pulled), "pull of slot 0 succeeded");

  assertEq(peeked.a_u64, pulled.a_u64, "u64 bit-exact (compiled fn)");
  assertEq(peeked.b_i64, pulled.b_i64, "i64 bit-exact (compiled fn)");
  assert(Object.is(peeked.c_f64, pulled.c_f64), "f64 bit-exact (compiled fn)");
  assert(Object.is(peeked.f_f32, pulled.f_f32), "f32 bit-exact (compiled fn)");
  assert(Object.is(peeked.j_i8, pulled.j_i8), "i8 bit-exact (compiled fn)");
  for (let k = 0; k < 3; k++) {
    assert(Object.is(peeked.arr_f64[k], pulled.arr_f64[k]), `arr_f64[${k}] bit-exact (compiled fn)`);
  }
  for (let k = 0; k < 4; k++) {
    assert(Object.is(peeked.traj[k], pulled.traj[k]), `traj[${k}] bit-exact (compiled fn)`);
  }
  ok("6 compileWorkletReader compiles a fn bit-exact vs Bridge.pull");
}

// ── 7. emitWorkletProcessorModule shape ─────────────────────────────────────
function testProcessorModuleShape(): void {
  const schema = makeAllKindsSchema();
  const PROCESSOR = "macro-reader";
  const BODY = "    const w = 0; readFrame(this._view, slotOf(w), out); return true;";
  const mod = emitWorkletProcessorModule(schema, {
    processorName: PROCESSOR,
    processBody: BODY,
  });

  // (a) exactly one registerProcessor(<processorName>, …)
  const regMatches = mod.match(/registerProcessor\(/g) ?? [];
  assertEq(regMatches.length, 1, "exactly one registerProcessor call");
  assert(
    mod.includes(`registerProcessor(${JSON.stringify(PROCESSOR)},`),
    "registerProcessor names the requested processorName",
  );

  // (b) embeds the reader fn (default name readFrame).
  assert(/function readFrame\(view, slot, out\) \{/.test(mod), "module embeds the reader fn");
  // The caller's body is spliced in verbatim.
  assert(mod.includes(BODY), "module splices the caller's processBody");
  // Pre-allocated reusable out frame (array fields → typed arrays).
  assert(/arr_f64: new Float64Array\(3\)/.test(mod), "out frame pre-allocates the f64 array");
  assert(/a_u64: 0n/.test(mod), "out frame inits bigint scalar to 0n");

  // (c) import-free / require-free.
  assert(!/\bimport\b/.test(mod), "processor module has no `import`");
  assert(!/\brequire\b/.test(mod), "processor module has no `require`");

  // (d) parses via new Function (smoke — won't RUN outside a worklet, but the
  //     class body + registerProcessor call must be syntactically valid).
  let parsed = false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(mod);
    parsed = true;
  } catch {
    parsed = false;
  }
  assert(parsed, "processor module parses via new Function");

  // A non-empty processorName is required.
  let threw = false;
  try {
    emitWorkletProcessorModule(schema, { processorName: "", processBody: BODY });
  } catch {
    threw = true;
  }
  assert(threw, "empty processorName throws");
  ok("7 emitWorkletProcessorModule: one registerProcessor, embeds reader, import-free, parses");
}

// ── 9. generated processor pullLatest helper commits read_index ─────────────
function testProcessorPullLatestCommits(): void {
  const schema = makeAllKindsSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  const first = makeAllKindsFrame();
  const latest = makeAllKindsFrame();
  latest.a_u64 = 222n;
  latest.b_i64 = -222n;
  latest.c_f64 = 22.25;
  latest.arr_f64 = new Float64Array([9, 8, 7]);
  assert(bridge.push(first), "first frame push succeeds");
  assert(bridge.push(latest), "latest frame push succeeds");
  assertEq(bridge.available(), 2, "two frames queued before generated pullLatest");

  const processorName = "macro-reader-commit";
  const mod = emitWorkletProcessorModule(schema, {
    processorName,
    processBody: "    this._lastSkipped = pullLatest(out); return true;",
  });

  type GeneratedProcessorCtor = new (
    options: { processorOptions: { sab: SharedArrayBuffer; capacity: number; policy?: string } },
  ) => {
    process: (inputs: unknown, outputs: unknown, parameters: unknown) => boolean;
    _out: AllKindsFrame;
    _lastSkipped: number;
  };
  let ProcessorCtor: GeneratedProcessorCtor | null = null;
  const AudioWorkletProcessor = class {
    constructor() {}
  };
  const registerProcessor = (name: string, ctor: GeneratedProcessorCtor): void => {
    assertEq(name, processorName, "generated module registers the requested processor name");
    ProcessorCtor = ctor;
  };

  const runModule = new Function("AudioWorkletProcessor", "registerProcessor", mod);
  runModule(AudioWorkletProcessor, registerProcessor);
  assert(ProcessorCtor !== null, "generated module called registerProcessor");

  const Ctor = ProcessorCtor as GeneratedProcessorCtor;
  const processor = new Ctor({ processorOptions: { sab, capacity } });
  assertEq(processor.process([], [], {}), true, "generated process returns true");
  assertEq(processor._lastSkipped, 1, "pullLatest reports one skipped stale frame");
  assertEq(processor._out.a_u64, latest.a_u64, "generated pullLatest decoded latest u64");
  assertEq(processor._out.b_i64, latest.b_i64, "generated pullLatest decoded latest i64");
  assert(Object.is(processor._out.c_f64, latest.c_f64), "generated pullLatest decoded latest f64");
  for (let i = 0; i < latest.arr_f64.length; i++) {
    assert(
      Object.is(processor._out.arr_f64[i], latest.arr_f64[i]),
      `generated pullLatest decoded arr_f64[${i}]`,
    );
  }
  assertEq(bridge.available(), 0, "generated pullLatest advanced read_index to write_index");

  ok("9 generated processor pullLatest decodes newest frame and commits read_index");
}

// ── 8. toWorkletModuleURL guard + stubbed happy path ────────────────────────
function testToWorkletModuleURL(): void {
  const src = "function readFrame(){}";

  // Save whatever this runtime has (some Node versions ship createObjectURL,
  // some don't) so we can both force the ABSENT path and stub the PRESENT path
  // deterministically, then restore.
  const original = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  const originalRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;

  // Force the guard: with createObjectURL removed, toWorkletModuleURL must throw
  // a clear, actionable error pointing at the build-step path.
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  let threw = false;
  try {
    toWorkletModuleURL(src);
  } catch (e) {
    threw = true;
    assert(/createObjectURL|build-step/.test((e as Error).message), "error mentions the missing API / build-step path");
  }
  assert(threw, "toWorkletModuleURL throws when createObjectURL is absent");

  // Stub a minimal createObjectURL/revokeObjectURL and confirm the happy path.
  let revoked: string | null = null;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    "blob:stub-12345";
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => {
    revoked = u;
  };
  try {
    const handle = toWorkletModuleURL(src);
    assert(handle.url.startsWith("blob:"), "stubbed createObjectURL yields a blob: url");
    assertEq(typeof handle.revoke, "function", "handle carries a revoke fn");
    handle.revoke();
    assertEq(revoked, "blob:stub-12345", "revoke() calls URL.revokeObjectURL with the url");
  } finally {
    // Restore Node's pristine (absent) state so no other suite is affected.
    if (original === undefined) {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    } else {
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = original;
    }
    if (originalRevoke === undefined) {
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    } else {
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = originalRevoke;
    }
  }
  ok("8 toWorkletModuleURL guards absent createObjectURL + Blobs source when present");
}

function main(): void {
  testEmittedSourceParses();
  testBitExactVsLibraryPull();
  testImportFree();
  testAllKindsCoveredAndStrides();
  testInvariantOptIn();
  testCompileWorkletReaderRoundTrip();
  testProcessorModuleShape();
  testToWorkletModuleURL();
  testProcessorPullLatestCommits();
  console.log("\nAll Bridge.codegen tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
