/**
 * emitWasmDecoder — monomorphized WASM whole-frame decoder equivalence.
 *
 * `emitWasmDecoder(schema)` generates a WAT module that decodes one ring slot
 * into a scratch region with every field offset baked in as an `i32.const`
 * literal — the schema-generated, straight-line counterpart to the packaged
 * GENERIC `decode_frame` (which loops a runtime descriptor table). The thesis
 * of the 0.9.74–0.9.77 SIMD-harvest sprint was "let the data decide"; this is
 * the codegen step that makes the decoder monomorphic. For it to be a drop-in
 * it must be PROVABLY equivalent, so this suite diffs the generated decoder
 * against two oracles at once:
 *
 *   (A) the GENERIC `decode_frame` — same shared memory, same slot; the two
 *       decoded scratch regions must be BYTE-IDENTICAL (the generated decoder
 *       uses the same descending-alignment destination packing as
 *       `buildFrameDescriptors`, so this is exact, not approximate).
 *   (B) `Bridge.pull` — the ground-truth JS decode; every decoded field must
 *       equal what was pushed (= what the JS Bridge surfaces).
 *
 * The generated WAT is compiled in-process with `wabt` (a devDependency; the
 * same toolkit `wasm/build.mjs` uses) under the same feature flags, then
 * instantiated against the SAME `WebAssembly.Memory` the Bridge SAB lives in.
 * `emitWasmDecoder` itself only ever returns a STRING — it imports no compiler,
 * matching the `emitWorkletReader` / `emitWgslStruct` boundary.
 *
 * Pins:
 *   1. Scalar-only schema fully coalesces to ONE memory.copy + is equivalent.
 *   2. Mixed scalar + array + trajectory schema is byte-identical to generic
 *      and bit-exact to Bridge.pull across a wrap-covering, fuzzed drive.
 *   3. coalesceCopies on/off produce IDENTICAL decoded bytes (off = one copy
 *      per field, on ≤ that); the optimization changes op count, not output.
 *   4. Invariant + timestamps schema: the invariant lane is EXCLUDED from the
 *      decode (bridge-managed), user fields still match Bridge.pull.
 *
 * Skips cleanly (exit 0) on a runtime without WASM SIMD+threads support — the
 * generated decoder needs only shared memory + bulk-memory, but pin (A) reuses
 * `instantiateConsumer`, which gates on `hasWasmConsumerSupport()`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import wabtInit from "wabt";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64, u64, u32, u16, u8, i16,
  f64Array, f32Array, f64TrajectoryArray,
  describeSchemaLayout,
  type Schema, type FieldsObject, type TimestampsConfig,
} from "../src/schema.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  buildFrameDescriptors,
  slotByteBase,
  hasWasmConsumerSupport,
} from "../src/worklet/index.js";
import { emitWasmDecoder, planWasmDecoder } from "../src/emitWasmDecoder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

type AnySchema = Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>;

/** Compile a WAT module string to a wasm binary via wabt, under the same
 *  feature flags `wasm/build.mjs` uses (simd / threads / bulk_memory). Returns
 *  a fresh Uint8Array over a plain ArrayBuffer (WebAssembly.Module rejects
 *  SAB-backed views). */
function makeCompiler(
  wabt: Awaited<ReturnType<typeof wabtInit>>,
): (wat: string) => Uint8Array<ArrayBuffer> {
  return (wat: string) => {
    const mod = wabt.parseWat("emitted.wat", wat, {
      simd: true,
      threads: true,
      bulk_memory: true,
    });
    const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
    mod.destroy();
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    return bytes;
  };
}

/** Read the packaged generic decoder.wasm as a plain-ArrayBuffer Uint8Array. */
function readPackagedDecoder(): Uint8Array<ArrayBuffer> {
  const fileBuf = readFileSync(wasmPath);
  const bytes = new Uint8Array(fileBuf.byteLength);
  bytes.set(fileBuf);
  return bytes;
}

