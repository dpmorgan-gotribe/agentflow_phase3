---
name: plan-status
description: List active plans with status, priority, branch, attempt count, and a one-line summary. Warns on plans near the max-attempts ceiling.
when_to_use: before starting the day's work, checking coordination state, auditing stalled plans
argument-hint: [--type feature|bug|refactor|investigation] [--status draft|approved|in-progress]
allowed-tools: Read Bash Grep Glob
---

# /plan-status — Active Plan Dashboard

Show every plan in `plans/active/` with the state needed to decide what to do
next. Reads frontmatter directly from each plan file — the manifest
(`plans/active.md`) is informational only and can drift.

## Steps

### 1. Parse filter arguments

- `$ARGUMENTS` may contain: `--type <t>`, `--status <s>`, both, or neither
- Valid types: feature, bug, refactor, investigation
- Valid statuses: draft, approved, in-progress, completed, abandoned, superseded
- No filters → list everything

### 2. Enumerate active plan files

- `ls plans/active/*.md 2>/dev/null` — excludes `active.md` if it's named differently;
  otherwise explicitly skip `plans/active.md`
- If no files match, print "No active plans." and stop

### 3. Read each plan's frontmatter

For every file, extract: `id`, `type`, `status`, `priority`, `branch`,
`attempt-count`, `max-attempts`, `feature-area`, and the first line under the
`# {id}: Title` heading (for the summary). Use a small awk/grep to pull just
the YAML block between the two `---` markers.

### 4. Apply filters

Drop plans whose `type` or `status` does not match a supplied filter.

### 5. Render the table

Print a markdown table sorted by priority (P0 → P3), then by updated date desc:

```
| ID | Type | Status | Priority | Attempts | Branch | Summary |
|---|---|---|---|---|---|---|
| feat-001-user-auth | feature | in-progress | P0 | 1/5 | feat/user-auth | Email + password signup with email verification |
| bug-003-login-500  | bug     | approved    | P1 | 0/5 | fix/login-500  | 500 on POST /auth/login when email contains + |
```

### 6. Warn on near-max attempts

After the table, for any plan with `attempt-count >= 3`, emit a warning:

```
⚠  feat-001-user-auth — 4/5 attempts used. Next failure triggers escalation.
⚠  bug-003-login-500 — 3/5 attempts used. Run /plan-investigation if the next try fails.
```

Sort warnings by attempts descending (closest to ceiling first).

### 7. Summary footer

Print counts: `{N} active ({by-type and by-status breakdown})`. Example:

```
7 active — 3 feature, 2 bug, 1 refactor, 1 investigation
           2 draft, 2 approved, 3 in-progress
```

If filters were applied, also show the total before filtering so the caller
knows what they hid.

## Edge Cases

- **`plans/active/` does not exist**: print "No active plans directory." and
  stop. Do not error.
- **Plan file missing required frontmatter fields**: render the row with
  `?` in unknown columns and append a warning after the table:
  `⚠  {id} has malformed frontmatter — fields missing: {list}`.
- **`attempt-count` missing**: treat as `0/5`, no warning.
- **Manifest drift**: `plans/active.md` may list plans that no longer exist in
  `plans/active/`, or omit ones that do. This skill ignores the manifest —
  `/plan-archive` is responsible for keeping it in sync.
