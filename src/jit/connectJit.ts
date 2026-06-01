/**
 * connectJit() — the one-call constructor for The Autonomous JIT
 * (Apollo Frontier 5, Stage 3, 0.9.917). **EXPERIMENTAL, internal-first.**
 *
 * Stage 1a (`compileKernel`) proves a vectorized SIMD kernel bit-exact/within-ULP
 * to its scalar reference; Stage 1b (`JitKernelConsumer`) live-swaps it into a
 * running AudioWorklet click-free, degrading to the developer's JS on every
 * failure; Stage 2 measured the win (3.8×–9.2× SIMD, ~4 µs install, ~0 glitch,
 * the doubled fade quantum is ~0.04 % of the budget). What was missing was the
 * thing a developer actually calls: a constructor that hides the THREE-thread
 * dance — compile off-thread, ship a gate-PASSED kernel into the worklet, install
 * it between quanta — behind one main-thread call plus two tiny realm helpers.
 *
 * ─── The three realms (mirrors connectFanIn's allocate-once / mount-many split) ─
 *
 * A JIT upgrade spans three JS realms that cannot share closures, so the wiring
 * is split into three entry points — one per realm — that all live in THIS file:
 *
 *   • MAIN thread — `connectJit(spec)`. Runs ONCE. Allocates (or adopts) the
 *     shared `WebAssembly.Memory`, snapshots `kernel.toString()` (the load-bearing
 *     fact: a function CLOSURE cannot cross `postMessage`, so the kernel must
 *     reach both off-thread realms as a SOURCE STRING), and returns a handle with
 *     the worklet `processorOptions`, the compile-worker request payload, and the
 *     `forceJs()`/`requestCompile()`/`dispose()` controls. It owns NO transport of
 *     its own — it forwards the worker's result to the worklet port via the single
 *     swappable `forwardCompileResponse` strategy.
 *
 *   • COMPILE WORKER — `runJitCompile(request, { compileWat })`. The background
 *     thread calls this with the request payload + an injected WAT→bytes compiler
 *     (`compileWat`; there is no encoder in the core — tests/bench inject wabt, the
 *     browser worker injects a vendored wabt). It runs `compileKernel`, and ON
 *     `accepted` ONLY does the async `WebAssembly.compile(wasm)` and returns a
 *     clone-safe response carrying BOTH the compiled `Module` and the raw `bytes`.
 *     The gate is the safety boundary: a `rejected-*`/`unsupported` verdict returns
 *     a `fallback` response and the worklet keeps playing JS — nothing is ever
 *     shipped that did not pass the equivalence gate.
 *
 *   • AUDIOWORKLET — `createJitConsumer(options)` + `handleJitInstallMessage(...)`.
 *     The worklet reconstructs the JS fallback from the source string via the
 *     `Function` constructor (the worklet realm permits it under CSP-free serving),
 *     builds a `JitKernelConsumer`, and routes install messages to the consumer's
 *     SYNC `installCompiledKernel` / `installCompiledKernelFromBytes` from
 *     `port.onmessage` (NEVER `process()`).
 *
 * ─── The transport is ONE swappable strategy (bytes default, Module opt-in) ─────
 *
 * Whether a `WebAssembly.Module` structured-clones INTO an AudioWorklet realm was
 * the Stage-3 #1 empirical risk (a worklet realm ≠ a worker realm). The Stage-3
 * browser finding settles it: in Chrome, posting a `WebAssembly.Module` to an
 * AudioWorkletNode `.port` does NOT throw at send — the failure is an ASYNC
 * `messageerror` on the worklet side when the Module fails to DESERIALIZE, so a
 * "try Module, catch the synchronous throw" fallback never fires and the worklet
 * silently never installs. So the robust default for the worklet boundary is
 * **bytes** (a `Uint8Array` clones into every realm; the consumer's
 * `installCompiledKernelFromBytes` compiles them synchronously in microseconds).
 * `forwardCompileResponse` therefore defaults to bytes; `transport: "module"` is
 * opt-in for callers whose destination is a Worker (where Module clone is reliable
 * and a failure DOES throw synchronously, so the bytes fallback still catches it).
 * Either way the choice is made in exactly one place; the consumer supports both
 * install paths and nothing else branches on transport.
 *
 * ─── Graceful degrade is the floor, not an error path ───────────────────────────
 *
 * No cross-origin isolation / no WASM-SIMD+threads ⇒ `connectJit` allocates a
 * NON-shared memory, the consumer's `jitEnabled` is false, every install is a
 * no-op, and the audio plays the developer's JS forever. `connectJit` NEVER throws
 * on an unsupported host (mirrors the compiler's "rejection is a value" contract) —
 * `handle.jitEnabled` reports it instead.
 *
 * @experimental — exported from `webgpu-audio-bridge/experimental`, NOT the 1.0
 * core. The compilable sub-language + this wiring API may change before promotion.
 */

