# Standard mode (`MessageChannelBridge<S>`) — design note

**Status**: **shipped at 0.9.40** (2026-05-28). MVP1 scope as recommended below; versioning slot is 0.9.40, not 0.10.0 — see [Shipped postscript](#shipped-postscript) at the bottom for the override rationale.
**Author**: maintainer + Claude (2026-05-27 design, 2026-05-28 ship).
**Decision pending**: no — the maintainer chose to ship MVP1 on the same day this note was written. The design analysis below stands as the rationale; the only deviation from the recommendation is the version slot (0.9.40 patch instead of 0.10.0 minor).

## Executive summary

Standard mode is the project's long-reserved second transport tier — same schema DSL, MessageChannel + transferable ArrayBuffer instead of SAB + Atomics. It is meant for environments where Turbo mode's cross-origin-isolation requirement (COOP + COEP HTTP headers) cannot be deployed: third-party embeds, SaaS-hosted apps without header control, prototyping before COOP/COEP is set up, telemetry channels, anything non-audio-critical.

The audit's recommendation to ship Standard mode is real — the COOP/COEP burden does filter out a nontrivial chunk of potential adopters, and Standard's 5–50 ms latency floor is acceptable for the use cases it targets. But "ship Standard mode" is not a single decision; it's three independent ones (API shape, versioning slot, scope cut) with multiplicative cost differences. The wrong combination — full feature parity, retroactively filling 0.8.0, single-maintainer ownership — would land somewhere between "double the maintenance burden" and "fork the project's release line in half." The right combination is much cheaper.

**Recommendation**: ship shape (b) "transport-only parity" at MVP1 scope, versioned as **0.10.0**. Roughly 600–800 LOC of new code + 200 LOC of tests + 150 lines of doc updates. Estimated effort: 2–4 focused weekends. Treats Standard mode as a deliberately-limited second-tier transport, not a Turbo replacement; preserves the project's monotonic version line; matches what the audit actually asked for (non-COI fallback for prototyping + control-plane updates).

Three reasons to **not** ship Standard mode at all are also enumerated below. They are real and the maintainer should weigh them deliberately.

## Why Standard mode exists — the problem it solves

Turbo mode's hard constraint is cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers gate `SharedArrayBuffer` and high-precision timers in every browser, for security reasons that won't change. Cross-origin isolation is a non-trivial deployment commitment: every cross-origin resource the page loads (third-party fonts, analytics, ad networks, images from a CDN that doesn't send `Cross-Origin-Resource-Policy: cross-origin`) must cooperate, or the page can't enable isolation.

Real-world cases where COOP/COEP can't be deployed:

| Audience | Why they can't deploy COI |
|---|---|
| Third-party embed authors (iframes inside customer sites) | The embedding page controls headers; the embed doesn't. |
| SaaS-hosted apps (WordPress / Squarespace / Shopify / etc.) | Customer doesn't control server headers; platform doesn't expose them. |
| Apps loading cross-origin assets that don't cooperate with COEP | Setting COEP breaks loading the assets; can't have both. |
| Local prototyping before deployment infrastructure is set up | Header config is post-MVP work for many teams. |
| Educational / sandbox contexts (CodePen / JSFiddle / StackBlitz / etc.) | Hosted sandbox doesn't expose header config. |

For these audiences, Turbo mode is currently a non-starter. They need a fallback — `MessageChannel` is the obvious one, because it works universally without COI and without `Atomics`.

The Standard mode pitch is: **same schema DSL, same frame API surface, different transport.** A team that wants to use this library's typed-frame ergonomics — but can't deploy COI — can use Standard mode for the non-audio-critical bits and either skip the audio bits or revisit Standard later when COI lands.

**Standard mode is explicitly NOT for audio rate.** Latency floor is 5–50 ms (vs Turbo's sub-µs); a 48 kHz / 128-sample audio quantum is 2.7 ms. Standard mode misses ~1–18 audio quanta per round trip. The audit acknowledges this. The use cases that legitimately need Standard are **control planes**, **telemetry**, and **prototyping** — places where 5–50 ms is fine.

## What's already in place

Before discussing what would need to be built, here's the scaffolding the project has already shipped for Standard mode:

1. **Two-tier framing is in the README** — the `### Two transport tiers — Turbo (shipped) and Standard (reserved at 0.8.0)` section names the second tier and frames the trade-offs.
2. **Environment helper already knows about Standard mode** — `src/environment.ts` exposes `suggestedMode: "turbo" | "standard" | "unsupported"`, latency-floor estimates for Standard (`STANDARD_FLOOR = { input: 10, output: 6, total: 16 }`), and fix descriptions that reference Standard mode by name. The interface is forward-compatible; no breaking change required to publish a Standard mode that the helper can recommend.
3. **Schema DSL is transport-agnostic** — `src/schema.ts` produces a `frameByteSize` + a `describeLayout()` that's JSON-safe for postMessage. The same schema definitions a Turbo `Bridge<S>` consumes would drive a Standard `MessageChannelBridge<S>` without modification.
4. **`ROADMAP.md` reserves 0.8.0** for `MessageChannelBridge<S>` (though see the versioning section below — the reservation is now stale because the project shipped past 0.8.0 in name even though no 0.8.0 release exists on npm).
5. **`bench/notify-cost-browser/`** already measures `Atomics.notify` cost as part of characterizing where Turbo wins; a Standard-mode counterpart could land in the same harness.

The missing piece is the `MessageChannelBridge<S>` class itself + tests + the README's switch from "reserved" to "shipped." Most of the design space below concerns *how* to build that piece, not *whether* the surrounding infrastructure is ready.

## Design space — API shape options

### Shape (a): full feature parity

`MessageChannelBridge<S>` exposes the entire `Bridge<S>` surface: PLL clock recovery, frame smoothing, invariant classification, trajectory evaluation, telemetry, backpressure policies, `pullAll`, `pullLatest`, the works.

| Pro | Con |
|---|---|
| Maximally satisfying — "same API, different transport" is the cleanest possible story. | PLL needs cross-thread clock observability that MessageChannel doesn't provide; would require an API-shaped stub that returns `null` / `0` for PLL fields. |
| No feature gap to document. | Smoothing is heap-only state — would work, but the value is mostly absorbed by MessageChannel's already-high latency floor. Smoothing 50 ms of jitter on top of a 50 ms transport floor doesn't help much. |
| Adopters can migrate Turbo → Standard or Standard → Turbo by swapping a single class. | Invariant classification needs the SAB header's `torn_frame` lane — can't replicate over MessageChannel without inventing a parallel mechanism. |
| | Doubles the maintenance surface: every change to Bridge features requires considering both transports. For bus factor 1, this is the deal-breaker. |
| | Suggests the two transports are equivalent. They aren't. |

**Estimated LOC**: 1500–2500 of new code + 500–800 of tests + 300 of docs.
**Effort**: 6–10 focused weekends for a single maintainer.

### Shape (b): transport-only parity *(recommended)*

`MessageChannelBridge<S>` exposes only the core SPSC verbs: `push(frame)` / `pull(frame)` / `pullLatest(frame)` / `scratchFrame()` / `describeLayout()` / overflow `policy`. No PLL, no smoothing, no invariant classification, no trajectory eval.

| Pro | Con |
|---|---|
| Honest about what each transport is for. Turbo is the precision instrument; Standard is the no-COI fallback. | Adopters who want smoothing on a Standard bus have to add it themselves. (Reasonable: the smoother is heap-only state; can be lifted out as a standalone utility.) |
| Schema DSL fully reused — same `defineSchema`, same `physicsControlFrameSchema(n)`, same `Frame<typeof S>` inference. | Feature gap between transports needs to be documented prominently. |
| Single-maintainer-sustainable. The new code surface is small. | "Same API surface" pitch becomes "same schema, subset API surface" — slightly weaker headline. |
| Future-proof — additional features can be ported to Standard as they're proven valuable, without committing up front. | |

**Estimated LOC**: 600–800 of new code + 200 of tests + 150 of docs.
**Effort**: 2–4 focused weekends.

### Shape (c): standard adapter (different name)

Don't call it `MessageChannelBridge<S>` at all. Ship a separate class — `StandardBus<S>` or `ControlChannel<S>` — that exposes a *deliberately different* interface (no scratch frames; structured-clone serialization per frame; explicit "this is the control-plane shape, not the audio-bridge shape" framing).

| Pro | Con |
|---|---|
| Sets low expectations explicitly. Adopters can't confuse Standard for Turbo. | Walks back the existing "Two transport tiers — Turbo and Standard" framing in the README, which the project has been shipping for ~30 patches. |
| Most freedom in API design — can be optimized for the control-plane use case without needing to mirror Bridge<S>. | Adopters who DO want to swap transports across environments have a harder migration. |
| Smallest implementation cost. | Loses some of the audit's framing — "the schema DSL works across both transports" was the headline; a separate name dilutes that. |

**Estimated LOC**: 400–600 of new code + 150 of tests + 100 of docs.
**Effort**: 1–2 focused weekends.

## Design space — versioning options

### Option (i): retroactively fill 0.8.0

Publish `webgpu-audio-bridge@0.8.0` to npm with Standard mode as its only public feature, derived from the current 0.9.38 codebase + the new `MessageChannelBridge<S>` class.

| Pro | Con |
|---|---|
| Honors the "reserved at 0.8.0" promise in the ROADMAP. | The published 0.8.0 would contain code logically derived from 0.9.x — confusing semantically. |
| `npm install webgpu-audio-bridge@^0.8.0` resolves to the Standard mode track. | npm `latest` semantics get weird: `^0.8.0` and `^0.9.0` resolve to different versions, which is technically correct but unintuitive. |
| | Future Standard-mode patches need their own version stream (0.8.1, 0.8.2 …) — doubles the release-management overhead. Bus factor 1 makes this unsustainable. |
| | The "0.8.0 reserved" promise was made under the assumption that the project would land at 0.8.0 *next*, not jump past it. The promise is now archeological; adopters won't lose trust if we update it. |

### Option (ii): ship as 0.10.0 *(recommended)*

Standard mode lands as the next minor bump after 0.9.x. The 0.8.0 reservation in the ROADMAP gets formally retired and replaced with a 0.10.0 anchor.

| Pro | Con |
|---|---|
| Monotonic version line — what every adopter expects. | The "reserved at 0.8.0" framing in the README and ROADMAP needs to be rewritten. (Cheap; one patch.) |
| One release stream to maintain. Bus factor 1 sustainable. | Slight credibility hit for slipping the reserved slot — mitigated by an honest ROADMAP note. |
| Honors the project's own versioning policy: a new transport with a new public API class is a minor bump, not a patch. | |

### Option (iii): ship as a 0.9.x patch

E.g., 0.9.40 introduces `MessageChannelBridge<S>`. Cheapest in version bookkeeping.

| Pro | Con |
|---|---|
| No minor bump means no perceived "release moment" — just lands like the other audit-response patches. | **Violates the project's own versioning policy.** New transports with new public API classes are explicit minor-bump triggers in `CLAUDE.md`. |
| | Confuses adopters who follow semver — they don't expect new public classes in a patch. |
| | Sets a bad precedent for future cohorts. |

**Effectively a non-option** — keep listed for completeness but rule out.

## Design space — scope cuts

For shape (b) "transport-only parity," three viable MVP scopes:

### MVP1: minimal viable Standard

| Surface | Included | Excluded |
|---|---|---|
| `MessageChannelBridge<S>` class | ✅ | |
| `push(frame)` | ✅ | |
| `pull(frame)` | ✅ | |
| `scratchFrame()` | ✅ | |
| `describeLayout()` | ✅ | |
| `pullLatest(frame)` | | ❌ (reserved for MVP2) |
| `pullAll(out)` | | ❌ (reserved for MVP2) |
| Overflow policy (`reject` / `drop-*` / `block`) | | ❌ (reserved for MVP2) |
| Telemetry | | ❌ (reserved for MVP2+) |

**Estimated LOC**: 600 of code + 150 of tests + 100 of docs.
**Effort**: 2 focused weekends.

### MVP2: control-plane-complete

Adds `pullLatest`, `pullAll`, overflow policies, basic telemetry. Closes the API gap that matters most for control-plane adopters.

**Estimated LOC**: +400 of code + +200 of tests + +150 of docs over MVP1.
**Effort**: +2 focused weekends.

### Full transport parity

Adds whatever Bridge features can sanely run over MessageChannel (deliberately excluding PLL + invariant lane + flow_scale, which need SAB header semantics).

**Estimated LOC**: +400 of code + +200 of tests + +100 of docs over MVP2.
**Effort**: +2–3 focused weekends.

## Implementation cost — concrete sketch

Files that would land for **shape (b), MVP1, versioned 0.10.0**:

```
src/
  MessageChannelBridge.ts                   (~500 LOC)
    class MessageChannelBridge<S extends Schema>
    push / pull / scratchFrame / describeLayout
    static allocate(capacity, schema) → { port1, port2, capacity }
    overflow handling at MVP1: silent reject when in-flight queue full

  index.ts                                  (+2 export lines)
    export { MessageChannelBridge } from "./MessageChannelBridge.js"

tests/
  MessageChannelBridge.test.ts              (~150 LOC, ~6 pins)
    1. push/pull round-trip for scalar schema
    2. push/pull round-trip for array schema
    3. capacity-respect (in-flight queue caps at capacity)
    4. describeLayout matches Bridge<S>.describeLayout for same schema
    5. scratch-frame mutation doesn't affect already-posted frames
    6. cross-worker push/pull via MessagePort.transferable

bench/
  Bridge.standard.bench.ts                  (~80 LOC, optional)
    push/pull latency in same-thread + cross-worker configurations

README.md                                   (~50 LOC delta)
  - "Two transport tiers" section: Standard moves from "reserved" to "shipped"
  - Browser support matrix: Standard mode row becomes "✅ shipped" everywhere
  - Quick start: add a Standard-mode example alongside the Turbo one
  - "Maintenance & operational status" → Scope discipline: add a "what
    Standard mode deliberately doesn't include" sub-bullet

ROADMAP.md                                  (~30 LOC delta)
  - Replace "Reserved slot — 0.8.0" subsection with "Shipped — 0.10.0"
  - Note the slot slip honestly

CHANGELOG.md                                (~150 LOC delta)
  - [0.10.0] entry with the usual structure
  - Wire-compat note: new public class; no impact on existing Bridge<S> users

CITATION.cff, package.json                  (1 line each)
  - version bumps to 0.10.0
```

**Total: ~700 LOC of code + 250 LOC of tests/bench + 230 LOC of doc deltas = ~1180 LOC for a complete shipped MVP1.**

For a single-maintainer project, that's a substantial 0.10.0 — not a casual patch. Two-to-four focused weekends is realistic, with the lower end being "I know exactly what I'm building" and the higher end being "I need to design as I go."

## Decision criteria

Three questions the maintainer should answer before committing to ship:

1. **Is there a real adopter waiting for this, or is it speculative?**
   The audit's complaint is hypothetical — "you should ship this." Real adopters asking for Standard mode are a much stronger signal. If no one has filed an issue requesting it, MVP1 might be premature; if even one credible adopter has asked (especially someone in the third-party-embed or SaaS-hosted camp), MVP1 is justified.

2. **Does the maintainer want to maintain two transports for the foreseeable future?**
   Shape (b) MVP1 is sustainable for bus factor 1, but it's still a permanent expansion of the project's surface. Every future API addition has to consider "does this also need to work in Standard?" That's a real cognitive overhead, not a free option.

3. **Does the project's 1.0 stability promise need to cover both transports, or only Turbo?**
   If Standard ships at 0.10.0 and 1.0 lands at some future date, the 1.0 stability promise either covers both transports (expensive — Standard's API freezes in lockstep with Turbo) or only Turbo (creates a permanent two-tier maturity story). The latter is honest but requires explicit documentation. Worth deciding NOW so 1.0 doesn't surprise anyone.

## Recommendation

**Ship shape (b) — transport-only parity — at MVP1 scope, versioned as 0.10.0.** Land MVP2 features as 0.10.x patches in a subsequent soak cohort, mirroring the 0.9.x discipline.

Rationale:

- **Shape (b)** is the only shape that's sustainable for bus factor 1 over multiple years. Shape (a) doubles the maintenance burden; shape (c) walks back framing the project has been shipping. (b) is honest about what each transport is for, and the schema DSL stays the unifying spine.
- **MVP1** is what the audit actually asks for. The complaint was "prototyping before COOP/COEP" and "control-plane updates in unisolated embeds" — neither needs `pullLatest` or backpressure policies on day one. MVP2 features can land based on actual adopter demand, not speculation.
- **0.10.0** is the cleanest versioning slot. The "reserved at 0.8.0" framing is now historically odd (the project shipped past 0.8.0 in name); honest retirement of the slot in the ROADMAP costs one paragraph and gains a coherent forward path.

**Alternative recommendation** if there is no real adopter waiting: **don't ship**, and instead expand the existing "reserved slot" section in the ROADMAP to make the deferred status explicit and dated, with an "adopt this issue if you want it built" call-to-action. Bus factor 1 makes "build it speculatively because an auditor said we should" a poor trade.

## What this is NOT

Explicit non-goals for Standard mode, regardless of which shape ships:

- **Not a path to audio rate.** Latency floor stays 5–50 ms forever. The library will never document Standard mode as audio-rate-capable.
- **Not a Turbo replacement.** Adopters who can deploy COOP/COEP should use Turbo for everything. Standard is the fallback, not the default.
- **Not auto-detection.** The user picks `Bridge<S>` (Turbo) or `MessageChannelBridge<S>` (Standard) at construction. The library will not silently swap transports based on environment — that's a documented invariant of the project's design philosophy.
- **Not a port of every Bridge feature.** PLL, invariant classification, and flow_scale need SAB header semantics; they will not ship on Standard. Frame smoothing might land as MVP3+ but is not promised.

## Open questions

1. **Should Standard mode be in the main entry, or a subpath (`webgpu-audio-bridge/standard`)?** Subpath would let adopters not paying for Standard avoid the code in their bundles. Main entry is simpler. Probably main entry for MVP1; revisit if tree-shaking matters.
2. **How does Standard mode interact with `BridgeBlockProducer` / `BridgeBlockConsumer`?** These are audio-rate helpers; they shouldn't accept a `MessageChannelBridge<S>` (which can't sustain audio rate). Either the type system enforces this (probably easy) or the docs do.
3. **Should the schema-driven serialization use the existing scratch-frame DataView mechanism, or a freshly-allocated `ArrayBuffer` per `push`?** Heap-side ring with reused buffers is cheaper; per-call allocation is simpler. MVP1 should probably do per-call allocation; optimize later if benchmarks demand.
4. **Standard mode tests in CI** — should they go in the existing 22-suite gauntlet, or a separate `tests/standard/` directory? Probably separate; the suite is already large and parallelizable.

## Next steps if the call is to ship

1. **Open a GitHub issue** documenting the intent + this design note + the chosen shape/scope. Pin it. Solicit at least one adopter voice before sinking 2–4 weekends.
2. **Draft `src/MessageChannelBridge.ts` skeleton** with the public API surface but no implementation — verify the type-level story works (schema reuse, `MessageChannelBridge<typeof MySchema>` infers correctly, `describeLayout()` returns the same shape as `Bridge<S>.describeLayout()`).
3. **Land the implementation in a feature branch** with the test pins listed above. Don't merge until cross-engine Playwright CI passes.
4. **Update the README's transport-tier section** to flip Standard from "reserved" to "shipped" in the same PR. Update the ROADMAP, the browser-support matrix, and the latency-floor estimates in `src/environment.ts`.
5. **Tag 0.10.0** with a substantial CHANGELOG entry mirroring the structure of other major-feature releases (0.6.18 for `BridgeGPUSource`, 0.6.19 for `BridgeInputLane`).

## Next steps if the call is to NOT ship

1. **Replace the ROADMAP's "Reserved slot — 0.8.0" subsection** with a dated, honest deferral notice: "Standard mode (`MessageChannelBridge<S>`) remains a viable future addition but is not on the active roadmap. See [design note](./docs/standard-mode-design.md). Adopt this issue if you want it built." Link the design note.
2. **Update the README's transport-tier section** to reflect "Standard mode is a documented future option, not a near-term ship."
3. **Leave the environment-helper scaffolding in place** — `suggestedMode: "standard"` is still meaningful information to surface to the user, even without a `MessageChannelBridge<S>` class to recommend.

Either path is honest. The worst outcome is shipping Standard mode under-baked because an auditor said to and then watching it bit-rot. The second-worst is leaving the ROADMAP's reserved-slot promise dangling indefinitely. This design note exists to make either choice deliberate rather than default.

— end of design analysis —

## Shipped postscript

Standard mode shipped on 2026-05-28 as the **0.9.40 patch**, not the 0.10.0 minor bump the analysis above recommended. The maintainer's override rationale:

> Re-reading CLAUDE.md's minor-bump triggers (wire-format changes, breaking public-API changes, accumulated-patch promotion moments), a new additive public class with no wire-format change and no breaking change to existing surfaces is squarely in the "patch by default" category. The 0.10.0 framing was over-cautious. Treating Standard mode as one more additive-API improvement keeps the 0.9.x soak cohort intact and matches the existing patch cadence.

The recommendation's reasoning ("a new transport with a new public API class is a minor-bump trigger") confused "substantial" with "breaking." Standard mode is substantial — it doubles the project's transport surface — but every existing `Bridge<S>` user can `npm install` 0.9.40 without changing a line of code. That's the test for patch-vs-minor under semver, and it lands on patch.

Other deviations from the design analysis above:

- **Capacity model**: the analysis suggested ack-channel-based producer-side capacity tracking ("silent reject when in-flight queue full"). The shipped implementation does **consumer-side drop-oldest** instead — simpler (no ack channel needed), matches `BridgeGPUSource`'s established freshness-first philosophy, and exposes drops via `droppedCount()`. The trade-off is that the producer has no direct backpressure signal; for MVP1 control-bus use cases that's fine.
- **Test count**: 9 pins shipped, not the 6 the analysis sketched. The extras cover construction validation, empty-pull semantics, and close() lifecycle — necessary for a public class even if not headline functionality.
- **LOC estimate**: shipped at ~390 LOC of class + ~360 LOC of tests + ~180 LOC of doc deltas = ~930 LOC, vs the analysis's ~1180 LOC estimate. The estimate was conservative; the actual implementation came in under budget because the schema DSL did most of the encoding/decoding heavy lifting.

The design analysis above is preserved unchanged as the historical reasoning record. The decision criteria it laid out remain useful for evaluating MVP2 scope expansions when those land.

## connect() Fallback Policy

`connect()` does not silently translate every Turbo backpressure policy to
Standard mode. Standard mode's MessageChannel transport is freshness-first and
consumer-side drop-oldest; it has no producer-side blocking or reliable
producer-side reject signal.

When a non-isolated environment falls back to Standard mode, these policies are
valid:

- no explicit policy: use the Standard default;
- `drop-oldest`: request the behavior Standard actually implements.

These policies throw `ConnectUnsupportedError` on fallback instead of degrading:

- `block`;
- `reject`;
- `drop-newest`.

This keeps integration code honest. A caller that needs blocking or explicit
reject semantics must require Turbo mode by passing `allowStandardFallback:
false` or by surfacing the isolation fix from `ConnectUnsupportedError.report`.
