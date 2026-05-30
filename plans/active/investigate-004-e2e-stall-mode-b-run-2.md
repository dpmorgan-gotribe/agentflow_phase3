---
id: investigate-004-e2e-stall-mode-b-run-2
type: investigation
status: draft
author-agent: Claude (Phase 2 build, post-Mode-B-Run-2 triage)
created: 2026-05-30
updated: 2026-05-30
parent-plan: null
supersedes: null
superseded-by: null
branch: null
affected-files:
  - projects/test-app/apps/web/app/page.tsx
  - projects/test-app/apps/web/app/about/page.tsx
  - projects/test-app/docs/screens-manifest.json
  - .claude/skills/agents/front-end/react-next/SKILL.md
  - orchestrator/src/feature-graph.ts
  - orchestrator/src/stall-watchdog.ts
  - projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/
feature-area: mode-b-build-orchestration
priority: P0
attempt-count: 0
max-attempts: 5
time-box-minutes: 60
hypothesis: "Three independent root causes compound to fail 5 of 12 features in Run 2. (a) PRODUCT — builders embed external CDN URLs (picsum.photos, unsplash.com) from the screens.json mockup HTML directly into production app/page.tsx; the react-next stack skill likely lacks explicit no-external-CDN guidance. (b) ROUTING — bug-121 tester→builder routing likely fires correctly but the feature still fails because tester max-3 is consumed FIRST (by 2 stall timeouts on attempts 1+2) before the diagnostic genuineProductBugs[] surfaces on attempt 3, leaving no budget to dispatch the builder fix. (c) STALL — attempts 1+2 stalls then attempt 3 success at 15min suggests keep-alive emission is correlated with rate-limit cool-down or cache-warm-up, NOT with actual stuck dispatches — stall-watchdog is misclassifying slow-but-progressing work as stuck."
---

<!-- STATUS STATE MACHINE
draft → approved → in-progress → completed → archived
                 → abandoned → archived

Investigations do NOT create branches by default — they are research tasks.
If the investigation leads to code changes, create a follow-up feature or bug plan.

TIME BOX: 60 minutes (operator-set, override of 30-min default).
  When time expires, document findings (even if incomplete) and recommend next steps.
  Do not exceed the time box — partial findings are better than no findings.
-->

# investigate-004-e2e-stall-mode-b-run-2: Why did 5 of 12 features fail with tester wall-clock stalls on test-app Mode B Run 2, and what mix of product / routing / stall-watchdog fixes recovers them?

## Question

Why did 5 features on test-app Mode B Run 2 (pipeline `15a61239-0758-4fd9-8eca-dfe33f609c52`) fail with E2E tester `error_stall_timeout: wall-clock-1800000ms` stalls — specifically, what mix of (a) product-code class bugs, (b) bug-121 tester→builder routing misses, and (c) stall-watchdog misclassification explains the failures, and which findings need follow-up `/plan-bug` vs stack-skill amendment vs `/plan-feature`?

The failing features: `feat-home`, `feat-about`, `feat-services`, `feat-case-studies`, `feat-static-pages`. (Plus `feat-contact-inquiry` + `feat-analytics-observability` — separate failure class, already covered by bug-007.)

The decisive empirical evidence: `feat-home/dispatches/tester-attempt-3.json` shows the tester correctly diagnosed root cause AND populated structured `genuineProductBugs[]` with `builderAgent: web-frontend-builder, taskId: home-screen` BEFORE the feature was marked failed — meaning at least one of the three sibling failure modes is real and orchestrator-side.

## Hypothesis

Three independent root causes compound:

1. **Product class** — builders embedded `picsum.photos` + `unsplash.com` URLs directly in `apps/web/app/page.tsx` instead of local `/public/` assets or `next/image` with `loading="lazy"`. The Playwright default `waitUntil: "load"` blocks until `window.load` fires; external CDN images that don't resolve in the test environment hold up `load` indefinitely → page.goto times out at the 30s default → ALL 17 E2E tests timeout uniformly. This is the bug the tester correctly diagnosed on attempt-3.

   **Sub-hypothesis on origin**: the screens.json scaffold from `/screens` carries the mockup-HTML's external CDN URLs verbatim. Builders dutifully port them into production code because (a) the react-next stack skill doesn't say "swap external image hosts for local /public/ assets" and (b) the screens fidelity rule says "match the mockup". The same root cause that drove ~50% of hatch-2's first-pass mockup→production drift in Phase 1.

2. **bug-121 routing miss (P0 sibling-of-bug-007)** — When tester surfaces `genuineProductBugs[]` on attempt 3 with `builderAgent: web-frontend-builder`, the bug-121 routing in `feature-graph.ts` SHOULD re-dispatch the builder with the tester's diagnostic as `retryContext` because the builder still has `feat-home/home-screen` task-retry budget = 1 (max 3 → remaining 2). BUT the feature was marked `failed` regardless. Two possible explanations:
   - (a) bug-121 routing IS firing but the feature-fail decision happens BEFORE the routing block executes (ordering bug — `taskOutcomes.failed` short-circuits feature evaluation).
   - (b) bug-121 routing is GATED on tester retry-budget remaining > 0, and when the tester's max-3 was consumed in 2 stalls + 1 diagnostic, no budget remains for the routing loop to verify the builder's fix.

   The fix shape mirrors bug-007 in either case: route the genuineProductBugs[] to the builder + treat tester max-3 as advisory (not fatal) when the last attempt produced a structured diagnostic.