import {
  type KernelSignature, type LaneWidth, type IrStateDecl, type IrStateBufferDecl,
  ELEM_BYTES, LANES, signatureWidth, paramsByRole, stateLayout, isStateful,
} from "./ir.js";
import { compileKernel, compileTokens, type CompileResult } from "./compileKernel.js";
import { emitJsKernel } from "./emitJsKernel.js";
import { tokensToKernel, type KernelToken } from "./kernelGrammar.js";
import { type CompileWat, type GateReport } from "./gate.js";
import { parseProgram } from "./parse.js";
import { lowerKernel } from "./lower.js";
import { JitRejection } from "./diagnostics.js";
import {
  JitKernelConsumer, MAX_STATE_REGISTERS, type JitJsKernel, type JitProcessResult,
} from "./JitKernelConsumer.js";
import { hasWasmConsumerSupport, hasWasmThreads } from "../worklet/wasmSimdSupport.js";

// ─── Spec + handle ───────────────────────────────────────────────────────────

/** The naive scalar JS kernel a developer hands `connectJit`. It is a plain
 *  function (compiled to a source string via `.toString()`); it must reference
 *  only its arguments + the `Math.*` whitelist (the same sub-language
 *  `compileKernel` accepts) so the source reconstructs identically in every
 *  realm. */
export type ConnectJitKernel = (...args: never[]) => void;

/** The declarative spec passed to `connectJit()` on the main thread. Provide
 *  EXACTLY ONE source of the kernel: a JS `kernel` function (the Frontier-5 path)
 *  OR a `tokens` stream (the Frontier-6 kernel-grammar path). */
export interface ConnectJitSpec {
  /** The developer's naive scalar JS DSP kernel. `connectJit` snapshots
   *  `kernel.toString()` and ships the SOURCE to both off-thread realms. Mutually
   *  exclusive with `tokens`. */
  readonly kernel?: ConnectJitKernel;
  /** A kernel-grammar token stream (Apollo Frontier 6). `connectJit` synthesizes
   *  the worklet JS fallback via `emitJsKernel(tokensToKernel(tokens))` and ships a
   *  `{ kind: "tokens" }` compile request; the compile worker runs `compileTokens`
   *  (the syntax gate + the equivalence gate). Mutually exclusive with `kernel`.
   *  The stream is self-contained (its `param` tokens carry the signature); the
   *  `signature` field below MUST be consistent with it (same names + order — the
   *  consumer calls both kernels positionally in `signature` order). */
  readonly tokens?: ReadonlyArray<KernelToken>;
  /** The kernel I/O shape (the same `KernelSignature` `compileKernel` takes).
   *  Plain data — clone-safe; travels in both payloads. On the token path it must
   *  match the stream's embedded signature. */
  readonly signature: KernelSignature;
  /** Maximum block size `n` per quantum (sizes every scratch slab). E.g. 128. */
  readonly maxBlock: number;
  /** Audio sample rate (Hz). */
  readonly sampleRate: number;
  /** Crossfade window seconds. Default 0.01 (the consumer default; Stage 2 proved
   *  the doubled fade quantum is ~0.04 % of the budget, so there is huge headroom
   *  and no hard-switch is needed at these kernel sizes). */
  readonly windowSeconds?: number;
  /** Byte offset where the consumer's working region begins (everything below is
   *  the caller's / a Bridge's). Default 16. Multiple of 16. */
  readonly baseOffset?: number;
  /** The WASM export name the compiled module exposes. Default "kernel". */
  readonly exportName?: string;
  /** Adopt a caller-owned `WebAssembly.Memory` (e.g. a Bridge's SAB-backed memory,
   *  with `baseOffset` placing the consumer region above it) instead of letting
   *  `connectJit` allocate one. */
  readonly memory?: WebAssembly.Memory;
  /** Override the SIMD lane width for the compile (default: `signature.width`). */
  readonly width?: LaneWidth;
  /** Polyphonic voice batch (Apollo Frontier 7, Stage 4). Default 1 (single voice).
   *  When `> 1` (a multiple of the lane width `W`) and the kernel lowers to STATEFUL
   *  IR (token or JS-source path), `connectJit` compiles a voice-SIMD kernel (W
   *  independent voices per v128) and the worklet runs the voice-batched runtime:
   *  voice-interleaved I/O + per-voice scalars (see `JitKernelConsumer.process`).
   *  Ignored for a stateless kernel (time-axis SIMD). */
  readonly voices?: number;
}

