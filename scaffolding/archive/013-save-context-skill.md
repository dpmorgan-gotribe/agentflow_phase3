---
task-id: "013"
title: "/save-context Skill"
status: complete
priority: P1
tier: 3 — Configuration & Context
depends-on: ["001"]
estimated-scope: small
---

# 013: /save-context Skill

## What This Task Produces

A skill at `.claude/skills/save-context/SKILL.md` that captures work state as a chained context snapshot.

## Scope

From blueprint lines 1366-1389:

### Snapshot Format

Filename: `contexts/YYYYMMDD-HHMMSS-<agent>-<brief>.md`

Frontmatter: `session-id`, `timestamp`, `agent`, `task-id`, `previous-context`, `checkpoint` (bool), `status` (in-progress | blocked | checkpoint | final).

Body sections: Summary, Completed Since Last Snapshot, Current State, Next Steps, Open Questions, Key Files Touched, Decisions Made.

### Skill Steps

1. Generate session-id from current timestamp
2. Find most recent file in `contexts/` to link as `previous-context`
3. Determine if checkpoint: every 5th snapshot, end-of-session, major milestones
4. Gather state from: `git status`, `git log --oneline -5`, failing tests, current plan, `git diff --name-only`
5. Write snapshot to `contexts/{session-id}-{agent}-{slug}.md`
6. If checkpoint, also add to `contexts/checkpoints/` symlink
7. Return snapshot path

### Constraint

Each snapshot under 500 lines. If more is needed, make a checkpoint.

## Acceptance Criteria

- [ ] `.claude/skills/save-context/SKILL.md` exists
- [ ] Snapshot format matches blueprint specification
- [ ] Links to previous context via frontmatter
- [ ] Checkpoint logic documented (every 5th, milestones, end-of-session)
- [ ] 500-line limit documented

## Human Verification

Is the snapshot format capturing enough state to resume work after a crash?
