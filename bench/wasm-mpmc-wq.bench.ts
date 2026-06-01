/**
 * WASM MpmcWorkQueue claim-kernel experiment.
 *
 * Compares the existing JS dequeue claim sequence against the emitted WASM
 * `claim_ticket` kernel under the same raw MP->MC partition fixture as
 * bench/mpmc-wq.bench.ts. The queue protocol, payload copy, generation stamps,
 * drop accounting, and teardown strand shape are identical; only the
 * consumer-side claim primitive changes.
 */

import { hrtime } from "node:process";
import { Worker } from "node:worker_threads";
import wabtInit from "wabt";
import { MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";
import { emitWasmMpmc } from "../src/emitWasmMpmc.js";
import { allocateWasmSharedMemory } from "../src/wasm/memory.js";
import { describeSchemaLayout } from "../src/schema.js";
import { stressSchema, STRESS_N } from "../tests/_mpmcStress.js";

const schema = stressSchema();
const CAPACITY = 256;
const COUNT_PER_PRODUCER = 600_000;
const WATCHDOG_MS = 30_000;
const REPEATS = 3;
const FILL_N = STRESS_N;

type Mode = "js" | "wasm" | "wasm-padded";

interface HeaderLanes {
  readonly enqueue: number;
  readonly dequeue: number;
  readonly frontier: number;
  readonly dropped: number;
  readonly stranded: number;
  readonly torn: number;
  readonly closed: number;
  readonly flowScale: number;
}

interface BenchLayout {
  readonly headerBytes: number;
  readonly genByteOffset: number;
  readonly payloadByteOffset: number;
  readonly payloadBytes: number;
  readonly totalByteLength: number;
  readonly lanes: HeaderLanes;
}

interface Row {
  readonly mode: Mode;
  readonly producers: number;
  readonly consumers: number;
  readonly consumed: number;
  readonly dropped: number;
  readonly strands: number;
  readonly elapsedMs: number;
  readonly framesPerSec: number;
  readonly dropFrac: number;
}

function align8(b: number): number {
  return (b + 7) & ~7;
}

const COMPACT_LANES: HeaderLanes = {
  enqueue: 0,
  dequeue: 1,
  frontier: 2,
  dropped: 3,
  stranded: 4,
  torn: 5,
  closed: 6,
  flowScale: 7,
};

const PADDED_LANES: HeaderLanes = {
  enqueue: 0,
  dequeue: 16,
  frontier: 32,
  dropped: 33,
  stranded: 34,
  torn: 35,
  closed: 36,
  flowScale: 37,
};

function layoutFor(mode: Mode): BenchLayout {
  const headerBytes = mode === "wasm-padded" ? 256 : MPMC_WQ_HEADER_BYTES;
  const genByteOffset = headerBytes;
  const payloadByteOffset = genByteOffset + align8(CAPACITY * 4);
  const payloadBytes = CAPACITY * schema.frameByteSize;
  return {
    headerBytes,
    genByteOffset,
    payloadByteOffset,
    payloadBytes,
    totalByteLength: payloadByteOffset + payloadBytes,
    lanes: mode === "wasm-padded" ? PADDED_LANES : COMPACT_LANES,
  };
}

async function compileWasm(
  bytesPages: number,
  lanes: HeaderLanes,
): Promise<Uint8Array<ArrayBuffer>> {
  const wabt = await wabtInit();
  const mod = wabt.parseWat(
    "mpmc-claim.wat",
    emitWasmMpmc({
      memoryPages: { min: bytesPages, max: bytesPages },
      headerOffsets: {
        enqueueTicket: lanes.enqueue * 4,
        dequeueTicket: lanes.dequeue * 4,
      },
    }),
    { threads: true },
  );
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

const PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, ctrlSab, capacity, slack, producerId, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, lanes } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);

Atomics.add(ctrl, 3, 1);
while (Atomics.load(ctrl, 4) === 0) Atomics.wait(ctrl, 4, 0);

function advanceFrontier() {
  let f = Atomics.load(header, lanes.frontier);
  const start = f;
  for (let scanned = 0; scanned < capacity; scanned++) {
    const slot = (f >>> 0) & mask;
    if (((Atomics.load(gen, slot) - ((f + capacity) | 0)) | 0) < 0) break;
    f = (f + 1) | 0;
  }
  if (f !== start && ((f - Atomics.load(header, lanes.frontier)) | 0) > 0) Atomics.store(header, lanes.frontier, f);
}

