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
attempt-count: 1
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

### Step 1 — Inputs inventory (P2 vs P3 test-app)

The "same project" framing in the question is materially false. Substantial input deltas:

| Surface                                       | P2 test-app                                                                                          | P3 test-app                                                                                                      | Delta                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `brief.md`                                    | 214 lines / 18,186 bytes                                                                             | 430 lines / 20,348 bytes                                                                                         | **2× the length; rewritten via /draft-brief**                 |
| `brief-summary.json` projectName              | "Hatch"                                                                                              | "Hatch — Studio Site"                                                                                            | n/a                                                           |
| screens.json screen count                     | 4                                                                                                    | 12                                                                                                               | **3× more screens to compose per /screens invocation**        |
| `docs/mockups/` style count                   | 1 (`style-0` "Editorial Hatch")                                                                      | 4 (`style-0…style-3`)                                                                                            | P3 ran multi-style gen                                        |
| `selected-style.json.styleId`                 | `style-0` (Editorial Hatch)                                                                          | `style-3` (Spark Studio)                                                                                         | n/a                                                           |
| `selected-style.json.selectedBy`              | `pick-style` (canonical flow)                                                                        | `operator-direct`                                                                                                | **P3 was operator-injected**                                  |
| `selected-style.json.provenance.source`       | absent                                                                                               | `agentflow_version2/projects/gulia/outputs/mockups/style-0.html`                                                 | **P3 mockup is an operator-captured rip of the gulia mockup** |
| Mockup home.html embedded `<style>` block     | 162 lines (modest)                                                                                   | 1,444 lines (heavy decoration — gulia-grade)                                                                     | **8.9× more custom CSS in P3 mockup**                         |
| Persona set                                   | founder-marketing-lead / in-house-brand-manager / creative-press-hire                                | marketing-director-maya / founder-felix / returning-client-riya                                                  | rewritten                                                     |
| Integrations list                             | static-site-host, headless-cms, bot-protection, transactional-email, analytics, monitoring           | cms, hosting, media-cdn, transactional-email, form-handler, analytics, monitoring, anti-spam, crm-webhook-target | rewritten                                                     |
| Compliance list                               | wcag-2.1-aa, https-only-transit, pii-confidential-handling, privacy-policy-cookie-notice-conditional | gdpr, uk-gdpr, pecr, wcag-2.1-aa                                                                                 | rewritten                                                     |
| `gate-1-approved.txt` / `gate-3-approved.txt` | present (file-flag gates)                                                                            | absent (P3 has `signoff-stylesheet-*.json` instead)                                                              | nomenclature change only                                      |
| analysis/shared/styles.md                     | 284 lines                                                                                            | 238 lines                                                                                                        | similar shape                                                 |
| analysis/webapp/screens.json                  | 144 lines                                                                                            | 327 lines                                                                                                        | scales with screen count                                      |

The clincher — **two excerpts from §2 "Visual Design Requirements" of each brief**:

- **P2 brief §2**: "Brand voice is confident, energetic, and creator-forward — 'ideas made real', 'bold', 'we hatch things'. Tone leans toward editorial-meets-agency: strong typography, generous whitespace, full-bleed imagery, motion that supports story without being decorative. The 'Hatch' name suggests an egg/emergence motif — usable as a subtle visual anchor (e.g., curved shapes, a hatching/cracking texture treatment)…"

- **P3 brief §2**: "Visual-production-heavy agency aesthetic: bold, story-driven, photo- and video-forward. The visual language is the proof of work — design must celebrate imagery rather than compete with it…" plus §1 directional principle: **"Prefer plain typographic confidence over agency tropes. No parallax hijacking, no cursor-follow gimmicks, no 'we're disruptive' copy."**

The P3 brief actively de-emphasizes the "agency-y" decoration that made gulia's output sing. P2 brief actively asks for it (egg/crack motif, full-bleed, motion-that-supports-story).

### Step 2 — Skill bodies + agent frontmatter

md5sums of the authored artefacts in `.claude/`:

