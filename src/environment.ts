/**
 * Environment diagnostics — `getEnvironmentReport()` (0.7.1).
 *
 * A synchronous, side-effect-free reflection of `globalThis` that answers
 * the question "can this page run Turbo mode, Standard mode, or neither?"
 * and emits an actionable list of fixes for whatever is missing.
 *
 * Deliberately **disjoint** from `Bridge<S>.telemetry()`:
 *
 *   - `telemetry()` is a *runtime* snapshot of one Bridge instance —
 *     occupancy, torn frames, flow-scale, PLL state. It assumes the
 *     environment already supports SAB; it tells you what the ring is
 *     doing right now.
 *
 *   - `getEnvironmentReport()` is a *platform* snapshot of the host —
 *     COOP/COEP, SAB, Atomics, AudioWorklet, WebGPU. It tells you what
 *     the browser even allows you to attempt. Calling it before
 *     constructing a Bridge is the supported pattern.
 *
 * The report is intentionally limited to **feature detection** —
 * `typeof globalThis.X`, `'X' in globalThis`, `'method' in Constructor.prototype`.
 * It MUST NOT:
 *
 *   - Call `navigator.requestMIDIAccess()` (prompts the user).
 *   - Instantiate `new AudioContext()` (costs hardware resources and may
 *     require a user activation gesture first).
 *   - `fetch()` anything, time anything, sniff `navigator.userAgent`
 *     for a browser-detect regex.
 *
 * The `userAgent` field IS captured raw — but only because copy-pasting
 * it into a bug report is the single most useful thing a triage chain
 * can do. It is never parsed.
 *
 * The report is a frozen plain object so it JSON-serializes cleanly for
 * the future 0.7.4 dev-CLI HTTP probe and the 0.7.2 overlay widget.
 * No methods, no prototype, no Bridge dependency.
 */

/** Result of a single environment check, returned via `report.fixes`. */
export interface EnvironmentFix {
  /** Stable string id, suitable for testing + UI keying. */
  readonly id: string;
  /**
   * `'blocker'` — the suggested transport tier cannot run at all without
   * fixing this.
   *
   * `'degraded'` — the page can run a tier, but a meaningful capability
   * is unavailable (e.g. Turbo unavailable, falling back to Standard).
   *
   * `'info'` — non-blocking environmental note (e.g. WebGPU absent on a
   * page that may not need it; secure context missing on `file://`).
   */
  readonly severity: "blocker" | "degraded" | "info";
  /** Human-readable one-line summary. */
  readonly summary: string;
  /**
   * URL the consumer can show / open for guidance. README anchors are
   * stable across releases; external spec links are used when the README
   * doesn't yet cover the issue (e.g. cross-origin isolation MDN).
   */
  readonly docUrl: string;
}

/**
 * Best-case input-to-audible latency floor, in milliseconds, for the
 * suggested transport tier *without* a GPU readback step. Static lookup
 * seeded from README §Honest input → audible breakdown. Informational,
 * not measured — the consumer must run `bench/e2e-latency/` for ground
 * truth on their hardware.
 *
 * Decomposed into the two natural buckets in the README breakdown:
 *
 *   - `input`  — quantum-boundary delay between a producer push and the
 *     AudioWorklet's next `process()` callback (~1.3 ms avg at 48 kHz
 *     with the default 128-sample quantum).
 *
 *   - `output` — `AudioContext` output buffer + DAC, ~5-8 ms typical
 *     with `latencyHint: 'interactive'`.
 *
 *   - `total`  — `input + output`. Materialized rather than computed at
 *     call sites so the overlay can render one number without arithmetic.
 *
 * For `'standard'` mode, `input` includes a conservative estimate of
 * the MessageChannel + transferable-ArrayBuffer hop (5-50 ms typical;
 * 10 ms used as the floor for the estimate).
 *
 * For `'unsupported'` mode, all three are `0` — no transport can run.
 */
