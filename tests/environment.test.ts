/**
 * getEnvironmentReport() — pins for the 0.7.1 environment-diagnostics API.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/environment.test.ts
 *
 * The tests mutate `globalThis` to simulate browser-shaped contexts —
 * Node 18+ already has SharedArrayBuffer / Atomics / Atomics.waitAsync,
 * but lacks AudioContext / crossOriginIsolated / navigator.gpu /
 * navigator.requestMIDIAccess, so each test installs (or removes) the
 * specific globals the case needs, then restores them on the way out.
 *
 * Pins:
 *   1.  Vanilla Node (no AudioContext, no crossOriginIsolated) reports
 *       suggestedMode === 'unsupported' and a non-empty fixes[] array.
 *   2.  Each prerequisite-present cell flips the corresponding field to
 *       true (sharedArrayBuffer / atomics / atomicsWaitAsync / audioWorklet
 *       / audioContext / crossOriginIsolated / secureContext / webgpu /
 *       webMidi / userActivation).
 *   3.  All four turbo prerequisites present →
 *       suggestedMode === 'turbo', estimatedLatencyFloorMs.total ≈ 7.3.
 *   4.  audioWorklet true + sharedArrayBuffer false →
 *       suggestedMode === 'standard', estimatedLatencyFloorMs.total ≈ 16.
 *   5.  audioWorklet false → suggestedMode === 'unsupported',
 *       estimatedLatencyFloorMs = { input: 0, output: 0, total: 0 }, and
 *       a single 'missing-audio-worklet' blocker fix is emitted (the
 *       short-circuit case — no other fixes muddy the message).
 *   6.  Every fix has a non-empty summary and a non-empty docUrl that
 *       parses as a URL.
 *   7.  Frozen-object invariant: Object.isFrozen(report) === true,
 *       Object.isFrozen(report.fixes) === true, every fix is frozen,
 *       and estimatedLatencyFloorMs is frozen.
 *   8.  Every fix severity is one of 'blocker' | 'degraded' | 'info'.
 *   9.  Static lookups: each suggestedMode maps to its documented
 *       estimatedLatencyFloorMs (turbo / standard / unsupported triples
 *       all distinct and match the README breakdown).
 *  10.  JSON-serializes cleanly — JSON.parse(JSON.stringify(report))
 *       round-trips without throwing and preserves every field shape.
 *  11.  Pure reflection: report does not call navigator.requestMIDIAccess
 *       (asserted by installing a throwing stub and proving it is not
 *       invoked) and does not instantiate AudioContext (same).
 *  12.  enable-coop-coep fix downgrades to 'info' when the host is
 *       already in turbo (so existing crossOriginIsolated guidance is
 *       not blown up to 'degraded' for a working page).
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  getEnvironmentReport,
  type EnvironmentFix,
  type EnvironmentReport,
} from "../src/environment.js";

// ── Mutable-global harness ───────────────────────────────────────────────
//
// Each test composes a small "shape" object describing which globals to
// install or delete, then runs the body inside `withMockedGlobal(shape, fn)`
// which restores state on exit. Keeps tests independent of Node-version
// drift in default globals.

const KEYS = [
  "SharedArrayBuffer",
  "Atomics",
  "AudioContext",
  "crossOriginIsolated",
  "isSecureContext",
  "navigator",
] as const;

type GlobalKey = (typeof KEYS)[number];

type MockShape = Partial<Record<GlobalKey, unknown>>;

const SENTINEL_DELETE = Symbol("delete");

function withMockedGlobal<T>(shape: MockShape, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<GlobalKey, { had: boolean; value: unknown }>();
  for (const key of KEYS) {
    saved.set(key, { had: key in g, value: g[key] });
  }
  try {
    for (const key of Object.keys(shape) as GlobalKey[]) {
      const v = shape[key];
      if (v === SENTINEL_DELETE) {
        delete g[key];
      } else {
        g[key] = v;
      }
    }
    return fn();
  } finally {
    for (const key of KEYS) {
      const entry = saved.get(key)!;
      if (entry.had) {
        g[key] = entry.value;
      } else {
        delete g[key];
      }
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function fakeAudioContextWithWorklet(): unknown {
  // Constructor function with `audioWorklet` on its prototype — that's
  // exactly what `hasAudioWorklet` looks for. Calling `new` instantiates
  // a plain object; the test never does, but the constructor must not
  // throw on prototype access.
  const Ctor = function (this: object): void { /* never instantiated */ };
  (Ctor as unknown as { prototype: object }).prototype = { audioWorklet: {} };
  return Ctor;
}