/** The `processorOptions` object to pass to
 *  `new AudioWorkletNode(ctx, name, { processorOptions })`. Every field is
 *  structured-clone-safe (a `WebAssembly.Memory` clones by sharing its SAB; the
 *  rest are plain data), so it crosses into the worklet realm unchanged. */
export interface JitWorkletOptions {
  readonly memory: WebAssembly.Memory;
  readonly kernelSource: string;
  readonly signature: KernelSignature;
  readonly maxBlock: number;
  readonly sampleRate: number;
  readonly windowSeconds: number;
  readonly baseOffset: number;
  readonly exportName: string;
  /** The kernel's declared state registers (Apollo Frontier 7, Stage 2),
   *  declaration order. Empty for a stateless kernel. Sizes the consumer's
   *  per-generation state slabs + seeds the JS-fallback / current-A generation.
   *  Clone-safe plain data ({name,init}[]). */
  readonly stateDecls: ReadonlyArray<IrStateDecl>;
  /** The kernel's declared delay-line ring buffers (Apollo Frontier 7, Stage 3),
   *  declaration order. Empty for a kernel with no delay lines. With `stateDecls` these
   *  size + seed the per-generation state slab. Clone-safe plain data ({name,length}[]). */
  readonly stateBuffers: ReadonlyArray<IrStateBufferDecl>;
  /** Polyphonic voice batch (Apollo Frontier 7, Stage 4). 1 for single-voice; `> 1`
   *  (a multiple of the lane width) selects the worklet's voice-batched runtime. The
   *  compiled SIMD kernel must be a voice-SIMD module for the same count. */
  readonly voices: number;
}

/** Fields common to both compile-request variants. */
export interface JitCompileRequestBase {
  readonly type: "jit-compile";
  readonly signature: KernelSignature;
  readonly width?: LaneWidth;
  readonly exportName: string;
  /** Polyphonic voice batch (Apollo Frontier 7, Stage 4). Default 1. */
  readonly voices?: number;
}

/** The message the main thread posts to the compile worker to start a compile. A
 *  discriminated union over `kind`: the JS-source path (`kind` absent or `"js"` —
 *  backward-compatible with the pre-Frontier-6 shape) carries `source`; the
 *  kernel-grammar path (`kind: "tokens"`) carries `tokens`. */
export type JitCompileRequest =
  | (JitCompileRequestBase & { readonly kind?: "js"; readonly source: string })
  | (JitCompileRequestBase & { readonly kind: "tokens"; readonly tokens: ReadonlyArray<KernelToken> });

/** The compile worker's reply (worker → main). On `accepted` it carries BOTH a
 *  compiled `Module` (the preferred transport) and the raw `bytes` (the universal
 *  fallback); on `fallback` it carries the verdict so the host can surface it
 *  without ever shipping an unproven kernel. */
export type JitCompileResponse =
  | {
      readonly type: "jit-result";
      readonly status: "accepted";
      readonly module: WebAssembly.Module | null;
      readonly bytes: Uint8Array;
      readonly exportName: string;
      readonly gate: GateReport;
      /** The compiled kernel's state registers (Frontier 7, Stage 2). Empty for a
       *  stateless kernel. The worklet needs these to seed the incoming
       *  generation's state slab — they are NOT derivable from the signature. */
      readonly stateDecls: ReadonlyArray<IrStateDecl>;
      /** The compiled kernel's delay-line ring buffers (Frontier 7, Stage 3). Empty
       *  when it has no delay lines. With `stateDecls`, sizes + seeds the incoming
       *  generation's state slab; not derivable from the signature. */
      readonly stateBuffers: ReadonlyArray<IrStateBufferDecl>;
      /** The polyphonic voice batch this kernel was compiled for (Frontier 7, Stage 4).
       *  1 for single-voice; `> 1` for a voice-SIMD kernel. The worklet's install guard
       *  checks it against what the consumer reserved. */
      readonly voices: number;
    }
  | {
      readonly type: "jit-result";
      readonly status: "fallback";
      readonly verdict: "rejected-source" | "rejected-gate" | "unsupported";
      readonly detail: string;
    };

