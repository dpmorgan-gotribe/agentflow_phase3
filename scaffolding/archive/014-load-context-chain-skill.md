---
task-id: "014"
title: "/load-context-chain Skill"
status: complete
priority: P1
tier: 3 — Configuration & Context
depends-on: ["013"]
estimated-scope: small
---

# 014: /load-context-chain Skill

## What This Task Produces

A skill at `.claude/skills/load-context-chain/SKILL.md` that reconstructs work state by following the context chain backward.

## Scope

From blueprint lines 1391-1409:

### Skill Steps

1. Find most recent context in `contexts/` (sorted by filename)
2. Read that context fully
3. If checkpoint: stop — you have complete state
4. Otherwise: follow frontmatter `previous-context` to next file
5. Keep following until:
   a. You reach a checkpoint (stop)
   b. You've read 5 non-checkpoint snapshots (stop, summarize and warn)
   c. Chain breaks (previous-context file missing) — warn user
6. Synthesize: summarize what's been done, current state, next steps, open questions, key files
7. Report this to the user before acting

### Key Design

- Checkpoints bound chain depth (prevent reading 50 snapshots)
- 5-snapshot limit prevents runaway reads
- Broken chain gets explicit warning
- Agent reports state BEFORE acting — human confirms before work resumes

## Acceptance Criteria

- [ ] `.claude/skills/load-context-chain/SKILL.md` exists
- [ ] Chain-following logic clearly specified
- [ ] Three stopping conditions documented
- [ ] Synthesis output format defined
- [ ] Broken chain handling included

## Human Verification

Walk through the crash recovery workflow from blueprint lines 1476-1488. Does this skill support that flow?