/**
 * Drive one schema through both decoders and assert (A) byte-identity vs the
 * generic path and (B) field equality vs the pushed frame / Bridge.pull.
 *
 * `fill(frame, r)` mutates the scratch push-frame for row `r`. Returns the
 * generated decoder's coalesced copy count for the caller to report/assert.
 */
function proveSchema(
  label: string,
  schema: AnySchema,
  capacity: number,
  rows: number,
  fill: (frame: Record<string, unknown>, r: number) => void,
  compile: (wat: string) => Uint8Array<ArrayBuffer>,
  packagedBytes: Uint8Array<ArrayBuffer>,
  coalesce: boolean,
  addrForm: { slotInput: "slotBase" | "slotIndex"; bakeDst: boolean } = {
    slotInput: "slotBase",
    bakeDst: false,
  },
): { copies: number; fields: number } {
  const layout = describeSchemaLayout(schema);
  const plan = planWasmDecoder(layout, { coalesceCopies: coalesce });
  const sabBytes = Bridge.byteLength(capacity, schema);

  // Generic path needs its descriptor table probed for sizing first.
  const probe = buildFrameDescriptors(layout, 0);
  const descBytes = probe.descCount * 12;
  // Scratch layout: [descTable | genericDecoded | generatedDecoded], each
  // 8-aligned. Reserve generously.
  const scratchBytes = descBytes + probe.totalDstBytes * 2 + 256;
  const alloc = allocateWorkletMemory({ sabBytes, scratchBytes });
  const base = alloc.scratchByteOffset!;
  const descPtr = base; // page-aligned ⇒ 4-aligned
  const genericBase = (descPtr + descBytes + 7) & ~7;
  const generatedBase = (genericBase + probe.totalDstBytes + 7) & ~7;

  // Generic descriptor plan targets genericBase; blit its words once.
  const genericPlan = buildFrameDescriptors(layout, genericBase);
  new Int32Array(alloc.sab, descPtr, genericPlan.words.length).set(genericPlan.words);

  // The generated decoder's destination packing must match the generic one's:
  // for every field, generatedBase + plan.dstRel === genericPlan.fields[name].byteOffset.
  for (const f of plan.fields) {
    const g = genericPlan.fields[f.name]!;
    assertEq(
      generatedBase + f.dstRel,
      g.byteOffset - genericBase + generatedBase,
      `${label}: dst packing parity for field '${f.name}'`,
    );
    assertEq(f.byteCount, g.byteCount, `${label}: byteCount parity for '${f.name}'`);
  }

  const bridge = new Bridge(alloc.sab, capacity, schema);
  const consumer = instantiateConsumer(packagedBytes, alloc.memory);

  // Compile + instantiate the generated decoder against the SAME memory, in
  // whichever address form the caller requested. When dstBase is baked it must
  // equal generatedBase (where this harness reads decoded bytes from).
  const wat = emitWasmDecoder(layout, {
    coalesceCopies: coalesce,
    slotInput: addrForm.slotInput,
    ...(addrForm.bakeDst ? { dstBase: generatedBase } : {}),
  });
  const genBytes = compile(wat);
  const genMod = new WebAssembly.Module(genBytes);
  const genInst = new WebAssembly.Instance(genMod, { env: { memory: alloc.memory } });
  const decodeExport = genInst.exports.decode_frame as (...args: number[]) => void;
  assert(typeof decodeExport === "function", `${label}: generated decode_frame export present`);
  // Unify the four signatures behind one (slot, slotBase) wrapper.
  const decodeGenerated = (slot: number, slotBase: number): void => {
    const slotArg = addrForm.slotInput === "slotIndex" ? slot : slotBase;
    if (addrForm.bakeDst) decodeExport(slotArg);
    else decodeExport(slotArg, generatedBase);
  };

  // Byte views over the two decoded regions for the identity diff.
  const genericRegion = new Uint8Array(alloc.sab, genericBase, probe.totalDstBytes);
  const generatedRegion = new Uint8Array(alloc.sab, generatedBase, probe.totalDstBytes);

  const mask = capacity - 1;
  const frameBytes = schema.compiled.frameByteSize;
  const push = bridge.scratchFrame() as unknown as Record<string, unknown>;
  const pull = bridge.scratchFrame();
  while (bridge.pull(pull as never)) { /* drain */ }

  for (let r = 0; r < rows; r++) {
    fill(push, r);
    assert(bridge.push(push as never), `${label}: push row ${r}`);

    const slot = consumer.peekPull(mask);
    assert(slot >= 0, `${label}: peekPull row ${r} not empty`);
    const slotBase = slotByteBase(slot, frameBytes);

    // Zero both regions so a missed copy surfaces as a mismatch, not stale data.
    genericRegion.fill(0);
    generatedRegion.fill(0);

    consumer.decodeFrame(slotBase, descPtr, genericPlan.descCount);
    decodeGenerated(slot, slotBase);

    // (A) Byte-identical to the generic decode.
    for (let b = 0; b < probe.totalDstBytes; b++) {
      if (genericRegion[b] !== generatedRegion[b]) {
        assertEq(
          generatedRegion[b],
          genericRegion[b],
          `${label}: byte ${b} differs (generated vs generic) row ${r}`,
        );
      }
    }
    consumer.commitPull();
  }

  // (B) Bridge.pull cross-check: decode a fresh row with the generated path,
  // snapshot, then JS-pull an identical re-push and compare a couple of fields.
  fill(push, rows + 1);
  assert(bridge.push(push as never), `${label}: cross-check push`);
  const xSlot = consumer.peekPull(mask);
  generatedRegion.fill(0);
  decodeGenerated(xSlot, slotByteBase(xSlot, frameBytes));
  consumer.commitPull();
  // Snapshot every f64/f32 scalar + first array element through generated views.
  const snapshots: Array<{ name: string; got: number }> = [];
  for (const f of plan.fields) {
    if (f.kind === "f64") {
      snapshots.push({
        name: f.name,
        got: new Float64Array(alloc.sab, generatedBase + f.dstRel, 1)[0]!,
      });
    } else if (f.kind === "f32") {
      snapshots.push({
        name: f.name,
        got: new Float32Array(alloc.sab, generatedBase + f.dstRel, 1)[0]!,
      });
    }
  }
  assert(bridge.push(push as never), `${label}: re-push for JS cross-check`);
  assert(bridge.pull(pull as never), `${label}: JS pull cross-check`);
  const pulled = pull as unknown as Record<string, unknown>;
  for (const s of snapshots) {
    const ref = pulled[s.name];
    const refNum = ref instanceof Float64Array || ref instanceof Float32Array
      ? ref[0]!
      : (ref as number);
    assertEq(s.got, refNum, `${label}: generated '${s.name}' == Bridge.pull`);
  }

  return { copies: plan.copies.length, fields: plan.fields.length };
}