export interface EstimatedLatencyFloorMs {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

/**
 * Frozen, JSON-serializable snapshot of the host environment relative
 * to webgpu-audio-bridge's two transport tiers.
 */
export interface EnvironmentReport {
  /** `globalThis.crossOriginIsolated === true`. Required for Turbo. */
  readonly crossOriginIsolated: boolean;
  /** `typeof globalThis.SharedArrayBuffer === 'function'`. Required for Turbo. */
  readonly sharedArrayBuffer: boolean;
  /** `typeof globalThis.Atomics === 'object'`. Required for Turbo. */
  readonly atomics: boolean;
  /** `typeof Atomics?.waitAsync === 'function'`. Enables async backpressure. */
  readonly atomicsWaitAsync: boolean;
  /** `'audioWorklet' in AudioContext.prototype`. Required for both tiers. */
  readonly audioWorklet: boolean;
  /** `typeof globalThis.AudioContext === 'function'`. Required for both tiers. */
  readonly audioContext: boolean;
  /** `typeof navigator?.gpu?.requestAdapter === 'function'`. Does NOT request an adapter. */
  readonly webgpu: boolean;
  /** `typeof navigator?.requestMIDIAccess === 'function'`. Does NOT request access. */
  readonly webMidi: boolean;

  // ── Experimental capability flags (0.7.15+) ─────────────────────────────
  // The fields below sniff specs that have not stabilized AND no browser
  // ships today. They are surfaced flat (no nested `experimental: { ... }`
  // key) for zero-friction consumer code; the comment block here is the
  // visual grouping. Each returns `false` everywhere today.

