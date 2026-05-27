// main.js — page main thread.
//
// Responsibilities:
//   1. Confirm crossOriginIsolated (SAB requires it).
//   2. Allocate TWO Bridges — macro (slow envelope) + input (fast events).
//   3. Spawn the macro worker, hand it the macro SAB.
//   4. Construct the AudioContext at latencyHint: 'interactive', load the
//      worklet, pass BOTH SABs + BOTH layouts via processorOptions.
//   5. Wire up the input lane:
//        - Computer keyboard → push note-on / note-off into Bridge<InputSchema>
//        - WebMIDI (if available) → push MIDI events
//        - On-screen keyboard pointer → push notes
//      Each event handler runs SYNCHRONOUSLY on the main thread and writes
//      to the SAB in ~1 µs. No postMessage hop = no event-loop latency.
//
// Why two different facades on the two bridges?
//   - Macro side uses Bridge<MacroSchema> (the canonical pulled-by-quantum
//     "freshest frame wins" path; matches the minimal demo).
//   - Input side uses BridgeInputLane / SpscRing<InputSchema> (the event-queue
//     path; pullAll on the worklet side drains EVERY unread frame because
//     events are discrete, not freshness-wins state).

import {
  Bridge,
  BridgeInputLane,
  SpscRing,
} from "../../dist/index.js";
import {
  MACRO_CAPACITY,
  INPUT_CAPACITY,
  makeMacroSchema,
  makeInputSchema,
} from "./schema.js";

const STATUS = document.getElementById("status");
const START  = document.getElementById("start");
const STOP   = document.getElementById("stop");
const KEYS   = document.getElementById("keys");
const EVENTS = document.getElementById("events");

const state = {
  ctx: null,
  node: null,
  worker: null,
  macroRing: null,    // Bridge<MacroSchema>
  inputRing: null,    // SpscRing<InputSchema>
  inputLane: null,    // BridgeInputLane<InputSchema> over inputRing
  inputFrame: null,
  running: false,
  lastReport: null,
  seqInput: 0n,
  activeKeys: new Set(),
  midi: null,
};

// QWERTY → MIDI note mapping. One octave A=C4 ... K=E5.
const KEY_MAP = {
  "a": 60, "w": 61, "s": 62, "e": 63, "d": 64, "f": 65, "t": 66, "g": 67, "y": 68, "h": 69, "u": 70, "j": 71, "k": 72,
};
const KEY_LABELS = [
  ["a", "C4", false], ["w", "C#4", true], ["s", "D4", false], ["e", "D#4", true], ["d", "E4", false],
  ["f", "F4", false], ["t", "F#4", true], ["g", "G4", false], ["y", "G#4", true], ["h", "A4", false],
  ["u", "A#4", true], ["j", "B4", false], ["k", "C5", false],
];

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(16, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

function renderKeys() {
  KEYS.innerHTML = "";
  for (const [key, label, black] of KEY_LABELS) {
    const el = document.createElement("div");
    el.className = `key${black ? " black" : ""}`;
    el.dataset.key = key;
    el.dataset.note = String(KEY_MAP[key]);
    el.textContent = `${key.toUpperCase()}\n${label}`;
    KEYS.appendChild(el);
  }
}

function appendEvent(text) {
  const div = document.createElement("div");
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="ts">${ts}</span>  ${text}`;
  EVENTS.insertBefore(div, EVENTS.firstChild);
  while (EVENTS.children.length > 50) EVENTS.removeChild(EVENTS.lastChild);
}

// ── The fast-lane write path ─────────────────────────────────────────────
//
// Three lines: stamp the timestamp, fill the fields, lane.push(). No
// postMessage, no event-loop hop, no allocations — straight SAB write that
// the AudioWorklet picks up on the next quantum.
function fireEvent(eventType, noteOrCc, velocityI, value) {
  if (!state.inputLane || !state.inputFrame) return;
  const ev = state.inputFrame;
  state.seqInput++;
  ev.seq        = state.seqInput;
  ev.tInputNs   = BigInt(Math.floor(performance.now() * 1e6));
  ev.eventType  = eventType;
  ev.noteOrCc   = noteOrCc;
  ev.velocityI  = velocityI;
  ev.value      = value;
  if (!state.inputLane.push(ev)) {
    appendEvent(`drop (lane full) — type=${eventType} note=${noteOrCc}`);
    return;
  }
  const tag = eventType === 0 ? "note-on" : eventType === 1 ? "note-off" : eventType === 2 ? "cc" : "trig";
  appendEvent(`${tag.padEnd(8)} note=${noteOrCc} vel=${velocityI}`);
}

function noteOn(midiNote, velocity) {
  if (state.activeKeys.has(midiNote)) return;
  state.activeKeys.add(midiNote);
  fireEvent(0, midiNote, velocity, velocity / 127);
  for (const el of KEYS.querySelectorAll(".key")) {
    if (Number(el.dataset.note) === midiNote) el.classList.add("active");
  }
}

function noteOff(midiNote) {
  if (!state.activeKeys.has(midiNote)) return;
  state.activeKeys.delete(midiNote);
  fireEvent(1, midiNote, 0, 0);
  for (const el of KEYS.querySelectorAll(".key")) {
    if (Number(el.dataset.note) === midiNote) el.classList.remove("active");
  }
}

async function start() {
  if (state.running) return;
  if (!isolationOk()) {
    setStatus([
      ["status", "FAILED — page is not crossOriginIsolated", "err"],
      ["fix",    "serve with COOP: same-origin + COEP: require-corp"],
    ]);
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setStatus([["status", "FAILED — SharedArrayBuffer unavailable", "err"]]);
    return;
  }

  START.disabled = true;
  setStatus([["status", "starting…"]]);

  // 1. Allocate BOTH bridge SABs.
  const macroSchema = makeMacroSchema();
  const inputSchema = makeInputSchema();
  const { sab: macroSab } = Bridge.allocate(MACRO_CAPACITY, macroSchema);
  const { sab: inputSab } = SpscRing.allocate(INPUT_CAPACITY, inputSchema);

  // Macro side: Bridge<MacroSchema> (canonical pulled-by-quantum path).
  state.macroRing = new Bridge(macroSab, MACRO_CAPACITY, macroSchema);
  const macroLayout = state.macroRing.describeLayout();

  // Input side: SpscRing<InputSchema> with a BridgeInputLane facade on the
  // main-thread producer side. The worklet constructs its own view on the
  // consumer side (inlined, no library import — see worklet.js).
  state.inputRing = new SpscRing(inputSab, INPUT_CAPACITY, inputSchema);
  state.inputLane = new BridgeInputLane(state.inputRing);
  state.inputFrame = state.inputLane.scratchFrame();
  const inputLayout = state.inputRing.describeLayout();

  // 2. Spawn the macro worker.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message}`, "err"]]);
  state.worker.postMessage({ type: "init", sab: macroSab, capacity: MACRO_CAPACITY });

  // 3. AudioContext at the tightest latencyHint.
  state.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "fast-lane", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      macroSab,
      macroCapacity: MACRO_CAPACITY,
      macroLayout,
      inputSab,
      inputCapacity: INPUT_CAPACITY,
      inputLayout,
    },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false;
  render();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  STOP.disabled = true;
  START.disabled = false;
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
  state.macroRing = null;
  state.inputRing = null;
  state.inputLane = null;
  state.inputFrame = null;
  state.activeKeys.clear();
  for (const el of KEYS.querySelectorAll(".key")) el.classList.remove("active");
  setStatus([["status", "stopped."]]);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "diag") {
    state.lastReport = { ...state.lastReport, ...m };
    render();
  } else if (m.type === "fatal") {
    setStatus([["status", `worker fatal: ${m.message}`, "err"]]);
    stop();
  }
}

