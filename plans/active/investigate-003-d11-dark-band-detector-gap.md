---
id: investigate-003-d11-dark-band-detector-gap
type: investigation
status: completed
author-agent: Claude (Phase 3 build)
created: 2026-05-29
updated: 2026-05-29
parent-plan: bug-004-screens-chrome-consistency
supersedes: null
superseded-by: null
branch: null
affected-files:
  - scripts/audit-screen-pattern-consumption.mjs
  - .claude/skills/screens/SKILL.md
  - projects/test-app/docs/screens/.shared-preamble.md
  - projects/test-app/docs/screens/webapp/*.html
  - projects/test-app/docs/design-system-preview.html
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
time-box-minutes: 60
hypothesis: D11's class-based regex misses dark-on-dark text instances because it under-counts what qualifies as a "dark-bg block" — either the preview's vocab is sparse so the detector's "approved set" is too narrow / too wide, OR agents put dark text inside containers whose bg class doesn't match the DARK_BG_PATTERNS list (likely candidates — accent / primary / secondary tokens that visually resolve dark but use color-family naming not covered by the regex), OR inheritance — text color set on an ANCESTOR of the dark-bg block applies inside it.
---

# investigate-003-d11-dark-band-detector-gap: Why does D11 report PASS while operator sees dark-on-dark text remaining?

## Question

What's the gap between D11's mechanical detection ("for each dark-bg block, assert descendant `text-*` classes are in preview's dark-band vocab") and the operator's visual experience that dark-on-dark text persists across screens post-bug-004?

## Hypothesis

Strongest prior — combination of two:

1. **DARK_BG_PATTERNS coverage gap.** The list (`bg-surface-inverted`, `bg-neutral-{800,900,950}`, `bg-secondary-{500,600}`, `bg-primary-{800,900}`, `bg-accent-{800,900}`, `bg-black`) misses dark-resolving tokens — most likely `bg-primary` family with no shade (defaults to base which may be dark-mode dark), arbitrary-value bg (`bg-[#1a1a1a]`), CSS-variable bg (`bg-[var(--color-surface-inverted)]`), kit-pattern bg (preview shipped `bg-near-black` or similar), or even `bg-secondary-700` which is excluded from the secondary-darks range.

2. **Vocab-set leak.** When the preview parser walked dark blocks, the only classes it surfaced were `text-white`, `text-white/85`, `text-text-primary`. `text-text-primary` shouldn't be in the dark-band vocab — it resolves to a DARK color (`#111` typical). If a screen agent saw `text-text-primary` in the canonical vocab and faithfully reused it inside a dark band, the audit passes but the text IS dark-on-dark. This is a vocab-pollution failure of the preview parser.

Secondary candidates worth checking but lower-prior:

- **Inheritance**: descendant text without an explicit `text-*` class inheriting a dark color from its parent.
- **Inline `style="color: #..."`**: bypasses the class detection entirely.
- **Class resolution**: `text-text-secondary` resolves through tokens.css — its actual hex may differ between light/dark modes and the detector only sees the class name.

## Investigation Steps

Time-box 60 minutes.

1. **Run D11 with `--dimension D11` + `--json`** on test-app post-fix to confirm what the audit currently sees. Confirms baseline = 0 findings.

2. **Inspect the canonical dark-band vocab the parser extracted.** Add a temporary `--debug-vocab` flag run or instrument the parser to print: (a) the set of dark-bg block opening tags found in `design-system-preview.html`; (b) the union of `text-*` classes inside those blocks; (c) the resolved CSS color value of `text-text-primary` per tokens.css. If `text-text-primary` is in the vocab AND it resolves to a near-black color, this confirms vocab-pollution hypothesis.

3. **Visually + mechanically inspect 3-4 screens** for dark-on-dark instances the operator likely saw:
   - `home.html` — has at least one CTA band + footer
   - `services-detail-visual.html` — frequent dark imagery sections
   - `case-study-detail.html` — the just-regenerated screen
   - `about.html` — bio + team + testimonial section

   For each screen: grep for every `bg-` class; flag any that's "dark-resolving" (per kit's tokens.json's dark token list); within each dark-resolving block, list all descendant `text-*` classes; check which of those resolve to dark colors per tokens.css. This catches what D11 missed.

4. **Render a screen in browser and sample with a color picker** (or use Chrome DevTools MCP if available) — verify whether what looks dark-on-dark to the operator IS in fact dark-on-dark in computed-style terms, OR whether it's a perception issue (e.g. orange/accent CTA mistaken for dark, low-contrast-but-not-dark grey).

5. **Cross-reference Tailwind config tokens** in `packages/ui-kit/src/styles/tailwind.config.ts` + `tokens.css` to identify EVERY token that resolves to a near-black (≤ #333) color value. Build the authoritative "dark-resolving bg classes" + "dark-resolving text classes" lists. These are the real D11 inputs, not the static regex list.

6. **Identify whether the preview itself has dark-on-dark text.** If `design-system-preview.html` ships dark-text-on-dark-bg (because it's the preview-bootstrap fragment is showcasing dark CTA bands with `text-text-primary` somewhere), then bug-004's "consistency-with-preview" contract is literally enforcing the bug. In that case the fix is upstream — `/stylesheet` step 7 needs the same audit applied to its own output.

## Findings

**Status:** complete. Time-box: ~25 minutes of the allotted 60.

D11 is a **silent vacuous PASS** on test-app due to a triple-compounding bug in `scripts/audit-screen-pattern-consumption.mjs`. Concrete evidence:

### F1 — Preview's dark-band vocab is silently empty (`previewDarkBandTextVocab.size === 0`)

The audit's preview parser at lines 250-290 finds the dark-bg blocks in `docs/design-system-preview.html` via a regex limited to `<(section|div|aside|footer|header|main|article)>` opens (line 253). The test-app preview's only dark-bg-carrying elements are:

- 2 × `<a class="bg-neutral-900">` (case-study card pattern at preview lines 840 + 885)
- 1 × `<div class="bg-black/40">` (modal scrim at preview line 1715, content-empty)

The `<a>` tags are NOT in the audit's tag list → the dark case-study-card blocks are never opened by the walker. The scrim `<div>` IS opened, but its content is just an `aria-hidden` overlay with no descendant `text-*` classes. Net result: `previewDarkBandTextVocab` is the empty set.

Verified by direct instrumentation:

```
Vocab (full, audit-equivalent): []
Contains text-text-secondary? false
```

### F2 — Empty vocab silently DISABLES D11 (fail-open semantics)

`scripts/audit-screen-pattern-consumption.mjs:479` guard:

```js
if ((DIM === "all" || DIM === "D11") && previewDarkBandTextVocab.size > 0) {
```

When vocab is empty, the entire D11 block is skipped — no findings, no warning, just `D11: 0 findings`. The audit reports PASS while it has done literally zero work. This is the load-bearing bug: any project whose preview doesn't render a fully-styled dark-bg block (with descendant text) silently disables D11.

### F3 — No bg-context tracking inside dark blocks (over-counting on the screen side, when D11 IS active)

When D11 IS active (vocab non-empty), the screen-side scanner (lines 482-535) walks each dark-bg block and collects EVERY `text-*` class found inside its content range — including classes on descendants that RESET the bg context via a nested `bg-surface-raised` / `bg-white` / etc. Example: a case-study card with `bg-neutral-900` containing a `<span class="bg-surface-raised/95 text-text-primary">` pill: the pill's `text-text-primary` is correctly rendered on the pill's own light background, but the audit sees it as a dark-band descendant. Either fires a false-positive D11 finding OR (when the vocab includes it via the same overcount on the preview side) creates vocab pollution that masks REAL dark-on-dark cases elsewhere.

### Observed empirical impact

Bg-context-aware re-detection against the 12 test-app screens surfaces **2 real dark-on-dark text instances** that D11 PASSED:

| Screen                        | Line  | Issue                                                                                                                                                                                                                                                             |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services-detail-visual.html` | ~1191 | Eyebrow pattern inlined verbatim from `_extracted/eyebrow.html` (with its baked-in `text-text-secondary` for light-bg use) into the screen's `<section class="bg-surface-inverted text-text-inverted">` CTA band → mid-grey "Let's talk" eyebrow on near-black bg |
| `services-index.html`         | ~738  | Identical pattern: same eyebrow shape (`text-text-secondary`) inside same shape of `bg-surface-inverted` CTA band                                                                                                                                                 |

Other 10 screens correctly handle dark-band eyebrows (using `text-white/70` / `text-text-inverted` / explicit "inverted variant" comment markers). So the visual issue the operator sees is real, narrow, and concentrated on the eyebrow-pattern-in-dark-CTA collision.

### Root pattern (semantic / design-system level)

The `_extracted/eyebrow.html` pattern was extracted from a light-bg section of the mockup and carries `text-text-secondary` baked in. There is no separate `eyebrow-inverted.html` pattern. When agents need an eyebrow inside a dark CTA band, they MUST swap `text-text-secondary` → `text-white/70` (or `text-text-inverted/70`) when inlining. Most agents DID — but 2 of 12 inlined the pattern verbatim without swapping. The shared preamble names canonical patterns and canonical dark-band text vocabulary as separate contracts; the connection between them (when inlining a pattern into a dark context, swap text-secondary tokens) is implicit.

### Cross-class consistency: same shape as bug-002 / bug-003 / bug-004

This is now a FIFTH manifestation of the prose-only-consumer-rule drift class within Phase 1, but with a NEW shape: even the mechanical audit can silently no-op when its derived contract is empty. The class extends from "consumer-side rules without audits drift" → to "mechanical audits whose contracts are derived from upstream artifacts can be silently empty when the upstream artifact doesn't model the contract surface."

## Recommendation

**File `bug-005-d11-dark-on-dark-detector-strengthening` with three coordinated fixes** — same fix shape as bug-002 / bug-003 / bug-004 (audit + skill body + phase-plan §F + feature_list row + empirical validation re-dispatch).

### Part A — `scripts/audit-screen-pattern-consumption.mjs` D11 strengthening

1. **Extend block-tag list**: walk dark-bg classes on `<a>` and `<button>` and `<span>` (in addition to current `<section/div/aside/footer/header/main/article>`). Most kit-pattern roots that carry dark bg are `<a>` (case-study cards). Validated by F1.

2. **Fail-closed on empty vocab**: when `previewDarkBandTextVocab.size === 0`, emit a structured warning + ABORT the audit with exit 1: `"D11 vocab is empty — design-system-preview.html doesn't model a dark-bg block with descendant text. Either extend the preview to include a dark CTA band sample (recommended) OR explicitly opt out via --skip-D11"`. Never silently PASS.

3. **Bg-context tracking on the screen-side scanner**: when walking inside a dark-bg block, RESET the dark context for any descendant element whose own class list contains a light-bg class (`bg-white`, `bg-surface-base`, `bg-surface-raised`, `bg-neutral-{50,100,200,300}`, `bg-accent-{50,100,200,300}`, `bg-highlight-`, etc.). Text classes inside the reset region are not considered dark-band descendants. Same logic applied to the preview-side parser when building vocab.

4. **Hardcoded dark-text-class blocklist as secondary check**: independently of vocab membership, ANY occurrence of `text-text-primary` / `text-text-secondary` / `text-text-tertiary` / `text-neutral-{700,800,900,950}` / `text-black` inside a dark-bg block (bg-context-aware) is ALWAYS a D11 finding. These classes are GLOBALLY known to resolve to dark colors via `tokens.css`; their use inside dark bg is unambiguously broken regardless of preview vocab.

### Part B — `/stylesheet` preview-coverage extension (UPSTREAM the same defect)

Per the bug-002 pattern: `/stylesheet` step 8.4 (preview-coverage audit) should require `design-system-preview.html` to render AT LEAST ONE dark-bg block with descendant text (e.g. a "Contact CTA band" example or a "footer-inverted" example). Without it, downstream D11 vocab derivation cannot work. This is the structural fix: make the upstream artifact model the contract surface.

Add to `scripts/audit-preview-coverage.mjs`: assertion that preview contains ≥1 `<section>` / `<a>` / `<div>` with `bg-surface-inverted` or `bg-neutral-{800,900,950}` class AND ≥1 descendant `<p>` / `<h*>` / `<span>` carrying a `text-*` class (i.e. the preview must demonstrate dark-band typography).

### Part C — `.claude/skills/screens/SKILL.md` §3.5.2 chrome-contract clarification

Add an explicit clause: "When inlining `_extracted/eyebrow.html` (or any other pattern with light-mode `text-text-{primary,secondary,tertiary}` baked in) into a dark-bg section, you MUST swap those tokens to their dark-band equivalents from the canonical dark-band text vocabulary (`text-white/70` for `text-text-secondary`, `text-white/50` for `text-text-tertiary`, etc.). Inlining verbatim is the default for light-bg sections only."

The audit (Part A.4 hardcoded blocklist) enforces this mechanically; the SKILL.md clause makes the contract explicit to the agent.

### Part D — `feature_list.json` row `phase1-step-037` + `phase-plan.md` §F Row 037 paragraph

Track the work + capture the meta-lesson: "Even mechanical audits can silently no-op when their contract is DERIVED from an upstream artifact that doesn't model the contract surface. Fail-closed semantics + a hardcoded fallback assertion are both required."

### Recovery validation pass (post-Part A + B + C)

Re-run `/screens` in single-screen mode on the 2 affected screens (`services-detail-visual`, `services-index`) only. Confirm:

- The strengthened audit fires D11 with specific findings
- Post-fix, audit exits 0
- Visual eyeball: dark CTA bands have readable high-contrast text on those 2 screens
- Negative-regression: the 10 currently-correct screens stay correct (no false-positive findings from the bg-context-aware logic)

## Attempt Log

### Attempt 1 — 2026-05-29

Investigation completed in ~25 minutes (well within 60-min time-box). All 5 investigation steps executed; root cause confirmed via direct instrumentation; recommendation written. No further investigation needed; proceed to bug-005 fix shipment per Recommendation.
