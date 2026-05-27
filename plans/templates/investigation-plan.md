---
id: investigate-000-slug
type: investigation
status: draft
author-agent: null
created: YYYY-MM-DD
updated: YYYY-MM-DD
parent-plan: null
supersedes: null
superseded-by: null
branch: null
affected-files: []
feature-area: null
priority: P1
attempt-count: 0
max-attempts: 5
time-box-minutes: 30
hypothesis: null
---

<!-- STATUS STATE MACHINE
draft → approved → in-progress → completed → archived
                 → abandoned → archived

Investigations do NOT create branches by default — they are research tasks.
If the investigation leads to code changes, create a follow-up feature or bug plan.

PLAN ID CONVENTION: investigate-{sequence}-{slug}
  e.g., investigate-001-zod-nullish, investigate-005-perf-regression

TIME BOX: Investigations have a default 30-minute time box.
  When time expires, document findings (even if incomplete) and recommend next steps.
  Do not exceed the time box — partial findings are better than no findings.
-->

# investigate-000-slug: Investigation Title

## Question

<!-- What specific question are we trying to answer?
     e.g., "Why does Zod reject z.string().nullable().optional() in our schema?" -->

## Hypothesis

<!-- What do we think the answer is BEFORE investigating?
     Having a hypothesis focuses the investigation and makes it falsifiable. -->

## Investigation Steps

<!-- Numbered steps to systematically investigate.
     1. Read the Zod documentation for nullable vs nullish
     2. Check our schema definition at packages/types/src/user.ts
     3. Test with a minimal reproduction
     4. Search for related issues in Zod GitHub -->

## Findings

<!-- What did we learn? Document everything, even dead ends.
     Include code snippets, links, and error outputs. -->

## Recommendation

<!-- Based on findings, what should we do?
     - Create a bug plan: /plan-bug [description]
     - Create a feature plan: /plan-feature [description]
     - No action needed — document why
     - Escalate to human — document what's still unclear -->

## Attempt Log

<!-- Populated automatically by agents.

NOTE: Investigations are what agents escalate to at attempt #3 of a bug or feature.
  This is the structured research step that prevents blind retrying.
-->
