---
task-id: "018b"
title: "/new-project Skill"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["001", "002", "016", "018"]
estimated-scope: medium
---

# 018b: /new-project Skill

## What This Task Produces

A skill at `.claude/skills/new-project/SKILL.md` that bootstraps a fresh generated-app directory under `projects/<name>/`, cloning agentic resources from this factory repo and seeding an empty `brief.md` for the user to fill in.

## Why This Exists

Blueprint line 369 references an "init function" that creates a project and clones from global, and §23 line 2762 starts the pipeline at _"0. User authors brief.md"_ — but neither is operationalized in the scaffolding. Without this skill:

- There is no target directory for `/analyze`, `/mockups`, `/stylesheet`, `/screens` to operate on
- Task 001's repo-root skeleton conflates the **factory** (this repo, holding agentic resources) with a **generated project** (per-project structure at blueprint lines 371-443)
- Tasks 023-025 (design pipeline) cannot be tested end-to-end

This skill draws the line: the factory produces projects; projects consume agentic resources.

## Scope

### Directory Convention

- `projects/` directory at the factory repo root — tracked in git, but individual project subdirectories are initialized as independent git repos (each `projects/<name>/.git`)
- Add `projects/*/` to root `.gitignore` so generated projects don't pollute factory history (keep `projects/.gitkeep`)
- Each `projects/<name>/` is a self-contained generated-app per blueprint lines 371-443

### SKILL.md

```yaml
---
name: new-project
description: Bootstrap a new generated-app project under projects/<name>/. Clones agentic resources from factory and seeds brief.md for user authoring.
when_to_use: before any pipeline work on a new project; when user says "create a new project" or "start a new app"
allowed-tools: Read Write Bash Glob
---
```

### Skill Arguments

- `<name>` (required) — project slug, kebab-case, validated against `^[a-z][a-z0-9-]{1,48}$`
- `--force` (optional) — re-copy agentic resources and regenerate scaffolding files even if `projects/<name>/` already exists. **Preserves user-authored content by default** (see policy below).
- `--reset-brief` (optional, requires `--force`) — nuclear option: also overwrite `brief.md` back to the template. Use only if the user explicitly wants to discard brief edits.

### Overwrite policy — what `--force` preserves vs. overwrites

Running `/new-project <name>` a second time on an existing project must never silently destroy user work. The policy:

| File / dir                              | No `--force` (default) | `--force`                                                             | `--force --reset-brief`         |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `projects/<name>/brief.md`              | skill aborts           | **preserved** (user content kept as-is)                               | overwritten with fresh template |
| `projects/<name>/assets/`               | skill aborts           | preserved                                                             | preserved                       |
| `projects/<name>/companion/`            | skill aborts           | preserved                                                             | preserved                       |
| `projects/<name>/docs/`                 | skill aborts           | preserved                                                             | preserved                       |
| `projects/<name>/plans/`                | skill aborts           | preserved                                                             | preserved                       |
| `projects/<name>/contexts/`             | skill aborts           | preserved                                                             | preserved                       |
| `projects/<name>/.git/`                 | skill aborts           | preserved (no reinit)                                                 | preserved                       |
| `projects/<name>/.claude/agents/`       | skill aborts           | **re-copied from factory**                                            | re-copied                       |
| `projects/<name>/.claude/skills/`       | skill aborts           | re-copied                                                             | re-copied                       |
| `projects/<name>/.claude/hooks/`        | skill aborts           | re-copied                                                             | re-copied                       |
| `projects/<name>/.claude/rules/`        | skill aborts           | re-copied                                                             | re-copied                       |
| `projects/<name>/.claude/settings.json` | skill aborts           | re-copied (backup written to `.claude/settings.json.bak-{timestamp}`) | same                            |
| `projects/<name>/.claude/models.yaml`   | skill aborts           | preserved (user may have tuned)                                       | preserved                       |
| `projects/<name>/.claude/CLAUDE.md`     | skill aborts           | re-copied (backup written)                                            | re-copied                       |
| `projects/<name>/CLAUDE.md`             | skill aborts           | re-copied (backup written)                                            | re-copied                       |
| `projects/<name>/.gitignore`            | skill aborts           | re-copied (backup written)                                            | re-copied                       |
| `projects/<name>/justfile`              | skill aborts           | re-copied (backup written)                                            | re-copied                       |

