---
task-id: "025b"
title: "/visual-review Skill (Layer 7 — LLM Visual Critique)"
status: pending
priority: P2
tier: 6 — Design Pipeline
depends-on: ["025", "032b", "034b", "041"]
estimated-scope: medium
---

# 025b: /visual-review Skill

## What This Task Produces

Skill at `.claude/skills/visual-review/SKILL.md` — the **Layer 7** LLM-based visual critique loop that sits between `/screens` and `/user-flows-generator`. For every generated screen, it renders the HTML at three viewports via Playwright MCP, screenshots it, and runs a structured rubric against each screenshot. On failure, structured feedback is emitted and the orchestrator re-invokes `/screens` for that single screen (up to 3 visual retries, independent of the HTML-verifier retry budget).

## Why This Exists

Refactor-001 identified that Task 032b (HTML Verifier, Haiku, regex) catches mechanical violations — raw hex, missing primitives, lorem ipsum — but cannot detect **visual** problems: orphaned elements, broken hierarchy, overflow at mobile width, absent loading/empty states, accent color used in >10% of visible area, clicheé "AI lila" aesthetics, etc.

Blueprint spec §10 (visual critique checklist) defines the seven-section rubric that separates "generated" from "designed." Without a dedicated skill that screenshots → judges → loops, the rubric is aspirational. This skill makes it operational.

Layer 7 is additive to Layer 6 (032b). Both run on HTML output; 032b catches mechanical first (fast, cheap, Haiku), then 025b runs the visual rubric (Sonnet/Opus-level judgment, slower, more expensive).

## Scope

### SKILL.md frontmatter

```yaml
---
name: visual-review
description: Screenshot every generated screen at 3 viewports, run the spec §10 visual critique checklist, and emit retry feedback when the rubric fails. Runs after /screens, before /user-flows-generator.
when_to_use: after /screens completes and /verify-html (032b) has passed; before /user-flows-generator
allowed-tools: Read Write Bash Grep Glob
---
```

### Prerequisites

- `/screens` has completed — `docs/screens/{platform}/*.html` exist
- `/verify-html` (032b) has passed on those files — no point running Layer 7 if Layer 6 already failed
- `docs/selected-style.json` exists — provides the styleId + dials the rubric checks against
- `packages/ui-kit/` exists — rubric references kit tokens/primitives for "uses only tokens" / "uses only primitives" checks
- MCP servers `playwright` (required) and `chrome-devtools` (optional) are registered — task 041 must have provisioned them

### Steps

1. **Pre-flight:**
   - Assert `docs/selected-style.json` exists and parses against `SelectedStyleSchema` (task 034b)
   - Assert `docs/screens/` has at least one HTML file per detected platform (from `docs/brief-summary.json`)
   - Assert the Playwright MCP is available (MCP server health check)
   - If any pre-flight fails, exit with structured error; do not attempt review

2. **Spin a local static server** serving `docs/` (port chosen dynamically; written to `pipeline/visual-review-{stage}-{timestamp}.lockfile`). Kill the server on skill exit (success or fail).

3. **For each screen** in `docs/screens/{platform}/*.html`:

   a. **Render at three viewports** using Playwright MCP:
   - Mobile: 390 × 844
   - Tablet: 768 × 1024
   - Desktop: 1440 × 900

   b. **Capture full-page screenshots** for each viewport. Save to
   `docs/visual-review/{platform}/{screen-id}/{viewport}.png`.

   c. **Run the rubric** (see below) against the three screenshots together.
   The rubric is authored as an LLM prompt that takes the PNGs as vision
   inputs and produces a structured JSON critique.

   d. **Write the critique** to
   `docs/visual-review/{platform}/{screen-id}/critique.md` (human-readable)
   AND append to the aggregate `docs/visual-review/report.json`.

   e. **If the rubric passes**, mark the screen as `reviewed: pass` and move on.

   f. **If the rubric fails**, write `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` — a structured, actionable set of instructions the `/screens` skill can consume on re-invocation. Example:

   ```markdown
   # Retry feedback — dashboard (mobile viewport)

   ## Failed rules

   - composition.single-primary-action: Two visually equivalent primary CTAs
     in the header at 390px — "New invoice" and "Invite team" both use the
     accent color. Reduce to one primary; secondary should be `ghost` variant.
   - color.accent-budget: Accent used in ~18% of visible area (target <10%).
     Move the stats-row background off accent-soft; keep the CTA and the
     paid-tag accent-only.
   - mobile.touch-target: "Edit" icon buttons in the table are 28×28 — below
     the 44×44 minimum. Bump to `size="md"` (44px) or move the action into
     a row swipe gesture.
   ```

