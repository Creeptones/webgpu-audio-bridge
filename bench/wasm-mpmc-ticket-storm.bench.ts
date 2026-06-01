/**
 * WASM MPMC ticket-storm probe.
 *
 * Fixed-duration producer/consumer contention benchmark for the two hot ticket
 * lanes only. This isolates the cache-line-padding question from payload copy,
 * generation stamps, capacity drops, and teardown strands.
 */

import { Worker } from "node:worker_threads";
import wabtInit from "wabt";
import { emitWasmMpmc } from "../src/emitWasmMpmc.js";

const DURATION_MS = 1_500;
const REPEATS = 5;

type LayoutName = "compact" | "padded";

interface Combo {
  readonly producers: number;
  readonly consumers: number;
}

interface Row {
  readonly layout: LayoutName;
  readonly producers: number;
  readonly consumers: number;
  readonly produced: number;
  readonly claimed: number;
  readonly misses: number;
  readonly claimsPerSec: number;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  const control = new Int32Array(workerData.control);
  const header = new Int32Array(workerData.memory.buffer);
  const enqueueLane = workerData.enqueueByteOffset / 4;
  let claimTicket = null;

  if (workerData.role === "consumer") {
    const result = await WebAssembly.instantiate(workerData.wasmBytes, {
      env: { memory: workerData.memory },
    });
    const instance = result.instance || result;
    claimTicket = instance.exports.claim_ticket;
  }

  Atomics.add(control, 2, 1);
  while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);

  let n = 0;
  let miss = 0;
  if (workerData.role === "producer") {
    while (Atomics.load(control, 1) === 0) {
      Atomics.add(header, enqueueLane, 1);
      n++;
    }
  } else {
    while (Atomics.load(control, 1) === 0) {
      if (claimTicket() >= 0) n++;
      else miss++;
    }
  }

  parentPort.postMessage({ role: workerData.role, n, miss });
})().catch((e) => {
  parentPort.postMessage({
    role: workerData.role,
    n: 0,
    miss: 0,
    err: e && e.stack ? e.stack : String(e),
  });
});
`;

function offsets(layout: LayoutName): { enqueue: number; dequeue: number } {
  return layout === "padded"
    ? { enqueue: 0, dequeue: 64 }
    : { enqueue: 0, dequeue: 4 };
}

async function compileClaim(layout: LayoutName): Promise<Uint8Array<ArrayBuffer>> {
  const o = offsets(layout);
  const wabt = await wabtInit();
  const mod = wabt.parseWat(
    `mpmc-${layout}.wat`,
    emitWasmMpmc({
      memoryPages: { min: 1, max: 1 },
      headerOffsets: {
        enqueueTicket: o.enqueue,
        dequeueTicket: o.dequeue,
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

async function runOnce(
  layout: LayoutName,
  combo: Combo,
  wasmBytes: Uint8Array<ArrayBuffer>,
): Promise<Row> {
  const o = offsets(layout);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const controlSab = new SharedArrayBuffer(12);
  const control = new Int32Array(controlSab);
  const workers: Worker[] = [];
  let done = 0;
  let produced = 0;
  let claimed = 0;
  let misses = 0;

  await new Promise<void>((resolve, reject) => {
    const totalWorkers = combo.producers + combo.consumers;
    for (let i = 0; i < totalWorkers; i++) {
      const role = i < combo.producers ? "producer" : "consumer";
      const w = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          role,
          memory,
          control: controlSab,
          wasmBytes,
          enqueueByteOffset: o.enqueue,
        },
      });
      workers.push(w);
      w.on("error", reject);
      w.on("message", (m: { role: string; n: number; miss: number; err?: string }) => {
        if (m.err !== undefined) {
          reject(new Error(m.err));
          return;
        }
        if (m.role === "producer") produced += m.n;
        else {
          claimed += m.n;
          misses += m.miss;
        }
        done++;
        if (done === totalWorkers) resolve();
      });
    }

    const ready = setInterval(() => {
      if (Atomics.load(control, 2) === totalWorkers) {
        clearInterval(ready);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0, totalWorkers);
        setTimeout(() => {
          Atomics.store(control, 1, 1);
        }, DURATION_MS);
      }
    }, 1);
  });

  await Promise.all(workers.map((w) => w.terminate()));
  return {
    layout,
    producers: combo.producers,
    consumers: combo.consumers,
    produced,
    claimed,
    misses,
    claimsPerSec: claimed / (DURATION_MS / 1000),
  };
}

function median(rows: Row[]): Row {
  rows.sort((a, b) => a.claimsPerSec - b.claimsPerSec);
  return rows[Math.floor(rows.length / 2)]!;
}

async function sample(
  layout: LayoutName,
  combo: Combo,
  wasmBytes: Uint8Array<ArrayBuffer>,
): Promise<Row> {
  const rows: Row[] = [];
  for (let r = 0; r < REPEATS; r++) {
    rows.push(await runOnce(layout, combo, wasmBytes));
  }
  return median(rows);
}

async function main(): Promise<void> {
  const wasmByLayout = {
    compact: await compileClaim("compact"),
    padded: await compileClaim("padded"),
  };
  const combos: Combo[] = [
    { producers: 2, consumers: 2 },
    { producers: 4, consumers: 2 },
    { producers: 2, consumers: 4 },
  ];

  console.log(
    `WASM MPMC ticket storm (duration=${DURATION_MS} ms, repeats=${REPEATS})`,
  );
  for (const combo of combos) {
    const compact = await sample("compact", combo, wasmByLayout.compact);
    const padded = await sample("padded", combo, wasmByLayout.padded);
    for (const row of [compact, padded]) {
      console.log(
        `  ${row.layout.toUpperCase().padEnd(7)} P=${row.producers} M=${row.consumers} ` +
          `claims=${row.claimed.toLocaleString().padStart(10)} ` +
          `produced=${row.produced.toLocaleString().padStart(10)} ` +
          `miss=${row.misses.toLocaleString().padStart(10)} ` +
          `${(row.claimsPerSec / 1e6).toFixed(2).padStart(5)} M/s`,
      );
    }
    console.log(
      `  delta PADDED vs COMPACT P=${combo.producers} M=${combo.consumers}: ` +
        `${((padded.claimsPerSec / compact.claimsPerSec - 1) * 100).toFixed(1)}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
