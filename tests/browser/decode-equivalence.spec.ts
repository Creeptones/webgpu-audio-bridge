/**
 * Browser decode-equivalence spec (Stage 1 of the SIMD-harvest plan).
 *
 * Proves, inside a real cross-origin-isolated browser (not just Node), that the
 * three consumer-side decode paths produce BIT-IDENTICAL frames against the
 * `Bridge.pull` oracle:
 *
 *   - B  emitWorkletReader (codegen-JS DataView reader)
 *   - C  WASM decodeFrame  (whole-frame descriptor decode)
 *
 * Everything runs on the page's main thread inside `page.evaluate` — equivalence
 * is about decode *correctness*, which is thread-independent; the worklet wiring
 * is exercised by the wasm-decode-worklet example. We reuse the existing
 * webServer (examples/minimal/serve.mjs, COOP/COEP, /dist/* resolves) so this
 * spec needs no new server.
 *
 * Headless companions that must also stay green:
 *   - tests/Bridge.wasmEquivalence.test.ts pin 16  (WASM decodeFrame vs pull)
 *   - tests/captureProbe.test.ts                    (pull vs emitWorkletReader)
 * This spec is the in-browser confirmation that the BUILT dist + the browser's
 * own WASM engine agree with those Node results.
 */

import { test, expect } from "@playwright/test";

test("decode-equivalence: Bridge.pull == emitWorkletReader == WASM decodeFrame (bit-exact)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    // Function-wrapped dynamic import so the TS compiler doesn't try to
    // resolve these runtime-only absolute URLs (served by the webServer).
    const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<any>;
    const root = await dynImport("/dist/index.js");
    const wk = await dynImport("/dist/worklet/index.js");
    const {
      Bridge, defineSchema, describeSchemaLayout, compileWorkletReader,
      f64, u64, u32, f64Array, f32Array, f64TrajectoryArray,
    } = root as any;
    const {
      allocateWorkletMemory, instantiateConsumer, buildFrameDescriptors,
      slotByteBase, hasWasmConsumerSupport, compareCaptures, flattenFrame, withinTolerance, TOLERANCE_EXACT,
    } = wk as any;

    if (!hasWasmConsumerSupport()) return { skipped: "no WASM SIMD/threads in this browser" };

    const schema = defineSchema({
      seq: u64(), tNs: u64(), vMax: f64(), flags: u32(),
      vEff: f64Array(16), gEff: f32Array(16), traj: f64TrajectoryArray(8, { order: 2 }),
    });
    const fieldNames = ["seq", "tNs", "vMax", "flags", "vEff", "gEff", "traj"];
    const layout = describeSchemaLayout(schema);
    const cap = 8;
    const sabBytes = Bridge.byteLength(cap, schema);

    const probe = buildFrameDescriptors(layout, 0);
    const descBytes = probe.descCount * 12;
    const alloc = allocateWorkletMemory({ sabBytes, scratchBytes: descBytes + probe.totalDstBytes + 64 });
    const descPtr = alloc.scratchByteOffset;
    const decodedBase = (descPtr + descBytes + 7) & ~7;
    const plan = buildFrameDescriptors(layout, decodedBase);
    new Int32Array(alloc.sab, descPtr, plan.words.length).set(plan.words);

    const wasmBytes = await (await fetch("/dist/worklet/decoder.wasm")).arrayBuffer();
    const bridge = new Bridge(alloc.sab, cap, schema);
    const consumer = instantiateConsumer(wasmBytes, alloc.memory);
    const reader = compileWorkletReader(schema, { functionName: "readFrame" });
    const dview = new DataView(alloc.sab);
    const frameBytes = schema.frameByteSize;
    const mask = cap - 1;

    // WASM scratch read views.
    const sc = {
      seq: new BigUint64Array(alloc.sab, plan.fields.seq.byteOffset, 1),
      tNs: new BigUint64Array(alloc.sab, plan.fields.tNs.byteOffset, 1),
      vMax: new Float64Array(alloc.sab, plan.fields.vMax.byteOffset, 1),
      flags: new Uint32Array(alloc.sab, plan.fields.flags.byteOffset, 1),
      vEff: new Float64Array(alloc.sab, plan.fields.vEff.byteOffset, 16),
      gEff: new Float32Array(alloc.sab, plan.fields.gEff.byteOffset, 16),
      traj: new Float64Array(alloc.sab, plan.fields.traj.byteOffset, 16),
    };

    const push = bridge.scratchFrame();
    const outPull = bridge.scratchFrame();
    const outRead = bridge.scratchFrame();

    let worstReader = 0, worstWasm = 0, rows = 0, badLen = 0;
    for (let r = 0; r < 16; r++) {
      push.seq = BigInt(5000 + r); push.tNs = BigInt((5000 + r) * 1000);
      push.vMax = Math.sin(r * 0.3) * 321; push.flags = (r * 2654435761) >>> 0;
      for (let k = 0; k < 16; k++) { push.vEff[k] = Math.cos(r + k) * 11; push.gEff[k] = Math.fround(k / (r + 1)); }
      for (let k = 0; k < 16; k++) push.traj[k] = r + k * 0.5;
      bridge.push(push);

      const writeIdx = new Int32Array(alloc.sab, 0, 8)[0]!;
      const slotIdx = ((writeIdx - 1) | 0) & mask;
      // B: codegen reader (peek)
      reader(dview, slotIdx, outRead);
      // C: WASM decodeFrame (peek)
      const slot = consumer.peekPull(mask);
      consumer.decodeFrame(slotByteBase(slot, frameBytes), descPtr, plan.descCount);
      const outWasm: Record<string, unknown> = {
        seq: sc.seq[0], tNs: sc.tNs[0], vMax: sc.vMax[0], flags: sc.flags[0],
        vEff: sc.vEff, gEff: sc.gEff, traj: sc.traj,
      };
      // A: oracle pull (consumes)
      bridge.pull(outPull);
      consumer.commitPull();

      const flatPull = flattenFrame(outPull as any, fieldNames);
      const cR = compareCaptures(flatPull, flattenFrame(outRead as any, fieldNames));
      const cW = compareCaptures(flatPull, flattenFrame(outWasm as any, fieldNames));
      if (!cR.sameLength || !cW.sameLength) badLen++;
      if (!withinTolerance(cR, TOLERANCE_EXACT)) worstReader = Math.max(worstReader, cR.max);
      if (!withinTolerance(cW, TOLERANCE_EXACT)) worstWasm = Math.max(worstWasm, cW.max);
      rows++;
    }
    return { rows, worstReader, worstWasm, badLen };
  });

  if ((result as { skipped?: string }).skipped) {
    test.skip(true, (result as { skipped: string }).skipped);
    return;
  }
  const r = result as { rows: number; worstReader: number; worstWasm: number; badLen: number };
  expect(errors, errors.join("\n")).toEqual([]);
  expect(r.rows).toBe(16);
  expect(r.badLen).toBe(0);
  expect(r.worstReader).toBe(0); // emitWorkletReader bit-exact vs Bridge.pull
  expect(r.worstWasm).toBe(0);   // WASM decodeFrame bit-exact vs Bridge.pull
});
