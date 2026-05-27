---
id: refactor-000-slug
type: refactor
status: draft
author-agent: null
created: YYYY-MM-DD
updated: YYYY-MM-DD
parent-plan: null
supersedes: null
superseded-by: null
branch: refactor/slug
affected-files: []
feature-area: null
priority: P1
attempt-count: 0
max-attempts: 5
motivation: null
---

<!-- STATUS STATE MACHINE
draft → approved → in-progress → completed → archived
                 → abandoned → archived
                 → superseded (by new plan) → archived

PLAN ID CONVENTION: refactor-{sequence}-{slug}
  e.g., refactor-001-db-layer, refactor-003-auth-middleware
-->

# refactor-000-slug: Refactor Title

## Current State

<!-- What does the code look like now? Which files/modules are involved?
     What's wrong with the current structure? Be specific. -->

## Desired State

<!-- What should it look like after the refactor?
     What properties does the new structure have that the old one lacks? -->

## Motivation

<!-- Why is this refactor worth doing NOW?
     - Performance concern?
     - Maintainability issue blocking a feature?
     - Tech debt causing repeated bugs?
     - Compliance/security requirement? -->

## Migration Strategy

<!-- How do we get from current to desired without breaking things?
     1. Create new module alongside old one
     2. Migrate consumers one at a time
     3. Verify each consumer still works
     4. Remove old module -->

## Affected Consumers

<!-- Which files/modules/apps import or depend on the code being refactored?
     List each with the change required. -->

| Consumer | File                   | Change Required    |
| -------- | ---------------------- | ------------------ |
| Example  | `apps/web/src/auth.ts` | Update import path |

## Validation Criteria

<!-- How do we confirm the refactor is correct?
     - All existing tests still pass
     - No new TypeScript errors
     - Performance benchmarks unchanged or improved
     - No consumer is still using old code paths -->

## Attempt Log

<!-- Populated automatically by agents.

RETRY POLICY:
  Attempt 1-2: Try different approaches
  Attempt 3: Run /plan-investigation
  Attempt 4: Try investigation's recommendation
  Attempt 5: STOP and escalate to human
  NEVER exceed 5 attempts on the same error
-->