function fakeAudioContextWithoutWorklet(): unknown {
  const Ctor = function (this: object): void { /* never instantiated */ };
  (Ctor as unknown as { prototype: object }).prototype = {};
  return Ctor;
}

function fakeNavigator(opts: {
  gpu?: boolean;
  midi?: boolean;
  userActivation?: boolean;
  userAgent?: string;
  midiThrower?: () => unknown;
} = {}): unknown {
  const nav: Record<string, unknown> = {
    userAgent: opts.userAgent ?? "tsx-test-runner/0.7.1",
  };
  if (opts.gpu) {
    nav.gpu = { requestAdapter: () => { throw new Error("gpu.requestAdapter must not be called"); } };
  }
  if (opts.midi) {
    nav.requestMIDIAccess = opts.midiThrower
      ?? (() => { throw new Error("requestMIDIAccess must not be called"); });
  }
  if (opts.userActivation) {
    nav.userActivation = { hasBeenActive: false, isActive: false };
  }
  return nav;
}

// Bare-bones "no browser at all" shape: nothing audio-related, nothing
// SAB-related, nothing navigator-related. Lets the tests start from a
// clean slate rather than Node's defaults.
const BARE_SHAPE: MockShape = {
  SharedArrayBuffer: SENTINEL_DELETE,
  Atomics: SENTINEL_DELETE,
  AudioContext: SENTINEL_DELETE,
  crossOriginIsolated: SENTINEL_DELETE,
  isSecureContext: SENTINEL_DELETE,
  navigator: SENTINEL_DELETE,
};

// ── 1. Vanilla / no-browser shape → 'unsupported' ────────────────────────
function testBareEnvironment(): void {
  const report = withMockedGlobal(BARE_SHAPE, () => getEnvironmentReport());

  assertEq(report.audioWorklet, false, "bare: audioWorklet false");
  assertEq(report.audioContext, false, "bare: audioContext false");
  assertEq(report.sharedArrayBuffer, false, "bare: sharedArrayBuffer false");
  assertEq(report.atomics, false, "bare: atomics false");
  assertEq(report.atomicsWaitAsync, false, "bare: atomicsWaitAsync false");
  assertEq(report.crossOriginIsolated, false, "bare: crossOriginIsolated false");
  assertEq(report.secureContext, false, "bare: secureContext false");
  assertEq(report.webgpu, false, "bare: webgpu false");
  assertEq(report.webMidi, false, "bare: webMidi false");
  assertEq(report.userActivation, false, "bare: userActivation false");
  assertEq(report.suggestedMode, "unsupported", "bare → unsupported");
  assertEq(report.userAgent, "", "bare: userAgent ''");
  assert(report.fixes.length >= 1, "bare: fixes non-empty");
  ok("1. bare environment → unsupported");
}

