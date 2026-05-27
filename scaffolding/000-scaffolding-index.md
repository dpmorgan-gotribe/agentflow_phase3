# Scaffolding Index — Multi-Agent App Generation System

> **Refactor-003 (2026-04-20)** reordered the pipeline so the architect (020) and PM (021) run AFTER design sign-off, not before. 020 moved from tier 5 to tier 6.5; 021 followed. 026 + 027 (monorepo + shared packages) moved from tier 7 to "invoked from /new-project step 5b" at project-bootstrap time. 038 skills-agent split into design + build scopes. Gate 5 (credentials, file-drop) added between architect and PM. Blueprint Appendix C records the decision; 035's `STAGES` array is the canonical pipeline order.
>
> **File-naming (2026-04-20):** pending scaffolding tasks are prefixed `NN-` where `NN` is build order (01–26). The original task-id (020, 022, 022b, 025b, etc.) is preserved inside the filename as the canonical reference — `depends-on` arrays, blueprint cross-refs, and plan records continue to use task-id strings verbatim. `ls scaffolding/` now sorts in implementation order.

## Build Philosophy

- Each task is a self-contained unit you can understand completely
- No task moves to "in progress" until the previous is signed off
- Human verifies every task before the next begins
- We build the **work management system first**, then use it to manage the rest

## Priority Tiers

### Tier 1: Work Management Foundation (Tasks 001-006)

_Build the system that manages work — so we can use it to manage building everything else._

- [001 — Project skeleton & CLAUDE.md](archive/001-project-skeleton.md) ✓ complete
- [002 — Plan file templates & directory structure](archive/002-plan-templates.md) ✓ complete
- [003 — /plan-bug skill](archive/003-plan-bug-skill.md) ✓ complete
- [004 — /plan-feature skill](archive/004-plan-feature-skill.md) ✓ complete
- [005 — /check-existing-work skill](archive/005-check-existing-work.md) ✓ complete
- [006 — /plan-status, /plan-archive, /plan-search, /plan-refactor, /plan-investigation skills](archive/006-plan-lifecycle-skills.md) ✓ complete

### Tier 2: Safety & Guardrails (Tasks 007-010)

_Before agents write code, ensure they can't break things._

- [007 — block-dangerous.sh hook](archive/007-block-dangerous-hook.md) ✓ complete
- [008 — enforce-boundaries.sh hook](archive/008-enforce-boundaries-hook.md) ✓ complete
- [009 — Loop detection hook](archive/009-loop-detection-hook.md) ✓ complete
- [010 — Justfile safe command wrapper](archive/010-justfile.md) ✓ complete

### Tier 3: Configuration & Context (Tasks 011-014)

_Model config, context preservation, settings.json wiring._

- [011 — Model configuration system (models.yaml)](archive/011-model-config.md) ✓ complete
- [012 — settings.json with hook wiring](archive/012-settings-json.md) ✓ complete
- [013 — /save-context skill](archive/013-save-context-skill.md) ✓ complete
- [014 — /load-context-chain skill](archive/014-load-context-chain-skill.md) ✓ complete

### Tier 4: Brief System (Tasks 015-019 + monorepo bootstrap)

_The canonical input that drives everything + project-bootstrap scaffolding that /new-project step 5b invokes at init time (refactor-003)._

- [015 — Brief schema & frontmatter validation](archive/015-brief-schema.md) ✓ complete
- [016 — Brief template (20-section structure)](archive/016-brief-template.md) ✓ complete
- [017 — /validate-brief skill](archive/017-validate-brief-skill.md) ✓ complete
- [018 — /scan-assets skill (asset scanner)](archive/018-scan-assets-skill.md) ✓ complete
- [018b — /new-project skill (bootstrap projects/<name>/ + step 5b monorepo scaffold + design-MCPs — refactor-003)](archive/018b-new-project-skill.md) ✓ complete
- [018c — /draft-brief skill (proposal → filled-in brief.md)](archive/018c-draft-brief-skill.md) ✓ complete
- [019 — Analyst agent + /analyze skill](archive/019-analyst-agent.md) ✓ complete

---

## Pending tasks — in implementation order

Tasks below are in the exact order they should be built. Filenames prefixed `NN-` sort `ls scaffolding/` the same way. Task-id (e.g. `022`, `025b`, `020`) preserved inside the filename for cross-reference continuity.

### Phase A — Design pipeline (tier 6; refactor-001 scope, refactor-003 unchanged)

_From analyst outputs to mockup grid → UI Kit → composed screens → visual review → sign-off. Framework-agnostic HTML + CSS + CVA. Tests directly against `projects/mindapp/` and `projects/gotribe-v1/` analyst outputs as each skill lands._

- [01 / 022 — UI Designer agent definition (opinionated identity + anti-slop + named-references library)](archive/01-022-ui-designer-agent.md) ✓ complete
- [02 / 022b — UI Kit consumption contract (ESLint plugin + validate-consumer + CONTRACT.md template)](archive/02-022b-ui-kit-contract.md) ✓ complete
- [03 / 023 — /mockups skill (N styles × M apps style-selection grid)](archive/03-023-mockups-skill.md) ✓ complete
- [04 / 024 — /stylesheet skill (UI Kit assembly: tokens + primitives + patterns + layouts + Storybook)](archive/04-024-stylesheet-skill.md) ✓ complete
- [05 / 025 — /screens skill + /user-flows-generator (kit-only composition + single-screen retry mode)](archive/05-025-screens-skill.md) ✓ complete
- [06 / 025b — /visual-review skill (Layer 7 — LLM visual critique loop)](archive/06-025b-visual-review-skill.md) ✓ complete

