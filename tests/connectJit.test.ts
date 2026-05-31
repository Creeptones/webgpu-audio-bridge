/**
 * connectJit pins (0.9.917 — Apollo Frontier 5, The Autonomous JIT, Stage 3).
 *
 * The one-call constructor's three-realm wiring, proven in Node with a real wabt
 * `compileWat` (the same injected compiler the rest of the JIT suite uses) and
 * FAKE worker / worklet-port objects standing in for the browser realms. The
 * compiler + the consumer are already pinned (JitCompiler.test.ts /
 * JitKernelConsumer.test.ts); this file pins the WIRING between them:
 *
 *   A  connectJit() shape: allocates a shared memory in an isolated host, echoes
 *      the kernel SOURCE string, sizes the memory so the consumer ctor accepts it,
 *      and the processorOptions / compileRequest carry the right fields.
 *   B  runJitCompile() — accepted kernel → status "accepted" with a compiled
 *      Module + bytes + the gate report; a non-subset kernel → status "fallback"
 *      with a verdict (NOTHING shippable). The gate is the safety boundary.
 *   C  forwardCompileResponse() — the single swappable transport: a Module that
 *      posts cleanly → "module"; a port that throws DataCloneError on the Module →
 *      bytes fallback; a fallback verdict → posts jit-fallback, returns "none".
 *   D  createJitConsumer() + handleJitInstallMessage() — reconstructs the JS
 *      fallback from the source string, and a bytes/module install arms the swap;
 *      force-js reverts.
 *   E  end-to-end: connection.bind(fakeWorker, fakePort) → requestCompile() →
 *      worker runs runJitCompile → result forwarded to the port → the consumer
 *      installs it and the f64 stream upgrades to SIMD bit-exactly (onUpgrade
 *      fired with transport "module").
 *   F  graceful degrade: a NON-shared memory → jitEnabled false → install is a
 *      no-op → output stays pure JS.
 *   G  the TOKEN path (Apollo Frontier 6): connectJit({ tokens }) synthesizes the
 *      JS fallback by inverting the IR (emitJsKernel), ships a { kind: "tokens" }
 *      request, runJitCompile runs compileTokens, and the f64 stream upgrades to
 *      SIMD bit-exactly through the same forward → install wiring.
 *
 * `tsx` script; `assert`/`assertEq`/`ok` from `_assert.ts`. No framework.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  connectJit, runJitCompile, forwardCompileResponse,
  createJitConsumer, handleJitInstallMessage, jitMemoryPages,
  type JitCompileResponse, type JitInstallMessage, type JitPostTarget, type JitMessageSource,
} from "../src/jit/connectJit.js";
import { kernelToTokens, tokensToKernel, emitJsKernel } from "../src/jit/index.js";
import {
  type KernelSignature, type LaneWidth,
  type IrKernel, type IrNode, type IrStore, type KernelParam, type ParamRole, type LoopBound,
} from "../src/jit/ir.js";
import { hasWasmConsumerSupport } from "../src/worklet/wasmSimdSupport.js";

// ── wabt-backed compileWat (identical to the rest of the JIT suite) ──────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const SR = 48_000;
const N = 128;

function sig(width: LaneWidth, ...spec: Array<[string, "input" | "output" | "scalar" | "length"]>): KernelSignature {
  return { width, params: spec.map(([name, role]) => ({ name, role })) };
}
function roundW(width: LaneWidth): (v: number) => number {
  return width === "f32" ? Math.fround : (v: number) => v;
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const IDENTITY = {
  width: "f32" as LaneWidth,
  sig: sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]),
  src: "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i]; } }",
};
const TAYLOR = {
  width: "f64" as LaneWidth,
  sig: sig("f64", ["out", "output"], ["x", "input"], ["v", "input"], ["dt", "scalar"], ["n", "length"]),
  src: "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }",
  scalars: { dt: 0.0166667 },
};
// A kernel OUTSIDE the compilable sub-language (Math.sin is not in the whitelist).
const REJECTED = {
  sig: sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]),
  src: "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = Math.sin(x[i]); } }",
};

// A TOKEN kernel (Apollo Frontier 6 grammar path): f64 gain out[i] = x[i] * g.
// f64 so the swap fades exact-lerp bit-exact to the JS fallback at every phase.
const TOKEN_GAIN = (() => {
  const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
  const L = (array: string): IrNode => ({ kind: "load", array, stride: 1, intercept: 0 });
  const Sc = (name: string): IrNode => ({ kind: "scalar", name });
  const bound: LoopBound = { kind: "param", name: "n" };
  const store: IrStore = { array: "out", stride: 1, intercept: 0, value: { kind: "binary", op: "mul", a: L("x"), b: Sc("g") } };
  const params = [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")];
  const ir: IrKernel = { width: "f64", bound, stores: [store], signature: { params, width: "f64" } };
  return {
    width: "f64" as LaneWidth,
    sig: { params, width: "f64" } as KernelSignature,
    tokens: kernelToTokens(ir),
    scalars: { g: 0.75 },
  };
})();

// ── A fake compile worker: main `postMessage`s a request; it runs runJitCompile
//    and delivers the response back through `onmessage` on the next microtask
//    (mirrors the async worker→main hop). ───────────────────────────────────────
class FakeWorker implements JitMessageSource, JitPostTarget {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(message: unknown): void {
    void this.handle(message);
  }
  private async handle(message: unknown): Promise<void> {
    const req = message as Parameters<typeof runJitCompile>[0];
    if (!req || (req as { type?: string }).type !== "jit-compile") return;
    const resp = await runJitCompile(req, { compileWat });
    this.onmessage?.({ data: resp });
  }
}

/** Records every message posted to it (a fake AudioWorkletNode `.port`). */
class FakePort implements JitPostTarget {
  readonly posted: JitInstallMessage[] = [];
  postMessage(message: unknown): void { this.posted.push(message as JitInstallMessage); }
}

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

