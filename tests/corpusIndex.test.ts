/**
 * corpusIndex — quick-win #3 pins (Apollo Frontier 6).
 *
 * The offline "sounds-like" index: batch-characterize kernels (gate #3, no wasm) →
 * cluster by fingerprint distance → export one representative prototype per cluster (a
 * vetted, deduplicated seed set for the eventual Stage-3b model). Builds directly on
 * quick-win #2's `fingerprintDistance`. Pure + deterministic — `acousticGate` rides
 * `evalReference`, so the whole index is byte-reproducible and pinnable.
 *
 * Run: tsx tests/corpusIndex.test.ts
 *
 * Pins
 *  1  characterizeCorpus — accepted kernels become entries (with their profile); a
 *     gate-rejected kernel (×1e9 blowup) and a `toKernel` throw (unknown name) become
 *     rejections with reasons. Nothing thrown.
 *  2  clusterByFingerprint radius 0 — groups only byte-identical sounds: gain / hardclip
 *     / constscale (distance 0, amplitude-invariant) collapse into one cluster; every
 *     distinct spectrum is its own singleton. Prototype is the medoid; radius 0.
 *  3  clusterByFingerprint radius 0.08 — folds the two cubic-soft variants (distance
 *     0.04) into one cluster while keeping them apart from gain (0.10/0.14) and ringmod
 *     (0.57); the realized cluster radius is the medoid→member max; negative radius throws.
 *  4  buildCorpusIndex + corpusPrototypes — one call yields entries/clusters/rejected;
 *     prototypes are one medoid per cluster (each a real member); the index is
 *     deterministic (two builds deep-equal).
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  acousticGate, fingerprintDistance,
  characterizeCorpus, clusterByFingerprint, buildCorpusIndex, corpusPrototypes,
  type LaneWidth,
} from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── IR builders ──────────────────────────────────────────────────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const U = (op: UnaryOp, a: IrNode): IrNode => ({ kind: "unary", op, a });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const pb = (name: string): LoopBound => ({ kind: "param", name });
function K(width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[]): IrKernel {
  return { width, bound, stores, signature: { params, width } };
}

const GAIN = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("x"), S("g")))]);                                   // pure fundamental, level 0.5
const HARDCLIP = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("min", Bn("max", L("x"), C(-1)), C(1)))]);                   // identity on ±1 sine → level 1.0
const CONSTSCALE = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", L("x"), C(0.5)))]);                                   // pure fundamental, level 0.5
const CUBIC = K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(3))))]); // + 3rd harmonic
const CUBIC4 = K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(4))))]); // weaker 3rd harmonic
const RINGMOD = K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], pb("n"),
  [ST("out", Bn("mul", L("a"), L("b")))]);
const RECTIFY = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", U("abs", L("x")), S("g")))]);
const BLOWUP = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", L("x"), C(1e9)))]);                                   // peak-out-of-bounds → gate #3 rejects

// The corpus (IR items; toKernel = identity), with a blowup that gate #3 rejects.
const CORPUS: ReadonlyArray<{ name: string; ir: IrKernel }> = [
  { name: "gain", ir: GAIN }, { name: "hardclip", ir: HARDCLIP }, { name: "constscale", ir: CONSTSCALE },
  { name: "cubic", ir: CUBIC }, { name: "cubic4", ir: CUBIC4 }, { name: "ringmod", ir: RINGMOD },
  { name: "rectify", ir: RECTIFY }, { name: "blowup", ir: BLOWUP },
];
const toKernel = (k: { name: string; ir: IrKernel }): IrKernel => k.ir;
const nameOf = (e: { item: { name: string } }): string => e.item.name;

async function main(): Promise<void> {
  // ── Pin 1: characterizeCorpus (accept / reject split) ─────────────────────
  {
    const { entries, rejected } = characterizeCorpus(CORPUS, toKernel);
    assertEq(entries.length, 7, "characterize: 7 sane kernels accepted");
    assertEq(rejected.length, 1, "characterize: 1 rejected (the blowup)");
    assertEq(rejected[0]!.item.name, "blowup", "characterize: the blowup is the rejection");
    assert(rejected[0]!.reason.startsWith("peak-out-of-bounds"), `characterize: gate reason carried (${rejected[0]!.reason})`);
    // Every accepted entry carries the gate-#3 profile, equal to a standalone run.
    const gain = entries.find((e) => e.item.name === "gain")!;
    assertEq(JSON.stringify(gain.profile), JSON.stringify(acousticGate(GAIN).profile), "characterize: entry profile == standalone gate");

    // A toKernel throw becomes a rejection (not an exception).
    const named = characterizeCorpus(
      [{ name: "gain" }, { name: "__missing__" }],
      (it: { name: string }) => { const f = CORPUS.find((c) => c.name === it.name); if (!f) throw new Error(`unknown kernel ${it.name}`); return f.ir; },
    );
    assertEq(named.entries.length, 1, "characterize: 1 resolved (gain)");
    assertEq(named.rejected.length, 1, "characterize: 1 toKernel-throw rejection");
    assert(named.rejected[0]!.reason.includes("unknown kernel __missing__"), "characterize: the throw message is the reason");

    ok("1 characterizeCorpus splits accepted entries vs gate-rejected + toKernel-throw rejections (no throw)");
  }

  // ── Pin 2: clusterByFingerprint radius 0 (exact dedup-by-sound) ───────────
  {
    const { entries } = characterizeCorpus(CORPUS, toKernel);
    const clusters = clusterByFingerprint(entries, 0);
    assertEq(clusters.length, 5, "radius0: 7 entries → 5 sound-distinct clusters");
    assertEq(clusters.reduce((s, c) => s + c.members.length, 0), 7, "radius0: every entry placed exactly once");

    // The amplitude-invariant trio collapses into one cluster.
    const trio = clusters.find((c) => c.members.length === 3)!;
    assertEq(trio.members.map(nameOf).sort().join(","), "constscale,gain,hardclip", "radius0: gain/hardclip/constscale cluster");
    assertEq(nameOf(trio.prototype), "gain", "radius0: medoid prototype is gain (tie → lowest index)");
    assertEq(trio.radius, 0, "radius0: identical-sound cluster has radius 0");
    assert(trio.members.includes(trio.prototype), "radius0: prototype is a real member");

    // The other four are singletons.
    assertEq(clusters.filter((c) => c.members.length === 1).length, 4, "radius0: cubic/cubic4/ringmod/rectify are singletons");

    ok("2 clusterByFingerprint(radius 0) groups only identical sounds (gain≡hardclip≡constscale), rest singleton");
  }

  // ── Pin 3: clusterByFingerprint radius 0.08 (fold near-identical) ──────────
  {
    const { entries } = characterizeCorpus(CORPUS, toKernel);
    const clusters = clusterByFingerprint(entries, 0.08);
    assertEq(clusters.length, 4, "radius0.08: → 4 clusters (cubic+cubic4 merge)");

    const cu = clusters.find((c) => c.members.map(nameOf).includes("cubic"))!;
    assertEq(cu.members.map(nameOf).sort().join(","), "cubic,cubic4", "radius0.08: cubic+cubic4 fold together");
    assert(!cu.members.map(nameOf).includes("gain"), "radius0.08: gain stays out (0.10 > 0.08)");
    // Realized radius = medoid→member max = the cubic↔cubic4 distance.
    const expected = fingerprintDistance(
      entries.find((e) => e.item.name === "cubic")!.profile,
      entries.find((e) => e.item.name === "cubic4")!.profile,
    );
    assert(Math.abs(cu.radius - expected) < 1e-12, `radius0.08: realized radius is the medoid→member max (${cu.radius} vs ${expected})`);
    assert(cu.radius <= 0.08 + 1e-12, "radius0.08: realized radius within the merge threshold");

    // The trio is still one cluster; ringmod + rectify still singletons.
    assert(clusters.some((c) => c.members.length === 3), "radius0.08: the gain trio survives");

    // A negative radius is a programming error.
    let threw = false;
    try { clusterByFingerprint(entries, -1); } catch { threw = true; }
    assert(threw, "radius0.08: a negative radius throws");

    ok("3 clusterByFingerprint(radius 0.08) folds the cubic variants, keeps gain/ringmod apart, realized radius = medoid max");
  }

  // ── Pin 4: buildCorpusIndex + corpusPrototypes + determinism ──────────────
  {
    const index = buildCorpusIndex(CORPUS, toKernel, { radius: 0.08 });
    assertEq(index.entries.length, 7, "build: 7 entries");
    assertEq(index.rejected.length, 1, "build: 1 rejection (blowup)");
    assertEq(index.clusters.length, 4, "build: 4 clusters at radius 0.08");

    const protos = corpusPrototypes(index);
    assertEq(protos.length, index.clusters.length, "build: one prototype per cluster");
    for (let i = 0; i < protos.length; i++) {
      assert(protos[i] === index.clusters[i]!.prototype, "build: prototype order matches cluster order");
      assert(index.clusters[i]!.members.includes(protos[i]!), "build: every prototype is a real cluster member");
    }
    // The prototype set is deduplicated by sound: distinct prototypes are > radius apart.
    for (let i = 0; i < protos.length; i++) {
      for (let j = i + 1; j < protos.length; j++) {
        assert(fingerprintDistance(protos[i]!.profile, protos[j]!.profile) > 0.08, "build: prototypes are mutually distinct sounds");
      }
    }

    // Determinism: same inputs ⇒ byte-identical index (profiles + clustering pure).
    const index2 = buildCorpusIndex(CORPUS, toKernel, { radius: 0.08 });
    const strip = (ix: typeof index): unknown => ({
      entries: ix.entries.map((e) => ({ name: e.item.name, profile: e.profile })),
      clusters: ix.clusters.map((c) => ({ proto: c.prototype.item.name, members: c.members.map((m) => m.item.name), radius: c.radius })),
      rejected: ix.rejected.map((r) => ({ name: r.item.name, reason: r.reason })),
    });
    assertEq(JSON.stringify(strip(index)), JSON.stringify(strip(index2)), "build: the index is deterministic across runs");

    ok("4 buildCorpusIndex + corpusPrototypes: medoid-per-cluster seed set, mutually distinct, deterministic");
  }

  console.log("\nAll corpusIndex pins passed.");
}

await main();
