---
id: bug-004-screens-chrome-consistency
type: bug
status: archived
author-agent: Claude (Phase 3 build)
created: 2026-05-29
updated: 2026-05-29
parent-plan: investigate-002-screens-reinvents-kit-patterns
supersedes: null
superseded-by: null
branch: fix/screens-chrome-consistency
affected-files:
  - .claude/skills/screens/SKILL.md
  - scripts/audit-screen-pattern-consumption.mjs
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: "Run /screens on any project; observe footer bg + dark-band text classes vary across screens within the same project"
stack-trace: null
---

# bug-004-screens-chrome-consistency: /screens cross-screen chrome (footer + dark-band text) drifts within a project — same prose-only-consumer-rule class as bug-002 / bug-003

## Bug Description

After bug-003 shipped (pattern verbatim consumption + cross-screen avatar/seed contract), a NEW drift dimension surfaced on the operator's visual review of the 12-screen rerun: **chrome styling drifts across screens within the same project.**

Concrete instances observed on `projects/test-app` (Spark Studio, 2026-05-29 post-bug-003 run):

- **Footer background color**: 4/12 screens use `bg-surface-base` (warm paper grey) — the kit's canonical footer chrome. 1/12 (`inquiry-confirmation`) uses `bg-surface-inverted` (near-black `#111111`). 7/12 omit the explicit bg class entirely.
- **Dark-band descendant text classes**: inside `bg-surface-inverted` blocks (CTA bands + the one inverted footer), agents use `text-text-secondary` (mid-grey `#6B6B6B`) for body / caption / nav text. The class resolves correctly to mid-grey — fine on light bg but **fails WCAG AA contrast on near-black** (operator framing: _"dark grey writing on black bands is unclear"_). Other screens correctly use `text-text-inverted` / `text-white` / `text-white/85` on dark bands.

This is the **fourth instance** of the prose-only-consumer-rule drift class observed in this Phase-1 session:

| Bug         | Drift surface                  | Prose rule that wasn't audited          |
| ----------- | ------------------------------ | --------------------------------------- |
| bug-002     | `/stylesheet` preview-coverage | "render every component live"           |
| bug-003     | `/screens` kit-content-bypass  | "consult kit patterns before inventing" |
| **bug-004** | `/screens` chrome consistency  | (no rule existed — chrome was implicit) |

Same fix shape applies: audit script + skill-body extension + feature_list row + phase-plan §F.

**Crucially: bug-004's fix is project-agnostic CONSISTENCY, not specific colors.** A SaaS dashboard project might legitimately want a black footer + low-contrast dark-band typography. A boutique-hotel project might want a sepia-tone footer. The audit's job is to detect drift WITHIN a project — that all 12 screens of a given project agree on the footer color and dark-band text vocabulary, NOT to enforce Hatch's specific palette across projects.

**The canonical chrome reference IS the design-system-preview.html.** It's the gate-3 signoff artifact; the operator approves the chrome there. Every screen's page-footer + dark-band text MUST match the vocabulary committed at gate 3. The audit derives the contract per-project by parsing the preview.

## Reproduction Steps

1. Run `/screens` on any project where `/stylesheet` has produced `docs/design-system-preview.html` + 12+ screens have been composed.
2. From project cwd:
   ```bash
   node ../../scripts/audit-screen-pattern-consumption.mjs --dimension D10
   node ../../scripts/audit-screen-pattern-consumption.mjs --dimension D11
   ```
3. **Observe** (post-bug-004): audit exits 1 with the specific screens whose footer bg differs from the design-system-preview's footer + the specific dark-band blocks whose text classes differ from the preview's vocabulary.

Concrete reproduction on `projects/test-app/` post-bug-003 (2026-05-29):

```
D10 footer-bg consistency:
  preview footer bg: bg-surface-base
  screens with matching footer:    4/12
  screens with non-matching footer: 1/12 (inquiry-confirmation: bg-surface-inverted)
  screens omitting explicit bg:    7/12 (probably inheriting default — should be explicit)
  → drift: 8/12 screens fail consistency

D11 dark-band text-vocabulary consistency:
  preview dark-band text classes: text-text-inverted, text-text-inverted/85, text-text-inverted/70
  screens with text-text-secondary inside bg-surface-inverted blocks: 5/12
    (home, services-index, services-detail-visual, case-study-detail, about)
  → drift: 5/12 screens mix light-mode text tokens into dark-band contexts
```

## Error Output

```
N/A — semantic consistency regression. Surfaced by operator visual review;
mechanically detected by the new D10 + D11 dimensions in
scripts/audit-screen-pattern-consumption.mjs. Same drift class as bug-002 / bug-003.
```

