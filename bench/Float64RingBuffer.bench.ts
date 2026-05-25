/**
 * Float64RingBuffer — push/pull microbenchmark.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/Float64RingBuffer.bench.ts
 *
 * Target history:
 *   - 0.1.x had no park/wake protocol — push was just a release-store + non-
 *     atomic payload writes. Single-thread median sat around ~150–200 ns/op.
 *   - 0.2.0 adds the always-notify wait/wake protocol (see the "Park / wake
 *     protocol" section in src/Float64RingBuffer.ts). Every push and every
 *     pull now pays an unconditional Atomics.notify syscall. On Windows +
 *     V8 that's ~1 μs per call even with zero waiters parked, so the new
 *     floor for the single-thread bench is ~1.1 μs median, not 200 ns.
 *   - In production this is invisible: 60 Hz push × 1.1 μs = 66 μs/sec
 *     (~0.007 % CPU); 375 Hz pullLatest × 1.1 μs = 412 μs/sec (~0.04 % CPU).
 *     The cost is the price of correct back-pressure under genuine 2-thread
 *     contention — see src/Float64RingBuffer.ts for the full wall-clock
 *     vs CPU-shape tradeoff rationale.
 *
 * This file does NOT fail on slow numbers — perf varies wildly between
 * local and CI hardware. It prints a table and only throws on egregious
 * regression (>10 μs median, suggesting a real bug). HARD_BUDGET_NS is the
 * actual regression gate; the soft `target = 200` line below is the
 * pre-protocol floor, kept as a hardware-comparison marker only.
 */

import { hrtime } from "node:process";
import {
  Float64RingBuffer,
  type RingFrameHeader,
} from "../src/Float64RingBuffer.js";

const N = 1000;
const CAPACITY = 16;
const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;

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

function runPushBench(): { samples: number[]; rejects: number } {
  const { sab } = Float64RingBuffer.allocate(CAPACITY, N);
  const ring = new Float64RingBuffer(sab, CAPACITY, N);
  const vEff = new Float64Array(N);
  const jEff = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  const header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 1, jMax: 1 };
  const outV = new Float64Array(N);
  const outJ = new Float64Array(N);
  const outH: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };

  for (let i = 0; i < WARMUP_ITERS; i++) {
    header.seq = i;
    ring.push(vEff, jEff, header);
    ring.pull(outV, outJ, outH);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let rejects = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    header.seq = i;
    const t0 = hrtime.bigint();
    const okPush = ring.push(vEff, jEff, header);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPush) {
      rejects++;
    }
    ring.pull(outV, outJ, outH);
  }
  return { samples, rejects };
}

function runPullBench(): { samples: number[]; misses: number } {
  const { sab } = Float64RingBuffer.allocate(CAPACITY, N);
  const ring = new Float64RingBuffer(sab, CAPACITY, N);
  const vEff = new Float64Array(N);
  const jEff = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  const header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 1, jMax: 1 };
  const outV = new Float64Array(N);
  const outJ = new Float64Array(N);
  const outH: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };

  for (let i = 0; i < WARMUP_ITERS; i++) {
    header.seq = i;
    ring.push(vEff, jEff, header);
    ring.pull(outV, outJ, outH);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    header.seq = i;
    ring.push(vEff, jEff, header);
    const t0 = hrtime.bigint();
    const okPull = ring.pull(outV, outJ, outH);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPull) {
      misses++;
    }
  }
  return { samples, misses };
}

function runPullLatestBench(): { samples: number[]; misses: number } {
  const { sab } = Float64RingBuffer.allocate(CAPACITY, N);
  const ring = new Float64RingBuffer(sab, CAPACITY, N);
  const vEff = new Float64Array(N);
  const jEff = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  const header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 1, jMax: 1 };
  const outV = new Float64Array(N);
  const outJ = new Float64Array(N);
  const outH: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };

  for (let i = 0; i < WARMUP_ITERS; i++) {
    header.seq = i;
    ring.push(vEff, jEff, header);
    ring.pullLatest(outV, outJ, outH);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    header.seq = i;
    ring.push(vEff, jEff, header);
    const t0 = hrtime.bigint();
    const skipped = ring.pullLatest(outV, outJ, outH);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (skipped < 0) {
      misses++;
    }
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
  console.log(
    `Float64RingBuffer bench  (N=${N}, CAPACITY=${CAPACITY}, ` +
      `frameBytes=${(4 + 2 * N) * 8}, iterations=${MEASURE_ITERS.toLocaleString()})`,
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

  const target = 200;
  const meds = { push: pushMed, pull: pullMed, pullLatest: pullLatestMed };
  for (const [name, med] of Object.entries(meds)) {
    if (med < target) {
      console.log(`  TARGET MET   ${name} median ${fmt(med)} < ${target}ns`);
    } else if (med < HARD_BUDGET_NS) {
      console.log(
        `  over target  ${name} median ${fmt(med)} ≥ ${target}ns (within hard budget ${fmt(HARD_BUDGET_NS)})`,
      );
    } else {
      console.error(
        `  FAIL         ${name} median ${fmt(med)} ≥ hard budget ${fmt(HARD_BUDGET_NS)}`,
      );
      process.exitCode = 1;
    }
  }
}

main();
