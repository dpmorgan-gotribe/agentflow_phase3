# justfile — curated safe commands for Claude Code
#
# Purpose: restrict the agent's Bash surface to a whitelist of reviewed
# recipes. When the `just`-only setting is enabled in .claude/settings.json
# (task 012), the agent can't run raw shell — it has to go through a recipe
# here. That makes --dangerously-skip-permissions safe-ish, because the
# universe of available commands is what's defined below.
#
# Requirements: `just` on PATH (https://github.com/casey/just).
#   macOS:    brew install just
#   Windows:  scoop install just  (or winget install Casey.Just)
#   Linux:    apt/cargo install just

set dotenv-load
set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# ------------------------------------------------------------------
# Development
# ------------------------------------------------------------------

dev:
    pnpm turbo dev

build:
    pnpm turbo build

# ------------------------------------------------------------------
# Testing
# ------------------------------------------------------------------

test *args:
    pnpm turbo test {{args}}

test-e2e target:
    pnpm turbo test:e2e --filter={{target}}

# ------------------------------------------------------------------
# Quality
# ------------------------------------------------------------------

lint:
    pnpm turbo lint

typecheck:
    pnpm turbo typecheck

format:
    pnpm prettier --write "**/*.{ts,tsx,json,md}"

# ------------------------------------------------------------------
# Git (safe operations only — no force-push, no reset --hard, no
# destructive rewrites. Use the Git Agent (task 033) for anything
# else, or drop to raw shell with explicit permission.)
# ------------------------------------------------------------------

status:
    git status

diff *args:
    git diff {{args}}

log *args:
    git log {{args}}

fetch:
    git fetch --all --prune

# Stage all changes and commit. Requires a good .gitignore — see note below.
commit message:
    git add -A && git commit -m "{{message}}"
# Gotcha: `git add -A` stages EVERY modified file, including pre-existing
# secrets (e.g., a .env placed manually before the enforce-boundaries hook
# was wired up). The hook catches Write/Edit tool calls but not `git add`.
# Rely on .gitignore to exclude secrets; audit it before first commit.

# Create and switch to a new branch.
branch name:
    git checkout -b {{name}}

# Push the current branch, setting upstream on first push.
push:
    git push -u origin "$(git branch --show-current)"
# Force-push to main/master is blocked by .claude/hooks/block-dangerous.sh.

# ------------------------------------------------------------------
# Dependencies
# ------------------------------------------------------------------

install:
    pnpm install

add-dep package target:
    pnpm --filter={{target}} add {{package}}

# ------------------------------------------------------------------
# Composite pipelines
# ------------------------------------------------------------------

# Full CI gate: install → typecheck → lint → test.
ci:
    just install
    just typecheck
    just lint
    just test
