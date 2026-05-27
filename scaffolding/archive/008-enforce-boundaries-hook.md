---
task-id: "008"
title: "enforce-boundaries.sh PreToolUse Hook"
status: complete
priority: P0
tier: 2 — Safety & Guardrails
depends-on: ["001"]
estimated-scope: small
---

# 008: enforce-boundaries.sh Hook

## What This Task Produces

A PreToolUse hook at `.claude/hooks/enforce-boundaries.sh` that prevents writes outside the project directory and blocks modification of sensitive files.

## Scope

Implement from blueprint lines 2311-2337:

### Rules

1. Resolve the file path being written to via `realpath`
2. Block if resolved path is outside `$CLAUDE_PROJECT_DIR`
3. Block writes to sensitive files: `.env`, `.env.local`, `*.pem`, `*.key`

### How It Works

- Reads tool input from stdin as JSON
- Extracts `tool_input.file_path` or `tool_input.path`
- Resolves to absolute path
- Checks against project directory boundary
- Checks basename against blocked file patterns
- Exit 0 = allow, Exit 2 = block with reason

## Acceptance Criteria

- [ ] `.claude/hooks/enforce-boundaries.sh` exists and is executable
- [ ] Blocks writes outside project directory
- [ ] Blocks `.env`, `.env.local`, `*.pem`, `*.key`
- [ ] Uses `$CLAUDE_PROJECT_DIR` for boundary check
- [ ] Clear error messages on block

## Human Verification

Are there other sensitive file patterns you'd want blocked? (e.g., `credentials.json`, `*.p12`, `id_rsa`)