/** Install / control messages the main thread posts to the worklet port. */
export type JitInstallMessage =
  | { readonly type: "jit-install"; readonly transport: "module"; readonly module: WebAssembly.Module; readonly exportName: string; readonly stateDecls: ReadonlyArray<IrStateDecl>; readonly stateBuffers: ReadonlyArray<IrStateBufferDecl>; readonly voices: number }
  | { readonly type: "jit-install"; readonly transport: "bytes"; readonly bytes: Uint8Array; readonly exportName: string; readonly stateDecls: ReadonlyArray<IrStateDecl>; readonly stateBuffers: ReadonlyArray<IrStateBufferDecl>; readonly voices: number }
  | { readonly type: "jit-fallback"; readonly verdict: string; readonly detail: string }
  | { readonly type: "jit-force-js" };

/** Which transport `forwardCompileResponse` chose (for the HUD / per-engine
 *  Playwright finding). `none` = a fallback verdict (nothing installable). */
export type JitTransport = "module" | "bytes" | "none";

/** Structural shape of a `postMessage` sink (a `Worker`, a `MessagePort`, or an
 *  AudioWorkletNode `.port`) — typed structurally so this module needs no DOM lib. */
export interface JitPostTarget {
  postMessage(message: unknown): void;
}

/** Structural shape of a message source (a `Worker` / `MessagePort`). */
export interface JitMessageSource {
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Optional diagnostics callbacks for the bound wiring. */
export interface ConnectJitCallbacks {
  /** Fired after a gate-PASSED kernel was forwarded to the worklet, with the
   *  transport that won (`module` or `bytes`). */
  readonly onUpgrade?: (transport: Exclude<JitTransport, "none">, gate: GateReport) => void;
  /** Fired when the worker returned a fallback verdict (rejection / unsupported)
   *  — the worklet keeps playing JS. */
  readonly onFallback?: (verdict: string, detail: string) => void;
}

/** The handle `connectJit()` returns on the main thread. */
export interface JitConnection {
  /** The shared `WebAssembly.Memory` the worklet + kernels operate over. Pass it
   *  to the worklet via `processorOptions` (already embedded there). */
  readonly memory: WebAssembly.Memory;
  /** The kernel SOURCE string (`kernel.toString()`) — shipped to both realms. */
  readonly kernelSource: string;
  /** True iff the runtime supports the WASM consumer AND `memory` is shared. When
   *  false, installs are no-ops and audio stays on JS forever (the degrade floor). */
  readonly jitEnabled: boolean;
  /** The `processorOptions` for the AudioWorkletNode (carries `memory` + source). */
  readonly processorOptions: JitWorkletOptions;
  /** The message to post to the compile worker (also posted by `requestCompile`). */
  readonly compileRequest: JitCompileRequest;

  /** Wire the worker → worklet handoff. Sets `worker.onmessage` to forward each
   *  compile result to the worklet port (bytes transport by default — robust for
   *  the worklet boundary; `transport: "module"` opt-in for Worker destinations)
   *  and fire the callbacks. Does NOT touch the worklet port's `onmessage` (the
   *  host owns that for the HUD). Returns the connection for chaining. */
  bind(opts: {
    readonly worker: JitMessageSource;
    readonly workletPort: JitPostTarget;
    readonly transport?: "bytes" | "module";
    readonly callbacks?: ConnectJitCallbacks;
  }): JitConnection;

  /** Post `compileRequest` to the bound worker (must `bind` first). */
  requestCompile(): void;

  /** Revert the worklet to the developer's JS kernel (the "Force JS" path). Posts
   *  `{ type: "jit-force-js" }` to the bound worklet port. */
  forceJs(): void;