| File                                            | P2 md5                             | P3 md5                             | Identical?                                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/stylesheet/SKILL.md`            | `6daf0b318aa85ee0e1e3a6eb8a199b82` | `6daf0b318aa85ee0e1e3a6eb8a199b82` | ✓ byte-identical                                                                                                                                                                                                                |
| `.claude/skills/stylesheet-primitives/SKILL.md` | `2f2add6d42ab0fcd300b7f1523714728` | `2f2add6d42ab0fcd300b7f1523714728` | ✓ byte-identical                                                                                                                                                                                                                |
| `.claude/agents/ui-designer.md`                 | `b4f0fc9dde7c8d1a054eabb333111160` | `b4f0fc9dde7c8d1a054eabb333111160` | ✓ byte-identical                                                                                                                                                                                                                |
| `.claude/skills/screens/SKILL.md`               | `63f92d…` (46,028 bytes)           | `b8d7d4…` (48,313 bytes)           | ✗ — differs by **only** the documented ADR-005 auto-run section (lines 589-613) appended to P3; the rest of the file is unchanged. Frontmatter, ui-designer agent ref, kit-only contract, kit-globals link rule — all identical |

**Decision-point hit**: "if skill bodies are byte-identical (modulo the ADR-005 auto-run addition) and ui-designer.md is byte-identical, the bug is NOT in the authored artifacts — pivot to dispatch infrastructure." → DISCONFIRMS H2; pivoting to dispatch.

### Step 3 — Dispatch infrastructure

md5sums of the orchestrator hot path:

| File                                   | P2 md5    | P3 md5    | Identical?       |
| -------------------------------------- | --------- | --------- | ---------------- |
| `orchestrator/src/invoke-agent.ts`     | `191664…` | `191664…` | ✓ byte-identical |
| `orchestrator/src/model-config.ts`     | `7a2f80…` | `7a2f80…` | ✓ byte-identical |
| `orchestrator/src/agent-mcp-config.ts` | `4a6aa2…` | `4a6aa2…` | ✓ byte-identical |
| `orchestrator/src/stage-runner.ts`     | `0ed62c…` | `0ed62c…` | ✓ byte-identical |
| `orchestrator/src/stages-array.ts`     | `2f1bd3…` | `986b7b…` | ✗ — differs      |

`stages-array.ts` diff is non-functional for design quality: P3 replaced the `z.unknown()` placeholder schema with the (still permissive) `MinimalStageOutput`, added `userInvokable: boolean` flags per ADR-005 for command-grouping, and updated/added comments. The stylesheet + screens stages keep the same `agent: "ui-designer"`, same `budgetUsd` (2 + 25), same `dependsOn`, same `gateType`. No prompt-assembly change.

`~/.claude/models.yaml` shows `ui-designer: { tier: building, effort: high }` → resolves to `claude-sonnet-4-6` with high effort in BOTH factories.

Project-level `.claude/models.yaml` differs only by a P3-side explanatory comment about the ADR-001-revised auth-provider reversion — no functional change for ui-designer dispatch.

**Decision-point hit**: dispatch infra is identical. **DISCONFIRMS H1 (excludeDynamicSections), H3 (MCP scope), H4 (model/effort).**

### Step 4 — Helpers + templates + inspirations

- `packages/`: both factories have only `orchestrator-contracts`. No helper-package drift.
- `scripts/`: P3 has slightly MORE scripts (`_flip-passes.mjs`, `_waive-polished.mjs`), no P2-only scripts are missing.
- `.claude/templates/`: equivalent (P3 added 3 `project-*.template` files; no P2-only template lost). Both have `ui-kit-contract.md`, `ui-kit-eslint-plugin`, `mockups-index-template.html`, `user-flows-template.html`, `playwright-global-setup.ts.template`.
- Skill-body external-helper references: skills/stylesheet/SKILL.md + skills/screens/SKILL.md only reference OUTPUT paths (e.g. `packages/ui-kit/UI-KIT.md`, `scripts/validate-consumer.ts` to be authored) — no inbound factory-side helper that would be load-bearing at run-time.
- No `inspirations/` directory exists at factory level in either factory.

**DISCONFIRMS H5 (asset/inspirations regression).** No port gap.

### Step 5 — Output structure (no re-run; static comparison)

Direct line counts:

| Artefact                                         | gulia (ref baseline)                  | P2 test-app                                 | P3 test-app                                              |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Mockup home.html (selected style)                | 2,035 lines (mockup style-0 in gulia) | 1,288 lines (`style-0`, fresh /mockups gen) | **2,353 lines** (`style-3`, operator-captured gulia rip) |
| Screens home.html (output of /screens)           | 1,507 lines                           | **1,616 lines**                             | **771 lines**                                            |
| design-system-preview.html (stylesheet output)   | —                                     | 2,910 lines                                 | 2,368 lines                                              |
| tokens.css                                       | —                                     | 231 lines                                   | 190 lines                                                |
| globals.css                                      | —                                     | 160 lines                                   | 141 lines                                                |
| design-system-preview.html `<svg>` count         | —                                     | 24                                          | 25                                                       |
| design-system-preview.html section/details count | —                                     | 11                                          | 12                                                       |

The stylesheet stage works correctly in both factories. P3 accent `#ff5c35` derives directly from the gulia mockup's `--primary: #ff5c35` value; P2 accent `#ff5b2e` derives from its own mockup's accent. /stylesheet is NOT the regression site.

