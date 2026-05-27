---
task-id: "037"
title: "Lessons Agent"
status: pending
priority: P3
tier: 10 — Meta & Compliance
depends-on: ["006"]
estimated-scope: small
---

# 037: Lessons Agent

## What This Task Produces

Agent definition at `.claude/agents/lessons-agent.md`.

## Scope

From blueprint Section 21 (lines 2699-2721):

### Agent Definition

```yaml
---
name: lessons-agent
description: Captures lessons from pipeline runs. Records error patterns and solutions. Updates CLAUDE.md files and agent memory.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
maxTurns: 20
effort: medium
---
```

### Three Scopes of Lessons

1. **Global** (`~/.claude/CLAUDE.md`) — applies across all projects
2. **Project** (`./CLAUDE.md` or `docs/lessons.md`) — project-specific
3. **Agent** (`.claude/agent-memory/<name>/MEMORY.md`) — agent-specific refinements

### Triggers

- Builder hits error requiring multiple attempts
- Reviewer finds recurring issue
- Plan archives with surprising lessons
- Pipeline stage fails and recovers

### Lesson Format

Each lesson captures: what happened, why it happened, what the fix was, and where the lesson applies.

## Acceptance Criteria

- [ ] `.claude/agents/lessons-agent.md` exists
- [ ] Three scope levels documented
- [ ] Trigger conditions specified
- [ ] Lesson format defined
- [ ] Writes to correct locations per scope

## Human Verification

Is the lesson capture comprehensive enough? Should lessons also feed into the plan templates?
