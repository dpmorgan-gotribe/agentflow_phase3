---
task-id: "011"
title: "Model Configuration System (models.yaml)"
status: complete
priority: P1
tier: 3 — Configuration & Context
depends-on: ["001"]
estimated-scope: small
---

# 011: Model Configuration System

## What This Task Produces

Two YAML config files that assign models and budgets to agents.

## Scope

### ~/.claude/models.yaml (System-level defaults)

From blueprint lines 806-841:

- `defaults` mapping: planning → opus, building → sonnet, quality → sonnet, meta → opus, mechanical → haiku
- `agents` mapping: all 12 agents with tier and effort assignments
- `budget` section: per-stage max USD and per-pipeline max USD

### .claude/models.yaml (Project-level override)

From blueprint lines 843-858:

- `extends: ~/.claude/models.yaml`
- Empty `agents` section (ready for per-project overrides)
- Budget override section

### CLAUDE.md Addition

Add the "Model Configuration" section to CLAUDE.md documenting the convention (blueprint lines 952-961).

## Note

The TypeScript `readModelConfig()` function that merges these comes in Task 035 (Orchestrator). For now, we just create the config files that it will read.

## Acceptance Criteria

- [ ] `~/.claude/models.yaml` exists with all 12 agents assigned
- [ ] `.claude/models.yaml` exists with `extends` reference
- [ ] All tiers match blueprint: analyst=planning, git-agent=mechanical, etc.
- [ ] Budget values match blueprint defaults
- [ ] CLAUDE.md updated with model config section

## Human Verification

Review the model-to-agent assignments. Does the cost/quality tradeoff feel right? Any agents you'd want on a different tier?