The regression is concentrated in /screens. Detail:

| Home.html metric                                | P2 output                                                                                                                         | P3 output                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Total lines                                     | 1,616                                                                                                                             | 771 (47% of P2)                                                                                                          |
| Inline `<style>` block lines                    | **30** (preserves marquee animation + hero-grain noise overlay)                                                                   | **0** (no `<style>` block at all)                                                                                        |
| Inline `<style>` blocks present                 | 1                                                                                                                                 | 0                                                                                                                        |
| `<svg>` count                                   | 28                                                                                                                                | 11                                                                                                                       |
| `<img>` count                                   | 7                                                                                                                                 | 5                                                                                                                        |
| `<section>` count                               | 6                                                                                                                                 | 5                                                                                                                        |
| `data-kit-*` attributes (kit primitive markers) | 59                                                                                                                                | 51                                                                                                                       |
| Hero treatment                                  | full-bleed h-[100vh] photo + grain overlay + 88px display heading + "Studio open · Brooklyn / Lisbon" mono badge + italic "Real." | 4:5 aspect ratio video-thumbnail card on right side + standard 5xl heading + "Editorial · 47 projects · est. 2003" badge |
| Marquee section                                 | yes ("Selected partners 2024-2026" with "Meridian Outfitters / Leyla Sarno Film")                                                 | absent                                                                                                                   |
| Custom CSS animations                           | marquee-scroll keyframes + hero-grain after-pseudo + grain SVG noise mask preserved                                               | none — only Tailwind utilities                                                                                           |

P3's mockup-stage `<style>` block (the source) carried **1,444 lines** of decoration: `--primary` token, custom nav with `backdrop-filter: blur(16px)`, `.hatch-crack` skewed-line motif, `.hero-fade` gradient overlay, `.btn-primary` lift-on-hover transform, scroll-cued reveal classes, the lot. The /screens compositor stripped **all** of it (output has 0 `<style>` blocks).

P2's mockup-stage `<style>` block had only **162 lines** of modest decoration. The /screens compositor PRESERVED a 30-line subset (the marquee + grain effect) and dropped the rest. The mockup-to-screen line-count went UP (1,288 → 1,616), because the compositor added kit-primitive markup that didn't exist in the mockup.

**Conclusion**: the /screens compositor applied the SAME "kit-only via Tailwind utilities + minimal custom `<style>`" doctrine in both runs. The doctrine has high preservation when the source mockup is already kit-shaped (P2 case). The doctrine has high stripping when the source mockup carries gulia-grade custom CSS that doesn't translate to kit primitives (P3 case).

### Hypothesis disposition

| H                                                         | Verdict                                                                                                                                                                                                                                                       | Reason                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 — Dispatch context regression (excludeDynamicSections) | **DISCONFIRMED**                                                                                                                                                                                                                                              | `invoke-agent.ts` byte-identical between P2 + P3                                                                                                                                                                                                                                                                                  |
| H2 — Skill body dependency on a Phase-2-only helper       | **DISCONFIRMED**                                                                                                                                                                                                                                              | Skill bodies + ui-designer agent byte-identical; only delta is the documented ADR-005 auto-run section in screens, which is post-stage chaining, not the body of design work                                                                                                                                                      |
| H3 — MCP scope regression                                 | **DISCONFIRMED**                                                                                                                                                                                                                                              | `agent-mcp-config.ts` byte-identical                                                                                                                                                                                                                                                                                              |
| H4 — Model/effort regression                              | **DISCONFIRMED**                                                                                                                                                                                                                                              | `model-config.ts` byte-identical; system + project YAMLs both resolve ui-designer to `claude-sonnet-4-6` tier:building effort:high                                                                                                                                                                                                |
| H5 — Asset / inspirations regression                      | **DISCONFIRMED**                                                                                                                                                                                                                                              | No `inspirations/` directory in either factory; analysis/shared/inspirations.md present in both projects (P2 176 lines, P3 106 lines — P3 is THINNER but not the dispatch surface)                                                                                                                                                |
| H6 — Stylesheet kit-only contract tightened               | **PARTIALLY CONFIRMED** as MECHANISM, not as a Phase-3 regression. Same kit-only doctrine applies in both factories. The doctrine is what strips the custom decoration; what changed between P2 + P3 is the source-material density, not the doctrine itself. |
| H7 — Pipeline-mode vs manual-mode dispatch                | **DISCONFIRMED**                                                                                                                                                                                                                                              | Both projects were re-run today (Phase 2 17:09-18:14 UTC, Phase 3 15:30-16:10 UTC) via the same Claude Code `/stylesheet` + `/screens` Skill-tool path. Same model in the same session pattern. Phase 2 has `gate-N-approved.txt` files (operator drops as gate signoff) but those are post-stage flags, not dispatch-time inputs |
| H8 — Inputs delta                                         | **PRIMARY CAUSE — STRONGLY CONFIRMED**                                                                                                                                                                                                                        | Brief, persona set, integrations list, compliance list, screen count, mockup selection, mockup decoration density all differ materially. The brief differences include explicit "no agency tropes / plain typographic confidence / no parallax hijacking" clauses in P3 that are absent from P2                                   |

