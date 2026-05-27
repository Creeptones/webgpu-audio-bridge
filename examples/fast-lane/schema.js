// schema.js — TWO schemas, the headline of this demo.
//
// The fast-lane pattern carves gestural input off the GPU macro path onto
// its own dedicated bridge:
//
//   Bridge<MacroSchema>  ← Worker (slow modulator) → AudioWorklet
//   Bridge<InputSchema>  ← Main thread (key/click)  → AudioWorklet
//
// Both bridges share the AudioWorklet, which combines them: macro state
// shapes the synth's timbre slowly, input events fire notes immediately.

import {
  defineSchema,
  f32,
  f64,
  u32,
  u64,
} from "../../dist/index.js";

// Macro: slow-evolving carrier frequency + filter cutoff. 60 Hz cadence.
// Identical shape to the minimal demo's macro frame — kept tiny so the
// demo focuses on the input lane, not the macro side.
export function makeMacroSchema() {
  return defineSchema({
    seq:        u64(),
    tMacroNs:   u64(),
    cutoffHz:   f64(),
    detuneCents: f64(),
  });
}

// Input event: one frame per discrete user action. Canonical MIDI-shaped
// payload — see README §Achieving pro-audio tracking latency.
//
//   eventType:
//     0 = note-on    (noteOrCc = MIDI note, velocityI = 0..127)
//     1 = note-off   (noteOrCc = MIDI note)
//     2 = cc         (noteOrCc = controller#, value = 0..1)
//     3 = paramSet   (noteOrCc = paramId,   value = arbitrary)
export function makeInputSchema() {
  return defineSchema({
    seq:        u64(),
    tInputNs:   u64(),
    eventType:  u32(),
    noteOrCc:   u32(),
    velocityI:  u32(),
    value:      f32(),
  });
}

// Sizing constants. Macro at 16 slots @ 60 Hz buffers ~266 ms of state.
// Input at 64 slots covers worst-case key chords + CC bursts without ever
// reaching the back-pressure path.
export const MACRO_CAPACITY = 16;
export const INPUT_CAPACITY = 64;

// Audio worklet drain budget per quantum. 32 is well above what a human can
// physically produce in 2.67 ms (a 10-finger chord plus a few CCs is < 20).
export const EVENT_DRAIN_PER_QUANTUM = 32;
