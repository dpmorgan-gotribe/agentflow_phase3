---
name: capture-lesson
description: Append a structured lesson entry to LESSONS.md. Invoked at the end of every completed step — both successes and failures — and at the end of every investigation. Tagged for later /consult-lessons retrieval.
when_to_use: end of every completed feature_list.json step, end of every investigation, after any "I learned something" moment during a session
argument-hint: [optional — row-id or free-text lesson hint]
allowed-tools: Read, Write, Bash
---

# /capture-lesson — Append to LESSONS.md

## Why this skill is mandatory

Capture is the cheap part. Consultation (via `/consult-lessons`) and promotion (via `/phase-gate`) only work if the raw log is dense. The standing rule: every completed step ends by invoking this skill before the next step starts. Yes, even when the step was boring. The mistake-pairing format below is the standard blameless-postmortem schema (Google SRE) collapsed to two bullets.

## Steps

### 1. Gather context

- Identify the row id (from `$ARGUMENTS` or the current branch name).
- Read the row from `feature_list.json` for description + outcome.
- Read the last 10 commits via `git log --oneline -10` to recall what happened.

### 2. Draft the entry

Use this template exactly:

```md
## {row-id} — {short title} ({YYYY-MM-DD})

- **What we set out to do**: {1 sentence}
- **What actually happened**: {1 sentence — successes AND surprises}
- **Root cause (if a mistake or surprise)**: {1 sentence — or "n/a"}
- **What worked**: {1 sentence}
- **Mistake made**: {1 sentence — or "none worth noting"}
- **Technique worth remembering**: {1 sentence — the durable insight, in a form a future me could apply}
- **Tags**: {space-separated, hash-prefixed — e.g. #performance #parallel-subagents #cache}
```

### 3. Tag discipline

- ≥ 2 tags, ≤ 6 tags.
- Tags are kebab-case (`#async-bug`, not `#asyncBug` or `#async_bug`).
- Reuse existing tags before inventing new ones — `grep -hoE '#[a-z][a-z0-9-]+' LESSONS.md | sort -u` to see what's in use.
- Domain tags (e.g. `#parity-verify`, `#mode-b`, `#worktree`) are encouraged; they make `/consult-lessons` precise.

### 4. Append, do not edit

- Read `LESSONS.md`, append the entry at the bottom, write back.
- Never edit prior entries. If a prior entry was wrong, append a correction entry referencing the original by row-id.

### 5. (Optional) Update `PROGRESS.md`

If the entry contains a "Technique worth remembering" that the human should see at next session start, add one line to `PROGRESS.md`:

```
- {YYYY-MM-DD}: lesson #{tag} captured for {row-id} — {one-line takeaway}
```

### 6. Report

```
Lesson captured: LESSONS.md (entry for {row-id})
Tags: {list}
PROGRESS.md updated: {yes/no}
```

## Relationship to `/sync-phase-plan`

`/capture-lesson` and `/sync-phase-plan` are **complementary, not redundant**:

- `/capture-lesson` writes wisdom to `LESSONS.md` — process insights, mistakes, techniques.
  Audience: a future agent planning new work in this area.
- `/sync-phase-plan` writes durable behavior to `phase-plan.md` — validation rules, retries, schemas.
  Audience: someone rebuilding the system from the plan alone.

A typical row close uses both:

1. `/sync-phase-plan {row-id}` — fold the design decision into the plan.
2. `/capture-lesson {row-id}` — capture the process lesson about how the decision was reached.
3. Then flip `passes:true`.

A lesson without a plan sync is a process insight. A plan sync without a lesson is a behavior addition. Most rows produce one of each.

## Edge cases

- **Investigation finishing with no clear lesson**: still capture. "What worked" can be "we ruled out X" — that's a real finding.
- **The same lesson keeps re-appearing**: that's a signal for `/phase-gate` to promote it to a skill or CLAUDE.md rule.
- **Cross-row insight (not tied to one row)**: use `id: cross-{phase}-{NNN}` and tag both phases.
- **Sensitive info in a lesson**: don't capture API responses verbatim. Summarize.
- **Lesson describes a durable behavior**: the behavior also belongs in `phase-plan.md`. Capture the lesson, then run `/sync-phase-plan` to fold the behavior into the plan.