4. **Aggregate report** at `docs/visual-review/report.json`:

   ```json
   {
     "version": "1.0",
     "runAt": "2026-04-20T14:45:00Z",
     "styleId": "style-03",
     "screensReviewed": 48,
     "passed": 43,
     "failed": 5,
     "retriesTriggered": 5,
     "needsHumanReview": [],
     "violations": [
       {
         "screen": "webapp/dashboard",
         "viewport": "mobile",
         "rule": "composition.single-primary-action",
         "severity": "error",
         "detail": "..."
       },
       {
         "screen": "webapp/dashboard",
         "viewport": "mobile",
         "rule": "color.accent-budget",
         "severity": "warning",
         "detail": "..."
       }
     ]
   }
   ```

   `needsHumanReview` is populated by the orchestrator (not by this skill) after the 3rd failed retry on a screen. It carries a list of `"{platform}/{screen-id}"` strings. Empty array when no screen has exceeded its retry budget.

5. **Return JSON** matching `VisualReviewOutput` schema (task 034b):
   ```json
   {
     "success": true,
     "screensReviewed": 48,
     "passed": 43,
     "failed": 5,
     "retriesTriggered": 5,
     "reportPath": "docs/visual-review/report.json"
   }
   ```

### Rubric — the visual critique checklist (blueprint §10 / spec §10)

The rubric is authored as a single prompt loaded at skill startup from
`.claude/skills/visual-review/rubric.md`. The prompt takes three PNG screenshots
(mobile, tablet, desktop) as vision inputs plus the screen's HTML path, the
styleId's dials from `selected-style.json`, and the kit's token list.

Output format: a structured JSON `{ rules: [{ id, passed, severity, detail }], overall: pass|fail }`.

**Seven rubric sections:**

1. **Composition**
   - `composition.single-primary-action` — only one visually dominant CTA per view
   - `composition.hierarchy-readable-in-2s` — primary headline + primary action identifiable within 2s of scan
   - `composition.no-orphans` — every element belongs to a visible group (header, card, list)
   - `composition.optical-alignment` — not just mathematical alignment; x-height baselines line up
   - `composition.intentional-whitespace` — whitespace looks chosen, not leftover

2. **Type**
   - `type.size-count` — max 3 font sizes on screen (display, body, caption)
   - `type.line-height-in-scale` — no magic numbers; line-heights match the kit's scale
   - `type.prose-width` — long-form text has `max-w-[65ch]` or equivalent
   - `type.tabular-nums` — numbers used for comparison are tabular-nums
   - `type.no-orphans` — no single word on the last line of a heading (enable `text-balance` or similar)

3. **Color**
   - `color.token-only` — no raw hex/rgb in visible styling (cross-check with kit tokens list)
   - `color.accent-budget` — accent color covers <10% of visible area (LLM eyeball estimate from the desktop screenshot; ±5% tolerance)
   - `color.contrast-AA` — body text ≥4.5:1, large text ≥3:1 against its background
   - `color.dark-mode-tokens` — **static CSS analysis** (not a screenshot check): Grep the screen's HTML/CSS; verify it uses kit tokens or CSS variables that respond to `.dark` class or `prefers-color-scheme`, and contains no hard-coded light-mode hex values. Dark-mode rendering is intentionally out of scope for v1 — adding it would double screenshot cost. A future task can add an optional `--dark` capture per viewport.

4. **States**
   - `states.empty-present` — empty state is visible when data list is empty (may require a separate render)
   - `states.loading-is-skeleton` — loading states use skeleton matching target layout, not spinners
   - `states.error-has-recovery` — error states include a recovery action
   - `states.focus-visible` — focus ring is custom (not browser-default blue outline)

5. **Motion** (inferred from HTML/CSS since screenshots are static)
   - `motion.reduced-motion-respected` — CSS honors `prefers-reduced-motion`
   - `motion.transition-duration` — all transitions ≤400ms unless narratively justified
   - `motion.transform-not-layout` — animations use `transform`, not `top`/`left`/`width`

