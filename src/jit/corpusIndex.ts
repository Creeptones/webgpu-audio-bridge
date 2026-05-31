/**
 * corpusIndex — the offline "sounds-like" corpus index
 * (Apollo Frontier 6, quick-win #3).
 *
 * Batch-characterize a set of kernels, cluster them by fingerprint, and export one
 * representative ("prototype") per cluster — a vetted, deduplicated seed set for the
 * eventual Stage-3b model (and a ready-made palette for a human). It is the natural
 * consumer of quick-win #2's `fingerprintDistance`: characterize → cluster → prototypes.
 *
 *   characterizeCorpus(items, toKernel)  → { entries, rejected }   (acousticGate each)
 *   clusterByFingerprint(entries, radius) → clusters               (leader clustering)
 *   buildCorpusIndex(items, toKernel, …)  → { entries, clusters, rejected }
 *   corpusPrototypes(index)               → the cluster medoids
 *
 * ─── Offline ONLY ───────────────────────────────────────────────────────────────
 *
 * This walks (potentially) thousands of kernels and runs an FFT per kernel via
 * `acousticGate` → `evalReference` (O(N log N), no wasm). That is cheap per kernel but
 * is BUILD/WORKER-time tooling — never call it from `process()`. Like the rest of gate
 * #3 it is pure + deterministic (no clock, no randomness, no wasm), so a corpus built
 * from the same inputs is byte-reproducible and pinnable.
 *
 * ─── Soundness (inherited from the fingerprint) ──────────────────────────────────
 *
 * Clustering groups kernels that SOUND alike on the probe — it is NOT a proof they
 * compute the same function (see `fingerprint.ts`: a clipper and a gain cluster
 * together on a non-clipping probe). A prototype is a representative SOUND, not a
 * canonical implementation; the sound behavioral identity stays `kernelHash`. Use the
 * index to seed/curate exploration, not to silently substitute one kernel for another.
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`.
 */

import { type IrKernel } from "./ir.js";
import {
  acousticGate, type AcousticProfile, type AcousticGateOptions,
} from "./acousticGate.js";
import { fingerprintDistance } from "./fingerprint.js";

/** One characterized member of the corpus: its source identity + the acoustic profile
 *  gate #3 produced. `T` is whatever you indexed (a token stream, an IR, an id, …). */
export interface CorpusEntry<T> {
  readonly item: T;
  readonly profile: AcousticProfile;
}

/** An item that could not be characterized: a `toKernel` throw (e.g. an invalid token
 *  stream) or an acoustic-gate rejection (non-finite / runaway). Carried, never thrown. */
export interface CorpusRejection<T> {
  readonly item: T;
  readonly reason: string;
}

/** A cluster of same-sounding entries. */
export interface CorpusCluster<T> {
  /** The medoid — the member minimizing total fingerprint distance to the rest of the
   *  cluster (the most central / representative sound). Ties → lowest input index. */
  readonly prototype: CorpusEntry<T>;
  /** Every member (including the prototype), in input order. */
  readonly members: ReadonlyArray<CorpusEntry<T>>;
  /** The realized tightness: the max fingerprint distance from the prototype to any
   *  member. Descriptive — it can differ from the assignment `radius` because members
   *  are admitted by distance to the cluster's SEED (leader), then the prototype is
   *  re-chosen as the medoid. */
  readonly radius: number;
}

/** The offline index: the accepted+characterized entries, their clusters, and the
 *  items that could not be characterized. Nothing is thrown — rejection is a value. */
export interface CorpusIndex<T> {
  readonly entries: ReadonlyArray<CorpusEntry<T>>;
  readonly clusters: ReadonlyArray<CorpusCluster<T>>;
  readonly rejected: ReadonlyArray<CorpusRejection<T>>;
}

/**
 * Characterize a set of items: map each to its `IrKernel` via `toKernel`, run gate #3
 * (`acousticGate`), and split into accepted `entries` (with the profile) and `rejected`
 * (a `toKernel` throw or a gate rejection, with its reason). Order-preserving; pure +
 * deterministic (no wasm). Pass `acoustic` to tune the probe / bounds.
 */
