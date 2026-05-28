---
id: bug-002-stylesheet-preview-coverage-prose-only
type: bug
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-28
parent-plan: investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2
supersedes: null
superseded-by: null
branch: fix/stylesheet-preview-coverage-prose-only
affected-files:
  - .claude/skills/stylesheet/SKILL.md
  - scripts/audit-preview-coverage.mjs
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: "Run /stylesheet on any project; then run node ../../scripts/audit-preview-coverage.mjs from the project cwd"
stack-trace: null
---

# bug-002-stylesheet-preview-coverage-prose-only: /stylesheet step 17 "full coverage assertion" is prose-only — no mechanical enforcement

## Bug Description

`/stylesheet` step 17 declares a "Full-coverage assertion" in prose:

> Before writing the preview, verify: every entry in `components.md`'s JSON trailer (`primitives`, `patterns`, `layouts`, `projectSpecific` combined) has at least one corresponding rendered instance with a matching `data-comp` attribute. If any analyst-observed component is missing from the preview, abort.

…and UX principle 3 says:

> Every component is active — no greyed-out "unused canonical" state. A Slider the analyst didn't call out is still draggable. A Popover the analyst didn't list still opens on click.

**Expected:** every analyst-observed primitive + pattern + layout + canonical-unused primitive + canonical-unused pattern + each primitive variant from `.components-shapes.json` is RENDERED LIVE in `design-system-preview.html` with a `data-comp="<Name>"` annotation. A reviewer at gate 3 sees the full kit and signs off knowing every downstream surface will draw from the same vocabulary.

**Actual:** the rule lives in prose only. The LLM author of step 17 follows the prose with interpretive latitude. The empirical post-feat-001 rerun of `/stylesheet` on `projects/test-app` (Spark Studio, 2026-05-28T21:15Z) shipped a preview missing:

- **2 analyst-observed components** — `Wordmark`, `MarketingLayout` (used on 11 + 12 screens respectively per `docs/analysis/shared/components.md`)
- **12 canonical-unused components** — `Tabs`, `Tooltip`, `Toast`, `Modal`, `Drawer`, `Slider`, `Switch`, `Radio`, `Skeleton`, `Select`, `CommandPalette`, `DataTable` — per UX principle 3 these SHOULD have been rendered live
- **5 primitives missing variants** from `.components-shapes.json` — Button missing `icon-only`, Badge missing `neutral` + `success`, Link missing `inline`, Hero missing `full-bleed-photo` + `split-photo`, Avatar missing `stack-item`
- **23 icons** referenced across `screens.json` not rendered as a catalog — reviewer can't sign off on icon style + scale + weight before the icons propagate across 12 screens

This is a meta-bug: the SKILL.md instruction is correct in spirit, but its enforcement relies on the LLM author actually following prose, with no mechanical check. The result is project-by-project drift — different /stylesheet invocations skip different sub-sets of the required coverage.

Operator framing (the empirical motivator for filing this bug): _"it's crucial we see everything on the stylesheet at this stage as the user may want components changed and it's best we fix here as the source of truth rather than fixing them everywhere they are used upstream."_

The fix must be **project-agnostic** — Hatch is one test case; every future project (book-swap / finance-track / kanban / gotribe-channels / etc.) goes through this same gate. The factory needs a coverage mechanism that gates `/stylesheet` regardless of which mockup, which style, which screen list.

## Reproduction Steps

1. Run `/stylesheet` on any project where `/analyze` has produced `docs/analysis/shared/components.md` with a JSON trailer.
2. From the project's cwd (e.g. `projects/test-app/`), run:
   ```
   node ../../scripts/audit-preview-coverage.mjs
   ```
3. Observe: the audit reports gaps for any analyst-observed / canonical-unused / variant entries the preview is missing.

Concrete reproduction on `projects/test-app/` after the 2026-05-28T21:15Z /stylesheet rerun:

```
audit-preview-coverage — ✗ FAIL
  required: 26 analyst-observed + 13 canonical-unused + 19 variants + 23 icons
  present: 27 component names + 0 icon names

  ✗ Analyst-observed components missing from preview (2):
      - Wordmark
      - MarketingLayout
  ✗ Canonical-unused components missing from preview (12):
      - Tabs / Tooltip / Toast / Modal / Drawer / Slider / Switch / Radio /
        Skeleton / Select / CommandPalette / DataTable
  ✗ Per-primitive variants missing (5 primitives):
      - Button: icon-only
      - Badge: neutral, success
      - Link: inline
      - Hero: full-bleed-photo, split-photo
      - Avatar: stack-item
```

## Error Output

```
(no runtime error — semantic coverage regression, surfaced by the new
scripts/audit-preview-coverage.mjs verifier; same pattern as bug-001's
"semantic regression, not a runtime error")
```

## Root Cause Analysis

`/stylesheet` step 17 is a single big LLM-author step. The "Full-coverage assertion" sits in prose alongside other instructions. The LLM follows the prose at its own discretion, with no mechanical post-write check. Specifically:

1. **No required-coverage manifest written before authoring.** The required union (analyst-observed + canonical-unused + variants + icons) isn't computed into a single file the author reads. The author re-derives it from prose every time, with predictable drift.
2. **No post-write verifier with hard-abort.** The skill body's "grep-based verifier" only checks `data-comp` names match `.components-plan.json`'s union — it doesn't check canonical-unused, variants, or icons.
3. **UX principle 3 is aspirational prose.** "Every component is active" reads as guidance, not contract. The LLM may interpret it as "for components the analyst observed, render them live" instead of "for ALL canonical components, render them live."
4. **Variants are introduced by feat-001 but coverage of variants wasn't added to step 17's verifier.** feat-001 added `.components-shapes.json` with `variants[]` arrays per primitive, but step 17's full-coverage assertion still only checks single-instance-per-name presence — no per-variant verification.

