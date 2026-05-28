---
id: investigate-002-screens-cross-screen-drift
type: investigation
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-28
parent-plan: investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2
supersedes: null
superseded-by: null
branch: null
affected-files:
  - .claude/skills/screens/SKILL.md
  - packages/ui-kit/src/patterns/_extracted/
  - scripts/audit-screen-pattern-consumption.mjs
  - scripts/audit-cross-screen-consistency.mjs
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
time-box-minutes: 75
hypothesis: The kit-consumption rules in screens/SKILL.md are prose-only enforcement across MULTIPLE drift dimensions — the brand-mark drift is the most visible but it's one class of a larger problem. Parallel ui-designer agents lack mechanical contracts forcing verbatim consumption of (1) named patterns from `_extracted/*.html`, (2) the preview-bootstrap fontFamily section, (3) the `data-kit-*` attribute contract for builder translation, (4) imagery seed conventions, (5) avatar URL consistency, (6) copy voice rules, (7) inline-style hex prohibition. Empirical motivator (12-screen rerun on test-app, 2026-05-28T22:00Z): 0/12 screens used the kit's canonical wordmark; some screens emit 27 data-comp annotations while others emit 0; bootstrap fontFamily sections drift (one observed missing `display` mapping); raw hex literals leaked into SVG fills despite the kit-only contract. All same root cause: prose enforcement without mechanical check.
---

# investigate-002-screens-cross-screen-drift: /screens cross-screen drift across multiple kit-consumption dimensions

## Question

When `/screens` dispatches N parallel ui-designer agents (one per screen) and they all read the shared `.shared-preamble.md` + their per-screen specs, how many DRIFT DIMENSIONS surface across the resulting `docs/screens/{platform}/*.html` files — and which ones are caused by prose-only enforcement that a mechanical audit could close?

This investigation surveys **all** observable cross-screen drift, not just the visible brand-mark issue. Brand mark is the entry point; the full drift survey informs whether the fix needs to be one bug or multiple.

## Hypothesis

The consumer-side rule shipped in feat-001 (screens/SKILL.md Inputs §4b) says:

> "Consult kit patterns BEFORE inventing. When a section needs a logo composition, reach for `_extracted/wordmark.html` instead of inventing one."

This is prose-only enforcement — same class as the bug-002 drift that bit `/stylesheet`'s preview-coverage. Empirical evidence from the 12-screen rerun on `projects/test-app` (2026-05-28T22:00Z):

| Screen                         | Logo composition shipped                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| home, services-index, about    | Lightning-bolt SVG path (close to canonical kit shape, but missing the `<span class="logo-spark">` orange-square container + warm shadow) |
| services-detail-\* (3 screens) | Lightning-bolt SVG path variant (different stroke; missing canonical container)                                                           |
| case-study-detail              | **8-pointed star/burst** with `fill="#FF5C35"` literal + yellow inner circle — entirely invented                                          |
| contact                        | Same 8-pointed star/burst but yellow (`fill="#FFE14D"`) — entirely invented                                                               |
| not-found, others              | Multiple sub-variants, all reinventions                                                                                                   |

0/12 screens used the kit's canonical `<span class="logo-spark">` + 14×14 lightning-bolt `<path d="M13 2 4.5 13.5h6L8 22l8.5-11.5h-6L13 2z"/>` composition.

Predicted: the same drift exists for the other 8 named patterns (Eyebrow, StatTile, TrustBar, HeroBadge, ServicePillarCard, CaseStudyCard, Testimonial, SocialProofRow). Agents likely vary the eyebrow's accent bar shape (3-wide vs 6-wide), the stat-tile's bob keyframe timing, the trust-bar's brand-wordmark gap, etc.

If hypothesis confirmed: the fix mirrors bug-002. Two parts:

1. **Skill body extension** — screens/SKILL.md gains an explicit "INLINE the canonical pattern HTML verbatim" rule (not "consult and adapt") with a per-pattern table mapping canonical anchor markers (`<span class="logo-spark">`, the lightning-bolt path bytes, the `data-pattern="wordmark"` attribute) that MUST appear unchanged in every screen that uses the pattern.
2. **Mechanical audit script** — `scripts/audit-screen-pattern-consumption.mjs` reads `packages/ui-kit/src/patterns/_extracted/*.html` to extract per-pattern canonical-marker signatures, then greps every `docs/screens/{platform}/*.html` for those markers. On any miss, exits non-zero with the drifted screen + missing canonical anchor named in the report. Runs from project cwd, same shape as `audit-preview-coverage.mjs`.