// ── A: connectJit() shape ─────────────────────────────────────────────────────
function testShape(): void {
  // eslint-disable-next-line no-new-func
  const kernel = new Function(`"use strict"; return (${IDENTITY.src});`)() as (...a: never[]) => void;
  const c = connectJit({ kernel, signature: IDENTITY.sig, maxBlock: N, sampleRate: SR });

  assertEq(c.kernelSource, kernel.toString(), "A: kernelSource is kernel.toString()");
  assert(c.memory instanceof WebAssembly.Memory, "A: memory allocated");
  assertEq(c.processorOptions.memory, c.memory, "A: processorOptions carries the same memory");
  assertEq(c.processorOptions.maxBlock, N, "A: processorOptions.maxBlock");
  assertEq(c.processorOptions.sampleRate, SR, "A: processorOptions.sampleRate");
  assertEq(c.processorOptions.windowSeconds, 0.01, "A: default windowSeconds 0.01");
  assertEq(c.processorOptions.baseOffset, 16, "A: default baseOffset 16");
  assertEq(c.processorOptions.exportName, "kernel", "A: default exportName");
  assertEq(c.compileRequest.type, "jit-compile", "A: compileRequest type");
  const req = c.compileRequest;
  assert(req.kind !== "tokens", "A: the { kernel } path produces the js compile-request variant");
  assertEq(req.source, kernel.toString(), "A: compileRequest carries source");
  assertEq(req.width, "f32", "A: compileRequest width from signature");

  // In an isolated host (Node has SAB + threads) the memory is shared and the JIT
  // is enabled; on a host without SIMD/threads it would be a no-op (jitEnabled false).
  if (hasWasmConsumerSupport() && typeof SharedArrayBuffer !== "undefined") {
    assert(c.memory.buffer instanceof SharedArrayBuffer, "A: shared memory on isolated host");
    assertEq(c.jitEnabled, true, "A: jitEnabled true on isolated host");
  }

  // The sized memory is large enough that the real consumer ctor accepts it.
  const pages = jitMemoryPages(IDENTITY.sig, N, 16);
  assert(c.memory.buffer.byteLength >= pages * 65536, "A: memory ≥ jitMemoryPages");
  const consumer = createJitConsumer(c.processorOptions);
  assert(consumer.describeLayout().baseEnd <= c.memory.buffer.byteLength, "A: consumer layout fits the memory");
  ok("A: connectJit() shape + sizing");
}