## Root Cause Analysis

`/screens` step 3.5.2 (cross-screen consistency contract — shipped with bug-003) names canonical avatars + case-study seeds + nav position + footer column count + max-width. It does NOT name:

- The footer background color
- The descendant text-class vocabulary inside dark-band blocks

These were assumed to inherit from `globals.css` or be tokenized through Tailwind utility classes. In practice agents fill them in idiomatically — and idiosyncratically — per their training-data instinct. Some inherit `bg-surface-base` from `globals.css` body; others explicitly set `bg-surface-inverted` "for visual contrast" with no contract telling them not to. Same with text-text-secondary in dark contexts — the class name doesn't TELL them it's a light-mode-only token; the agent picks it because "secondary text" semantically fits.

The root cause is identical to bug-002 / bug-003: **prose-only consumer-side rule (or absence of one) → drift**. The fix is mechanical enforcement.

## Fix Approach

Three-part fix (mirrors bug-002 + bug-003 shape):

### Part A — `scripts/audit-screen-pattern-consumption.mjs` extension (D10 + D11)

**D10 — Footer background consistency** (project-agnostic):

1. Parse `docs/design-system-preview.html` for its page-level `<footer>` element. Extract the background-color class (e.g. `bg-surface-base`, `bg-neutral-100`, `bg-secondary-500`, whatever the project's preview committed).
2. For each `docs/screens/{platform}/*.html`, extract the page-level `<footer>` background-color class (preferring `<footer data-kit-component="Footer">` OR last footer per existing audit logic).
3. Flag screens whose footer-bg class doesn't match the preview's. Empty-bg screens flagged too (force explicit consistency).
4. Exit non-zero on any mismatch.

**D11 — Dark-band text vocabulary consistency** (project-agnostic):

1. Parse `docs/design-system-preview.html` for blocks with backgrounds that resolve to dark (heuristic: `bg-surface-inverted`, `bg-neutral-{800,900,950}`, `bg-secondary-{500,600}`, `bg-black`).
2. Extract the unique text-color classes used as descendants within those dark blocks (e.g. `text-text-inverted`, `text-text-inverted/85`, `text-white/70`).
3. Build the project's **dark-band text vocabulary** = union of those classes.
4. For each screen, find dark-band blocks + their descendant text-color classes. Flag any class used inside a dark-band block that is NOT in the project's dark-band vocabulary.
5. Specifically flags `text-text-secondary` inside dark-band blocks when the preview's dark-band vocabulary uses `text-text-inverted/*` — the audit doesn't know the resolved hex; it knows the preview's vocabulary and asserts vocabulary consistency.
6. Exit non-zero on any mismatch.

Both dimensions: same `--json` / `--strict` / `--dimension` flags as the existing audit. Cross-project agnostic — reads each project's own design-system-preview.html to derive contract.

### Part B — `.claude/skills/screens/SKILL.md` extension (step 3.5.2 update)

Add a new clause to §3.5.2 cross-screen consistency contract:

```
### Canonical chrome reference: docs/design-system-preview.html

The design-system-preview.html generated by /stylesheet is the canonical
chrome reference for the project. The operator signs it off at gate 3.
Every screen's page-level chrome MUST match the preview's vocabulary:

- **Footer background**: copy the page-level <footer>'s bg-* class from the
  preview. Use it on every screen's page footer. Do not invent your own
  footer chrome.

- **Dark-band text vocabulary**: for any background context that's "dark"
  in the preview (bg-surface-inverted / bg-neutral-{800,900,950} / etc.),
  copy the descendant text-color class vocabulary from the preview. If
  the preview uses text-text-inverted / text-text-inverted/85 /
  text-text-inverted/70, every screen's dark-band block must use the
  same. Do NOT mix in light-mode text tokens (text-text-secondary,
  text-text-tertiary) — they fail WCAG contrast on dark backgrounds.

The audit at step 8a (D10 + D11) verifies this mechanically. Drift
aborts the batch.
```

This is **project-agnostic**: a project whose preview uses a black footer with low-contrast typography is internally consistent + the audit passes. Different projects have different vocabularies; what the audit enforces is consistency-within-project.

### Part C — `feature_list.json` row `phase1-step-036` + `phase-plan.md` §F update + bug-004 plan

Track the work + document durable behavior so the rebuild manifest captures the chrome-consistency contract.

## Rejected Fixes

- **Fix A — Hardcode "footer must be bg-surface-base" + "dark-band text must be text-text-inverted" in the SKILL.md.** Rejected because: projects vary. A SaaS dashboard might legitimately want a black footer; a heavy-typography fashion brand might want low-contrast intentionally. The drift-prevention rule is **consistency within a project**, derived from the project's own design-system-preview.html (the operator signs off on chrome at gate 3 — that's the contract).