  /** Detach the bound `worker.onmessage` handler. */
  dispose(): void;
}

// ─── connectJit() (main thread) ──────────────────────────────────────────────

function align16(n: number): number { return (n + 15) & ~15; }

/** Pages of 64 KiB the consumer layout needs for this signature + maxBlock +
 *  baseOffset (input slab per input array, two output generations per output, plus
 *  — for a stateful kernel — two per-generation state slabs). The `stateElements` arg
 *  (Frontier 7, Stage 3 — generalized from Stage 2's `stateRegisters`) is the kernel's
 *  TOTAL slab element count (`stateLayout(ir).elements`: registers + every buffer's
 *  ring + cursor). 0 (the default) reserves NO state region, so a stateless signature's
 *  page count is byte-identical to pre-Stage-2 (the frontier gate). Any positive count
 *  reserves `max(MAX_STATE_REGISTERS, stateElements)` per generation (the same floor +
 *  exact-sizing the consumer uses), so the budgets always agree — and a registers-only
 *  kernel (elements ≤ 64) stays byte-identical to Stage 2. */
export function jitMemoryPages(signature: KernelSignature, maxBlock: number, baseOffset = 16, stateElements = 0, voices = 1): number {
  const width = signatureWidth(signature);
  const eb = ELEM_BYTES[width];
  const nIn = paramsByRole(signature, "input").length;
  const nOut = paramsByRole(signature, "output").length;
  // Voice-batched layout (Frontier 7, Stage 4): every slab is `· voices` (voice-
  // interleaved); the per-generation state slab uses the EXACT `stateElements` (no
  // 64-register floor — the voice path sizes exactly), plus a per-voice scalar slab.
  if (voices > 1) {
    const ioSlot = align16(maxBlock * voices * eb);
    const stateSlot = align16(Math.max(1, stateElements) * voices * eb);
    const nScalar = paramsByRole(signature, "scalar").length;
    const scalarSlot = nScalar > 0 ? align16(nScalar * voices * eb) : 0;
    const regionEnd = baseOffset + (nIn + 2 * nOut) * ioSlot + 2 * stateSlot + scalarSlot;
    return Math.max(1, Math.ceil(regionEnd / 65536));
  }
  const slot = align16(maxBlock * eb);
  const reserved = stateElements > 0 ? Math.max(MAX_STATE_REGISTERS, stateElements) : 0;
  const stateBytes = reserved > 0 ? 2 * align16(reserved * eb) : 0;
  const regionEnd = baseOffset + (nIn + 2 * nOut) * slot + stateBytes;
  return Math.max(1, Math.ceil(regionEnd / 65536));
}

/** True iff a shared `WebAssembly.Memory` can be allocated here (proxy for
 *  cross-origin isolation — `SharedArrayBuffer` is gated behind it). */
function canAllocateShared(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && hasWasmThreads();
}

function isSharedMemory(memory: WebAssembly.Memory): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  return memory.buffer instanceof SharedArrayBuffer;
}

/**
 * The one-call main-thread constructor. Allocates (or adopts) the shared memory,
 * snapshots the kernel source, and returns the handle with the worklet
 * `processorOptions`, the compile-worker request, and the bind/control surface.
 * Never throws on an unsupported host (allocates a non-shared memory and reports
 * `jitEnabled === false`).
 */
