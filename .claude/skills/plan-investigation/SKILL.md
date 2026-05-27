---
name: plan-investigation
description: Create a time-boxed investigation plan. Use to research a question before committing to an implementation — and as the attempt-3 escalation step in the retry ladder.
when_to_use: unclear root cause, choosing between approaches, attempt-3 escalation from a stuck bug or feature
argument-hint: [question-to-investigate]
allowed-tools: Read Write Bash Grep Glob Skill
---

# /plan-investigation — Create Time-Boxed Research Plan

Investigations are **research tasks, not implementations**. They do not
create git branches. They have a default 30-minute time box. When time
expires, findings (even incomplete) are documented and a recommendation is
written — usually pointing at a follow-up `/plan-bug` or `/plan-feature`.

Per the retry policy, agents run `/plan-investigation` at attempt 3 of a
stuck bug or feature. Skipping this step and blind-retrying is what the
loop-detection hook is designed to catch.

## Steps

### 1. Get the question

- If `$ARGUMENTS` is provided, use it as the investigation question
- If empty, ask: "What specific question should this investigation answer?
  Phrase it as a question with a falsifiable answer."

### 2. Check for existing related work

- Invoke `/check-existing-work <keywords>` — prior investigations into the
  same question are the single highest-value thing to find before starting
- If a prior investigation found an answer, surface its Recommendation and
  ask whether a fresh investigation is really needed

### 3. Identify parent plan (if this is an escalation)

- If the user's turn history or `$ARGUMENTS` names a parent plan
  (`feat-NNN-…` or `bug-NNN-…`), record it. Otherwise ask: "Is this
  escalating from an existing plan? If so, which ID? (blank if standalone)"
- Parent plan ID goes into `parent-plan` frontmatter

### 4. Generate plan ID

- Count: `ls plans/active/investigate-*.md plans/archive/investigate-*.md plans/superseded/investigate-*.md 2>/dev/null | wc -l`
- Next ID = count + 1, zero-padded to 3 digits
- Slug: lowercase, hyphens, drop stop words, max 30 chars
- Full ID: `investigate-{NNN}-{slug}`

### 5. Read the template

- `plans/templates/investigation-plan.md`

### 6. Fill in the plan

**Frontmatter:**

- `id`, `type: investigation`, `status: draft`, `author-agent`, `created`,
  `updated`, `branch: null` (investigations don't branch),
  `attempt-count: 0`, `max-attempts: 5`, `time-box-minutes: 30`
- `parent-plan`: from step 3, or null
- `priority`: inherit from parent plan if escalating, else `P1`
- `hypothesis`: one-line starting guess; full explanation goes in the body
  Hypothesis section
- `feature-area`: infer, or inherit from parent

**Body:**

- **Question** — restate the question crisply. One sentence. Falsifiable
- **Hypothesis** — what do we currently believe the answer is? Having a
  hypothesis BEFORE investigating focuses the search. If you genuinely have
  no hypothesis, write "No prior hypothesis" — don't invent one
- **Investigation Steps** — numbered, concrete. Each step should produce an
  observation: read doc X, run command Y, test minimal repro Z, check git
  blame on file F. Steps should fit inside the time box
- **Findings** — leave empty; the executing agent fills this in
- **Recommendation** — leave empty; filled in once findings are complete
- **Attempt Log** — leave empty

### 7. Write the plan

- `plans/active/investigate-{ID}-{slug}.md`
- Do NOT create a git branch

### 8. Update the active manifest

- Append to `plans/active.md`:
  `| investigate-{NNN}-{slug} | investigation | draft | {priority} | - | {one-line question} |`
  (branch column is `-` because investigations don't branch)

### 9. If this is an attempt-3 escalation, update the parent plan

- Add a note to the parent plan's Attempt Log:
  `### Attempt 3 — Escalated to investigation {investigate-NNN-slug}`
  `  See plans/active/investigate-{NNN}-{slug}.md`
- Do not change the parent's status

### 10. Report to user

```
Investigation plan created: plans/active/investigate-{ID}-{slug}.md
Time box: 30 minutes
Status: draft — review and approve to start.

{if parent-plan}
Escalated from: {parent-plan-id}
Parent plan's Attempt Log updated — parent stays in its current status until
this investigation produces a recommendation.
{endif}

Findings + Recommendation sections are empty and must be filled before
archiving.
```

## Time-Box Discipline

- Default 30 minutes is in the template frontmatter. Override with
  `--time-box <minutes>` in `$ARGUMENTS` if the user supplied it
- When the time box expires, the executing agent MUST document what they
  found even if incomplete, and write a Recommendation (which can be "run
  another investigation focused on X")
- Exceeding the time box is a retry-policy violation — the loop detector
  treats repeated investigation extensions as a loop

## Edge Cases

- **Question is not a question**: if `$ARGUMENTS` is phrased as a task
  ("fix the auth bug") rather than a question, prompt: "Rephrase as a
  question with a falsifiable answer (e.g., 'Why does auth fail when email
  contains +?')." Don't write the plan until you have a proper question.
- **Attempt 3 with no prior plan context**: if an agent invokes this without
  citing a parent plan but `/plan-status` shows a plan at attempt-count 3+,
  warn: "This looks like it should be linked to {candidate-plan}. Set
  parent-plan? (y/n)"
- **Hypothesis contradicts prior findings**: if `/check-existing-work`
  surfaced a prior investigation with a different answer to a similar
  question, prominently warn and require the user to explain why the prior
  finding doesn't apply here.
- **Empty $ARGUMENTS**: don't generate a generic plan. Prompt for a real
  question.
