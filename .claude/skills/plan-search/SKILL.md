---
name: plan-search
description: Search active, archived, and superseded plans with rich filters (outcome, type, feature-area, affected-file). Extends /check-existing-work.
when_to_use: researching prior work before a refactor, auditing failed attempts, tracing who touched a file
argument-hint: [query] [--failed|--success|--abandoned|--partial] [--type …] [--feature-area …] [--file path/to/file]
allowed-tools: Read Bash Grep Glob Skill
---

# /plan-search — Rich Plan Archive Query

`/check-existing-work` answers "is there related work?" before starting.
`/plan-search` answers deeper questions: "show me every refactor that failed
in the auth area" or "who has ever touched `packages/api/routes/auth.ts`".

## Steps

### 1. Parse arguments

Split `$ARGUMENTS` into:

- **query string**: free text not prefixed by `--`
- **outcome filters**: `--failed`, `--success`, `--abandoned`, `--partial`
  (multiple allowed — OR'd)
- **type filter**: `--type feature|bug|refactor|investigation`
- **feature-area filter**: `--feature-area <area>`
- **file filter**: `--file <path>` — match plans whose `affected-files`
  frontmatter or completion record `actual-files-changed` contains the path

If query is empty AND no filters are supplied, ask: "What are you searching
for? Provide a query, a filter, or both."

### 2. Delegate base search to /check-existing-work

If there is a query string, invoke `/check-existing-work <query>` and capture
the file paths it returns. This keeps keyword-extraction logic in one place.

If no query, list candidate files directly:

- `ls plans/active/*.md plans/archive/*.md plans/superseded/*.md 2>/dev/null`
  — skip manifest files (`plans/active.md`)

### 3. Apply structured filters

For each candidate file, read frontmatter + (if archived) the completion
record. Drop any file where:

- `--type` does not match the `type` field
- `--feature-area` does not match the `feature-area` field
- `--file` path is not in `affected-files` or `actual-files-changed`
- Outcome filters are supplied and the file's outcome does not match any of
  them. Active and superseded plans have no outcome — they pass outcome
  filters only if no outcome filter was supplied.

Use `grep` for the file filter since paths can be long:
`grep -l "<path>" plans/archive/*.md plans/active/*.md 2>/dev/null`

### 4. Group and render

Group by directory (ACTIVE, ARCHIVED, SUPERSEDED) identical to
`/check-existing-work`'s output. Add one extra column to archived results —
outcome:

```
ARCHIVED (3):
  - feat-007-payments [feature/success/P0] — Stripe integration end-to-end
    plans/archive/feat-007-payments.md
  - bug-014-webhook-dup [bug/failed/P1] — Stripe webhook delivered twice under high load
    plans/archive/bug-014-webhook-dup.md
  - refactor-003-billing [refactor/abandoned/P2] — Split billing into its own service
    plans/archive/refactor-003-billing.md
```

### 5. Emit a summary line

After the grouped list:

```
Found {N} plans matching {query-and-filters}.
Outcomes: {success: 2, failed: 1} across {types}.
```

If zero results, print: "No plans match. Try broader filters or drop the
query." — no "safe to proceed" verdict here; this skill is for research,
not pre-work gating.

## Filter Examples

- `/plan-search --failed --feature-area auth` — every failed auth plan
- `/plan-search zod --type bug` — bug plans mentioning Zod
- `/plan-search --file packages/api/routes/auth.ts` — every plan that touched
  this file
- `/plan-search migration --abandoned` — abandoned migration work (avoid
  repeating)

## Edge Cases

- **Outcome filter on a plan with no completion record**: active and
  superseded plans have no `outcome` yet. Skip them when any outcome filter
  is present. Do not treat missing outcome as "success".
- **Malformed completion record**: if an archived plan has a broken
  completion record YAML block, include it in results with a warning:
  `⚠  {id} has an unparseable completion record.`
- **File filter with partial paths**: match by substring (so
  `--file routes/auth.ts` matches `packages/api/routes/auth.ts`). Warn if
  matches exceed 20 — query may be too broad.
- **`/check-existing-work` unavailable**: fall back to the raw greps from
  that skill's step 3 (documented in scaffolding/archive/005).
