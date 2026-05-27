# PROGRESS.md — Session handoff log (append-only)

> Append a new dated section at the bottom each session. Latest at the bottom; reverse-chronological reading is a foot-gun.

---

## 2026-05-27 — Phase 0 kickoff

- **Goal:** rebuild agentflow Phase 2 onto a harness baseline (ported from agentmark) with sync-phase-plan + evidence-gated discipline + RESEARCH.md adopts.
- **Rows seeded:** 134 in `feature_list.json` (Phase 0: 61, Phase 1: 26, Phase 2: 22, Phase 3: 25).
- **Reference docs in this dir:** `agentflow_rebuild_prompt.md` (the prompt that scoped this work), `RESEARCH.md` (overlay), `inventory-scratch.md` (Phase 2 walk).
- **Open items:** ANTHROPIC_API_KEY not set in current shell; Claude Code session auth covers harness build, but orchestrator runs will need it.

## 2026-05-27 — Harness baseline shipped (rows 001-015 + 029)

- **Done:** 16 rows flipped to passes:true. Commit `[master]` baseline + cleanup. See `evidence/phase0-step-{001..015,029}-result.txt`.
- **Inventory of shipped:**
  - 6 root artifacts (CLAUDE.md, PROGRESS.md, phase-plan.md, LESSONS.md, DECISIONS.md w/ ADR-000/001/002, feature_list.json)
  - Folder skeleton (.claude/{agents,skills,hooks,rules,templates,state}/, schemas/, scaffolding/, packages/, scripts/, orchestrator/{src,tests,scripts}/, evidence/, contracts/, contexts/, investigations/, reports/, projects/, docs/)
  - `.claude/settings.json` wiring 4 PreToolUse + 2 PostToolUse + Stop + SessionStart hooks
  - 7 hooks: block-dangerous.sh, enforce-boundaries.sh, detect-loop.mjs, validate-brief.mjs (ported) + verify-gate.mjs, track-read.mjs, commit-on-stop.mjs (net-new)
  - 2 subagents: evaluator + retro (ported from agentmark scaffolding)
  - 11 skills: 6 Phase 2 ports (check-existing-work, plan-bug/feature/investigation, save-context, load-context-chain) + 5 harness-new (capture-lesson, consult-lessons, phase-gate, polish-pass, sync-phase-plan)
  - scripts/_flip-passes.mjs (internal helper)
- **Verifications run:** verify-gate selftest PASS; block-dangerous probes (rm -rf / blocked, force-with-lease allowed); syntax-check on all .mjs hooks
- **STOP GATE: phase0-step-016 (HUMAN — harness baseline smoke test).** Operator runs 5-step smoke + signs off in `evidence/phase0-step-016-result.txt`.
- **Next after smoke:** phase0-step-017 (auth-provider.ts) → rest of orchestrator shared infra → project lifecycle skills → second HUMAN gate at phase0-step-027 (new-project inspection).

