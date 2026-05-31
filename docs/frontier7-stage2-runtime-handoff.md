# Apollo Frontier 7 — Stage 2: the persistent-state runtime (handoff)

**As of:** 2026-05-31 · current version **0.9.929** · branch `main` · next patch **0.9.930**.

> **What this is.** The kickoff for **Stage 2** of stateful kernels: making a gate-verified stateful kernel actually *run, click-free, across `process()` quanta* in the AudioWorklet. Stage 0 (semantics) and Stage 1 (the compiler) are **shipped** — a stateful kernel already compiles to scalar WASM proven `scalar-WASM ≡ evalReference`, with the acoustic gate rejecting unstable filters. What's missing is the runtime: the compiler emits a kernel that takes a `$__state` base-pointer arg, but `JitKernelConsumer` (the worklet runtime) doesn't yet allocate, persist, or thread a state slab. A filter that resets its `z⁻¹` every 128 samples is a click per quantum — Stage 2 fixes exactly that.
>
> **Read first:** this file; then `docs/frontier7-statefulness-semantics.md` (the locked decisions — esp. §2.2 simultaneous semantics + §3.6 the crossfade-state correction); then `src/jit/JitKernelConsumer.ts` (the runtime you are extending — read it end-to-end, it is ~590 LOC and the whole Stage-2 surface lives in it), `src/jit/JitKernelSwap.ts` (the pure fade schedule, unchanged), and `src/jit/connectJit.ts` (the 3-realm wiring + the `JitInstallMessage` you must extend). The Stage-1 commit is `0d9c5cc`; `tests/stateKernel.test.ts` shows the by-hand slab convention Stage 2 makes real.

---

## 1. What Stage 1 already locked (don't re-decide these)

- **Semantics are SIMULTANEOUS** (state-space / delay-line): every `readState` in an iteration sees the previous iteration's committed value; each register (≤1 write/iteration) commits at iteration end. The emitter realizes this with `$__st_*` (current) + `$__next_*` (to-commit) locals, committed at the loop-body tail. **The runtime never sees this** — it only loads the slab in, runs, stores the slab out.
- **The WASM ABI** (`emitKernelWat.paramLayout`): for a stateful kernel the param order is **`trip(i32) → arrays(i32, signature order) → $__state(i32) → scalars(width, signature order)`**. The `$__state` arg is a **byte offset into the shared memory** of a contiguous slab of `stateDecls.length` elements (one `width`-sized value per register, declaration order). The kernel **loads the slab at entry and stores it back at exit** — it does NOT initialize it. The caller owns initialization + persistence. A stateless kernel has no `$__state` arg (byte-identical to pre-statefulness).
- **The JS fallback ABI** (`emitJsKernel`): for a stateful kernel the emitted function takes a **trailing** typed-array param after the signature params — `function kernel(…signatureParams…, __state)` — reads `__state[k]` at entry, writes `__state[k]` at exit. Same persistence contract as WASM, just a typed-array view instead of a byte offset. (Stateless JS fallback unchanged — no trailing param.)
- **Cold start = the declared inits.** `tests/stateKernel.test.ts`'s `runStateful` is the reference: allocate a `Float32Array`/`Float64Array` of `stateDecls.length` seeded to the inits, write it into memory before the call, read it back after to persist, reuse the SAME slab across calls. One call of 512 ≡ two calls of 256+256 — that IS cross-quantum persistence, already proven at the bytes level.
- **State registers are NOT signature params.** This is the load-bearing plumbing fact: `JitKernelConsumer` is built from a `KernelSignature`, which carries **no** state information. So Stage 2's first job is *getting `stateDecls` (the `{name, init}[]`) to the consumer* — it cannot derive them from the signature.

---

## 2. Why the obvious design is wrong (the §3.6 correction — read before coding)

During a hot-swap fade, kernel **A** (current) and kernel **B** (incoming) are **different recurrences**. The naive design — one shared state slab — is **WRONG**: B would read A's filter memory mid-fade and corrupt its own recurrence (and vice versa). The correct design:

