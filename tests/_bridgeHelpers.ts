/**
 * Shared helpers for the Bridge.*.test.ts feature-file family.
 *
 * Extracted from tests/Bridge.test.ts in 0.8.5 when the 92-pin single-
 * file suite was split into 8 feature files (core / smoother / observability
 * / invariant / pll / trajectory / backpressure / facades). Each split file
 * imports the helpers it needs from this module so the per-file scope stays
 * minimal.
 *
 * Naming follows the `_assert.ts` precedent — leading underscore signals
 * "shared helper, not a runnable test file."
 */

import { defineSchema, f64Array, u64, type FrameFor } from "../src/schema.js";
import { assert } from "./_assert.js";
import type { PhysicsControlFrameSchema } from "../src/schemas/physics.js";

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

/** Make a deterministic frame keyed by seq so equality is unambiguous. */
export function makePhysFrame(seq: number, n: number): PhysFrame {
  const vEff = new Float64Array(n);
  const jEff = new Float64Array(n);
  let vMax = 0;
  let jMax = 0;
  for (let k = 0; k < n; k++) {
    vEff[k] = seq + k * 0.001;
    jEff[k] = -seq + k * 0.001;
    if (Math.abs(vEff[k]!) > vMax) vMax = Math.abs(vEff[k]!);
    if (Math.abs(jEff[k]!) > jMax) jMax = Math.abs(jEff[k]!);
  }
  return {
    seq: BigInt(seq),
    tMacroNs: BigInt(seq) * 16_666_667n,
    vMax,
    jMax,
    vEff,
    jEff,
  };
}

export function emptyPhysFrame(n: number): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(n),
    jEff: new Float64Array(n),
  };
}

export function framesEqual(expected: PhysFrame, got: PhysFrame): boolean {
  if (expected.seq !== got.seq) return false;
  if (expected.tMacroNs !== got.tMacroNs) return false;
  if (expected.vMax !== got.vMax) return false;
  if (expected.jMax !== got.jMax) return false;
  if (expected.vEff.length !== got.vEff.length) return false;
  for (let k = 0; k < expected.vEff.length; k++) {
    if (expected.vEff[k] !== got.vEff[k]) return false;
    if (expected.jEff[k] !== got.jEff[k]) return false;
  }
  return true;
}

/**
 * Small invariant schema for the invariant-classifier pin block: seq:u64 +
 * vEff:f64Array(4) + hidden __invariant:f64. The invariant is the
 * sum-of-squares of vEff (canonical Σ|f|² norm). With this layout:
 *   seq         at byteOffset 0      (8B)
 *   vEff[0..4]  at byteOffset 8      (32B)   userEnd raw = 40
 *   __invariant at byteOffset 40     (8B)
 *   frameByteSize = 48 (= userEnd + 8)
 * In Float64 element units (stride8 = 6): seq at f64-off 0, vEff[k] at
 * f64-off 1+k, __invariant at f64-off 5. Used by the SAB-mutation pins and
 * by the softFrames / stallRecoveries observability pins that share the
 * same fixture.
 */
export function makeInvariantSchema() {
  return defineSchema({
    seq: u64(),
    vEff: f64Array(4),
  }).withInvariant((frame) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += frame.vEff[k]! * frame.vEff[k]!;
    return s;
  });
}

export type InvFrame = FrameFor<ReturnType<typeof makeInvariantSchema>>;

export function makeInvFrame(seq: number, vEff: number[]): InvFrame {
  assert(vEff.length === 4, "invariant test helper: vEff must be length 4");
  return { seq: BigInt(seq), vEff: new Float64Array(vEff) };
}

export function emptyInvFrame(): InvFrame {
  return { seq: 0n, vEff: new Float64Array(4) };
}