### Phase B — Post-design planning (tier 6.5; refactor-003)

_Architect decides vendors + emits .env.example after design sign-off. PM decomposes to tasks.yaml using concrete architecture decisions. Gate 5 (credentials file-drop) sits between them._

- [07 / 020 — Architect agent + architecture.yaml + .env.example + credentials/deployment checklists](archive/07-020-architect-agent.md) ✓ complete (feat-005)
- [08 / 021 — Project Manager agent + tasks.yaml (dual-mode: --mode=tasks main / --mode=kit-change-request detour)](archive/08-021-pm-agent.md) ✓ complete (feat-006)

### Phase C — Contracts + foundational infrastructure

_Zod schemas + output-contract enforcement + MCP registration + monorepo scaffolds that Phase D builders consume. 034b before 035 (orchestrator imports StageSchemas). 026+027 are specs for the logic `/new-project` step 5b already invokes at init time._

- [09 / 034b — Output contract Zod schemas (`StageSchemas` lookup for all 17 stages)](archive/09-034b-output-contract-zod-schemas.md) ✓ complete (task-035 Phase 2 + feat-005/006/008/009 extensions; 121 contract tests)
- [10 / 034 — Output contract enforcement (6 layers — prompt / file / Zod / hook / retry / verifier)](10-034-output-contracts.md) _partial — Zod + validate-\*.mjs runners shipped; hook + retry enforcement shipped via orchestrator (task-035); full 6-layer audit pending_
- [11 / 041 — MCP server registration (`/register-mcp-servers --scope=design|build`; dual-invocation per refactor-003)](archive/11-041-mcp-server-registration.md) ✓ complete (task-011)
- [12 / 026 — Turborepo + pnpm workspace scaffold (invoked from /new-project step 5b)](12-026-turborepo-scaffold.md)
- [13 / 027 — Shared packages skeleton — `@repo/{ui-kit, types, utils, api-client, orchestrator-contracts}` (invoked from /new-project step 5b)](13-027-shared-packages.md)

### Phase D — Build pipeline (tier 7)

_Builder agents consuming architecture.yaml + `.env` (populated at gate 5) + UI Kit + composed screens._

- [14 / 028 — Backend Builder agent (NestJS + tRPC + Drizzle)](archive/14-028-backend-builder-agent.md) ✓ complete (feat-008)
- [15 / 029 — Web Frontend Builder agent (Next.js)](archive/15-029-web-frontend-builder.md) ✓ complete (feat-008)
- [16 / 030 — Mobile Frontend Builder agent (Expo)](archive/16-030-mobile-frontend-builder.md) ✓ complete (feat-008)

### Phase E — Quality + ship (tier 8)

_Testing, review, git, HTML verification._

- [17 / 031 — Tester agent](archive/17-031-tester-agent.md) ✓ complete (feat-009)
- [18 / 032 — Reviewer agent + output contract hooks](archive/18-032-reviewer-agent.md) ✓ complete (refactor-005 spec-refresh + feat-010 implementation)
- [19 / 032b — HTML Verifier agent (Layer 6 defense-in-depth)](19-032b-html-verifier-agent.md)
- [20 / 033 — Git Agent](archive/20-033-git-agent.md) ✓ complete (feat-007)

### Phase F — Orchestrator (tier 9)

_The external TypeScript orchestrator + HITL gate mechanics that tie stages together for autonomous runs._

- [21 / 035 — Orchestrator core (stage runner + SDK integration + kit-change-request detour)](archive/21-035-orchestrator-core.md) ✓ complete (task-035)
- [22 / 036 — HITL gates (6 gates — 5 classic + pr-review/gate-6) — MVP file-drop shipped; HTTP UI deferred](archive/22-036-hitl-gates.md) ✓ shipped 2026-04-23 via plans/task-036-hitl-gates-server.md

### Phase G — Meta & compliance (tier 10)

_Self-improvement loop, skills-audit split, App Store readiness, meta-agent._

- [23 / 038 — Skills Agent (dual-scope: `--scope=design` runs pre-mockups, `--scope=build` runs post-architect)](archive/23-038-skills-agent.md) ✓ complete (task-011)
- [24 / 037 — Lessons Agent](24-037-lessons-agent.md)
- [25 / 040 — App Store compliance layer](25-040-app-store-compliance.md) _post-MVP per roadmap_
- [26 / 039 — Agent Expert (meta-agent for authoring + editing other agents)](26-039-agent-expert.md) _post-MVP per roadmap_

---

## Sign-off Protocol

After each task:

1. Builder completes the task and self-verifies
2. Human reviews the output files
3. Human signs off: `APPROVED` or `REVISE: [feedback]`
4. Only then does the next task begin

## Testing protocol (integration beds)

Treat `projects/mindapp/` (5-style useAssets=false; mobile + webapp) and `projects/gotribe-v1/` (3-style useAssets=true; webapp + mobile + admin) as live integration test beds. Any stage that breaks on either gets a `plan-bug`. Any stage that works should round-trip on both before marking the scaffolding task complete.