6. **Mobile** (evaluated on the 390×844 screenshot specifically)
   - `mobile.touch-target-size` — all interactive elements ≥44×44pt
   - `mobile.thumb-zone` — primary actions in the bottom 2/3 of the viewport
   - `mobile.no-horizontal-scroll` — no content overflows 390px
   - `mobile.safe-area` — safe-area insets respected (bottom-sheet tabbars, etc.)

7. **Slop-sniff test** (the gut check)
   - `slop.not-v0-default` — doesn't look like a v0/Lovable default output
   - `slop.memorable-detail` — has at least one specific, memorable detail
   - `slop.would-ship` — passes the "would Linear/Stripe/Arc ship this?" sniff test

**Dial-aware checks:** the rubric reads `selected-style.json.dials` and adjusts expectations:

- `design_variance < 4` → do not penalize symmetric layouts
- `design_variance > 6` → require at least one asymmetric layout element per screen
- `motion_intensity < 3` → downgrade `motion.transition-duration` from error to warning
- `visual_density > 7` → accept tighter spacing; do not penalize `type.no-orphans` as aggressively

### Retry mechanics

- **Retry counter is owned by the orchestrator (task 035), not by this skill.** This skill is stateless: every invocation reviews the current screens and writes a fresh report. The orchestrator inspects `report.json.failed > 0`, increments its per-screen counter, and decides whether to retry or escalate.
- Per-screen visual retry budget: **3 attempts**, independent of 032b's HTML-verifier retry budget.
- On failure, the orchestrator re-invokes `/screens` for ONLY that screen with `retry-feedback.md` injected into the prompt. This requires `/screens` (task 025) to support a single-screen mode — see the "Cross-task dependency" section below.
- After 3 visual retries, the orchestrator writes `report.json.needsHumanReview: [...screenIds]`, flags those screens at the final sign-off gate, and proceeds. The pipeline does not abort; the human reviewer sees the flagged screens inline with their critique.md at sign-off.
- Visual retries do NOT re-run `/verify-html` (032b) because Layer 6 already passed; we only re-run Layer 7 after the retry completes.

### Cross-task dependency — /screens single-screen mode

This skill's retry loop assumes `/screens` can be invoked for a single screen. Task 025 (as currently spec'd) generates screens in batches of 20–40. To support per-screen retry, task 025's SKILL.md must be extended to accept `--screen {platform}/{screen-id}` as an alternate invocation mode. When the argument is present, the skill:

1. Skips the manifest-hash calculation for the whole set (only that one screen is affected)
2. Reads `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` if present and injects it into the generation prompt
3. Writes ONLY `docs/screens/{platform}/{screen-id}.html` (leaves the rest alone)
4. Returns a minimal return JSON `{ success: bool, screen: "platform/id", attempt: N }` for the orchestrator

**This dependency must be reflected in task 025's scope and acceptance criteria.** Add an acceptance bullet: "Supports single-screen invocation via `--screen {platform}/{screen-id}` argument that consumes `retry-feedback.md` from `/visual-review`."

### Cost and timeout

Per-screen LLM-vision cost: 3 screenshots × ~1 LLM call with vision input. At Sonnet 4.6 pricing (~$3/MTok input, ~$15/MTok output, image tokens ~1.5k per ~1MP image), a 50-screen app reviewed once costs roughly **$3–$8**. With retries, budget **$10–$20** per project for this stage.

- Per-screen timeout: **90 seconds** (generous — vision is slower than text). If exceeded, the screen is marked `review-timeout` in the report and added to `needsHumanReview` without consuming retries.
- Per-run total timeout: **60 minutes** for up to 100 screens. Larger apps batch internally.
- Budget is enforced by the orchestrator (task 036) via the reserve-commit pattern.

### No --nanobanana interaction

`/visual-review` is observational, never generative. The flag has no effect here. The skill does not call `image-generator` or any generative MCP.

### MCP usage

- **Playwright MCP** (required) — multi-viewport screenshots; scoped to ui-designer + html-verifier in `architecture.yaml`
- **Chrome DevTools MCP** (optional) — Lighthouse + a11y tree inspection; if present, adds `lighthouse.score` and `a11y.violations` fields to the per-screen critique. If absent, those fields are omitted with no error.

