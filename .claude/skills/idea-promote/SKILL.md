---
name: idea-promote
description: Graduate an idea from docs/ideas.md to a real plan-feature/plan-bug/plan-refactor/plan-investigation. Reads idea N (per /idea-list numbering), checks for related prior work via /check-existing-work, prompts the operator to choose a plan type, dispatches the chosen plan-* skill seeded with the idea text, and ticks the idea in docs/ideas.md with a (→ plan-id) backref on success.
when_to_use: when an operator decides a stashed idea is ready to commit to (give it a plan + branch + status); when reviewing the unticked pile periodically and wanting to graduate the keepers; when the conversation returns to a previously-stashed idea
argument-hint: <N — idea number from /idea-list>
allowed-tools: Read Write Edit Bash
---

# /idea-promote — Graduate idea N to a real plan

Reads idea number N from `docs/ideas.md` (numbering from
`/idea-list`), runs `/check-existing-work` against its keywords, asks
the operator which plan type to use, dispatches the chosen plan-\*
skill seeded with the idea text, and on success ticks the idea with a
backref to the new plan ID.

## Steps

### 1. Validate input

- Argument is a positive integer N.
- If missing or non-numeric: error
  `Usage: /idea-promote <N> where N is from /idea-list output.`

### 2. Pre-flight

Confirm `docs/ideas.md` exists. If not:

```
No ideas to promote — docs/ideas.md does not exist.
```

Exit cleanly.

### 3. Resolve idea N

Run the same parsing logic as `/idea-list` (default = unticked-only).
Pick the Nth entry (1-indexed). If N is out of range:

```
Idea #N not found. /idea-list shows <K> unticked ideas.
```

Capture: `ideaText`, `capturedAt`, `lineNumberInFile`.

### 4. Search for related prior work

Run `/check-existing-work <keywords-from-idea-text>` where keywords
are the most-distinctive 2-3 words from the idea text (skip stop
words). If there are matches, present them to the operator and ask:

```
Found related prior work:
  - feat-NNN-foo (archived 2026-03-12) — outcome: success
  - bug-MMM-bar  (active, P1)

Continue with promotion? (yes / no / supersede <plan-id>)
```

- `yes` → proceed to step 5.
- `no` → exit cleanly without changes. Report: `Promotion cancelled.`
- `supersede <plan-id>` → promote AND mark the named prior plan as
  superseded by the new one (only valid if the named plan is in
  `plans/active/`).

### 5. Choose plan type

Prompt the operator:

```
Promote idea to:
  1) feature      → /plan-feature
  2) bug          → /plan-bug
  3) refactor     → /plan-refactor
  4) investigation→ /plan-investigation
  5) drop         (delete the idea without creating a plan)

Idea text: "<ideaText>"
```

Read the operator's response. Map to a plan skill OR delete-and-tick.

### 6. Dispatch the plan-\* skill

Invoke the chosen `/plan-<type>` skill with the idea text as the
argument. Let the skill run interactively as it normally would —
it'll author its own plan file with the right ID + frontmatter.

Capture the new plan's full ID (e.g. `feat-034-dag-status-skill`)
from the skill's output.

If the skill errors or the operator cancels mid-way through, treat
this as a no-op — do NOT tick the idea.

### 7. Tick the idea on success

Read `docs/ideas.md`, locate the line at `lineNumberInFile`, and
replace `- [ ]` with `- [x]` plus a backref:

```
- [x] 2026-04-29 14:32 — DAG observability via tree render of … (→ feat-034-dag-status-skill)
```

If the operator chose `drop` in step 5, replace the line with a
crossed-out form OR delete it entirely (operator preference, default
delete). Report the action.

### 8. Report

```
Idea #N promoted to plans/active/<new-plan-id>.md
Idea ticked in docs/ideas.md.
```

## Edge cases

- **Idea number is for a ticked entry** (operator misread
  `/idea-list`): error
  `Idea #N is already ticked (promoted to <prior-plan-id>).`
- **No `docs/ideas.md`**: step 2 handles.
- **Idea text is too short to extract keywords for
  /check-existing-work**: skip the search step and proceed to
  step 5 directly (note in output that the search was skipped).
- **Operator chooses `supersede` but the named plan is not in
  active**: error and abort — `supersede` is not for archived plans.

## Cost

Free for the file mutation; the plan-\* dispatch may invoke an SDK
call depending on the skill (e.g. `/plan-feature` is currently
purely-template-based and does not call the SDK).

## See also

- `/idea <text>` — capture a new idea
- `/idea-list` — find the right N
- `/plan-feature`, `/plan-bug`, `/plan-refactor`, `/plan-investigation`
- `/check-existing-work` — automatic step 4
- `/plan-archive` — for terminal cleanup of the new plan later
