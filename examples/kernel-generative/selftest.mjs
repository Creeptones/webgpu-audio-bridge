// selftest.mjs — HEADLESS verification of the model-free generative pipeline.
//
// Runs the EXACT browser generator (generate.js → legalNextTokens + LCG) through the
// EXACT browser gate stack (KernelCache.getOrCompile with real wabt) — no AudioWorklet,
// no browser — and reports the verdict mix + curation hit-rate + example kernels with
// their acoustic fingerprints. This is how the demo is verified without a browser:
//
//   npm run build && node examples/kernel-generative/selftest.mjs
//
// Asserts: (1) EVERY generated stream is a valid kernel (the no-invalid-stream property
// in action — the generator only ever picks masked kinds); (2) NO stream throws or is
// rejected for SYNTAX (gate #1) — a syntax reject would mean the mask/generator drifted;
// (3) a healthy fraction survive all three gates + curation (so the demo is fun, not a
// reroll grind). Gate/acoustic rejections are EXPECTED and welcome — they are the safety
// net doing its job on the unsafe streams the generator occasionally proposes.

import wabtInit from "wabt";
import { KernelCache, validateTokens } from "../../dist/experimental/index.js";
import { generateKernel, curate } from "./generate.js";

const N = Number(process.env.N ?? 300);

const wabt = await wabtInit();
function compileWat(wat, name = "m") {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const cache = new KernelCache();
const tally = { accepted: 0, curated: 0, "rejected-source": 0, "rejected-gate": 0, "rejected-acoustic": 0, unsupported: 0, threw: 0 };
const examples = [];
let invalid = 0;

for (let i = 0; i < N; i++) {
  const gen = generateKernel((i + 1) * 2654435761 >>> 0);

  // (1) the generator never emits an invalid stream
  if (!validateTokens(gen.tokens).ok) { invalid++; continue; }

  let r;
  try {
    r = cache.getOrCompile(gen.tokens, { compileWat });
  } catch (e) {
    tally.threw++;
    console.error("THREW:", e.message, "\n  ", gen.text);
    continue;
  }

  if (r.status === "accepted") {
    tally.accepted++;
    const cur = curate(r.kernel.acoustic);
    if (cur.ok) {
      tally.curated++;
      if (examples.length < 8) examples.push({ text: gen.text, a: r.kernel.acoustic });
    }
  } else {
    tally[r.status] = (tally[r.status] ?? 0) + 1;
  }
}

const spark = (b) => { const m = b.reduce((x, v) => Math.max(x, v), 0) || 1; return b.map((v) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((v / m) * 7))]).join(""); };

console.log(`\n=== generative selftest — ${N} kernels ===`);
console.log(`invalid streams (must be 0):      ${invalid}`);
console.log(`syntax-rejects  (must be 0):      ${tally["rejected-source"]}`);
console.log(`wabt threw      (should be 0):    ${tally.threw}`);
console.log(`accepted (passed gates #1+#2+#3): ${tally.accepted}`);
console.log(`  …of which CURATED (musical):    ${tally.curated}  (${(100 * tally.curated / N).toFixed(0)}% of all rolls)`);
console.log(`rejected-gate   (eq #2 caught):   ${tally["rejected-gate"]}`);
console.log(`rejected-acoustic (gate #3):      ${tally["rejected-acoustic"]}`);
console.log(`unsupported (vectorizer):         ${tally.unsupported}`);
console.log(`cache size (distinct):            ${cache.size}`);
console.log(`\n--- example musical kernels ---`);
for (const ex of examples) {
  const a = ex.a;
  console.log(`${spark(a.magnitude)}  rms ${a.rms.toFixed(3)} peak ${a.peak.toFixed(2)} centroid ${a.spectralCentroid.toFixed(2)}  ${ex.text}`);
}

// Assertions (exit non-zero on failure).
let failed = false;
function check(cond, msg) { if (!cond) { console.error("FAIL:", msg); failed = true; } else console.log("OK  ", msg); }
console.log();
check(invalid === 0, "generator emits ONLY valid streams (no-invalid-stream property)");
check(tally["rejected-source"] === 0, "NO syntax rejects (mask never drifts from the validator)");
check(tally.threw === 0, "no wabt/compile throws");
check(tally.curated >= N * 0.15, `a healthy fraction is musical (${tally.curated}/${N} ≥ 15%)`);
// The cache is content-addressed: distinct entries ≤ accept events — the gap is cache
// HITS (the same kernel generated from different seeds hashes equal and returns free).
check(cache.size > 0 && cache.size <= tally.accepted,
  `cache dedupes by content hash (${cache.size} distinct ≤ ${tally.accepted} accepts; ${tally.accepted - cache.size} were free hits)`);
if (failed) { process.exitCode = 1; console.error("\nselftest FAILED"); } else console.log("\nAll generative selftest checks passed.");
