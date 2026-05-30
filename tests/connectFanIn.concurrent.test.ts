/**
 * connectFanIn.concurrent.test.ts — real `worker_threads` cross-thread stress
 * for the MP→SC fan-in TOPOLOGY (src/connectFanIn.ts, Apollo Frontier 3, Stage
 * 3, 0.9.909).
 *
 * This is tests/MpmcRing.concurrent.test.ts re-pointed THROUGH the Stage-3
 * wiring: the ring is allocated by `connectFanIn(spec)` (which sizes the SAB,
 * reserves SLACK, and calls `initLayout` exactly once) and the consumer is
 * reconstructed by `mountFanIn(handle, { role:'consumer' })` — the two functions
 * under test. If the wiring mis-sized the SAB, lost the producerCount, or
 * re-inited on mount, the bit-exact + conservation assertions below would catch
 * it. (The producer-side `mountFanIn(role:'producer')` + real `push` path is
 * covered single-threaded in tests/connectFanIn.test.ts pin 4; here the producers
 * are the repo's proven inline-eval plain-JS workers, reimplementing the
 * Policy-B enqueue over the shared SAB so no TS loader is needed in the worker —
 * the HARDER memory-ordering case for the consumer under test.)
 *
 * The environment is INJECTED (turbo) so `connectFanIn` runs under Node/tsx,
 * where `crossOriginIsolated` is undefined but `SharedArrayBuffer` is present.
 *
 * N producers × COUNT frames each; every frame carries (producerId, seq, fill[],
 * checksum). The consumer recomputes checksum + every fill element with the
 * IDENTICAL float ops (imported from _mpmcStress) and asserts bit-exact — any
 * torn/wrong/reordered byte is caught. Reconciliation:
 *
 *     pushedOk (sum over workers)  === consumed
 *     attempted (= N·COUNT)        === consumed + ring.droppedFrames()
 *     ring.overrunLostFrames()     === 0   (envelope enforced, producerCount right)
 *     ring.tornFrameCount()        === 0
 *
 * Run standalone: `tsx tests/connectFanIn.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import { connectFanIn } from "../src/connectFanIn.js";
import { MPMC_HEADER_BYTES } from "../src/MpmcRing.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { stressSchema, fillValue, checksumOf, STRESS_N } from "./_mpmcStress.js";

const NPROD = 3;
const COUNT = 400_000; // 1.2 M attempted frames total (≥ 1 M)
const CAPACITY = 64;
const BATCH = 50_000;
const WATCHDOG_MS = 60_000;

// Injected Turbo report so connectFanIn() resolves to turbo under Node/tsx.
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

// Plain-JS producer (byte-faithful to src/MpmcRing.ts push + _mpmcStress.ts
// formulas). Identical to tests/MpmcRing.concurrent.test.ts's WORKER_SOURCE —
// what changed in Stage 3 is the CONSUMER allocation/mount, not the producer.
const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, capacity, slack, producerId, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);

function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}

let pushedOk = 0;
for (let seq = 0; seq < count; seq++) {
  const W = Atomics.load(header, 0);
  const R = Atomics.load(header, 1);
  if (((W - R) | 0) >= capacity - slack) { Atomics.add(header, 2, 1); continue; }
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF64 = slot * frameF64;
  const bU32 = slot * frameU32;
  f64[bF64 + off.checksum] = checksumOf(producerId, seq, n);
  const fb = bF64 + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = fillValue(producerId, seq, i);
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  Atomics.store(gen, slot, ticket | 0);
  pushedOk++;
}
parentPort.postMessage({ pushedOk });
`;

async function main(): Promise<void> {
  console.log(
    `connectFanIn.concurrent — ${NPROD} producers × ${COUNT} = ${NPROD * COUNT} attempted, cap ${CAPACITY}`,
  );
  const schema = stressSchema();

  // ── The Stage-3 wiring under test: allocate via connectFanIn, mount consumer.
  const topo = connectFanIn({
    schema,
    producerCount: NPROD,
    capacity: CAPACITY,
    environment: turbo(),
  });
  assertEq(topo.handle.kind, "mpmc", "handle is an mpmc fan-in handle");
  assertEq(topo.handle.producerCount, NPROD, "handle carried producerCount");
  assertEq(topo.handle.capacity, CAPACITY, "handle capacity == requested override");
  assertEq(topo.handle.sizing.usableDepth, CAPACITY - (NPROD - 1), "usableDepth = cap − slack");
  const ring = topo.mount({ role: "consumer", schema });

  // Element offsets within a frame, from the real compiled layout (handle side).
  const layout = topo.handle.layout;
  assertEq(layout.fields.checksum!.kind, "f64", "checksum is f64");
  assertEq(layout.fields.fill!.kind, "f64", "fill is f64");
  assertEq(layout.fields.producerId!.kind, "u32", "producerId is u32");
  assertEq(layout.fields.seq!.kind, "u32", "seq is u32");
  const off = {
    checksum: layout.fields.checksum!.byteOffset / 8,
    fill: layout.fields.fill!.byteOffset / 8,
    producerId: layout.fields.producerId!.byteOffset / 4,
    seq: layout.fields.seq!.byteOffset / 4,
  };

  const frameByteSize = schema.frameByteSize;
  const genByteOffset = MPMC_HEADER_BYTES;
  const payloadByteOffset = MPMC_HEADER_BYTES + ((CAPACITY * 4 + 7) & ~7);
  const payloadBytes = CAPACITY * frameByteSize;

  let workerError: unknown = null;
  let done = 0;
  let totalPushed = 0;
  const workers: Worker[] = [];
  for (let p = 0; p < NPROD; p++) {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab: topo.handle.sab, // ← the SAB connectFanIn allocated + initialized.
        capacity: CAPACITY,
        slack: NPROD - 1,
        producerId: p,
        count: COUNT,
        n: STRESS_N,
        genByteOffset,
        payloadByteOffset,
        payloadBytes,
        frameF64: frameByteSize / 8,
        frameU32: frameByteSize / 4,
        off,
      },
    });
    w.on("message", (m: { pushedOk: number }) => { done++; totalPushed += m.pushedOk; });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  const out = ring.createFrame() as Record<string, unknown>;
  const lastSeq = new Array<number>(NPROD).fill(-1);
  let consumed = 0;
  const start = Date.now();
  const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

  const verify = (): void => {
    const pid = out.producerId as number;
    const seq = out.seq as number;
    assert(pid >= 0 && pid < NPROD, `frame producerId in range (got ${pid})`);
    assert(seq > lastSeq[pid]!, `FIFO-per-producer: pid ${pid} seq ${seq} > last ${lastSeq[pid]}`);
    lastSeq[pid] = seq;
    const fillArr = out.fill as Float64Array;
    for (let i = 0; i < STRESS_N; i++) {
      if (fillArr[i] !== fillValue(pid, seq, i)) {
        throw new Error(
          `TORN/WRONG fill pid=${pid} seq=${seq} i=${i}: got ${fillArr[i]} want ${fillValue(pid, seq, i)}`,
        );
      }
    }
    const expCk = checksumOf(pid, seq, STRESS_N);
    if ((out.checksum as number) !== expCk) {
      throw new Error(`checksum mismatch pid=${pid} seq=${seq}: got ${out.checksum} want ${expCk}`);
    }
    consumed++;
  };

  for (;;) {
    let n = 0;
    while (ring.pull(out as never)) {
      verify();
      if (++n >= BATCH) break;
    }
    if (workerError) break;
    if (done === NPROD && ring.available() === 0) break;
    if (Date.now() - start > WATCHDOG_MS) {
      throw new Error(
        `DEADLOCK watchdog: ${Date.now() - start}ms, consumed=${consumed}, available=${ring.available()}, done=${done}`,
      );
    }
    await yieldMacrotask();
  }
  while (ring.pull(out as never)) verify();

  await Promise.all(workers.map((w) => w.terminate()));
  assert(!workerError, `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`);

  const attempted = NPROD * COUNT;
  const dropped = ring.droppedFrames();
  console.log(
    `  consumed=${consumed} pushedOk=${totalPushed} dropped=${dropped} attempted=${attempted} ` +
      `overrunLost=${ring.overrunLostFrames()} torn=${ring.tornFrameCount()}`,
  );

  assertEq(consumed, totalPushed, "every successfully-pushed frame was consumed");
  assertEq(consumed + dropped, attempted, "conservation: consumed + dropped === attempted");
  assertEq(ring.overrunLostFrames(), 0, "envelope held: zero overrun loss");
  assertEq(ring.tornFrameCount(), 0, "zero torn frames under real parallelism");
  assert(consumed > 0, "consumer actually received frames");

  console.log(`\nconnectFanIn.concurrent: OK (${consumed} frames verified bit-exact through the wiring).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
