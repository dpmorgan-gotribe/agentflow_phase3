---
id: bug-000-slug
type: bug
status: draft
author-agent: null
created: YYYY-MM-DD
updated: YYYY-MM-DD
parent-plan: null
supersedes: null
superseded-by: null
branch: fix/slug
affected-files: []
feature-area: null
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: null
stack-trace: null
---

<!-- STATUS STATE MACHINE
draft → approved → in-progress → completed → archived
                 → abandoned → archived
                 → superseded (by new plan) → archived

PLAN ID CONVENTION: bug-{sequence}-{slug}
  e.g., bug-001-login-crash, bug-042-zod-nullish
-->

# bug-000-slug: Bug Title

## Bug Description

<!-- What is broken? When did it start? What is the expected vs actual behavior? -->

## Reproduction Steps

<!-- Numbered steps to reliably trigger the bug.
     1. Navigate to /settings
     2. Click "Save" without changing anything
     3. Observe: 500 error in console -->

## Error Output

<!-- Paste the exact error message, stack trace, or failing test output.
     Use code blocks for readability. -->

```
Paste error output here
```

## Root Cause Analysis

<!-- After investigation, document the root cause.
     What is actually wrong in the code? Which file, which line, which logic? -->

## Fix Approach

<!-- Numbered steps for the fix.
     1. Change X in file Y
     2. Add validation for Z
     3. Update tests -->

## Rejected Fixes

<!-- What was considered and why it was rejected? -->

- **Fix A** — Rejected because: ...

## Validation Criteria

<!-- How do we confirm the bug is fixed?
     - Specific test that was failing and must now pass
     - Manual reproduction steps that must no longer trigger the bug
     - Regression tests to prevent recurrence -->

## Attempt Log

<!-- Populated automatically by agents.

RETRY POLICY:
  Attempt 1-2: Try different approaches
  Attempt 3: Run /plan-investigation
  Attempt 4: Try investigation's recommendation
  Attempt 5: STOP and escalate to human
  NEVER exceed 5 attempts on the same error
-->
