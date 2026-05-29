---
id: bug-005-d11-dark-on-dark-detector-strengthening
type: bug
status: archived
author-agent: Claude (Phase 3 build)
created: 2026-05-29
updated: 2026-05-29
parent-plan: investigate-003-d11-dark-band-detector-gap
supersedes: null
superseded-by: null
branch: fix/d11-dark-on-dark-strengthening
affected-files:
  - scripts/audit-screen-pattern-consumption.mjs
  - scripts/audit-preview-coverage.mjs
  - .claude/skills/screens/SKILL.md
  - phase-plan.md
  - feature_list.json
  - projects/test-app/docs/design-system-preview.html (test fixture)
  - projects/test-app/docs/screens/webapp/services-detail-visual.html
  - projects/test-app/docs/screens/webapp/services-index.html
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: "Run /screens on any project; observe D11 reports PASS while screens contain text-text-secondary inside bg-surface-inverted CTA bands"
stack-trace: null
---

# bug-005-d11-dark-on-dark-detector-strengthening: D11 silently no-ops when preview's dark-band vocab is empty; eyebrow-in-dark-CTA bug class slipped through

## Bug Description

After bug-004 shipped, operator reported dark-on-dark text persisting on screens despite D11 audit reporting PASS. investigate-003 found the root cause: a **triple-compounding bug** in D11's detector + a coordinated upstream gap.

Concrete instances (test-app, 2026-05-29 post-bug-004):

- `services-detail-visual.html:1191` — `_extracted/eyebrow.html` inlined verbatim (with baked-in `text-text-secondary` for light-bg use) into a `<section class="bg-surface-inverted">` CTA band → mid-grey "Let's talk" eyebrow on near-black bg, fails WCAG AA contrast
- `services-index.html:738` — identical shape

D11 reported these screens as PASS because:

1. **F1 — Empty vocab.** test-app's `design-system-preview.html` carries dark bg ONLY on 2 case-study `<a>` tags + 1 modal scrim `<div>`. The audit's preview parser walks only `<section|div|aside|footer|header|main|article>` — `<a>` is not in the list. Scrim div has no descendant text. Result: `previewDarkBandTextVocab = {}` (empty set).

2. **F2 — Empty vocab silently DISABLES D11.** The guard `if (DIM === "all" || DIM === "D11") && previewDarkBandTextVocab.size > 0` at line 479 makes D11 fail-OPEN: empty vocab → entire block skipped → reports 0 findings vacuously. The audit says PASS while doing literally zero work.

3. **F3 — No bg-context tracking inside dark blocks.** Even when D11 IS active (vocab non-empty), descendant pills / cards that reset bg via a nested `bg-surface-raised` / `bg-white` / etc. still count their descendant text-\* classes as dark-band descendants. Causes both vocab pollution AND false-positive screen-side findings.

Class membership: this is the **fifth manifestation of the prose-only-consumer-rule drift class** within Phase 1, but with a NEW shape — even the mechanical audit can silently no-op when its contract is derived from an upstream artifact that doesn't model the contract surface.

## Reproduction Steps

1. Run `/screens` on any project where the design-system-preview's only dark-bg elements are on `<a>` tags (a very common pattern — case-study cards, link cards, hover-overlay cards).
2. Confirm `node ../../scripts/audit-screen-pattern-consumption.mjs --dimension D11 --json` reports `D11: 0 findings`.
3. Confirm via manual eyeballing (or the bg-context-aware replication scan in investigate-003) that screens have `text-text-secondary` / `text-text-tertiary` / `text-text-primary` / `text-neutral-{700-950}` / `text-black` descendants inside `bg-surface-inverted` / `bg-neutral-{800-950}` blocks — i.e. real dark-on-dark text.

Specific test-app reproduction (2026-05-29):

```
$ node ../../scripts/audit-screen-pattern-consumption.mjs --dimension D11
audit-screen-pattern-consumption — ✓ PASS
  screens audited: 12
  patterns loaded: 9
  canonical avatars: 4
  canonical case-study seeds: 6
  canonical keyframes: 4
  dimension scope: D11
  ✓ All scoped dimensions pass.
```

…yet `services-detail-visual.html:1191` + `services-index.html:738` both have dark-on-dark eyebrow text in the bg-surface-inverted CTA band.

