---
task-id: "007"
title: "block-dangerous.sh PreToolUse Hook"
status: complete
priority: P0
tier: 2 — Safety & Guardrails
depends-on: ["001"]
estimated-scope: small
---

# 007: block-dangerous.sh Hook

## What This Task Produces

A PreToolUse hook at `.claude/hooks/block-dangerous.sh` that blocks destructive commands.

## Scope

Implement the exact script from blueprint lines 2281-2309:

### Blocked Patterns

- `rm -rf /`, `rm -rf ~`, `rm -rf .`
- `git push.*--force.*main`, `git push.*--force.*master`
- `git reset --hard`
- `git clean -fd`
- `DROP TABLE`, `DROP DATABASE`
- Fork bomb pattern

### How It Works

- Reads tool input from stdin as JSON
- Extracts `tool_input.command`
- Checks against dangerous patterns via grep
- Exit 0 = allow, Exit 2 = block (stderr message fed back to Claude)

### Important

- Must work on Windows (bash via Git Bash / WSL)
- Must handle edge cases: quoted arguments, flags in different order
- Should be executable (`chmod +x`)

## Acceptance Criteria

- [ ] `.claude/hooks/block-dangerous.sh` exists and is executable
- [ ] All patterns from blueprint are covered
- [ ] Exit codes are correct (0 = allow, 2 = block)
- [ ] Stderr output gives clear reason for block
- [ ] Test: pipe a mock `rm -rf /` input and confirm it exits 2

## Human Verification

Review the pattern list — are there any destructive commands missing that you commonly worry about?