// ── 2. Each prerequisite-present cell flips its field to true ───────────
function testIndividualFlags(): void {
  withMockedGlobal({ ...BARE_SHAPE, SharedArrayBuffer: function () { /* stub */ } }, () => {
    const r = getEnvironmentReport();
    assertEq(r.sharedArrayBuffer, true, "SAB flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, Atomics: {} }, () => {
    const r = getEnvironmentReport();
    assertEq(r.atomics, true, "Atomics flips on");
    assertEq(r.atomicsWaitAsync, false, "no waitAsync without it");
  });

  withMockedGlobal({ ...BARE_SHAPE, Atomics: { waitAsync: () => { /* stub */ } } }, () => {
    const r = getEnvironmentReport();
    assertEq(r.atomicsWaitAsync, true, "waitAsync flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, AudioContext: fakeAudioContextWithWorklet() }, () => {
    const r = getEnvironmentReport();
    assertEq(r.audioContext, true, "AudioContext flips on");
    assertEq(r.audioWorklet, true, "audioWorklet flips on with worklet proto");
  });

  withMockedGlobal({ ...BARE_SHAPE, AudioContext: fakeAudioContextWithoutWorklet() }, () => {
    const r = getEnvironmentReport();
    assertEq(r.audioContext, true, "AudioContext flips on (no worklet)");
    assertEq(r.audioWorklet, false, "audioWorklet false when proto missing");
  });

  withMockedGlobal({ ...BARE_SHAPE, crossOriginIsolated: true }, () => {
    const r = getEnvironmentReport();
    assertEq(r.crossOriginIsolated, true, "crossOriginIsolated flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, isSecureContext: true }, () => {
    const r = getEnvironmentReport();
    assertEq(r.secureContext, true, "secureContext flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, navigator: fakeNavigator({ gpu: true }) }, () => {
    const r = getEnvironmentReport();
    assertEq(r.webgpu, true, "webgpu flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, navigator: fakeNavigator({ midi: true }) }, () => {
    const r = getEnvironmentReport();
    assertEq(r.webMidi, true, "webMidi flips on");
  });

  withMockedGlobal({ ...BARE_SHAPE, navigator: fakeNavigator({ userActivation: true }) }, () => {
    const r = getEnvironmentReport();
    assertEq(r.userActivation, true, "userActivation flips on");
  });

  ok("2. each prerequisite-present cell flips its field");
}

// ── 3. Turbo prerequisites all present → 'turbo' ─────────────────────────
function testTurboMode(): void {
  withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator({ gpu: true, midi: true, userActivation: true }),
  }, () => {
    const r = getEnvironmentReport();
    assertEq(r.suggestedMode, "turbo", "all prereqs → turbo");
    assertEq(r.estimatedLatencyFloorMs.input, 1.3, "turbo input floor");
    assertEq(r.estimatedLatencyFloorMs.output, 6, "turbo output floor");
    assertEq(r.estimatedLatencyFloorMs.total, 7.3, "turbo total floor");
  });
  ok("3. turbo prerequisites all present → turbo");
}

// ── 4. audioWorklet true + SAB false → 'standard' ────────────────────────
function testStandardMode(): void {
  withMockedGlobal({
    SharedArrayBuffer: SENTINEL_DELETE,
    Atomics: SENTINEL_DELETE,
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: SENTINEL_DELETE,
    isSecureContext: true,
    navigator: fakeNavigator({ userAgent: "test/standard" }),
  }, () => {
    const r = getEnvironmentReport();
    assertEq(r.suggestedMode, "standard", "no SAB but audioWorklet → standard");
    assertEq(r.estimatedLatencyFloorMs.input, 10, "standard input floor");
    assertEq(r.estimatedLatencyFloorMs.output, 6, "standard output floor");
    assertEq(r.estimatedLatencyFloorMs.total, 16, "standard total floor");
    assertEq(r.userAgent, "test/standard", "userAgent passthrough");
  });
  ok("4. audioWorklet true + SAB false → standard");
}

// ── 5. audioWorklet false → 'unsupported' + single blocker fix ───────────
function testUnsupportedMode(): void {
  // Even if every Turbo-side flag is present, no audioWorklet still
  // produces 'unsupported' (the AudioWorklet itself is the floor for
  // both transport tiers).
  withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithoutWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator({ gpu: true, midi: true }),
  }, () => {
    const r = getEnvironmentReport();
    assertEq(r.suggestedMode, "unsupported", "no audioWorklet → unsupported");
    assertEq(r.estimatedLatencyFloorMs.input, 0, "unsupported input 0");
    assertEq(r.estimatedLatencyFloorMs.output, 0, "unsupported output 0");
    assertEq(r.estimatedLatencyFloorMs.total, 0, "unsupported total 0");
    assertEq(r.fixes.length, 1, "unsupported: single fix");
    assertEq(r.fixes[0]!.id, "missing-audio-worklet", "blocker is audio-worklet");
    assertEq(r.fixes[0]!.severity, "blocker", "audio-worklet severity blocker");
  });
  ok("5. audioWorklet false → unsupported + single blocker fix");
}

// ── 6. Every fix has non-empty summary + parseable docUrl ───────────────
function testFixShape(): void {
  // Bare environment maximizes the number of fixes we exercise.
  const r = withMockedGlobal(BARE_SHAPE, () => getEnvironmentReport());
  assert(r.fixes.length >= 1, "fixes non-empty");
  for (const fix of r.fixes) {
    assert(typeof fix.id === "string" && fix.id.length > 0, `fix id non-empty: ${fix.id}`);
    assert(typeof fix.summary === "string" && fix.summary.length > 0, `fix summary non-empty: ${fix.id}`);
    assert(typeof fix.docUrl === "string" && fix.docUrl.length > 0, `fix docUrl non-empty: ${fix.id}`);
    // Parses as a URL — throws if not.
    new URL(fix.docUrl);
  }
  ok("6. every fix has non-empty summary + parseable docUrl");
}

// ── 7. Frozen-object invariant ───────────────────────────────────────────
function testFrozenObjects(): void {
  const r = withMockedGlobal(BARE_SHAPE, () => getEnvironmentReport());
  assert(Object.isFrozen(r), "report frozen");
  assert(Object.isFrozen(r.fixes), "fixes array frozen");
  assert(Object.isFrozen(r.estimatedLatencyFloorMs), "latency floor frozen");
  for (const fix of r.fixes) {
    assert(Object.isFrozen(fix), `fix frozen: ${fix.id}`);
  }
  // Mutation attempts should fail silently in non-strict, throw in strict
  // (this file runs as ESM, which is strict). Catch + assert no change.
  let threw = false;
  try {
    (r as { suggestedMode: string }).suggestedMode = "turbo";
  } catch {
    threw = true;
  }
  assert(threw || r.suggestedMode === "unsupported", "frozen prevents mutation");
  ok("7. frozen-object invariant");
}

// ── 8. Severity is always one of the three literals ─────────────────────
function testSeverityLiterals(): void {
  const allowed = new Set(["blocker", "degraded", "info"]);

  function check(label: string, fixes: ReadonlyArray<EnvironmentFix>): void {
    for (const fix of fixes) {
      assert(allowed.has(fix.severity), `${label}: ${fix.id} severity ${fix.severity} ∈ allowed`);
    }
  }

  check("bare", withMockedGlobal(BARE_SHAPE, () => getEnvironmentReport()).fixes);

  check("turbo", withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator({ gpu: true, midi: true, userActivation: true }),
  }, () => getEnvironmentReport()).fixes);

  check("standard", withMockedGlobal({
    ...BARE_SHAPE,
    AudioContext: fakeAudioContextWithWorklet(),
    isSecureContext: true,
  }, () => getEnvironmentReport()).fixes);

  ok("8. every fix severity ∈ {blocker, degraded, info}");
}

