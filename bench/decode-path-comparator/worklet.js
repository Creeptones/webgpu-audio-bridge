// worklet.js — the decode-path comparator, running on the real audio thread.
//
// Standalone (no library import on the audio thread). The main thread hands it
// everything via processorOptions:
//   - sab            : the SharedArrayBuffer (also memory.buffer)
//   - memory         : the WebAssembly.Memory wrapping that SAB (shared)
//   - wasmBytes      : ArrayBuffer of /dist/worklet/decoder.wasm
//   - layout         : Bridge.describeLayout() JSON (offsets for the A2 path)
//   - readerSrc      : emitWorkletReader() source string (the B path)
//   - descPtr/descCount : the C path's descriptor table location in WASM memory
//   - decodedFields  : C path scratch read offsets (name → {byteOffset,length,kind})
//
// Each process() call: find the newest ring slot, then run each decode strategy
// R times, timing each strategy's batch with performance.now() and recording
// ns/decode into a per-strategy histogram. We do NOT commit read_index — this
// is a decode microbench, not a correctness consumer; the producer force-drains
// so fresh bytes keep arriving. Bit-exactness is pinned elsewhere
// (tests/Bridge.wasmEquivalence pin 16 + the Stage-1 browser equivalence spec).
//
// A faint tone derived from the decoded vMax is written to the output so (a)
// the results are observably used (no dead-code elimination) and (b) the
// worklet carries a realistic audio load while measuring.

import { DurationHistogram } from "./histogram.js";

const HEADER = 32;
const R = 64; // decodes per strategy per quantum (averaged → one histogram sample)

class DecodeComparator extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.sab = o.sab;
    this.frameByteSize = o.frameByteSize;
    this.capacity = o.capacity;
    this.mask = o.capacity - 1;
    this.layout = o.layout;

    this.indices = new Int32Array(this.sab, 0, 8);

    // ── A2: umbrella views + element offsets ────────────────────────────────
    this.f64 = new Float64Array(this.sab);
    this.f32 = new Float32Array(this.sab);
    this.u32 = new Uint32Array(this.sab);
    this.i32 = new Int32Array(this.sab);
    this.big = new BigUint64Array(this.sab);
    this.stride8 = this.frameByteSize / 8;
    const fo = this.layout.fields;
    this.eo = {
      seq: fo.seq.byteOffset / 8, tNs: fo.tMacroNs.byteOffset / 8,
      vMax: fo.vMax.byteOffset / 8, jMax: fo.jMax.byteOffset / 8,
      flags: fo.flags.byteOffset / 4, mode: fo.mode.byteOffset / 4,
      vEff: fo.vEff.byteOffset / 8, gEff: fo.gEff.byteOffset / 4, traj: fo.traj.byteOffset / 8,
    };
    this.aN = fo.vEff.length; this.tN = fo.traj.length;
    // A2 output target (allocate once)
    this.outA = { vEff: new Float64Array(this.aN), gEff: new Float32Array(this.aN), traj: new Float64Array(this.tN) };

    // ── B: codegen-JS reader ────────────────────────────────────────────────
    this.dview = new DataView(this.sab);
    // eslint-disable-next-line no-new-func
    this.reader = new Function(`${o.readerSrc}\nreturn readFrame;`)();
    this.outB = {
      seq: 0n, tMacroNs: 0n, vMax: 0, jMax: 0, flags: 0, mode: 0,
      vEff: new Float64Array(this.aN), gEff: new Float32Array(this.aN), traj: new Float64Array(this.tN),
    };

    // ── C: WASM decodeFrame ─────────────────────────────────────────────────
    this.descPtr = o.descPtr; this.descCount = o.descCount;
    this.wasmReady = false;
    try {
      const mod = new WebAssembly.Module(o.wasmBytes);
      const inst = new WebAssembly.Instance(mod, { env: { memory: o.memory } });
      this.decodeFrame = inst.exports.decode_frame;
      // scratch read view to touch the result (defeat DCE)
      this.scVMax = new Float64Array(this.sab, o.decodedFields.vMax.byteOffset, 1);
      this.wasmReady = true;
    } catch (err) {
      this.port.postMessage({ type: "error", where: "wasm-instantiate", message: String(err) });
    }

    this.hA = new DurationHistogram();
    this.hB = new DurationHistogram();
    this.hC = new DurationHistogram();
    this.phase = 0;
    this.lastVMax = 0;
    this.quanta = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "reset") { this.hA.reset(); this.hB.reset(); this.hC.reset(); }
    };
  }

  newestSlotBase() {
    const readIdx = this.indices[1];
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx === readIdx) return -1;
    const slot = ((writeIdx - 1) | 0) & this.mask;
    return HEADER + slot * this.frameByteSize;
  }

  decodeA2(slot8) {
    const o = this.outA, eo = this.eo;
    this.lastVMax = this.f64[slot8 + eo.vMax];
    void this.big[slot8 + eo.seq]; void this.big[slot8 + eo.tNs];
    void this.f64[slot8 + eo.jMax];
    void this.u32[(slot8 * 2) + eo.flags]; void this.i32[(slot8 * 2) + eo.mode];
    for (let k = 0; k < this.aN; k++) o.vEff[k] = this.f64[slot8 + eo.vEff + k];
    for (let k = 0; k < this.aN; k++) o.gEff[k] = this.f32[(slot8 * 2) + eo.gEff + k];
    for (let k = 0; k < this.tN; k++) o.traj[k] = this.f64[slot8 + eo.traj + k];
  }

  process(_in, outputs) {
    const slotBase = this.newestSlotBase();
    if (slotBase >= 0) {
      const slot8 = slotBase / 8;
      // A2 — JS umbrella
      let t0 = performance.now();
      for (let r = 0; r < R; r++) this.decodeA2(slot8);
      this.hA.record(((performance.now() - t0) * 1e6) / R);

      // B — codegen-JS reader. reader(view, slot, out); slot index, not bytes.
      const slotIdx = ((this.indices[0] - 1) | 0) & this.mask;
      t0 = performance.now();
      for (let r = 0; r < R; r++) this.reader(this.dview, slotIdx, this.outB);
      this.hB.record(((performance.now() - t0) * 1e6) / R);
      if (slotBase >= 0) this.lastVMax = this.outB.vMax;

      // C — WASM decodeFrame
      if (this.wasmReady) {
        t0 = performance.now();
        for (let r = 0; r < R; r++) this.decodeFrame(slotBase, this.descPtr, this.descCount);
        this.hC.record(((performance.now() - t0) * 1e6) / R);
        this.lastVMax = this.scVMax[0];
      }
    }

    // Faint tone so the decoded value is used + the worklet carries a load.
    const out = outputs[0][0];
    const f = 110 + (Math.abs(this.lastVMax) % 220);
    const inc = (2 * Math.PI * f) / sampleRate;
    for (let s = 0; s < out.length; s++) {
      this.phase += inc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      out[s] = Math.sin(this.phase) * 0.02;
    }

    if (++this.quanta >= 30) {
      this.quanta = 0;
      this.port.postMessage({
        type: "report",
        A: this.hA.snapshot(), B: this.hB.snapshot(), C: this.hC.snapshot(),
        wasm: this.wasmReady,
      });
    }
    return true;
  }
}

registerProcessor("decode-comparator", DecodeComparator);
