/**
 * Shared schema + deterministic payload helpers for the MpmcRing cross-thread
 * stress (tests/MpmcRing.concurrent.test.ts + tests/_mpmcStress.worker.ts).
 *
 * Both the producer workers and the consumer import these so the bytes a
 * producer writes and the bytes the consumer recomputes are produced by the
 * IDENTICAL float operations in the IDENTICAL order — any mismatch is then a
 * genuine torn / wrong / reordered frame, not a recomputation artifact.
 */

import { defineSchema, u32, f64, f64Array } from "../src/index.js";

/** Logical samples in the fill array per frame. */
export const STRESS_N = 8;

export function stressSchema() {
  return defineSchema({
    producerId: u32(),
    seq: u32(),
    checksum: f64(),
    fill: f64Array(STRESS_N),
  });
}

export type StressSchema = ReturnType<typeof stressSchema>;

/** Deterministic fill element for (producerId, seq, i). Pure float arithmetic;
 *  the producer stores exactly this and the consumer recomputes exactly this. */
export function fillValue(pid: number, seq: number, i: number): number {
  return pid * 1000003 + seq * 7 + i * 0.25;
}

/** Per-frame checksum, summed in a fixed order so both sides agree bit-for-bit. */
export function checksumOf(pid: number, seq: number, n: number): number {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < n; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}
