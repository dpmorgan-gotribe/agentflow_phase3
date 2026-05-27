---
task-id: "015"
title: "Brief Schema & Frontmatter Validation"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["001"]
estimated-scope: small
---

# 015: Brief Schema & Frontmatter Validation

## What This Task Produces

A JSON Schema file at `schemas/brief-frontmatter.schema.json` that validates brief.md frontmatter.

## Scope

From blueprint lines 471-518:

### Frontmatter Fields to Validate

- `$schema` (string, reference to this schema)
- `version` (semver string, required)
- `status` (enum: draft | review | approved | locked)
- `project-name` (string, required)
- `author` (string, required)
- `created` (date, required)
- `last-modified` (date, required)
- `brief-schema-version` (string, required)
- `companion-files` (array of objects: path, type, required)
- `tags` (array of strings)
- `amendments` (array of objects: sections-affected, downstream-impact)

### JSON Schema

Write a standard JSON Schema draft-2020-12 that validates all above fields with correct types, required fields, and enum constraints.

### Also Create

- `schemas/navigation.schema.json` — placeholder (to be filled when companion files are defined)
- `scripts/validate-brief.mjs` — runnable Node script with four flags detailed below

### Markdownlint config (owned by task 016, not here)

The `.markdownlint.jsonc` enforcing MD043 on brief.md structure is task **016**'s deliverable. This task owns the frontmatter JSON Schema and the validator script only — they're separate concerns. If 016 hasn't yet shipped, the validator's `--structure` (markdownlint) check is a no-op that returns success with a warning.

### scripts/validate-brief.mjs — output contract

The script is the runtime that the `/validate-brief` skill (task 017) and CI workflow (§5 L524-534) both call. Each flag must produce a predictable stdout/stderr contract:

| Flag            | What it does                                                                                                                                                                                       | On success (stdout)                       | On failure (stderr, exit 1)                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `--frontmatter` | Parse YAML frontmatter block from `brief.md`; validate against `schemas/brief-frontmatter.schema.json` using Ajv (draft-2020-12)                                                                   | `✓ Frontmatter valid`                     | Each error on its own line: `brief.md:<line>: <json-pointer>: <ajv-message>`  |
| `--codeblocks`  | Verify §7 (Architecture Overview) and §10 (Navigation Schema) each contain at least one fenced code block                                                                                          | `✓ Code blocks present in §7, §10`        | `brief.md: §<N> (<title>) missing required code block` (one line per missing) |
| `--companions`  | For every entry in frontmatter `companion-files[]`, check the path exists and is readable; if `type: navigation`, also validate against `schemas/navigation.schema.json` when it's non-placeholder | `✓ All companion files present and valid` | `brief.md: companion-files[<i>].path '<path>': <reason>`                      |
| `--structure`   | Run `npx markdownlint-cli2 brief.md` using `.markdownlint.jsonc` (from task 016). No-op with warning if config absent                                                                              | `✓ Structure (markdownlint) valid`        | Passes markdownlint's own output through; non-zero exit if violations         |
| `--all`         | Run all four flags in order; stop on first failure OR continue with `--keep-going`                                                                                                                 | `✓ Brief validation passed`               | Aggregated errors from all phases; non-zero exit if any failed                |

Every error line MUST include the file path and (when possible) line number so editors and CI can click through. The skill (task 017) relies on this format verbatim — don't change it without updating 017.

Implementation notes:

- Use Ajv with `ajv-formats` for `date` format validation on `created` / `last-modified`
- Use `gray-matter` to extract YAML frontmatter reliably (handles `---` fences + UTF BOM)
- Parse code blocks via a simple regex over fenced-block open/close — don't require a full markdown parser
- Exit codes: 0 = all checks passed, 1 = at least one check failed, 2 = invocation error (missing file, bad args)

## Acceptance Criteria

- [ ] `schemas/brief-frontmatter.schema.json` exists and is valid JSON Schema draft-2020-12
- [ ] All frontmatter fields from blueprint L473-492 are covered: `$schema`, `version`, `status` (enum), `project-name`, `author`, `created`, `last-modified`, `brief-schema-version`, `companion-files[]`, `tags[]`, `amendments[]`
- [ ] `scripts/validate-brief.mjs` implements all five flags (`--frontmatter`, `--codeblocks`, `--companions`, `--structure`, `--all`)
- [ ] Output format matches the contract above (line-prefixed errors with file:line)
- [ ] Exit codes follow the 0/1/2 convention
- [ ] `--structure` gracefully no-ops with a warning if `.markdownlint.jsonc` (task 016) hasn't shipped yet
- [ ] CI workflow at `.github/workflows/validate-brief.yml` created per §5 L524-534
- [ ] Schema enforces required fields and enum values

## Human Verification

Review the schema — are any frontmatter fields missing? Is the validation strict enough?
