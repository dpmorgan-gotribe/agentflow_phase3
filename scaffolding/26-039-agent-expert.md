---
task-id: "039"
title: "Agent Expert (Meta-Agent)"
status: pending
priority: P3
tier: 10 — Meta & Compliance
depends-on: ["037", "038"]
estimated-scope: small
---

# 039: Agent Expert (Meta-Agent)

## What This Task Produces

Agent definition at `.claude/agents/agent-expert.md`.

## Scope

From blueprint lines 247-248 and Section 21 (lines 2709-2721):

### Agent Definition

```yaml
---
name: agent-expert
description: Detects repeating task patterns without a dedicated agent, analyzes the pattern, writes new agent or skill definitions, validates, and adds to .claude/agents/.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
maxTurns: 30
effort: max
---
```

### Self-Improvement Loop

1. Detect repeating manual pattern
2. Analyze requirements (inputs, steps, outputs)
3. Author new SKILL.md or agent definition
4. Validate on minimal test case
5. Deposit in appropriate library
6. "System is now better at this task forever"

### Versioning

Agent and skill files are treated as code:

- Commit to version control
- Semantic versioning in SKILL.md description
- Keep previous versions in `_archive/` until validated

### Important Note

This is the last agent to build because it requires observing actual pipeline runs to detect patterns. You can't capture patterns until you have runs to observe.

## Acceptance Criteria

- [ ] `.claude/agents/agent-expert.md` exists
- [ ] Self-improvement loop documented
- [ ] Versioning strategy documented
- [ ] Uses `meta` tier (Opus — high-stakes system-building)

## Human Verification

Does the self-improvement loop feel safe? Are there guardrails to prevent the meta-agent from creating poor-quality agents?