### Root cause synthesis

The regression is **multi-causal**, with H8 as the dominant driver and H6 as the mechanism that translates H8 into the observed quality drop. Specifically:

1. **(Dominant) P3 brief actively de-emphasizes the agency-y visual language P2 brief celebrated.** /draft-brief (the new P3 brief-authoring skill) produced a brief whose §1 directional principles include "Prefer plain typographic confidence over agency tropes. No parallax hijacking, no cursor-follow gimmicks, no 'we're disruptive' copy." The ui-designer correctly read those instructions and self-restrained — producing flat, restrained, kit-utility-shaped output. The agent's behavior is downstream-compliant with the brief; the brief is upstream-misaligned with operator intent. **This is a /draft-brief over-tightening, not a ui-designer regression.**

2. **(Compounding) Operator-injected gulia mockup carries fidelity intent that the /screens skill has no doctrine to honor.** The P3 selected-style provenance explicitly says: _"Operator-elected direction-4 drop. Prior project produced a high-quality Hatch design; manually captured into test-app and selected at Gate 2. The cross-project design-library mechanism that would surface this automatically does not yet exist in the rebuild."_ The operator's intent in injecting the gulia mockup was: "use this as the fidelity baseline." The /screens skill's intent is: "compose from kit primitives via Tailwind utilities; keep custom `<style>` minimal." These conflict, and the skill has no rule that recognizes the operator-pinned mockup as a fidelity baseline override. Result: 1,444 lines of gulia decoration in the mockup is stripped to 0 lines in the screen.

3. **(Compounding) Screen-count scaling.** P3 generated 12 screens in one /screens dispatch vs P2's 4. Same per-stage budget (25 USD) and same context-window budget means each P3 screen has ~⅓ the per-screen depth.

4. **(Not causal) /stylesheet is fine.** Tokens flow correctly from the selected mockup into the kit (gulia `--primary: #ff5c35` → kit `--color-accent-500: #ff5c35`). design-system-preview.html sizes are comparable (P3 2,368 lines vs P2 2,910 lines — within normal variance; both have ~25 svg + 12 sections of richness). The operator's complaint that "stylesheet is also worse" is partially a knock-on from the brief restraint clauses (palette intentionally restrained per brief §2 "Color: restrained palette — neutrals plus one accent. Photography provides color.").

### What this is NOT

- NOT a Phase-3 dispatch infrastructure regression (every dispatch file is byte-identical; this was the strongest a-priori hypothesis and it falsifies cleanly).
- NOT a Phase-3 skill-body regression (skill bodies + ui-designer agent are byte-identical modulo the auto-run chain documented elsewhere).
- NOT a port gap (no helpers, templates, or scripts are missing from Phase 3).
- NOT a single-bug class — fixing it requires changing inputs (brief authoring) AND/OR doctrine (mockup-fidelity preservation in /screens), not patching a regression site.

## Recommendation

Escalate to operator with structured options. Three independent levers exist; the right next step depends on which lever the operator wants to pull (or all three).

**Option A — File `plan-feature` for "/screens mockup-fidelity preservation".** Extend the screens skill so when the selected mockup contains a custom `<style>` block over a size threshold (e.g. >200 lines) AND/OR `selected-style.json.selectedBy === "operator-direct"`, the compositor PRESERVES the mockup's `<style>` block verbatim alongside the kit globals, and uses class-based composition that references the mockup's custom selectors. Concrete edit: skills/screens/SKILL.md §"Kit-only contract" → add an "operator-pinned mockup override" carve-out section. Expected impact: P3 home.html would carry forward the gulia marquee + nav-blur + crack-motif + hero-fade decoration the operator was trying to inject.