- **Fix B — Surgical-patch the 12 test-app screens directly without filing.** Rejected because: same drift will recur on the next project. The empirical pattern (this is the FOURTH instance of the same class in one session) shows that prose-only consumer-side rules drift ≥75-86% of the time. The fix is structural.

- **Fix C — Wait for /visual-review (task 025b) to catch this via screenshot rubric.** Rejected because: /visual-review fires AFTER /screens completes, and its rubric is interpretive ("does this look right"). A mechanical class-vocabulary check catches drift faster + deterministically + before /visual-review burns LLM time on screenshots of inconsistent output.

- **Fix D — Make the audit detect contrast failures via WCAG calculation on resolved hex values.** Rejected because: requires resolving CSS variables through the kit + parsing the dark surface bg + the text fg hex, then computing contrast ratio. Too much surface area for v1. Vocabulary consistency is the simpler proxy — if the preview's dark-band uses text-text-inverted/\* and the screen uses text-text-secondary, that's a token-set mismatch the audit can grep without computing colors. WCAG contrast calculation is a future enhancement.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app` post-bug-003 (current state, 12 screens).

**Pass conditions** (after Part A + B land):

1. Re-running `/screens` on `projects/test-app` (with the updated SKILL.md driving regeneration) produces 12 screens where:
   - All 12 footers use the same `bg-*` class (whatever the preview committed)
   - All 12 dark-band blocks use ONLY text-color classes that appear in the preview's dark-band vocabulary

2. Audit script exits 0 from project cwd:

   ```
   audit-screen-pattern-consumption — ✓ PASS
     D10 footer-bg consistency: 12/12 match preview
     D11 dark-band text vocabulary: 0 mismatches
   ```

3. Negative-regression test: edit one screen to swap its footer bg to a different class → audit exits 1 with footer-mismatch finding on that screen.

4. Cross-project sanity: run the audit on a hypothetical second project whose design-system-preview has a black footer + low-contrast vocabulary. The audit PASSES if the project's screens are consistent with that preview (even though Hatch's preview is light-grey + high-contrast). Confirms project-agnostic.

5. Operator visual eyeball: open all 12 screens in browser. Footers visually identical (same shade). Dark CTA-bands have text that's readable + visually consistent across screens.

**Cross-references:**

- `bug-002-stylesheet-preview-coverage-prose-only` (sibling)
- `bug-003-screens-kit-content-bypass` (immediate sibling — shipped same session)
- `investigate-002-screens-reinvents-kit-patterns` (parent investigation; drift survey)
- `LESSONS.md` candidate entry on close: _"Consumer-side rules in skill bodies need mechanical audits when shipped, not retroactively."_ Now n=4 instances in one session.

## Attempt Log

<!-- Populated automatically by agents. -->

---

# COMPLETION RECORD (appended to archived plan)

completed: 2026-05-29
outcome: success
actual-files-changed:

- .claude/skills/screens/SKILL.md (modified)
- scripts/audit-screen-pattern-consumption.mjs (modified — added D10 + D11)
- plans/active/bug-004-screens-chrome-consistency.md (created)
  commits:
- hash: 65cd7fa
  message: "phase1: bug-004 — /screens chrome-consistency factory fix (D10 + D11 audit + SKILL.md §3.5.2 chrome contract)"
- hash: d0367b6
  message: "phase1: evidence — phase1-step-036 (bug-004 chrome consistency) empirical validation"
  attempts: 1
  lessons:
- "FOURTH instance of prose-only-consumer-rule class. Footer-bg drift 50% + dark-band-text-vocab drift 42% across n=12 dispatches when chrome contract was implicit."
- "PROJECT-AGNOSTIC framing matters: audit derives canonical chrome from each project's own design-system-preview.html (the gate-3 signoff artifact), not from hardcoded values. A SaaS dashboard whose preview commits to black footer + low-contrast typography passes — consistency-within-project is what's enforced."
- "Operator instruction 'lets only re dispatch on affected screens' is the right cost-saving heuristic — surgical retries on only the audit-flagged screens, not the full batch."
- "Single-screen surgical retries must use Read+Edit, NOT PowerShell `(Get-Content -Raw) -replace … | Set-Content`. Empirical destruction: case-study-detail.html dispatch lost a 1498-line file via shell-pipe quoting failure. Full regeneration recovered it."
  test-results:
  unit: n/a (audit script + skill body)
  integration: verified via phase1-step-036 evidence — 12 screens × 7 dimensions all PASS post 6-screen surgical re-dispatch
  duration-minutes: 240

---
