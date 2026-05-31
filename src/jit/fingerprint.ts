/**
 * fingerprint — "sounds-like" queries over the acoustic fingerprint
 * (Apollo Frontier 6, quick-win #2).
 *
 * Gate #3 (`acousticGate.ts`) attaches an `AcousticProfile` to every characterized
 * kernel. Its `magnitude` field is a small, L1-normalized band vector that is
 * AMPLITUDE-INVARIANT by construction (a gain change leaves it unchanged), so it is a
 * genuine "sounds-like" embedding — two kernels with the same spectral shape have the
 * same vector regardless of level. This module turns that embedding into the obvious
 * queries:
 *
 *   • `fingerprintDistance(a, b)`  — Euclidean (L2) distance over the magnitude
 *      vectors. A proper metric (identity / symmetry / triangle), so it composes.
 *   • `nearestByFingerprint(target, candidates)` — the nearest-sounding candidate.
 *   • `dedupByFingerprint(items, ε)` — collapse near-identical-sounding kernels
 *      (greedy: keep the first of each ε-cluster). Kills "same sound, different
 *      spelling" duplicates a generative emitter produces.
 *   • `sortByBrightness` / `brighterThan` / `darkerThan` — move along the
 *      `spectralCentroid` axis (a 1-D timbre coordinate: low = dark, high = bright).
 *
 * Pure + deterministic (no wasm, no clock, no randomness) — the profile was already
 * produced by `evalReference`, so every query here is plain vector math. The helpers
 * read only the minimal `FingerprintLike` shape (`{ magnitude, spectralCentroid? }`),
 * which every `AcousticProfile` — and thus every `CharacterizedKernel.acoustic` —
 * satisfies, so you can pass a kernel's `.acoustic` directly.
 *
 * ─── SOUNDNESS: a "sounds-like" heuristic, NOT an equivalence proof ───────────────
 *
 * `fingerprintDistance(a, b) === 0` means a and b sound identical *on the probe* — it
 * is NOT a proof they compute the same function. The fingerprint is amplitude-invariant
 * and reads a SINGLE deterministic probe (a full-scale sine), so two kernels can match
 * here yet diverge everywhere else: a hard-clipper and a linear gain are identical on a
 * probe that never exceeds the clip threshold, but differ the instant a signal does. So
 * use these queries to **cull** redundant generative candidates and to **order/search**
 * by timbre — NEVER to substitute one kernel for another in a signal path. The sound
 * behavioral identity remains the structural content address (`kernelHash` / `kernelKey`
 * in `kernelGrammar.ts`): equal IR ⇒ provably equal computation. Fingerprint distance is
 * the cheap "probably worth a closer look / probably redundant" prior; the hash is truth.
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`.
 */

/** The minimal shape the fingerprint helpers read. Every `AcousticProfile` (and so
 *  every `CharacterizedKernel.acoustic`) satisfies it; a bare `{ magnitude }` literal
 *  does too (handy for tests). `spectralCentroid` is required only by the brightness
 *  helpers. */
export interface FingerprintLike {
  /** The L1-normalized, amplitude-invariant band vector — the "sounds-like" embedding. */
  readonly magnitude: ReadonlyArray<number>;
  /** The 1-D timbre coordinate in [0,1] (low = dark, high = bright). Optional here;
   *  the brightness helpers require it. */
  readonly spectralCentroid?: number;
}

/** A match against a candidate list: the item, its index in that list, and its
 *  distance from the query (L2 over magnitude for nearest-neighbour; |Δcentroid| for
 *  the brightness helpers — always ≥ 0). */
export interface FingerprintMatch<T> {
  readonly item: T;
  readonly index: number;
  readonly distance: number;
}

/**
 * Euclidean (L2) distance between two magnitude fingerprints. Both vectors are
 * L1-normalized band energies, so this is a bounded, amplitude-invariant "how
 * differently do these sound" scalar (0 = identical shape). A proper metric:
 * `d(a,a)=0`, `d(a,b)=d(b,a)`, and the triangle inequality hold.
 *
 * Throws on a band-count mismatch — comparing fingerprints of different resolutions is
 * a programming error (build them with the same `fingerprintBands`).
 */
