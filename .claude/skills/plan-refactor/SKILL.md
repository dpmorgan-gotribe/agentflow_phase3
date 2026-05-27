---
name: plan-refactor
description: Create a new refactor plan. Use when restructuring existing code without changing external behavior.
when_to_use: restructuring, tech-debt cleanup, extracting modules, renaming, migrating internal APIs
argument-hint: [refactor-description]
allowed-tools: Read Write Bash Grep Glob Skill
---

# /plan-refactor — Create Refactor Plan

Create a structured refactor plan so the migration path is explicit and every
consumer of the old code is accounted for before the first line changes.

## Steps

### 1. Get refactor description

- If `$ARGUMENTS` is provided, use it as the description
- If empty, ask: "What's the refactor — what's the current structure, what
  should it become, and why now?"

### 2. Check for existing related work

- Invoke `/check-existing-work <keywords>` — prefer this over raw grep
- If matches exist, show them and ask: proceed, supersede an existing plan,
  or abandon
- If a superseded match exists, read its lessons and surface them before
  proceeding

### 3. Reference the brief

- If `brief.md` exists, scan headings for sections that describe the
  subsystem being refactored (commonly §7 Architecture, §8 Data Model,
  §17 Technical Debt if present)
- Record the section reference for the Motivation section
- If no `brief.md`, note "no brief.md at plan creation time"

### 4. Generate plan ID

- Count: `ls plans/active/refactor-*.md plans/archive/refactor-*.md plans/superseded/refactor-*.md 2>/dev/null | wc -l`
- Next ID = count + 1, zero-padded to 3 digits
- Slug: lowercase, hyphens, drop stop words, max 30 chars
- Full ID: `refactor-{NNN}-{slug}` (e.g., `refactor-001-db-layer`)

### 5. Read the template

- `plans/templates/refactor-plan.md`

### 6. Fill in the plan

**Frontmatter:**

- `id`, `type: refactor`, `status: draft`, `author-agent`, `created`,
  `updated`, `branch: refactor/{slug}`, `attempt-count: 0`, `max-attempts: 5`
- `feature-area`: infer from the subsystem (e.g., `auth`, `billing`); null if
  unclear
- `priority`: default `P1` (refactors are usually not the most urgent but
  matter). Override from user if stated
- `motivation`: one-line — gets fleshed out in the Motivation body section
- `affected-files`: populated in step below

**Body:**

- **Current State** — specific files/modules involved, what structure is
  there today, what's wrong with it. Be concrete — file paths, function
  names, patterns
- **Desired State** — the structure after the refactor. What properties does
  it have that the current structure lacks?
- **Motivation** — why now? Tie to a constraint: blocking a feature, causing
  repeat bugs, performance, compliance. Reference brief section if
  applicable
- **Migration Strategy** — numbered steps that go from current → desired
  without breaking consumers. Prefer incremental migrations (new alongside
  old, migrate one consumer at a time, then delete old) over big-bang
- **Affected Consumers** — fill the consumer table. Run
  `grep -rln "<old-symbol>" apps/ packages/ 2>/dev/null | head -30` to find
  importers. Each row: Consumer name | File path | Change required
- **Validation Criteria** — how to confirm the refactor is correct. Typical:
  all existing tests still pass, no new type errors, performance unchanged
  or improved, no consumer still references old paths
- **Attempt Log** — leave empty

**Affected files:** union of files touched by the migration steps +
consumer files. Record under `affected-files` in frontmatter (max ~20 — if
more, note "see Affected Consumers table").

### 7. Write the plan

- `plans/active/refactor-{ID}-{slug}.md`

### 8. Create git branch

- Check current branch + uncommitted changes
- `git checkout -b refactor/{slug}`
- If branch exists, switch to it and warn
- If uncommitted changes block the checkout, write the plan anyway and tell
  the user to stash/commit then checkout manually

### 9. Update the active manifest

- Append to `plans/active.md`:
  `| refactor-{NNN}-{slug} | refactor | draft | {priority} | refactor/{slug} | {one-line summary} |`

### 10. Report to user

```
Refactor plan created: plans/active/refactor-{ID}-{slug}.md
Branch: refactor/{slug}
Status: draft — review the plan and approve (status → approved) to start.

Affected consumers identified: {N}   ← if 0, recheck your grep
Brief reference: {brief.md §X or "none — no brief.md at creation time"}
```

## Edge Cases

- **Affected Consumers table is empty**: refuse to write. Ask the user: "No
  consumers found — is this really a refactor, or is this dead code you can
  delete outright? If truly no consumers, describe why." A refactor with
  zero consumers is almost always mis-classified.
- **Migration Strategy is big-bang**: if the strategy is "rewrite everything
  and swap", warn: "Big-bang refactors are high-risk. Can this be staged
  (new alongside old → migrate consumers → delete old)?" — do not block, but
  require the user to acknowledge.
- **Behavior change smuggled in**: if the description mentions new features
  alongside the refactor, stop and say: "This mixes a refactor with new
  behavior. Split into a `/plan-refactor` and a `/plan-feature` — they have
  different approval bars."
- **Empty $ARGUMENTS**: do not generate a generic plan. Prompt for a real
  description.