export function connectJit(spec: ConnectJitSpec): JitConnection {
  const hasKernel = typeof spec.kernel === "function";
  const hasTokens = Array.isArray(spec.tokens);
  if (hasKernel === hasTokens) {
    throw new TypeError(
      "connectJit(): provide exactly one of { kernel } (a function) or { tokens } (a kernel-grammar stream)",
    );
  }
  if (!Number.isInteger(spec.maxBlock) || spec.maxBlock <= 0) {
    throw new RangeError(`connectJit(): maxBlock must be a positive integer, got ${spec.maxBlock}`);
  }
  if (!Number.isFinite(spec.sampleRate) || spec.sampleRate <= 0) {
    throw new RangeError(`connectJit(): sampleRate must be a finite positive number, got ${spec.sampleRate}`);
  }
  if (paramsByRole(spec.signature, "output").length === 0) {
    throw new Error("connectJit(): signature declares no output array");
  }

  const baseOffset = spec.baseOffset ?? 16;
  const windowSeconds = spec.windowSeconds ?? 0.01;
  const exportName = spec.exportName ?? "kernel";
  const width = spec.width ?? signatureWidth(spec.signature);
  const signature: KernelSignature = spec.width ? { ...spec.signature, width } : spec.signature;
  const requestedVoices = spec.voices ?? 1;
  if (requestedVoices > 1 && (!Number.isInteger(requestedVoices) || requestedVoices % LANES[width] !== 0)) {
    throw new RangeError(`connectJit(): voices must be a positive multiple of W=${LANES[width]} for width ${width}, got ${requestedVoices}`);
  }

  // Resolve the kernel SOURCE (shipped to both off-thread realms) + the compile
  // request from whichever input was given. On the token path the worklet fallback
  // is synthesized by inverting the IR (`emitJsKernel`); `tokensToKernel` throws on
  // a malformed stream — a construction-time programmer error, like a non-function
  // kernel. The gate, not this, is the equivalence boundary.
  let kernelSource: string;
  let compileRequest: JitCompileRequest;
  // The kernel's declared state registers (Frontier 7). When the source can be
  // lowered at construction time (token path always, JS path for in-subset source)
  // the JS fallback + compiled kernel share the same state shape. If a JS source is
  // out-of-subset, construction stays non-throwing and the compile worker returns
  // the fallback verdict later, preserving the original graceful-degrade contract.
  let stateDecls: ReadonlyArray<IrStateDecl> = [];
  let stateBuffers: ReadonlyArray<IrStateBufferDecl> = [];
  // Voice-SIMD (Frontier 7, Stage 4) is for STATEFUL kernels only; for a stateless
  // kernel `voices` collapses to 1 (time-axis SIMD). Derived after lowering reveals
  // statefulness.
  let voices = 1;
  if (hasTokens) {
    const tokens = spec.tokens!;
    const ir = tokensToKernel(tokens);
    stateDecls = ir.stateDecls ?? [];
    stateBuffers = ir.stateBuffers ?? [];
    voices = requestedVoices > 1 && isStateful(ir) ? requestedVoices : 1;
    kernelSource = emitJsKernel(ir);
    compileRequest = { type: "jit-compile", kind: "tokens", tokens, signature, width, exportName, voices };
  } else {
    const source = spec.kernel!.toString();
    kernelSource = source;
    try {
      const ir = lowerKernel(parseProgram(source), signature);
      stateDecls = ir.stateDecls ?? [];
      stateBuffers = ir.stateBuffers ?? [];
      if (isStateful(ir)) {
        voices = requestedVoices > 1 ? requestedVoices : 1;
        // The authored JS state syntax (`let s = 0` before the loop) is a source
        // declaration, not a persistent runtime slab. Once it lowers successfully,
        // use the IR-derived fallback so the worklet JS path shares the same
        // persistent simultaneous-state semantics as WASM and the token path.
        kernelSource = emitJsKernel(ir);
      }
    } catch (err) {
      if (!(err instanceof JitRejection)) throw err;
      // Keep the original source and stateless sizing; runJitCompile will surface
      // the precise rejected-source verdict asynchronously.
    }
    compileRequest = { type: "jit-compile", kind: "js", source, signature, width, exportName, voices };
  }

  // Allocate the working memory unless the caller adopts one. Shared when the host
  // is isolated; otherwise a non-shared memory so the JS-only degrade path still
  // has somewhere to run (jitEnabled will be false and installs become no-ops).
  let memory = spec.memory;
  if (!memory) {
    const pages = jitMemoryPages(signature, spec.maxBlock, baseOffset, stateLayout({ stateDecls, stateBuffers }).elements, voices);
    memory = canAllocateShared()
      ? new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true })
      : new WebAssembly.Memory({ initial: pages });
  }

  const jitEnabled = hasWasmConsumerSupport() && isSharedMemory(memory);

  const processorOptions: JitWorkletOptions = {
    memory, kernelSource, signature,
    maxBlock: spec.maxBlock, sampleRate: spec.sampleRate, windowSeconds, baseOffset, exportName, stateDecls, stateBuffers, voices,
  };

  let boundWorker: JitMessageSource | null = null;
  let boundPort: JitPostTarget | null = null;

  const connection: JitConnection = {
    memory, kernelSource, jitEnabled, processorOptions, compileRequest,

    bind(opts) {
      boundWorker = opts.worker;
      boundPort = opts.workletPort;
      const cb = opts.callbacks;
      const fwd: ForwardOptions = { transport: opts.transport ?? "bytes" };
      boundWorker.onmessage = (ev: { data: unknown }): void => {
        const data = ev.data as JitCompileResponse;
        if (!data || data.type !== "jit-result") return;
        if (data.status === "fallback") {
          boundPort!.postMessage({ type: "jit-fallback", verdict: data.verdict, detail: data.detail });
          cb?.onFallback?.(data.verdict, data.detail);
          return;
        }
        const transport = forwardCompileResponse(boundPort!, data, fwd);
        if (transport !== "none") cb?.onUpgrade?.(transport, data.gate);
      };
      return connection;
    },

    requestCompile() {
      if (!boundWorker) throw new Error("connectJit(): call bind({ worker }) before requestCompile()");
      // `bind` stores the worker as a message SOURCE; the same object is the post
      // target. Cast through the structural post shape.
      (boundWorker as unknown as JitPostTarget).postMessage(compileRequest);
    },

    forceJs() {
      if (!boundPort) throw new Error("connectJit(): call bind({ workletPort }) before forceJs()");
      boundPort.postMessage({ type: "jit-force-js" } satisfies JitInstallMessage);
    },

    dispose() {
      if (boundWorker) boundWorker.onmessage = null;
      boundWorker = null;
      boundPort = null;
    },
  };
  return connection;
}

