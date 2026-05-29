---
id: investigate-002-screens-cross-screen-drift
type: investigation
status: archived
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-29
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

### Step 1 — Drift matrix (`investigations/investigate-002-drift-survey.mjs` run 2026-05-28)

The full matrix is at `investigations/investigate-002-drift-survey-output.txt` (108 cells D1 + per-screen D2-D9). Summary by dimension:

#### D1. Named-pattern consumption — **SEVERE DRIFT confirmed** (86% drift rate)

```
                       wordmark   eyebrow  stat-tile trust-bar hero-badge  s-pillar  cs-card  testim   social
home                       ~         ~         ~        ✗         ~         ✗        ✗         ✗        ✗
services-index             ✓         ✓         ✗        ✗         ✗         ✓        ✗         ✗        ✗
services-detail-social     ✓         ✓         ~        ✗         ~         ✗        ✓         ✗        ✗
services-detail-visual     ✗         ✗         ✗        ✗         ~         ✗        ✗         ✗        ✗
services-detail-digital    ✗         ✗         ~        ✗         ~         ✗        ✗         ✗        ✗
work-index                 ~         ✓         ✗        ✗         ~         ✗        ✗         ✗        ✗
case-study-detail          ~         ✓         ✓        ✗         ✗         ✗        ✗         ✓        ✗
about                      ✓         ✓         ✗        ✓         ✗         ✗        ✗         ✗        ✗
contact                    ✗         ✗         ✗        ✗         ~         ✗        ✗         ✗        ✗
inquiry-confirmation       ✗         ✓         ✗        ✗         ✗         ✗        ✓         ✗        ✗
privacy                    ✗         ✗         ✗        ✗         ✗         ✗        ✗         ✗        ✗
not-found                  ✗         ✗         ✗        ✗         ✗         ✗        ✗         ✗        ✗
```

- **15/108 cells (14%) fully verbatim**
- 13/108 cells partial (some markers present — agents copied a class name or animation but not the full canonical composition)
- 80/108 cells (74%) with NONE of the kit's canonical markers
- **Drift rate: 86%**
- Worst patterns: `hero-badge` (0/12 verbatim), `social-proof-row` (0/12), `trust-bar` (1/12), `stat-tile` (1/12), `service-pillar-card` (1/12), `testimonial-block` (1/12)
- Best (still bad): `eyebrow` (6/12 verbatim — agents at least copy the canonical accent-bar shape sometimes)

#### D2. `data-kit-*` annotation density — **NO REAL DRIFT** (initial concern false-positive)

```
                              data-comp   data-kit-component   data-kit-variant   data-kit-layout   data-screen-id
home                              27              25                21                  1                1
services-detail-visual             1              60                14                  1                1
case-study-detail                  0              34                 8                  1                1
not-found                          0              33                 6                  1                1
```

Initial reading flagged "data-comp variance 27x" as drift. False positive: agents emit `data-kit-component="..."` (the canonical builder-translation attribute per screens/SKILL.md §5) instead of `data-comp="..."` (preview vocabulary used in design-system-preview.html). All 12 screens have ≥12 `data-kit-component` annotations with ≥1 `data-kit-variant` instances + `data-kit-layout` + `data-screen-id` ✓. The kit-attribute-contract for builder translation is intact.

#### D3. Preview-bootstrap config sections — **NO DRIFT** (12/12 ✓ across all 7 sub-sections)

```
                             cfg  accent  acc-ramp  fontDisp  fontSans  fontMono  radFull  highlight
all 12 screens                ✓     ✓        ✓        ✓         ✓         ✓        ✓        ✓
```

Initial concern that services-detail-visual lacked `display` mapping was a sampling artefact (truncated awk output). Actual full-config check passes 12/12. Refactor-007 silent-styling guard is solid.

#### D4. Hex literal leakage — **REAL DRIFT** (5/12 screens)

```
case-study-detail        2 unique hex · 0 inline-style · 5 svg-fill hex
contact                  1 unique hex · 0 inline-style · 2 svg-fill hex
inquiry-confirmation     2 unique hex · 0 inline-style · 4 svg-fill hex
privacy                  2 unique hex · 0 inline-style · 4 svg-fill hex
not-found                2 unique hex · 0 inline-style · 6 svg-fill hex
```

21 SVG `fill="#XXXXXX"` occurrences across 5 screens — agents inventing their own brand-mark SVG paths with literal hex fills (`#FF5C35`, `#FFE14D`) instead of using `currentColor` + the kit's parent-color cascade. **Tightly correlated with D1 pattern-drift on `wordmark`.** Inline-style hex held (0/12 screens leak there — agents respect the no-inline-style rule).

#### D5. Font wiring — **NO DRIFT**