### Output contract

- `docs/visual-review/report.json` — aggregate (validated vs `VisualReviewOutput` in 034b)
- `docs/visual-review/{platform}/{screen-id}/{mobile,tablet,desktop}.png` — screenshots
- `docs/visual-review/{platform}/{screen-id}/critique.md` — human-readable critique
- `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` — only present when the screen failed; consumed by `/screens` on re-invocation
- Return JSON per step 5 above

## Integration Points

- **Task 035** (orchestrator): insert `/visual-review` stage between `/screens` and `/user-flows-generator`; implement the per-screen retry loop (max 3 visual retries, separate from HTML-verifier retries)
- **Task 034b** (output schemas): add `VisualReviewOutput` schema
- **Task 034** (output contracts): reference this skill as Layer 7 in the six-layer defense-in-depth table
- **Task 041** (MCP registration): `playwright` and `chrome-devtools` entries must exist in the catalog (already added in step 1)
- **Task 036** (HITL gates): at the final sign-off gate, reject if `report.json.failed > 0` remains after retries — the human reviewer sees the flagged screens with their critique.md inline
- **Task 037** (Lessons agent): aggregate `violations[]` from report.json files across projects → populates the anti-patterns log per spec §14

## Acceptance Criteria

- [ ] `.claude/skills/visual-review/SKILL.md` exists with the frontmatter above
- [ ] `.claude/skills/visual-review/rubric.md` exists with all seven rubric sections verbatim
- [ ] Pre-flight asserts `selected-style.json` parses and at least one screen exists; aborts cleanly otherwise
- [ ] Local static server lifecycle is managed (started + killed on skill exit, even on failure)
- [ ] Three viewport screenshots produced per screen at 390×844, 768×1024, 1440×900
- [ ] Per-screen outputs at `docs/visual-review/{platform}/{screen-id}/` include screenshots + critique.md
- [ ] Aggregate `docs/visual-review/report.json` matches `VisualReviewOutput` Zod schema
- [ ] `retry-feedback.md` written only for failed screens; content is actionable, not generic
- [ ] Rubric reads `selected-style.json.dials` and applies dial-aware adjustments
- [ ] No `--nanobanana` interaction (skill has no image-generation path)
- [ ] Chrome DevTools MCP is used when present, silently skipped when absent (no hard dependency)
- [ ] Skill return JSON includes `screensReviewed`, `passed`, `failed`, `retriesTriggered`, `reportPath`
- [ ] Orchestrator (035) wired to re-invoke `/screens` on failure with retry-feedback injected (max 3 per screen)
- [ ] 034 references this skill as Layer 7
- [ ] 034b defines `VisualReviewOutput` schema
- [ ] Playwright MCP is required; skill aborts cleanly if Playwright is not provisioned
- [ ] Skill is stateless — retry counter is owned by the orchestrator, not persisted by the skill
- [ ] `report.json` includes `needsHumanReview: string[]` field (populated by orchestrator after exhausted retries)
- [ ] `color.dark-mode-tokens` rule is implemented as static CSS analysis (grep over HTML/CSS), not dark-mode rendering
- [ ] Per-screen timeout of 90s; `review-timeout` marker applied to timeouts without consuming retry budget
- [ ] Task 025 (/screens) scope updated to accept `--screen {platform}/{screen-id}` argument that consumes `retry-feedback.md` — cross-task dependency tracked

## Human Verification

1. Run `/screens` on a small project (2–3 screens). Then run `/visual-review`. Are screenshots produced at all 3 viewports for every screen? Do they look correct?
2. Hand-author a screen with a giant accent-colored background (~50% accent coverage). Does the rubric flag `color.accent-budget`? Is the retry-feedback.md actionable enough that re-running `/screens` with that feedback produces a visibly improved screen?
3. Hand-author a screen with `motion.transition-duration: 800ms` in CSS. With `motion_intensity: 2` in dials, does it flag as error? With `motion_intensity: 8`, does it pass or downgrade to warning?
4. Kill the Playwright MCP mid-run. Does the skill abort with a clear message, not a timeout?
5. Re-run after a fix. Does the previously-failed screen now pass without re-reviewing the already-passing ones?
