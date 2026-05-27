---
name: load-context-chain
description: Reconstruct work state by walking the context chain backward until a checkpoint or sufficient state is accumulated.
when_to_use: resuming after session restart, after compaction, after a crash, when a SessionStart reminder fires
argument-hint: [--latest-only] [--max-depth N]
allowed-tools: Read Bash Grep Glob
---

# /load-context-chain — Resume From Prior Snapshots

Pair skill to `/save-context`. Walks backward through the chain of snapshots,
each linked via `previous-context` frontmatter, until it hits a checkpoint or
the walk-depth limit. Synthesizes everything into a single "where we are" brief
and reports it to the user BEFORE any new work starts.

## Steps

### 1. Locate the newest snapshot

- `ls -1 contexts/*.md 2>/dev/null | sort | tail -1`
- Skip `contexts/checkpoints.md` (manifest, not a snapshot)
- If the listing is empty or `contexts/` is missing, report: "No prior
  context found — this is a cold start." and stop.

### 2. Parse frontmatter + body

For each snapshot you read (this one and each ancestor), extract:

- Frontmatter: `session-id`, `timestamp`, `agent`, `task-id`,
  `previous-context`, `checkpoint`, `status`
- Body sections: Summary, Completed since last snapshot, Current state,
  Next steps, Open questions, Key files touched, Decisions made

Use a small awk/grep slice:

```
awk '/^---/{c++; next} c==1' contexts/<file>.md   # frontmatter only
awk '/^---/{c++; next} c>=2' contexts/<file>.md   # body only
```

### 3. Decide whether to keep walking

Stop when ANY of these become true (evaluated in order):

a. **Current snapshot has `checkpoint: true`** — you have complete state
back to this point. Stop.
b. **You've read 5 non-checkpoint snapshots in the chain** — walking further
has diminishing returns and violates the chain-depth discipline. Stop
and warn: "Walked 5 non-checkpoint snapshots without finding one —
consider running `/save-context --checkpoint` next time to bound the chain."
c. **`previous-context` is null** — this is the start of the chain. Stop.
d. **`previous-context` file does not exist** — broken chain. Stop and warn:
"Chain breaks at `{missing-file}` — state before that point is lost.
Check git history or the active plan's Attempt Log to fill the gap."

Otherwise: set next = the file named in `previous-context`, go to step 2.

### 4. Reverse the walk order for synthesis

You walked newest-to-oldest. Synthesize in chronological order
(oldest → newest) so "what happened when" reads naturally.

### 5. Produce the synthesis

Report exactly this shape — one consolidated brief, not a dump of snapshots:

```
## Resuming from {N} snapshots — {oldest timestamp} → {newest timestamp}
Last known agent: {agent}, task-id: {task-id}, status: {status}

### What's been done
- {merged bullets from each snapshot's "Completed since last snapshot",
   deduplicated, chronological}

### Current state
- Branch: {from newest snapshot}
- Tests: {from newest snapshot}
- Uncommitted files: {from newest snapshot}
- Blockers: {from newest snapshot, or "none"}

### Next steps
1. {from newest snapshot's "Next steps"}

### Open questions (still unresolved)
- {union of all snapshots' open questions, minus any that a later snapshot
   marked resolved under "Decisions made"}

### Key decisions already made
- {union from "Decisions made" sections, deduplicated}

### Files recently touched
- {union from "Key files touched", newest mention wins on conflicting notes}

### Chain walked
- {file1} ({checkpoint|non}, {status})
- {file2} ...
- {file3}
```

### 6. Verify before acting

Tell the user (or the next agent): **"Review the above before I do anything.
Confirm to proceed, or correct a misunderstanding first."**

Do not automatically resume work. The whole point of context chains is to
surface state so a human can sanity-check it before work continues.

### 7. If `--latest-only` was passed

Skip the walk. Read just the newest snapshot, report it verbatim (no
synthesis needed). Useful when the user just wants "what was I doing"
without the chain depth.

### 8. If `--max-depth N` was passed

Override the default 5-snapshot limit in step 3b with the user's N.
Still honor the checkpoint-stop (3a) and broken-chain-stop (3d).

## Key Design

- **Synthesizes**, does not dump. Five 500-line snapshots would burn the
  caller's context; one consolidated brief is ~50 lines.
- **Chronological order** for readability.
- **Human confirms before resume**. The skill reports state; it doesn't
  re-hydrate and continue automatically.
- **Walk is bounded** by checkpoints (explicit) and the 5-snapshot cap
  (implicit discipline reminder).

## Edge Cases

- **Newest snapshot is stale** (hours or days old, a new session after long
  idle): still synthesize, but flag in the header: "Last activity: {N} hours
  ago. Branch / test state may have drifted."
- **Newest snapshot has `status: final`**: report "Previous session marked
  this work finished. Do you want to resume anyway, or start something new?"
- **Checkpoint manifest (`contexts/checkpoints.md`) disagrees with
  `checkpoint: true` in a snapshot's frontmatter**: trust the snapshot's
  frontmatter. The manifest is a lookup convenience, not authoritative.
- **Multiple snapshots have the same `session-id`** (shouldn't happen, but
  clocks drift): sort by filename lexicographically, take the last.
- **Agent conflict across the chain** (e.g., backend-builder snapshot links
  to a ui-designer snapshot): surface this in the header: "Chain crosses
  agent boundaries — some decisions may not be yours to re-open."