let pushedOk = 0;
for (let seq = 0; seq < count; seq++) {
  advanceFrontier();
  const W = Atomics.load(header, lanes.enqueue);
  const F = Atomics.load(header, lanes.frontier);
  if (((W - F) | 0) >= capacity - slack) { Atomics.add(header, lanes.dropped, 1); continue; }
  const ticket = Atomics.add(header, lanes.enqueue, 1);
  const slot = (ticket >>> 0) & mask;
  const bF64 = slot * frameF64;
  const bU32 = slot * frameU32;
  f64[bF64 + off.checksum] = producerId * 0.5 + seq * 0.25;
  const fb = bF64 + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = producerId * 1000003 + seq * 7 + i * 0.25;
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  Atomics.store(gen, slot, (ticket + 1) | 0);
  pushedOk++;
}
Atomics.add(ctrl, 1, pushedOk);
Atomics.sub(ctrl, 0, 1);
parentPort.postMessage({ producerId, pushedOk });
`;

const CONSUMER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { mode, sab, memory, wasmBytes, ctrlSab, capacity, consumerIndex, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, lanes, watchdogMs } = wd;

(async () => {
  let claimTicket = null;
  if (mode === "wasm") {
    const result = await WebAssembly.instantiate(wasmBytes, { env: { memory } });
    const instance = result.instance || result;
    claimTicket = instance.exports.claim_ticket;
  }

  const mask = capacity - 1;
  const header = new Int32Array(sab);
  const gen = new Int32Array(sab, genByteOffset, capacity);
  const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
  const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
  const ctrl = new Int32Array(ctrlSab, 0, 8);

  Atomics.add(ctrl, 3, 1);
  while (Atomics.load(ctrl, 4) === 0) Atomics.wait(ctrl, 4, 0);

  function done() {
    return Atomics.load(ctrl, 0) === 0 && ((Atomics.load(ctrl, 2) - Atomics.load(ctrl, 1)) | 0) >= 0;
  }

  let held = -1, hasHeld = false, delivered = 0, sink = 0, err = null;
  const start = Date.now();

  for (;;) {
    if (!hasHeld) {
      if (mode === "wasm") {
        held = claimTicket();
        if (held < 0) {
          if (done()) break;
          if (Date.now() - start > watchdogMs) { err = "watchdog(empty) c=" + consumerIndex; break; }
          continue;
        }
      } else {
        const R = Atomics.load(header, lanes.dequeue);
        const W = Atomics.load(header, lanes.enqueue);
        if (((W - R) | 0) <= 0) {
          if (done()) break;
          if (Date.now() - start > watchdogMs) { err = "watchdog(empty) c=" + consumerIndex; break; }
          continue;
        }
        held = Atomics.add(header, lanes.dequeue, 1);
      }
      hasHeld = true;
    }

    const D = held;
    const slot = (D >>> 0) & mask;
    const seq1 = Atomics.load(gen, slot);
    const d = (seq1 - ((D + 1) | 0)) | 0;
    if (d === 0) {
      const bF64 = slot * frameF64;
      const bU32 = slot * frameU32;
      sink += f64[bF64 + off.checksum] + u32[bU32 + off.producerId] + u32[bU32 + off.seq];
      const fb = bF64 + off.fill;
      for (let i = 0; i < n; i++) sink += f64[fb + i];
      Atomics.store(gen, slot, (D + capacity) | 0);
      hasHeld = false;
      delivered++;
      Atomics.add(ctrl, 2, 1);
    } else if (d > 0) {
      Atomics.add(header, lanes.torn, 1);
      hasHeld = false;
    } else {
      if (done()) break;
      if (Date.now() - start > watchdogMs) { err = "watchdog(held) c=" + consumerIndex; break; }
    }
  }

  parentPort.postMessage({ consumerIndex, delivered, strandHeld: hasHeld, sink, err });
})().catch((e) => {
  parentPort.postMessage({ consumerIndex, delivered: 0, strandHeld: false, sink: 0, err: e && e.stack ? e.stack : String(e) });
});
`;

