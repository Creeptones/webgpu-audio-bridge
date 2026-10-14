/**
 * JIT parser injection — the acorn-free `experimental/core` subpath (0.9.946).
 *
 * Imports ONLY `src/experimental/core.ts` first (no acorn registered in this
 * process yet), so it observes the true acorn-free state before registering.
 *
 * Run: tsx tests/jitParserInjection.test.ts
 *
 * Pins
 *  1  experimental/core loads + the non-JS-source surface works without acorn
 *     (MpmcRing round-trip; compileTokens accepts a token kernel).
 *  2  without a registered parser, compileKernel(source) rejects as a VALUE with
 *     E_PARSE and a message naming both fixes (never throws, never loads acorn).
 *  3  registerJsParser(acorn.parse) enables the JS-source path from the core
 *     subpath, and the result is byte-identical to the full barrel's compile.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import * as core from "../src/experimental/core.js";

const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const sig = {
  width: "f32" as const,
  params: [
    { name: "out", role: "output" as const },
    { name: "x", role: "input" as const },
    { name: "g", role: "scalar" as const },
    { name: "n", role: "length" as const },
  ],
};
const src = "function k(out, x, g, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * g; } }";

const TOKENS = "width:f32 param:out:output param:x:input param:g:scalar param:n:length bound:$n load:x:1:0 scalar:g binary:mul store:out:1:0";

// ── Pin 1: the acorn-free surface works without a parser ─────────────────────
{
  assertEq(core.hasJsParser(), false, "no parser registered before any acorn import");
  const r = core.compileTokens(core.parseTokens(TOKENS), { compileWat });
  assertEq(r.status, "accepted", "token-path compile works with no JS parser registered");
  ok("1 experimental/core loads + token path compiles with no acorn registered");
}

// ── Pin 2: JS-source path rejects as a value without a parser ─────────────────
{
  const r = core.compileKernel(src, sig, { compileWat });
  assertEq(r.status, "rejected-source", "JS-source compile without a parser → rejected-source (a value)");
  const d = (r as { diagnostic: { code: string; message: string } }).diagnostic;
  assertEq(d.code, "E_PARSE", "diagnostic code is E_PARSE");
  assert(d.message.includes("registerJsParser") && d.message.includes("webgpu-audio-bridge/experimental"), `message names both fixes: ${d.message}`);
  ok("2 compileKernel(source) without a parser → rejected-source E_PARSE naming registerJsParser + the full barrel");
}

// ── Pin 3: registering acorn enables JS-source from the core subpath ─────────
{
  const acorn = await import("acorn");
  core.registerJsParser(acorn.parse);
  assertEq(core.hasJsParser(), true, "parser registered");
  const a = core.compileKernel(src, sig, { compileWat });
  assertEq(a.status, "accepted", "JS-source compile accepted after registerJsParser");
  const full = await import("../src/experimental/index.js");
  const b = full.compileKernel(src, sig, { compileWat });
  assertEq(b.status, "accepted", "full barrel compile accepted");
  const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
  assertEq(hex((a as { wasm: Uint8Array }).wasm), hex((b as { wasm: Uint8Array }).wasm), "core+registered ≡ full barrel, byte-identical wasm");
  ok("3 registerJsParser(acorn.parse) enables JS-source from experimental/core, byte-identical to the full barrel");
}

console.log("\nAll jitParserInjection pins passed.");