// ── B: runJitCompile() — accepted vs fallback ─────────────────────────────────
async function testRunCompile(): Promise<void> {
  const acc = await runJitCompile(
    { type: "jit-compile", source: TAYLOR.src, signature: TAYLOR.sig, width: "f64", exportName: "kernel" },
    { compileWat },
  );
  assertEq(acc.status, "accepted", "B: taylor accepted");
  if (acc.status === "accepted") {
    assert(acc.module instanceof WebAssembly.Module, "B: accepted carries a compiled Module");
    assert(acc.bytes instanceof Uint8Array && acc.bytes.byteLength > 8, "B: accepted carries bytes");
    assertEq(acc.exportName, "kernel", "B: accepted exportName");
    assertEq(acc.gate.status, "accepted", "B: gate accepted");
  }

  const rej = await runJitCompile(
    { type: "jit-compile", source: REJECTED.src, signature: REJECTED.sig, width: "f32", exportName: "kernel" },
    { compileWat },
  );
  assertEq(rej.status, "fallback", "B: Math.sin kernel → fallback (nothing shippable)");
  if (rej.status === "fallback") {
    assert(
      rej.verdict === "rejected-source" || rej.verdict === "unsupported" || rej.verdict === "rejected-gate",
      `B: fallback verdict is a known kind, got ${rej.verdict}`,
    );
    assert(rej.detail.length > 0, "B: fallback carries a detail string");
  }
  ok("B: runJitCompile accepted vs fallback");
}

// ── C: forwardCompileResponse() — the swappable transport ─────────────────────
async function testTransport(): Promise<void> {
  const resp = await runJitCompile(
    { type: "jit-compile", source: IDENTITY.src, signature: IDENTITY.sig, width: "f32", exportName: "kernel" },
    { compileWat },
  );
  assertEq(resp.status, "accepted", "C: precondition accepted");

  // (1) DEFAULT is bytes — the robust worklet transport (a Module can silently
  // fail to deserialize into a worklet realm; the Stage-3 browser finding).
  const dflt = new FakePort();
  assertEq(forwardCompileResponse(dflt, resp), "bytes", "C: default transport is bytes");
  assert((dflt.posted[0] as { transport: string }).transport === "bytes", "C: default posts bytes");

  // (2) opt-in Module transport (for a Worker destination) when it clones cleanly.
  const clean = new FakePort();
  assertEq(forwardCompileResponse(clean, resp, { transport: "module" }), "module", "C: Module transport opt-in when it clones");
  assertEq((clean.posted[0] as JitInstallMessage).type, "jit-install", "C: posts a jit-install");
  assert((clean.posted[0] as { transport: string }).transport === "module", "C: transport module");

  // (3) Module opt-in but the port throws DataCloneError → bytes fallback.
  const throwing: JitPostTarget & { posted: JitInstallMessage[] } = {
    posted: [],
    postMessage(m: unknown) {
      const msg = m as { transport?: string };
      if (msg.transport === "module") throw new Error("DataCloneError: WebAssembly.Module");
      this.posted.push(m as JitInstallMessage);
    },
  };
  assertEq(forwardCompileResponse(throwing, resp, { transport: "module" }), "bytes", "C: bytes fallback on DataCloneError");
  assert((throwing.posted[0] as { transport: string }).transport === "bytes", "C: bytes transport posted");

  // (4) a fallback verdict → posts jit-fallback, returns none.
  const fb: JitCompileResponse = { type: "jit-result", status: "fallback", verdict: "unsupported", detail: "x" };
  const port = new FakePort();
  assertEq(forwardCompileResponse(port, fb), "none", "C: none for a fallback verdict");
  assertEq((port.posted[0] as JitInstallMessage).type, "jit-fallback", "C: posts jit-fallback");
  ok("C: forwardCompileResponse transport selection (bytes default, module opt-in)");
}