3. **Stall classification** — attempts 1+2 on the same task hit 1800s wall-clock cap; attempt 3 (identical prompt + retryContext) completed in 15 minutes. The asymmetry suggests stall-watchdog is keying off keep-alive heartbeat emission rate, and Wave 3 high-concurrency periods (4-5 features in flight simultaneously) starve heartbeat emission via rate-limit cool-downs in `rate-limit-events.ndjson`. The dispatch is making progress (the tester eventually returns valid output on attempt 3) but the watchdog interprets the heartbeat gap as stuck. Stall-watchdog needs heartbeat-gap classification that distinguishes "rate-limited cool-down" from "actually stuck".

## Investigation Steps

Time-budget: 60 minutes. Order by ROI (cheapest decisive observations first).

### Q1: Product class (~15 min)

1. **Read `projects/test-app/apps/web/app/page.tsx`** verbatim. Count `picsum.photos` and `unsplash.com` `<img src>` references. Note whether they're raw `<img>` or `next/image`. Note whether any use `loading="lazy"`.
2. **Read `projects/test-app/apps/web/app/about/page.tsx`** (and `services/page.tsx`, `work/page.tsx` if present in the merged commits). Same count.
3. **Read `projects/test-app/docs/screens-manifest.json` + sample 2-3 entries from `docs/screens/`** — does the mockup HTML carry the same external CDN URLs? If yes → root cause is screens.json→builder verbatim porting. If no → builders independently introduced these URLs (more concerning).
4. **Grep `.claude/skills/agents/front-end/react-next/SKILL.md`** for `picsum`, `unsplash`, `external`, `CDN`, `placeholder`, `image host` — does the stack skill say anything about image-host policy? If not, the skill has a gap.
5. **Observation**: list every external-CDN URL site-wide. Categorize by (a) hero/banner imagery, (b) avatar/portrait, (c) gallery thumbnails. Each may need a different recovery strategy.

### Q2: bug-121 routing miss (~25 min)

6. **Read `orchestrator/src/feature-graph.ts` bug-121 routing block** (search for `bug-121` or `genuineProductBugs`). Note: condition for firing, what `taskOutcomes` writes happen before/after, how it interacts with tester `max-3`.
7. **Cross-reference**: read `projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/dispatches/feat-home/` directory listing. Did ANY `web-frontend-builder-attempt-N.json` exist with `attemptN >= 2` that received the tester's `genuineProductBugs[]` as `retryContext`? Two possibilities:
   - YES web-frontend-builder-attempt-2 exists post-tester-attempt-3 → routing fired but the builder's fix didn't unblock the feature → feature-fail logic is correct but something else broke
   - NO such attempt exists → routing did NOT fire after the tester's diagnostic → confirmed bug-121 routing miss class
8. **Grep `feature-graph.ts` for `taskRetry` counter increments around the tester block** — what's the exact condition under which `taskOutcomes.X = "failed"` triggers `result.status = "failed"` for the whole feature? Is there a window where the builder's retry budget could be exercised before the feature is marked failed?
9. **Check sibling features**: same dispatches/ scan for `feat-about`, `feat-services`, `feat-case-studies`, `feat-static-pages`. Same routing pattern (tester-attempt-3 produced genuineProductBugs[] then no builder re-dispatch)? Confirms the routing miss is systemic.
10. **Read `orchestrator/tests/feature-graph.test.ts` test coverage for bug-121** — does any existing test assert "tester returns genuineProductBugs[] on attempt 3 → builder re-dispatched"? If not, the unit-test coverage gap matches the runtime gap.

### Q3: Stall classification (~15 min)

11. **Read `projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/rate-limit-events.ndjson`** for the 03:40-04:15Z window (when feat-home tester attempts 1+2 stalled). Count `rate-limited` events. Was there cool-down pressure during the stall windows?
12. **Read `orchestrator/src/stall-watchdog.ts` (or equivalent)** — what triggers the wall-clock kill? Is it absolute elapsed time, OR last-keep-alive-since? Both? What's the heartbeat emission protocol — every N API responses, every N tool calls, or every N seconds?
13. **Compare** dispatch timestamps for feat-home tester attempts 1 / 2 / 3 with the orchestrator's concurrent dispatch count at each timestamp. Attempts 1 + 2 fired during peak-concurrency (Wave 3a — 4-5 features in flight); attempt 3 fired during Wave 3b (likely fewer concurrent). If concurrency-gradient correlates with stall-rate, that's strong evidence for the rate-limit-cool-down hypothesis.
14. **Read `orchestrator/src/keep-alive.ts`** (or wherever heartbeats are emitted) — under rate-limit pressure, does heartbeat emission pause until the API responds? If yes → watchdog mistakes "throttled" for "stuck". This is the root cause hypothesis.

### Q4: Recommendation synthesis (~5 min)

15. For each of Q1, Q2, Q3 — decide:
    - **Q1 PRODUCT** → likely: `/plan-bug` with two-part fix (react-next stack-skill amendment + a /screens-side guardrail that rewrites mockup CDN URLs to `/public/placeholder-<seed>.jpg` before emitting screens.json).
    - **Q2 ROUTING** → likely: `/plan-bug` mirroring bug-007 + bug-109 — schema field present, routing missing, 3-test minimum. May also need a "last-attempt-with-diagnostic" budget bonus (advisory cap that doesn't fail the feature when the final attempt produced a structured diagnostic).
    - **Q3 STALL** → likely: `/plan-feature` (stall-watchdog heartbeat-source-of-truth refactor) IF concurrency-correlation confirmed; `/plan-bug` IF a narrower fix (e.g., keep-alive emission inside rate-limit cool-down loop) covers the case.
16. Time-box-end: write the recommendation section even if Q3 is incomplete. Q1 + Q2 fixes will unblock the next Mode B run regardless of Q3 resolution.

## Findings

<!-- Populated by the investigating agent. Leave empty until the investigation runs. -->

## Recommendation

<!-- Populated by the investigating agent at time-box end. -->

## Attempt Log

<!-- Populated automatically by agents. -->