// ─── runJitCompile() (compile worker) ────────────────────────────────────────

/**
 * The compile-worker entry. Runs `compileKernel` with the injected `compileWat`
 * and, ON `accepted` ONLY, performs the async `WebAssembly.compile(wasm)` (the
 * background-thread step Stage 2 measured at ~40 µs) so the worklet's install is a
 * synchronous `new Instance`. Returns a clone-safe response. The gate is the
 * safety boundary: every non-`accepted` verdict yields a `fallback` response and
 * NO kernel is shipped. Never throws on a user program (rejection is a value);
 * only an injected-`compileWat` defect can throw, which the worker surfaces.
 */
export async function runJitCompile(
  request: JitCompileRequest,
  opts: { compileWat: CompileWat },
): Promise<JitCompileResponse> {
  // Branch on the request kind: `"tokens"` runs the kernel-grammar pipeline
  // (`compileTokens` = syntax gate → equivalence gate); the JS path (`"js"`/absent)
  // is unchanged (`compileKernel`). Either way the verdict is a value and only an
  // `accepted` result ships. On the token path the width rides in the stream, so no
  // width override is applied.
  const result: CompileResult = request.kind === "tokens"
    ? compileTokens(request.tokens, { compileWat: opts.compileWat, exportName: request.exportName, voices: request.voices })
    : compileKernel(request.source, request.signature, {
        compileWat: opts.compileWat,
        width: request.width,
        exportName: request.exportName,
        voices: request.voices,
      });

  if (result.status !== "accepted") {
    const detail =
      result.status === "rejected-source" ? `${result.diagnostic.code}: ${result.diagnostic.message}`
      : result.status === "rejected-gate" ? (result.gate.reason ?? "gate mismatch")
      : result.reason;
    return { type: "jit-result", status: "fallback", verdict: result.status, detail };
  }

  // accepted — do the async compile here (off the audio thread). If it somehow
  // throws, still ship the bytes (the worklet's bytes path compiles synchronously).
  let module: WebAssembly.Module | null = null;
  try {
    module = await WebAssembly.compile(toArrayBufferView(result.wasm));
  } catch {
    module = null;
  }
  return {
    type: "jit-result", status: "accepted",
    module, bytes: result.wasm, exportName: result.exportName, gate: result.gate,
    stateDecls: result.stateDecls, stateBuffers: result.stateBuffers, voices: result.voices,
  };
}

/** Copy into a fresh ArrayBuffer-backed view (`WebAssembly.compile` rejects a
 *  SAB-backed `Uint8Array` in some engines, and the typed `BufferSource` param
 *  requires a plain `ArrayBuffer` backing). */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  buf.set(bytes);
  return buf;
}

// ─── forwardCompileResponse() (main thread, the swappable transport) ──────────

/** Options for `forwardCompileResponse` / `JitConnection.bind`. */
export interface ForwardOptions {
  /** Preferred install transport. Default `"bytes"` — the robust choice for an
   *  AudioWorklet destination (a `WebAssembly.Module` can silently fail to
   *  deserialize into a worklet realm). Pass `"module"` only when the destination
   *  is a Worker, where Module clone is reliable and a failure throws at send. */
  readonly transport?: "bytes" | "module";
}

