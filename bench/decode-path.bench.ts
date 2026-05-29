/**
 * decode-path microbenchmark — which consumer-side frame decoder is fastest?
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/decode-path.bench.ts          (or `npm run bench:decode-path`)
 *
 * ─── Why this bench exists ──────────────────────────────────────────────────
 *
 * The repo accumulated TWO unfinished consumer-side decode strategies — a
 * hand-written WASM decoder (`src/worklet/`, `wasm/decoder.wat`) and a
 * codegen-JS monomorphized DataView reader (`emitWorkletReader`, 0.9.44) —
 * and never measured either against the plain `Bridge.pull` facade in a
 * head-to-head. The WASM decoder's per-field primitives (`readF64(off)`, one
 * JS↔WASM crossing per field) were suspected to LOSE to inlined JS because the
 * boundary tax dwarfs the tiny per-field work; the 0.9.74 `decodeFrame` export
 * (one crossing decodes the whole frame) was added to give WASM a fair shot.
 *
 * This bench answers: for a realistic macro-control frame, what is the per-
 * frame decode cost of each strategy, decode-only (SPSC atomics excluded,
 * since they're identical across strategies)?
 *
 *   A1  Bridge.pull            — the status-quo facade (INCLUDES SPSC atomics;
 *                                shown for context, not a like-for-like decode).
 *   A2  JS umbrella decode     — Bridge's decode CORE: umbrella TypedArray
 *                                views over the SAB, read one slot → out frame.
 *   B   codegen-JS reader      — emitWorkletReader's monomorphized DataView
 *                                reader (offsets baked in as literals).
 *   C   WASM decodeFrame       — 0.9.74 whole-frame descriptor decode (one
 *                                crossing → scratch region; reads from scratch).
 *   D   WASM per-field         — readF64/readU32/… one crossing per field.
 *
 * The A1−A2 delta is the facade + per-pull atomics/notify cost. The B vs C vs
 * D comparison is the decision the plan ("bench both, let data decide") hangs
 * on: it tells us which path to wire as the canonical worklet consumer.
 *
 * Timing harness mirrors bench/Bridge.bench.ts (hrtime.bigint, warmup +
 * measure, p50/p99/mean). Each cell decodes the SAME fixed, pre-filled slot
 * repeatedly (except A1, which must push+pull each iter and brackets only the
 * pull) so we measure decode cost, not ring traffic.
 */

import { hrtime } from "node:process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  describeSchemaLayout,
  f64, u64, u32, i32,
  f64Array, f32Array, f64TrajectoryArray,
  type FrameFor,
} from "../src/schema.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  buildFrameDescriptors,
  slotByteBase,
  hasWasmConsumerSupport,
} from "../src/worklet/index.js";
import { compileWorkletReader } from "../src/emitWorkletReader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixture: a representative macro-control frame ──────────────────────────
// A handful of scalars (seq/timestamps/peaks/flags) plus two sample arrays and
// one order-2 trajectory — the shape BridgeGPUSource macro frames actually
// carry. ARRAY_N=64 keeps the per-frame payload realistic (~1.6 KB) without
// being memcpy-dominated, so decode-strategy differences stay visible.
const ARRAY_N = 64;
const TRAJ_N = 64;
const macroSchema = defineSchema({
  seq: u64(),
  tMacroNs: u64(),
  vMax: f64(),
  jMax: f64(),
  flags: u32(),
  mode: i32(),
  vEff: f64Array(ARRAY_N),
  gEff: f32Array(ARRAY_N),
  traj: f64TrajectoryArray(TRAJ_N, { order: 2 }),
});
type MacroFrame = FrameFor<typeof macroSchema>;

const CAPACITY = 16;
const WARMUP_ITERS = 5_000;
const MEASURE_ITERS = 50_000;

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return NaN;
  const idx = Math.min(sortedNs.length - 1, Math.max(0, Math.floor(sortedNs.length * p)));
  return sortedNs[idx]!;
}
function mean(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}
function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function makeFrame(): MacroFrame {
  const vEff = new Float64Array(ARRAY_N);
  const gEff = new Float32Array(ARRAY_N);
  const traj = new Float64Array(TRAJ_N * 2);
  for (let k = 0; k < ARRAY_N; k++) {
    vEff[k] = Math.sin(k * 0.013) * 1000;
    gEff[k] = Math.fround(Math.cos(k * 0.021));
  }
  for (let k = 0; k < TRAJ_N * 2; k++) traj[k] = k * 0.5;
  return { seq: 0n, tMacroNs: 0n, vMax: 1.5, jMax: -2.5, flags: 0xdeadbeef, mode: 3, vEff, gEff, traj };
}
function makeOut(): MacroFrame {
  return {
    seq: 0n, tMacroNs: 0n, vMax: 0, jMax: 0, flags: 0, mode: 0,
    vEff: new Float64Array(ARRAY_N), gEff: new Float32Array(ARRAY_N), traj: new Float64Array(TRAJ_N * 2),
  };
}

