---
name: phase-gate
description: Run the end-of-phase retrospective. Invokes the `retro` subagent, saves its report to reports/, and pauses for human approval before recommending a phase transition. This is the harness's only mandatory human-in-the-loop point for phase transitions.
when_to_use: when phase-plan.md's definition-of-done is believed met; before starting work on the next phase
argument-hint: [phase-number — e.g. 1]
allowed-tools: Read, Write, Bash, Skill, Task
---

# /phase-gate — End-of-phase retrospective

## Steps

### 1. Confirm the phase

- If `$ARGUMENTS` provides a number, use it.
- Else ask: "Which phase are we closing?"

### 2. Sanity-check the close criteria

Read `phase-plan.md` for the phase's definition-of-done. Then read `feature_list.json`:

- Count `rows` for the phase (`id` starts with `phase{N}-`).
- Count `passes:true` and `passes:false`.
- Count `polished:true`.

If `passes:true` is < 80% of the phase's rows, emit a warning *before* invoking the retro:

```
WARNING: Phase {N} is {pct}% passing — recommend NOT closing yet.
Continue anyway? (y/n)
```

Wait for confirmation.

### 3. Determine the git range

- Read the tag/ref that marks the phase start (convention: `phase-{N}-start`).
- If missing, fall back to `git log --pretty=format:%H --since='30 days ago' | tail -1`.
- Pass as `<range> = phase-{N}-start..HEAD`.

### 4. Invoke the `retro` subagent

Use the Task tool with:

- Description: `Phase {N} retrospective`
- subagent_type: `retro`
- Prompt: (a self-contained brief — the subagent has fresh context, give it everything)

```
You are running the phase {N} retrospective for agentflow_phase3.

Inputs:
- Phase: {N}
- Phase-plan section: phase-plan.md, the "Phase {N}" heading
- Git range: phase-{N}-start..HEAD
- Feature list summary:
    total rows: {T}, passes:true {P}, polished:true {Q}
    rows by category: {breakdown}
- LESSONS.md entries tagged for phase {N}: {grep count}
- DECISIONS.md ADRs created in window: {count}
- evidence/ files referenced by rows: {count}

Read those files yourself. Produce the Phase Gate Report exactly per your prompt's output format. Print to stdout — do not write the file.
```

### 5. Save the report

- Create `reports/` if it doesn't exist.
- Write the subagent's stdout to `reports/phase-{N}-gate-{YYYY-MM-DD}.md`.

### 6. Stop for human approval

Print:

```
Phase {N} Gate Report saved: reports/phase-{N}-gate-{YYYY-MM-DD}.md

Next actions require human review:
  1. Read the report.
  2. Approve recommended skill / rule promotions (Section 4) — for each, either:
     - file a new /plan-feature row to add the skill, OR
     - directly amend CLAUDE.md (one-liner rules), OR
     - reject and append rationale to DECISIONS.md.
  3. Resolve open blockers (Section 6).
  4. Once approved, the user runs: `git tag phase-{N}-end` and `git tag phase-{N+1}-start`.

Do NOT auto-advance the phase. Wait for explicit human approval.
```

### 7. Update PROGRESS.md

Append:

```
## {YYYY-MM-DD} — phase {N} gate report generated
- Report: reports/phase-{N}-gate-{YYYY-MM-DD}.md
- Awaiting human approval before phase {N+1} starts.
```

## What this skill does NOT do

- Doesn't write skills or rules. The retro *recommends*; the human decides; a follow-up `/plan-feature` files the work.
- Doesn't tag the git ref. That's a human action.
- Doesn't advance the phase. There's no "current phase" file the harness mutates — the phase is implicit in `feature_list.json` row id prefixes.