async function main(): Promise<void> {
  if (!hasWasmConsumerSupport()) {
    console.log(
      "SKIP emitWasmDecoder.test.ts — runtime lacks WASM SIMD/threads " +
        "(generated decoder needs shared+bulk-memory; the generic-path oracle needs the consumer).",
    );
    return;
  }
  const wabt = await wabtInit();
  const compile = makeCompiler(wabt);
  const packaged = readPackagedDecoder();
  assert(packaged.byteLength > 0, "packaged decoder.wasm is non-empty (run build:wasm)");

  // ── 1: Scalar-only schema fully coalesces to ONE memory.copy ────────────
  {
    const schema = defineSchema({ seq: u64(), tNs: u64(), value: f64() });
    const plan = planWasmDecoder(describeSchemaLayout(schema));
    // seq@0, tNs@8, value@16 — contiguous in src AND dst ⇒ one fused copy.
    assertEq(plan.copies.length, 1, "scalar-only schema coalesces to 1 memory.copy");
    assertEq(plan.fields.length, 3, "scalar-only schema has 3 fields");
    const r = proveSchema(
      "scalar-only",
      schema,
      16,
      40,
      (f, i) => {
        f.seq = BigInt(900_000 + i);
        f.tNs = BigInt((900_000 + i) * 1000);
        f.value = Math.sin(i * 0.37) * 1234.5;
      },
      compile,
      packaged,
      true,
    );
    ok(`scalar-only-equivalence (${r.fields} fields → ${r.copies} copy; 40 rows, wrap 2.5×)`);
  }

  // ── 2: Mixed scalar + array + trajectory, fuzzed + wrap-covering ─────────
  {
    const schema = defineSchema({
      seq: u64(),
      tNs: u64(),
      vMax: f64(),
      flags: u32(),
      tag: u16(),
      kindByte: u8(),
      lil: i16(),
      vEff: f64Array(8),
      gEff: f32Array(8),
      traj: f64TrajectoryArray(4, { order: 2 }),
    });
    // Deterministic LCG fuzz so a failure reproduces.
    let s = 0x1234_5678 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    const r = proveSchema(
      "mixed",
      schema,
      8,
      60,
      (f, i) => {
        f.seq = BigInt(7_000_000 + i);
        f.tNs = BigInt((7_000_000 + i) * 1000);
        f.vMax = (rnd() - 0.5) * 1e6;
        f.flags = (rnd() * 0xffff_ffff) >>> 0;
        f.tag = (rnd() * 0xffff) & 0xffff;
        f.kindByte = (rnd() * 255) & 0xff;
        f.lil = ((rnd() * 0xffff) & 0xffff) - 0x8000;
        const vEff = f.vEff as Float64Array;
        const gEff = f.gEff as Float32Array;
        const traj = f.traj as Float64Array;
        for (let k = 0; k < 8; k++) {
          vEff[k] = (rnd() - 0.5) * 200;
          gEff[k] = Math.fround((rnd() - 0.5) * 4);
          traj[k] = (rnd() - 0.5) * 50;
        }
      },
      compile,
      packaged,
      true,
    );
    ok(`mixed-equivalence (${r.fields} fields → ${r.copies} copies; 60 fuzzed rows, wrap 7.5×)`);
  }

  // ── 3: coalesceCopies on/off produce identical decoded bytes ────────────
  {
    const schema = defineSchema({
      a: f64(), b: f64(), c: u32(), d: u16(), e: u8(), arr: f32Array(5),
    });
    const off = planWasmDecoder(describeSchemaLayout(schema), { coalesceCopies: false });
    const on = planWasmDecoder(describeSchemaLayout(schema), { coalesceCopies: true });
    assertEq(off.copies.length, off.fields.length, "coalesce=off emits one copy per field");
    assert(on.copies.length <= off.copies.length, "coalesce=on never emits MORE copies");
    const rOff = proveSchema("coalesce-off", schema, 8, 24,
      (f, i) => fillGeneric(f, i), compile, packaged, false);
    const rOn = proveSchema("coalesce-on", schema, 8, 24,
      (f, i) => fillGeneric(f, i), compile, packaged, true);
    // Both legs already proved byte-identity vs the SAME generic oracle, so
    // they are transitively identical to each other.
    ok(`coalesce-invariance (off=${rOff.copies} copies, on=${rOn.copies} copies; same bytes via shared oracle)`);
  }

  // ── 4: Invariant + timestamps schema — invariant lane excluded ──────────
  {
    const schema = defineSchema({
      seq: u64(),
      tMacroNs: u64(),
      amp: f64(),
      pan: f64(),
    })
      .withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } })
      .withInvariant((fr) => fr.amp * fr.amp + fr.pan * fr.pan);
    const layout = describeSchemaLayout(schema);
    assert(layout.invariantByteOffset !== null, "schema has an invariant lane");
    const plan = planWasmDecoder(layout);
    // The invariant lane is NOT a user field — it must not appear in the plan.
    assert(
      !plan.fields.some((f) => f.name === "__invariant"),
      "invariant lane excluded from the decode plan",
    );
    const r = proveSchema(
      "invariant",
      schema,
      8,
      30,
      (f, i) => {
        f.seq = BigInt(500 + i);
        f.tMacroNs = BigInt((500 + i) * 1_000_000);
        f.amp = Math.sin(i * 0.21);
        f.pan = Math.cos(i * 0.13);
      },
      compile,
      packaged,
      true,
    );
    ok(`invariant-equivalence (${r.fields} user fields → ${r.copies} copies; invariant lane skipped; 30 rows)`);
  }

  // ── 5: All four address forms decode identically (single-arg included) ──
  {
    const schema = defineSchema({
      seq: u64(), tNs: u64(), vMax: f64(), flags: u32(), tag: u16(),
      vEff: f64Array(8), traj: f64TrajectoryArray(4, { order: 2 }),
    });
    // Structural: slotIndex + baked dstBase collapses to a single param and
    // bakes the absolute dst as an i32.const (no $dstBase, no slot multiply at
    // the call site).
    const single = emitWasmDecoder(describeSchemaLayout(schema), {
      slotInput: "slotIndex",
      dstBase: 4096,
    });
    assert(single.includes("(param $slot i32)"), "single-arg: takes $slot only");
    assert(!single.includes("$dstBase"), "single-arg: no $dstBase param");
    assert(single.includes("i32.const 4096"), "single-arg: bakes dst base literal");
    // Invalid baked dstBase is rejected.
    let threw = false;
    try { emitWasmDecoder(describeSchemaLayout(schema), { dstBase: 5 }); } catch { threw = true; }
    assert(threw, "non-8-aligned baked dstBase rejected");

    const fill = (f: Record<string, unknown>, i: number): void => {
      f.seq = BigInt(i); f.tNs = BigInt(i * 1000);
      f.vMax = Math.sin(i * 0.4) * 7; f.flags = (i * 99) >>> 0; f.tag = (i * 5) & 0xffff;
      const vEff = f.vEff as Float64Array, traj = f.traj as Float64Array;
      for (let k = 0; k < 8; k++) { vEff[k] = i + k * 0.5; traj[k] = i - k * 0.25; }
    };
    const forms: Array<{ slotInput: "slotBase" | "slotIndex"; bakeDst: boolean }> = [
      { slotInput: "slotBase", bakeDst: false },
      { slotInput: "slotIndex", bakeDst: false },
      { slotInput: "slotBase", bakeDst: true },
      { slotInput: "slotIndex", bakeDst: true },
    ];
    for (const form of forms) {
      proveSchema(
        `form(${form.slotInput},bakeDst=${form.bakeDst})`,
        schema, 8, 20, fill, compile, packaged, true, form,
      );
    }
    ok(`address-form-invariance (4 forms incl. single-arg decode_frame(slot); all byte-identical to generic)`);
  }

  console.log(
    "\nemitWasmDecoder: schema-generated monomorphized WAT decoder is byte-identical to the generic decode_frame and bit-exact to Bridge.pull across scalar / array / trajectory / invariant schemas and all four address forms (incl. single-arg decode_frame(slot)); copy coalescing changes op count, not output.",
  );
}

/** Shared filler for the coalesce on/off legs (schema { a,b: f64; c:u32; d:u16;
 *  e:u8; arr: f32Array(5) }). */
function fillGeneric(f: Record<string, unknown>, i: number): void {
  f.a = Math.sin(i * 0.3) * 10;
  f.b = Math.cos(i * 0.7) * 20;
  f.c = (i * 2654435761) >>> 0;
  f.d = (i * 7 + 1) & 0xffff;
  f.e = (i * 13) & 0xff;
  const arr = f.arr as Float32Array;
  for (let k = 0; k < 5; k++) arr[k] = Math.fround(Math.sin(i + k) * 3);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