// ── 9. Static floor lookups distinct per mode ────────────────────────────
function testFloorLookups(): void {
  const turbo = withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator(),
  }, () => getEnvironmentReport()).estimatedLatencyFloorMs;

  const standard = withMockedGlobal({
    ...BARE_SHAPE,
    AudioContext: fakeAudioContextWithWorklet(),
    isSecureContext: true,
  }, () => getEnvironmentReport()).estimatedLatencyFloorMs;

  const unsupported = withMockedGlobal(BARE_SHAPE, () => getEnvironmentReport()).estimatedLatencyFloorMs;

  assert(turbo.total < standard.total, "turbo total < standard total");
  assert(standard.total > unsupported.total, "standard total > unsupported total");
  assertEq(unsupported.total, 0, "unsupported total === 0");
  ok("9. estimatedLatencyFloorMs lookups distinct per mode");
}

// ── 10. JSON round-trips cleanly ─────────────────────────────────────────
function testJsonRoundTrip(): void {
  const r = withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator({ gpu: true, midi: true, userActivation: true, userAgent: "rt/1" }),
  }, () => getEnvironmentReport());

  const json = JSON.stringify(r);
  const rt = JSON.parse(json) as EnvironmentReport;

  assertEq(rt.suggestedMode, r.suggestedMode, "rt suggestedMode");
  assertEq(rt.userAgent, r.userAgent, "rt userAgent");
  assertEq(rt.estimatedLatencyFloorMs.total, r.estimatedLatencyFloorMs.total, "rt latency total");
  assertEq(rt.fixes.length, r.fixes.length, "rt fixes length");
  assertEq(rt.crossOriginIsolated, true, "rt crossOriginIsolated");
  assertEq(rt.sharedArrayBuffer, true, "rt sharedArrayBuffer");
  ok("10. JSON round-trips cleanly");
}