## Fix Approach

Three-part fix, all factory-level (not project-specific):

### Part A — `scripts/audit-preview-coverage.mjs` (factory script, project-agnostic)

A standalone Node script that:

1. Reads `docs/analysis/shared/components.md` JSON trailer → required = (primitives ∪ patterns ∪ layouts ∪ projectSpecific) + (canonicalCoverage.primitivesUnused ∪ canonicalCoverage.patternsUnused).
2. Reads `packages/ui-kit/.components-shapes.json` → required-variants = per-primitive `variants[*].name`.
3. Reads `docs/brief-summary.json` + `docs/analysis/{platform}/screens.json` → required-icons = union of `screens[*].icons[]`.
4. Greps `docs/design-system-preview.html` for `data-comp="<Name>"`, `data-variant="<name>"` inside Button-class data-comp matches, and `data-icon="<name>"`.
5. Reports missing items per category.
6. Exits 0 on full coverage, 1 on any gap (icons warning-only by default; `--strict` makes icons fail too).

Runnable from any project's cwd. Same script works on test-app, book-swap, finance-track, gotribe-\*, future projects. No project-specific config.

### Part B — `/stylesheet` SKILL.md extension

Two additions to step 17:

1. **New required sub-sections** the preview MUST contain (each gets a `<section id="...">` heading):
   - **§Header** (already required per feat-001 principle 10)
   - **§Form Controls** — renders Input, Textarea, Select, Checkbox, Radio, Switch, Slider — each interactive
   - **§Overlays** — renders triggers for Tabs, Tooltip, Toast, Modal, Drawer + a Skeleton sample
   - **§Data Views** — DataTable + CommandPalette trigger
   - **§Button variants** — one rendered instance per `variants[]` entry in `.components-shapes.json` Button. data-comp + data-variant annotations
   - **§Card variants** — same, per Card's variants[]
   - **§Icon catalog** — every distinct icon from `screens.json` icons[] arrays, rendered at uniform size with `data-icon="<name>"`
   - **§Realistic chrome** (the existing hero/services/work/testimonial/contact composition — analyst-observed patterns rendered in context)

2. **Post-write verifier wired to the audit script:**

   ```
   After writing docs/design-system-preview.html, invoke
   `node $FACTORY_ROOT/scripts/audit-preview-coverage.mjs` from the
   project cwd. If exit code != 0, ABORT with success:false and
   errors:[<missing items from script output>]. Do NOT regenerate the
   preview without re-reading components.md + .components-shapes.json
   + screens.json to confirm the required-coverage union changed.
   ```

### Part C — feature_list.json row + phase-plan.md §F update

Track the work as `phase1-step-034` (paired with the existing phase1-step-032/033 follow-up rows). Document the durable behavior in phase-plan.md §F so the rebuild manifest captures the coverage mechanism, not just feat-001's extraction.

## Rejected Fixes

- **Fix A — Add another prose principle to step 17 saying "really, really render every canonical component".** Rejected because: the existing prose principle 3 already says this. Adding more prose doesn't fix the enforcement gap; only a mechanical check does. Same root cause as the bug.

- **Fix B — Have `/screens` skip components that weren't in the preview.** Rejected because: the gate-3 review's whole purpose is to lock the kit BEFORE downstream stages run. If `/screens` filters by what's in the preview, the operator's leverage at gate 3 is the wrong leverage point — they'd be reviewing a subset, not the kit. The fix lives upstream in /stylesheet.

- **Fix C — Move coverage enforcement to /verify-html (Layer 6).** Rejected because: /verify-html is a generic HTML schema checker; coverage is project-specific (depends on this project's components.md). The audit lives naturally in /stylesheet's post-write step where the project context is loaded. /verify-html can stay generic.

- **Fix D — Don't render canonical-unused components in the preview; trust that /stylesheet-primitives will author them post-architect.** Rejected because: gate 3 is the last review point BEFORE architect runs. If the operator hasn't signed off on Tabs/Tooltip/Drawer at gate 3, those primitives ship in /stylesheet-primitives without review. UX principle 3 exists precisely to prevent that. Rendering canonical-unused live at gate 3 is what makes the gate meaningful for the FULL kit.

## Validation Criteria

1. Re-run `/stylesheet` on `projects/test-app` after Part A + B land. The skill body's step 17 emits a preview that has all required sections.
2. Run `node ../../scripts/audit-preview-coverage.mjs` from `projects/test-app/`. Exit code 0. Output: `✓ PASS  All required components + variants present.`
3. Negative-regression test: edit `docs/design-system-preview.html` to delete one canonical-unused component (e.g. remove the Modal section). Re-run the audit. Exit code 1. Output reports Modal missing.
4. Cross-project test: run the same audit on a hypothetical project with a different `components.md` shape (e.g. book-swap with EmptyState as analyst-observed + Slider as canonical-unused). The audit reports gaps per THAT project's required-union, not test-app's. (Confirms project-agnostic.)
5. The skill body's step 17 post-write paragraph names `node $FACTORY_ROOT/scripts/audit-preview-coverage.mjs` as the verifier with hard-abort semantics.
6. `phase-plan.md` §F has a paragraph documenting the audit-script + required-section mechanism (so the rebuild manifest captures the durable behavior).

## Attempt Log

<!-- Populated automatically by agents. -->
