---
id: feat-000-slug
type: feature
status: draft
author-agent: null
created: YYYY-MM-DD
updated: YYYY-MM-DD
parent-plan: null
supersedes: null
superseded-by: null
branch: feat/slug
affected-files: []
feature-area: null
priority: P0
attempt-count: 0
max-attempts: 5
---

<!-- STATUS STATE MACHINE
draft → approved → in-progress → completed → archived
                 → abandoned → archived
                 → superseded (by new plan) → archived

Only PM or human can transition draft → approved.
Executing agent transitions approved → in-progress and in-progress → completed.
HITL gate can force → abandoned.
Superseded requires a superseded-by reference.

PLAN ID CONVENTION: feat-{sequence}-{slug}
  e.g., feat-001-user-auth, feat-012-dashboard-charts
-->

# feat-000-slug: Feature Title

## Problem Statement

<!-- What problem does this feature solve? Reference brief.md sections where applicable.
     e.g., "Users cannot reset their passwords. See brief.md § 13. Security" -->

## Approach

<!-- Numbered implementation steps. Be specific about files, modules, and patterns.
     1. Create Zod schema in packages/types/src/...
     2. Add tRPC router in apps/api/routes/...
     3. Build UI component in apps/web/... -->

## Rejected Alternatives

<!-- At least ONE alternative must be listed with reasoning for rejection.
     This forces thinking about tradeoffs before implementation begins. -->

- **Alternative A** — Rejected because: ...

## Expected Outcomes

<!-- Checkboxes that define "done". Each must be testable. -->

- [ ] Outcome 1
- [ ] Outcome 2
- [ ] Outcome 3

## Validation Criteria

<!-- How do we verify the feature works correctly?
     - Specific tests that must pass
     - Manual verification steps
     - Performance thresholds if applicable -->

## Attempt Log

<!-- Populated automatically by agents. Each attempt records:
     - Attempt number
     - Timestamp
     - What was tried
     - What happened (success/failure)
     - Error output if applicable
     - What to try differently next time

RETRY POLICY:
  Attempt 1-2: Try different approaches
  Attempt 3: Run /plan-investigation
  Attempt 4: Try investigation's recommendation
  Attempt 5: STOP and escalate to human
  NEVER exceed 5 attempts on the same error
-->