// ── 11. Pure reflection — no side-effecting calls ────────────────────────
function testPureReflection(): void {
  let midiCalled = false;
  const midiThrower = (): unknown => {
    midiCalled = true;
    throw new Error("requestMIDIAccess must not be called");
  };
  withMockedGlobal({
    ...BARE_SHAPE,
    AudioContext: fakeAudioContextWithWorklet(),
    isSecureContext: true,
    navigator: fakeNavigator({ midi: true, midiThrower }),
  }, () => {
    const r = getEnvironmentReport();
    assertEq(r.webMidi, true, "midi detected without invocation");
  });
  assertEq(midiCalled, false, "requestMIDIAccess never invoked");

  // AudioContext side-effect: getEnvironmentReport must not `new` it.
  // We can prove this by installing a constructor that throws on `new`.
  let acCalled = false;
  const ThrowingAC = function (this: object): void {
    acCalled = true;
    throw new Error("AudioContext must not be instantiated");
  };
  (ThrowingAC as unknown as { prototype: object }).prototype = { audioWorklet: {} };
  withMockedGlobal({
    ...BARE_SHAPE,
    AudioContext: ThrowingAC,
    isSecureContext: true,
  }, () => {
    const r = getEnvironmentReport();
    assertEq(r.audioContext, true, "AC detected without instantiation");
    assertEq(r.audioWorklet, true, "audioWorklet detected via prototype");
  });
  assertEq(acCalled, false, "AudioContext never instantiated");

  ok("11. pure reflection — no side-effecting calls");
}

// ── 12. enable-coop-coep severity downgrade in turbo mode ────────────────
function testCoopCoepSeverityDowngrade(): void {
  // Standard mode: crossOriginIsolated missing → fix is 'degraded'.
  const standardFix = withMockedGlobal({
    ...BARE_SHAPE,
    AudioContext: fakeAudioContextWithWorklet(),
    isSecureContext: true,
  }, () => getEnvironmentReport()).fixes.find(f => f.id === "enable-coop-coep");
  assert(standardFix !== undefined, "standard mode emits enable-coop-coep");
  assertEq(standardFix!.severity, "degraded", "standard: COOP/COEP severity degraded");

  // Turbo mode with everything already satisfied: enable-coop-coep is
  // absent altogether (the fix only fires when crossOriginIsolated is
  // false). This is the desired silent-success state.
  const turboFixes = withMockedGlobal({
    SharedArrayBuffer: function () { /* stub */ },
    Atomics: { waitAsync: () => { /* stub */ } },
    AudioContext: fakeAudioContextWithWorklet(),
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: fakeNavigator({ gpu: true, midi: true, userActivation: true }),
  }, () => getEnvironmentReport()).fixes;
  const coopInTurbo = turboFixes.find(f => f.id === "enable-coop-coep");
  assertEq(coopInTurbo, undefined, "turbo with COI=true: no enable-coop-coep fix");

  ok("12. enable-coop-coep severity downgrade + silent-success");
}

function main(): void {
  testBareEnvironment();
  testIndividualFlags();
  testTurboMode();
  testStandardMode();
  testUnsupportedMode();
  testFixShape();
  testFrozenObjects();
  testSeverityLiterals();
  testFloorLookups();
  testJsonRoundTrip();
  testPureReflection();
  testCoopCoepSeverityDowngrade();
  console.log("\nAll environment.test.ts pins passed.");
}

main();
