// worklet.gpu-block-replace.js — PATH C: GPU block-replace.
//
// The one-liner consumer: BridgeBlockConsumer.process(out) overwrites the
// 128-sample quantum with the next slice of the GPU-rendered FULL signal
// (fundamental + partials, computed in worker.gpu.js "full" mode). Underflow
// policy is 'zero-fill' — the AudioWorklet silence-on-stall idiom — which is
// exactly why C's stall continuity collapses to ~0 (audible click).
//
// ── Why C's control latency is the block-mode floor (~85 ms) ────────────────
//
// C has no CPU carrier: a pitch change only becomes audible once a GPU block
// COMPUTED at the new frequency has travelled the full ring depth and is
// consumed. So C's "apply" instant is NOT when the worklet first sees the freq
// event — it is the block boundary where the first new-freq samples land.
//
// The page still writes each freq change into the input lane (stamped with
// tInputNs) AND posts it to the worker so the GPU recomputes. This worklet
// drains the lane only to LEARN (targetFreq, tInputNs); it applies nothing to
// any carrier. The producer tags every block with the carrier freq it was
// computed at (frame.carrierFreq). When this consumer pulls a block whose
// carrierFreq matches a pending target, the first sample of that block is the
// audible apply instant, and we record (appliedEpochNs − tInputNs). Because the
// block has to cross the ring (capacity·blockSize/sampleRate ≈ 85 ms at D=4),
// that delta is the block-mode floor — the number that makes C lose the
// latency column.
//
// The scripted sweep fires DISTINCT freq values per event, so matching a
// landed block to its originating event by frequency is unambiguous.

import { Bridge, BridgeBlockConsumer, BridgeInputLane, SpscRing } from "../../dist/index.js";
import {
  EVENT_DRAIN_PER_QUANTUM,
  EVT_FREQ,
  makeInputSchema,
  makeSchema,
} from "./schema.js";
import { LatencyHistogram } from "./histogram.js";

const FREQ_EPS = 0.01; // Hz tolerance when matching a landed block to its event.

class GpuBlockReplaceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, blockSize, inputSab, inputCapacity, audioStartPerfMs } =
      options.processorOptions;

    const schema = makeSchema(blockSize);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, { underflowPolicy: "zero-fill" });

    const inputSchema = makeInputSchema();
    this.inputRing = new SpscRing(inputSab, inputCapacity, inputSchema);
    this.inputLane = new BridgeInputLane(this.inputRing);
    this.events = this.inputLane.scratchEventBuffer(EVENT_DRAIN_PER_QUANTUM);

    this.audioStartPerfNs = audioStartPerfMs * 1e6;
    this.hist = new LatencyHistogram();
    this.hasPerf = typeof performance !== "undefined" && typeof performance.now === "function";
    this.procHist = new LatencyHistogram();

    // Pending freq targets awaiting their block to land: {freq, tInputNs}.
    this.pending = [];
    this.lastBlockFreq = NaN;
    this.inputDrained = 0;

    this.enableRms = false;
    this.rmsSqAccum = 0;
    this.rmsSinceReport = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "rms-reset") { this.rmsSqAccum = 0; this.rmsSinceReport = 0; return; }
      if (m.type === "latency-reset") { this.hist.reset(); this.pending.length = 0; return; }
      if (m.type !== "config") return;
      if (typeof m.enableRms === "boolean") this.enableRms = m.enableRms;
    };
  }

  // Drain freq events into the pending-targets queue (no carrier to apply to).
  drainTargets() {
    const n = this.inputLane.pullAll(this.events);
    for (let i = 0; i < n; i++) {
      const ev = this.events[i];
      if (ev.eventType === EVT_FREQ) {
        this.pending.push({ freq: ev.value0, tInputNs: Number(ev.tInputNs) });
      }
    }
    this.inputDrained += n;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const tProc0 = this.hasPerf ? performance.now() : 0;
    this.drainTargets();

    const framesBefore = this.consumer.framesConsumed();
    this.consumer.process(out);
    const framesAfter = this.consumer.framesConsumed();

    // A fresh block was pulled this quantum (blockSize is a multiple of the
    // quantum, so at most one pull, and its first sample is this quantum's
    // first sample → apply instant = currentTime).
    if (framesAfter > framesBefore) {
      const blockFreq = this.consumer.frame.carrierFreq;
      if (!(Math.abs(blockFreq - this.lastBlockFreq) < FREQ_EPS)) {
        // Freq transition: match the oldest pending target at this frequency.
        for (let i = 0; i < this.pending.length; i++) {
          if (Math.abs(this.pending[i].freq - blockFreq) < FREQ_EPS) {
            const appliedEpochNs = this.audioStartPerfNs + currentTime * 1e9;
            this.hist.record(appliedEpochNs - this.pending[i].tInputNs);
            this.pending.splice(i, 1);
            break;
          }
        }
        this.lastBlockFreq = blockFreq;
      }
    }

    if (this.hasPerf) this.procHist.record((performance.now() - tProc0) * 1e6);

    if (this.enableRms) {
      let sq = 0;
      for (let i = 0; i < out.length; i++) { const x = out[i]; sq += x * x; }
      this.rmsSqAccum += sq;
      this.rmsSinceReport += out.length;
    }

    this.framesSinceReport += out.length;
    if (this.framesSinceReport >= sampleRate / 4) {
      const h = this.hist.snapshot();
      this.port.postMessage({
        type: "diag",
        path: "C",
        framesConsumed: this.consumer.framesConsumed(),
        underflowSamples: this.consumer.underflowSamples(),
        inputDrained: this.inputDrained,
        latency: h,
        procDuration: this.hasPerf ? this.procHist.snapshot() : null,
        rmsSqAccum: this.rmsSqAccum,
        rmsSinceReport: this.rmsSinceReport,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("comparator-gpu-block-replace", GpuBlockReplaceProcessor);