## Investigation Steps

Time-boxed at 75 minutes total. Stop and document findings even if incomplete. The full drift survey is intentionally broad — narrowing the fix scope is part of the investigation's output.

### Step 1 — Survey the FULL drift landscape across all 12 screens (25 min)

Run a systematic per-dimension grep against all 12 screens. Record presence/absence per (drift-dimension × screen) cell. Drift dimensions to check:

**D1. Named-pattern consumption (the entry-point drift):**

- D1.1 — `wordmark`: canonical `<span class="logo-spark">` + 14×14 lightning-bolt SVG path bytes (`M13 2 4.5 13.5h6L8 22l8.5-11.5h-6L13 2z`)
- D1.2 — `eyebrow`: canonical 6-wide accent bar `<span class="inline-block h-1 w-6 bg-accent-500 rounded-full">` + uppercase mono text
- D1.3 — `stat-tile`: canonical `.stat-tile-bob` keyframe + 4-second bob animation + warm-orange shadow signature
- D1.4 — `trust-bar`: canonical `.trust-marquee` class + 30s `marquee-scroll` keyframe + named brand wordmark list
- D1.5 — `hero-badge`: canonical `.pulse-dot` class + 2s `hero-badge-pulse` keyframe + indicator-dot composition
- D1.6 — `service-pillar-card`: canonical icon-badge + heading + lede + bulleted list + "Explore service →" CTA structure
- D1.7 — `case-study-card`: canonical image + work-tag pill + headline + outcome metric structure
- D1.8 — `testimonial-block`: canonical accent-500 quote-mark + italic display-serif quote + attribution row with avatar
- D1.9 — `social-proof-row`: canonical avatar-stack of 3 overlapping circles + bold count + tagline structure

**D2. `data-kit-*` attribute contract (builder translation contract):**

- D2.1 — `data-kit-component` annotation density (per-screen count). Already observed: home=27, services-detail-social=13, all others 0–1.
- D2.2 — `data-kit-variant` presence on Button / Card / Badge instances
- D2.3 — `data-kit-layout` on the `<body>` element (per principle 11 of /stylesheet step 17, mirrors to /screens)
- D2.4 — `data-screen-id` on `<body>` matching filename (refactor-007.1 + feat-022)

**D3. Preview-bootstrap consistency (refactor-007 silent-styling guard):**

- D3.1 — `<script src="https://cdn.tailwindcss.com">` present (already verified: 12/12 ✓)
- D3.2 — Inline `tailwind.config` block present (12/12 ✓ per cross-screen check)
- D3.3 — Bootstrap `fontFamily` section maps `display: var(--font-family-display)` — already observed missing on services-detail-visual; need full per-screen check
- D3.4 — Bootstrap `colors.accent` extends `50..950` (vs. agents shortening to 500-only)
- D3.5 — Bootstrap `borderRadius.full: var(--radius-full)` mapping (otherwise pill buttons silently fall back)

**D4. Hex literal leakage (kit-only contract violation):**

- D4.1 — Hex literals in HTML attributes (excluding the canonical spark-mark SVG fill which IS the brand color)
- D4.2 — Inline `style="…"` attributes with `#XXXXXX` values
- D4.3 — Inline `<style>` blocks with hex literals outside the kit token system
- D4.4 — SVG `fill="#…"` outside `_extracted/*.html` canonical bytes

**D5. Font family consistency:**

- D5.1 — `font-display` Tailwind class density per screen (resolves to Bricolage via kit; should be ≥10 per screen for any content-rich page)
- D5.2 — `font-sans` + `font-mono` consistency
- D5.3 — Any explicit `font-family: …` declarations in inline `<style>` (should be 0 — agents shouldn't bypass the kit's font system)
- D5.4 — Duplicate Google Fonts `<link>` tags (waste — globals.css already imports fonts; mostly cosmetic but indicates agent uncertainty)

**D6. Imagery + avatar consistency:**

- D6.1 — Recurring avatar URLs: did all screens use the SAME 4 unsplash avatar URLs for Anika P. / Marco L. / Priya R. / Sam K. (per preamble), or did agents substitute their own URLs?
- D6.2 — Case-study imagery: did Bloom Co. + Northstar + Meridian use the SAME picsum seeds across home / work-index / case-study-detail? Or did the seeds drift?
- D6.3 — CSS tone-block substitutes for imagery (the `<div style="aspect-ratio:4/3;background:#…">` anti-pattern) — should be 0

