---
task-id: "004"
title: "/plan-feature Skill"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: ["002"]
estimated-scope: small
---

# 004: /plan-feature Skill

## What This Task Produces

A skill at `.claude/skills/plan-feature/SKILL.md` that scaffolds new feature implementation plans.

## Scope

### SKILL.md Content

```yaml
---
name: plan-feature
description: Create a new feature implementation plan. Use when adding new functionality to the system.
when_to_use: new feature, new capability, adding functionality
argument-hint: [feature-description]
allowed-tools: Read Write Bash Grep Glob
---
```

### Skill Steps

1. Accept feature description from `$ARGUMENTS` or ask user
2. Run `/check-existing-work` — verify no duplicate plans
3. Generate next plan ID: count existing `feat-*.md` files + 1
4. Read `plans/templates/feature-plan.md`
5. Fill in:
   - Problem statement (from brief.md reference if it exists)
   - Approach (proposed implementation steps)
   - Affected files (by searching codebase for related code)
   - Expected outcomes (as checkboxes)
   - Rejected alternatives (at least one — forces thinking about tradeoffs)
6. Set `status: draft`, `attempt-count: 0`
7. Write to `plans/active/feat-{ID}-{slug}.md`
8. Create git branch: `feat/{slug}`
9. Report: "Plan created. Review and approve to start implementation."

## Acceptance Criteria

- [ ] `.claude/skills/plan-feature/SKILL.md` exists with valid frontmatter
- [ ] At least one rejected alternative is required
- [ ] Brief.md reference included when brief exists
- [ ] Git branch creation included

## Human Verification

Does this produce plans with enough structure to prevent aimless implementation?
