---
name: validate-brief
description: Validate brief.md structure, frontmatter, companion files, and embedded code blocks. Run before starting implementation, after brief edits, or when something seems off.
when_to_use: before pipeline start, after brief edits, when the brief is referenced but behavior seems wrong, on demand
argument-hint: [--keep-going]
allowed-tools: Read Bash Grep Glob
---

# /validate-brief — Verify brief.md is pipeline-ready

Runs the full validation suite against `brief.md`. This is the on-demand
checker. A PreToolUse hook (`.claude/hooks/validate-brief.mjs`) also runs
automatically on Write/Edit/MultiEdit targeting brief.md — the skill is for
when you want to run the checks yourself (e.g., after a manual edit, before
kicking off the pipeline, or to audit a brief handed to you).

Three layers total protect the brief:

1. **CI** — `.github/workflows/validate-brief.yml` (every PR)
2. **Hook** — `.claude/hooks/validate-brief.mjs` (agent-time, blocks bad writes)
3. **This skill** — on-demand, run by you

## Steps

### 1. Check brief.md exists

- If not present, report: "No brief.md at project root. Run `/new-project
<name>` to scaffold one, or copy `brief-template.md` to `brief.md` and
  fill it in."
- Exit cleanly — nothing else to validate.

### 2. Run the four validation phases

Invoke `scripts/validate-brief.mjs --all` (which sequences the four
sub-checks in order, stopping on the first failure):

```
node scripts/validate-brief.mjs --all
```

Pass `--keep-going` through from `$ARGUMENTS` if the user wants all errors
reported at once instead of stopping at the first failing phase:

```
node scripts/validate-brief.mjs --all --keep-going
```

The phases and what each catches:

- `--frontmatter` — YAML frontmatter violates the JSON Schema at
  `schemas/brief-frontmatter.schema.json` (wrong type, missing required
  field, bad enum value, invalid date).
- `--codeblocks` — §7 Architecture Overview or §10 Navigation Schema is
  missing a fenced code block.
- `--companions` — a `companion-files[].path` is missing or unreadable, or
  a `type: navigation` companion fails `schemas/navigation.schema.json`.
- `--brief-capabilities` (feat-023) — when `docs/brief-capabilities.json`
  exists alongside brief.md, validates it against
  `schemas/brief-capabilities.schema.json` and asserts capability IDs are
  unique within the file. No-op pass when the file is absent (pre-feat-023
  projects).
- `--structure` — markdownlint MD043 (20-section headings in the exact
  order). No-ops with a warning if `.markdownlint.jsonc` hasn't shipped.

### 3. Interpret the exit code

- `0` — all checks passed. Report: `✓ Brief validation passed.`
- `1` — at least one check failed. The script already wrote each error as
  `brief.md:<line>: <json-pointer>: <message>` to stderr — quote that
  output verbatim in your response so the caller can click through. Do NOT
  summarize or rephrase errors; the line format is contracted.
- `2` — invocation error (missing file, missing dep, bad args). Report the
  underlying stderr message and stop.

### 4. If errors exist, guide the next action

After listing errors, append a one-line next-action recommendation:

- If only `--frontmatter` failed: "Fix the YAML frontmatter in brief.md
  and re-run."
- If `--codeblocks` failed: "Add a fenced code block to the indicated
  section(s) and re-run."
- If `--companions` failed: "Check that each companion file path in
  frontmatter points to an existing file."
- If `--structure` failed: "Fix heading structure per markdownlint's
  output (typically a missing or out-of-order section)."
- If multiple phases failed: "Fix the frontmatter errors first — later
  phases may be cascading from them."

## Key Design

- **Script does the work, skill is the interface.** The skill orchestrates
  but doesn't duplicate validation logic. Every rule lives in
  `scripts/validate-brief.mjs` or in the JSON Schema.
- **Error format is contracted.** The `brief.md:<line>: …` lines are what
  editors and CI parse. Don't reformat.
- **Fail-fast by default, fail-slow with `--keep-going`.** Catching one
  error at a time is usually faster to fix.

## Edge Cases

- **Missing deps** (Ajv / gray-matter not installed): script exits 2 with
  install instructions. Surface those instructions directly.
- **brief.md is encoded with a BOM**: `gray-matter` handles this —
  shouldn't cause issues.
- **brief.md has CRLF line endings on Windows**: still validates fine;
  report line numbers as-is.