/**
 * Forward a gate-PASSED compile result to the worklet port. The default transport
 * is BYTES (universally clone-safe; the consumer compiles them synchronously in
 * µs) — the robust choice for the AudioWorklet boundary, where a `WebAssembly.
 * Module` can silently fail to deserialize (an async `messageerror`, not a
 * send-time throw, so it could not be caught here). With `transport: "module"` it
 * posts the compiled Module and, only because THAT failure mode (a Worker
 * destination) throws synchronously, falls back to bytes on a `DataCloneError`.
 * Returns which transport won, or `"none"` for a fallback verdict (which posts a
 * `jit-fallback` message instead).
 *
 * This is the SINGLE place the transport decision is made — the consumer supports
 * both install paths; nothing else in the system branches on transport.
 */
export function forwardCompileResponse(
  port: JitPostTarget,
  response: JitCompileResponse,
  opts: ForwardOptions = {},
): JitTransport {
  if (response.status === "fallback") {
    port.postMessage({ type: "jit-fallback", verdict: response.verdict, detail: response.detail } satisfies JitInstallMessage);
    return "none";
  }
  if (opts.transport === "module" && response.module) {
    try {
      port.postMessage({ type: "jit-install", transport: "module", module: response.module, exportName: response.exportName, stateDecls: response.stateDecls, stateBuffers: response.stateBuffers, voices: response.voices } satisfies JitInstallMessage);
      return "module";
    } catch {
      // DataCloneError: a WebAssembly.Module would not clone into this realm.
      // Fall through to the bytes transport (always clone-safe).
    }
  }
  port.postMessage({ type: "jit-install", transport: "bytes", bytes: response.bytes, exportName: response.exportName, stateDecls: response.stateDecls, stateBuffers: response.stateBuffers, voices: response.voices } satisfies JitInstallMessage);
  return "bytes";
}

// ─── createJitConsumer() + handleJitInstallMessage() (AudioWorklet) ───────────

/**
 * Reconstruct the developer's JS fallback from the source string and build a
 * `JitKernelConsumer` over the shared memory. Call this once in the
 * `AudioWorkletProcessor` constructor with `options.processorOptions`. The
 * `Function` constructor reconstitution requires a CSP that permits it (the demo
 * serves CSP-free; production hosts under a strict CSP must instead ship the JS
 * fallback as a module the worklet imports).
 */
export function createJitConsumer(options: JitWorkletOptions): JitKernelConsumer {
  // eslint-disable-next-line no-new-func
  const jsKernel = new Function(`"use strict"; return (${options.kernelSource});`)() as JitJsKernel;
  return new JitKernelConsumer({
    memory: options.memory,
    signature: options.signature,
    jsKernel,
    maxBlock: options.maxBlock,
    sampleRate: options.sampleRate,
    windowSeconds: options.windowSeconds,
    baseOffset: options.baseOffset,
    exportName: options.exportName,
    stateDecls: options.stateDecls,
    stateBuffers: options.stateBuffers,
    voices: options.voices,
  });
}

/** The result of routing one install/control message to the consumer. */
export interface JitInstallOutcome {
  /** Whether a kernel was armed (false for a no-op / fallback / force-js). */
  readonly installed: boolean;
  /** Which transport handled it (`none` for fallback / force-js / unknown). */
  readonly transport: JitTransport;
}

/**
 * Route a `JitInstallMessage` (received in the worklet's `port.onmessage`) to the
 * consumer: a `module`/`bytes` install arms the swap via the matching SYNC install
 * method; a `force-js` reverts to the JS fallback; a `fallback` verdict is a no-op
 * (the consumer keeps playing whatever it had). MUST be called from
 * `port.onmessage`, never inside `process()`.
 */
export function handleJitInstallMessage(consumer: JitKernelConsumer, message: unknown): JitInstallOutcome {
  const msg = message as JitInstallMessage;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return { installed: false, transport: "none" };
  switch (msg.type) {
    case "jit-install":
      if (msg.transport === "module") return { installed: consumer.installCompiledKernel(msg.module, msg.stateDecls, msg.stateBuffers, msg.voices), transport: "module" };
      return { installed: consumer.installCompiledKernelFromBytes(msg.bytes, msg.stateDecls, msg.stateBuffers, msg.voices), transport: "bytes" };
    case "jit-force-js":
      consumer.revertToFallback();
      return { installed: false, transport: "none" };
    case "jit-fallback":
    default:
      return { installed: false, transport: "none" };
  }
}

// Re-export the consumer's per-quantum result shape for worklet typings.
export type { JitProcessResult };
