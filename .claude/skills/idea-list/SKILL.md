---
name: idea-list
description: Enumerate ideas captured in docs/ideas.md, numbered for /idea-promote. Default shows only unticked (still-pending) ideas. --all includes promoted (ticked) entries with their backref plan IDs. --since <date> filters by capture date.
when_to_use: before /idea-promote to find the right number; periodically (e.g. weekly) to review the someday/maybe pile and promote, edit, or drop stale entries; when the operator asks "what ideas do we have stashed?"
argument-hint: [--all] [--since <YYYY-MM-DD>]
allowed-tools: Read Bash
---

# /idea-list — Review captured ideas

Reads `docs/ideas.md` and prints captured ideas numbered. Default
shows only unticked items (the active queue). `--all` includes
promoted entries (history). `--since <date>` filters by capture date.

## Steps

### 1. Pre-flight

Confirm `docs/ideas.md` exists at the factory root. If not:

```
No ideas captured yet — docs/ideas.md does not exist.
Run `/idea <text>` to capture your first idea.
```

Exit cleanly.

### 2. Parse arguments

- `--all` (boolean): include ticked (`- [x]`) entries.
- `--since <date>`: filter to ideas captured on/after this date.
  Format: `YYYY-MM-DD`. If the format is invalid, error.

### 3. Read + parse `docs/ideas.md`

Each idea line matches this regex (loose):

```
^- \[( |x)\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.+)$
```

Where group 1 = ticked-flag, group 2 = capture timestamp, group 3 =
the idea text (with optional trailing `(→ plan-id)` backref).

Skip lines that don't match (header text, blanks, etc.).

### 4. Apply filters

- If `--all` not passed, drop ticked entries.
- If `--since <date>` passed, drop entries older than that date.

### 5. Render

If the filtered list is empty:

```
No matching ideas. (Total in file: <U> unticked, <T> ticked)
```

Otherwise, number each entry starting from 1. Format:

```
Ideas in docs/ideas.md
   <U> unticked, <T> ticked, showing <K> filtered

  1. [ ] 2026-04-29 14:32 — DAG observability via tree render of …
  2. [ ] 2026-04-29 14:35 — Idea-bucket promote-on-stale nudge
  3. [x] 2026-04-28 09:12 — bug-020 Layer 3 timestamp work (→ bug-024-…)
  …

To promote: /idea-promote <N>
```

The number column matches the unticked-only ordering by default; with
`--all`, it follows file order including ticked items.

### 6. Edge cases

- **`docs/ideas.md` missing**: Step 1 handles.
- **Header-only file (no bullets)**: print `No ideas captured yet.`
- **Mid-file corrupt line**: skip silently; report tally at end as
  `<K> recognized, <X> skipped (malformed)`.
- **Operator passes both `--all` and `--since`**: both apply
  (intersection — ticked OR unticked, but only those after the date).

## Cost

Free — pure file read.

## See also

- `/idea <text>` — capture a new idea
- `/idea-promote <N>` — graduate idea N to a real plan