  /**
   * Interface-presence sniff for the future W3C zero-copy / shared-memory
   * readback surface on `GPUBuffer.prototype` (0.7.15). Returns `false`
   * everywhere today — no browser exposes the interface yet
   * (tracked at `gpuweb#4432` and the shared-buffer / external-memory
   * follow-up issues). Flips to `true` the day the canonical method
   * appears on `GPUBuffer.prototype`; sniffs purely by interface
   * presence, NOT UA version.
   *
   * Pairs with `BridgeGPUSource`'s `WriteTarget` strategy: callers can
   * read this before passing `writeTarget: 'shared'`. Today `'auto'`
   * deterministically resolves to `'map-async'`; the day this flag
   * flips, a future patch will land `SharedMemoryWriteTarget` and the
   * auto resolution will follow.
   *
   * @experimental — capability label is stable; underlying predicate
   * follows the spec.
   */
  readonly webgpuZeroCopy: boolean;
  /**
   * `typeof navigator?.ml?.createContext === 'function'` (0.7.17).
   * Interface-presence sniff for the W3C WebNN root entry point. Does
   * NOT create a context. Returns `false` everywhere today — WebNN is
   * W3C Candidate Recommendation, Chrome behind
   * `chrome://flags/#web-machine-learning-api`, Safari absent, Firefox
   * in early stages. Pairs with `mlTensor` below: `webnn` says "the
   * root surface is present"; `mlTensor` says "the tensor primitive
   * specifically is present."
   *
   * Consumers building against the experimental
   * `BridgeWebNNSource` (under the
   * `webgpu-audio-bridge/experimental` subpath) should read these
   * flags pre-construction rather than catching the helper's
   * "WebNN not available" throw. The helper's static
   * `BridgeWebNNSource.isAvailable()` reports the same as
   * `mlTensor` here.
   */
  readonly webnn: boolean;
  /**
   * `typeof globalThis.MLTensor === 'function'` (0.7.17).
   * Interface-presence sniff for the WebNN `MLTensor` global class —
   * the tensor primitive `BridgeWebNNSource` accepts. Some WebNN
   * impls may expose the root `navigator.ml` API without
   * `MLTensor` yet; this flag captures that split.
   */
  readonly mlTensor: boolean;
  /** `navigator?.userActivation` present. Predicts whether AudioContext.resume will succeed. */
  readonly userActivation: boolean;
  /** `globalThis.isSecureContext === true`. */
  readonly secureContext: boolean;
  /** Derived from the feature flags. See module header for the rules. */
  readonly suggestedMode: "turbo" | "standard" | "unsupported";
  /** Static, informational latency floor for the suggested mode. */
  readonly estimatedLatencyFloorMs: EstimatedLatencyFloorMs;
  /** Actionable fixes for the detected gaps. Frozen array of frozen objects. */
  readonly fixes: ReadonlyArray<EnvironmentFix>;
  /** Raw `navigator.userAgent`, for bug-report copy/paste only. */
  readonly userAgent: string;
}

// ── Feature-detect helpers ───────────────────────────────────────────────
//
// Each helper is intentionally one-liner and uses `as unknown as ...`
// rather than ambient lib.dom.d.ts types because this module compiles
// in both DOM and Node contexts (tsx-script tests run under Node).

function hasSharedArrayBuffer(g: typeof globalThis): boolean {
  return typeof (g as { SharedArrayBuffer?: unknown }).SharedArrayBuffer === "function";
}

function hasAtomics(g: typeof globalThis): boolean {
  return typeof (g as { Atomics?: unknown }).Atomics === "object"
    && (g as { Atomics?: unknown }).Atomics !== null;
}

function hasAtomicsWaitAsync(g: typeof globalThis): boolean {
  const A = (g as { Atomics?: { waitAsync?: unknown } }).Atomics;
  return !!A && typeof A.waitAsync === "function";
}

function hasAudioContext(g: typeof globalThis): boolean {
  return typeof (g as { AudioContext?: unknown }).AudioContext === "function";
}

function hasAudioWorklet(g: typeof globalThis): boolean {
  const AC = (g as { AudioContext?: unknown }).AudioContext;
  if (typeof AC !== "function") return false;
  const proto = (AC as { prototype?: object }).prototype;
  if (!proto || typeof proto !== "object") return false;
  return "audioWorklet" in proto;
}

function hasCrossOriginIsolated(g: typeof globalThis): boolean {
  return (g as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

function hasSecureContext(g: typeof globalThis): boolean {
  return (g as { isSecureContext?: boolean }).isSecureContext === true;
}

interface NavigatorLike {
  gpu?: { requestAdapter?: unknown };
  ml?: { createContext?: unknown };
  requestMIDIAccess?: unknown;
  userActivation?: unknown;
  userAgent?: string;
}

function getNavigator(g: typeof globalThis): NavigatorLike | undefined {
  return (g as { navigator?: NavigatorLike }).navigator;
}

function hasWebGpu(nav: NavigatorLike | undefined): boolean {
  return !!nav && !!nav.gpu && typeof nav.gpu.requestAdapter === "function";
}

/**
 * Interface-presence sniff for a WebGPU zero-copy / shared-memory readback
 * surface (0.7.15). The W3C spec for this hasn't landed; the placeholder
 * method name `mapShared` on `GPUBuffer.prototype` is what we sniff for
 * today. When the canonical method name is fixed by the spec, update this
 * function's predicate (NOT the public field name on `EnvironmentReport`,
 * which is the stable capability label).
 *
 * Returns `false` everywhere today — no browser exposes the surface yet.
 */
function hasWebGpuZeroCopy(g: typeof globalThis): boolean {
  const GB = (g as { GPUBuffer?: { prototype?: object } }).GPUBuffer;
  const proto = GB?.prototype;
  if (!proto || typeof proto !== "object") return false;
  return "mapShared" in proto;
}

/**
 * Interface-presence sniff for the W3C WebNN root entry point
 * `navigator.ml.createContext` (0.7.17). Does NOT create a context.
 * Returns `false` everywhere today — WebNN is W3C Candidate
 * Recommendation, Chrome behind a flag, Safari absent.
 */
function hasWebNN(nav: NavigatorLike | undefined): boolean {
  return !!nav && !!nav.ml && typeof nav.ml.createContext === "function";
}

/**
 * Interface-presence sniff for the WebNN `MLTensor` global class
 * (0.7.17) — the tensor primitive `BridgeWebNNSource` accepts.
 * Returns `false` everywhere today; flips `true` when a browser
 * exposes `MLTensor` on the thread's global.
 */
function hasMLTensor(g: typeof globalThis): boolean {
  return typeof (g as { MLTensor?: unknown }).MLTensor === "function";
}

function hasWebMidi(nav: NavigatorLike | undefined): boolean {
  return !!nav && typeof nav.requestMIDIAccess === "function";
}

function hasUserActivation(nav: NavigatorLike | undefined): boolean {
  return !!nav && nav.userActivation !== undefined && nav.userActivation !== null;
}

function readUserAgent(nav: NavigatorLike | undefined): string {
  return (nav && typeof nav.userAgent === "string") ? nav.userAgent : "";
}

// ── Mode derivation ──────────────────────────────────────────────────────

interface FeatureFlags {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly atomics: boolean;
  readonly atomicsWaitAsync: boolean;
  readonly audioWorklet: boolean;
  readonly audioContext: boolean;
  readonly webgpu: boolean;
  readonly webMidi: boolean;
  // Experimental capability flags — mirror the EnvironmentReport grouping.
  readonly webgpuZeroCopy: boolean;
  readonly webnn: boolean;
  readonly mlTensor: boolean;
  // Stable, non-feature host flags.
  readonly userActivation: boolean;
  readonly secureContext: boolean;
}

function deriveSuggestedMode(f: FeatureFlags): "turbo" | "standard" | "unsupported" {
  if (!f.audioWorklet) return "unsupported";
  if (f.crossOriginIsolated && f.sharedArrayBuffer && f.atomics) return "turbo";
  return "standard";
}

// ── Latency floors (static) ──────────────────────────────────────────────
//
// Seeded from README §Honest input → audible breakdown:
//   - 1.3 ms avg quantum-boundary delay at 48 kHz / 128 samples
//   - 5-8 ms AudioContext output + DAC, ~5 used as the realistic floor
//
// Standard-mode bumps `input` by a conservative 10 ms to model the
// MessageChannel + structured-clone + transferable-ArrayBuffer hop
// (typical range 5-50 ms; floor used here, not measured).

const TURBO_FLOOR: EstimatedLatencyFloorMs = Object.freeze({
  input: 1.3,
  output: 6,
  total: 7.3,
});

const STANDARD_FLOOR: EstimatedLatencyFloorMs = Object.freeze({
  input: 10,
  output: 6,
  total: 16,
});

const UNSUPPORTED_FLOOR: EstimatedLatencyFloorMs = Object.freeze({
  input: 0,
  output: 0,
  total: 0,
});

function floorFor(mode: "turbo" | "standard" | "unsupported"): EstimatedLatencyFloorMs {
  if (mode === "turbo") return TURBO_FLOOR;
  if (mode === "standard") return STANDARD_FLOOR;
  return UNSUPPORTED_FLOOR;
}

// ── Fix derivation ───────────────────────────────────────────────────────
//
// Each fix is keyed by a stable `id` so the overlay/CLI can deduplicate,
// the golden-matrix test (0.7.8) can assert per-environment cells, and
// downstream test suites can pin specific fixes without depending on
// `summary` wording (which may evolve).
//
// Severity rules:
//   - `blocker` — without this, `suggestedMode === 'unsupported'`.
//   - `degraded` — Turbo unavailable, Standard still works.
//   - `info` — non-blocking but noted (WebGPU absent, etc.).
//
// All docUrls point to README anchors that exist in 0.7.0+; the
// `enable-coop-coep` MDN link is the canonical external reference until
// the 0.7.5 deployment recipes ship.

const README = "https://github.com/Creeptones/webgpu-audio-bridge#";
const MDN_COOP_COEP =
  "https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated";

function freezeFix(fix: EnvironmentFix): EnvironmentFix {
  return Object.freeze(fix);
}

function deriveFixes(f: FeatureFlags, mode: "turbo" | "standard" | "unsupported"): EnvironmentFix[] {
  const fixes: EnvironmentFix[] = [];

  if (!f.audioWorklet) {
    fixes.push(freezeFix({
      id: "missing-audio-worklet",
      severity: "blocker",
      summary:
        "AudioWorklet is not available — neither Turbo nor Standard mode can run. " +
        "Update to a current browser (Chrome 66+, Firefox 76+, Safari 14.1+).",
      docUrl: README + "browser-support-matrix",
    }));
    // No further fixes meaningful — return early.
    return fixes;
  }

  if (!f.audioContext) {
    fixes.push(freezeFix({
      id: "missing-audio-context",
      severity: "blocker",
      summary:
        "AudioContext constructor is not available on this global. " +
        "Confirm this is a window/worker context with Web Audio API support.",
      docUrl: README + "browser-support-matrix",
    }));
  }

  if (!f.secureContext) {
    fixes.push(freezeFix({
      id: "insecure-context",
      severity: "blocker",
      summary:
        "Page is not a secure context (no HTTPS / not localhost). " +
        "SharedArrayBuffer and most modern audio APIs are gated on secure contexts.",
      docUrl: "https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts",
    }));
  }

  // Turbo prerequisites — if any of these is missing, Turbo cannot run.
  // We emit them as `degraded` (rather than `blocker`) when Standard mode
  // can still run; `blocker` is reserved for the truly-no-transport case.

  if (!f.crossOriginIsolated) {
    fixes.push(freezeFix({
      id: "enable-coop-coep",
      severity: mode === "turbo" ? "info" : "degraded",
      summary:
        "Page is not cross-origin isolated. Turbo mode requires the " +
        "Cross-Origin-Opener-Policy: same-origin and " +
        "Cross-Origin-Embedder-Policy: require-corp response headers.",
      docUrl: MDN_COOP_COEP,
    }));
  }

  if (!f.sharedArrayBuffer) {
    fixes.push(freezeFix({
      id: "missing-shared-array-buffer",
      severity: "degraded",
      summary:
        "SharedArrayBuffer is unavailable. Turbo mode cannot run; " +
        "Standard mode (MessageChannelBridge, 0.8.x) is the explicit second tier.",
      docUrl: README + "two-transport-tiers-070",
    }));
  }

  if (!f.atomics) {
    fixes.push(freezeFix({
      id: "missing-atomics",
      severity: "degraded",
      summary:
        "Atomics API is unavailable. Turbo mode's lock-free protocol cannot run.",
      docUrl: README + "browser-support-matrix",
    }));
  }

  if (f.atomics && !f.atomicsWaitAsync) {
    fixes.push(freezeFix({
      id: "missing-atomics-wait-async",
      severity: "info",
      summary:
        "Atomics.waitAsync is unavailable. Turbo mode falls back to " +
        "synchronous Atomics.wait or to polling for backpressure events.",
      docUrl: README + "back-pressure",
    }));
  }

  // Non-blocking environmental notes.

  if (!f.webgpu) {
    fixes.push(freezeFix({
      id: "missing-webgpu",
      severity: "info",
      summary:
        "navigator.gpu is unavailable. The library still runs without WebGPU; " +
        "any CPU-side producer (worker thread, MIDI lane, etc.) works unchanged.",
      docUrl: README + "use-cases",
    }));
  }

  if (!f.webMidi) {
    fixes.push(freezeFix({
      id: "missing-web-midi",
      severity: "info",
      summary:
        "navigator.requestMIDIAccess is unavailable. The fast-lane input " +
        "pattern still works with pointer / keyboard / touch input.",
      docUrl: README + "achieving-pro-audio-tracking-latency",
    }));
  }

  if (!f.userActivation) {
    fixes.push(freezeFix({
      id: "missing-user-activation",
      severity: "info",
      summary:
        "navigator.userActivation is unavailable. AudioContext may still " +
        "require a user gesture before audio output starts.",
      docUrl: "https://developer.mozilla.org/en-US/docs/Web/API/UserActivation",
    }));
  }

  return fixes;
}

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Build a synchronous, frozen snapshot of the host environment relative
 * to the library's two transport tiers. Pure feature detection — safe
 * to call at module load, before user activation, in any thread with
 * a `globalThis`. JSON-serializes cleanly for transport over HTTP /
 * postMessage.
 *
 * See module header for the disjoint relationship with
 * `Bridge<S>.telemetry()`.
 */
export function getEnvironmentReport(): EnvironmentReport {
  const g = globalThis;
  const nav = getNavigator(g);

  const flags: FeatureFlags = {
    crossOriginIsolated: hasCrossOriginIsolated(g),
    sharedArrayBuffer: hasSharedArrayBuffer(g),
    atomics: hasAtomics(g),
    atomicsWaitAsync: hasAtomicsWaitAsync(g),
    audioWorklet: hasAudioWorklet(g),
    audioContext: hasAudioContext(g),
    webgpu: hasWebGpu(nav),
    webMidi: hasWebMidi(nav),
    webgpuZeroCopy: hasWebGpuZeroCopy(g),
    webnn: hasWebNN(nav),
    mlTensor: hasMLTensor(g),
    userActivation: hasUserActivation(nav),
    secureContext: hasSecureContext(g),
  };

  const suggestedMode = deriveSuggestedMode(flags);
  const fixes = Object.freeze(deriveFixes(flags, suggestedMode));

  const report: EnvironmentReport = {
    crossOriginIsolated: flags.crossOriginIsolated,
    sharedArrayBuffer: flags.sharedArrayBuffer,
    atomics: flags.atomics,
    atomicsWaitAsync: flags.atomicsWaitAsync,
    audioWorklet: flags.audioWorklet,
    audioContext: flags.audioContext,
    webgpu: flags.webgpu,
    webMidi: flags.webMidi,
    webgpuZeroCopy: flags.webgpuZeroCopy,
    webnn: flags.webnn,
    mlTensor: flags.mlTensor,
    userActivation: flags.userActivation,
    secureContext: flags.secureContext,
    suggestedMode,
    estimatedLatencyFloorMs: floorFor(suggestedMode),
    fixes,
    userAgent: readUserAgent(nav),
  };

  return Object.freeze(report);
}