- **Each generation keeps its OWN state slab.** A writes/reads slab-A; B writes/reads slab-B. They produce their own independently-correct outputs into the existing disjoint `outA`/`outB` output slabs, and the consumer amplitude-blends the two outputs **exactly as it blends two stateless outputs today** (`blendAtoBintoOuts`, the exact-lerp `a + w·(b−a)`).
- **A freshly-installed kernel starts cold** (slab seeded to inits) → a short settling transient, which the rising crossfade gain largely masks (fine for filters; watch oscillators — note it, don't solve it).
- **On promotion** (`q.justCompleted`), B becomes current: **its slab becomes the current slab**. The old current's slab is dropped with the retiring instance.
- **On a non-finite abort during a fade**, the consumer snaps to current-A. A's slab has been advancing every quantum (current-A runs every quantum, idle/priming/fading), so it is live and valid — snapping to it is safe. **Do not** seed B's slab from A's.

**Bumpless transfer (deferred, but decide the predicate):** for a swap that changes only a *coefficient* on the *same topology*, seeding B's slab from A's at the swap instant gives click-free continuity (no cold transient). Gate it behind a **same-state-shape predicate**: the outgoing and incoming kernels have *identical ordered `(name, init)` `stateDecls`*. Stage 2 should **flag** this (a one-line TODO + the predicate) but **not build it** — cold-start + crossfade is correct and sufficient for v1.

---

## 3. The work, with exact anchors (`JitKernelConsumer.ts`)

The whole change is additive and contained to the consumer + the wiring that feeds it `stateDecls`. The stateless path must stay **bit-for-bit** identical (a frontier gate — pin it: a stateless consumer's layout, arg arrays, and output are unchanged).

### 3.1 Get `stateDecls` to the consumer

- **`JitKernelConsumerOptions`** (`:77`): add `readonly stateDecls?: ReadonlyArray<IrStateDecl>;` (absent/empty ⇒ stateless — the existing behavior, untouched). Import `IrStateDecl` from `./ir.js`.
- **Source of truth:** the compile worker has the IR (`compileTokens`/`compileIr` → it validated the tokens, so it has `ir.stateDecls`). Thread it through:
  - **`JitCompileResponse`** / the install path in `connectJit.ts` (`forwardCompileResponse`, `:485`–`:497`): the `jit-install` message (`JitInstallMessage`, `connectJit.ts:189`) must carry the `stateDecls` (a plain `{name,init}[]` — structured-clone-safe) alongside `bytes`/`module`/`exportName`. The acceptance response already knows the plan; surface `stateDecls` from the accepted IR (you may need to add it to the `accepted` `CompileResult` or recover it from the validated tokens — simplest is to add `stateDecls` to the `jit-compile` *response*).
  - **`JitWorkletOptions`** (`connectJit.ts:141`) + **`createJitConsumer`** (`:511`): pass `stateDecls` into the consumer ctor. But the worklet builds the consumer ONCE up front from the signature — and `stateDecls` aren't known until a kernel is compiled. **Decision to make:** either (a) the consumer learns `stateDecls` per-install (preferred — a kernel's state shape can differ per generation), carried on the `jit-install` message and applied in `installCompiledKernel*`; or (b) the consumer is constructed knowing the (single) kernel's `stateDecls`. **Recommend (a):** state shape is a property of the *installed kernel*, not the consumer, and it lets the same consumer host successive kernels with different state shapes. That means the **state slab is allocated/seeded at install time**, not construction.

### 3.2 Allocate + seed the per-generation state slabs

- The consumer's layout allocator (ctor, `:212`–`:227`) lays out `in:*`, `outA:*`, `outB:*` disjoint slabs. Add **`stateA` and `stateB`** regions — but their SIZE depends on `stateDecls.length`, which (under 3.1(a)) isn't known at construction. Two options:
  - **Reserve a fixed max** (e.g. 64 registers — matches the `SpmcRing` consumer cap precedent) at construction, so the layout + disjointness assertion stay construction-time and the `jitMemoryPages` budget is stable. Seed the live prefix (`stateDecls.length`) at install. **Recommended** — keeps `describeLayout()` + the disjointness pin construction-time and the memory budget predictable.
  - Or re-layout on install (more invasive; touches `jitMemoryPages` + the memory-grow guard). Avoid.
- **Seeding:** on `armInstance` (`:338`), write the incoming kernel's inits into **slab-B** (the incoming generation). On promotion (`q.justCompleted`, `:460`), slab-B's *role* becomes current — swap the slab references, don't copy. When current is the JS fallback (no SIMD yet), it uses **slab-A** (seed it to the JS kernel's inits at construction/first-install).
- `jitMemoryPages` (`connectJit.ts:264`) must account for the two state slabs (the fixed-max reservation × 2 × elemBytes, align16). Bump it; pin that a stateless signature's page count is unchanged.

