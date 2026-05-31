/**
 * fingerprint — quick-win #2 pins (Apollo Frontier 6).
 *
 * "Sounds-like" queries over `AcousticProfile.magnitude` (the L1-normalized,
 * amplitude-invariant band vector gate #3 attaches to every characterized kernel):
 * L2 distance, nearest-neighbour, dedup-by-sound, and brightness ordering along
 * `spectralCentroid`. Pure vector math — the profiles come from `acousticGate` (no
 * wasm), so the whole suite is deterministic + Node-only.
 *
 * Band resolution: profiles use the DEFAULT `fingerprintBands` (64) — fine enough to
 * separate a fundamental (bin 8 → band 0) from a 3rd harmonic (bin 24 → band 2), so the
 * magnitude discrimination the dedup / NN pins rely on works on the real attached
 * embedding. The helpers are band-count-agnostic anyway (they only require both vectors
 * share a resolution); the brightness pins use `spectralCentroid`, which is band-
 * independent.
 *
 * Run: tsx tests/fingerprint.test.ts
 *
 * Pins
 *  1  fingerprintDistance is a proper metric — identity, symmetry, triangle on hand
 *     vectors; the L2 value; a band-count mismatch throws.
 *  2  amplitude-invariance + dedup — gain (level 0.5) and hardclip (level 1.0) share a
 *     fingerprint exactly (a gain change leaves the shape untouched), so dedup collapses
 *     them; genuinely-distinct spectra are all kept.
 *  3  nearestByFingerprint — a cubic-soft variant's nearest neighbour is the cubic
 *     softclip (its harmonic sibling), not the pure-fundamental gain; self → distance 0;
 *     empty candidates → undefined.
 *  4  brightness — sortByBrightness orders dark→bright by centroid; brighterThan /
 *     darkerThan step one item along the axis; no-brighter → undefined; a missing
 *     centroid throws.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  acousticGate,
  fingerprintDistance, nearestByFingerprint, dedupByFingerprint,
  sortByBrightness, brighterThan, darkerThan,
  type AcousticProfile, type FingerprintLike, type LaneWidth,
} from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── IR builders (mirror the rest of the JIT suite) ───────────────────────────
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

// ── kernels, by spectral character ───────────────────────────────────────────
const GAIN: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("x"), S("g")))]);                              // pure fundamental, level 0.5
const HARDCLIP: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("min", Bn("max", L("x"), C(-1)), C(1)))]);             // identity on a ±1 sine → pure fundamental, level 1.0
const CONSTSCALE: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", L("x"), C(0.5)))]);                              // pure fundamental, level 0.5 (no scalar)
const CUBIC: IrKernel = K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(3))))]); // + 3rd harmonic
const CUBIC4: IrKernel = K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(4))))]); // + weaker 3rd harmonic
const RINGMOD: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], pb("n"),
  [ST("out", Bn("mul", L("a"), L("b")))]);                              // sum/diff bins — distinct
const RECTIFY: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", U("abs", L("x")), S("g")))]);                    // full-wave rectified → bright, harmonic-rich

function profile(ir: IrKernel): AcousticProfile {
  const r = acousticGate(ir); // default fingerprintBands (64) — the real attached embedding
  if (!r.ok) throw new Error(`acousticGate rejected a probe kernel: ${r.reason}`);
  return r.profile;
}

async function main(): Promise<void> {
  // ── Pin 1: fingerprintDistance is a proper metric ─────────────────────────
  {
    const a: FingerprintLike = { magnitude: [1, 0, 0] };
    const b: FingerprintLike = { magnitude: [0, 1, 0] };
    const c: FingerprintLike = { magnitude: [0, 0, 1] };

    assertEq(fingerprintDistance(a, a), 0, "metric: identity d(a,a)=0");
    assertEq(fingerprintDistance(a, b), fingerprintDistance(b, a), "metric: symmetry d(a,b)=d(b,a)");
    assert(Math.abs(fingerprintDistance(a, b) - Math.SQRT2) < 1e-12, "metric: d(a,b)=√2");
    const ac = fingerprintDistance(a, c);
    const ab = fingerprintDistance(a, b);
    const bc = fingerprintDistance(b, c);
    assert(ac <= ab + bc + 1e-12, `metric: triangle d(a,c) ≤ d(a,b)+d(b,c) (${ac} ≤ ${ab + bc})`);

    let threw = false;
    try { fingerprintDistance({ magnitude: [1, 0] }, { magnitude: [1, 0, 0] }); }
    catch { threw = true; }
    assert(threw, "metric: a band-count mismatch throws");

    ok("1 fingerprintDistance is a proper metric (identity/symmetry/triangle + L2 value + mismatch throws)");
  }

  // ── Pin 2: amplitude-invariance + dedup-by-sound ──────────────────────────
  {
    const gain = profile(GAIN);
    const hardclip = profile(HARDCLIP);
    const constscale = profile(CONSTSCALE);
    const cubic = profile(CUBIC);
    const rectify = profile(RECTIFY);

    // The headline: a pure level change leaves the fingerprint untouched. gain runs at
    // amplitude 0.5, hardclip at 1.0 — yet the L1-normalized shape vectors are identical.
    assert(Math.abs(gain.peak - 0.5) < 1e-3 && Math.abs(hardclip.peak - 1) < 1e-3, "dedup: gain ≈ 0.5, hardclip ≈ 1.0 (different levels)");
    assertEq(fingerprintDistance(gain, hardclip), 0, "dedup: amplitude-invariant — gain ≡ hardclip fingerprint despite 2× level");
    assertEq(fingerprintDistance(gain, constscale), 0, "dedup: gain ≡ constscale fingerprint");
    assert(fingerprintDistance(gain, cubic) > 0.1, "dedup: cubic is genuinely distinct (3rd harmonic)");

    // Greedy dedup collapses the three pure-fundamental kernels into one; the two
    // distinct spectra survive. Order-preserving (gain is the kept representative).
    const kept = dedupByFingerprint([gain, hardclip, constscale, cubic, rectify]);
    assertEq(kept.length, 3, "dedup: 5 kernels → 3 distinct sounds");
    assert(kept[0] === gain, "dedup: keeps the first of the collapsed cluster (gain)");
    assert(!kept.includes(hardclip) && !kept.includes(constscale), "dedup: hardclip/constscale dropped (same sound as gain)");
    assert(kept.includes(cubic) && kept.includes(rectify), "dedup: distinct spectra kept");

    // All-distinct input is untouched.
    const ringmod = profile(RINGMOD);
    const allDistinct = dedupByFingerprint([gain, cubic, ringmod, rectify]);
    assertEq(allDistinct.length, 4, "dedup: genuinely-distinct set is kept whole");

    ok("2 amplitude-invariance (gain≡hardclip≡constscale) + dedup collapses identical sounds, keeps distinct");
  }

  // ── Pin 3: nearestByFingerprint ───────────────────────────────────────────
  {
    const gain = profile(GAIN);
    const cubic = profile(CUBIC);
    const ringmod = profile(RINGMOD);
    const rectify = profile(RECTIFY);
    const candidates = [gain, cubic, ringmod, rectify];

    // A cubic-soft variant: its nearest neighbour is its harmonic sibling (cubic),
    // NOT the pure-fundamental gain — a real timbre match, not a level match.
    const query = profile(CUBIC4);
    const near = nearestByFingerprint(query, candidates);
    assert(near !== undefined, "NN: a match exists");
    if (near) {
      assertEq(near.index, 1, "NN: cubic4's nearest is cubic (index 1)");
      assert(near.item === cubic, "NN: returns the cubic profile object");
      assert(near.distance < fingerprintDistance(query, gain), "NN: cubic is strictly nearer than gain");
    }

    // A query equal to a candidate → that candidate at distance 0 (ties → lowest index).
    const self = nearestByFingerprint(gain, candidates);
    assert(self !== undefined && self.index === 0 && self.distance === 0, "NN: self-match is distance 0 at its index");

    // Empty candidate list → undefined.
    assertEq(nearestByFingerprint(gain, []), undefined, "NN: empty candidates → undefined");

    ok("3 nearestByFingerprint finds the timbre neighbour (cubic4→cubic), self→0, empty→undefined");
  }

  // ── Pin 4: brightness along spectralCentroid ──────────────────────────────
  {
    const gain = profile(GAIN);       // centroid ≈ 0.0156 (darkest — pure low fundamental)
    const cubic = profile(CUBIC);     // ≈ 0.0188
    const ringmod = profile(RINGMOD); // ≈ 0.0313
    const rectify = profile(RECTIFY); // ≈ 0.0783 (brightest — rich harmonics)

    // sortByBrightness orders dark→bright regardless of input order.
    const sorted = sortByBrightness([rectify, gain, ringmod, cubic]);
    assert(sorted[0] === gain && sorted[1] === cubic && sorted[2] === ringmod && sorted[3] === rectify,
      "brightness: sorted dark→bright (gain<cubic<ringmod<rectify)");
    assert(sorted[0]!.spectralCentroid <= sorted[3]!.spectralCentroid, "brightness: centroids ascend");

    // brighterThan steps UP one: the nearest item with a strictly greater centroid.
    const up = brighterThan(gain, [cubic, ringmod, rectify]);
    assert(up !== undefined && up.item === cubic, "brightness: brighterThan(gain) → cubic (next up)");
    assert(up !== undefined && up.distance > 0, "brightness: a positive centroid gap");

    // darkerThan steps DOWN one: the nearest item with a strictly smaller centroid.
    const down = darkerThan(rectify, [gain, cubic, ringmod]);
    assert(down !== undefined && down.item === ringmod, "brightness: darkerThan(rectify) → ringmod (next down)");

    // Nothing brighter than the brightest → undefined.
    assertEq(brighterThan(rectify, [gain, cubic, ringmod]), undefined, "brightness: nothing brighter than rectify → undefined");

    // A bare {magnitude} has no centroid → the brightness helpers throw.
    let threw = false;
    try { brighterThan({ magnitude: [1, 0, 0] }, [gain]); }
    catch { threw = true; }
    assert(threw, "brightness: a missing spectralCentroid throws");

    ok("4 brightness: sort dark→bright, brighterThan/darkerThan step the axis, no-brighter→undefined, missing centroid throws");
  }

  console.log("\nAll fingerprint pins passed.");
}

await main();
