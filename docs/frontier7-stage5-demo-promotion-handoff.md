# Apollo Frontier 7 — Stage 5: surface + poly-synth demo + promotion reconsideration (handoff)

**As of:** 2026-05-31 · current version **0.9.932** · branch `main` · next patch **0.9.933**.
Stage 4 shipped at commit **`915d661`** (`0.9.932 — SIMD across voices`).

> **What this is.** The kickoff for **Stage 5** of stateful kernels — the *consolidation*
> stage. Stages 1–4 built the machinery: a stateful kernel compiles (Stage 1), runs
> click-free across quanta (Stage 2), carries delay-line ring buffers (Stage 3), and
> re-engages SIMD along the **voice axis** for polyphony (Stage 4). Everything is proven
> bit-exact and is `@experimental` on the `webgpu-audio-bridge/experimental` subpath. What
> is missing is the part a *user* sees and the decision a *maintainer* owes: a live
> playable demo, the token path exercised end-to-end for the stateful/delay/voice kernels,
> docs/README that match the shipped surface, and a deliberate verdict on whether the whole
> Frontier 6/7 subtree (grammar + codec + hash + pipeline + acoustic gate + decoder masks +
> statefulness + voice-SIMD) is ready to **promote into the 1.0 core** or should keep
> soaking. Stage 5 is mostly *integration + judgement*, not new compiler invariants.
>
> **Read first:** this file; then the Stage-4 handoff
> (`docs/frontier7-stage4-simd-voices-handoff.md`) and the Stage-4 commit `915d661`; the
> statefulness semantics (`docs/frontier7-statefulness-semantics.md`); and the existing
> demo + design notes (`examples/jit-vectorize/`, `examples/kernel-palette/`,
> `docs/jit-vectorize-design.md`, `docs/frontier6-grammar-design.md`). The relevant source
> is settled and frozen at Stage 4 — Stage 5 mostly *consumes* it.

---

## 1. The shipped Stage-4 surface (what you are building on)

All `@experimental`, exported from `webgpu-audio-bridge/experimental` (and the internal
barrel `src/jit/index.ts`). The single-voice + stateless paths are byte-for-byte identical
to pre-Stage-4 (the **frontier gate**, pinned by `voiceKernel` pin 6 + the full suite).

**Compile.**
- `vectorize(ir, exportName, { voices })` → plan with `mode: "simd-time" | "scalar" |
  "simd-voice"` (and `scalarOnly` = `mode !== "simd-time"`, kept for back-compat). `voices`
  default 1. `simd-voice` iff stateful AND `voices ≥ W && voices % W === 0` (`W = LANES[width]`
  = 4 for f32 / 2 for f64).
- `compileIr(ir, { voices, compileWat, … })` / `compileTokens(tokens, { voices, … })` /
  `compileKernel(source, sig, { voices, … })` — all thread `voices`. The `accepted`
  `CompileResult` carries **`voices`** (1 for scalar/stateless) alongside `stateDecls` /
  `stateBuffers`.
- `emitVoiceSimdModule(ir, W, exportName)` + `voiceParamLayout(ir)` — the voice emitter +
  its ABI (`trip → arrays → $__state → $__scalars`; scalars are a lane-packed pointer, the
  one ABI difference from `paramLayout`). Stateful-only (`throw` on a stateless ir).
- `runGate({ …, voiceMode: true, voiceCorpora })` — the voice-equivalence gate: lane `j` ≡
  `evalReference(ir, voice-j inputs/scalars, n)` **bit-exact** for every lane, over `W`
  distinct per-voice corpora. A mismatch is `GateMismatch { kind: "voice-vs-ref", lane, … }`.

**Layout conventions (load-bearing — keep them straight in the demo).**
- **Voice-interleaved** is the fast axis: caller I/O is **fully voice-interleaved
  `x[i·V + v]`** (sample `i`, voice `v`) — the natural poly frame. Internally the consumer
  re-packs into `V/W` batched blocks of `W` voices (`[i·W + j]` per block); the translation
  is identity when `V === W`.
- **Per-voice scalars:** `process()`'s `scalars` is now
  `Record<string, number | ArrayLike<number>>` — a **number broadcasts** to all voices, an
  **array is per-voice** (length `V`). This is how each voice gets its own cutoff/gain.
- **State slab** is lane-packed (`stateLayout.elements · voices` per generation); the
  per-buffer delay cursor is ONE shared `i32` per lane group (the §2 shared-cursor insight).

