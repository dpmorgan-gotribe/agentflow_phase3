---
task-id: "032b"
title: "HTML Verifier Agent (Layer 6)"
status: pending
priority: P2
tier: 8 — Quality & Ship
depends-on: ["011", "022", "034"]
estimated-scope: small
---

# 032b: HTML Verifier Agent

## What This Task Produces

An independent agent at `.claude/agents/html-verifier.md` that implements §13 Layer 6 — a cheap, independent check on HTML output from the UI Designer (mockups, screens, user-flows). Uses Haiku because the task is mechanical validation, not generation.

## Why This Exists

Blueprint §13 L2146-2149 specifies: _"For the sycophantic self-evaluation problem, deploy a separate HTML Verifier agent using Haiku. Cheap, independent, catches what the generating agent misses."_ Without this agent as a real deliverable, Layer 6 is only a pattern description in task 034 — nothing in the pipeline actually runs it.

This sits alongside but distinct from:

- **Layer 4** (task 034 hook `validate-html-write.sh`) — mechanical regex checks on every Write
- **Reviewer agent** (task 032) — full architecture + compliance + quality review (Sonnet)

The Verifier is the middle layer: LLM-based, scoped narrowly to HTML correctness, runs every time the UI Designer produces HTML before the Reviewer sees it.

## Scope

### Agent Definition

```yaml
---
name: html-verifier
description: Independent second-pass check on UI Designer HTML output. Validates structure, token usage, and primitive adherence. Uses Haiku for cost and independence.
tools: Read, Grep, Glob
model: haiku
maxTurns: 8
effort: low
---
```

### System Prompt (key rules)

The agent is a strict mechanical verifier. It does NOT provide design feedback, does NOT suggest improvements. It answers one question: _"Does this HTML meet the contract?"_ The contract is:

1. **File is valid HTML** — starts with `<!doctype` or `<html`, parses as a tree (no dangling tags, no markdown fences)
2. **Uses design tokens, not hex values** — no raw `#rrggbb`, `rgb(...)`, or magic `px` values outside of explicit exceptions (borders 1px, etc.). All colors/spacing via CSS variables from `packages/tokens/`.
3. **Uses primitives, not ad-hoc components** — any button must use the `Button` primitive class, inputs use `Input`, cards use `Card`, etc., as defined in `packages/ui/primitives/`
4. **Includes required metadata** — `<title>`, viewport meta, screen-id data attribute matching the filename
5. **No markdown leakage** — zero occurrences of backtick code fences, `<pre><code>`, or raw markdown syntax like `**bold**`
6. **No placeholder content** — no `Lorem ipsum`, no `TODO`, no `[insert X here]` strings

### /verify-html Skill

Skill at `.claude/skills/verify-html/SKILL.md` (invoked by orchestrator after each HTML-producing stage):

```yaml
---
name: verify-html
description: Run html-verifier agent over a directory of HTML files. Returns pass/fail plus list of violations. Runs after /mockups, /screens, /user-flows-generator.
when_to_use: after any HTML-producing pipeline stage, before advancing
allowed-tools: Read Grep Glob
---
```

Steps:

1. Accept argument: target directory (e.g., `docs/mockups/`, `docs/screens/`)
2. Glob `*.html` in target
3. For each file, invoke `html-verifier` with the file path and the six contract rules above
4. Collect results into `pipeline/html-verify-{stage}-{timestamp}.json`:
   ```json
   {
     "stage": "mockups",
     "filesChecked": 12,
     "passed": 10,
     "failed": 2,
     "violations": [
       {
         "file": "docs/mockups/dashboard.html",
         "rule": "tokens",
         "detail": "Raw hex #4F46E5 at line 34"
       },
       {
         "file": "docs/mockups/settings.html",
         "rule": "primitives",
         "detail": "Custom button element; should use .Button primitive"
       }
     ]
   }
   ```
5. Return `{ success: <boolean>, passed, failed, violations }`

### Integration points

- **Orchestrator (task 035)** — after any HTML-producing stage, invoke `/verify-html` on the output directory. On failure: feed violations back into the generating stage's retry (Layer 5). Max 3 verifier-triggered retries before escalating.
- **Task 034 Layer 6** — this agent IS Layer 6. Update 034 to reference this task as the implementation.

## Acceptance Criteria

- [ ] `.claude/agents/html-verifier.md` exists with Haiku model and read-only tools
- [ ] System prompt enforces the six contract rules above, no generative behavior
- [ ] `.claude/skills/verify-html/SKILL.md` exists with the frontmatter shown
- [ ] Skill writes structured JSON to `pipeline/html-verify-{stage}-{timestamp}.json`
- [ ] Skill returns pass/fail + violations list
- [ ] Task 034 updated to point at this task for Layer 6 implementation
- [ ] Orchestrator (task 035) wires `/verify-html` into the post-HTML stages

## Human Verification

1. Hand-author a mockup that uses `#4F46E5` inline — does the verifier catch it?
2. Hand-author one that wraps text in markdown backticks — catch?
3. Hand-author one that uses a bare `<button>` instead of `.Button` primitive — catch?
4. Inspect the JSON violations file — is the detail actionable for retry feedback?

## Rationale: why Haiku

- **Independence** — different model family from Sonnet (the UI Designer), reducing correlated blind spots
- **Cost** — Haiku is roughly 1/10 the cost of Sonnet; this agent runs on every HTML file, so cost compounds
- **Task shape** — pattern matching over a small rubric, not creative reasoning; Haiku is adequate and faster
