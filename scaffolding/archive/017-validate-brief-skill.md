---
task-id: "017"
title: "/validate-brief Skill"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["015", "016"]
estimated-scope: small
---

# 017: /validate-brief Skill

## What This Task Produces

A skill at `.claude/skills/validate-brief/SKILL.md` that validates brief.md on demand.

## Scope

From blueprint lines 553-568:

### SKILL.md

```yaml
---
name: validate-brief
description: Validate brief.md structure, frontmatter, companion files, and embedded code blocks. Run before starting implementation.
when_to_use: before pipeline start, after brief edits, on demand
allowed-tools: Read Bash Grep Glob
---
```

### Skill Steps

1. `npx markdownlint-cli2 brief.md` — check section structure
2. `node scripts/validate-brief.mjs --frontmatter` — validate YAML against schema
3. `node scripts/validate-brief.mjs --codeblocks` — verify §7 and §10 have code blocks
4. `node scripts/validate-brief.mjs --companions` — check companion files exist
5. Report all errors with line numbers, or "Brief validation passed"

### PreToolUse Hook Integration

Also create the hook at `.claude/hooks/validate-brief.mjs` that runs on Write|Edit operations touching `brief.md` (from blueprint lines 538-550). This ensures agents can't write a malformed brief.

## Acceptance Criteria

- [ ] `.claude/skills/validate-brief/SKILL.md` exists
- [ ] Runs all four validation steps
- [ ] `.claude/hooks/validate-brief.mjs` exists for PreToolUse enforcement
- [ ] Reports errors with line numbers
- [ ] Clear pass/fail output

## Human Verification

Intentionally break a brief (remove a required field, delete §7 code block) and mentally trace: does the validation catch it?
