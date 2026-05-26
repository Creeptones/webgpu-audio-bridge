# Repo guidance for Claude (and humans)

This file documents project-specific conventions that apply to any session working in this repo. Read it before starting work.

## Versioning policy — slow down on minor bumps

Pre-1.0 the project has been moving fast: `0.1.x → 0.2.0 → 0.3.0 → 0.4.0 → 0.4.1 → 0.5.0 → 0.6.0` in a short window, one minor bump per shipped improvement. **Going forward, slow down.** The 1.0 release should be a substantive milestone — many additional improvements are planned before it lands, and we don't want the public version number to inflate past the maturity it reflects.

**Default policy from 0.6.0 onward:**

- **Patch bumps (`0.6.0 → 0.6.1 → 0.6.2 …`) are the default** for any wire-compatible improvement. Smoothers, new helper APIs, perf wins, new docs, additional test pins, bug fixes, internal refactors — all patch-level.
- **Minor bumps (`0.6.x → 0.7.0`) are reserved for**:
  - Wire-format changes (new active lanes, frame-size additions, breaking SAB layout shifts).
  - Public-API breaking changes (renamed/removed methods, changed return types).
  - Accumulated patches reaching a coherent "release moment" worth calling out — let several patches land first, then promote in a batch.
- **Major bump (`0.x → 1.0.0`) is the deliberate stability commitment.** Do not bump there for a single feature; bump there when the API is settled and the project is ready to make compat promises.

**Practical rule for any session that ships an improvement:**

1. Default to a patch bump.
2. Only consider a minor bump if the change breaks wire format or breaks the public TS surface.
3. If unsure, ask the user before bumping `0.x.0`. A `0.6.1` that the user later promotes to `0.7.0` is cheap; a premature `0.7.0` they have to walk back is not.

The rapid 0.4 → 0.6 sequence was justified by each improvement adding a wire-format change AND a substantial public-API addition simultaneously. That bundling shouldn't be the norm — future improvements should usually land as `0.6.x` patches and accumulate.

**Extended slowdown from 0.7.0 onward (post-0.6.9 policy update).** Each minor-level cohort should reach deep into the patch space before promoting:

- `0.7.0 → 0.7.1 → 0.7.2 → … → 0.7.99` is the **expected** patch lifetime for a minor cohort. Don't promote to `0.8.0` after a handful of patches — let the patches accumulate and use each one as a checkpoint to assess "are we ready for 1.0 yet?"
- The same applies at every subsequent minor: `0.8.x` should likewise go deep before `0.9.0`, and `0.9.x` before `1.0.0`.
- Rationale: 80% of the polish toward 1.0 happens in the last 20% of the work. Treating minor bumps as cheap promotions inflates the version number past the actual maturity. Treating patches as effectively unbounded gives us a clean "assess at every step" cadence without ever feeling pressure to ship a premature 1.0.

The minor-bump triggers remain unchanged from the 0.6.x rule (wire-format change, breaking public-API change, or a deliberate "coherent release moment" promotion) — this rule just raises the bar on the third trigger. A coherent release moment that would have landed as `0.7.5 → 0.8.0` should now land as `0.7.5 → 0.7.6` and the promotion question revisited after another N patches.

If a session is genuinely unsure whether the change warrants a minor bump under this stricter rule, default to the patch bump and let the user promote later — same asymmetry as the original 0.6.x rule.

## Commit policy

- Each release-grade change gets its own commit with a multi-line message (subject line names the version + tagline; body describes what shipped, why, and any wire-compat notes).
- Mirror the prior CHANGELOG style — a session that bumps to e.g. `0.6.1` should append a `[0.6.1]` block above the previous entry with the same section shape (`### Added` / `### Why` / `### Wire compatibility` / `### Tests` / `### Documentation`).
- Include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (or current model identifier) in the commit trailer when Claude wrote the code.
- Never push to `origin/main` without the user's explicit OK. Local commits are fine; remote pushes require permission.

## Test / bench gates before any version bump

Mandatory before any commit that bumps the version:

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # all 6 suites green (schema / Bridge / Bridge.phaseLock / Bridge.concurrent / Float64RingBuffer / Float64RingBuffer.concurrent)
npm run bench       # push/pull/pullLatest median sanity-check vs documented baseline (~1.20 μs at N=1000)
```

The concurrent test has a known timing-sensitive `emptyWaitTimeouts === 0` assertion that can flake once on a loaded machine; re-run once if it fires, treat as real only if reproducible. Document any new flake patterns in the relevant test file's header.

## What lives where

- `src/Bridge.ts` — the primary public surface. ~1,134 lines as of 0.6.9. Header comment blocks document every lane and every protocol invariant; keep them current when changing behavior. Bridge composes one `SpscRing<S>` (`this.ring`), one `FrameSmoother<S>` (`this.smoother`), and one `ConsumerClockRecovery` (`this.pll`) — every public method is either a delegator or the invariant-classifier orchestration.
- `src/SpscRing.ts` — internal SAB / Atomics core (0.6.8 extract). ~866 LOC. Composes one `AdaptiveFlowController` for the lane-2 PI tick. Internal-only through 0.6.9; 0.6.10 is the promotion patch.
- `src/FrameSmoother.ts` / `src/ConsumerClockRecovery.ts` / `src/AdaptiveFlowController.ts` — the three internal heap-state machines extracted in 0.6.9. ~312 / ~134 / ~131 LOC. Each carries a self-contained file header documenting invariants + the math. Internal-only through 0.6.9.
- `src/schema.ts` — DSL + compile pass. `.withInvariant(fn, { absoluteEpsilon? })` (0.6.6 added the epsilon opts).
- `src/trajectory.ts` — order-1/2/3 Taylor evaluator with optional safety clamps (0.6.7). Fast / clamped paths split per-spec.
- `src/Float64RingBuffer.ts` — deprecated legacy class. Frozen at v0.1.x byte format. Removal scheduled no earlier than 2.0.
- `tests/Bridge.test.ts` — 63 single-thread pins as of 0.6.9 (file header lists each by number). New pins append at the end with a numbered header comment and get added to `main()`'s call list. Use the existing `assert` / `assertEq` / `ok` helpers from `tests/_assert.ts`; no test framework.
- `tests/Bridge.concurrent.test.ts` — 1 M-frame cross-thread SPSC stress. Producer is an inline-eval Worker; uses `Bridge.describeLayout()` so schema changes auto-propagate.
- `tests/Bridge.phaseLock.test.ts` — FFT-based phase-lock spectrum pin (added 0.6.4).
- `bench/Bridge.bench.ts` — push / pull / pullLatest cells + 0.5.0's `flow_scale recovery` characterization cell + 0.6.7's `trajEval (fast)` / `trajEval (clamp)` cells.
- `CHANGELOG.md` — newest entry at top. Entries follow the established structure.
- `README.md` — public docs; mirror CHANGELOG entries for shipped features under the relevant section (API reference, Back-pressure, Roadmap, etc.).

## Where the bridge is consumed

The website twin at `../NewProject/website/src/lib/wavefunction/gpu/Float64RingBuffer.ts` is a separately-maintained copy that's gradually being migrated to consume this package directly. See `../NewProject/website/WebsitePlans/WebAudioBridge Improvements 4 - Migration to Bridge in website twin.md` for the migration plan. Changes to this repo's public API should be conscious of the website consumer, but the website is not a release blocker — it pulls via `npm link` and can update at its own cadence.
