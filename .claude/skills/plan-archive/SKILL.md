---
name: plan-archive
description: Move a completed or abandoned plan from plans/active/ to plans/archive/, append a completion record, and update the manifest.
when_to_use: after a plan reaches completed/abandoned, or when superseding a plan (use /plan-supersede for that path when available)
argument-hint: [plan-id] [--outcome success|partial|failed|abandoned] [--lessons "..."]
allowed-tools: Read Write Bash Grep Glob
---

# /plan-archive — Complete and Archive a Plan

Move a terminal plan out of `plans/active/` and seal it with a completion
record. The archive is searchable by `/plan-search` and feeds
`docs/lessons.md` via the Lessons agent.

## Steps

### 1. Resolve the plan ID

- If `$ARGUMENTS` begins with a plan ID (`feat-NNN-…`, `bug-NNN-…`,
  `refactor-NNN-…`, `investigate-NNN-…`), use it
- If not supplied, list active plans via `/plan-status` output and ask which
  one to archive
- Verify `plans/active/{id}.md` exists. If not, error: "Plan {id} not found
  in plans/active/. Check the ID."

### 2. Parse outcome + lessons

- `--outcome` values: `success`, `partial`, `failed`, `abandoned`
- Required. If missing, ask: "Outcome? success | partial | failed | abandoned"
- `--lessons` is a quoted string or repeated flag. If none supplied, ask the
  user: "What lessons should future agents learn from this plan? (blank to
  skip)"

### 3. Gather facts from git and the plan itself

Read the plan's frontmatter (`type`, `branch`, `affected-files`,
`attempt-count`, `created`). Then:

**If `type == investigation` OR `branch` is null/empty**, skip the git
queries — investigations are research, not code. Emit `commits: []` and
`actual-files-changed: []` in the record, and note in the report:
`Commits: n/a (investigation — no branch)`.

**Otherwise** (feature, bug, refactor with a real branch):

- **commits**: list commits on the plan's branch since it diverged from main:
  `git log main..{branch} --pretty=format:"%h|%s" 2>/dev/null` — parse each
  as `{hash, message}`. If the branch doesn't exist, see Edge Cases.
- **actual-files-changed**: `git diff --name-status main...{branch} 2>/dev/null`
  — each line is `{status}\t{path}`; map status letters (A/M/D/R) to
  `(created|modified|deleted|renamed)`
- **duration-minutes**: `created` date → today, rounded to minutes. If
  crossing multiple days, still minutes (not days) — the field is
  `duration-minutes` per the blueprint

**For all plan types:**

- **test-results**: look for the last test summary line in the plan's
  Attempt Log. If `type == investigation`, write `unit: n/a (research only)`
  and `integration: n/a` — investigations have no test results by design.
  For other types, if no test summary is found, leave blank with a
  comment and ask the user.

### 4. Build the completion record YAML block

Exactly this shape (from blueprint lines 1077-1098):

```yaml
---
# COMPLETION RECORD (appended to archived plan)
completed: 2026-04-17
outcome: success # success | partial | failed | abandoned
actual-files-changed:
  - src/auth/clerk.ts (created)
  - src/middleware/auth.ts (created)
  - packages/api/routes/auth.ts (modified)
commits:
  - hash: abc1234
    message: "feat: implement Clerk auth integration"
attempts: 2
lessons:
  - "Clerk SDK v5 changed the session API — had to reference migration guide"
  - "RBAC guard names must exactly match navigation-schema.json guard field"
test-results:
  unit: 14/14 passed
  integration: 3/3 passed
duration-minutes: 45
---
```

Populate with real values. Omit list items that have no data (e.g., empty
`commits:` if the branch had no commits — but then warn the caller: "No
commits on branch {branch} — is this really done?"). For `lessons:` with
none supplied, write `lessons: []` and note in report: "No lessons captured —
consider adding later."

### 5. Update the plan's frontmatter status

Set `status` to `archived` and bump `updated` to today. If outcome is
`abandoned`, set status to `archived` with `outcome: abandoned` in the
record — the Archive Record captures the terminal reason.

### 6. Write the archived file

- Read `plans/active/{id}.md`
- Append the completion record to the end (one blank line before the
  opening `---`)
- Write to `plans/archive/{id}.md`
- Remove `plans/active/{id}.md`. Use this exact fallback chain so untracked
  files don't block the move:
  `git mv plans/active/{id}.md plans/archive/{id}.md 2>/dev/null || mv plans/active/{id}.md plans/archive/{id}.md`
  `git mv` only succeeds if the file is tracked; for brand-new plans that
  were never staged, `mv` is the correct path. Do NOT use `git rm` — we
  already moved the file to archive, and we want the move recorded (if
  tracked) rather than a delete.

### 7. Update the active manifest

- Read `plans/active.md`
- Remove the row where the first column equals `{id}`
- Write the updated manifest

### 8. Report to user

Report exactly:

```
Archived: plans/archive/{id}.md
Outcome: {outcome}
Commits: {N} on {branch}                   ← or "n/a (investigation — no branch)"
Files changed: {M}                         ← or "n/a" for investigations
Attempts used: {attempts}/{max-attempts}
Lessons captured: {L}   ← consider /lessons-add if 0
```

## Edge Cases

- **Branch not merged**: if the plan's branch still has commits ahead of main
  and outcome is `success`, warn: "Branch {branch} has {N} unmerged commits.
  Merge before archiving, or confirm you want an archived record of work
  that never landed." Do not block — the user decides.
- **Branch deleted**: if `git rev-parse {branch}` fails, skip the git-diff
  step and note in the report: "Branch {branch} no longer exists — file list
  and commits omitted. Supply via --files and --commits if needed."
- **Plan already archived**: if `plans/archive/{id}.md` already exists, error:
  "{id} is already archived at plans/archive/{id}.md. Refusing to overwrite."
- **Abandoned outcome with success-like evidence**: if outcome is `abandoned`
  but commits exist on the branch, ask: "You marked this abandoned but the
  branch has {N} commits. Confirm abandoned, or should this be `partial`?"
- **No lessons on a failed plan**: if outcome is `failed` or `partial` and
  `lessons` is empty, refuse: "Failed/partial plans must capture at least one
  lesson. What went wrong?" Retry from step 2.
