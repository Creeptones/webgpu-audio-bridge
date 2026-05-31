/**
 * JIT fuzz corpus — deterministic inputs for the equivalence gate
 * (Apollo Frontier 5, Stage 1a).
 *
 * The gate is only as strong as the inputs it checks, so the corpus is built to
 * hit exactly the places a wrong lowering hides (the Stage-0 proof's lemmas):
 *   - every IEEE edge class (0, -0, ±Inf, NaN, denormals, ±MAX, ±1, ±0.5, …) at
 *     every lane position, AND
 *   - every loop-tail residue `n mod W` (so the SIMD-body/scalar-epilogue
 *     partition — Lemma 6 — is exercised on both sides of the seam), AND
 *   - seeded-random wide-dynamic-range fills.
 *
 * Fully deterministic — a seeded LCG, NO Math.random / Date.now — so the gate's
 * verdict is reproducible (same source ⇒ same corpus ⇒ same accept/reject).
 */

import { type KernelSignature, type LaneWidth, paramsByRole, signatureWidth } from "./ir.js";

export interface CorpusCase {
  readonly n: number;
  readonly arrays: Record<string, number[]>; // one row per INPUT array
  readonly scalars: Record<string, number>;
}

const EDGE = [
  0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3,
  Math.PI, Math.E,
  Infinity, -Infinity, NaN,
  Number.MIN_VALUE, 5e-324, -5e-324,
  Number.MAX_VALUE, -Number.MAX_VALUE,
  1 + Number.EPSILON, 1 - Number.EPSILON / 2,
  8388609, // 2^23 + 1 (f32 rounding boundary)
];

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The n-values the corpus sweeps — covers every residue mod 4 and mod 2 plus
 *  a couple of larger blocks (the SIMD body must run several full chunks). */
export const CORPUS_N_VALUES: ReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 63, 64];

export interface CorpusOptions {
  readonly nValues?: ReadonlyArray<number>;
  readonly randomFills?: number; // random rows per n (in addition to the edge row)
  readonly seed?: number;
}

/** Build all corpus cases for a signature. The output arrays are NOT part of a
 *  case (the gate allocates + zeroes them); only INPUT arrays + scalars are. */
export function buildCorpus(sig: KernelSignature, opts: CorpusOptions = {}): CorpusCase[] {
  const nValues = opts.nValues ?? CORPUS_N_VALUES;
  const randomFills = opts.randomFills ?? 3;
  const rng = makeRng(opts.seed ?? 0xc0ffee);
  const inputs = paramsByRole(sig, "input").map((p) => p.name);
  const scalars = paramsByRole(sig, "scalar").map((p) => p.name);
  const cases: CorpusCase[] = [];

  for (const n of nValues) {
    for (let f = 0; f <= randomFills; f++) {
      const arrays: Record<string, number[]> = {};
      for (let a = 0; a < inputs.length; a++) {
        arrays[inputs[a]!] = fillArray(n, f, a, rng);
      }
      const sc: Record<string, number> = {};
      for (let s = 0; s < scalars.length; s++) {
        sc[scalars[s]!] = f === 0 ? EDGE[(s * 5 + 3) % EDGE.length]! : (rng() - 0.5) * 16;
      }
      cases.push({ n, arrays, scalars: sc });
    }
  }
  return cases;
}

function fillArray(n: number, fill: number, arrIdx: number, rng: () => number): number[] {
  const a = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (fill === 0) {
      a[i] = EDGE[(i + arrIdx * 7) % EDGE.length]!; // dense edge sweep
    } else {
      const r = rng();
      a[i] = r < 0.12
        ? EDGE[(rng() * EDGE.length) | 0]!
        : (rng() - 0.5) * Math.pow(2, ((rng() * 80) | 0) - 40);
    }
  }
  return a;
}

export { signatureWidth };
export type { LaneWidth };