// ── D + E: end-to-end through the bound wiring ────────────────────────────────
async function testEndToEnd(): Promise<void> {
  if (!hasWasmConsumerSupport()) { ok("D/E: skipped (no WASM SIMD/threads on host)"); return; }

  // eslint-disable-next-line no-new-func
  const kernel = new Function(`"use strict"; return (${TAYLOR.src});`)() as (...a: never[]) => void;
  const c = connectJit({ kernel, signature: TAYLOR.sig, maxBlock: N, sampleRate: SR });
  if (!c.jitEnabled) { ok("D/E: skipped (jit not enabled — non-isolated host)"); return; }

  const worker = new FakeWorker();
  const port = new FakePort();
  let upgradeTransport = "";
  let fellBack = false;
  c.bind({
    worker, workletPort: port,
    callbacks: {
      onUpgrade: (t) => { upgradeTransport = t; },
      onFallback: () => { fellBack = true; },
    },
  });
  c.requestCompile();
  await flush();

  assertEq(fellBack, false, "E: no fallback for a compilable kernel");
  assertEq(upgradeTransport, "bytes", "E: onUpgrade fired with the default bytes transport");
  assert(port.posted.length === 1, "E: exactly one install message reached the port");
  const installMsg = port.posted[0]!;
  assertEq((installMsg as JitInstallMessage).type, "jit-install", "E: it's a jit-install");
  assert((installMsg as { transport: string }).transport === "bytes", "E: bytes transport");

  // Build the worklet-side consumer from the SAME processorOptions + memory, apply
  // the install, and run quanta until the SIMD kernel has fully taken over.
  const consumer = createJitConsumer(c.processorOptions);
  assertEq(consumer.jitEnabled, true, "D: consumer jitEnabled over the shared memory");

  const inputs = { x: new Float64Array(N), v: new Float64Array(N) };
  for (let i = 0; i < N; i++) { inputs.x[i] = Math.sin(0.011 * i + 0.5); inputs.v[i] = Math.cos(0.017 * i + 0.1); }
  const round = roundW("f64");
  const jsRef = new Float64Array(N);
  {
    const a = new Float64Array(N); const b = new Float64Array(N);
    for (let i = 0; i < N; i++) { a[i] = inputs.x[i]!; b[i] = inputs.v[i]!; }
    for (let i = 0; i < N; i++) a[i] = a[i]! + round(TAYLOR.scalars.dt) * b[i]!;
    jsRef.set(a);
  }

  const QUANTA = 12;
  let sawSimdComplete = false;
  let appliedAt = -1;
  for (let q = 0; q < QUANTA; q++) {
    if (q === 1) {
      const outcome = handleJitInstallMessage(consumer, installMsg);
      assertEq(outcome.installed, true, "D: bytes install armed the swap");
      assertEq(outcome.transport, "bytes", "D: routed via bytes transport");
      appliedAt = q;
    }
    const out = new Float64Array(N);
    const baseNs = (q * N / SR) * 1e9;
    const r = consumer.process({ x: inputs.x, v: inputs.v }, TAYLOR.scalars, { out }, N, baseNs);
    // f64 is exact-lerp bit-exact to the JS stream at EVERY phase (gate proves
    // SIMD≡JS f64; the a+w(b−a) blend is exactly a when a==b).
    for (let i = 0; i < N; i++) {
      assertEq(out[i]!, jsRef[i]!, `E: q${q} sample ${i} bit-exact to JS reference`);
    }
    if (r.phase === "complete" && r.ranSimd) sawSimdComplete = true;
  }
  assert(appliedAt >= 0, "E: install was applied");
  assert(sawSimdComplete, "E: the swap reached complete on the SIMD kernel");

  // Force-JS reverts.
  c.forceJs();
  assertEq((port.posted[port.posted.length - 1] as JitInstallMessage).type, "jit-force-js", "E: forceJs posts jit-force-js");
  handleJitInstallMessage(consumer, { type: "jit-force-js" });
  assertEq(consumer.isUpgraded(), false, "E: force-js reverted to JS");

  c.dispose();
  assertEq(worker.onmessage, null, "E: dispose detaches the worker handler");
  ok("D/E: end-to-end bind → compile → forward → install → upgrade → forceJs");
}

