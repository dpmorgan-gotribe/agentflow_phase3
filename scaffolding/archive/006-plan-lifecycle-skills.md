---
task-id: "006"
title: "/plan-status, /plan-archive, /plan-search, /plan-refactor, /plan-investigation Skills"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: ["002", "003", "004", "005"]
estimated-scope: medium
---

# 006: Remaining Plan Lifecycle Skills

## What This Task Produces

The remaining plan management skills that complete the work management system.

## Skills to Create

### /plan-status

`.claude/skills/plan-status/SKILL.md`

- List all active plans with: ID, type, status, priority, branch, one-line summary
- Show attempt counts and warn if any are near max (5)
- Optionally filter by type or status

### /plan-archive

`.claude/skills/plan-archive/SKILL.md`

- Move a completed/abandoned plan from `plans/active/` to `plans/archive/`
- Append a completion record YAML block: outcome (success/partial/failed/abandoned), actual files changed, commits, attempts, lessons, test results, duration
- Update `plans/active.md` manifest

### /plan-search

`.claude/skills/plan-search/SKILL.md`

- Search across active + archived + superseded plans
- Accept: keywords, file paths, feature areas, error messages
- Return structured results with file references (like /check-existing-work but more powerful)
- Support filtering by outcome: `--failed`, `--success`, `--abandoned`

### /plan-refactor

`.claude/skills/plan-refactor/SKILL.md`

- Same pattern as /plan-feature but uses `plans/templates/refactor-plan.md`
- Emphasizes: current state, desired state, migration strategy, affected consumers

### /plan-investigation

`.claude/skills/plan-investigation/SKILL.md`

- Time-boxed research plan (default 30 minutes)
- Uses `plans/templates/investigation-plan.md`
- Emphasizes: question, hypothesis, investigation steps, findings, recommendation
- This is what agents escalate to at attempt #3

## Acceptance Criteria

- [ ] All five skills exist as SKILL.md files
- [ ] /plan-archive appends the completion record format from blueprint (lines 1077-1098)
- [ ] /plan-search supports outcome filtering
- [ ] /plan-investigation includes time-box field

## Human Verification

Walk through the lifecycle: create a feature plan → work on it → hit a bug → create bug plan → investigate → archive both. Does the tooling support this flow end to end?