Rationale: agentic resources (`.claude/agents/`, `skills/`, `hooks/`, `rules/`) evolve in the factory and SHOULD get pulled forward. User-authored content (brief, assets, docs, plans) represents real work and must never be clobbered without explicit opt-in.

### Skill Steps

1. **Validate name** — regex check; reject reserved names (`active`, `archive`, `templates`, `test`, `shared`, `factory`)
2. **Pre-flight** — if `projects/<name>/` exists:
   - Without `--force` → abort with: `Project 'projects/<name>/' already exists. Use --force to refresh agentic resources (preserves user content), or pick a different name.`
   - With `--force` → proceed, applying the preserve/overwrite policy above
   - Before overwriting any file marked "re-copied (backup written)", write the existing bytes to `{path}.bak-{ISO-timestamp}` first
3. **Create per-project structure** per blueprint lines 371-443:
   ```
   projects/<name>/
   ├── brief.md                         # from brief-template.md (task 016)
   ├── brief.manifest.json              # empty index, updated by analyst
   ├── companion/                       # empty dir
   ├── schemas/                         # copied from factory
   ├── assets/
   │   └── README.md                    # from factory assets/README.md
   ├── .claude/
   │   ├── CLAUDE.md                    # project-level instructions
   │   ├── settings.json                # inherited hooks + permissions
   │   ├── models.yaml                  # cloned from factory .claude/models.yaml
   │   ├── agents/                      # copied from factory
   │   ├── skills/                      # copied from factory
   │   ├── hooks/                       # copied from factory
   │   ├── rules/                       # copied from factory
   │   ├── state/                       # empty, gitignored
   │   └── worktrees/                   # empty, gitignored
   ├── contexts/
   │   ├── checkpoints/
   │   └── archive/
   ├── plans/
   │   ├── active/
   │   ├── archive/
   │   ├── superseded/
   │   └── templates/                   # copied from factory plans/templates
   ├── docs/                            # empty, populated by agents
   ├── pipeline/                        # gitignored, stage outputs
   ├── CLAUDE.md                        # root project instructions
   ├── .gitignore
   └── justfile                         # copied from factory (task 010)
   ```
4. **Seed `brief.md`** from `brief-template.md` (task 016), with frontmatter `name` and `slug` pre-filled from the project name
5. **Copy agentic resources** from factory `./.claude/` into `projects/<name>/.claude/` — prefer copy over symlink for portability and per-project evolution. List what was copied in the return payload.
6. **Write project CLAUDE.md** — reference the factory CLAUDE.md sections verbatim but with project-specific paths. Must include the Brief Protocol from blueprint lines 598-606.
7. **Write `.gitignore`** — `.claude/state/`, `.claude/worktrees/`, `pipeline/`, `node_modules/`, `.env*`, `*.pem`, `*.key`
8. **Initialize git** — `git init` inside `projects/<name>/`, initial commit with message `chore: initialize project <name> from factory`
9. **Self-verify** — read back `brief.md`, `.claude/CLAUDE.md`, and at least one agent/skill/hook file to confirm copy succeeded
10. **Return** JSON: `{ success, projectPath, filesCopied: { agents: N, skills: N, hooks: N, rules: N, templates: N }, nextStep: "author brief.md at <path>" }`

### Output Contract

- `projects/<name>/` exists with the full per-project structure
- `projects/<name>/brief.md` exists, is valid against the brief schema (task 015), has placeholder content the user must replace
- `projects/<name>/.claude/` contains copies of all factory agents, skills, hooks, rules
- `projects/<name>/.git/` exists with an initial commit
- Skill returns structured JSON (above) — no HTML, no prose-only response

