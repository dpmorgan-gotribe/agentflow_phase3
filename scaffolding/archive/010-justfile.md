---
task-id: "010"
title: "Justfile Safe Command Wrapper"
status: complete
priority: P0
tier: 2 — Safety & Guardrails
depends-on: ["001"]
estimated-scope: small
---

# 010: Justfile Safe Command Wrapper

## What This Task Produces

A `justfile` at project root that curates all allowed commands as safe recipes.

## Scope

Implement from blueprint lines 2339-2394:

### Recipes

- **Development**: `dev`, `build`
- **Testing**: `test *args`, `test-e2e target`
- **Quality**: `lint`, `typecheck`, `format`
- **Git (safe only)**: `status`, `diff *args`, `commit message`, `branch name`
- **Dependencies**: `install`, `add-dep package target`

### Settings

```just
set dotenv-load
set shell := ["bash", "-euo", "pipefail", "-c"]
```

### Note

The justfile is a scaffold — recipes will be expanded as we add the monorepo structure (Task 026). For now, keep the recipes that work without a full monorepo in place.

## Acceptance Criteria

- [ ] `justfile` exists at project root
- [ ] All recipes from blueprint are included
- [ ] `set dotenv-load` and safe shell settings configured
- [ ] `just --list` shows all available commands
- [ ] No destructive git operations (no `push --force`, `reset --hard`)

## Human Verification

Are there any commands you commonly use that should be added? Any recipes that feel too permissive?
