// worklet.js — the audio-rate consumer (audio-rate demo).
//
// Runs on the audio rendering thread. Imports `Bridge` + `BridgeBlockConsumer`
// from the library — modern ES module worklets support imports (Chrome 124+,
// Safari 18.4+, Firefox 144+; all evergreen browsers in 2026). The
// BridgeBlockConsumer's `process(out)` API is the canonical block-mode
// consumption pattern; the AudioWorkletProcessor.process() callback below
// is a one-liner against it.

import { Bridge, BridgeBlockConsumer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

class AudioRateBlockConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, blockSize } = options.processorOptions;

    // Construct a sibling Bridge over the same SAB. The producer-side
    // Bridge in the worker and this consumer-side Bridge see the same
    // bytes; they coordinate via the SPSC counter protocol in the ring
    // header. No postMessage on the audio thread after this constructor.
    const schema = makeSchema(blockSize);
    const bridge = new Bridge(sab, capacity, schema);

    this.consumer = new BridgeBlockConsumer(bridge, {
      underflowPolicy: "zero-fill",  // AudioWorklet's silence-on-stall idiom.
    });

    // Diagnostics — reported back to main ~4×/sec.
    this.lastReportFrames = 0;
    this.lastReportUnderflow = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (_e) => { /* no live config in this demo */ };
  }

  process(_inputs, outputs) {
    // The one-liner the helper exists for. process(out) fills the
    // 128-sample quantum with the next slice of audio, transparently
    // crossing producer-block boundaries every 8 quanta.
    this.consumer.process(outputs[0][0]);

    this.framesSinceReport += outputs[0][0].length;
    if (this.framesSinceReport >= sampleRate / 4) {
      const framesConsumed = this.consumer.framesConsumed();
      const underflowSamples = this.consumer.underflowSamples();
      this.port.postMessage({
        type: "diag",
        framesConsumed,
        underflowSamples,
      });
      this.lastReportFrames = framesConsumed;
      this.lastReportUnderflow = underflowSamples;
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("audio-rate-block-consumer", AudioRateBlockConsumer);