**Runtime.**
- `new JitKernelConsumer({ …, voices })` — default 1 ⇒ the existing path, byte-identical.
  `> 1` requires `voices % W === 0` AND a stateful kernel (else throws). It runs `V/W`
  per-batch WASM calls; the JS fallback runs once per VOICE, marshalling each voice's
  lane-packed state through a contiguous scratch slab (so slab-A/B stay uniformly
  lane-packed — no dual-layout hazard; promotion/abort unchanged in structure).
- `process(inputs, scalars, outs, n, baseNs, sampleRate?)` — `inputs`/`outs` are
  voice-interleaved (`outs[name].length ≥ n·voices`); `scalars` per-voice-or-broadcast.
- `connectJit({ tokens, signature, voices, maxBlock, sampleRate })` derives `voices` from the
  spec ONLY when the token IR is stateful (a stateless / JS-source kernel collapses to
  `voices = 1` — `lower.ts` statefulness is still deferred). It threads `voices` through
  `JitWorkletOptions` → `createJitConsumer`, the compile request, the `jit-result`
  response, `forwardCompileResponse`'s `jit-install` (both transports), and
  `handleJitInstallMessage` → the consumer's install guard (refuses a `voices`/slab
  mismatch). `jitMemoryPages(sig, maxBlock, baseOffset, stateElements, voices)` reserves the
  voice-batched window; `voices === 1` is byte-identical.

**Tests pinning all of the above:** `tests/voiceKernel.test.ts` (compiler + gate, pins
1–4 + 6) and `tests/stateKernelConsumer.test.ts` pin 7 (cross-quantum voice persistence).
Both registered in `package.json` `test` + `test:unit`.

---

## 2. Stage 5, part A — the playable poly-synth demo (the headline)

There is **no stateful browser demo yet** (Stages 1–3 were proven in Node; Stage 4 too).
The Frontier-5/6 demos are `examples/jit-vectorize/` (JS-path off-thread compile) and
`examples/kernel-palette/` (token path + cache + acoustic fingerprint HUD). Stage 5's demo
is their stateful sibling: **a small playable polyphonic synth** that makes the voice batch
audible.

**Suggested shape (`examples/poly-synth/`, `npm run dev:poly-synth`, a fresh port e.g. 5187).**
- A fixed batch of `V` voices (e.g. `V = 8` for f32 ⇒ 2 batches of W=4) over ONE token
  kernel — a per-voice **stateful** voice: e.g. a one-pole/biquad lowpass on a per-voice
  oscillator, or a Karplus-Strong / feedback-comb pluck (delay-line state) so the delay +
  voice axes are BOTH exercised in the demo.
- An on-screen keyboard (or a chord button set) maps notes → voice slots → per-voice
  scalar arrays (the oscillator frequency / filter cutoff per voice). v1 mapping can be the
  *trivial* "key N → voice N" (no stealing — stealing is the deferred synth layer, §4).
- The audio path is exactly the shipped wiring: `connectJit({ tokens, signature, voices,
  maxBlock, sampleRate })` (main) → a compile worker calling `runJitCompile` → the worklet
  built by `createJitConsumer`, driven by `handleJitInstallMessage`; the worklet's
  `process()` fills the voice-interleaved input slab (per-voice oscillators) + the per-voice
  scalar map and calls `consumer.process(...)`. Live-swap the gate-verified voice-SIMD bytes
  in click-free, just like the other demos.
- Reuse the demos' COOP/COEP + bare-`acorn`-rewrite `serve.mjs` and the vendored wabt/acorn
  (the worker injects `compileWat`). A HUD showing "JS fallback → voice-SIMD upgraded
  (V voices, W per v128)" + the gate's `worstUlpF32 === 0` makes the bit-exactness tangible.

**Gotcha:** the worklet must build the voice-interleaved input itself (one oscillator per
voice, written `x[i·V + v]`), and pass per-voice cutoffs as an ArrayLike. Pin the demo's
worklet glue with a tiny Node test if practical, or lean on a Playwright smoke (mirror
`tests/browser/jit-vectorize.spec.ts`).

---

## 3. Stage 5, part B — end-to-end token-path coverage + the bench cell

These are the small, concrete, *pinnable* gaps left from Stage 4.