**D7. Copy voice drift:**

- D7.1 — Cliché bigram occurrences (Elevate / Seamless / Unleash / Next-Gen / Empower / Transform your) — should be 0 per the preamble
- D7.2 — Lorem ipsum / TODO / REPLACE_ME placeholder leakage — should be 0
- D7.3 — Sentence-case heading consistency (vs Title Case or ALL CAPS in places that shouldn't be)
- D7.4 — Inquiry email consistency (`hello@hatch.studio` across screens, not `info@…` or `contact@…`)

**D8. Layout shell consistency:**

- D8.1 — Nav `position: fixed` vs `sticky` vs `absolute` (should be uniform — preamble says fixed)
- D8.2 — Footer 4-column composition (Logo+tagline / Services / Company / Contact)
- D8.3 — `max-w-[1280px]` content width consistency
- D8.4 — Section gap (`py-16` vs `py-20` vs `py-24`) consistency for similar section types

**D9. Inline `<style>` block content:**

- D9.1 — Per-screen inline `<style>` block line count (drift-revealing — agents adding lots of custom CSS classes vs minimal keyframes per preamble)
- D9.2 — Custom CSS class names that don't appear in `globals.css` (agents creating their own utilities — kit-bypass)
- D9.3 — `@keyframes` definitions: only canonical kit keyframes allowed (`marquee-scroll`, `stat-tile-bob`, `hero-badge-pulse`); others indicate drift

Build a matrix output: 12 screens × ~30 drift dimensions. The matrix shape itself tells us whether the drift is concentrated in a few screens (per-agent failure) or spread evenly (systemic prose-enforcement failure).

**Decision point:** if drift concentrated in 1-2 screens, individual agent fix; if spread across all 12, systemic skill-body extension required.

### Step 2 — Audit the dispatch prompts vs the screens/SKILL.md rules (10 min)

- Re-read the 12 dispatch prompts I sent to ui-designer agents at 2026-05-28T22:00Z (visible in this session's transcript).
- For each of the 9 drift dimensions (D1-D9), identify what the prompts said + what the skill body says.
- Categorise each drift dimension: (a) prompt was vague + skill is vague → both need tightening; (b) prompt was vague + skill is explicit → prompts inherited drift, skill alone is enough if prompts derive from skill; (c) prompt was explicit + skill is explicit + drift still happened → agent compliance issue not solved by more prose.

**Decision point:** categorising per drift dimension informs whether the fix is per-dimension (e.g. patterns get verbatim consumption, fontFamily gets explicit table, etc.) or one-size-fits-all.

### Step 3 — Test whether verbatim-inline prompts close the drift (15 min)

Hand-author a tightly-prompted dispatch for ONE screen (say `not-found.html`) that explicitly requires:

- "Read `_extracted/wordmark.html` and inline its contents VERBATIM — do not modify the SVG path bytes, do not change the `logo-spark` class name, do not substitute your own brand mark."
- "Read `_extracted/eyebrow.html` and inline VERBATIM above every section heading — do not change the 6-wide accent bar to 3-wide, do not change the gap value."
- "Use this exact preview-bootstrap inline config: <verbatim quote from preamble>. Do not modify any colors / fontFamily / borderRadius entries."
- "Annotate every Button / Card / Badge / Link / Logo with `data-kit-component="…"` and `data-kit-variant="…"`. The data-comp count should be ≥15 across the page."

Dispatch one ui-designer agent. Inspect output: does the agent consume verbatim across all drift dimensions, or do some still drift?

**Decision point:** if verbatim-inline prompts work for all dimensions, the fix is "tighten preamble + skill body"; if some dimensions still drift despite verbatim prompts, those dimensions need MECHANICAL audit (the prose ceiling).

### Step 4 — Design the mechanical audit (10 min)

Draft `scripts/audit-cross-screen-consistency.mjs` shape (project-agnostic, mirroring audit-preview-coverage.mjs):

1. Reads `packages/ui-kit/.patterns-extracted.json` → list of pattern slugs + per-pattern canonical-marker signatures parsed from `_extracted/{slug}.html`:
   - **Anchor classes** (e.g. `logo-spark`, `pulse-dot`, `trust-marquee`, `stat-tile-bob`)
   - **Canonical SVG path bytes** (the lightning-bolt `d` attribute)
   - **Canonical attribute markers** (`data-pattern="<slug>"`)
2. Reads `packages/ui-kit/src/styles/preview-bootstrap.html` → required tailwind.config sections (colors keys, fontFamily keys, borderRadius keys).
3. For each `docs/screens/{platform}/*.html`:
   - Grep for canonical pattern markers (D1)
   - Grep for required `data-kit-*` annotations density threshold (D2)
   - Compare inline bootstrap config to canonical preview-bootstrap.html — diff sections (D3)
   - Grep for hex literals + inline-style hex (D4)
   - Count `font-display` / `font-sans` / `font-mono` usage (D5)
   - Grep for cliché bigrams + lorem (D7)
   - Identify recurring imagery URLs that should match across screens (D6)
   - Count inline `<style>` block lines + unknown CSS classes (D9)
4. Per-dimension per-screen gap report.
5. Exits 0 on full consistency, 1 on any drift.

Cross-project agnostic: same script works for any project — reads each project's own `_extracted/*.html` + `preview-bootstrap.html` to compute markers.

### Step 5 — Estimate fix scope (10 min)

Per-dimension fix estimate, mirroring bug-002 shape:

- `bug-003`: kit-pattern verbatim consumption + audit (D1)
- `bug-004` (or fold into bug-003): preview-bootstrap consistency audit (D3)
- `bug-005` (or fold): `data-kit-*` annotation density rule (D2)
- `bug-006` (or fold): explicit hex-literal hard-prohibition + grep (D4)
- `bug-007` (or fold): copy-voice + imagery-seed consistency (D6-D7)

Decision: file ONE bug-003 with comprehensive scope, OR multiple narrower bugs? The investigation step 1's drift matrix shape informs this. If drift dimensions are tightly correlated (one root cause), one bug. If independent, multiple bugs.

**Recommend the bug filing strategy in the Recommendation section.**

### Step 6 — Document findings + recommendation (5 min)

Populate Findings (the drift matrix from step 1) + Recommendation (bug filing strategy from step 5). If hypothesis confirmed across all drift dimensions, recommend one comprehensive bug-003 + audit script. If some dimensions are NOT prose-enforcement issues, split.

## Findings

<!-- To be populated during execution. -->

## Recommendation

<!-- To be populated post-investigation. Likely strategy decisions to surface:

A. **One comprehensive bug** (if drift dimensions are correlated):
   - File bug-003 "screens cross-screen drift — kit-consumption rules are prose-only"
   - Ship a single `scripts/audit-cross-screen-consistency.mjs` covering D1-D9
   - One skill-body extension that tightens the shared-preamble + adds the verbatim-consumption table for patterns + bootstrap drift checks
   - Single feature_list row + phase-plan §F update

B. **Multiple narrow bugs** (if drift dimensions are independent):
   - bug-003 (D1): pattern consumption
   - bug-004 (D3): bootstrap drift
   - bug-005 (D2): data-kit-* density
   - bug-006 (D4): hex literal prohibition
   - bug-007 (D6-D7): copy + imagery consistency
   - Each ships its own audit + skill edit + feature_list row

C. **Hybrid** (one for systemic prose-enforcement, narrow ones for atomic regressions):
   - bug-003 covers the systemic drift class (D1 + D3 + D9 — all the "kit-content-bypass" dimensions)
   - bug-004 covers `data-kit-*` density (D2 — distinct from kit-content; it's about builder-translation contract)
   - bug-005 covers hex-literal prohibition (D4 — atomic, easy audit)
   - bug-006 covers copy-voice (D7 — atomic, easy audit)

The drift matrix from step 1 determines which strategy. Default: hybrid (option C) unless drift is overwhelmingly one root cause.

In all strategies, /screens needs to be re-run on test-app after the fixes land; the empirical validation is the audit script exiting 0 + a visual eyeball of the rerun preview confirming the brand marks are uniform.
-->

## Attempt Log

<!-- Populated by the executing agent. -->

## Operator notes

- Operator (David Morgan) previewed the screens mid-run and noticed logo issues across screens; confirmed empirically by spot-check showing 3 entirely different brand marks across the 12 screens.
- Same drift class as bug-002 (which was for /stylesheet's preview). Fixing one and not the other leaves the kit-consumption contract half-enforced.
- Parent investigation `investigate-001` documented the broader regression class; this is a specific follow-up for the kit-consumption surface that feat-001 was supposed to close.