// ── F: graceful degrade over non-shared memory ────────────────────────────────
async function testDegrade(): Promise<void> {
  // eslint-disable-next-line no-new-func
  const kernel = new Function(`"use strict"; return (${IDENTITY.src});`)() as (...a: never[]) => void;
  const pages = jitMemoryPages(IDENTITY.sig, N, 16);
  const nonShared = new WebAssembly.Memory({ initial: pages }); // non-shared
  const c = connectJit({ kernel, signature: IDENTITY.sig, maxBlock: N, sampleRate: SR, memory: nonShared });
  assertEq(c.jitEnabled, false, "F: jitEnabled false over non-shared memory");

  const consumer = createJitConsumer(c.processorOptions);
  assertEq(consumer.jitEnabled, false, "F: consumer jitEnabled false");

  // Even a real accepted module is a no-op install on the JS-only floor.
  const resp = await runJitCompile(c.compileRequest, { compileWat });
  assertEq(resp.status, "accepted", "F: kernel still compiles (gate accepts)");
  if (resp.status === "accepted") {
    const outcome = handleJitInstallMessage(consumer, { type: "jit-install", transport: "bytes", bytes: resp.bytes, exportName: "kernel" });
    assertEq(outcome.installed, false, "F: install is a no-op when jit disabled");
  }

  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(0.013 * i + 0.2);
  const out = new Float32Array(N);
  const r = consumer.process({ x }, {}, { out }, N, 0);
  assertEq(r.ranSimd, false, "F: stays on JS");
  for (let i = 0; i < N; i++) assertEq(out[i]!, Math.fround(x[i]!), "F: output is the pure-JS identity stream");
  ok("F: graceful degrade over non-shared memory");
}

// ── G: the TOKEN path end-to-end (Apollo Frontier 6) ──────────────────────────
async function testTokenEndToEnd(): Promise<void> {
  // Shape: { tokens } synthesizes the JS fallback by inverting the IR, and the
  // compile request is the tokens variant.
  const c = connectJit({ tokens: TOKEN_GAIN.tokens, signature: TOKEN_GAIN.sig, maxBlock: N, sampleRate: SR });
  assertEq(c.kernelSource, emitJsKernel(tokensToKernel(TOKEN_GAIN.tokens)), "G: kernelSource = emitJsKernel(tokensToKernel(tokens))");
  assertEq(c.compileRequest.kind, "tokens", "G: compileRequest is the tokens variant");
  assert(c.compileRequest.kind === "tokens" && c.compileRequest.tokens.length === TOKEN_GAIN.tokens.length, "G: request carries the tokens");

  if (!hasWasmConsumerSupport() || !c.jitEnabled) { ok("G: token path shape OK; e2e skipped (jit not enabled on host)"); return; }

  const worker = new FakeWorker();
  const port = new FakePort();
  let upgradeTransport = "";
  let fellBack = false;
  c.bind({ worker, workletPort: port, callbacks: { onUpgrade: (t) => { upgradeTransport = t; }, onFallback: () => { fellBack = true; } } });
  c.requestCompile();
  await flush();

  assertEq(fellBack, false, "G: a compilable token kernel does not fall back");
  assertEq(upgradeTransport, "bytes", "G: onUpgrade fired (bytes transport)");
  assertEq(port.posted.length, 1, "G: one install message reached the port");
  const installMsg = port.posted[0]!;
  assertEq((installMsg as JitInstallMessage).type, "jit-install", "G: it's a jit-install");

  // Worklet-side consumer from the SAME processorOptions; install + run quanta.
  const consumer = createJitConsumer(c.processorOptions);
  assertEq(consumer.jitEnabled, true, "G: consumer jitEnabled over the shared memory");

  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(0.019 * i + 0.3);
  const g = TOKEN_GAIN.scalars.g;
  const jsRef = new Float64Array(N);
  for (let i = 0; i < N; i++) jsRef[i] = x[i]! * g; // f64 exact

  const QUANTA = 12;
  let sawSimdComplete = false;
  for (let q = 0; q < QUANTA; q++) {
    if (q === 1) {
      const outcome = handleJitInstallMessage(consumer, installMsg);
      assertEq(outcome.installed, true, "G: install armed the swap");
    }
    const out = new Float64Array(N);
    const baseNs = (q * N / SR) * 1e9;
    const r = consumer.process({ x }, TOKEN_GAIN.scalars, { out }, N, baseNs);
    for (let i = 0; i < N; i++) assertEq(out[i]!, jsRef[i]!, `G: q${q} sample ${i} bit-exact to JS gain reference`);
    if (r.phase === "complete" && r.ranSimd) sawSimdComplete = true;
  }
  assert(sawSimdComplete, "G: the swap reached complete on the SIMD kernel");
  c.dispose();
  ok("G: token path bind → compileTokens → forward → install → bit-exact SIMD upgrade");
}

async function main(): Promise<void> {
  testShape();
  await testRunCompile();
  await testTransport();
  await testEndToEnd();
  await testDegrade();
  await testTokenEndToEnd();
  console.log("\nconnectJit: all pins passed.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
