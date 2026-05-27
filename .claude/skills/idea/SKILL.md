---
name: idea
description: Capture a half-baked thought to docs/ideas.md without ceremony. Lightweight alternative to /plan-feature when the idea is a one-liner you might revisit in 2 weeks. Stashes ideas as unticked markdown bullets with a timestamp. Promote to a real plan later via /idea-promote N.
when_to_use: when the user surfaces a "this would be useful but isn't critical path" thought mid-conversation; when Claude notices a follow-up that doesn't yet warrant the full plan-feature ceremony; when an operator wants to record a "someday/maybe" item for periodic review; explicitly NOT for blocking bugs or actively-needed features (those go straight to /plan-bug or /plan-feature)
argument-hint: <text — free-form description of the idea>
allowed-tools: Read Write Edit Bash
---

# /idea — Capture a half-baked thought

Appends one timestamped bullet to `docs/ideas.md` at the factory root.
Creates the file if absent. Reports the new total count.

## Steps

### 1. Validate input

- Argument is the free-form idea text. If empty, error:
  `/idea requires a description. Usage: /idea <text>.`
- Trim leading/trailing whitespace. Single-line bullets only — if the
  text contains a literal newline, replace with a space.

### 2. Pre-flight

Confirm CWD looks like the factory: `.claude/agents/` and
`brief-template.md` must both exist at CWD. If not, error:
`This doesn't look like the factory repo. Run /idea from the agentflow-phase2 root.`.

### 3. Ensure `docs/ideas.md` exists

If `docs/ideas.md` does not exist, create it with this header:

```
# Ideas

Half-baked thoughts captured via `/idea` for periodic review. Items
are unticked (`- [ ]`) by default. When an idea graduates to a real
plan via `/idea-promote N`, the bullet is marked `- [x]` with a
backref like `(→ feat-NNN-slug)`.

To review: `/idea-list`. To promote: `/idea-promote <N>` where N is
from the list output.

---

```

### 4. Append the new idea

Construct the line:

```
- [ ] YYYY-MM-DD HH:MM — <text>
```

Where the timestamp is current UTC, formatted as
`YYYY-MM-DD HH:MM` (no seconds; minute-precision is enough). Append
to the end of `docs/ideas.md` with a single trailing newline.

### 5. Report

Count the unticked bullets (`- [ ]`) in the file. Report:

```
Idea captured at docs/ideas.md (N unticked total)
Run `/idea-list` to review or `/idea-promote <N>` to graduate.
```

## Edge cases

- **Operator passes a multi-line text**: collapse to single line per
  step 1.
- **Operator runs `/idea` without args**: prompt the operator with
  the usage line.
- **`docs/ideas.md` exists but is malformed** (no header, weird
  encoding): append anyway, but warn that the file looks unusual.
- **The text matches an existing unticked idea verbatim**: warn but
  accept the duplicate. Operator may have a reason to re-capture.

## Cost

Free — pure file append. No SDK calls.

## See also

- `/idea-list` — review captured ideas
- `/idea-promote <N>` — graduate idea N to a real plan
- `/plan-feature` — heavier-weight alternative for ideas you're ready
  to commit to
