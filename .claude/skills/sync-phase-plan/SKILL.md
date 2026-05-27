---
name: sync-phase-plan
description: After a row goes passes:true, a bug closes, or a polish-pass lands an architectural change, draft a surgical addition to phase-plan.md and apply it after human approval. MANDATORY before flipping passes:true on any row whose diff includes durable behavior (validation, retry, rate-limit, cache, schema, control-flow inversion). Keeps phase-plan.md as the canonical rebuild manifest.
when_to_use: end of every row before flipping passes:true; end of every bug close; end of every /polish-pass that lands architectural change
argument-hint: [row-id or bug-id]
allowed-tools: Read, Write, Edit, Bash, Grep, Skill
---

# /sync-phase-plan — Fold shipped reality into the rebuild manifest

## Why this skill is mandatory

The 200-bugs-of-drift problem in Phase 2: every fix landed in code, but `phase-plan.md` was frozen at kickoff. Anyone rebuilding from the plan would re-discover the same 200 bugs. This skill back-propagates shipped reality into the plan so plan and code never diverge.

> Working principle: `phase-plan.md` is a **living rebuild spec**, not a frozen kickoff doc. The frozen snapshot is `git show phase-N-start:phase-plan.md`; the working copy is always source of truth.

## Steps

### 1. Gather context

- Row id from `$ARGUMENTS` or current branch name (`feat/<slug>` or `fix/<slug>` — grep feature_list.json for the slug).
- Read the row from `feature_list.json` — `description`, `steps`, `expected_outcomes`.
- Run `git diff phase-N-start..HEAD -- <files-touched>` to see what actually changed.
- Read the most recent `/capture-lesson` entry for the row (if any).

### 2. Classify changes — durable vs noise

For each non-trivial change in the diff, decide: durable or not.

**Durable (sync to plan):**
- Validation rules (`quantity > 0`, `symbol in allowlist`, schema field required)
- Retry / circuit-breaker policies (max attempts, backoff curve)
- Rate-limits / throttles / semaphores
- Caching layers (TTL, invalidation rule)
- New required JSON keys / DB columns / API response fields
- Control-flow inversions (sync→async, serial→parallel, push→pull)
- New external dependencies (model, library, service)
- Protected-files additions (`.claude/rules/protected-files-policy.md` cited)

**NOT durable (skip):**
- Logging, imports, type hints, formatting
- Refactor-only changes (rename, file move, extract function)
- Test-only changes (test code, fixtures, mocks)
- Comments, docstring polish

If the entire diff is non-durable → skip the sync; report "no spec-level changes" and continue.

### 3. Find the right section of phase-plan.md

- Grep `phase-plan.md` for a section matching the component/feature (`§0c Project lifecycle skills`, `§A Mode A pipeline`, etc.).
- If no section exists, this is a **SCAFFOLDING MISS signal**. Ask the human:
  ```
  No section in phase-plan.md describes {component}. Two options:
    (a) Add a new section here — phase-plan was incomplete (SCAFFOLDING MISS).
        Increment .claude/state/scaffolding-misses-current-phase and log to DECISIONS.md.
    (b) The change belongs in an existing section — which one?
  ```
- Don't guess. Wait for the answer.

### 4. Draft the spec delta as a unified diff

Annotate each addition with `(added YYYY-MM-DD after <row-id>)` for provenance:

```diff
  ## Phase 1 §A — Mode A pipeline
  - 13 sequential stages with HITL gates
+ - kit-change-request detour cap = 2 per pipeline run (added 2026-06-02 after phase1-step-005)
+ - visual-review retry cap = 3 per screen, independent of Layer-5 (added 2026-06-02 after phase1-step-006)
```

Rules for the delta:
- Surgical. Add lines; do not rewrite paragraphs.
- Specific. "Cap = 3 per screen" beats "limited retries".
- Provenanced. Every line ends with `(added YYYY-MM-DD after <row-id>)`.
- One sentence per item.
- No code blocks in phase-plan.md — that's CLAUDE.md territory. Plan describes behavior, not implementation.

### 5. Show the human the draft. Wait for approval.

```
Proposed phase-plan.md delta for {row-id}:

[unified diff]

Approve? (y / n / edit)
  y    → apply the edit
  n    → skip; record reason in PROGRESS.md
  edit → human rewrites the draft, then approve
```

This is a hard pause. Do not auto-apply. The plan is the one artifact where human judgment matters most.

### 6. Apply

- `Edit phase-plan.md` with the approved diff.
- `verify-gate.mjs` ignores edits to `phase-plan.md` (only `feature_list.json` is gated). The edit goes through.

### 7. Append to DECISIONS.md (only if architectural-level)

If the decision is **architectural** (new pattern, not a single validation rule):

```md
## ADR-NNN — Adopted {pattern} (YYYY-MM-DD)
- Context: {row-id} surfaced {problem}
- Decision: {one-line summary}
- Rationale: {one-line — why this approach over alternatives}
- Plan impact: phase-plan.md §X.Y updated
```

Routine validation / single-rule additions don't need an ADR. Reserve ADRs for choices that affect future work.

### 8. Report

```
phase-plan.md synced for {row-id}.
- Section: §X.Y ({heading})
- Items added: {N}
- ADR appended: {yes — ADR-NNN | no}
- Skipped (non-durable): {none | brief list}

Plan ↔ code parity confirmed. Safe to flip passes:true.
```

### 9. ONLY NOW — flip passes:true

The caller (the executing builder turn) proceeds to:
- Invoke `/capture-lesson` if not already done.
- Read the evidence file (triggers `track-read.mjs`).
- Edit `feature_list.json` to flip `passes:true` (or `polished:true`).
- `verify-gate.mjs` allows because evidence is logged.

## Edge cases

- **No diff applicable**: tests-only / refactor-only row. Skip sync. Log "no spec-level changes for {row-id}" in `PROGRESS.md`. The evaluator's plan-parity check won't fire on a row with no durable behavior in the diff.
- **Decision contradicts a prior phase-plan.md item**: do NOT auto-resolve. Surface the conflict to the human.
- **Multiple rows share a decision**: write the spec line once with both row ids in the provenance tag: `(added YYYY-MM-DD after phase1-step-005, phase1-step-006)`.
- **Bug fix reveals a missing whole subsection**: route via the SCAFFOLDING MISS counter (step 3 above). Don't bury whole missing components in a bug-fix line.

## What this skill does NOT do

- **Doesn't rewrite phase-plan.md wholesale.** Surgical additions only.
- **Doesn't delete from phase-plan.md.** Deprecations need their own skill (TBD if needed in practice — defer).
- **Doesn't touch RESEARCH.md or any other research doc.** Research docs are frozen at write time. Phase-plan is the rebuild manifest; research is the rationale.
- **Doesn't update other phases' sections.** Phase 1's work updates Phase 1's section, even if it touches code Phase 2 will reuse.

## Why this is mandatory (not optional)

The evaluator subagent has a plan-parity rubric line: if the diff contains durable behavior not described in `phase-plan.md`, the evaluator returns `NEEDS_WORK`. Skipping `/sync-phase-plan` costs an evaluator round-trip — and the second time around you'll have to sync anyway. Sync first; flip second.

## The rebuild test

The litmus test for whether this skill is doing its job: **delete the repo, clone phase-N-start, and rebuild from `phase-plan.md` alone**. The rebuilt system should match the shipped system. If it doesn't, the gap is what should have been synced. The phase-gate retro samples 5 random rows at each gate and audits this drift.
