/**
 * Bridge — push/pull microbenchmark.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/Bridge.bench.ts
 *
 * Companion to bench/Float64RingBuffer.bench.ts. Same loop shape, same iter
 * counts, same hard budget — measures the schema-driven path on a schema with
 * the same physical layout as the legacy ring (physicsControlFrameSchema(N))
 * so that "Bridge vs Float64RingBuffer" is an apples-to-apples comparison of
 * the per-field-closure dispatch overhead.
 *
 * The plan budgets ~50-150ns extra per op for the closure dispatch (one
 * scalar writer/reader per scalar field, indexed-loop call), measured against
 * the ~1.1μs Atomics.notify-dominated baseline. The hard ceiling
 * HARD_BUDGET_NS = 10μs catches catastrophic regressions; anything between
 * the Float64RingBuffer median and the ceiling is acceptable for the schema
 * path (users wanting peak perf on the legacy shape still have
 * Float64RingBuffer exported).
 *
 * 0.4.0 perf note. The counter representation switched from BigInt64 to Int32
 * wrap (see src/Bridge.ts "Counter representation" section). At N=1000 the
 * per-op cost is dominated by the payload memcpy, so the median is unchanged.
 * The win lives in the isolated atomic path: pure load+store+notify is ~100ns
 * on i32 vs ~160ns on BigInt — ringbuf.js-class. End-to-end push by N:
 *   N=1    (48 B):    100 ns    (atomic-only floor — ringbuf.js territory)
 *   N=4   (96 B):    200 ns
 *   N=64  (1056 B):  200 ns
 *   N=256 (4128 B):  400 ns
 *   N=1000 (16032 B): 1100 ns   (memcpy-bound, atomics invisible)
 * Users on small-payload schemas (control signals, scalar streams) get the
 * full win; users on the legacy macro-physics shape see no change but pay
 * less BigInt boxing cost on V8.
 */

import { hrtime } from "node:process";
import { Bridge } from "../src/Bridge.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";
import type { FrameFor } from "../src/schema.js";

const N = 1000;
const CAPACITY = 16;
const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return NaN;
  const idx = Math.min(
    sortedNs.length - 1,
    Math.max(0, Math.floor(sortedNs.length * p)),
  );
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

function makeFrame(): PhysFrame {
  const vEff = new Float64Array(N);
  const jEff = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  return { seq: 0n, tMacroNs: 0n, vMax: 1, jMax: 1, vEff, jEff };
}

function makeOutFrame(): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(N),
    jEff: new Float64Array(N),
  };
}

function runPushBench(): { samples: number[]; rejects: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pull(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let rejects = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    const t0 = hrtime.bigint();
    const okPush = ring.push(frame);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPush) rejects++;
    ring.pull(out);
  }
  return { samples, rejects };
}

function runPullBench(): { samples: number[]; misses: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pull(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    const t0 = hrtime.bigint();
    const okPull = ring.pull(out);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPull) misses++;
  }
  return { samples, misses };
}

function runPullLatestBench(): { samples: number[]; misses: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pullLatest(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    const t0 = hrtime.bigint();
    const skipped = ring.pullLatest(out);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (skipped < 0) misses++;
  }
  return { samples, misses };
}

function summarize(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const med = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1]!;
  const avg = mean(samples);
  console.log(
    `  ${label.padEnd(14)} median=${fmt(med).padStart(8)}  ` +
      `p99=${fmt(p99).padStart(8)}  max=${fmt(max).padStart(10)}  ` +
      `mean=${fmt(avg).padStart(8)}`,
  );
  return med;
}

function main(): void {
  const schema = physicsControlFrameSchema(N);
  console.log(
    `Bridge bench  (schema=physicsControlFrameSchema(${N}), CAPACITY=${CAPACITY}, ` +
      `frameBytes=${schema.frameByteSize}, iterations=${MEASURE_ITERS.toLocaleString()})`,
  );
  console.log();
  const pushResult = runPushBench();
  const pushMed = summarize("push", pushResult.samples);
  const pullResult = runPullBench();
  const pullMed = summarize("pull", pullResult.samples);
  const pullLatestResult = runPullLatestBench();
  const pullLatestMed = summarize("pullLatest", pullLatestResult.samples);
  console.log();
  console.log(
    `  push rejects=${pushResult.rejects} ` +
      `pull misses=${pullResult.misses} ` +
      `pullLatest misses=${pullLatestResult.misses}`,
  );
  console.log();

  // Per the plan: schema dispatch costs ~50-150ns/op on top of the
  // Float64RingBuffer baseline. The acceptance gate is the hard budget; the
  // per-op number is for hardware comparison.
  const meds = { push: pushMed, pull: pullMed, pullLatest: pullLatestMed };
  for (const [name, med] of Object.entries(meds)) {
    if (med < HARD_BUDGET_NS) {
      console.log(`  within hard budget  ${name} median ${fmt(med)} < ${fmt(HARD_BUDGET_NS)}`);
    } else {
      console.error(
        `  FAIL                ${name} median ${fmt(med)} ≥ hard budget ${fmt(HARD_BUDGET_NS)}`,
      );
      process.exitCode = 1;
    }
  }
}

main();
