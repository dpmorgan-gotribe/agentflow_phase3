---
task-id: "002"
title: "Plan File Templates & Directory Structure"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: ["001"]
estimated-scope: small
---

# 002: Plan File Templates & Directory Structure

## What This Task Produces

Markdown templates for the four plan types (feature, bug, refactor, investigation) that the plan skills will use.

## Scope

Create four template files in `plans/templates/`:

### feature-plan.md

Template with YAML frontmatter:

- `id`, `type: feature`, `status: draft`, `author-agent`, `created`, `updated`
- `parent-plan`, `supersedes`, `superseded-by`, `branch`
- `affected-files`, `feature-area`, `priority`, `attempt-count: 0`, `max-attempts: 5`
  Body sections: Problem Statement, Approach, Rejected Alternatives (at least one), Expected Outcomes (checkboxes), Validation Criteria, Attempt Log.

### bug-plan.md

Same frontmatter + `error-message`, `reproduction-steps`, `stack-trace` fields.
Body sections: Bug Description, Reproduction Steps, Error Output, Root Cause Analysis, Fix Approach, Rejected Fixes, Validation Criteria, Attempt Log.

### refactor-plan.md

Same frontmatter + `motivation` field.
Body sections: Current State, Desired State, Migration Strategy, Affected Consumers, Validation Criteria, Attempt Log.

### investigation-plan.md

Same frontmatter + `time-box-minutes: 30`, `hypothesis` fields.
Body sections: Question, Hypothesis, Investigation Steps, Findings, Recommendation, Attempt Log.

### Also create `plans/active.md`

An auto-generated manifest template that lists all active plans with one-line status.

## Plan ID Convention

`{type}-{sequence}-{slug}`: e.g., `feat-001-user-auth`, `bug-042-login-crash`

## Status State Machine (document in each template header)

```
draft → approved → in-progress → completed → archived
                 → abandoned → archived
                 → superseded (by new plan) → archived
```

## Acceptance Criteria

- [ ] Four template files exist in `plans/templates/`
- [ ] Each has valid YAML frontmatter with all required fields
- [ ] Each has the correct body sections with placeholder guidance
- [ ] Status state machine documented in each
- [ ] `plans/active.md` manifest template exists

## Human Verification

Read each template — do the fields and sections cover what you'd need to track work effectively?
