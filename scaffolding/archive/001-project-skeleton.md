---
task-id: "001"
title: "Project Skeleton & CLAUDE.md"
status: complete
priority: P0
tier: 1 — Work Management Foundation
depends-on: none
estimated-scope: small
---

# 001: Project Skeleton & CLAUDE.md

## What This Task Produces

The bare directory structure and root CLAUDE.md that every other task builds on.

## Scope

Create the following empty directory structure (no code yet, just folders and the root CLAUDE.md):

```
project-root/
├── .claude/
│   ├── agents/              # Agent definitions (populated later)
│   ├── skills/              # Skill definitions (populated later)
│   ├── hooks/               # Hook scripts (populated later)
│   ├── rules/               # Modular rule files (populated later)
│   ├── state/               # Runtime state (gitignored)
│   └── worktrees/           # Git worktrees (gitignored)
├── plans/
│   ├── active/              # Current plans
│   ├── archive/             # Completed plans
│   ├── superseded/          # Replaced plans
│   └── templates/           # Plan templates (populated in 002)
├── contexts/
│   ├── checkpoints/         # Dense checkpoint summaries
│   └── archive/             # Shipped project contexts
├── docs/                    # Agent outputs (requirements, mockups, etc.)
├── schemas/                 # JSON schemas for validation
├── companion/               # Large structured companion data
├── assets/
│   └── README.md            # Tells users what to put where
├── CLAUDE.md                # Root project instructions
├── .gitignore               # Ignore state, worktrees, node_modules, etc.
└── pipeline/                # Stage output JSONs (gitignored)
```

## CLAUDE.md Content

Write the CLAUDE.md from **Appendix B** of the blueprint (lines 2916-2989), adapted for this project.

## assets/README.md Content

Brief instructions telling users what brand assets they can drop in (logos, icons, fonts, wireframes, brand-guides, colors.json).

## .gitignore

Include: `.claude/state/`, `.claude/worktrees/`, `pipeline/`, `node_modules/`, `.env*`, `*.pem`, `*.key`.

## Acceptance Criteria

- [ ] All directories exist
- [ ] CLAUDE.md contains all sections from Appendix B
- [ ] assets/README.md explains the asset directory convention
- [ ] .gitignore covers sensitive/transient files
- [ ] `git init` and initial commit

## Human Verification

Review CLAUDE.md — does it accurately reflect the blueprint's conventions? Is anything missing or unclear?
