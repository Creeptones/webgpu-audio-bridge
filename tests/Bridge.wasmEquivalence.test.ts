/**
 * Bridge — WASM consumer equivalence (Track 2 of the King roadmap, 0.7.5
 * scaffolding cut).
 *
 * The Track 2 thesis: an AudioWorklet that drains a Bridge SAB through a
 * WASM decoder (rather than the pure-JS path) eliminates the last
 * credible source of glitches — JS object allocation + V8 GC pauses.
 *
 * For that thesis to hold, the WASM module must see the SAB identically
 * to the JS Bridge — same bytes, same atomic-load semantics, same
 * happens-before discipline. This pin proves the smoke-test floor of
 * that guarantee:
 *
 *   (a) The packaged decoder.wasm loads in this runtime (Node 22 with
 *       SAB + WASM threads + WASM SIMD available).
 *   (b) Both feature probes (hasWasmSimd / hasWasmThreads) return true
 *       in the runtime where the WASM module subsequently loads. If
 *       either lies, the runtime contract is broken.
 *   (c) After every Bridge.push the WASM module's read_write_index()
 *       returns EXACTLY the same i32 value JS-side Atomics.load(int32,
 *       0) returns. Same after pull (read_read_index() vs lane 1).
 *   (d) The agreement holds across the full SPSC counter wrap window
 *       (we drive thousands of push/pulls; the i32 lane will eventually
 *       wrap mod 2^32 — both readers must agree across the wrap).
 *
 * Subsequent patches add the full pullLatest decode (schema-driven,
 * SIMD-vectorized for trajectory fields, CAS-aware on drop-oldest). The
 * equivalence corpus grows accordingly: the 63 single-thread Bridge
 * pins become the cross-language oracle that any new WASM decode must
 * match bit-for-bit.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema, f64, f32, u64, i64, u32, i32, u16, i16, u8, i8,
  f64Array, f32Array, u32Array, f64TrajectoryArray, f32TrajectoryArray,
  describeSchemaLayout,
} from "../src/schema.js";
import { evaluateTrajectoryInto, evaluateHermiteTrajectoryInto } from "../src/trajectory.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  hasWasmSimd,
  hasWasmThreads,
  hasWasmConsumerSupport,
} from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

function main(): void {
  // ── 1: Feature probes agree with one another ────────────────────────────
  // hasWasmConsumerSupport() is the conjunction. If either sub-probe is
  // false, the conjunction must be false. If both are true, the consumer
  // must load below.
  {
    const simd = hasWasmSimd();
    const threads = hasWasmThreads();
    const both = hasWasmConsumerSupport();
    assertEq(both, simd && threads, "consumer support = simd ∧ threads");
    ok(`feature-probes (simd=${simd} threads=${threads} both=${both})`);
  }

  // ── 2: WASM binary loads with shared memory ─────────────────────────────
  // Allocates a small SAB (capacity=4, payload header + 4 frames of a
  // tiny schema), instantiates the consumer over it, asserts both
  // exports are callable. Proves the build pipeline produced a WASM
  // module that THIS runtime accepts.
  let wasmBytes: Uint8Array<ArrayBuffer>;
  try {
    // readFileSync returns Node's `Buffer` (a `Uint8Array<ArrayBufferLike>`).
    // Re-wrap into a fresh `Uint8Array` whose backing buffer is explicitly
    // a plain ArrayBuffer so the type aligns with `BufferSource` —
    // WebAssembly.Module's constructor rejects SharedArrayBuffer-backed
    // views at the type level (and would in any case copy them).
    const fileBuf = readFileSync(wasmPath);
    wasmBytes = new Uint8Array(fileBuf.byteLength);
    wasmBytes.set(fileBuf);
  } catch (err) {
    throw new Error(
      `wasm equivalence: cannot read ${wasmPath} — run \`npm run build:wasm\` first (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  assert(wasmBytes.byteLength > 0, "decoder.wasm is not empty");
  ok(`wasm-binary-loaded (${wasmBytes.byteLength} bytes)`);

  // ── 3: Push/pull header equivalence ─────────────────────────────────────
  // The headline pin. Allocates a shared memory, wraps it as a Bridge,
  // instantiates the WASM consumer over the same memory, drives N
  // push/pull cycles, asserts the WASM atomic reads agree with the
  // JS Atomic reads at every step.
  const schema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    value: f64(),
  });
  const CAPACITY = 16;
  const wantedBytes = Bridge.byteLength(CAPACITY, schema);
  const { memory, sab, pages, byteLength } = allocateWorkletMemory(wantedBytes);
  assert(
    byteLength >= wantedBytes,
    `allocator must reserve >= ${wantedBytes} bytes (got ${byteLength}, ${pages} pages)`,
  );

  const bridge = new Bridge(sab, CAPACITY, schema);
  const consumer = instantiateConsumer(wasmBytes, memory);

  // JS-side view of the SAB header. Lanes 0/1 are write_index/read_index;
  // we compare WASM's atomic reads against Atomics.load on these.
  const headerView = new Int32Array(sab, 0, 8);

  const scratchPush = bridge.scratchFrame();
  const scratchPull = bridge.scratchFrame();

  // Drive enough cycles to verify the agreement across many state
  // transitions. CAPACITY=16 so we fill / drain / fill again multiple
  // times. 200 cycles is roughly 3 ms — fast.
  const CYCLES = 200;
  for (let i = 0; i < CYCLES; i++) {
    scratchPush.seq = BigInt(i);
    scratchPush.tMacroNs = BigInt(i * 1_000_000);
    scratchPush.value = i * 0.5;
    const pushed = bridge.push(scratchPush);
    if (!pushed) {
      // Ring full — drain a few frames so the loop continues. This is
      // expected behavior for the smoke test (CAPACITY=16, no consumer
      // until below); we use the JS Bridge to drain rather than the
      // WASM consumer (which doesn't have a pull export yet).
      while (bridge.pull(scratchPull));
      const retried = bridge.push(scratchPush);
      assert(retried, `push retried after drain at cycle ${i}`);
    }

    // After the producer's atomic store on write_index, the WASM
    // read must match the JS read.
    const jsWrite = Atomics.load(headerView, 0);
    const wasmWrite = consumer.readWriteIndex();
    assertEq(
      wasmWrite,
      jsWrite,
      `cycle ${i} post-push: WASM read_write_index() = ${wasmWrite}, JS Atomics.load = ${jsWrite}`,
    );

    // Pull one frame back, then check read_index agreement.
    bridge.pull(scratchPull);
    assertEq(scratchPull.value, i * 0.5, `cycle ${i}: pull value`);

    const jsRead = Atomics.load(headerView, 1);
    const wasmRead = consumer.readReadIndex();
    assertEq(
      wasmRead,
      jsRead,
      `cycle ${i} post-pull: WASM read_read_index() = ${wasmRead}, JS Atomics.load = ${jsRead}`,
    );
  }
  ok(
    `wasm-js-header-equivalence (${CYCLES} push/pull cycles; ` +
      `final writeIdx=${Atomics.load(headerView, 0)} readIdx=${Atomics.load(headerView, 1)})`,
  );

  // ── 4: Memory page bounds + shared-buffer identity ──────────────────────
  // Defensive: confirm the runtime really did give us a SharedArrayBuffer
  // (not a regular ArrayBuffer) and that `memory.buffer === sab` — the
  // bedrock of the JS / WASM agreement.
  assert(sab instanceof SharedArrayBuffer, "allocator returned a SharedArrayBuffer");
  assert(
    (memory.buffer as unknown as SharedArrayBuffer) === sab,
    "memory.buffer is the same SAB object the bridge wraps",
  );
  ok(`memory-identity (${pages} pages, ${byteLength} bytes)`);

  // ── 5: FIFO peek+commit drains agree with JS Bridge.pull bytes (0.7.6) ──
  // The hot-path pin for the SPSC dance. Push N frames via the JS Bridge,
  // then drain via the WASM consumer's peek_pull / commit_pull cycle. For
  // each drained frame, read the slot bytes directly from the SAB and
  // verify they match what was pushed. The slot index returned by WASM
  // must equal `readIdx & mask` — same algebra the JS Bridge uses.
  //
  // The schema is { seq: u64, tMacroNs: u64, value: f64 } so the in-
  // slot field offsets are seq @ 0, tMacroNs @ 8, value @ 16 — easy to
  // index via DataView without reaching into the Bridge's private
  // umbrella views.
  {
    const frameBytes = schema.compiled.frameByteSize;
    const headerBytes = 32; // matches RING_HEADER_BYTES (the bridge's static)
    const mask = CAPACITY - 1;
    const dv = new DataView(sab);

    // Drain whatever's left over from pin 3 so we start with an empty ring.
    while (bridge.pull(scratchPull)) { /* drain */ }
    assertEq(
      consumer.peekPull(mask),
      -1,
      "peekPull on empty ring returns -1",
    );
    consumer.commitPull(); // no-op semantics on empty (idempotent store)
    assertEq(
      Atomics.load(headerView, 1),
      Atomics.load(headerView, 0),
      "commit_pull on empty ring leaves read_index === write_index",
    );

    const N = 150; // enough to wrap CAPACITY (=16) several times
    for (let i = 0; i < N; i++) {
      scratchPush.seq = BigInt(1_000_000_000 + i);
      scratchPush.tMacroNs = BigInt((1_000_000_000 + i) * 1_000);
      scratchPush.value = -3.14 + i * 0.01;
      assert(bridge.push(scratchPush), `pin5: push ${i}`);

      const expectedReadIdx = Atomics.load(headerView, 1);
      const expectedSlot = (expectedReadIdx >>> 0) & mask;
      const slot = consumer.peekPull(mask);
      assertEq(slot, expectedSlot, `pin5: peekPull slot at i=${i}`);

      // Read slot bytes via DataView — same bytes JS Bridge.pull would
      // surface through its umbrella views. Little-endian per the
      // bridge's SAB conventions.
      const slotOffset = headerBytes + slot * frameBytes;
      const seq = dv.getBigUint64(slotOffset + 0, true);
      const tMacroNs = dv.getBigUint64(slotOffset + 8, true);
      const value = dv.getFloat64(slotOffset + 16, true);
      assertEq(seq, BigInt(1_000_000_000 + i), `pin5: seq[${i}]`);
      assertEq(tMacroNs, BigInt((1_000_000_000 + i) * 1_000), `pin5: tMacroNs[${i}]`);
      assertEq(value, -3.14 + i * 0.01, `pin5: value[${i}]`);

      consumer.commitPull();
      // After commit, read_index advanced by exactly one.
      assertEq(
        Atomics.load(headerView, 1),
        (expectedReadIdx + 1) | 0,
        `pin5: read_index post-commit at i=${i}`,
      );
    }
    ok(`wasm-pull-fifo-equivalence (${N} frames drained, wrap covered ${Math.floor(N / CAPACITY)}×)`);
  }

  // ── 6: pullLatest peek+commit skips correctly (0.7.6) ──────────────────
  // The drain-to-newest contract. Push a burst of K frames without
  // draining, then a single WASM peek_pull_latest must return the slot
  // of the K-th frame and commit_pull_latest must advance read_index
  // ALL THE WAY to write_index (consuming the older K-1 in one shot).
  // Repeat several times to cover wraparound and varying burst sizes.
  {
    const frameBytes = schema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = CAPACITY - 1;
    const dv = new DataView(sab);

    // Drain leftover.
    while (bridge.pull(scratchPull)) { /* drain */ }
    assertEq(
      consumer.peekPullLatest(mask),
      -1,
      "peekPullLatest on empty ring returns -1",
    );
    consumer.commitPullLatest(); // idempotent on empty

    const bursts = [1, 2, 5, CAPACITY - 1, CAPACITY]; // last burst saturates the ring
    let pushSeqBase = 2_000_000_000;
    for (let bIdx = 0; bIdx < bursts.length; bIdx++) {
      const K = bursts[bIdx]!;
      const writeIdxBefore = Atomics.load(headerView, 0);

      for (let k = 0; k < K; k++) {
        scratchPush.seq = BigInt(pushSeqBase + k);
        scratchPush.tMacroNs = BigInt((pushSeqBase + k) * 1_000);
        scratchPush.value = 100 + k * 0.5;
        assert(bridge.push(scratchPush), `pin6: push burst ${bIdx} item ${k}`);
      }

      const writeIdxAfter = Atomics.load(headerView, 0);
      assertEq(
        (writeIdxAfter - writeIdxBefore) | 0,
        K,
        `pin6: burst ${bIdx} produced ${K} pushes`,
      );

      // WASM peek must return slot of the LAST pushed frame (writeIdx − 1).
      const expectedNewestSlot = ((writeIdxAfter - 1) >>> 0) & mask;
      const slot = consumer.peekPullLatest(mask);
      assertEq(slot, expectedNewestSlot, `pin6: peekPullLatest slot for burst ${bIdx}`);

      // The slot's contents must equal the LAST frame in the burst.
      const slotOffset = headerBytes + slot * frameBytes;
      const seq = dv.getBigUint64(slotOffset + 0, true);
      const tMacroNs = dv.getBigUint64(slotOffset + 8, true);
      const value = dv.getFloat64(slotOffset + 16, true);
      assertEq(seq, BigInt(pushSeqBase + K - 1), `pin6: newest seq for burst ${bIdx}`);
      assertEq(
        tMacroNs,
        BigInt((pushSeqBase + K - 1) * 1_000),
        `pin6: newest tMacroNs for burst ${bIdx}`,
      );
      assertEq(value, 100 + (K - 1) * 0.5, `pin6: newest value for burst ${bIdx}`);

      consumer.commitPullLatest();

      // After commit, read_index === writeIdxAfter (consumed everything).
      assertEq(
        Atomics.load(headerView, 1),
        writeIdxAfter,
        `pin6: read_index post-commit for burst ${bIdx}`,
      );
      // Ring must be empty for the next iteration.
      assertEq(
        consumer.peekPullLatest(mask),
        -1,
        `pin6: ring empty after drain for burst ${bIdx}`,
      );
      consumer.commitPullLatest();

      pushSeqBase += K;
    }
    ok(`wasm-pullLatest-skip-equivalence (${bursts.length} bursts ${bursts.join(",")})`);
  }

  // ── 7: All-scalar-kinds decoder equivalence (0.7.7) ─────────────────────
  // The first PAYLOAD-DECODE pin: WASM-side scalar reads must produce
  // the exact value the producer pushed for every FieldKind the
  // schema DSL declares. Critical edge cases covered: i32 with high
  // bit set (signed −1 vs unsigned 4 294 967 295), i64 spanning the
  // signed/unsigned boundary, i8/u8 at ±extremes, f32 with NaN bit
  // patterns and f64 normal values, BigInt round-trips through the
  // WASM i64 boundary.
  //
  // Pushes 10 frames with carefully-chosen edge-case values; drains
  // each via the FIFO peek/read/commit cycle; asserts every WASM
  // read equals the pushed value. The shim's unsigned-cast helpers
  // (BigInt.asUintN for u64, `>>> 0` for u32) are exercised in the
  // EXPECTED unsigned representations the test asserts against.
  {
    const wideSchema = defineSchema({
      f: f64(),
      g: f32(),
      h: i64(),
      i: u64(),
      j: i32(),
      k: u32(),
      l: i16(),
      m: u16(),
      n: i8(),
      o: u8(),
    });
    const wideCapacity = 8;
    const wideBytes = Bridge.byteLength(wideCapacity, wideSchema);
    const widePages = Math.ceil(wideBytes / 65536);
    const wideMemory = new WebAssembly.Memory({
      initial: widePages,
      maximum: widePages,
      shared: true,
    });
    const wideSab = wideMemory.buffer as unknown as SharedArrayBuffer;
    const wideBridge = new Bridge(wideSab, wideCapacity, wideSchema);
    const wideConsumer = instantiateConsumer(wasmBytes, wideMemory);

    const frameBytes = wideSchema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = wideCapacity - 1;
    // Pre-resolve each field's in-slot byte offset from the compiled
    // layout. Order in the schema definition is the canonical field
    // order; the compiled layout exposes the byteOffset of each.
    const fieldOffsets: Record<string, number> = {};
    for (const field of wideSchema.compiled.fields) {
      fieldOffsets[field.name] = field.byteOffset;
    }

    // Edge-case value table. Each row is `[f, g, h, i, j, k, l, m, n, o]`
    // — one frame's worth of values for the ten fields. Designed to
    // exercise sign extension, BigInt wide-range, and the unsigned-cast
    // shim helpers.
    type FrameValues = {
      f: number; g: number; h: bigint; i: bigint;
      j: number; k: number; l: number; m: number; n: number; o: number;
    };
    const rows: FrameValues[] = [
      { f: 0, g: 0, h: 0n, i: 0n, j: 0, k: 0, l: 0, m: 0, n: 0, o: 0 },
      // High-bit-set 32-bit boundary
      { f: 1.5, g: -2.25, h: -1n, i: 0xFFFFFFFFFFFFFFFFn,
        j: -1, k: 0xFFFFFFFF, l: -32768, m: 65535, n: -128, o: 255 },
      // Signed/unsigned 32-bit pivot at 2^31
      { f: 1e100, g: -1e30, h: 1n << 32n, i: 1n << 63n,
        j: -(2 ** 31), k: 2 ** 31, l: 12345, m: 12345, n: 42, o: 42 },
      // 53-bit safe integer boundary
      { f: Number.MAX_SAFE_INTEGER, g: 1.5, h: BigInt(Number.MAX_SAFE_INTEGER),
        i: BigInt(Number.MAX_SAFE_INTEGER) + 1n, j: 7, k: 7, l: -1, m: 1, n: 1, o: 200 },
      // Negative normal floats + small ints
      { f: -3.14159265358979, g: 2.5, h: -42n, i: 42n,
        j: 100, k: 100, l: -100, m: 100, n: -1, o: 1 },
    ];

    const pushFrame = wideBridge.scratchFrame();
    const pullFrame = wideBridge.scratchFrame();
    // Drain any leftover from prior pins to start clean.
    while (wideBridge.pull(pullFrame)) { /* drain */ }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      pushFrame.f = row.f; pushFrame.g = row.g;
      pushFrame.h = row.h; pushFrame.i = row.i;
      pushFrame.j = row.j; pushFrame.k = row.k;
      pushFrame.l = row.l; pushFrame.m = row.m;
      pushFrame.n = row.n; pushFrame.o = row.o;
      assert(wideBridge.push(pushFrame), `pin7: push row ${r}`);

      const slot = wideConsumer.peekPull(mask);
      assert(slot >= 0, `pin7: peekPull row ${r} should not be empty`);
      const slotBase = headerBytes + slot * frameBytes;

      // f64: full precision; bit-identical compare via Object.is for NaN safety.
      assertEq(wideConsumer.readF64(slotBase + fieldOffsets.f!), row.f, `pin7 f64 row ${r}`);
      // f32: rounds to f32 precision; the producer's write already lost the
      // extra precision, so the WASM read of the same bytes equals what JS
      // would see via Float32Array.
      const f32JsRoundtrip = Math.fround(row.g);
      assertEq(wideConsumer.readF32(slotBase + fieldOffsets.g!), f32JsRoundtrip, `pin7 f32 row ${r}`);
      // i64 / u64
      assertEq(wideConsumer.readI64(slotBase + fieldOffsets.h!), row.h, `pin7 i64 row ${r}`);
      assertEq(wideConsumer.readU64(slotBase + fieldOffsets.i!), row.i, `pin7 u64 row ${r}`);
      // i32 / u32
      assertEq(wideConsumer.readI32(slotBase + fieldOffsets.j!), row.j, `pin7 i32 row ${r}`);
      assertEq(wideConsumer.readU32(slotBase + fieldOffsets.k!), row.k, `pin7 u32 row ${r}`);
      // i16 / u16
      assertEq(wideConsumer.readI16(slotBase + fieldOffsets.l!), row.l, `pin7 i16 row ${r}`);
      assertEq(wideConsumer.readU16(slotBase + fieldOffsets.m!), row.m, `pin7 u16 row ${r}`);
      // i8 / u8
      assertEq(wideConsumer.readI8(slotBase + fieldOffsets.n!), row.n, `pin7 i8 row ${r}`);
      assertEq(wideConsumer.readU8(slotBase + fieldOffsets.o!), row.o, `pin7 u8 row ${r}`);

      wideConsumer.commitPull();
    }

    // Cross-check vs JS Bridge.pull on a SECOND Bridge over the SAME bytes
    // (the WASM consumer already drained the first, so we push fresh
    // values and verify the JS path produces the EXACT same scalars the
    // WASM readers just confirmed are correct).
    const jsScratch = wideBridge.scratchFrame();
    const sampleRow = rows[1]!;
    pushFrame.f = sampleRow.f; pushFrame.g = sampleRow.g;
    pushFrame.h = sampleRow.h; pushFrame.i = sampleRow.i;
    pushFrame.j = sampleRow.j; pushFrame.k = sampleRow.k;
    pushFrame.l = sampleRow.l; pushFrame.m = sampleRow.m;
    pushFrame.n = sampleRow.n; pushFrame.o = sampleRow.o;
    assert(wideBridge.push(pushFrame), "pin7 cross-check push");
    assert(wideBridge.pull(jsScratch), "pin7 cross-check pull");
    // JS Bridge.pull also produces the unsigned-cast forms automatically
    // (u32 via Uint32Array umbrella view, u64 via BigUint64Array etc.),
    // so the two reads should match exactly.
    assertEq(jsScratch.f, sampleRow.f, "pin7 cross-check f64");
    assertEq(jsScratch.k, sampleRow.k, "pin7 cross-check u32");
    assertEq(jsScratch.i, sampleRow.i, "pin7 cross-check u64");
    assertEq(jsScratch.n, sampleRow.n, "pin7 cross-check i8");
    assertEq(jsScratch.o, sampleRow.o, "pin7 cross-check u8");

    ok(
      `wasm-scalar-decode-equivalence (${rows.length} rows × 10 field kinds + JS cross-check)`,
    );
  }

  // ── 8: Array decoder equivalence (0.7.8) ───────────────────────────────
  // The WASM `copy_array` export bulk-copies an array field's bytes
  // from a slot to a caller-provided destination region inside the
  // same WebAssembly.Memory. The shim's `allocateWorkletMemory({
  // sabBytes, scratchBytes })` overload reserves a page-aligned
  // scratch region above the SAB ring for exactly this use.
  //
  // This pin defines a small array schema, pushes N frames of known
  // array values, drains each via WASM peek → copy_array (per array
  // field) → JS reads from the scratch view → commit, and asserts
  // the scratch-region bytes equal what was pushed. A cross-check
  // against JS Bridge.pull on a fresh push confirms the JS-side
  // umbrella TypedArray decode agrees with the WASM bulk copy.
  {
    const ARRAY_N = 32;
    const arraySchema = defineSchema({
      seq: u64(),
      tMacroNs: u64(),
      vEff: f64Array(ARRAY_N),
      gEff: f32Array(ARRAY_N),
      iEff: u32Array(ARRAY_N),
    });
    const arrayCapacity = 8;
    const arraySabBytes = Bridge.byteLength(arrayCapacity, arraySchema);
    // Scratch region carries one copy of all three arrays:
    //   vEff:  ARRAY_N × 8 bytes (f64)
    //   gEff:  ARRAY_N × 4 bytes (f32)
    //   iEff:  ARRAY_N × 4 bytes (u32)
    const vEffBytes = ARRAY_N * 8;
    const gEffBytes = ARRAY_N * 4;
    const iEffBytes = ARRAY_N * 4;
    const arrayScratchBytes = vEffBytes + gEffBytes + iEffBytes;

    const arrayAlloc = allocateWorkletMemory({
      sabBytes: arraySabBytes,
      scratchBytes: arrayScratchBytes,
    });
    assert(
      arrayAlloc.scratchByteOffset !== undefined,
      "pin8: allocator returned a scratch offset for the scratchBytes overload",
    );
    assertEq(
      arrayAlloc.scratchBytes,
      arrayScratchBytes,
      "pin8: allocator preserved the requested scratchBytes",
    );
    const scratchBase = arrayAlloc.scratchByteOffset!;

    const arrayBridge = new Bridge(arrayAlloc.sab, arrayCapacity, arraySchema);
    const arrayConsumer = instantiateConsumer(wasmBytes, arrayAlloc.memory);

    const frameBytes = arraySchema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = arrayCapacity - 1;
    const arrayFieldOffsets: Record<string, number> = {};
    for (const field of arraySchema.compiled.fields) {
      arrayFieldOffsets[field.name] = field.byteOffset;
    }

    // JS-side TypedArray views over the scratch region. The shim's
    // allocator returns a single contiguous scratch byte range; we
    // partition it by laying f64 first, then f32, then u32. The byte
    // offsets are computed once and reused per pull.
    const scratchVEffOff = scratchBase;
    const scratchGEffOff = scratchBase + vEffBytes;
    const scratchIEffOff = scratchBase + vEffBytes + gEffBytes;
    const scratchVEffView = new Float64Array(arrayAlloc.sab, scratchVEffOff, ARRAY_N);
    const scratchGEffView = new Float32Array(arrayAlloc.sab, scratchGEffOff, ARRAY_N);
    const scratchIEffView = new Uint32Array(arrayAlloc.sab, scratchIEffOff, ARRAY_N);

    const arrayPushFrame = arrayBridge.scratchFrame();
    const arrayPullFrame = arrayBridge.scratchFrame();
    // Drain any leftover so the test starts clean.
    while (arrayBridge.pull(arrayPullFrame)) { /* drain */ }

    const ROWS = 6;
    for (let r = 0; r < ROWS; r++) {
      // Generate a per-row pattern that varies element-by-element AND
      // row-by-row, so any off-by-one in slot/offset math surfaces.
      for (let k = 0; k < ARRAY_N; k++) {
        arrayPushFrame.vEff[k] = Math.sin((r + 1) * k * 0.137) * 1e3;
        arrayPushFrame.gEff[k] = Math.fround(Math.cos(r * 0.4 + k * 0.07) * 0.99);
        arrayPushFrame.iEff[k] = ((r << 16) | (k + 1)) >>> 0;
      }
      arrayPushFrame.seq = BigInt(7_000_000_000 + r);
      arrayPushFrame.tMacroNs = BigInt((7_000_000_000 + r) * 1_000);
      assert(arrayBridge.push(arrayPushFrame), `pin8: push row ${r}`);

      const slot = arrayConsumer.peekPull(mask);
      assert(slot >= 0, `pin8: peekPull row ${r} should not be empty`);
      const slotBase = headerBytes + slot * frameBytes;

      // Bulk-copy each array via WASM `copy_array`. Source = slot's
      // field byte offset; destination = scratch region's partition
      // for that array; byte count = array elements × element bytes.
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.vEff!,
        scratchVEffOff,
        vEffBytes,
      );
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.gEff!,
        scratchGEffOff,
        gEffBytes,
      );
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.iEff!,
        scratchIEffOff,
        iEffBytes,
      );

      // Compare the scratch views (populated by WASM) to the values we
      // pushed.
      for (let k = 0; k < ARRAY_N; k++) {
        assertEq(
          scratchVEffView[k],
          arrayPushFrame.vEff[k],
          `pin8 vEff[${k}] row ${r}`,
        );
        assertEq(
          scratchGEffView[k],
          arrayPushFrame.gEff[k],
          `pin8 gEff[${k}] row ${r}`,
        );
        assertEq(
          scratchIEffView[k],
          arrayPushFrame.iEff[k],
          `pin8 iEff[${k}] row ${r}`,
        );
      }
      arrayConsumer.commitPull();
    }

    // Cross-check: push one more row and pull via JS Bridge.pull. The
    // JS-decoded arrays must equal the values we pushed (mirrors the
    // WASM-decoded scratch above bit-for-bit).
    for (let k = 0; k < ARRAY_N; k++) {
      arrayPushFrame.vEff[k] = -k * 0.5;
      arrayPushFrame.gEff[k] = Math.fround(k * 0.25);
      arrayPushFrame.iEff[k] = (0xDEAD0000 | k) >>> 0;
    }
    arrayPushFrame.seq = 9999n;
    arrayPushFrame.tMacroNs = 9_999_999n;
    assert(arrayBridge.push(arrayPushFrame), "pin8: cross-check push");
    assert(arrayBridge.pull(arrayPullFrame), "pin8: cross-check pull");
    for (let k = 0; k < ARRAY_N; k++) {
      assertEq(arrayPullFrame.vEff[k], -k * 0.5, `pin8 cross-check vEff[${k}]`);
      assertEq(arrayPullFrame.gEff[k], Math.fround(k * 0.25), `pin8 cross-check gEff[${k}]`);
      assertEq(arrayPullFrame.iEff[k], (0xDEAD0000 | k) >>> 0, `pin8 cross-check iEff[${k}]`);
    }

    ok(
      `wasm-array-copy-equivalence (${ROWS} rows × ${ARRAY_N} elements × 3 array fields, scratch=${arrayScratchBytes}B + JS cross-check)`,
    );
  }

  // ── 9: f64 trajectory evaluator equivalence (0.7.9) ────────────────────
  // The WASM evaluator exports must produce BIT-IDENTICAL output to
  // the JS evaluateTrajectoryInto / evaluateHermiteTrajectoryInto
  // helpers — same operation order, same f64 arithmetic, no FMA
  // fusion (WebAssembly spec disallows implicit FMA in scalar ops;
  // V8 honors this). The pin sweeps:
  //
  //   - Order 1/2/3 Taylor across multiple dt values to exercise
  //     the per-order dispatch and the halfDt2 caching on order=3.
  //   - Hermite at multiple (t, segmentSeconds) pairs to exercise
  //     the caller-side basis-coefficient resolution.
  //
  // Source bytes for the WASM evaluator come from the trajectory's
  // location inside an actual Bridge SAB slot (drained via the
  // peek/commit dance), matching the production wiring. The JS
  // evaluator reads the same bytes via the trajectory's flat
  // typed-array.
  {
    const TRAJ_N = 24; // per-trajectory sample count
    const trajSchema = defineSchema({
      seq: u64(),
      // Three trajectory fields, one per order.
      tO1: f64TrajectoryArray(TRAJ_N, { order: 1 }),
      tO2: f64TrajectoryArray(TRAJ_N, { order: 2 }),
      tO3: f64TrajectoryArray(TRAJ_N, { order: 3 }),
    });
    const trajCapacity = 4;
    const trajSabBytes = Bridge.byteLength(trajCapacity, trajSchema);
    // Scratch: one dst region per order (n × 8 bytes each).
    const dstBytesO1 = TRAJ_N * 8;
    const dstBytesO2 = TRAJ_N * 8;
    const dstBytesO3 = TRAJ_N * 8;
    // Plus two Hermite dst regions (order=2 + order=3) for the Hermite sub-pin.
    const dstBytesHermO2 = TRAJ_N * 8;
    const dstBytesHermO3 = TRAJ_N * 8;
    const totalScratch =
      dstBytesO1 + dstBytesO2 + dstBytesO3 + dstBytesHermO2 + dstBytesHermO3;

    const trajAlloc = allocateWorkletMemory({
      sabBytes: trajSabBytes,
      scratchBytes: totalScratch,
    });
    const trajBridge = new Bridge(trajAlloc.sab, trajCapacity, trajSchema);
    const trajConsumer = instantiateConsumer(wasmBytes, trajAlloc.memory);

    const headerBytes = 32;
    const frameBytes = trajSchema.compiled.frameByteSize;
    const mask = trajCapacity - 1;
    const trajOff: Record<string, number> = {};
    for (const f of trajSchema.compiled.fields) trajOff[f.name] = f.byteOffset;

    // Carve the scratch into per-evaluator partitions.
    const scratchBase = trajAlloc.scratchByteOffset!;
    const dstO1Off = scratchBase;
    const dstO2Off = dstO1Off + dstBytesO1;
    const dstO3Off = dstO2Off + dstBytesO2;
    const dstHermO2Off = dstO3Off + dstBytesO3;
    const dstHermO3Off = dstHermO2Off + dstBytesHermO2;
    const dstO1View = new Float64Array(trajAlloc.sab, dstO1Off, TRAJ_N);
    const dstO2View = new Float64Array(trajAlloc.sab, dstO2Off, TRAJ_N);
    const dstO3View = new Float64Array(trajAlloc.sab, dstO3Off, TRAJ_N);
    const dstHermO2View = new Float64Array(trajAlloc.sab, dstHermO2Off, TRAJ_N);
    const dstHermO3View = new Float64Array(trajAlloc.sab, dstHermO3Off, TRAJ_N);

    const pushFrame = trajBridge.scratchFrame();
    const pullFrame = trajBridge.scratchFrame();
    // JS-side reference buffers — receive the JS evaluator output.
    const jsRefO1 = new Float64Array(TRAJ_N);
    const jsRefO2 = new Float64Array(TRAJ_N);
    const jsRefO3 = new Float64Array(TRAJ_N);
    const jsRefHermO2 = new Float64Array(TRAJ_N);
    const jsRefHermO3 = new Float64Array(TRAJ_N);

    // Helper to fill the trajectory flat arrays with a "physics-shaped"
    // curve: position = sin(k·θ), velocity = ω·cos(k·θ),
    // acceleration = −ω²·sin(k·θ). Distinct per-row θ so each
    // frame's content is unique.
    function fillTrajectories(row: number): void {
      const theta = 0.13 + row * 0.041;
      const omega = 2 * Math.PI * 3; // 3 Hz-equivalent rate
      // Order 1: positions only
      for (let k = 0; k < TRAJ_N; k++) {
        pushFrame.tO1[k] = Math.sin(k * theta);
      }
      // Order 2: interleaved (p, v)
      for (let k = 0; k < TRAJ_N; k++) {
        const p = Math.sin(k * theta + row);
        const v = omega * Math.cos(k * theta + row);
        pushFrame.tO2[k * 2] = p;
        pushFrame.tO2[k * 2 + 1] = v;
      }
      // Order 3: interleaved (p, v, a)
      for (let k = 0; k < TRAJ_N; k++) {
        const p = Math.cos(k * theta + row * 0.5);
        const v = -omega * Math.sin(k * theta + row * 0.5);
        const a = -omega * omega * Math.cos(k * theta + row * 0.5);
        pushFrame.tO3[k * 3] = p;
        pushFrame.tO3[k * 3 + 1] = v;
        pushFrame.tO3[k * 3 + 2] = a;
      }
    }

    // For Hermite we need TWO consecutive frames pre-staged.
    const prevSlotByteBase = { val: 0 };
    const currSlotByteBase = { val: 0 };

    // ── 9a: Taylor o1/o2/o3 equivalence across multiple dt values ──────
    const taylorRows = 5;
    const dts = [0.0, 0.0008, 0.005, 0.012345, 0.0166667];
    // Drain anything left in the ring.
    while (trajBridge.pull(pullFrame)) { /* drain */ }

    for (let r = 0; r < taylorRows; r++) {
      fillTrajectories(r);
      assert(trajBridge.push(pushFrame), `pin9a: push row ${r}`);

      const slot = trajConsumer.peekPull(mask);
      assert(slot >= 0, `pin9a: peekPull row ${r}`);
      const slotBase = headerBytes + slot * frameBytes;

      for (const dt of dts) {
        // WASM o1: writes positions verbatim.
        trajConsumer.evalTaylorF64O1(slotBase + trajOff.tO1!, dstO1Off, TRAJ_N);
        evaluateTrajectoryInto(
          pushFrame.tO1 as Float64Array,
          trajSchema.compiled.fields.find((f) => f.name === "tO1")!.trajectory!,
          dt,
          jsRefO1,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(
            dstO1View[k], jsRefO1[k],
            `pin9a tO1[${k}] row=${r} dt=${dt}`,
          );
        }
        // WASM o2: linear Taylor.
        trajConsumer.evalTaylorF64O2(slotBase + trajOff.tO2!, dstO2Off, TRAJ_N, dt);
        evaluateTrajectoryInto(
          pushFrame.tO2 as Float64Array,
          trajSchema.compiled.fields.find((f) => f.name === "tO2")!.trajectory!,
          dt,
          jsRefO2,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(
            dstO2View[k], jsRefO2[k],
            `pin9a tO2[${k}] row=${r} dt=${dt}`,
          );
        }
        // WASM o3: quadratic Taylor.
        trajConsumer.evalTaylorF64O3(slotBase + trajOff.tO3!, dstO3Off, TRAJ_N, dt);
        evaluateTrajectoryInto(
          pushFrame.tO3 as Float64Array,
          trajSchema.compiled.fields.find((f) => f.name === "tO3")!.trajectory!,
          dt,
          jsRefO3,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(
            dstO3View[k], jsRefO3[k],
            `pin9a tO3[${k}] row=${r} dt=${dt}`,
          );
        }
      }

      // Remember this slot's byte base for the upcoming Hermite pin —
      // shift curr → prev each iteration.
      prevSlotByteBase.val = currSlotByteBase.val;
      currSlotByteBase.val = slotBase;
      trajConsumer.commitPull();
    }
    ok(
      `wasm-taylor-f64-equivalence (${taylorRows} rows × ${dts.length} dts × 3 orders × ${TRAJ_N} samples)`,
    );

    // ── 9b: Hermite f64 equivalence across multiple (t, segmentSeconds) ──
    // Push fresh frames so we have two valid slots to Hermite between.
    // Re-fill the ring with two known rows, then iterate (t,
    // segmentSeconds) pairs without draining (the two frames stay
    // in-ring at known slots). Use Bridge.pull to inspect the slot
    // byte offsets indirectly — we recompute them from the readIdx
    // immediately after each peek so the consumer's eval call sees
    // the same bytes the JS reference reads.
    while (trajBridge.pull(pullFrame)) { /* drain */ }
    fillTrajectories(100);
    assert(trajBridge.push(pushFrame), "pin9b: push prev frame");
    // Snapshot the pushed values for the JS reference (since pushFrame
    // will be reused for the curr push below).
    const pushPrevO2 = new Float64Array(pushFrame.tO2 as Float64Array);
    const pushPrevO3 = new Float64Array(pushFrame.tO3 as Float64Array);
    fillTrajectories(101);
    assert(trajBridge.push(pushFrame), "pin9b: push curr frame");
    const pushCurrO2 = new Float64Array(pushFrame.tO2 as Float64Array);
    const pushCurrO3 = new Float64Array(pushFrame.tO3 as Float64Array);

    // The first peek returns the slot of the older (prev) frame; the
    // second peek (after commit) returns the curr frame.
    const prevSlot = trajConsumer.peekPull(mask);
    assert(prevSlot >= 0, "pin9b: peek prev");
    const prevBase = headerBytes + prevSlot * frameBytes;
    trajConsumer.commitPull();
    const currSlot = trajConsumer.peekPull(mask);
    assert(currSlot >= 0, "pin9b: peek curr");
    const currBase = headerBytes + currSlot * frameBytes;

    // Sweep Hermite eval coefficients over a representative set of
    // (t, segmentSeconds) pairs.
    const hermiteCases = [
      { t: 0.0, segS: 1 / 60 },
      { t: 0.25, segS: 1 / 60 },
      { t: 0.5, segS: 1 / 60 },
      { t: 0.75, segS: 1 / 60 },
      { t: 1.0, segS: 1 / 60 },
      { t: 0.3, segS: 0.001 },
    ];
    for (const { t, segS } of hermiteCases) {
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const h10s = h10 * segS;
      const h11s = h11 * segS;

      // WASM Hermite over order=2 trajectory
      trajConsumer.evalHermiteF64(
        prevBase + trajOff.tO2!,
        currBase + trajOff.tO2!,
        dstHermO2Off,
        TRAJ_N,
        2,
        h00, h10s, h01, h11s,
      );
      evaluateHermiteTrajectoryInto(
        pushPrevO2, pushCurrO2,
        trajSchema.compiled.fields.find((f) => f.name === "tO2")!.trajectory!,
        t, segS, jsRefHermO2,
      );
      for (let k = 0; k < TRAJ_N; k++) {
        assertEq(
          dstHermO2View[k], jsRefHermO2[k],
          `pin9b hermite-o2[${k}] t=${t} segS=${segS}`,
        );
      }

      // WASM Hermite over order=3 trajectory (acceleration lane ignored)
      trajConsumer.evalHermiteF64(
        prevBase + trajOff.tO3!,
        currBase + trajOff.tO3!,
        dstHermO3Off,
        TRAJ_N,
        3,
        h00, h10s, h01, h11s,
      );
      evaluateHermiteTrajectoryInto(
        pushPrevO3, pushCurrO3,
        trajSchema.compiled.fields.find((f) => f.name === "tO3")!.trajectory!,
        t, segS, jsRefHermO3,
      );
      for (let k = 0; k < TRAJ_N; k++) {
        assertEq(
          dstHermO3View[k], jsRefHermO3[k],
          `pin9b hermite-o3[${k}] t=${t} segS=${segS}`,
        );
      }
    }
    trajConsumer.commitPull();
    ok(
      `wasm-hermite-f64-equivalence (${hermiteCases.length} (t, segS) × 2 orders × ${TRAJ_N} samples)`,
    );
  }

  // ── 10: f32 trajectory evaluator equivalence (0.7.10) ──────────────────
  // Mirror of Pin 9 but using f32TrajectoryArray. Three Taylor orders
  // + Hermite, each evaluated against the JS evaluateTrajectoryInto /
  // evaluateHermiteTrajectoryInto reference. Bit-exact equality is
  // expected because the WASM evaluator demotes dt and the Hermite
  // basis coefficients to f32 ONCE per call (matching what a
  // Float32Array-bound JS evaluator does implicitly per store).
  {
    const TRAJ_N = 24;
    const trajSchema32 = defineSchema({
      seq: u64(),
      tO1: f32TrajectoryArray(TRAJ_N, { order: 1 }),
      tO2: f32TrajectoryArray(TRAJ_N, { order: 2 }),
      tO3: f32TrajectoryArray(TRAJ_N, { order: 3 }),
    });
    const trajCap32 = 4;
    const sabBytes32 = Bridge.byteLength(trajCap32, trajSchema32);
    // Scratch: 5 evaluators × TRAJ_N × 4 bytes
    const dstBytesEach = TRAJ_N * 4;
    const totalScratch32 = dstBytesEach * 5;
    const alloc32 = allocateWorkletMemory({
      sabBytes: sabBytes32,
      scratchBytes: totalScratch32,
    });
    const bridge32 = new Bridge(alloc32.sab, trajCap32, trajSchema32);
    const consumer32 = instantiateConsumer(wasmBytes, alloc32.memory);

    const headerBytes = 32;
    const frameBytes32 = trajSchema32.compiled.frameByteSize;
    const mask32 = trajCap32 - 1;
    const off32: Record<string, number> = {};
    for (const f of trajSchema32.compiled.fields) off32[f.name] = f.byteOffset;
    const scratchBase32 = alloc32.scratchByteOffset!;
    const dstO1Off32 = scratchBase32;
    const dstO2Off32 = dstO1Off32 + dstBytesEach;
    const dstO3Off32 = dstO2Off32 + dstBytesEach;
    const dstHermO2Off32 = dstO3Off32 + dstBytesEach;
    const dstHermO3Off32 = dstHermO2Off32 + dstBytesEach;
    const dstO1View32 = new Float32Array(alloc32.sab, dstO1Off32, TRAJ_N);
    const dstO2View32 = new Float32Array(alloc32.sab, dstO2Off32, TRAJ_N);
    const dstO3View32 = new Float32Array(alloc32.sab, dstO3Off32, TRAJ_N);
    const dstHermO2View32 = new Float32Array(alloc32.sab, dstHermO2Off32, TRAJ_N);
    const dstHermO3View32 = new Float32Array(alloc32.sab, dstHermO3Off32, TRAJ_N);

    const push32 = bridge32.scratchFrame();
    const pull32 = bridge32.scratchFrame();
    const jsO1_32 = new Float32Array(TRAJ_N);
    const jsO2_32 = new Float32Array(TRAJ_N);
    const jsO3_32 = new Float32Array(TRAJ_N);
    const jsHermO2_32 = new Float32Array(TRAJ_N);
    const jsHermO3_32 = new Float32Array(TRAJ_N);

    function fill32(row: number): void {
      const theta = 0.13 + row * 0.041;
      const omega = 2 * Math.PI * 3;
      for (let k = 0; k < TRAJ_N; k++) {
        push32.tO1[k] = Math.fround(Math.sin(k * theta));
      }
      for (let k = 0; k < TRAJ_N; k++) {
        push32.tO2[k * 2] = Math.fround(Math.sin(k * theta + row));
        push32.tO2[k * 2 + 1] = Math.fround(omega * Math.cos(k * theta + row));
      }
      for (let k = 0; k < TRAJ_N; k++) {
        push32.tO3[k * 3] = Math.fround(Math.cos(k * theta + row * 0.5));
        push32.tO3[k * 3 + 1] = Math.fround(-omega * Math.sin(k * theta + row * 0.5));
        push32.tO3[k * 3 + 2] = Math.fround(-omega * omega * Math.cos(k * theta + row * 0.5));
      }
    }

    while (bridge32.pull(pull32)) { /* drain */ }
    const taylorRows = 4;
    const dts = [0.0, 0.005, 0.012345, 0.0166667];
    for (let r = 0; r < taylorRows; r++) {
      fill32(r);
      assert(bridge32.push(push32), `pin10a: push row ${r}`);
      const slot = consumer32.peekPull(mask32);
      assert(slot >= 0, `pin10a: peekPull row ${r}`);
      const slotBase = headerBytes + slot * frameBytes32;
      for (const dt of dts) {
        consumer32.evalTaylorF32O1(slotBase + off32.tO1!, dstO1Off32, TRAJ_N);
        evaluateTrajectoryInto(
          push32.tO1 as Float32Array,
          trajSchema32.compiled.fields.find((f) => f.name === "tO1")!.trajectory!,
          dt,
          jsO1_32,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(dstO1View32[k], jsO1_32[k], `pin10a tO1[${k}] row=${r} dt=${dt}`);
        }
        consumer32.evalTaylorF32O2(slotBase + off32.tO2!, dstO2Off32, TRAJ_N, dt);
        evaluateTrajectoryInto(
          push32.tO2 as Float32Array,
          trajSchema32.compiled.fields.find((f) => f.name === "tO2")!.trajectory!,
          dt,
          jsO2_32,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(dstO2View32[k], jsO2_32[k], `pin10a tO2[${k}] row=${r} dt=${dt}`);
        }
        consumer32.evalTaylorF32O3(slotBase + off32.tO3!, dstO3Off32, TRAJ_N, dt);
        evaluateTrajectoryInto(
          push32.tO3 as Float32Array,
          trajSchema32.compiled.fields.find((f) => f.name === "tO3")!.trajectory!,
          dt,
          jsO3_32,
        );
        for (let k = 0; k < TRAJ_N; k++) {
          assertEq(dstO3View32[k], jsO3_32[k], `pin10a tO3[${k}] row=${r} dt=${dt}`);
        }
      }
      consumer32.commitPull();
    }
    ok(
      `wasm-taylor-f32-equivalence (${taylorRows} rows × ${dts.length} dts × 3 orders × ${TRAJ_N} samples)`,
    );

    // f32 Hermite sub-pin — two consecutive frames, several (t, segS) pairs.
    while (bridge32.pull(pull32)) { /* drain */ }
    fill32(100);
    assert(bridge32.push(push32), "pin10b: push prev");
    const pushPrevO2_32 = new Float32Array(push32.tO2 as Float32Array);
    const pushPrevO3_32 = new Float32Array(push32.tO3 as Float32Array);
    fill32(101);
    assert(bridge32.push(push32), "pin10b: push curr");
    const pushCurrO2_32 = new Float32Array(push32.tO2 as Float32Array);
    const pushCurrO3_32 = new Float32Array(push32.tO3 as Float32Array);

    const prevSlot32 = consumer32.peekPull(mask32);
    assert(prevSlot32 >= 0, "pin10b: peek prev");
    const prevBase32 = headerBytes + prevSlot32 * frameBytes32;
    consumer32.commitPull();
    const currSlot32 = consumer32.peekPull(mask32);
    assert(currSlot32 >= 0, "pin10b: peek curr");
    const currBase32 = headerBytes + currSlot32 * frameBytes32;

    const hermCases32 = [
      { t: 0.0, segS: 1 / 60 },
      { t: 0.5, segS: 1 / 60 },
      { t: 1.0, segS: 1 / 60 },
      { t: 0.3, segS: 0.001 },
    ];
    for (const { t, segS } of hermCases32) {
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10s = (t3 - 2 * t2 + t) * segS;
      const h01 = -2 * t3 + 3 * t2;
      const h11s = (t3 - t2) * segS;
      consumer32.evalHermiteF32(
        prevBase32 + off32.tO2!,
        currBase32 + off32.tO2!,
        dstHermO2Off32,
        TRAJ_N,
        2,
        h00, h10s, h01, h11s,
      );
      evaluateHermiteTrajectoryInto(
        pushPrevO2_32, pushCurrO2_32,
        trajSchema32.compiled.fields.find((f) => f.name === "tO2")!.trajectory!,
        t, segS, jsHermO2_32,
      );
      for (let k = 0; k < TRAJ_N; k++) {
        assertEq(dstHermO2View32[k], jsHermO2_32[k], `pin10b herm-o2[${k}] t=${t}`);
      }
      consumer32.evalHermiteF32(
        prevBase32 + off32.tO3!,
        currBase32 + off32.tO3!,
        dstHermO3Off32,
        TRAJ_N,
        3,
        h00, h10s, h01, h11s,
      );
      evaluateHermiteTrajectoryInto(
        pushPrevO3_32, pushCurrO3_32,
        trajSchema32.compiled.fields.find((f) => f.name === "tO3")!.trajectory!,
        t, segS, jsHermO3_32,
      );
      for (let k = 0; k < TRAJ_N; k++) {
        assertEq(dstHermO3View32[k], jsHermO3_32[k], `pin10b herm-o3[${k}] t=${t}`);
      }
    }
    consumer32.commitPull();
    ok(
      `wasm-hermite-f32-equivalence (${hermCases32.length} (t, segS) × 2 orders × ${TRAJ_N} samples)`,
    );
  }

  // ── 11: SIMD-vs-scalar order=2 Taylor equivalence (0.7.10) ─────────────
  // The f64x2 SIMD path is bit-identical to its scalar counterpart —
  // WebAssembly's spec disallows implicit FMA in either, and the
  // scalar f64 evaluator already runs all math in f64. The f32x4
  // SIMD path is NOT bit-identical to the scalar f32 evaluator
  // because the scalar version promotes f32 → f64 for the intermediate
  // math (to match JS's `Float32Array[i] * Number` semantics) while
  // SIMD `f32x4.mul` necessarily stays in f32. The two paths agree
  // to within 1 ULP at f32 precision — verified with a tight epsilon
  // below.
  //
  // The pin also covers sample-count edge cases that exercise the
  // scalar tail: a multiple of 4 (clean SIMD, no tail), a value with
  // a 1-3 sample tail (f32 path), and a value with a 0-1 sample tail
  // (f64 path). Same SOURCE bytes drive both implementations so any
  // shuffle misalignment surfaces instantly.
  {
    // Sample counts chosen to span the SIMD / tail boundary:
    //   17 — f32 SIMD does 4 chunks of 4 samples + 1 scalar tail sample.
    //        f64 SIMD does 8 chunks of 2 samples + 1 scalar tail sample.
    //   32 — clean multiple of 4 (no tail for either width).
    //   3  — too small for f32 SIMD (entire body is scalar tail);
    //        too small for f64 SIMD only at the trailing 1 sample.
    for (const N of [17, 32, 3]) {
      const simdSchemaF64 = defineSchema({
        traj: f64TrajectoryArray(N, { order: 2 }),
      });
      const simdSchemaF32 = defineSchema({
        traj: f32TrajectoryArray(N, { order: 2 }),
      });
      const cap = 4;
      const f64SabBytes = Bridge.byteLength(cap, simdSchemaF64);
      const f32SabBytes = Bridge.byteLength(cap, simdSchemaF32);
      const f64DstBytes = N * 8;
      const f32DstBytes = N * 4;

      // f64 SIMD-vs-scalar
      {
        const alloc = allocateWorkletMemory({
          sabBytes: f64SabBytes,
          scratchBytes: f64DstBytes * 2,
        });
        const bridge = new Bridge(alloc.sab, cap, simdSchemaF64);
        const consumer = instantiateConsumer(wasmBytes, alloc.memory);
        const headerBytes = 32;
        const frameBytes = simdSchemaF64.compiled.frameByteSize;
        const mask = cap - 1;
        const trajOff = simdSchemaF64.compiled.fields.find((f) => f.name === "traj")!.byteOffset;
        const scratchBase = alloc.scratchByteOffset!;
        const scalarOff = scratchBase;
        const simdOff = scratchBase + f64DstBytes;
        const scalarView = new Float64Array(alloc.sab, scalarOff, N);
        const simdView = new Float64Array(alloc.sab, simdOff, N);

        const pushFrame = bridge.scratchFrame();
        for (let k = 0; k < N; k++) {
          pushFrame.traj[k * 2] = Math.sin(k * 0.21 + 1);
          pushFrame.traj[k * 2 + 1] = Math.cos(k * 0.21 + 1) * 100;
        }
        assert(bridge.push(pushFrame), `pin11 f64 N=${N}: push`);
        const slot = consumer.peekPull(mask);
        assert(slot >= 0, `pin11 f64 N=${N}: peek`);
        const slotBase = headerBytes + slot * frameBytes;
        const dts = [0, 0.001, 0.016667];
        for (const dt of dts) {
          consumer.evalTaylorF64O2(slotBase + trajOff, scalarOff, N, dt);
          consumer.evalTaylorF64O2Simd(slotBase + trajOff, simdOff, N, dt);
          for (let k = 0; k < N; k++) {
            assertEq(simdView[k], scalarView[k], `pin11 f64 simd-vs-scalar [${k}] N=${N} dt=${dt}`);
          }
        }
        consumer.commitPull();
      }

      // f32 SIMD-vs-scalar — agreement within 1 ULP at f32 precision.
      // The scalar f32 path runs intermediate math in f64 (matching JS);
      // SIMD f32x4 stays in f32 — so values diverge by ≤ 0.5 ULP per
      // operation, accumulating to ~1 ULP after the mul + add chain.
      // F32_EPSILON_REL = 2^-23 ≈ 1.19e-7 is the per-value spacing for
      // f32 around magnitude 1; we use 4× that as a safe relative
      // tolerance to absorb compound rounding.
      {
        const alloc = allocateWorkletMemory({
          sabBytes: f32SabBytes,
          scratchBytes: f32DstBytes * 2,
        });
        const bridge = new Bridge(alloc.sab, cap, simdSchemaF32);
        const consumer = instantiateConsumer(wasmBytes, alloc.memory);
        const headerBytes = 32;
        const frameBytes = simdSchemaF32.compiled.frameByteSize;
        const mask = cap - 1;
        const trajOff = simdSchemaF32.compiled.fields.find((f) => f.name === "traj")!.byteOffset;
        const scratchBase = alloc.scratchByteOffset!;
        const scalarOff = scratchBase;
        const simdOff = scratchBase + f32DstBytes;
        const scalarView = new Float32Array(alloc.sab, scalarOff, N);
        const simdView = new Float32Array(alloc.sab, simdOff, N);

        const pushFrame = bridge.scratchFrame();
        for (let k = 0; k < N; k++) {
          pushFrame.traj[k * 2] = Math.fround(Math.sin(k * 0.21 + 1));
          pushFrame.traj[k * 2 + 1] = Math.fround(Math.cos(k * 0.21 + 1) * 100);
        }
        assert(bridge.push(pushFrame), `pin11 f32 N=${N}: push`);
        const slot = consumer.peekPull(mask);
        assert(slot >= 0, `pin11 f32 N=${N}: peek`);
        const slotBase = headerBytes + slot * frameBytes;
        const dts = [0, 0.001, 0.016667];
        // 4 × f32 epsilon = ~4.77e-7 relative tolerance
        const F32_TOL_REL = 4 * Math.pow(2, -23);
        for (const dt of dts) {
          consumer.evalTaylorF32O2(slotBase + trajOff, scalarOff, N, dt);
          consumer.evalTaylorF32O2Simd(slotBase + trajOff, simdOff, N, dt);
          for (let k = 0; k < N; k++) {
            const s = scalarView[k]!;
            const v = simdView[k]!;
            const tol = Math.max(Math.abs(s), Math.abs(v), 1) * F32_TOL_REL;
            assert(
              Math.abs(s - v) <= tol,
              `pin11 f32 simd-vs-scalar [${k}] N=${N} dt=${dt}: scalar=${s} simd=${v} |Δ|=${Math.abs(s - v)} > tol=${tol}`,
            );
          }
        }
        consumer.commitPull();
      }
    }
    ok(
      `wasm-simd-vs-scalar-equivalence (N ∈ {17, 32, 3} × 3 dts × f64 bit-exact + f32 within 4×ULP)`,
    );
  }

  // ── 12: Invariant lane decode equivalence (0.7.11) ──────────────────────
  // The final shape in the Track 2 cohort. Schemas built with
  // `.withInvariant(fn)` (0.6.0) carry a hidden `__invariant: f64` lane
  // at the end of each frame slot — the producer writes it on push
  // BEFORE the release-store on write_index; the consumer reads it on
  // pull BEFORE the release-store on read_index. Bridge runs the
  // heap-side classifier (raw or smoothed handler) AFTER the release-
  // store to decide ok / soft / hard.
  //
  // The WASM consumer already has `readF64` (0.7.7) sufficient to read
  // the f64 invariant from any byte offset. The missing piece was
  // visibility: `describeLayout()` did not expose
  // `invariantByteOffset`, so a worklet that only sees the layout JSON
  // (the canonical cross-thread descriptor) couldn't find the lane.
  // 0.7.11 surfaces `invariantByteOffset` on `SchemaLayoutDescription`
  // — additive, no SAB format change. This pin proves end-to-end that:
  //
  //   (a) `describeLayout().invariantByteOffset` is the same offset
  //       the JS Bridge writes/reads through.
  //   (b) A WASM `readF64` at that offset returns the value the
  //       schema's invariant fn computed on the producer side.
  //   (c) The agreement holds across multiple frames with varied
  //       payloads, exercising the invariant fn's full range.
  //
  // Test invariant: sum-of-squares of the f64 array field — a typical
  // shape for physical conservation-law checks (matches the existing
  // physicsControlFrameSchema invariant). Predictable, deterministic.
  {
    const N_ELEMS = 8;
    const invariantFn = (frame: { samples: Float64Array }): number => {
      let s = 0;
      for (let k = 0; k < N_ELEMS; k++) {
        const v = frame.samples[k]!;
        s += v * v;
      }
      return s;
    };
    const invSchema = defineSchema({
      seq: u64(),
      samples: f64Array(N_ELEMS),
    }).withInvariant(invariantFn);

    // The schema MUST have a non-null invariantByteOffset in its layout.
    // (`describeSchemaLayout` is the schema-side helper; Bridge exposes
    // the same shape via `bridge.describeLayout()` once constructed.)
    const layout = describeSchemaLayout(invSchema);
    assert(
      layout.invariantByteOffset !== null,
      "pin12: layout exposes invariantByteOffset for invariant-bearing schema",
    );
    assertEq(
      layout.invariantByteOffset! % 8,
      0,
      "pin12: invariantByteOffset is 8-aligned",
    );

    // Layout offset MUST match the compiled offset (the source of truth
    // the JS Bridge writes through). This is the cross-channel agreement
    // that lets a worklet trust the describeLayout JSON.
    assertEq(
      layout.invariantByteOffset,
      invSchema.compiled.invariantByteOffset,
      "pin12: layout offset === compiled offset",
    );

    const cap = 4;
    const sabBytes = Bridge.byteLength(cap, invSchema);
    const alloc = allocateWorkletMemory(sabBytes);
    const bridge = new Bridge(alloc.sab, cap, invSchema);
    const consumer = instantiateConsumer(wasmBytes, alloc.memory);
    const frameBytes = invSchema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = cap - 1;
    const invariantOff = layout.invariantByteOffset!;

    // Drive several frames with varied payloads so the invariant takes
    // varied values (including 0 — empty payload — which exercises the
    // absolute-epsilon floor path on the classifier side).
    const rows: ReadonlyArray<readonly number[]> = [
      [0, 0, 0, 0, 0, 0, 0, 0],                   // invariant = 0
      [1, 0, 0, 0, 0, 0, 0, 0],                   // invariant = 1
      [1, 1, 1, 1, 1, 1, 1, 1],                   // invariant = 8
      [0.5, -0.5, 2, -2, 3, -3, 0.1, -0.1],       // invariant = 0.5 + 0.5 + 4 + 4 + 9 + 9 + 0.01 + 0.01 = 27.02
      [1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-7], // invariant ≈ 8e-14 (subnormal-ish)
      [1e6, -1e6, 1e6, -1e6, 1e6, -1e6, 1e6, -1e6],     // invariant = 8e12
    ];

    const push = bridge.scratchFrame();
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      push.seq = BigInt(r);
      for (let k = 0; k < N_ELEMS; k++) push.samples[k] = row[k]!;
      assert(bridge.push(push), `pin12: push row ${r}`);

      // WASM peek + invariant read at the layout offset.
      const slot = consumer.peekPull(mask);
      assert(slot >= 0, `pin12: peekPull row ${r}`);
      const slotBase = headerBytes + slot * frameBytes;
      const wasmInvariant = consumer.readF64(slotBase + invariantOff);

      // JS-side oracle — recompute the invariant from the row payload.
      // The schema's invariant fn must produce this exact value (no
      // smoothing, no recovery — the producer's stored value is just
      // `compute(frame)` at push time).
      let expected = 0;
      for (let k = 0; k < N_ELEMS; k++) expected += row[k]! * row[k]!;
      assertEq(
        wasmInvariant,
        expected,
        `pin12: WASM invariant read row ${r} (expected sum-of-squares=${expected})`,
      );

      // Commit before next push so the ring doesn't fill (cap=4, rows=6).
      consumer.commitPull();
    }

    ok(
      `wasm-invariant-decode-equivalence (${rows.length} rows × N=${N_ELEMS} sum-of-squares; offset from describeLayout)`,
    );
  }

  // ── 13: Invariant lane returns null on no-invariant schema (0.7.11) ─────
  // The other half of the layout-API contract: a schema with NO
  // `.withInvariant(...)` MUST surface `invariantByteOffset: null` so
  // worklet callers can branch on presence without falling back to
  // checking the Schema object.
  {
    const plainSchema = defineSchema({ a: f64(), b: f64() });
    const plainLayout = describeSchemaLayout(plainSchema);
    assertEq(
      plainLayout.invariantByteOffset,
      null,
      "pin13: no-invariant schema layout exposes invariantByteOffset=null",
    );
    ok(`wasm-invariant-layout-null-for-plain-schema`);
  }

  console.log(
    "\nBridge.wasmEquivalence: WASM decoder reads SAB header + drives SPSC dance + decodes all 10 scalar kinds + bulk-copies array fields + evaluates f64/f32 Taylor/Hermite trajectories + SIMD-vectorized order=2 paths + invariant-lane f64 decode in agreement with JS atomics.",
  );
}

main();