## Error Output

```
N/A — the bug is a silent fail-open, not a thrown error. The detection
class is the audit's own silence. Verified via investigate-003's direct
instrumentation:

  Vocab (full, audit-equivalent): []
  Contains text-text-secondary? false
  D11 guard: vocab.size > 0 → false → entire D11 block SKIPPED
```

## Root Cause Analysis

Three orthogonal defects in `scripts/audit-screen-pattern-consumption.mjs`:

1. **Lines 250-290 (preview parser block walker)** — `<a>` and `<button>` and `<span>` are not in the tag list. The kit's most common dark-bg patterns (case-study-card, hover-overlay-card, dark-themed CTAs) use `<a>` as root → silently invisible to the walker.

2. **Line 479 (D11 guard)** — `previewDarkBandTextVocab.size > 0` is the WRONG condition. An empty vocab means the preview FAILED to model the contract surface; the correct response is **abort + warn**, not silent-skip. Fail-open semantics on a load-bearing check is itself the bug.

3. **Lines 482-535 (screen-side block walker)** — no bg-context tracking. Walks all descendants of a dark-bg block flat, harvesting every `text-*` class found via regex match — including classes on descendants that re-set the bg context. Bug-context-aware tracking is required to (a) reduce false positives, (b) prevent vocab pollution when the same walker builds the preview-side vocab.

Additionally — **upstream contract gap**: `/stylesheet` step 8.4 (preview-coverage audit shipped by bug-002) does not assert that the preview models a dark-bg block with descendant typography. Without that assertion, the preview is free to ship without modeling the dark-band contract surface — and D11 has nothing to derive its vocab from.

## Fix Approach

Four-part fix (mirrors bug-002 + bug-003 + bug-004 shape):

### Part A — `scripts/audit-screen-pattern-consumption.mjs` D11 strengthening

1. Extend the dark-block walker's tag list from `(section|div|aside|footer|header|main|article)` to `(section|div|aside|footer|header|main|article|a|button|span)`. Applies to BOTH the preview-side parser AND the screen-side scanner.

2. Change the D11 guard semantics: when `previewDarkBandTextVocab.size === 0`, EMIT a structured warning to stderr (`[audit] D11 vocab is empty — design-system-preview.html doesn't model a dark-bg block with descendant text. Either extend preview to include a dark CTA band OR pass --skip-D11.`) AND EXIT 1. Never silently PASS. Provide `--skip-D11` opt-out flag for projects that have no dark-band surface intentionally (rare; documented).

3. Add bg-context tracking to BOTH the preview-side parser AND the screen-side scanner. Maintain a stack as the tokenizer walks tags; each tag's bg context = (a) explicit dark-bg class on self → dark, (b) explicit light-bg class on self → light, (c) inherit from parent. Light-bg classes recognized: `bg-white`, `bg-surface-base`, `bg-surface-raised`, `bg-surface-overlay`, `bg-neutral-{50,100,200,300}`, `bg-accent-{50,100,200,300}`, `bg-highlight-`, `bg-yellow-`. Text-\* classes are collected ONLY when the current bg context is `dark`.

4. Add a hardcoded dark-text-class blocklist as INDEPENDENT secondary check. Regardless of vocab membership, ANY occurrence of `text-text-primary` / `text-text-secondary` / `text-text-tertiary` / `text-neutral-{700,800,900,950}` / `text-black` inside a dark-bg block (bg-context-aware) is ALWAYS a D11 finding. These tokens are GLOBALLY known dark-resolving via tokens.css; their use inside dark bg is unambiguously broken regardless of any project's preview vocab.

### Part B — `scripts/audit-preview-coverage.mjs` preview-dark-band coverage assertion

Add a new dimension to the preview-coverage audit: assert that `docs/design-system-preview.html` contains AT LEAST ONE element with a dark-bg class (per the DARK_BG_PATTERNS list) AND ≥1 descendant carrying a `text-*` color class. This is the "structural fix" that upstream's the D11-vocab-derivation gap.

On miss: exit 1 with `Preview missing dark-band coverage: extend design-system-preview.html to include a 'Contact CTA' or 'Inverted footer' or 'Dark hero' example demonstrating how the kit's typography looks on dark surfaces. Required because /screens audit D11 derives its dark-band text vocabulary from this section.`

