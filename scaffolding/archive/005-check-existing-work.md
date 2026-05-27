---
task-id: "005"
title: "/check-existing-work Skill"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: ["002"]
estimated-scope: small
---

# 005: /check-existing-work Skill

## Why This Matters

This is the "pre-work check discipline" from the blueprint. Every agent's FIRST action before doing anything is to search for related prior work. Without this, agents will duplicate effort or re-attempt failed approaches.

## What This Task Produces

A skill at `.claude/skills/check-existing-work/SKILL.md`.

## Scope

### SKILL.md

```yaml
---
name: check-existing-work
description: Search active and archived plans for work related to the current task. Run BEFORE starting any new work.
when_to_use: before any new plan, before investigating a bug, before starting implementation
argument-hint: [search-query — file path, feature name, or error message]
allowed-tools: Read Bash Grep Glob
---
```

### Skill Steps

1. Accept search query (file path, feature name, error message)
2. Search `plans/active/` for matching plans (grep frontmatter + body)
3. Search `plans/archive/` for matching completed/abandoned work
4. Search `plans/superseded/` for replaced plans
5. For each match, return:
   - Plan ID
   - Type (feature/bug/refactor/investigation)
   - Status
   - Outcome (if archived)
   - One-line summary
   - File path to full plan (do NOT paste content)
6. If matches found: "Related work exists — review before proceeding"
7. If no matches: "No related work found — safe to proceed"

### Key Design Decision

Returns **summaries with file references**, not full plan content. This keeps context usage minimal and lets the caller decide what to read in detail.

## Acceptance Criteria

- [ ] `.claude/skills/check-existing-work/SKILL.md` exists
- [ ] Searches all three plan directories
- [ ] Returns structured summaries, not full content
- [ ] Clear "safe to proceed" vs "review before proceeding" signal

## Human Verification

Is the search scope correct? Should it also search `docs/lessons.md` or `contexts/`?
