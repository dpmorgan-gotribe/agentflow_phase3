# Rebuild Agentflow — Feature Planning Prompt

You are planning a full rebuild of Agentflow onto a new harness pattern. Your **only deliverable** is a populated `feature_list.json` that drives the rebuild end-to-end. Do not implement anything in this run.

## Inputs (read in this order)

1. **Harness template (canonical scaffold)** — `C:\Development\ps\claude\claude_\agentmark\scaffolding\phase-0-harness`
2. **Phase plan format reference** — `C:\Development\ps\claude\claude_\agentmark\phase-plan.md`
3. **Feature list format reference** — `C:\Development\ps\claude\claude_\agentmark\feature_list.json` (match this schema exactly)
4. **Inventory source — entire Phase 2 codebase** — `C:\Development\ps\claude\claude_\agentflow_phase2`
   Walk the full tree. Capture every meaningful capability, including ones that were started but unfinished. Pay particular attention to:
   - `.claude/agents/` — all 16 subagents
   - `.claude/skills/` — workflow skills and stack-skill packs
   - `.claude/hooks/` and `.claude/rules/` — guardrails and policies
   - `orchestrator/src/` — every module, especially `budget-tracker`, `model-config`, `auth-provider`, `tester-diff-audit`, `pre-verify-discriminators`, `cluster-bugs`, `protected-files`, `pause`, `dev-server`, `fix-bugs-loop`, `build-to-spec-verify`, `perceptual-review`, `walkthrough-review`, `parity-verify`, `audit-pixel-diff`, `gate-server-lifecycle`, `feature-graph`, `stages-array`
   - `packages/`, `scaffolding/`, `schemas/`
5. **Research overlay (pragmatic adoption only)** — `C:\Development\ps\claude\claude_\agentflow_phase3\RESEARCH.md`
   Pull in only what integrates cleanly with the harness and has outsized impact. Skip anything that adds complexity for marginal gain.

## Phase structure

Every feature lands in exactly one phase:

- **Phase 0 — Factory.** The factory itself: subagent system prompts, skill packs, learning-agent / agent-expert mechanisms, project creation, shared infrastructure (model config, auth, budget tracking, hooks, rules, schemas, protected-files, pause/resume).
- **Phase 1 — Design pipeline.** Mode A sequential stages: analyze, skills-audit-design, mockups, stylesheet, stylesheet-primitives, screens, visual-review, user-flows, architect, pm, skills-audit-build, register-mcp-build, git-agent-bootstrap. HITL gates included.
- **Phase 2 — End-to-end build.** Mode B parallel feature-graph build: `tasks.yaml` v2, worktree orchestration, `agent_sequence` walking, builder/security/tester/reviewer dispatch, `close-feature` merging, pause/resume state, optional pr-review gate.
- **Phase 3 — Verify + bug fix.** `/build-to-spec-verify` 5-tier verifier (build-sanity, reachability, synth-flows, parity, perceptual+walkthrough), bug filing to `docs/bugs.yaml`, fix-bugs loop with `bug-fixer` + `systemic-fixer`, `cluster-bugs`, `pre-verify-discriminators`, `protected-files` rollback, `tester-diff-audit`.

## Human-inspection gates

After every feature-block that ends in an interactive boundary, append a feature-task whose owner is the human operator. The task is: _"manually exercise this step, inspect outputs, confirm expectations met."_ Interactive boundaries include — but are not limited to — create-new-project, analyze, stylesheet, mockups, screens, architect, pm, start-build, and each verifier-tier completion. Identify any others you find in the codebase.

## Methodology — execute these passes in order

**Pass 1 — Format study.** Read inputs 1–3. Internalize the harness shape and feature_list schema. Write nothing yet.

**Pass 2 — Inventory.** Walk input 4 exhaustively. Produce a flat checklist of every distinct capability, grouped by source path. Mark unfinished items explicitly. Do not write `feature_list.json` yet.

**Pass 3 — Factory/project boundary review.** For each inventoried capability, decide: **factory-only**, **project-only**, or **both**. Anything not load-bearing for generated projects stays factory-only. This is the single most important filter — get it right before drafting.

**Pass 4 — Phase assignment + drafting.** Write `feature_list.json`. Assign each capability to Phase 0/1/2/3 per the structure above. Insert each human-inspection task immediately after the preceding build task. Schema must match input 3 exactly.

**Pass 5 — Research overlay.** Read input 5. For each recommendation: **adopt / defer / skip** with a one-line reason. Adopt only items that integrate cleanly and have outsized impact. Add adopted items as feature-tasks in the right phase.

**Pass 6 — Completeness check.** Re-read input 4 with `feature_list.json` open. For every file/module, confirm at least one feature-task covers it. Add anything missing.

**Pass 7 — Second completeness check.** Re-walk `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`, and `orchestrator/src/` once more. The bar: a reader of `feature_list.json` alone could reproduce the factory's full capability set without consulting Phase 2.

**Pass 8 — Tighten.** Remove duplication. Verify every feature-task has a single owner, a clear deliverable, and an acceptance check. Verify every interactive boundary has its paired human-inspection task. Verify phase ordering is consistent — no earlier-phase task depends on a later-phase capability.

## Output

A single file at the working directory root: `feature_list.json`. Schema matches input 3. Phases ordered 0 → 1 → 2 → 3; feature-tasks within each phase ordered by dependency; human-inspection tasks are first-class entries.

After writing the file, print a short summary:

- Total feature-task count per phase.
- List of items adopted from `RESEARCH.md` and items deferred/skipped with one-line reasons.
- Any open questions that blocked a decision.

## Out of scope for this run

- Do not implement any feature.
- Do not modify Phase 2 — read-only.
- Do not author subagent system prompts. Reference what they do; the prompts come during execution.