This is enforced even when the project's stylesheet step shipped without an explicit dark-band element — the audit forces the gap to be closed at the source.

### Part C — `.claude/skills/screens/SKILL.md` §3.5.2 chrome-contract clarification

Add a new explicit clause under "Canonical chrome reference — `docs/design-system-preview.html`":

```
### Pattern inlining inside dark contexts (bug-005)

`_extracted/*.html` patterns (eyebrow.html, etc.) carry baked-in text-color
classes derived from their light-bg source mockup. When inlining such a
pattern into a DARK section (any block with `bg-surface-inverted` /
`bg-neutral-{800,900,950}` / `bg-secondary-{500,600}` / `bg-primary-{800,900}`
/ `bg-accent-{800,900}` / `bg-black` / etc.):

- Swap `text-text-secondary` → `text-white/70` (or `text-text-inverted/70`)
- Swap `text-text-tertiary` → `text-white/50` (or `text-text-inverted/50`)
- Swap `text-text-primary` → `text-white` (or `text-text-inverted`)
- Swap `text-neutral-{600,700,800,900}` → `text-white/70`
- Swap `text-black` → `text-white`

Inlining a pattern VERBATIM is the default for LIGHT-bg sections only.
Verbatim-inline + dark-bg context = unreadable dark-on-dark text.

Audit dimension D11 (mechanically enforced) catches both the vocab-derived
case AND a hardcoded blocklist of the dark-resolving tokens above. Either
manifest aborts the batch and triggers a per-screen retry.
```

### Part D — `feature_list.json` row `phase1-step-037` + `phase-plan.md` §F Row 037 + bug-005 plan

Track the work + capture the meta-lesson:

> _"Mechanical audits whose contracts are DERIVED from upstream artifacts can silently no-op when the upstream artifact doesn't model the contract surface. Fail-closed semantics + a hardcoded independent fallback assertion are both required. The upstream preview-coverage audit should force the contract surface to be modeled."_

## Rejected Fixes

- **Fix X — Add `text-text-secondary` / `text-text-tertiary` to the preview's dark-band vocab manually.** Rejected: vocab pollution doesn't help. The issue is the tokens resolve to dark colors per `tokens.css` regardless of where they appear; "approving" them in the vocab just masks the bug.

- **Fix Y — Convert `_extracted/eyebrow.html` to use `currentColor` instead of `text-text-secondary` so the parent's color applies.** Rejected at this layer: it's a valid design-system improvement but it's a refactor of every extracted pattern (eyebrow.html + every other pattern that bakes in text colors). Out of scope for bug-005's narrow class. Worth filing as a separate refactor follow-up after bug-005 stabilizes the audit.

- **Fix Z — Move D11 enforcement out of the screens audit into a render-time computed-style check (e.g. Playwright + getComputedStyle assertions).** Rejected: that's bug-078 territory (audit-computed-styles, deferred per `.claude/rules/protected-files-policy.md` §Empirical motivator). Adds a heavyweight runtime dependency to the design pipeline before any builder fires. Class-level static checks catch ≥90% of the regression class with zero runtime overhead.

- **Fix W — Hardcode the dark-text blocklist as the SOLE D11 check; drop the vocab-derived approach entirely.** Rejected: the vocab-derived approach catches PROJECT-SPECIFIC drift (e.g. a project that committed `text-white/85` in its preview but a screen uses `text-white/40` which isn't approved). Both checks are valuable in tandem — vocab catches drift relative to project's chosen palette; blocklist catches universally-broken combinations. Defense in depth.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app` post-bug-004 (current state, 12 screens, 2 known dark-on-dark instances on services-detail-visual + services-index).

**Pass conditions** (after Parts A + B + C land):

1. Re-running `node ../../scripts/audit-preview-coverage.mjs` against test-app's current preview (no dark CTA band) EXITS 1 with the dark-band-coverage assertion failure. Test-app extends the preview with a dark CTA band; re-running EXITS 0.

2. After the preview is extended + re-rerun `/screens`, the strengthened D11:
   - Reports `services-detail-visual.html` + `services-index.html` as failures with specific findings naming the offending `text-text-secondary` lines.
   - Per-screen surgical fix swaps `text-text-secondary` → `text-white/70` in the dark CTA bands.
   - Final audit: `audit-screen-pattern-consumption — ✓ PASS` across D1+D4+D6+D8+D9+D10+D11 (all 7 dimensions).

3. Negative-regression test: edit the strengthened audit to remove the hardcoded blocklist (keep only vocab-derived). Re-run on a synthetic preview where vocab is empty. Confirm Part A.2 fail-closed semantics fire (exit 1 + structured warning) instead of silent PASS.

4. Cross-project sanity: run the strengthened audit on a hypothetical project whose preview explicitly models a dark CTA band with `text-white/70` body text. Confirm screens using `text-white/70` inside dark bands PASS; screens using `text-text-secondary` FAIL. Project-agnostic behavior preserved.

5. Operator visual eyeball: open `services-detail-visual.html` + `services-index.html` post-fix in a browser. Dark CTA band's eyebrow text reads clearly (light grey on near-black).

**Cross-references:**

- `investigate-003-d11-dark-band-detector-gap` (parent — the investigation that found the triple-compounding bug)
- `bug-002-stylesheet-preview-coverage-prose-only` (sibling — the original preview-coverage audit Part B extends)
- `bug-003-screens-kit-content-bypass` + `bug-004-screens-chrome-consistency` (siblings of the same drift class)
- `LESSONS.md` candidate entry on close: _"Mechanical audits whose contracts are derived from upstream artifacts can silently no-op when the upstream artifact doesn't model the contract surface. Fail-closed semantics + hardcoded independent fallback assertion are both required."_ This now extends the prose-only-consumer-rule class into a meta-class about audit derivability.

## Attempt Log

<!-- Populated automatically by agents. -->

---

# COMPLETION RECORD (appended to archived plan)

completed: 2026-05-29
outcome: success
actual-files-changed:

- scripts/audit-screen-pattern-consumption.mjs (modified — D11 strengthening)
- scripts/audit-preview-coverage.mjs (modified — dark-band coverage assertion)
- .claude/skills/screens/SKILL.md (modified — §3.5.2 pattern-inlining-into-dark-contexts clause)
- phase-plan.md (modified — §F Row 037)
- feature_list.json (modified — phase1-step-037 row)
- projects/test-app/docs/design-system-preview.html (modified — Contact CTA band test fixture)
- projects/test-app/docs/screens/webapp/services-detail-visual.html (modified — surgical eyebrow swap)
- projects/test-app/docs/screens/webapp/services-index.html (modified — surgical eyebrow swap)
  commits:
- hash: 49e12be
  message: "phase1: bug-005 — D11 dark-band detector strengthening + preview-coverage dark-band assertion"
- hash: 0d098ed
  message: "phase1: evidence — phase1-step-037 (bug-005 D11 strengthening) empirical validation"
  attempts: 1
  lessons:
- "FIFTH instance of prose-only-consumer-rule class with NEW shape: mechanical audits can THEMSELVES silently no-op when their contracts are DERIVED from upstream artifacts that don't model the contract surface."
- "Triple-compounding bug shape: (F1) preview parser tag list omitted load-bearing tags, (F2) empty-vocab silently DISABLED the entire check (fail-OPEN), (F3) no bg-context tracking caused vocab pollution + screen-side over-counting."
- "Forward-looking rules: derivation-based audits MUST (a) fail-CLOSED on empty contracts, (b) pair with a hardcoded independent fallback assertion for universally-broken combinations, (c) be backed by an upstream coverage audit that forces the contract surface to be modeled."
- "Severity tiering matters: hardcoded blocklist findings = errors (always fail); vocab-derived findings = warnings (fail only with --strict). Conflating the two produces noise that masks real bugs."
- "Family-level vocab matching (text-white/85 family accepts text-white/70 etc.) reduces noise without losing signal — text-color tokens have natural family + opacity hierarchies that exact-match misses."
- "Surgical Edit-tool fixes worked correctly for the 2-screen swap — confirms the bug-004 dispatch-destruction lesson: Read+Edit is the right primitive for class-name substitutions, NOT shell-based search/replace."
  test-results:
  unit: n/a (audit script + skill body)
  integration: verified via phase1-step-037 evidence — both audits PASS post Part A+B+C+D + 2-screen surgical fix
  duration-minutes: 240

---
