---
id: bug-003-screens-kit-content-bypass
type: bug
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-29
updated: 2026-05-29
parent-plan: investigate-002-screens-reinvents-kit-patterns
supersedes: null
superseded-by: null
branch: fix/screens-kit-content-bypass
affected-files:
  - .claude/skills/screens/SKILL.md
  - scripts/audit-screen-pattern-consumption.mjs
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: "Run /screens on any project; then run node ../../scripts/audit-screen-pattern-consumption.mjs from project cwd"
stack-trace: null
---

# bug-003-screens-kit-content-bypass: /screens consumer-side kit-content rules are prose-only — agents reinvent brand marks, hex literals, keyframes, layout, and avatar URLs across 5 drift dimensions

## Bug Description

`/screens` skill body Inputs §4b says (post-feat-001):

> "Consult kit patterns BEFORE inventing. When a section needs a logo composition, reach for `_extracted/wordmark.html` instead of inventing one. When a section heading needs an eyebrow, reach for `_extracted/eyebrow.html`. When a hero needs a floating stat overlay, reach for `_extracted/stat-tile.html`. This is what makes screens look LIKE the mockup, not GENERIC."

This is prose-only enforcement — same drift class as bug-002 (which fixed the equivalent gap in `/stylesheet`'s preview-coverage). Operative verbs are "consult" and "reach for" — invitations to consume the pattern, not contracts requiring byte-verbatim consumption. Agents read the patterns, internalize the design intent, then write their own version — which technically complies with "consult before inventing" but defeats the whole point of feat-001's extraction passes.

**Empirical evidence** — `investigate-002` measured n=12 ui-designer dispatches on `projects/test-app` (2026-05-28T22:00Z). Five drift dimensions surfaced (cluster confirmed in `investigations/investigate-002-drift-survey.mjs` output):

| Dimension                               | Drift rate                                                                                                         | Concrete example                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** Named-pattern consumption        | **86%** (15/108 cells verbatim; 93/108 drifting)                                                                   | 0/12 screens use the kit's canonical `<span class="logo-spark">` + 14×14 lightning-bolt SVG path `M13 2 4.5 13.5h6L8 22l8.5-11.5h-6L13 2z`. 3 distinct brand-mark designs (lightning-bolt variant / 8-pointed star orange / 8-pointed star yellow) shipped across 12 screens. |
| **D4** Hex literal leakage              | 5/12 screens (21 SVG fill hex occurrences)                                                                         | `fill="#FF5C35"` and `fill="#FFE14D"` literals inline in case-study-detail, contact, inquiry-confirmation, privacy, not-found — bypassing kit's `currentColor` + token cascade. Correlates 1:1 with D1 (agents inventing brand marks need invented hex fills).                |
| **D6** Cross-screen imagery consistency | 6/12 screens use non-canonical avatars; 0/12 reuse all 4 canonical                                                 | Preamble named 4 canonical Unsplash avatar URLs (Anika P. / Marco L. / Priya R. / Sam K.) for cross-screen continuity. Agents substitute their own Unsplash photo IDs. The reviewer sees different "team members" across screens.                                             |
| **D8** Layout shell drift               | 8/12 used `sticky` nav instead of preamble-required `fixed`; 4/12 missing 4-col footer                             | Preamble + `.components-shapes.json` `Nav.position: "fixed"` both specify fixed. Agents reinterpret as `sticky` (semantically similar in their training data, NOT what the kit specifies).                                                                                    |
| **D9** Inline `<style>` block drift     | 34 custom class definitions + 7 non-canonical `@keyframes` (`spark-rotate` / `hatch-pulse` / `glyph-drift` / etc.) | Agents invent CSS keyframes to animate their invented brand marks. Each invention compounds the kit-bypass.                                                                                                                                                                   |

Operator-facing rationale (investigation parent + bug-002 origin): same pattern — _"it's crucial we use the kit as the source of truth at this stage; agents reinventing content downstream means the kit's role as the single source of truth is lost."_

**Confirmed by investigate-002 Findings:** root cause is identical across D1+D4+D6+D8+D9 — prose-only enforcement of consumer-side rules. The fix is mechanical enforcement (audit script + skill-body verbatim contract) — same shape as bug-002.

## Reproduction Steps

1. Run `/screens` on any project where `/analyze` + `/mockups` + `/stylesheet` have completed and feat-001 wrote `packages/ui-kit/src/patterns/_extracted/*.html`.
2. Wait for batch to complete (12+ screens generated in `docs/screens/{platform}/`).
3. From project cwd, run `node ../../scripts/audit-screen-pattern-consumption.mjs` (filed by this bug).
4. **Observe:** audit exits 1 with per-dimension drift report.

Concrete reproduction on `projects/test-app/` (2026-05-28T22:00Z run):

```
audit-screen-pattern-consumption — ✗ FAIL
  D1 patterns:           93/108 cells drifting (86% drift rate)
  D4 hex leakage:        21 SVG fill hex literals across 5 screens
  D6 imagery:            6/12 screens use non-canonical avatars
  D8 layout:             8/12 sticky-nav vs preamble fixed; 4/12 missing 4-col footer
  D9 inline styles:      34 custom class defs; 7 non-canonical @keyframes
```

## Error Output

```
N/A — semantic kit-consumption regression. Surfaced by the new
scripts/audit-screen-pattern-consumption.mjs verifier filed by this bug.
Same pattern as bug-002's drift class (no runtime error; agent-compliance failure).
```

## Root Cause Analysis

`/screens` step 4 ("Compose each remaining screen") is a parallel-agent fan-out. Each ui-designer subagent:

1. Reads the shared preamble (per skill step 3.5) — which references `_extracted/*.html` by PATH, not by inlined content.
2. Reads `_extracted/*.html` directly when prompted.
3. Composes the screen.

The compose step is where drift surfaces. The skill body's prescription "consult before inventing" leaves the door open to "I consulted, now I'll write my own." Without a mechanical contract, agents follow their training-data instinct to "compose creatively" rather than "inline byte-for-byte."

The bug class is **identical to bug-002**:

- bug-002 (`/stylesheet`): "Full-coverage assertion" in prose → agents skipped components → fixed with audit script + skill-body sub-section table
- bug-003 (`/screens`): "Consult kit patterns" in prose → agents reinvent patterns → fix with audit script + skill-body verbatim contract

Same prose-enforcement root cause; same fix shape.

## Fix Approach

Three-part fix (mirrors bug-002 structure):

### Part A — `scripts/audit-screen-pattern-consumption.mjs` (factory script, project-agnostic)

Node script that:

1. **Pattern marker extraction** — for each pattern in `packages/ui-kit/.patterns-extracted.json`, parse `_extracted/{slug}.html` to extract:
   - Anchor classes (e.g. `logo-spark`, `pulse-dot`, `stat-tile-bob`, `trust-marquee`)
   - Canonical SVG path bytes (e.g. lightning-bolt `M13 2 4.5 13.5h6L8 22l8.5-11.5h-6L13 2z`)
   - `data-pattern="<slug>"` attribute
   - Canonical `@keyframes <name>` defined in the pattern's inline `<style>`

2. **Per-screen audit** — for each `docs/screens/{platform}/*.html`:
   - **D1**: For each kit pattern, check whether the screen references it AND whether canonical anchor + SVG path bytes appear unmodified
   - **D4**: Count `fill="#[0-9A-Fa-f]{6}"` outside canonical kit-pattern bytes
   - **D9**: Parse inline `<style>` blocks for `@keyframes` defs; flag any name not in canonical set

3. **Cross-screen audit**:
   - **D6**: parse all screens for image URLs; identify recurring image references; assert canonical avatars (per preamble manifest) appear consistently
   - **D8**: parse nav position + footer column count + max-width consistency

4. Per-dimension gap report. Exits 0 on full pass, 1 on any drift. Flags: `--json`, `--strict`, `--dimension D1|D4|D6|D8|D9|all`.

5. **Project-agnostic** — reads each project's own `.patterns-extracted.json` + `_extracted/*.html` + `screens/*.html`. No project-specific config. Same script for test-app, future agency portfolios, SaaS dashboards.

### Part B — `.claude/skills/screens/SKILL.md` extension

1. **Inputs §4b language tightening** — replace "Consult kit patterns BEFORE inventing" with explicit verbatim-inline contract:

   ```
   ### §4b — INLINE kit patterns verbatim (NOT consult-and-adapt) — phase1-step-035 / bug-003

   When a screen section needs a kit pattern, INLINE the canonical
   _extracted/{slug}.html content byte-for-byte into the screen HTML. Do
   NOT modify the SVG path bytes. Do NOT change anchor class names. Do NOT
   substitute your own brand mark / keyframe / utility class.

   "Consult" / "consume creatively" / "use as inspiration" are explicitly
   forbidden. The kit's _extracted/*.html files are the canonical content;
   reproduction = identity.
   ```

2. **New §4b.1 per-pattern marker table** — explicit markers each pattern MUST emit (anchor class, canonical SVG path, data-pattern attr, keyframe names). Audit script greps for these.

3. **Step 3.5 shared-preamble change** — the preamble generator MUST inline `_extracted/*.html` content verbatim (not just path references). Agents see the bytes; agents inline the bytes.

4. **New §4h "Cross-screen consistency contract"** — names canonical avatar URLs + case-study seeds + nav position + footer composition that EVERY screen reuses across the batch. Audit script enforces consistency.

5. **New step 8a "Mechanical batch audit"** — wires `scripts/audit-screen-pattern-consumption.mjs` as post-batch verifier. Exit non-zero → halt the batch; populate `failedScreens[]` with the drifting screens; orchestrator retries the failed ones with the audit report as retry context.

6. **Updated Acceptance criteria** with new invariants.

### Part C — `feature_list.json` row `phase1-step-035` + `phase-plan.md` §F update

Track the work + document durable behavior so the rebuild manifest captures the verbatim-inline contract + audit script.

## Rejected Fixes

- **Fix A — Tighten the prose further: "use VERBATIM, do not adapt".** Rejected because: that's what investigate-002 step 3 (skipped on time budget but pattern-matches strongly) would have tested. Empirical n=12 already showed prose-only enforcement fails ≥75% of the time even with "USE VERBATIM" in the dispatch prompts. More prose without mechanical enforcement is not load-bearing.

- **Fix B — Block on `/screens` skipping `_extracted/*.html` reads via hook.** Rejected because: hooks check tool calls (Read/Write), not output content. An agent that Reads the file and then writes its own version passes the hook. The audit must check the OUTPUT HTML, not the agent's tool calls.

- **Fix C — Have the orchestrator pre-compose the kit patterns into HTML scaffolds and dispatch agents only to fill content slots.** Rejected because: too rigid — patterns need contextual variation (different avatar URLs, different stat values, different case-study text). The fix is mechanical CONTENT verification, not mechanical layout pre-composition.

- **Fix D — Skip /screens entirely and have /stylesheet emit fully-composed screens.** Rejected because: /stylesheet ships the kit (tokens + patterns); /screens consumes the kit to compose screens. Folding them merges two concerns and loses the multi-screen parallelism.

- **Fix E — File 5 separate narrow bugs (one per drift dimension).** Rejected because: same root cause (prose enforcement), same fix shape (audit + skill edit), same validation surface (one /screens rerun). 5 bugs = 5× plan-archiving overhead with no incremental value.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app` with the existing 12-screen batch from the 2026-05-28T22:00Z run.

**Pass conditions** (post-Part A + Part B):

1. Re-running `/screens` on `projects/test-app` (with updated SKILL.md driving regeneration) produces an audit that exits 0 with:
   - D1: 9/9 patterns × 12/12 screens verbatim (108/108 cells ✓)
   - D4: 0 SVG fill hex literals outside canonical kit pattern bytes
   - D6: 4/4 canonical avatars present on every screen that needs avatars; canonical case-study seeds reused across home / work-index / case-study-detail
   - D8: 12/12 screens use `fixed` nav + 4-col footer
   - D9: 0 non-canonical `@keyframes`; custom class defs ≤4 per screen (only screen-specific keyframes that exist in the kit's canonical set)
2. Visual eyeball: open all 12 screens in a browser. All brand marks visually identical (same orange square + lightning bolt). Eyebrows uniform 6-wide accent bar. Stat tiles + trust bar identical.
3. Negative-regression test: edit one screen to substitute `fill="#FF5C35"` → re-run audit → exits 1 with hex-leakage finding on that screen.
4. Cross-project test: run the same audit on a hypothetical second project with different patterns (e.g. an enterprise dashboard with DataTable + CommandPalette as core patterns). Audit reports per-project drift correctly.
5. The skill body's step 8a names `node $FACTORY_ROOT/scripts/audit-screen-pattern-consumption.mjs` as the verifier with hard-abort semantics.
6. `phase-plan.md` §F has a paragraph documenting the verbatim-inline contract + audit script + kit-content-bypass class.

**Cross-references:**

- `investigate-002-screens-reinvents-kit-patterns` (parent investigation — full drift survey)
- `bug-002-stylesheet-preview-coverage-prose-only` (sibling drift class with identical fix shape)
- `feat-001-stylesheet-component-shapes` (the consumer-side rule that bug-003 tightens — shipped patterns; bug-003 ensures they get consumed)

**LESSONS.md entry to capture on close:**

Title: _"Consumer-side rules in skill bodies need mechanical audits when shipped, not retroactively"_

Empirical pattern (bug-002 + bug-003 are sibling instances):

- When a SKILL.md extends with a consumer-side rule depending on agent compliance (vs deterministic mechanical instruction), pair it with a mechanical audit script at ship time
- Prose-only consumer rules have a measured ≥75-86% drift rate (n=12 dispatches on test-app)
- Pattern: skill body says "do X" → agents do something close to X → drift compounds → operator notices → file retroactive audit
- Better: skill body says "do X" + audit script that exits 1 when X isn't done → drift caught at the skill's return JSON

## Attempt Log

<!-- Populated automatically by agents. -->
