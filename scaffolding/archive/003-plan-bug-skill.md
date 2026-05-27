---
task-id: "003"
title: "/plan-bug Skill"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: ["002"]
estimated-scope: small
---

# 003: /plan-bug Skill

## Why This Is Priority #3

You specifically called out `/plan-bug`. Building this first means that as we encounter issues while constructing the rest of the system, we have a structured way to track and resolve them. We eat our own dog food from day one.

## What This Task Produces

A skill at `.claude/skills/plan-bug/SKILL.md` that creates bug investigation plans.

## Scope

### SKILL.md Content

```yaml
---
name: plan-bug
description: Create a new bug investigation plan. Use when encountering errors, unexpected behavior, or failing tests.
when_to_use: bug report, error, crash, failing test, unexpected behavior
argument-hint: [bug-description]
allowed-tools: Read Write Bash Grep Glob
---
```

### Skill Steps

1. Accept bug description from `$ARGUMENTS` or ask user
2. Run `/check-existing-work` (if it exists yet — graceful skip if not)
3. Generate next plan ID: count existing `bug-*.md` files in `plans/active/` + `plans/archive/` + 1
4. Read `plans/templates/bug-plan.md`
5. Fill in: bug description, reproduction steps (from user or detected), error output, affected files (by searching codebase for related code)
6. Set `status: draft`, `attempt-count: 0`
7. Write to `plans/active/bug-{ID}-{slug}.md`
8. Create git branch: `fix/{slug}`
9. Report: "Bug plan created at `plans/active/bug-{ID}-{slug}.md`. Review and approve to start investigation."

### Edge Cases

- If similar bug plan exists in archive, warn: "Similar bug was investigated before — check lessons"
- If `$ARGUMENTS` is empty, prompt for description

## Acceptance Criteria

- [ ] `.claude/skills/plan-bug/SKILL.md` exists with valid frontmatter
- [ ] Skill steps are clear and complete
- [ ] Template references `plans/templates/bug-plan.md`
- [ ] ID generation logic is specified
- [ ] Git branch creation is included

## Human Verification

Try mentally walking through: "I hit a Zod validation error in the backend. I run `/plan-bug Zod refuses nullish on user bio field`." Does the skill produce a useful, actionable plan file?