**Option B — File `plan-bug` for "/draft-brief over-restrains visual ambition for portfolio/agency briefs".** /draft-brief currently emits "no parallax hijacking, no cursor-follow gimmicks, no 'we're disruptive' copy" as boilerplate restraint language in the Visual Design Requirements section. For portfolio/agency briefs where the SITE IS THE PORTFOLIO PIECE, this restraint actively works against the brief's own purpose. Concrete edit: skills/draft-brief/SKILL.md → add a brief-class detector ("is the project's primary value proposition the site's visual quality?") and suppress the restraint clauses when true. Expected impact: future briefs for agency/portfolio/studio projects would not pre-strip the agency-y decoration.

**Option C — File `ADR-006` documenting the kit-only-vs-mockup-fidelity tradeoff.** Even without a code change, document the doctrine: "/screens uses kit primitives + Tailwind utilities + minimal custom `<style>`. When a mockup carries heavy custom CSS, expect it to be flattened; the kit is the source of truth, not the mockup." Then add a `selectedBy: "operator-direct"` carve-out as a P3+ improvement. Expected impact: operator knows what to expect from operator-direct selection; can either (a) pre-extract the mockup's custom decoration into kit-globals before /screens runs, or (b) wait for Option A to land.

Suggested order of operations:

1. Operator confirms the diagnosis matches their experience (the brief delta is the dominant cause, not a dispatch regression).
2. If confirmed → pursue Option A (highest-leverage; addresses both the immediate gulia-injection case AND any future operator-pinned high-quality mockup).
3. Option B + C are independent and can land in parallel; both are smaller scopes.

The `polished:false` outcome of this investigation: **a single-row code patch is not the right next step.** The regression is the emergent behavior of an upgraded brief-authoring skill (/draft-brief) intersecting with a kit-only screens-compositor doctrine that was authored before /draft-brief existed. Both are correct in isolation; the interaction is what the operator sees.

## Attempt Log

### Attempt 1 — 2026-05-28

Investigator: Claude (Phase 3 build session)
Wall-clock: ~60 min of the 90-min time-box
Outcome: **resolved-no-code-fix-required**; structured findings + 3-option recommendation populated above

Investigation walk:

- Step 1 (inputs inventory): identified large brief delta (214 → 430 lines; persona / integration / compliance sets all rewritten) + screen-count delta (4 → 12) + mockup provenance delta (P3 is operator-captured gulia rip, P2 is fresh /mockups gen)
- Step 2 (skill body diff): md5-confirmed stylesheet + stylesheet-primitives + ui-designer byte-identical; screens differs only by documented ADR-005 auto-run section. Decision-point routed to Step 3 (pivot to dispatch infra)
- Step 3 (dispatch diff): md5-confirmed invoke-agent.ts + model-config.ts + agent-mcp-config.ts + stage-runner.ts byte-identical; stages-array.ts differs but non-functionally for ui-designer dispatch. DISCONFIRMS H1/H3/H4/H7
- Step 4 (helpers + templates): no port gap; P3 has equal or more scripts/templates than P2. DISCONFIRMS H5
- Step 5 (output structure): home.html structural counts — P2 preserved 30 lines of `<style>` (marquee + grain) from a 162-line mockup; P3 stripped ALL 1,444 lines of `<style>` (gulia decoration) to 0 lines. /screens compositor applied same kit-only doctrine in both; doctrine bites harder when mockup is decoration-heavy
- Step 6 (root cause): multi-causal — primary driver is brief-content delta (P3 brief actively de-emphasizes agency-y decoration); compounding driver is mockup-fidelity-vs-kit-only tradeoff with no operator-direct override doctrine; compounding driver is screen-count scaling (3× more screens per dispatch). NOT a dispatch regression; NOT a port gap; NOT a single-bug class

No code edits were made during this investigation — read-only static comparison only.

## Operator notes

- Operator (David Morgan) compared Phase 2 test-app output against Phase 3 test-app output for the SAME Hatch brief and reported the Phase 3 stylesheet and screens are materially worse.
- Earlier in the same Phase 3 session, operator flagged the stylesheet output as "different from the mockup"; the build-agent rationalized this away as "colors correct, just renamed" — which missed the deeper signal that the operator was comparing against an empirical Phase 2 baseline they had high confidence in. This investigation supersedes that earlier dismissal.
- Phase 2 test-app path: `C:\Development\ps\claude\claude_\agentflow_phase2\projects\test-app`
- Phase 3 test-app path: `C:\Development\ps\claude\claude_\agentflow_phase3\projects\test-app`
- Gulia reference (Phase 2-era quality baseline): `C:\Development\ps\claude\claude_\agentflow\agentflow_version2\agentflow\projects\gulia\outputs\screens\screen-01-home.html`
