// worklet.js — the audio-rate consumer.
//
// Receives TWO SAB + describeLayout pairs through processorOptions:
//   - macroSab / macroLayout  → Bridge<MacroSchema>: slow envelope (filter cutoff, detune)
//   - inputSab / inputLayout  → Bridge<InputSchema>: discrete events from main thread
//
// Per quantum:
//   1. pullLatest the macro frame (freshness-wins — older macro state is stale).
//   2. pullAll the input events (each event matters — drain everything, FIFO).
//   3. For each sample 0..127:
//        a. apply any input events that landed at this sample offset (sub-sample placement)
//        b. advance voice envelopes
//        c. synthesize the saw output through the macro filter cutoff
//
// The worklet does NOT import the library. Both bridges are read via the
// JSON-safe describeLayout() byte-offset tables main passed through.

const MAX_VOICES = 8;
const EVENT_DRAIN_PER_QUANTUM = 32;

class FastLaneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    // ── Macro side ──────────────────────────────────────────────────────
    this.macroSab      = opts.macroSab;
    this.macroCapacity = opts.macroCapacity;
    this.macroMask     = this.macroCapacity - 1;
    this.macroLayout   = opts.macroLayout;
    this.macroIndices  = new Int32Array(this.macroSab, 0, 2);
    // Umbrella views for the macro schema's u64 + f64 fields.
    const mPayloadF64Elems = (this.macroCapacity * this.macroLayout.frameByteSize) / 8;
    this.macroU64 = new BigUint64Array(this.macroSab, this.macroLayout.headerBytes, mPayloadF64Elems);
    this.macroF64 = new Float64Array  (this.macroSab, this.macroLayout.headerBytes, mPayloadF64Elems);
    this.macroStride8     = this.macroLayout.frameByteSize / 8;
    this.macroSeqOff      = this.macroLayout.fields.seq.byteOffset / 8;
    this.macroTNsOff      = this.macroLayout.fields.tMacroNs.byteOffset / 8;
    this.macroCutoffOff   = this.macroLayout.fields.cutoffHz.byteOffset / 8;
    this.macroDetuneOff   = this.macroLayout.fields.detuneCents.byteOffset / 8;
    // Last-known-good macro state.
    this.cutoffHz    = 1500;
    this.detuneCents = 0;

    // ── Input side ──────────────────────────────────────────────────────
    this.inputSab      = opts.inputSab;
    this.inputCapacity = opts.inputCapacity;
    this.inputMask     = this.inputCapacity - 1;
    this.inputLayout   = opts.inputLayout;
    this.inputIndices  = new Int32Array(this.inputSab, 0, 2);
    const iPayloadBytes = this.inputCapacity * this.inputLayout.frameByteSize;
    this.inputU64 = new BigUint64Array(this.inputSab, this.inputLayout.headerBytes, iPayloadBytes / 8);
    this.inputU32 = new Uint32Array  (this.inputSab, this.inputLayout.headerBytes, iPayloadBytes / 4);
    this.inputF32 = new Float32Array (this.inputSab, this.inputLayout.headerBytes, iPayloadBytes / 4);
    this.inputStrideU64 = this.inputLayout.frameByteSize / 8;
    this.inputStrideU32 = this.inputLayout.frameByteSize / 4;
    this.inputSeqOff8       = this.inputLayout.fields.seq.byteOffset       / 8;
    this.inputTNsOff8       = this.inputLayout.fields.tInputNs.byteOffset  / 8;
    this.inputEventTypeOff4 = this.inputLayout.fields.eventType.byteOffset / 4;
    this.inputNoteOff4      = this.inputLayout.fields.noteOrCc.byteOffset  / 4;
    this.inputVelOff4       = this.inputLayout.fields.velocityI.byteOffset / 4;
    this.inputValueOff4     = this.inputLayout.fields.value.byteOffset     / 4;

    // Drained event scratch — fixed-size, reused across calls. Each entry
    // is one event read out of the SAB into heap memory so the SAB slot is
    // free to be overwritten by the producer immediately.
    this.events = new Array(EVENT_DRAIN_PER_QUANTUM);
    for (let i = 0; i < EVENT_DRAIN_PER_QUANTUM; i++) {
      this.events[i] = {
        seq: 0n,
        tInputNs: 0n,
        eventType: 0,
        noteOrCc: 0,
        velocityI: 0,
        value: 0,
        sampleOffset: 0,    // computed at drain time from tInputNs
      };
    }

    // ── Synth voices ────────────────────────────────────────────────────
    // Simple polyphonic saw + 1-pole low-pass. One voice per MIDI note.
    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices[i] = { note: -1, phase: 0, freq: 0, gain: 0, target: 0, lpf: 0 };
    }

    // ── Diagnostics ─────────────────────────────────────────────────────
    this.macroPulls = 0;
    this.inputDrained = 0;
    this.framesSinceReport = 0;
  }

  // pullLatest the macro frame. Returns true on update, false if no new
  // frame (last-known-good preserved).
  pullLatestMacro() {
    const readIdx = this.macroIndices[1];
    const writeIdx = Atomics.load(this.macroIndices, 0);
    if (writeIdx === readIdx) return false;
    const newestIdx = writeIdx - 1;
    const slot = newestIdx & this.macroMask;
    const base = slot * this.macroStride8;
    this.cutoffHz    = this.macroF64[base + this.macroCutoffOff];
    this.detuneCents = this.macroF64[base + this.macroDetuneOff];
    Atomics.store(this.macroIndices, 1, writeIdx);
    Atomics.notify(this.macroIndices, 1, 1);
    return true;
  }

  // pullAll the input lane. Drains every unread event into this.events[]
  // (up to EVENT_DRAIN_PER_QUANTUM); returns count.
  pullAllInput(quantumStartNs) {
    const readBase = this.inputIndices[1];
    const writeIdx = Atomics.load(this.inputIndices, 0);
    let count = (writeIdx - readBase) | 0;
    if (count <= 0) return 0;
    if (count > EVENT_DRAIN_PER_QUANTUM) count = EVENT_DRAIN_PER_QUANTUM;
    for (let i = 0; i < count; i++) {
      const readIdx = (readBase + i) | 0;
      const slot = readIdx & this.inputMask;
      const base8 = slot * this.inputStrideU64;
      const base4 = slot * this.inputStrideU32;
      const ev = this.events[i];
      ev.seq        = this.inputU64[base8 + this.inputSeqOff8];
      ev.tInputNs   = this.inputU64[base8 + this.inputTNsOff8];
      ev.eventType  = this.inputU32[base4 + this.inputEventTypeOff4];
      ev.noteOrCc   = this.inputU32[base4 + this.inputNoteOff4];
      ev.velocityI  = this.inputU32[base4 + this.inputVelOff4];
      ev.value      = this.inputF32[base4 + this.inputValueOff4];
      // Sub-sample placement: how many samples after quantum start should this
      // event take effect? Compute from the timestamp diff; clamp to the quantum.
      const tInputMs = Number(ev.tInputNs) * 1e-6;
      const qStartMs = quantumStartNs * 1e-6;
      const offsetSamples = Math.round((tInputMs - qStartMs) * 1e-3 * sampleRate);
      ev.sampleOffset = Math.max(0, Math.min(127, offsetSamples));
    }
    // Single trailing release-store + notify is sufficient — we consumed
    // `count` frames in one go, semantically equivalent to N back-to-back pulls
    // collapsed into one.
    Atomics.store(this.inputIndices, 1, (readBase + count) | 0);
    Atomics.notify(this.inputIndices, 1, 1);
    return count;
  }

  // Find a voice slot. Reuse a slot already playing this note (re-trigger),
  // else steal a free slot, else steal the quietest active voice.
  findVoiceSlot(note) {
    let free = -1;
    let quietest = 0;
    let quietestGain = Infinity;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.note === note) return i;
      if (v.note < 0 && free < 0) free = i;
      if (v.target < quietestGain) { quietestGain = v.target; quietest = i; }
    }
    return free >= 0 ? free : quietest;
  }

  applyEvent(ev) {
    const t = ev.eventType;
    if (t === 0) {
      // note-on
      const i = this.findVoiceSlot(ev.noteOrCc);
      const v = this.voices[i];
      v.note   = ev.noteOrCc;
      v.freq   = 440 * Math.pow(2, (ev.noteOrCc - 69) / 12);
      v.target = ev.velocityI / 127 * 0.4;
      // Don't reset phase on retrigger — clicks. Don't reset on cold start either; phase=0 is fine.
    } else if (t === 1) {
      // note-off
      for (let i = 0; i < MAX_VOICES; i++) {
        if (this.voices[i].note === ev.noteOrCc) {
          this.voices[i].target = 0;
        }
      }
    }
    // CC / paramSet not handled in this minimal demo synth.
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const len = out.length;

    // 1. Pull macro state.
    if (this.pullLatestMacro()) this.macroPulls++;

    // 2. Drain input events.
    const quantumStartNs = currentTime * 1e9;
    const eventCount = this.pullAllInput(quantumStartNs);
    this.inputDrained += eventCount;

    // Sort events by sampleOffset so we can iterate in lockstep with the
    // per-sample loop. (Insertion sort; eventCount is tiny.)
    for (let i = 1; i < eventCount; i++) {
      const ev = this.events[i];
      let j = i;
      while (j > 0 && this.events[j - 1].sampleOffset > ev.sampleOffset) {
        this.events[j] = this.events[j - 1];
        j--;
      }
      this.events[j] = ev;
    }

    // 3. Synthesis: walk samples 0..127, applying events at their offset.
    const cutoff = this.cutoffHz;
    const detuneRatio = Math.pow(2, this.detuneCents / 1200);
    // 1-pole LPF coefficient: a = exp(-2πf / sampleRate). Clamp for stability.
    const lpfA = Math.exp(-2 * Math.PI * Math.min(20000, Math.max(50, cutoff)) / sampleRate);
    const lpfB = 1 - lpfA;
    const twoOverSr = 2 / sampleRate;
    const gainSmooth = 0.001;   // gain slew per sample toward target

    let nextEventIdx = 0;
    for (let s = 0; s < len; s++) {
      // Apply any events scheduled at this sample offset.
      while (nextEventIdx < eventCount && this.events[nextEventIdx].sampleOffset <= s) {
        this.applyEvent(this.events[nextEventIdx]);
        nextEventIdx++;
      }
      // Sum saw oscillators per voice.
      let acc = 0;
      for (let i = 0; i < MAX_VOICES; i++) {
        const v = this.voices[i];
        // Slew gain toward target; deactivate voice when gain ~= target = 0.
        if (v.gain < v.target)      v.gain = Math.min(v.target, v.gain + gainSmooth);
        else if (v.gain > v.target) v.gain = Math.max(v.target, v.gain - gainSmooth);
        if (v.note < 0 && v.gain < 1e-5) continue;
        if (v.note >= 0 && v.target === 0 && v.gain < 1e-5) {
          v.note = -1; // voice released; free for steal
          continue;
        }
        const f = v.freq * detuneRatio;
        v.phase += f * twoOverSr;
        if (v.phase >= 1) v.phase -= 2;
        // Naive saw: phase ∈ [-1, 1]. Aliasing is fine for a demo.
        acc += v.phase * v.gain;
      }
      // 1-pole LPF.
      const filtered = lpfA * (this.voices[0]?.lpf ?? 0) + lpfB * acc;
      this.voices[0].lpf = filtered;
      out[s] = filtered;
    }

    // 4. Report ~4×/sec.
    this.framesSinceReport += len;
    if (this.framesSinceReport >= sampleRate / 4) {
      let active = 0;
      for (let i = 0; i < MAX_VOICES; i++) if (this.voices[i].note >= 0) active++;
      this.port.postMessage({
        type: "diag",
        macroPulls: this.macroPulls,
        inputDrained: this.inputDrained,
        activeVoices: active,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("fast-lane", FastLaneProcessor);