1. **`connectJit` token path e2e for voice (a `connectJit` pin).** `tests/connectJit.test.ts`
   already has pin G (token path → compileTokens → forward → install → bit-exact SIMD
   upgrade) for a STATELESS kernel. Add a sibling pin: a `connectJit({ tokens, signature,
   voices: W })` over a STATEFUL token kernel, drive the worklet glue
   (`createJitConsumer` + `handleJitInstallMessage`) with voice-interleaved I/O + per-voice
   scalars, and assert the upgraded stream is bit-exact to per-voice `evalReference`. This
   closes the "the whole `connectJit` wiring carries `voices`" claim with a test, not just
   the unit-level `stateKernelConsumer` pin 7.
2. **`bench/jit.bench.ts` Cell 5 — voice-batch speedup.** The handoff §5 deferred this
   "once the path is green" — it is green now. Measure scalar-per-voice (run the scalar
   module `V` times) vs the voice-batched module (`V/W` v128 calls), expecting ≈ `W`× for a
   compute-bound kernel. This is the *payoff number* the whole stage exists to produce.
   `npm run bench:jit`.
3. **README mirror.** The README has an `Experimental — The Autonomous JIT — connectJit()`
   section (~line 2191). Add a short Stage-4 subsection (voice-SIMD: the `voices` knob, the
   voice-interleaved I/O + per-voice scalar convention, the bit-exact-per-lane gate) mirroring
   the CHANGELOG `[0.9.932]` entry, per the commit policy. Keep it concise + `@experimental`.

---

## 4. Stage 5, part C — the promotion verdict (the maintainer decision)

The whole Frontier 6/7 subtree has now soaked across **Stages 0–4** (grammar/codec/hash,
the model-free compile pipeline + cache, the acoustic gate, the constrained-decoder masks,
statefulness, delay lines, voice-SIMD). The `@experimental` warning + subpath were always
"until it soaks + promotes". Stage 5 is the moment to **make the call deliberately** and
write it down (a design note `docs/frontier-promotion-decision.md`), covering:

- **Is the compilable sub-language settled?** (the IR shape, the grammar tokens, the
  ABI/`paramLayout`/`voiceParamLayout`, the gate contract). If yes → a promotion plan
  mirroring `SpscRing` internal@0.6.8 → public@0.6.10: move the surface from
  `src/experimental/index.ts` to `src/index.ts`, drop the one-shot construction warning,
  and add the compat promise. **BUT** note the hard blocker: the JIT subtree transitively
  imports `acorn` via `parse.ts`, and the **zero-runtime-dep core guard**
  (`tests/JitCompiler.test.ts` import-graph pin) pins that the root entry never reaches it.
  Promoting `compileKernel` to the core would break that guarantee. The token path
  (`compileTokens`) is **acorn-free** — so a viable promotion is *token-path-only into the
  core, JS-source path stays experimental*. Spell this out.
- **`kernelHash` stability.** The `kernelHash(gain) === "72b5c2e5a7a5f117"` regression pin
  is the content-address contract; promotion freezes it. Confirm it survived every stage
  (it did — registers/delay/voice all fold into the key only when present).
- **Default to "keep soaking" if unsure** — the asymmetry that kept it experimental through
  Stages 0–4 still holds; a premature promotion is expensive to walk back. Recommend the
  cheap path: promote nothing this stage, write the decision note + the promotion *plan*,
  and revisit when the demo + a real consumer (the website twin) have exercised it.

---

## 5. Tests to land (Stage 5)

- `tests/connectJit.test.ts` — a new pin: voice token path e2e bit-exact (§3.1).
- A demo smoke (`tests/browser/poly-synth.spec.ts`, Playwright) OR a Node glue pin for the
  worklet's voice-interleaving, if the demo glue is non-trivial (§2).
- (If promotion proceeds — unlikely this stage) move the import-graph + barrel pins to
  match the new entry point; otherwise leave them.
- Keep the **frontier gate** intact: `voices === 1` + stateless byte-identical; the
  `kernelHash(gain)` pin holds. Re-run the full suite.

No new compiler invariants ⇒ no new formal model / interleaving fuzzer needed (Stage 5 is
integration, not a new protocol).

---

## 6. Process / gotchas

1. **Versioning:** next is **`0.9.933`**, patch-level (additive demo + tests + docs + an
   optional bench cell; no wire/API break). Three-digit patch space `0.9.900 → 0.9.999`.
   A *promotion* (moving the surface to the core) WOULD be a minor (`0.10.0`) — public-API
   change — so if you actually promote, that is the one place to bump minor (and ask the user
   first, per CLAUDE.md).
