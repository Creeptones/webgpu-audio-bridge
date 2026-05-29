/**
 * captureProbe — unit pins for the decode-equivalence comparator
 * (src/worklet/captureProbe.ts). Node/tsx, assert-helper convention.
 *
 * Also exercises the comparator END-TO-END against the real decode paths it
 * exists to compare: it pushes frames through a Bridge, decodes them via both
 * `Bridge.pull` and the codegen-JS `emitWorkletReader`, flattens both, and
 * asserts bit-exact equivalence — the JS-vs-JS leg of the Stage-1 harness,
 * runnable headlessly (the WASM + browser legs live in the browser spec).
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  flattenFrame, compareCaptures, withinTolerance,
  TOLERANCE_EXACT, TOLERANCE_F32_SIMD,
} from "../src/worklet/captureProbe.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema, f64, u64, u32, f64Array, f32Array, f64TrajectoryArray,
} from "../src/schema.js";
import { compileWorkletReader } from "../src/emitWorkletReader.js";

function main(): void {
  // ── 1: flattenFrame shape + bigint coercion ──────────────────────────────
  {
    const flat = flattenFrame(
      { seq: 5n, v: 1.5, arr: new Float64Array([1, 2, 3]) },
      ["seq", "v", "arr"],
    );
    assertEq(flat.length, 5, "flatten length = 1 + 1 + 3");
    assertEq(flat[0], 5, "bigint coerced to Number");
    assertEq(flat[4], 3, "array tail element");
    ok("captureProbe-flatten-shape");
  }

  // ── 2: identical buffers → bit-exact ─────────────────────────────────────
  {
    const a = new Float64Array([1, 2, 3, 4]);
    const b = new Float64Array([1, 2, 3, 4]);
    const cmp = compareCaptures(a, b);
    assertEq(cmp.rms, 0, "rms 0"); assertEq(cmp.max, 0, "max 0");
    assertEq(cmp.firstDiffIndex, -1, "no diff index");
    assert(withinTolerance(cmp, TOLERANCE_EXACT), "passes exact band");
    ok("captureProbe-bit-exact");
  }

  // ── 3: small diff → within f32-SIMD band, fails exact ────────────────────
  {
    const a = new Float64Array([1, 2, 3]);
    const b = new Float64Array([1 + 1e-7, 2 - 2e-7, 3]);
    const cmp = compareCaptures(a, b);
    assert(cmp.firstDiffIndex === 0, "first diff at 0");
    assert(!withinTolerance(cmp, TOLERANCE_EXACT), "fails exact band");
    assert(withinTolerance(cmp, TOLERANCE_F32_SIMD), "passes f32-SIMD band");
    ok("captureProbe-tolerance-bands");
  }

  // ── 4: NaN-at-same-index counts as equal; length mismatch always fails ───
  {
    const a = new Float64Array([NaN, 1]);
    const b = new Float64Array([NaN, 1]);
    assert(withinTolerance(compareCaptures(a, b), TOLERANCE_EXACT), "NaN==NaN at same idx");
    const cmp = compareCaptures(new Float64Array([1, 2, 3]), new Float64Array([1, 2]));
    assert(!cmp.sameLength, "length mismatch flagged");
    assert(!withinTolerance(cmp, TOLERANCE_F32_SIMD), "length mismatch fails even loose band");
    ok("captureProbe-nan-and-length");
  }

  // ── 5: end-to-end Bridge.pull vs emitWorkletReader (JS-vs-JS leg) ────────
  {
    const schema = defineSchema({
      seq: u64(), flags: u32(), vMax: f64(),
      vEff: f64Array(16), gEff: f32Array(16), traj: f64TrajectoryArray(8, { order: 2 }),
    });
    const fieldNames = ["seq", "flags", "vMax", "vEff", "gEff", "traj"] as const;
    const cap = 8;
    const { sab } = Bridge.allocate(cap, schema);
    const bridge = new Bridge(sab, cap, schema);
    const reader = compileWorkletReader(schema, { functionName: "readFrame" });
    const dview = new DataView(sab);

    const push = bridge.scratchFrame();
    const outPull = bridge.scratchFrame();
    const outRead = bridge.scratchFrame();

    let worstRms = 0;
    for (let r = 0; r < 12; r++) {
      push.seq = BigInt(1000 + r);
      push.flags = (r * 2654435761) >>> 0;
      push.vMax = Math.sin(r * 0.4) * 100;
      for (let k = 0; k < 16; k++) { push.vEff[k] = Math.cos(r + k) * 7; push.gEff[k] = Math.fround(k / (r + 1)); }
      for (let k = 0; k < 16; k++) push.traj[k] = r * 2 + k * 0.25;
      assert(bridge.push(push), `push ${r}`);

      // Path A: Bridge.pull consumes the slot.
      // Path B: emitWorkletReader peeks the same slot index BEFORE the pull.
      const writeIdx = new Int32Array(sab, 0, 8)[0]!;
      const slotIdx = ((writeIdx - 1) | 0) & (cap - 1);
      reader(dview, slotIdx, outRead);
      assert(bridge.pull(outPull), `pull ${r}`);

      const cmp = compareCaptures(
        flattenFrame(outPull as never, fieldNames),
        flattenFrame(outRead as never, fieldNames),
      );
      assert(withinTolerance(cmp, TOLERANCE_EXACT),
        `row ${r}: Bridge.pull vs emitWorkletReader bit-exact (rms=${cmp.rms} max=${cmp.max} @${cmp.firstDiffIndex})`);
      if (cmp.rms > worstRms) worstRms = cmp.rms;
    }
    ok(`captureProbe-bridge-vs-reader (12 rows bit-exact, worstRms=${worstRms})`);
  }

  console.log("\ncaptureProbe: flatten + compare + tolerance bands + Bridge.pull/emitWorkletReader equivalence pins green.");
}

main();
