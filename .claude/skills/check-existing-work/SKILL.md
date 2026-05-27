---
name: check-existing-work
description: Search active and archived plans for work related to the current task. Run BEFORE starting any new work.
when_to_use: before any new plan, before investigating a bug, before starting implementation
argument-hint: [search-query — file path, feature name, or error message]
allowed-tools: Read Bash Grep Glob
---

# /check-existing-work — Find Related Prior Work

Search the plan archive before starting anything new. Agents that skip this step
duplicate effort or re-attempt fixes that have already failed. This skill
returns **summaries with file references only** — it never pastes full plan
content into the caller's context. The caller decides what to read in detail.

## Steps

### 1. Get the search query

- If `$ARGUMENTS` is provided, use it as the query (may be a file path, feature
  name, error message, or free text)
- If empty, ask the user: "What should I search for? Give me a file path,
  feature name, or error message."

### 2. Extract search keywords

- Strip punctuation, lowercase, drop stop words (the, a, an, of, for, and, or,
  to, in, is, on)
- Keep the 2–4 most distinctive terms. For error messages, favor the unique
  symbol/function/module names over generic words like "error" or "failed"
- If the query is a file path, also search by the basename (e.g.,
  `auth.ts` → also match `auth`)

### 3. Search the three plan directories

Run these greps (case-insensitive, list files only):

- `grep -rlI -i "<keyword>" plans/active/ 2>/dev/null`
- `grep -rlI -i "<keyword>" plans/archive/ 2>/dev/null`
- `grep -rlI -i "<keyword>" plans/superseded/ 2>/dev/null`

Run one grep per keyword, then union the file lists. If no keyword is
distinctive enough to run alone, combine with `grep -E` alternation:
`grep -rlI -iE "kw1|kw2|kw3" plans/active/ ...`

If any of the three directories is missing, skip it silently — do not error.

### 4. For each matching plan file, extract a summary

Read just the frontmatter plus the first body heading. From each file capture:

- `id`
- `type` (feature | bug | refactor | investigation)
- `status` (draft | approved | in-progress | completed | abandoned | superseded | archived)
- `outcome` (if archived: one-line outcome from frontmatter or the Outcome section)
- `priority`
- One-line summary — prefer the first sentence under `# {id}: Title` or the
  Problem Statement / Bug Description opening line
- File path (relative to repo root)

Do NOT paste plan body content into your output. Summaries only.

### 5. Group and present results

Group by directory so the caller can see status at a glance:

```
ACTIVE (n):
  - {id} [{type}/{status}/{priority}] — {one-line summary}
    plans/active/{id}.md

ARCHIVED (n):
  - {id} [{type}/{outcome}] — {one-line summary}
    plans/archive/{id}.md

SUPERSEDED (n):
  - {id} [{type}, superseded-by {new-id}] — {one-line summary}
    plans/superseded/{id}.md
```

Omit any group that has zero matches.

### 6. Emit a clear verdict

After the grouped list, print one of:

- **`Related work exists — review before proceeding.`** — if any matches
  found. If an archived match appears highly similar (same keywords appear in
  title), add: "Read {path} and its lessons section before starting."
- **`No related work found — safe to proceed.`** — if all three searches
  returned zero files.

### 7. Return, do not recurse

This skill does not create plans, edit files, or take follow-up action. The
caller decides what to do with the result.

## Key Design Decision

Returns **summaries with file references**, not full plan content. This keeps
context usage minimal and lets the caller pull in only the plan bodies they
actually need.

## Edge Cases

- **Query is too generic** (e.g., `user`, `error`, `test`): matches will be
  noisy. Still return them, but prefix the verdict with: "Query is broad — many
  matches may be unrelated. Consider narrowing the search."
- **Directories don't exist yet**: a new project may not have
  `plans/archive/` or `plans/superseded/`. Treat missing directories as empty,
  not as errors.
- **Binary or non-markdown files in plan dirs**: the `-I` flag on grep already
  skips binaries. Ignore anything that isn't `*.md`.
- **Match is in a `lessons-learned` section of a superseded plan**: surface it
  prominently — prior lessons are the most valuable signal this skill can find.
- **Called by another skill vs. directly by a user**: behavior is identical.
  Callers that invoke this programmatically should parse the grouped output.