export function characterizeCorpus<T>(
  items: ReadonlyArray<T>,
  toKernel: (item: T) => IrKernel,
  acoustic?: AcousticGateOptions,
): { entries: CorpusEntry<T>[]; rejected: CorpusRejection<T>[] } {
  const entries: CorpusEntry<T>[] = [];
  const rejected: CorpusRejection<T>[] = [];
  for (const item of items) {
    let ir: IrKernel;
    try {
      ir = toKernel(item);
    } catch (err) {
      rejected.push({ item, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const r = acousticGate(ir, acoustic);
    if (r.ok) entries.push({ item, profile: r.profile });
    else rejected.push({ item, reason: r.reason });
  }
  return { entries, rejected };
}

/**
 * Cluster characterized entries by fingerprint distance (leader clustering): walk the
 * entries in order; assign each to the first existing cluster whose SEED (its first,
 * leader member) is within `radius`, else open a new cluster seeded by this entry. Then
 * re-choose each cluster's `prototype` as its medoid and report the realized `radius`.
 *
 * Deterministic given input order. `radius = 0` groups only byte-identical fingerprints
 * (exact dedup-by-sound). Larger radii fold audibly-similar kernels together. The
 * magnitude vectors are L1-normalized, so distances live in `[0, √2]`.
 */
export function clusterByFingerprint<T>(
  entries: ReadonlyArray<CorpusEntry<T>>,
  radius: number,
): CorpusCluster<T>[] {
  if (radius < 0) throw new Error(`clusterByFingerprint: radius must be ≥ 0, got ${radius}`);

  // Leader pass: each cluster is seeded by its first member; admit by distance to seed.
  const groups: CorpusEntry<T>[][] = [];
  for (const entry of entries) {
    let placed = false;
    for (const g of groups) {
      if (fingerprintDistance(entry.profile, g[0]!.profile) <= radius) {
        g.push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([entry]);
  }

  // Finalize: medoid prototype + realized radius per cluster.
  return groups.map((members) => {
    let bestIdx = 0;
    let bestSum = Infinity;
    for (let i = 0; i < members.length; i++) {
      let sum = 0;
      for (let j = 0; j < members.length; j++) {
        if (i !== j) sum += fingerprintDistance(members[i]!.profile, members[j]!.profile);
      }
      if (sum < bestSum) { bestSum = sum; bestIdx = i; }
    }
    const prototype = members[bestIdx]!;
    let realized = 0;
    for (const m of members) {
      const d = fingerprintDistance(prototype.profile, m.profile);
      if (d > realized) realized = d;
    }
    return { prototype, members, radius: realized };
  });
}

/** Options for `buildCorpusIndex`. */
export interface BuildCorpusIndexOptions {
  /** Cluster radius (fingerprint distance). Default 0 — group only identical sounds
   *  (exact dedup). Raise it to fold audibly-similar kernels into one prototype. */
  readonly radius?: number;
  /** Tuning forwarded to `acousticGate` (the probe + sane bounds + `fingerprintBands`). */
  readonly acoustic?: AcousticGateOptions;
}

/**
 * One call: `characterizeCorpus` then `clusterByFingerprint`. The cluster prototypes
 * (`corpusPrototypes(index)`) are your deduplicated, vetted seed set. Pure + offline.
 */
export function buildCorpusIndex<T>(
  items: ReadonlyArray<T>,
  toKernel: (item: T) => IrKernel,
  opts: BuildCorpusIndexOptions = {},
): CorpusIndex<T> {
  const { entries, rejected } = characterizeCorpus(items, toKernel, opts.acoustic);
  const clusters = clusterByFingerprint(entries, opts.radius ?? 0);
  return { entries, clusters, rejected };
}

/** The cluster medoids — the representative-sound seed set, in cluster order. */
export function corpusPrototypes<T>(index: CorpusIndex<T>): CorpusEntry<T>[] {
  return index.clusters.map((c) => c.prototype);
}