- 0/12 screens have inline `font-family:` overrides
- 1/12 (home) has a duplicate Google Fonts `<link>` (waste, not breakage — kit's globals.css already imports the fonts)
- font-display class density 9–35 per screen (proportional to content density)
- font-mono density 13–53 per screen
- The kit's font system is correctly consumed via Tailwind utility classes

#### D6. Imagery + avatar consistency — **REAL DRIFT** (6/12 screens use non-canonical avatars)

```
                            canonical-avatars   custom-avatars   canonical-cs-seeds
home                               2                  6                  3
services-detail-social             0                  4                  0
services-detail-visual             3                  5                  2
services-detail-digital            0                  4                  0
work-index                         0                  0                  3
case-study-detail                  1                  7                  3
about                              2                  4                  0
contact                            0                  0                  0
```

The preamble named 4 canonical avatar URLs (Anika P., Marco L., Priya R., Sam K.) and 3 canonical case-study seeds (bloom, northstar, meridian) to reuse across screens for cross-screen continuity. Agents substituted their own Unsplash photo IDs in 6/12 screens. `about` is partial-OK (2 canonical + 4 custom — but TeamGrid likely needs 4 unique people, so custom additions are expected; canonical 4 should be the foundation).

#### D7. Copy voice — **NO DRIFT** (clean)

- 0/12 screens contain cliché bigrams (Elevate / Seamless / Unleash / Next-Gen / Empower / Transform your)
- 0/12 screens have lorem ipsum / TODO / REPLACE_ME leakage
- 12/12 use canonical `hello@hatch.studio` (no `info@…` / `contact@…` substitutions)
- Agents respected the voice rules from the preamble

#### D8. Layout shell — **REAL DRIFT** (nav position + footer columns)

- **Nav position**: `fixed` × 4 + `sticky` × 8. Preamble specified `fixed`. 8/12 agents used `sticky` instead — likely because the screens-skill body's Nav-default-shape in `.components-shapes.json` says `"position": "fixed"` but agents interpreted "sticky" as semantically equivalent.
- **Footer 4-col**: 8/12 ✓, 4/12 missing the 4-column grid (home, services-index, services-detail-social used a different footer composition)
- **max-w-[1280px]**: 12/12 ✓
- **Section gaps** (py-16/py-20/py-24): highly variable per screen — visual_density=4 should drive a consistent default but agents pick whichever feels right

#### D9. Inline `<style>` block content — **REAL DRIFT** (34 custom classes + 7 non-canonical keyframes)

- 34 custom CSS class definitions across screens (kit-bypass — agents inventing utility classes outside the kit's vocabulary)
- **7 non-canonical `@keyframes` definitions**: `play-pulse`, `spark-rotate`, `hatch-pulse`, `spark-pulse`, `hatched-drift`, `spark-wobble`, `glyph-drift`
- All 7 are "spark"-themed animations that agents invented to animate their custom brand-mark SVGs (D9 directly correlates with D1+D4 — agents inventing brand marks need invented keyframes to animate them)
- Canonical keyframes (`marquee-scroll`, `stat-tile-bob`, `trust-bar-scroll`, `hero-badge-pulse`) appeared 0–3 times per screen — used correctly when the agent did consume the kit pattern.

### Step 2 — Prompt audit (my dispatch transcripts vs screens/SKILL.md)

My 12 dispatch prompts (in this session's transcript 2026-05-28T22:00Z) said variants of:

> "Read these files FIRST … 4. `packages/ui-kit/src/patterns/_extracted/*.html` — the named patterns to USE VERBATIM (wordmark, eyebrow, …)"

The phrase "USE VERBATIM" appeared, but each per-pattern row in the table also said things like "Use in nav + footer", "Use above EVERY section heading", "Use 2 per hero when relevant" — operative verb is "use", not "inline byte-for-byte". Ambiguity: does "use" mean "the inline content is verbatim" or "compose using this as reference"?

The screens/SKILL.md Inputs §4b (the consumer-side rule shipped with feat-001) says:

> "Consult kit patterns BEFORE inventing. When a section needs a logo composition, reach for `_extracted/wordmark.html` instead of inventing one."

Operative verbs: **"consult"** and **"reach for"** — clearly invitations to consume the pattern, NOT contracts requiring byte-verbatim. An agent that reads `wordmark.html`, internalises the design intent, then writes their own version is technically compliant with "consult before inventing" — they consulted; they're not strictly inventing from scratch.

Both my prompts AND the skill body left the door open to "I consulted it, now I'll write my own based on the spirit." **The skill-body language is the upstream cause; my dispatch prompts inherited the ambiguity.**

### Step 3 — Verbatim-inline test (skipped per time budget)

Time-budget call: skipped the empirical dispatch. Reasoning: with 9/12 ui-designer dispatches reinventing patterns despite reading both the preamble's "USE VERBATIM" and the skill body's "consult before inventing", prose-only enforcement clearly fails ≥75% of the time. Tighter prose ("INLINE byte-for-byte; do not adapt") may improve compliance but won't reliably close it without mechanical enforcement. Confidence: medium-high based on the n=12 evidence.

**Decision:** prescribe mechanical audit as the load-bearing fix — same shape as bug-002. Tighter skill-body prose is supporting, not load-bearing.

### Step 4 — Audit script design

`scripts/audit-screen-pattern-consumption.mjs` (project-agnostic, mirroring `audit-preview-coverage.mjs`):

1. **Pattern marker signatures** — parse each `packages/ui-kit/src/patterns/_extracted/*.html` to extract:
   - All `class="logo-spark"` / `class="pulse-dot"` / `class="stat-tile-bob"` / `class="trust-marquee"` / etc. — anchor classes
   - All canonical SVG `<path d="…">` byte sequences from the pattern's inline SVG
   - The `data-pattern="<slug>"` attribute
   - All `@keyframes <name>` names defined in the pattern's inline `<style>` block

2. **Per-screen audit** — for each `docs/screens/{platform}/*.html`:
   - For each kit pattern, check whether the screen references it (via `data-pattern` attribute OR by usage-class) AND whether the canonical anchor classes + SVG path bytes appear unmodified
   - Flag drift cells: pattern referenced but markers absent

3. **Hex-literal-in-SVG check** — count `fill="#[0-9A-Fa-f]{6}"` occurrences in each screen that don't match canonical bytes from `_extracted/*.html`. Flag as drift (correlates with pattern-consumption miss).

4. **Non-canonical keyframe check** — parse inline `<style>` blocks for `@keyframes <name>` definitions. Cross-reference against the canonical keyframe names extracted from `_extracted/*.html`. Flag any keyframe name not in the canonical set as drift.

5. **Cross-screen imagery consistency check** — parse all screen HTMLs, identify recurring image URL patterns (avatars + case-study seeds), assert they match across screens that share the same domain (e.g. all references to "Bloom Co." should use the same picsum seed; all 4 canonical avatar URLs should appear consistently).

6. **Exit 0 on full consumption, 1 on drift.** Flags: `--json`, `--strict` (icons-equivalent), `--dimension D1|D4|D6|D9|all`.

### Step 5 — Fix scope

The drift cluster analysis:

- **D1 (patterns) + D4 (hex leakage) + D9 (custom keyframes)** are **tightly correlated** — agents inventing brand-mark SVGs need invented hex fills + invented keyframes to animate them. All three are "kit-content-bypass" — one prose-enforcement root cause. **Fold into ONE bug.**
- **D6 (imagery consistency)** is a **distinct cross-screen pinning problem** — agents pick fresh URLs in isolation, not realizing they should reuse canonical seeds. Same kind of fix (audit script + skill-body extension naming canonical URLs), but the audit logic is different (cross-screen comparison vs per-screen pattern check). **Fold into the SAME bug** since the prose-enforcement root cause is identical and one audit script can cover both.
- **D8 (layout shell)** — nav position 8/12 drifted from `fixed` to `sticky`; footer-4-col 4/12 missing. Same prose-enforcement root cause — preamble said `fixed`, agents reinterpreted. Could fold OR be its own narrow bug. Given the cluster correlation, **fold into bug-003**.

**Recommendation: ONE comprehensive bug** covering D1 + D4 + D6 + D8 + D9. The single audit script covers all dimensions; the single skill-body extension tightens the verbatim-consumption rule + names canonical assets. Empirical validation = re-running `/screens` on test-app and getting a passing audit.

## Recommendation

### File ONE comprehensive bug — `bug-003-screens-kit-content-bypass`

Cover D1 + D4 + D6 + D8 + D9 in one bug. The drift dimensions cluster around a single root cause (prose-only enforcement of kit-content consumption rules) and the fix shape is identical for all of them (skill-body extension + mechanical audit script + feature_list row + phase-plan §F update).

**bug-003 deliverables (mirroring bug-002 shape):**

1. **`scripts/audit-screen-pattern-consumption.mjs`** (project-agnostic, ~250 lines per the step-4 design above). Reads each project's own `_extracted/*.html` + `screens/*.html`, computes per-pattern canonical markers, flags drift across 5 dimensions (D1 + D4 + D6 + D8 + D9). Exits 0/1, supports `--json` + `--strict` + `--dimension`.

2. **`.claude/skills/screens/SKILL.md` extension** — Inputs §4b language change from "Consult kit patterns BEFORE inventing" → "**INLINE the canonical pattern HTML verbatim**". New §4b.1 per-pattern marker table (logo-spark / pulse-dot / stat-tile-bob / etc.) the screens MUST contain. New §4h "Cross-screen consistency contract" naming canonical avatars + case-study seeds + nav position + footer composition. New step 8a "Mechanical audit" wiring `scripts/audit-screen-pattern-consumption.mjs` as post-batch verifier with hard-abort semantics. Updated acceptance criteria.

3. **`docs/screens/.shared-preamble.md` generator change** — when /screens emits the preamble at step 3.5, it MUST include the literal `_extracted/*.html` content of each pattern verbatim in the preamble itself (not just a path reference). Agents see the bytes; agents inline the bytes.

4. **`feature_list.json` row `phase1-step-035`** — passes:false pending audit script exiting 0 on a re-run of /screens on test-app.

5. **`phase-plan.md` §F new paragraph** documenting the kit-content-bypass class + the verbatim-inline contract + the audit script.

6. **`bug-003` plan** filed at `plans/active/bug-003-screens-kit-content-bypass.md` with the canonical bug-plan shape (problem statement / reproduction / root cause / fix approach / rejected alternatives / validation criteria) — see bug-002 as the template.

### Empirical validation (after bug-003 ships)

Re-run `/screens` on `projects/test-app/` after the fixes land. The audit script should exit 0 with:

- D1: 9/9 patterns × 12/12 screens verbatim (108/108 cells ✓)
- D4: 0 SVG fill hex literals outside canonical kit bytes
- D6: 4/4 canonical avatars present on every screen that needs avatars; 12/12 screens use canonical case-study seeds where they reference the same client
- D8: 12/12 screens use `fixed` nav + 4-col footer
- D9: 0 non-canonical `@keyframes` definitions; ≤4 custom CSS class definitions per screen (only allowed for screen-specific keyframes that ALREADY exist in the kit's canonical set)

Visual eyeball: open all 12 screens in a browser. All brand marks should be visually identical (same orange square + lightning bolt). No 8-pointed star surprises.

### Meta-lesson to capture (LESSONS.md after bug-003 closes)

Title: _"Consumer-side rules in skill bodies need mechanical audits when shipped, not retroactively."_

Pattern observed across three drift surfaces in one investigation:

- bug-002 (`/stylesheet` preview-coverage) — prose rule "every component must be rendered", agents skipped — bug-002 added audit
- bug-003 (`/screens` kit-content-bypass) — prose rule "consult patterns before inventing", agents reinvented — bug-003 adds audit
- (potentially) future bugs as more consumer-side rules ship

When a SKILL.md is extended with a consumer-side rule that depends on agent compliance (vs being a deterministic mechanical instruction), the rule MUST ship with a paired mechanical audit script. Prose-only consumer-side rules have a measured ≥75% drift rate in n=12 dispatches on this project.

Cross-references: investigate-001 (parent regression), bug-002 (sibling drift class), feat-001 (the consumer-side rule that bug-003 tightens).

### Strategy decision: one bug vs multiple

Rejected: 5 separate narrow bugs (one per drift dimension). Reasoning:

- Same root cause (prose enforcement)
- Same fix shape (audit script + skill edit + feature_list row + §F update)
- Same empirical validation surface (one /screens rerun)
- Filing 5 bugs would 5× the plan-archiving overhead for no incremental value

Chosen: one comprehensive `bug-003-screens-kit-content-bypass`.

A. **One comprehensive bug** (if drift dimensions are correlated):

- File bug-003 "screens cross-screen drift — kit-consumption rules are prose-only"
- Ship a single `scripts/audit-cross-screen-consistency.mjs` covering D1-D9
- One skill-body extension that tightens the shared-preamble + adds the verbatim-consumption table for patterns + bootstrap drift checks
- Single feature_list row + phase-plan §F update

B. **Multiple narrow bugs** (if drift dimensions are independent):

- bug-003 (D1): pattern consumption
- bug-004 (D3): bootstrap drift
- bug-005 (D2): data-kit-\* density
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

---

# COMPLETION RECORD (appended to archived plan)

completed: 2026-05-29
outcome: success
actual-files-changed: []
commits: []
attempts: 1
lessons:

- "Surfaced 3 brand-mark variants + 4 chrome dimensions of cross-screen drift on n=12 ui-designer dispatches — empirical motivation for bug-003 (kit-content-bypass) + bug-004 (chrome-consistency)."
- "Cross-screen consistency is a separate contract from per-screen pattern consumption — agents can correctly inline a wordmark per-screen but use different wordmarks across screens. Requires explicit cross-screen contract in the shared preamble."
- "Closed by bug-003 + bug-004."
  test-results:
  unit: n/a (research only)
  integration: n/a (research only)
  duration-minutes: 60

---