export function fingerprintDistance(a: FingerprintLike, b: FingerprintLike): number {
  const u = a.magnitude;
  const v = b.magnitude;
  if (u.length !== v.length) {
    throw new Error(`fingerprintDistance: band-count mismatch (${u.length} vs ${v.length})`);
  }
  let sum = 0;
  for (let i = 0; i < u.length; i++) {
    const d = u[i]! - v[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * The nearest-sounding candidate to `target` by `fingerprintDistance`, or `undefined`
 * if `candidates` is empty. Ties resolve to the lowest index (a stable, deterministic
 * pick). The target may itself appear in `candidates` (it returns at distance 0); pass
 * a filtered list if you want to exclude it.
 */
export function nearestByFingerprint<T extends FingerprintLike>(
  target: FingerprintLike,
  candidates: ReadonlyArray<T>,
): FingerprintMatch<T> | undefined {
  let best: FingerprintMatch<T> | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const distance = fingerprintDistance(target, candidates[i]!);
    if (best === undefined || distance < best.distance) {
      best = { item: candidates[i]!, index: i, distance };
    }
  }
  return best;
}

/**
 * Collapse near-identical-sounding items: greedily keep the first item of each cluster
 * whose members are all within `epsilon` (L2 fingerprint distance) of a kept
 * representative. Order-preserving — the kept items appear in their original order.
 * `epsilon` defaults to 0 (collapse only byte-identical fingerprints; deterministic
 * kernels with the same spectral shape produce the same vector). Raise it to fold
 * "audibly the same" variants together.
 */
export function dedupByFingerprint<T extends FingerprintLike>(
  items: ReadonlyArray<T>,
  epsilon = 0,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const dup = kept.some((k) => fingerprintDistance(item, k) <= epsilon);
    if (!dup) kept.push(item);
  }
  return kept;
}

// ── brightness (the spectralCentroid axis) ──────────────────────────────────────

function centroidOf(x: FingerprintLike, where: string): number {
  if (x.spectralCentroid === undefined) {
    throw new Error(`${where}: item is missing spectralCentroid (the brightness coordinate)`);
  }
  return x.spectralCentroid;
}

/** Items sorted dark→bright by `spectralCentroid` (ascending). Stable — equal-centroid
 *  items keep their original order. Does not mutate the input. */
export function sortByBrightness<T extends FingerprintLike>(items: ReadonlyArray<T>): T[] {
  return items
    .map((item, index) => ({ item, index, c: centroidOf(item, "sortByBrightness") }))
    .sort((p, q) => p.c - q.c || p.index - q.index)
    .map((p) => p.item);
}

/**
 * The nearest item STRICTLY brighter than `reference` (smallest `spectralCentroid`
 * still greater than the reference's) — one timbre step toward bright — or `undefined`
 * if none is brighter. `distance` is the centroid gap. Ties resolve to the lowest index.
 */
export function brighterThan<T extends FingerprintLike>(
  reference: FingerprintLike,
  candidates: ReadonlyArray<T>,
): FingerprintMatch<T> | undefined {
  const ref = centroidOf(reference, "brighterThan");
  let best: FingerprintMatch<T> | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const c = centroidOf(candidates[i]!, "brighterThan");
    if (c > ref && (best === undefined || c - ref < best.distance)) {
      best = { item: candidates[i]!, index: i, distance: c - ref };
    }
  }
  return best;
}

/**
 * The nearest item STRICTLY darker than `reference` (largest `spectralCentroid` still
 * less than the reference's) — one timbre step toward dark — or `undefined` if none is
 * darker. `distance` is the centroid gap. Ties resolve to the lowest index.
 */
export function darkerThan<T extends FingerprintLike>(
  reference: FingerprintLike,
  candidates: ReadonlyArray<T>,
): FingerprintMatch<T> | undefined {
  const ref = centroidOf(reference, "darkerThan");
  let best: FingerprintMatch<T> | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const c = centroidOf(candidates[i]!, "darkerThan");
    if (c < ref && (best === undefined || ref - c < best.distance)) {
      best = { item: candidates[i]!, index: i, distance: ref - c };
    }
  }
  return best;
}