### 3.3 Thread the state pointer into the arg arrays

- The prebuilt WASM arg arrays `_wasmArgsA`/`_wasmArgsB` (`:164`, built at `:236`–`:252`) are `[n, ...arrayOffsets, ...scalars]`. For a stateful kernel they must become `[n, ...arrayOffsets, stateOffset, ...scalars]` — the `$__state` arg goes **after arrays, before scalars** (matching `paramLayout`). A = slab-A offset, B = slab-B offset. Rebuild these when `stateDecls` is applied at install (under 3.1(a)).
- The JS fallback arg arrays `_jsArgsA`/`_jsArgsB` (`:168`) are signature-order. For a stateful JS fallback, **append** a trailing arg = the typed-array view over slab-A (resp. slab-B). Add the state view binding to `bindJsArrayViews` / `refreshViews` (`:497`, `:548`).
- Add `stateA`/`stateB` typed-array views to the cached-views set (`refreshViews`, `:548`) so the buffer-identity guard rebuilds them too.

### 3.4 The persistence + crossfade behavior

- **Persistence is automatic** once the slab isn't zeroed between quanta: the kernel loads it at entry, stores at exit, and the consumer reuses the same byte range every quantum. The ONLY thing Stage 2 must NOT do is re-seed mid-stream. Seed exactly once, at install (per generation).
- **`runCurrentA`/`runIncomingB`/`runJsFallbackA`** (`:476`–`:494`) need no structural change beyond the arg arrays now carrying the state offset / trailing view — the kernel functions are still called the same way.
- **The blend (`blendAtoBintoOuts`, `:522`) is UNCHANGED** — it blends the two *output* slabs, which each generation fills correctly from its own state. This is the elegant part: the §3.6 "independent state per generation" design means the existing output-blend Just Works.
- **`outputsFiniteB` (`:536`)** already guards the incoming kernel — keep it; a stateful kernel that goes non-finite at runtime (shouldn't, the acoustic gate rejects unstable ones, but a pathological input could) aborts the fade and snaps to current-A (whose state is live).

---

## 4. Tests (new: `tests/stateKernelConsumer.test.ts`, register in `test` + `test:unit`)

Mirror `tests/JitKernelConsumer.test.ts` (the stateless runtime pins) + reuse the wabt harness from `tests/stateKernel.test.ts`. Pins to land:

1. **Cross-quantum persistence (the headline):** install a gate-verified one-pole; drive the consumer over many small quanta (e.g. 8×64 samples) and assert the concatenated output equals one big `evalReference(ir, …, 512)` run — i.e. state carried across `process()` calls, no per-quantum reset. (This is the runtime analogue of `stateKernel` pin 1's 256+256 ≡ 512, but through `JitKernelConsumer.process`.)
2. **Click-free swap with independent state:** start on the JS fallback (cold), `installCompiledKernel`, drive through the fade, assert the blended output has no discontinuity (reuse the existing swap-glitch assertion style) AND that A and B used **disjoint** state slabs (extend `describeLayout()` to expose the state regions + assert disjoint, mirroring the existing output-slab disjointness pin).
3. **Promotion keeps state continuous:** after the fade completes, the promoted kernel continues from the state it accrued *during* the fade (not a re-seed) — assert continuity across the promotion boundary.
4. **Non-finite abort snaps to live JS state:** force an incoming kernel non-finite mid-fade (a crafted module or a poisoned input) and assert the consumer reverts to current-A whose state is intact.
5. **Stateless-path-untouched frontier pin:** a stateless consumer's `describeLayout()` regions, arg arrays, page count, and output are byte-identical to pre-Stage-2 (no state slab allocated; `stateDecls` absent).

Add a browser smoke (extend `examples/kernel-palette/` or a new `examples/state-filter/`) only if cheap — otherwise defer to Stage 5.

---

## 5. Process / gotchas

1. **Versioning:** next is **`0.9.930`**, patch-level (additive, `@experimental` subpath). Three-digit patch space `0.9.900 → 0.9.999`. Default to patch; ask before any `0.x.0`.
2. **Gates before any version-bumping commit:** `npm run typecheck` clean · full `npm test` green · `npm run bench` push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget · `npm run bench:jit` for the JIT-path change. Register the new test in `package.json` **both** `test` and `test:unit`.
3. **Known flakes (pre-existing, re-run once):** `connectJit` pin G (async worklet upgrade under load) and `Bridge.properties` (fast-check, unseeded). Not regressions unless reproducible.
4. **The stateless runtime path is a frontier gate** — keep it bit-for-bit. The cleanest guard is "no `stateDecls` ⇒ every code path is the pre-Stage-2 path" (the `stateDecls?.length ?? 0 === 0` early-outs).
5. **Windows commit gotcha:** author the message with the Write tool to `.git/COMMIT_MSG_TMP.txt`, then `git commit -F` it and `rm`. Stage explicitly (never `git add -A`) — `examples/**/vendor/`, `verify-*.png`, `.claude/`, `dbg.mjs`-style scratch are untracked junk; `LLM_BUNDLE.md` is a gitignored artifact.
6. **Push:** local commits are fine; remote pushes need the user's OK (the standing OK was for the Stage-0/1 session — re-confirm for Stage 2).
7. **`installCompiledKernel` runs in `port.onmessage`, NEVER `process()`** — seeding the state slab is part of arming, so it also happens off the audio thread. Good (no audio-thread allocation).
8. **`tests/stateKernel.test.ts` `runStateful` is the spec for the by-hand slab dance** — the consumer's per-quantum behavior must match it exactly (seed once, persist across calls). When in doubt, diff against it.

---

## 6. Quick-start checklist for the next session

1. Read this file + the semantics note (§2.2, §3.6) + `JitKernelConsumer.ts` end-to-end. Run `tsx tests/stateKernel.test.ts` to feel the slab convention.
2. Thread `stateDecls` to the consumer (§3.1) — recommend the per-install path (state shape is a property of the installed kernel). Extend `JitInstallMessage` + `forwardCompileResponse` + `installCompiledKernel*`.
3. Allocate the two per-generation state slabs (§3.2, fixed-max reservation), seed at install, swap-by-reference on promotion. Bump `jitMemoryPages`.
4. Thread the state offset into `_wasmArgs*` + the trailing state view into `_jsArgs*` (§3.3). Keep the blend untouched (§3.4).
5. `tests/stateKernelConsumer.test.ts` (§4, 5 pins) → gates → bump `0.9.930` → CHANGELOG `[0.9.930]` block → commit → push (re-confirm OK).
6. Update CLAUDE.md `src/jit/` entry + the statefulness handoff postscript to mark Stage 2 shipped, Stage 3 (delay lines, `z⁻N` ring buffers) next.

---

## 7. The road past Stage 2 (unchanged from the kickoff handoff)

- **Stage 3 — delay lines (`z⁻N`).** State extends from single-sample registers to addressable ring buffers with a modulo write cursor (echo, comb, short reverb, fractional delay). Grammar `stateBuffer` decl + indexed `readState`/`writeState`; emitter ring-buffer addressing; the gate runs long enough for the delay to wrap. Medium–large.
- **Stage 4 — SIMD across voices.** A voice-batched calling convention packs `W` independent instances per `v128`; the SIMD emitter re-engages along the *voice* axis; the gate proves SIMD-voices ≡ scalar-per-voice. The polyphony payoff. Large.
- **Stage 5 — surface + demo.** A live-tweakable filter/echo browser demo, the `connectJit` token path exercised for stateful kernels end-to-end, docs + README + the experimental-promotion note. Medium.
- **Deferred: `lower.ts` JS authoring** (a `let s = <literal>;` before the loop ⇒ a register; `s = expr;` ⇒ its `writeState`) — the real-JS-is-sequential vs IR-is-simultaneous reconciliation (enforce the single-write-at-end class where the two coincide). Independent of Stages 2–4.

---

## 8. Shipped postscript (0.9.930)

Stage 2 shipped as **0.9.930**, additive and `@experimental`. What actually landed vs the plan above:

- **`stateDecls` source of truth** — went with "add `stateDecls` to the *accepted `CompileResult`*" (§3.1's simplest option): both `compileIr` accepted returns now carry `ir.stateDecls ?? []`. `runJitCompile` forwards it on the `jit-result` response → `forwardCompileResponse` onto the `jit-install` message (both transports) → `handleJitInstallMessage` → the consumer's install methods. `connectJit` derives it from `tokensToKernel(tokens)` on the token path (JS-source path stays stateless) into `JitWorkletOptions` → `createJitConsumer`.
- **Per-install AND construction (a hybrid, not pure §3.1(a))** — the recommendation was "per-install only", but the JS fallback (current-A) is itself a stateful kernel that runs at idle *before any install*, so its state shape MUST be known at construction. So: `JitKernelConsumerOptions.stateDecls` fixes the consumer's `stateful` flag + layout + the JS-fallback / slab-A seed at construction; the install message's `stateDecls` seeds the incoming slab-B. v1 `connectJit` derives both from the same kernel so they always match; a stateful kernel installed onto a stateless consumer (or one exceeding the reserved registers) is refused (`install* → false`).
- **Fixed-max reservation** — `MAX_STATE_REGISTERS = 64` (exported from `JitKernelConsumer.ts`), per §3.2's recommended option, so `describeLayout()` + the disjointness assertion + `jitMemoryPages` stay construction-time and the page budget is predictable. `stateA`/`stateB` regions are reserved only when stateful (stateless layout byte-identical).
- **Promotion is a copy, not a reference swap** — §3.6 said "swap the slab references"; the static prebuilt arg arrays (which bake the slab offsets) made a tiny ≤64-element `slab-B → slab-A` copy at promotion strictly simpler and equally continuous. Documented inline.
- **One bug fixed beyond the plan** — the existing non-finite-abort path re-ran the current kernel (`runJsFallbackA`) *after* `runCurrentA` had already run it; for a STATEFUL kernel that **double-advances** the registers. The abort now projects the already-computed current-A output (`copyAtoOuts`) instead of re-running — bit-identical for a stateless kernel (the re-run was idempotent), correct for a stateful one. Pin 4 guards it.
- **Tests** — `tests/stateKernelConsumer.test.ts`, 5 pins, registered in `test` + `test:unit`. All green; `npm run typecheck` clean; `npm run bench` 1.30 µs; `npm run bench:jit` swap/install cells unchanged. The `Bridge.properties` + `Bridge.observability` flakes fired once each under load and passed on isolated re-run (documented in §5.3 — neither touches the JIT).
- **Demo deferred** — no `examples/state-filter/` yet (Stage 5 per §4).

**Stage 3 (delay lines — `z⁻N` ring buffers) is now the next frontier** (§7).
