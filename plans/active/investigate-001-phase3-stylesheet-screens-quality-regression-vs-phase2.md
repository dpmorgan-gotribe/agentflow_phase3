---
id: investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2
type: investigation
status: approved
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-28
parent-plan: null
supersedes: null
superseded-by: null
branch: null
affected-files:
  - .claude/skills/stylesheet/SKILL.md
  - .claude/skills/screens/SKILL.md
  - .claude/skills/stylesheet-primitives/SKILL.md
  - .claude/agents/ui-designer.md
  - packages/orchestrator-contracts/src/stages.ts
  - orchestrator/src/stages-array.ts
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
time-box-minutes: 90
hypothesis: One or more of the bulk-ported Phase 2 artifacts (ui-designer agent body, stylesheet/screens SKILL.md, stack-skills, templates) is being CONSUMED DIFFERENTLY in Phase 3 — either because Phase 3's dispatch infrastructure (model-config + agent-mcp-config + invoke-agent + excludeDynamicSections) feeds the agent a different context window than Phase 2's did, OR because a Phase-2-side helper / hook / context source that the skill body depends on did not get ported into Phase 3.
---

# investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2

## Question

When the SAME operator ran the SAME project (test-app with the Hatch brief) through Phase 2 agentflow vs Phase 3 agentflow:

- Phase 2's `/stylesheet` and `/screens` produced **rich, brand-aligned output** comparable to the gulia reference (`agentflow_version2/projects/gulia/outputs/screens/screen-01-home.html` — 1507 lines with custom decoration, floating overlays, logo marquee, stats band, hero visual card, backdrop-blur nav)
- Phase 3's `/stylesheet` and `/screens` produced **materially worse output** scored "1/10" by the operator — 771-line generic Tailwind composition, no decoration, no fidelity to the Spark Studio mockup

**Why does Phase 3 produce materially worse output than Phase 2 for the SAME project (brief + analysis + selected-style.json all identical or equivalent)?**

Both factories share the same authored artifacts (the bulk port preserved them verbatim) — so the regression must be in HOW the artifacts are dispatched, what context the agent receives, or what auxiliary files got missed in the port.

## Hypothesis

One or more of the following:

**H1 — Dispatch context regression.** Phase 3's `invoke-agent.ts` ships `excludeDynamicSections: true` (phase0-step-049 RESEARCH adopt). This was a cache-optimization that REMOVES per-machine cwd/git/platform context from the system prompt prefix. If `ui-designer` was implicitly relying on Phase 2's dynamic context (e.g. project-specific file enumeration, recent commits as design context, working directory awareness) for its richer output, removing it would degrade the result.

**H2 — Skill body dependency on a Phase-2-only helper.** The bulk port copied `.claude/skills/{stylesheet,screens}/SKILL.md` verbatim. But these skills may reference Phase-2-side helpers (a `factory/lib/` module, an unported template, an analyzer subscope output) that exist in Phase 2 but not Phase 3.

**H3 — MCP scope regression.** Phase 3's `agent-mcp-config.ts` filters factory `.mcp.json` to a per-dispatch subset based on agent frontmatter `mcp_servers: []`. If `ui-designer.md`'s frontmatter MCP list is incomplete (e.g. missing `image-generator` for nanobanana or `chrome-devtools` for design inspection) the agent gets fewer tools than Phase 2 dispatched it with.

**H4 — Model/effort regression.** Phase 3 `.claude/models.yaml` may resolve `ui-designer` to a different model + effort than Phase 2's resolution. If Phase 2 ran ui-designer at Opus + max-effort and Phase 3 lands at Sonnet + medium, the quality drop is explained.

**H5 — Asset / inspirations regression.** Phase 2's gulia run had cross-project pattern accumulation (agent had seen prior winning designs in the factory). Phase 3's test-app is a first run with no prior wins — the analyst's worker C (visual signature) couldn't pull in references the same way.

**H6 — Stylesheet kit-only contract tightened.** Phase 3 may have inadvertently tightened the kit-only enforcement (no inline styles + no custom CSS classes + no arbitrary Tailwind) such that ui-designer self-censors anything that would violate, producing flat output.

**H7 — Pipeline-mode vs manual-mode dispatch difference.** Phase 2's gulia run went through full pipeline (cli-runner walks stages, stage-runner dispatches each, each stage's prompt is constructed by stage-runner including upstream stages' outputs). Phase 3's test-app /stylesheet was invoked manually via Claude Code's Skill tool — the model didn't have the same stage-runner-assembled prompt context, just the SKILL.md body + whatever the model independently reads.

**H8 — Inputs delta**. Despite "same project", the Phase 2 test-app and Phase 3 test-app may differ in subtle inputs that influence output quality (`docs/analysis/` content, `docs/asset-inventory.json` depth, `brief-summary.json` completeness, etc.). The "same brief" assumption needs verification.

## Investigation Steps

Time-boxed at 90 minutes total. Stop and document findings even if incomplete.

### Step 1 — Inventory Phase 2 vs Phase 3 test-app artifacts (15 min)

For each of `projects/test-app/`:

- `docs/analysis/shared/{styles,components,inspirations,assets}.md` — `wc -l` + `md5sum` (or `sha256sum`) both versions
- `docs/analysis/webapp/{screens.json,flows.md,navigation-schema.md}` — same
- `docs/asset-inventory.json` — diff structure
- `docs/brief-summary.json` — diff
- `brief.md` — diff
- `docs/mockups/style-N/dials.yaml` + manifests — what styles existed in Phase 2 vs Phase 3
- `docs/selected-style.json` — what was selected in Phase 2 (if anything) vs Phase 3 (style-3 Spark Studio)

