---
name: save-context
description: Capture current work state as a chained context snapshot. Run at logical breakpoints, before session end, or when blocked.
when_to_use: before session end, at milestones, when blocked, before compaction, every ~5 significant edits
argument-hint: [--checkpoint] [--status blocked|final] [--brief "one-line summary"]
allowed-tools: Read Write Bash Grep Glob
---

# /save-context — Chained Context Snapshot

Snapshots preserve the ephemeral "what was happening" state that conversations
lose on compaction, session restart, or crash. Each snapshot links backward
via `previous-context` in its frontmatter; `/load-context-chain` walks that
chain to reconstruct state.

Contexts are distinct from:

- **CLAUDE.md** — stable project facts (always apply)
- **Plans** — intent (what we're doing and why)
- **Lessons** — generalized insights from completed work

Contexts = the working state at a point in time.

## Steps

### 1. Generate session-id

- Format: `YYYYMMDD-HHMMSS` in UTC
- Bash: `date -u +"%Y%m%d-%H%M%S"`

### 2. Find the previous context (if any)

- `ls -1 contexts/*.md 2>/dev/null | sort | tail -1`
- If a previous snapshot exists, capture its filename (basename only) as
  `previous-context`. If `contexts/` is empty or missing, leave
  `previous-context: null` — this is the first snapshot in the chain.
- Skip `contexts/checkpoints.md` if it shows up in the listing (it's the
  manifest, not a snapshot).

### 3. Determine the brief and agent

- `--brief "text"` in `$ARGUMENTS` → use it as the brief
- Else infer from: the current plan's title, recent git log subject, or
  a one-line description of the last 3-5 actions. Max 40 chars, kebab-case.
- `agent`: inferred from the invoking context. Default to `human` when
  invoked directly by a user.

### 4. Determine if this is a checkpoint

Checkpoint when any of:

- `--checkpoint` flag in `$ARGUMENTS`
- Counting backward through the chain, 5 non-checkpoint snapshots found
  before the last checkpoint (so every 5th is automatic)
- `--status final` (end-of-session) or `--status blocked` (milestone)
- An active plan moves to `completed`, `abandoned`, or `superseded`
  (caller provides `--checkpoint`)

Checkpoints bound how far `/load-context-chain` has to walk backward.

### 5. Gather state

Run these (best-effort — missing outputs fine, just note absent):

- `git rev-parse --abbrev-ref HEAD` — current branch
- `git log --oneline -5` — recent commits
- `git status --short` — uncommitted changes
- `git diff --name-only HEAD` — files touched this session (vs. HEAD)
- Grep the active plan (if any) — from `plans/active/` with frontmatter
  status `in-progress`
- Last known test result if mentioned in an active plan's Attempt Log

### 6. Build the snapshot

Filename: `contexts/{session-id}-{agent}-{brief-slug}.md`

**Frontmatter (exactly these keys):**

```yaml
---
session-id: "{YYYYMMDD-HHMMSS}"
timestamp: { ISO8601 UTC }
agent: { agent-name }
task-id: { active-plan-id or null }
previous-context: { filename of prior snapshot, or null }
checkpoint: { true | false }
status: { in-progress | blocked | checkpoint | final }
---
```

**Body (these sections, in order):**

```markdown
# Context snapshot — {agent} — {brief}

## Summary

{2-5 sentences — what this session is doing, why it matters}

## Completed since last snapshot

- {bullet points of concrete accomplishments}

## Current state

- Branch: {name} ({short-sha})
- Tests: {X/Y passing}
- Uncommitted files: {count and notable ones}
- Blockers: {anything blocking progress, or "none"}

## Next steps

1. {concrete, numbered, first next action}
2. {...}

## Open questions

- {questions the next agent/session needs answered}
- {"(none)" if truly none}

## Key files touched

- {path} — {what changed / why it matters}

## Decisions made

- {architectural, naming, or process decisions made this session}
- {include the _why_ so the decision can be re-evaluated with context}
```

Sections with no content get `(none)` — don't omit them, so the structure is
predictable for `/load-context-chain`.

### 7. Enforce the 500-line cap

- `wc -l <path>` — if over 500 lines, warn and set `checkpoint: true`
  (forcing a chain break). Longer snapshots mean the chain is carrying too
  much state; a checkpoint resets the walk depth.

### 8. Register checkpoints

- If `checkpoint: true`, append the filename to `contexts/checkpoints.md`
  (a flat list, one filename per line, newest last). This replaces the
  blueprint's "symlink to checkpoints/" because Windows doesn't reliably
  support POSIX symlinks via Git for Windows.
- Create `contexts/` and `contexts/checkpoints.md` on first run if missing.

### 9. Report

```
Context saved: contexts/{filename}
Previous: {previous-context or "(none — first in chain)"}
Checkpoint: {yes | no}
Lines: {N}/500
Next: run /load-context-chain on resume.
```

## Edge Cases

- **`contexts/` doesn't exist**: create it with `mkdir -p contexts` before
  writing. Create `contexts/checkpoints.md` with a one-line header.
- **Previous context file is malformed**: still link to it by filename;
  `/load-context-chain` will surface the problem when it tries to parse.
- **Over 500 lines even as a checkpoint**: refuse to write. Prompt the user:
  "Snapshot exceeds 500 lines. Split your summary, or consolidate into the
  active plan's Attempt Log instead."
- **No previous context AND no active plan AND no git history**: allow the
  snapshot, but flag in Summary: "Cold start — no prior state to chain from."
- **`$ARGUMENTS` passes `--status final` outside an end-of-session context**:
  don't validate intent, trust the caller. `final` means "nothing after this."