### Factory-Side Additions

Done once, as part of shipping this task — NOT per-project-creation:

1. **`projects/.gitkeep`** — create an empty file at the factory root so the directory is tracked even when empty
2. **Factory `.gitignore`** — append these lines at the end (verbatim):
   ```gitignore
   # Generated projects live here. Each project is its own git repo.
   # Keep the directory itself (.gitkeep) but ignore its contents.
   projects/*
   !projects/.gitkeep
   ```
3. **Factory root `CLAUDE.md`** — add a new section:

   ```markdown
   ## Project Initialization

   - This repository is the **factory** — it holds agentic resources (agents, skills, hooks, rules) used to generate apps
   - Generated apps live under `projects/<name>/` and are independent git repos
   - To create a new project: run `/new-project <name>` (see `.claude/skills/new-project/SKILL.md`)
   - To refresh agentic resources in an existing project without losing user content: `/new-project <name> --force`
   - The factory↔project distinction is load-bearing: never edit a project's `.claude/agents/` expecting it to propagate back to the factory
   ```

## Acceptance Criteria

- [ ] `.claude/skills/new-project/SKILL.md` exists with the frontmatter above
- [ ] Skill validates the `<name>` argument (regex + expanded reserved words list)
- [ ] Refuses to overwrite existing projects without `--force`
- [ ] `--force` re-copies agentic resources but preserves user content per the policy table
- [ ] `--reset-brief` is gated behind `--force` AND opts in explicitly to brief overwrite
- [ ] Before overwriting any factory-owned file with `--force`, writes `.bak-{timestamp}` backup
- [ ] Produces the full per-project structure from blueprint L371-443 on fresh init
- [ ] `projects/<name>/brief.md` is seeded from `brief-template.md` with name/slug pre-filled on fresh init
- [ ] All factory `.claude/` resources (agents, skills, hooks, rules) are copied on fresh init
- [ ] `git init` runs and creates an initial commit inside the project on fresh init only (not on `--force`)
- [ ] Self-verification step reads back key files before returning
- [ ] Returns structured JSON per output contract, including `mode: "init" | "refresh"` and `preserved: [paths]` / `overwritten: [paths]` lists when `--force` is used
- [ ] Factory `projects/.gitkeep` created
- [ ] Factory `.gitignore` appended with the three-line block above (exact text)
- [ ] Factory root `CLAUDE.md` gains the Project Initialization section (exact text above)

## Human Verification

Fresh-init path:

1. Run `/new-project test-app`
2. `projects/test-app/` exists with the expected tree
3. `projects/test-app/brief.md` has the 20-section template and pre-filled frontmatter
4. `projects/test-app/.claude/skills/` contains every skill present in the factory
5. `cd projects/test-app && git log` shows the initial commit
6. `/analyze` inside `projects/test-app/` can find `brief.md` and proceed (mentally trace — actual run is task 019's test)

Re-run / refresh path: 7. Edit `projects/test-app/brief.md` (add a real project name). Drop a fake logo into `assets/logos/`. 8. Re-running `/new-project test-app` without `--force` is refused with a clear message 9. Running `/new-project test-app --force` keeps the edited `brief.md` and the logo file untouched 10. The same `--force` run re-copies `.claude/agents/` from factory; if you modified an agent in the project, the old version is preserved as `{agent}.md.bak-{timestamp}` 11. `git log` inside `projects/test-app/` does NOT show a new initial-commit from the refresh (git state preserved) 12. Running `/new-project test-app --force --reset-brief` DOES overwrite `brief.md` back to the template (destructive, intentional)

## Downstream Dependencies

Unblocks:

- **019** Analyst / `/analyze` — needs a project with `brief.md`
- **023** `/mockups`, **024** `/stylesheet`, **025** `/screens` — need a project directory to write outputs into
- **035** Orchestrator — operates on a project path, not the factory