**Decision point:** if inputs materially differ, hypothesis H8 is the likely cause and the rest of the investigation pivots to understanding what produced the input delta.

### Step 2 — Diff the skill bodies + agent frontmatter (10 min)

- `diff` Phase 2 `.claude/skills/stylesheet/SKILL.md` vs Phase 3's
- `diff` Phase 2 `.claude/skills/screens/SKILL.md` vs Phase 3's (NOTE: Phase 3 just gained the Auto-run chain section per ADR-005 revision; that's expected delta — ignore for fidelity comparison)
- `diff` Phase 2 `.claude/skills/stylesheet-primitives/SKILL.md` vs Phase 3's
- `diff` Phase 2 `.claude/agents/ui-designer.md` vs Phase 3's
- Check frontmatter `mcp_servers: []` on ui-designer in both factories

**Decision point:** if skill bodies are byte-identical (modulo the ADR-005 auto-run addition) and ui-designer.md is byte-identical, the bug is NOT in the authored artifacts — pivot to dispatch infrastructure (H1, H3, H4, H7).

### Step 3 — Diff dispatch infrastructure (15 min)

- `diff` `orchestrator/src/invoke-agent.ts` — focus on systemPrompt construction, excludeDynamicSections, agent-mcp-config integration
- `diff` `orchestrator/src/model-config.ts` — focus on per-agent tier/effort resolution for ui-designer
- `diff` `orchestrator/src/agent-mcp-config.ts`
- `diff` `.claude/models.yaml` (factory + project levels) — what tier resolves to ui-designer in each factory
- Sample Phase 2's stage-runner.ts to see what prompt context it assembles for each stage; compare to Phase 3's

**Decision point:** if dispatch infra differs in tier/effort resolution OR systemPrompt construction OR MCP filter behavior, that's the bug. Document the specific delta.

### Step 4 — Check for unported helpers + lib (15 min)

- `find` Phase 2 `factory/lib/` and `factory/lib/common/` for any helper modules referenced by the stylesheet/screens skill bodies (grep skill body for `factory/lib`, `require`, `import`, helper names)
- Compare directory: does Phase 3 have the same `factory/lib/` tree? Anything missing?
- Check `scripts/` for stylesheet/screens-specific helpers that might be invoked by the skill bodies
- Check templates: do `.claude/templates/ui-kit-*` differ between Phase 2 and Phase 3?
- Check inspirations: did Phase 2 have an `inspirations/` directory at factory level with stock reference designs?

**Decision point:** if helpers / templates / inspirations are unported, that's the gap.

### Step 5 — Reproduce on Phase 2 to confirm the regression is real (15 min)

- Re-run `/stylesheet` and `/screens` on Phase 2's test-app FROM SCRATCH (delete docs/screens, packages/ui-kit, re-run)
- Confirm the rich output reproduces in Phase 2 a SECOND time (not a one-shot quality fluke)
- Inspect Phase 2's output structure — how many lines? what's in the home.html `<style>` block? what kit primitives were used? what custom CSS classes?

**Decision point:** if Phase 2's second run is also good, regression is real. If Phase 2's second run is also bad, then it was a one-shot Phase 2 luck and Phase 3 isn't actually worse — but that contradicts the operator's experience, so unlikely.

### Step 6 — Pinpoint the root cause + draft fix (20 min)

Based on Steps 1-5, identify the specific delta that explains the quality drop. Draft:

- Concrete fix (skill body edit, model-config tier change, MCP frontmatter addition, helper port, etc.)
- Expected impact (specific design elements that would now appear)
- How to verify the fix (re-run /stylesheet + /screens on test-app, compare to gulia reference)

If no single root cause emerges, document the top 2-3 most likely + recommend an experiment to discriminate between them.

## Findings

<!-- To be populated during execution. Document every comparison + finding, even dead ends. -->

## Recommendation

<!-- To be populated post-investigation. Likely one of:
- File a bug plan for a specific regression (e.g. plan-bug for "phase3 invoke-agent.ts strips ui-designer context that phase2 had")
- File a feature plan for a Phase-3-net-new improvement (e.g. plan-feature for "/stylesheet should read mockup HTML directly for fidelity")
- File an ADR-006 documenting the kit-only-vs-mockup-fidelity tradeoff
- Escalate to operator with structured options if the root cause is design-level rather than implementation-level
-->

## Attempt Log

<!-- Populated by the executing agent. -->

## Operator notes

- Operator (David Morgan) compared Phase 2 test-app output against Phase 3 test-app output for the SAME Hatch brief and reported the Phase 3 stylesheet and screens are materially worse.
- Earlier in the same Phase 3 session, operator flagged the stylesheet output as "different from the mockup"; the build-agent rationalized this away as "colors correct, just renamed" — which missed the deeper signal that the operator was comparing against an empirical Phase 2 baseline they had high confidence in. This investigation supersedes that earlier dismissal.
- Phase 2 test-app path: `C:\Development\ps\claude\claude_\agentflow_phase2\projects\test-app`
- Phase 3 test-app path: `C:\Development\ps\claude\claude_\agentflow_phase3\projects\test-app`
- Gulia reference (Phase 2-era quality baseline): `C:\Development\ps\claude\claude_\agentflow\agentflow_version2\agentflow\projects\gulia\outputs\screens\screen-01-home.html`