async function runOnce(
  mode: Mode,
  producers: number,
  consumers: number,
  wasmBytesByMode: Partial<Record<Mode, Uint8Array<ArrayBuffer>>>,
): Promise<Row> {
  const benchLayout = layoutFor(mode);
  const wasmAlloc = mode === "js" ? null : allocateWasmSharedMemory(benchLayout.totalByteLength);
  const memory = wasmAlloc?.memory;
  const sab = wasmAlloc?.sab ?? new SharedArrayBuffer(benchLayout.totalByteLength);
  const header = new Int32Array(sab);
  for (const lane of Object.values(benchLayout.lanes)) Atomics.store(header, lane, 0);
  const gen = new Int32Array(sab, benchLayout.genByteOffset, CAPACITY);
  for (let s = 0; s < CAPACITY; s++) Atomics.store(gen, s, s | 0);

  const layout = describeSchemaLayout(schema);
  const off = {
    checksum: layout.fields.checksum!.byteOffset / 8,
    fill: layout.fields.fill!.byteOffset / 8,
    producerId: layout.fields.producerId!.byteOffset / 4,
    seq: layout.fields.seq!.byteOffset / 4,
  };
  const frameByteSize = schema.frameByteSize;
  const genByteOffset = benchLayout.genByteOffset;
  const payloadByteOffset = benchLayout.payloadByteOffset;
  const payloadBytes = benchLayout.payloadBytes;
  const ctrlSab = new SharedArrayBuffer(8 * 4);
  const ctrl = new Int32Array(ctrlSab, 0, 8);
  Atomics.store(ctrl, 0, producers);
  Atomics.store(ctrl, 1, 0);
  Atomics.store(ctrl, 2, 0);
  Atomics.store(ctrl, 3, 0);
  Atomics.store(ctrl, 4, 0);

  const prodResults: Array<{ producerId: number; pushedOk: number }> = [];
  const conResults: Array<{
    consumerIndex: number;
    delivered: number;
    strandHeld: boolean;
    err: string | null;
  }> = [];
  const workers: Worker[] = [];
  let workerError: unknown = null;

  const startMs = Date.now();

  for (let p = 0; p < producers; p++) {
    const w = new Worker(PRODUCER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        ctrlSab,
        capacity: CAPACITY,
        slack: producers - 1,
        producerId: p,
        count: COUNT_PER_PRODUCER,
        n: FILL_N,
        genByteOffset,
        payloadByteOffset,
        payloadBytes,
        frameF64: frameByteSize / 8,
        frameU32: frameByteSize / 4,
        off,
        lanes: benchLayout.lanes,
      },
    });
    w.on("message", (m: { producerId: number; pushedOk: number }) => { prodResults.push(m); });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  for (let c = 0; c < consumers; c++) {
    const w = new Worker(CONSUMER_SOURCE, {
      eval: true,
      workerData: {
        mode,
        sab,
        memory,
        wasmBytes: wasmBytesByMode[mode] ?? null,
        ctrlSab,
        capacity: CAPACITY,
        consumerIndex: c,
        n: FILL_N,
        genByteOffset,
        payloadByteOffset,
        payloadBytes,
        frameF64: frameByteSize / 8,
        frameU32: frameByteSize / 4,
        off,
        lanes: benchLayout.lanes,
        watchdogMs: WATCHDOG_MS,
      },
    });
    w.on("message", (m: typeof conResults[number]) => {
      conResults.push(m);
      if (m.err) workerError = m.err;
    });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  const yieldMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
  while (Atomics.load(ctrl, 3) < producers + consumers) {
    if (workerError) break;
    if (Date.now() - startMs > WATCHDOG_MS + 5_000) {
      throw new Error(
        `ready watchdog mode=${mode} P=${producers} M=${consumers} ` +
          `ready=${Atomics.load(ctrl, 3)}/${producers + consumers}`,
      );
    }
    await yieldMacrotask();
  }
  const start = hrtime.bigint();
  Atomics.store(ctrl, 4, 1);
  Atomics.notify(ctrl, 4, producers + consumers);

  while (prodResults.length < producers || conResults.length < consumers) {
    if (workerError) break;
    if (Date.now() - startMs > WATCHDOG_MS + 5_000) {
      throw new Error(
        `watchdog mode=${mode} P=${producers} M=${consumers} ` +
          `producers=${prodResults.length}/${producers} consumers=${conResults.length}/${consumers}`,
      );
    }
    await yieldMacrotask();
  }
  const elapsedNs = Number(hrtime.bigint() - start);
  await Promise.all(workers.map((w) => w.terminate()));
  if (workerError) {
    throw new Error(`worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`);
  }

  const consumed = conResults.reduce((a, r) => a + r.delivered, 0);
  const totalPushed = prodResults.reduce((a, r) => a + r.pushedOk, 0);
  const dropped = Atomics.load(header, benchLayout.lanes.dropped) >>> 0;
  const attempted = producers * COUNT_PER_PRODUCER;
  if (consumed !== totalPushed) {
    throw new Error(`lost/duplicated frames mode=${mode} consumed=${consumed} pushed=${totalPushed}`);
  }
  if (consumed + dropped !== attempted) {
    throw new Error(`conservation failed mode=${mode} consumed=${consumed} dropped=${dropped} attempted=${attempted}`);
  }
  const tornGuarded = Atomics.load(header, benchLayout.lanes.torn) >>> 0;
  if (tornGuarded !== 0) {
    throw new Error(`tornGuarded nonzero mode=${mode}: ${tornGuarded}`);
  }

  return {
    mode,
    producers,
    consumers,
    consumed,
    dropped,
    strands: conResults.filter((r) => r.strandHeld).length,
    elapsedMs: elapsedNs / 1e6,
    framesPerSec: consumed / (elapsedNs / 1e9),
    dropFrac: dropped / attempted,
  };
}