interface Cell { name: string; note: string; samples: number[]; }

function summarize(c: Cell): { name: string; note: string; p50: number; p99: number; mean: number } {
  const sorted = c.samples.slice().sort((a, b) => a - b);
  return { name: c.name, note: c.note, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), mean: mean(c.samples) };
}

function time(iters: number, fn: (i: number) => void): number[] {
  const samples = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = hrtime.bigint();
    fn(i);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
  }
  return samples;
}

function main(): void {
  if (!hasWasmConsumerSupport()) {
    console.error("decode-path.bench: runtime lacks WASM SIMD/threads — cannot bench the WASM contenders.");
    process.exit(1);
  }

  const layout = describeSchemaLayout(macroSchema);
  const frameBytes = macroSchema.frameByteSize;
  const sabBytes = Bridge.byteLength(CAPACITY, macroSchema);

  // Plan the descriptor table + scratch, then allocate WASM memory big enough
  // for the SAB ring + descriptor table + decoded scratch region.
  const probe = buildFrameDescriptors(layout, 0);
  const descBytes = probe.descCount * 12;
  const alloc = allocateWorkletMemory({
    sabBytes,
    scratchBytes: descBytes + probe.totalDstBytes + 64,
  });
  const scratchBase = alloc.scratchByteOffset!;
  const descPtr = scratchBase;
  const decodedBase = (scratchBase + descBytes + 7) & ~7;
  const plan = buildFrameDescriptors(layout, decodedBase);
  new Int32Array(alloc.sab, descPtr, plan.words.length).set(plan.words);

  const bridge = new Bridge(alloc.sab, CAPACITY, macroSchema);
  const consumer = instantiateConsumer(
    // WebAssembly.Module rejects SAB-backed views; the binary is read by the
    // shim from disk in tests, but here we already have a memory — re-read the
    // packaged wasm bytes.
    readWasmBytes(),
    alloc.memory,
  );

  // Fill the ring and keep slot 0 stable for the decode-only cells.
  const frame = makeFrame();
  const out = makeOut();
  for (let s = 0; s < CAPACITY; s++) {
    frame.seq = BigInt(s);
    bridge.push(frame);
  }
  const slot0Base = slotByteBase(0, frameBytes);

  // ── A2: JS umbrella decode-only ──────────────────────────────────────────
  // Umbrella TypedArray views over the whole SAB, indexed at the slot. This is
  // the decode core of Bridge.pull without the SPSC atomics — the apples-to-
  // apples JS-library decode cost.
  const HEADER = 32;
  const f64View = new Float64Array(alloc.sab);
  const f32View = new Float32Array(alloc.sab);
  const u32View = new Uint32Array(alloc.sab);
  const i32View = new Int32Array(alloc.sab);
  const bigView = new BigUint64Array(alloc.sab);
  const off = (name: string) => HEADER + 0 * frameBytes + layout.fields[name]!.byteOffset;
  const oSeq = off("seq") / 8, oTNs = off("tMacroNs") / 8, oVMax = off("vMax") / 8, oJMax = off("jMax") / 8;
  const oFlags = off("flags") / 4, oMode = off("mode") / 4;
  const oVEff = off("vEff") / 8, oGEff = off("gEff") / 4, oTraj = off("traj") / 8;

  // ── B: codegen-JS reader (DataView, offsets baked in) ────────────────────
  const reader = compileWorkletReader(macroSchema, { functionName: "readMacro" });
  const dview = new DataView(alloc.sab);

  // ── C: WASM decodeFrame — read decoded scratch via views ─────────────────
  const scVMax = new Float64Array(alloc.sab, plan.fields.vMax!.byteOffset, 1);
  const scTraj = new Float64Array(alloc.sab, plan.fields.traj!.byteOffset, TRAJ_N * 2);

  // ── D: WASM per-field readers ─────────────────────────────────────────────
  const fOff = (name: string) => slot0Base + layout.fields[name]!.byteOffset;

  // Warmup each path.
  for (let i = 0; i < WARMUP_ITERS; i++) {
    out.seq = bigView[oSeq]!; out.vMax = f64View[oVMax]!; for (let k = 0; k < TRAJ_N * 2; k++) out.traj[k] = f64View[oTraj + k]!;
    reader(dview, 0, out);
    consumer.decodeFrame(slot0Base, descPtr, plan.descCount);
    out.vMax = consumer.readF64(fOff("vMax"));
  }

  const cells: Cell[] = [];

  // A1: full Bridge.pull. Each iter pushes (untimed) so the ring never
  // empties, then brackets ONLY the pull — so the cell is pull cost (decode +
  // SPSC load/store/notify), not push+pull. Shown for context: it includes
  // atomics the decode-only cells deliberately exclude.
  {
    while (bridge.pull(out)) { /* drain */ }
    const pullSamples = new Array<number>(MEASURE_ITERS);
    for (let i = 0; i < MEASURE_ITERS; i++) {
      bridge.push(frame);
      const t0 = hrtime.bigint();
      bridge.pull(out);
      const t1 = hrtime.bigint();
      pullSamples[i] = Number(t1 - t0);
    }
    cells.push({ name: "A1 Bridge.pull", note: "facade + SPSC atomics (context)", samples: pullSamples });
    // Re-fill for the decode-only cells (they read fixed slot 0).
    while (bridge.pull(out)) { /* drain */ }
    for (let s = 0; s < CAPACITY; s++) { frame.seq = BigInt(s); bridge.push(frame); }
  }

  cells.push({
    name: "A2 JS umbrella decode",
    note: "Bridge decode core, no atomics",
    samples: time(MEASURE_ITERS, () => {
      out.seq = bigView[oSeq]!; out.tMacroNs = bigView[oTNs]!;
      out.vMax = f64View[oVMax]!; out.jMax = f64View[oJMax]!;
      out.flags = u32View[oFlags]!; out.mode = i32View[oMode]!;
      for (let k = 0; k < ARRAY_N; k++) out.vEff[k] = f64View[oVEff + k]!;
      for (let k = 0; k < ARRAY_N; k++) out.gEff[k] = f32View[oGEff + k]!;
      for (let k = 0; k < TRAJ_N * 2; k++) out.traj[k] = f64View[oTraj + k]!;
    }),
  });

  cells.push({
    name: "B  codegen-JS reader",
    note: "emitWorkletReader, no atomics",
    samples: time(MEASURE_ITERS, () => { reader(dview, 0, out); }),
  });

  cells.push({
    name: "C  WASM decodeFrame",
    note: "whole-frame, 1 crossing, no atomics",
    samples: time(MEASURE_ITERS, () => { consumer.decodeFrame(slot0Base, descPtr, plan.descCount); }),
  });
  // touch scratch so the decode isn't dead-code eliminated
  void scVMax[0]; void scTraj[0];

  cells.push({
    name: "D  WASM per-field",
    note: "N crossings, no atomics",
    samples: time(MEASURE_ITERS, () => {
      out.seq = consumer.readU64(fOff("seq")); out.tMacroNs = consumer.readU64(fOff("tMacroNs"));
      out.vMax = consumer.readF64(fOff("vMax")); out.jMax = consumer.readF64(fOff("jMax"));
      out.flags = consumer.readU32(fOff("flags")); out.mode = consumer.readI32(fOff("mode"));
      const vB = fOff("vEff"), gB = fOff("gEff"), tB = fOff("traj");
      for (let k = 0; k < ARRAY_N; k++) out.vEff[k] = consumer.readF64(vB + k * 8);
      for (let k = 0; k < ARRAY_N; k++) out.gEff[k] = consumer.readF32(gB + k * 4);
      for (let k = 0; k < TRAJ_N * 2; k++) out.traj[k] = consumer.readF64(tB + k * 8);
    }),
  });

  // ── Report ────────────────────────────────────────────────────────────────
  const rows = cells.map(summarize);
  console.log(`\ndecode-path bench — schema: ${probe.descCount} fields, frame ${frameBytes} B, ` +
    `arrays ${ARRAY_N}, traj ${TRAJ_N}×o2; ${MEASURE_ITERS.toLocaleString()} iters\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("cell", 24) + pad("p50", 12) + pad("p99", 12) + pad("mean", 12) + "note");
  console.log("-".repeat(84));
  for (const r of rows) {
    console.log(pad(r.name, 24) + pad(fmt(r.p50), 12) + pad(fmt(r.p99), 12) + pad(fmt(r.mean), 12) + r.note);
  }

  // Verdict: fastest decode-only path (exclude A1, which includes atomics).
  const decodeOnly = rows.filter((r) => !r.name.startsWith("A1"));
  const winner = decodeOnly.slice().sort((a, b) => a.p50 - b.p50)[0]!;
  console.log(`\nFastest decode-only (p50): ${winner.name} @ ${fmt(winner.p50)}`);

  // Persist results JSON for the findings doc / regression tracking.
  const resultsDir = resolve(__dirname, "decode-path-comparator", "results");
  try {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      resolve(resultsDir, "node-latest.json"),
      JSON.stringify({ schema: { fields: probe.descCount, frameBytes, arrayN: ARRAY_N, trajN: TRAJ_N }, iters: MEASURE_ITERS, rows, winner: winner.name }, null, 2),
    );
    console.log(`\nWrote ${resolve(resultsDir, "node-latest.json")}`);
  } catch (e) {
    console.warn("could not write results json:", (e as Error).message);
  }
}

function readWasmBytes(): Uint8Array<ArrayBuffer> {
  const p = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");
  const buf = readFileSync(p);
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy;
}

main();
