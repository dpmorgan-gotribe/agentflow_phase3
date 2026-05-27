# phase-plan.md — the canonical rebuild manifest

> **This is a living document.** It evolves with shipped reality via `/sync-phase-plan` (phase0-step-014).
> If you rebuilt the system from this doc alone (starting from a clean repo at `phase-N-start`),
> you should arrive at the currently-shipped system — same modules, same wiring, same hooks, same
> rules. Drift between this doc and the code is what causes the 200-bugs-of-rediscovery problem
> that Phase 2 hit.
>
> The frozen kickoff snapshot of any phase is `git show phase-N-start:phase-plan.md`.
> The working copy is always the source of truth.
>
> Source of truth for capability scope: `feature_list.json` (134 rows). This doc encodes the *why*
> behind those rows + the architectural decisions they implement.

---

# Phase 0 — Build the factory

## Goal

Produce a working agentic factory in `.claude/` plus orchestrator/, packages/, schemas/, scaffolding/,
scripts/, 6 root artifacts. Factory is capable of running `/new-project` end-to-end and dispatching
all 16+ subagents through Mode A and Mode B pipelines.

## Definition of done

- All Phase 0 rows in `feature_list.json` (phase0-step-001 through phase0-step-061) have `passes: true` with evidence
- `phase0-step-048` HUMAN closure signed off
- `git tag phase-0-done`

## Scope sections (filled by /sync-phase-plan as rows close)

### §0a Harness baseline (rows 001-016)

[to be filled by /sync-phase-plan after rows land]

### §0b Shared orchestrator infra (rows 017-025)

[to be filled]

### §0c Project lifecycle skills (rows 026-029)

[to be filled]

### §0d Schemas + contracts + templates (rows 030-034)

[to be filled]

### §0e Subagents (rows 035-042)

[to be filled]

### §0f Stack skills + analyzer subscopes (rows 043-046)

[to be filled]

### §0g Scaffolding docs (row 047)

[to be filled]

### §0h Phase 0 closure (row 048)

[to be filled]

### §0i RESEARCH adopts + factory-root scaffolds + post-MVP adopts (rows 049-061)

[to be filled]

---

# Phase 1 — Design pipeline (Mode A)

## Goal

13-stage sequential design pipeline with 5 HITL gates, kit-change-request detour, visual-review retry.

## Definition of done

- All Phase 1 rows in `feature_list.json` (phase1-step-001 through phase1-step-026) `passes: true` with evidence
- `phase1-step-026` HUMAN closure signed off
- `git tag phase-1-done`

[Scope sections filled by /sync-phase-plan]

---

# Phase 2 — Build orchestration (Mode B)

## Goal

Parallel feature-graph executor with per-feature worktree, agent_sequence dispatch, protected-files rollback,
pause/resume, optional PR-review gate, partial-failure-policy.

## Definition of done

- All Phase 2 rows (phase2-step-001 through phase2-step-022) `passes: true` with evidence
- `phase2-step-020` HUMAN closure signed off
- `git tag phase-2-done`

[Scope sections filled by /sync-phase-plan]

---

# Phase 3 — Verify + bugfix

## Goal

5-tier verifier (build-sanity → reachability → synth-flows → parity → perceptual+walkthrough),
bug filing to docs/bugs.yaml, fix-bugs loop with bug-fixer + systemic-fixer + cluster-bugs + protected-files,
rounds-orchestrator wrapping 1→4 + final-gate round 5, runtime-signoff Gate 7.

## Definition of done

- All Phase 3 rows (phase3-step-001 through phase3-step-025) `passes: true` with evidence
- `phase3-step-021` HUMAN closure signed off
- `git tag phase-3-done`
- Factory ready for first real client project

[Scope sections filled by /sync-phase-plan]

---

# Architectural commitments (cross-phase)

These commitments shape multiple phases. They are load-bearing and changing them retroactively requires
an ADR in `DECISIONS.md`.

## Factory ↔ project split

The repo is a **factory**; each app is a **project** under `projects/<slug>/`. /new-project clones
factory `.claude/` resources into the project (visibility controlled by --agentic-visibility:
public, private, or split). Never edit a project's `.claude/agents/` expecting it to propagate
back to the factory.

## Hybrid TDD (builder 60% / tester 80%)

Builder ships happy-path tests with code; tester adds edge-cases + integration + E2E. Tester is
write-test-only (cannot edit source). See `.claude/rules/testing-policy.md`.

## Evidence-gated row flips

Rows in `feature_list.json` cannot flip `passes:false → true` without the evidence file being read
in-session. Enforced by `verify-gate.mjs` PreToolUse hook (phase0-step-008) + `track-read.mjs`
PostToolUse hook (phase0-step-009).

## Cache-aware dispatch

Orchestrator passes `excludeDynamicSections: true` on every query() (phase0-step-049). Auth
defaults to API-key mode for orchestrator path. `ENABLE_PROMPT_CACHING_1H=1` is set. Cross-worktree
cache reuse is the highest single-ROI performance commitment.

## Vision routing

Perceptual + walkthrough reviewers default to Haiku 4.5. Escalation to Sonnet 4.6 fires on SSIM
dissimilarity >1% via phase3-step-022 prefilter. Cluster-bugs gets a Haiku second-pass for
defense-in-depth on cluster decisions.

## Worktree per feature

Mode B opens `.claude/worktrees/<featureId>/` per feature. Per-feature isolation lets
--max-concurrent N work without conflicts. close-feature merges + removes worktree
(unless --keep-worktrees).