async function main(): Promise<void> {
  const wasmBytesByMode: Partial<Record<Mode, Uint8Array<ArrayBuffer>>> = {};
  for (const mode of ["wasm", "wasm-padded"] as const) {
    const benchLayout = layoutFor(mode);
    const pages = Math.ceil(benchLayout.totalByteLength / 65_536);
    wasmBytesByMode[mode] = await compileWasm(pages, benchLayout.lanes);
  }
  const combos = [
    { producers: 2, consumers: 2 },
    { producers: 4, consumers: 2 },
  ];

  console.log(
    `WASM MpmcWorkQueue claim bench (frameBytes=${schema.frameByteSize}, cap=${CAPACITY}, ` +
      `attempts/producer=${COUNT_PER_PRODUCER.toLocaleString()}, repeats=${REPEATS})`,
  );
  for (const combo of combos) {
    const rows: Row[] = [];
    for (const mode of ["js", "wasm", "wasm-padded"] as const) {
      const samples: Row[] = [];
      for (let r = 0; r < REPEATS; r++) {
        samples.push(await runOnce(mode, combo.producers, combo.consumers, wasmBytesByMode));
      }
      samples.sort((a, b) => a.framesPerSec - b.framesPerSec);
      rows.push(samples[Math.floor(samples.length / 2)]!);
    }
    const js = rows.find((r) => r.mode === "js");
    const wasm = rows.find((r) => r.mode === "wasm");
    const padded = rows.find((r) => r.mode === "wasm-padded");
    if (js === undefined || wasm === undefined || padded === undefined) throw new Error("missing benchmark rows");
    for (const row of rows) {
      console.log(
        `  ${row.mode.toUpperCase()} P=${row.producers} M=${row.consumers} ` +
          `consumed=${row.consumed.toLocaleString().padStart(9)} ` +
          `partition=${(row.framesPerSec / 1e6).toFixed(2).padStart(5)} M/s ` +
          `drop=${(row.dropFrac * 100).toFixed(1).padStart(5)}% ` +
          `strands=${row.strands} (${row.elapsedMs.toFixed(0)} ms)`,
      );
    }
    console.log(
      `  delta WASM vs JS P=${combo.producers} M=${combo.consumers}: ` +
        `${((wasm.framesPerSec / js.framesPerSec - 1) * 100).toFixed(1)}%`,
    );
    console.log(
      `  delta PADDED vs WASM P=${combo.producers} M=${combo.consumers}: ` +
        `${((padded.framesPerSec / wasm.framesPerSec - 1) * 100).toFixed(1)}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
