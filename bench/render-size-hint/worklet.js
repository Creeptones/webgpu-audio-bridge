// worklet.js — a minimal probe processor for the renderSizeHint bench.
//
// It does nothing audible (writes silence). Its only job is to report, from
// inside the audio thread, the GROUND TRUTH of the render quantum:
//
//   - `blockLength`  — outputs[0][0].length, the actual sample count the UA
//     hands `process()` each callback. This is the real quantum, independent
//     of whatever `ctx.renderQuantumSize` claims on the main thread.
//   - `frameDelta`   — the increment of `currentFrame` between callbacks, an
//     independent cross-check of the quantum (should equal blockLength).
//   - `callbacks`    — how many process() calls were observed in the window.
//
// It posts one summary message after `REPORT_AFTER` callbacks, then keeps
// running silently. The main thread pairs this with `ctx.renderQuantumSize`
// to confirm the browser is actually rendering at the requested size.

const REPORT_AFTER = 64;

class RenderProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._calls = 0;
    this._lastFrame = -1;
    this._frameDelta = 0;
    this._blockLength = 0;
    this._reported = false;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out && out[0];
    if (ch0) {
      this._blockLength = ch0.length;
      // Write silence — this is a measurement harness, not a synth.
      ch0.fill(0);
    }
    if (this._lastFrame >= 0) {
      this._frameDelta = currentFrame - this._lastFrame;
    }
    this._lastFrame = currentFrame;
    this._calls++;

    if (!this._reported && this._calls >= REPORT_AFTER) {
      this._reported = true;
      this.port.postMessage({
        type: "probe",
        blockLength: this._blockLength,
        frameDelta: this._frameDelta,
        callbacks: this._calls,
        sampleRate,
        currentTime,
      });
    }
    return true; // keep the node alive
  }
}

registerProcessor("render-probe", RenderProbeProcessor);