function onWorkletMessage(e) {
  const m = e.data;
  if (m.type === "diag") {
    state.lastReport = { ...state.lastReport, ...m };
    render();
  }
}

function render() {
  const r = state.lastReport ?? {};
  const out = state.ctx?.outputLatency;
  setStatus([
    ["status", state.running ? "running" : "stopped", state.running ? "ok" : ""],
    ["outputLatency", out != null ? `${(out * 1000).toFixed(1)} ms` : "—"],
    ["baseLatency",   state.ctx?.baseLatency != null ? `${(state.ctx.baseLatency * 1000).toFixed(1)} ms` : "—"],
    ["macro pushes",  String(r.macroPushes ?? 0)],
    ["macro pulls",   String(r.macroPulls ?? 0)],
    ["input pushes",  String(state.seqInput)],
    ["input drained", String(r.inputDrained ?? 0)],
    ["active voices", String(r.activeVoices ?? 0)],
    ["MIDI",          state.midi ? "connected" : "not connected"],
  ]);
}

// ── Event bindings ────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (KEY_MAP[k] !== undefined) noteOn(KEY_MAP[k], 100);
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (KEY_MAP[k] !== undefined) noteOff(KEY_MAP[k]);
});

KEYS.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".key");
  if (!el) return;
  noteOn(Number(el.dataset.note), 100);
});
KEYS.addEventListener("pointerup", (e) => {
  const el = e.target.closest(".key");
  if (!el) return;
  noteOff(Number(el.dataset.note));
});
KEYS.addEventListener("pointercancel", (e) => {
  const el = e.target.closest(".key");
  if (!el) return;
  noteOff(Number(el.dataset.note));
});

// ── WebMIDI ───────────────────────────────────────────────────────────────
async function initMIDI() {
  if (!navigator.requestMIDIAccess) return;
  try {
    state.midi = await navigator.requestMIDIAccess();
    for (const input of state.midi.inputs.values()) input.onmidimessage = onMidiMessage;
    state.midi.onstatechange = (e) => {
      if (e.port?.type === "input" && e.port.state === "connected") {
        e.port.onmidimessage = onMidiMessage;
      }
    };
    render();
  } catch (e) {
    console.warn("MIDI init failed:", e);
  }
}

function onMidiMessage(e) {
  const [status, data1, data2] = e.data;
  const type = status >> 4;
  if (type === 9 && data2 > 0)                          noteOn(data1, data2);
  else if (type === 8 || (type === 9 && data2 === 0))   noteOff(data1);
  else if (type === 11)                                 fireEvent(2, data1, data2, data2 / 127);
}

// ── Boot ──────────────────────────────────────────────────────────────────
renderKeys();
START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);

setStatus([
  ["status",   "idle. press Start to run."],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB",      String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["WebMIDI",  String(typeof navigator.requestMIDIAccess !== "undefined"), typeof navigator.requestMIDIAccess !== "undefined" ? "ok" : ""],
]);

initMIDI();