2. **Gates before any version-bumping commit:** `npm run typecheck` clean · full `npm test`
   green · `npm run bench` push/pull/pullLatest within ~1.20 µs + 10 µs hard budget ·
   `npm run bench:jit`. Register any new test in `package.json` **both** `test` and `test:unit`.
3. **Known flakes (pre-existing, re-run once; NOT regressions):** the `bench` `trajEval
   (fast)` micro-gate (~1.25–1.30 µs, load-sensitive, unrelated to the JIT — it fired this
   session and is a documented flake); `Bridge.properties` (fast-check fp wobble);
   `Bridge.observability` (60 Hz wall-clock cadence); `connectJit` pin G (async worklet
   upgrade). `bench_exit=1` from ONLY the trajEval gate is acceptable — confirm push/pull/
   pullLatest are within baseline.
4. **The frontier gate stays sacred:** `voices === 1` ⇒ exactly the Stage-3 scalar path;
   stateless ⇒ exactly the time-axis SIMD path. Do NOT thread `· W`/`· voices` into
   `stateLayout`, `paramLayout`, or the scalar emitter — it lives only in the voice emitter +
   the voice consumer branch.
5. **Voice I/O contract (for the demo + the new pin):** caller buffers are
   **voice-interleaved `[i·V + v]`**; `scalars` is per-voice (array) or broadcast (number);
   `outs[name].length ≥ n · voices`; `voices % W === 0`. Bit-exactness vs `evalReference` is
   per-voice (run `evalReference` once per voice with that voice's rows + scalar).
6. **Windows commit gotcha:** author the message with the Write tool to
   `.git/COMMIT_MSG_TMP.txt`, then `git commit -F` it and `rm`. Stage EXPLICITLY (never
   `git add -A`) — `examples/**/vendor/`, `verify-*.png`, `.claude/`, scratch `*.txt` files
   are untracked junk; `LLM_BUNDLE.md` is a gitignored artifact. (This session's commit
   `915d661` staged exactly the 12 Stage-4 files and nothing else.)
7. **Push:** local commits are fine; remote pushes need the user's explicit OK (re-confirm
   for Stage 5). Stage 4 is committed locally but **not pushed**.

---

## 7. Deferred follow-ups (independent of Stage 5, flag-don't-build unless asked)

These were flagged across Stages 1–4 and remain open; none block Stage 5:

- **Dynamic voice allocation / note-on-off / voice stealing** — the synth layer. v1 runs a
  FIXED batch; mapping MIDI notes → voice slots + stealing belongs above the compiler. The
  demo (§2) can do trivial fixed mapping; real allocation is its own piece.
- **`V % W ≠ 0` masked tail batches** — v1 requires `V` a multiple of `W` (pad with silent
  voices). A masked partial tail is a follow-up.
- **Fractional / modulated delay** (chorus, flanger) — Stage 3 §1's deferral, now
  per-voice. v1 delays are fixed integer `z⁻N`.
- **`lower.ts` JS authoring of stateful kernels** — the JS-source path (`compileKernel`,
  `connectJit({ kernel })`) is still stateless-only; only the token/IR path is stateful.
  Reconciling real-JS-is-sequential vs IR-is-simultaneous is the work here.
- **Per-buffer non-zero init (wavetables)** — buffers seed to 0 in v1.
- **Cross-voice fan-in / sum stage (a shared reverb bus)** — explicitly a SEPARATE stage
  DOWNSTREAM of the per-voice kernels, never inside the voice batch (it would break lane
  independence, the soundness premise). A `connectFanIn`-style sum could feed a single
  shared-reverb kernel after the V voices are mixed.

---

## 8. One-paragraph summary for the impatient

Stage 4 (shipped, `915d661`, 0.9.932) made stateful kernels vectorize across `V` polyphonic
voices (`W` per `v128`, lane = voice), gate-proven bit-exact per lane, with a voice-batched
runtime that live-swaps click-free and keeps lane-packed state across quanta. **Stage 5 is
consolidation:** build a playable `examples/poly-synth/` demo over the token+voice path, add
a `connectJit` voice e2e pin + the `bench:jit` "Cell 5 voice-batch speedup" number + a
README mirror, and write the **promotion-decision note** for the whole Frontier 6/7 subtree
(recommend: token-path-only into the core *or* keep soaking — the JS-source path can't
promote without breaking the zero-runtime-dep `acorn` guard). No new compiler invariants;
keep the `voices === 1` / stateless frontier gate byte-identical and the
`kernelHash(gain)` pin intact.
