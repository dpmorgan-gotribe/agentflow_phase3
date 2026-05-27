---
name: new-project
description: Bootstrap a new generated-app under projects/<name>/. Clones agentic resources from the factory and seeds brief.md for user authoring.
when_to_use: before any pipeline work on a new project; when user says "create a new project" or "start a new app"
argument-hint: <name> [--force] [--reset-brief] [--agentic-visibility=public|private|split] [--proposal "<text>" | --proposal-file <path> | --proposal-url <url>]
allowed-tools: Read Write Bash Glob Grep
---

# /new-project — Scaffold a Generated App

Creates `projects/<name>/` as a self-contained, independently git-tracked
app project. Copies the factory's agentic resources (agents, skills, hooks,
rules, templates) into the project so agents can run against it without
reaching back into the factory.

Factory (this repo) produces projects. Projects consume agentic resources.
That distinction is load-bearing — projects evolve their agents
independently after `/new-project`; factory changes don't auto-propagate.

## Arguments

- `<name>` (required) — project slug, kebab-case, regex `^[a-z][a-z0-9-]{1,48}$`
- `--force` — re-copy agentic resources on an existing project. **Preserves
  all user-authored content by default** (brief, assets, docs, plans, contexts).
  Backs up factory-owned files before overwriting (`.bak-{ISO-timestamp}`).
- `--reset-brief` — nuclear option, requires `--force`. Also overwrites
  `brief.md` back to the template. Use only if user explicitly wants
  brief edits discarded.
- `--agentic-visibility=<public|private|split>` — controls whether the
  agentic layer (`.claude/agents/`, `.claude/skills/`, `.claude/hooks/`,
  `.claude/rules/`, `.claude/templates/`, `plans/`, `contexts/`) is tracked
  by the project's git repo. Default: **`private`**.
  - `public` — track everything (legacy behavior). Use for factory-internal
    projects where the agentic layer is part of the deliverable + audit
    trail.
  - `private` — gitignore the agentic layer. Safest default — prevents
    leakage when the project's repo is pushed to a public remote.
  - `split` — two git roots. Outer repo at `projects/<name>/` tracks the
    agentic layer (for a private factory remote). Inner repo at
    `projects/<name>/apps-and-packages/` tracks only the app code (for a
    public remote).
  - Preserved across `--force` refreshes via `agenticVisibility` field in
    the project's root `CLAUDE.md` frontmatter.
  - See `docs/agentic-visibility.md` for the full matrix of what each mode
    tracks vs ignores.
- `--proposal "<text>"` — optional. Freeform proposal text. After scaffold,
  invokes `/draft-brief "<text>"` inside the new project to fill in the
  20-section brief.
- `--proposal-file <path>` — same, but read the proposal from a file (path
  resolved against the user's CWD at invocation time — NOT the new project).
- `--proposal-url <url>` — same, but fetch the proposal from a URL.
- The three `--proposal*` flags are mutually exclusive. If none is
  supplied, the scaffold leaves brief.md as the empty template and the
  user runs `/draft-brief` later.

## Steps

### 1. Validate `<name>`

- Regex: `^[a-z][a-z0-9-]{1,48}$` — starts with a letter, kebab-case, 2-49 chars
- Reject these reserved names: `active`, `archive`, `templates`, `test`,
  `shared`, `factory`
- On failure, error with `Project name '<name>' invalid. Must match {regex}
and not be a reserved word.`

### 2. Pre-flight

- If `projects/<name>/` does NOT exist → proceed to step 3 (init mode)
- If it exists AND no `--force` → error and stop:
  ```
  Project 'projects/<name>/' already exists. Use --force to refresh
  agentic resources (preserves user content), or pick a different name.
  ```
- If it exists WITH `--force` → proceed to step 5 (refresh mode, skipping
  init-only steps)
- `--reset-brief` without `--force` → error: "--reset-brief requires --force"

### 3. Create per-project directory tree (INIT MODE ONLY)

```
projects/<name>/
├── brief.md
├── brief.manifest.json
├── companion/
├── schemas/
├── assets/
│   └── README.md
├── .claude/
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── models.yaml
│   ├── agents/
│   ├── skills/
│   ├── hooks/
│   ├── rules/
│   ├── state/
│   └── worktrees/
├── contexts/
│   ├── checkpoints/
│   └── archive/
├── plans/
│   ├── active/
│   ├── archive/
│   ├── superseded/
│   └── templates/
├── docs/
├── pipeline/
├── CLAUDE.md
├── .gitignore
└── justfile
```

Use `mkdir -p` for each directory. Add `.gitkeep` to otherwise-empty dirs
that should be tracked (`contexts/`, `plans/active/`, `docs/`, `companion/`).

### 4. Seed user-authored files (INIT MODE ONLY)

- `projects/<name>/brief.md` ← copy from factory `brief-template.md`
  (task 016), then sed-replace `project-name: "REPLACE_ME"` with the
  actual `<name>` and the current date in `created` / `last-modified`
- `projects/<name>/brief-template.md` ← copy from factory, so `/draft-brief`
  inside the project can find its template locally
- `projects/<name>/brief.manifest.json` ← `{ "version": "1.0", "sections": {} }`
- `projects/<name>/assets/README.md` ← copy from factory `assets/README.md`
- `projects/<name>/schemas/` ← copy factory `schemas/` (needed by
  `/validate-brief` running inside the project)
- `projects/<name>/scripts/validate-brief.mjs` ← copy factory
  `scripts/validate-brief.mjs`. The script auto-resolves paths from CWD
  (bug-fixed 2026-04-18) and reaches factory `node_modules/` via Node's
  upward module resolution when run from `projects/<name>/`. Projects that
  are later moved out of the factory tree should `pnpm install` standalone
- `projects/<name>/plans/templates/` ← copy factory `plans/templates/`
- `projects/<name>/.markdownlint.jsonc` ← copy from factory, so
  markdownlint's MD043 20-section rule applies per-project
- `projects/<name>/.markdownlint-cli2.jsonc` ← copy from factory (scopes
  markdownlint to brief files only)
- `projects/<name>/.prettierignore` ← copy from factory (keeps prettier
  from mangling YAML in `brief.md` frontmatter)
- `projects/<name>/.gitignore` ← see step 6 content
- `projects/<name>/justfile` ← copy factory `justfile`

### 5. Copy agentic resources (BOTH MODES — backup first in refresh mode)

For each of these factory paths, `cp -r` into the matching project path.
In refresh mode, before overwriting an existing file, copy it to
`{path}.bak-{ISO-timestamp}` first:

| Factory source                          | Project destination                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude/agents/`                       | `projects/<name>/.claude/agents/`                                                                                                                                                          |
| `.claude/skills/`                       | `projects/<name>/.claude/skills/`                                                                                                                                                          |
| `.claude/hooks/`                        | `projects/<name>/.claude/hooks/`                                                                                                                                                           |
| `.claude/rules/`                        | `projects/<name>/.claude/rules/`                                                                                                                                                           |
| `.claude/settings.json`                 | `projects/<name>/.claude/settings.json`                                                                                                                                                    |
| `.claude/templates/worktrees-README.md` | `projects/<name>/.claude/worktrees/README.md` (feat-003: human-facing lifecycle doc; seeded into the gitignored worktrees dir so humans inspecting `.claude/worktrees/` see what it's for) |

**Exception — `.claude/models.yaml` is preserved in refresh mode** (user
may have tuned it). Init mode copies it fresh.

**Exception — `projects/<name>/CLAUDE.md` and `projects/<name>/.claude/CLAUDE.md`**
are re-copied in refresh mode with backup.

Track what was preserved, overwritten, and backed up — the return payload
needs these lists.

### 5a. Sync schemas + validators + rules + templates (BOTH MODES — bug-019, refactor-008)

Run `scripts/sync-project-schemas.mjs` against the project to copy
factory-canonical files in five categories from the factory tree:

- `schemas/*.schema.json` (bug-019)
- `scripts/validate-*.mjs` (bug-019)
- `scripts/retrofit-*.mjs` (bug-019; codemods invoked from project CWD)
- `.claude/rules/*.md` (refactor-008; e.g. `testing-policy.md`)
- `.claude/templates/**` (refactor-008; recursive — covers nested
  `ui-kit-eslint-plugin/` tree + the seed-helper templates the architect
  copies into projects per persistence_layer)

Without this step, factory-side regenerations (e.g. bug-015 Phase 2
adding `affects_files`, feat-038 Phase 0 adding §E2E data-seeding
strategy to testing-policy.md, feat-038 Phase 2B adding seed-helper
templates) silently fail to propagate. Downstream agents then either
honor the stale constraint (dropping new fields) or silently mutate the
project artefact as a side-effect.

```
node scripts/sync-project-schemas.mjs projects/<name>
```

The script is idempotent: it byte-compares each factory file against the
project's matching file and skips when identical. New factory files get
created; updated factory files overwrite the project copy. Nested files
under templates get their parent dir created via `mkdirSync(...,
{ recursive: true })` before copy. One log line per file. Failures (FS
errors) surface a non-zero exit (2) but don't abort `/new-project` —
surface them in the return payload's `warnings[]` and continue.

Add the synced filenames to `filesCopied.schemas`, `filesCopied.validators`,
`filesCopied.retrofits`, `filesCopied.rules`, and `filesCopied.templates`
buckets. Ad-hoc operators (suspecting drift between PM runs OR after a
factory rule/template edit) can call this script directly with
`--dry-run` to preview, then without it to apply.

### 5b. Scaffold the Turborepo + shared-package skeleton + design-stage MCPs (refactor-003)

**INIT MODE ONLY** for the filesystem scaffold; `--scope=design` MCP registration runs in BOTH modes (idempotent on refresh — no-op when unchanged).

Refactor-003 moved the monorepo scaffold + design-stage MCP registration here from the old tier-7 pipeline position. Design stages write into `packages/ui-kit/` and need design-stage MCP servers (playwright, icons8, unsplash, chrome-devtools) registered before they run. Since these are fixed factory-level decisions (not per-project architectural freedom), they scaffold at project-bootstrap time.

Steps:

1. **Turborepo + pnpm workspace** (task 026 content; run once in init mode):
   - `pnpm init` at project root
   - Write `turbo.json` with factory canonical task-graph config
   - Write `pnpm-workspace.yaml` defining `apps/*` and `packages/*`
   - Write root `tsconfig.json` (base TS config)
2. **Shared-package skeletons** (task 027 content; run once in init mode):
   - Create `packages/ui-kit/`, `packages/types/`, `packages/utils/`, `packages/api-client/`, `packages/orchestrator-contracts/` each with minimal `package.json` (name + version `0.0.0`) and README
   - `packages/ui-kit/` gets placeholder directories for `tokens/`, `primitives/`, `patterns/`, `layouts/`, `stories/`
   - **UI Kit consumption contract artifacts** (task 022b; factory templates under `.claude/templates/`):
     - `packages/ui-kit/CONTRACT.md` ← `.claude/templates/ui-kit-contract.md` (the six-rule paste-ready block that consumer agents embed in their system prompts)
     - `packages/ui-kit/tsconfig.consumer.json` ← `.claude/templates/ui-kit-tsconfig-consumer.json` (path aliases — exposes `@repo/ui-kit` barrel only; no subpath wildcards — consumer tsconfigs extend this)
     - `packages/ui-kit/scripts/validate-consumer.ts` ← `.claude/templates/ui-kit-validate-consumer.ts` (standalone grep validator; CI layer)
     - `packages/ui-kit/eslint-plugin/` ← `.claude/templates/ui-kit-eslint-plugin/` (four-rule ESLint plugin `@repo/eslint-plugin-ui-kit-contract`; copied as a tree incl. `package.json`, `index.js`, `rules/*.js`, `README.md`)
   - Wire root `package.json`:
     - Add `scripts['ui-kit:validate-consumer']: "tsx packages/ui-kit/scripts/validate-consumer.ts 'apps/*/src/**/*.{ts,tsx,js,jsx}'"`
     - Add `devDependencies`: `tsx`, `glob` (runtime deps of `validate-consumer.ts`)
     - Add `pnpm.onlyBuiltDependencies: ["bcrypt", "esbuild", "sharp", "bufferutil", "utf-8-validate"]` (per bug-153 — pnpm v10 default-disables postinstall scripts for transitively-installed packages; native-binding packages need an explicit opt-in or runtime imports fail with `Cannot find module '*_lib.node'`)
3. **Design-stage MCP defaults** (refactor-003 mechanic):
   - Copy factory `mcp-defaults-design.json` into project root
   - Invoke `/register-mcp-servers --scope=design --input=mcp-defaults-design.json` (task 041 contract). Safe to re-run — idempotent.
   - `--scope=design` registers: `playwright`, `icons8`, `unsplash`, `chrome-devtools`, and (when `--flags=nanobanana` is active for the run) `image-generator`. Populates `.mcp.json` and the `ui-designer` + `html-verifier` agent frontmatters' `mcp_servers` arrays.

Refresh mode (`--force`) re-invokes only step 3 (MCP registration); steps 1-2 preserve the existing monorepo state.

Add to `filesCopied` tracker: `turbo.json`, `pnpm-workspace.yaml`, `tsconfig.json`, root `package.json`, `packages/ui-kit/{package.json, CONTRACT.md, README.md, tsconfig.consumer.json, scripts/validate-consumer.ts, eslint-plugin/**}`, `packages/{types,utils,api-client,orchestrator-contracts}/{package.json,README.md}`, `mcp-defaults-design.json`, `.mcp.json`.

### 6. Write project-level files (INIT MODE ONLY)

**`projects/<name>/CLAUDE.md`** (root) — short file referencing factory
patterns, project-specific paths. Include the Brief Protocol section from
factory CLAUDE.md. Reference `brief.md` at project root as the canonical
spec. The frontmatter MUST include `agenticVisibility: <mode>` (from the
resolved `--agentic-visibility` flag, default `private`) so refresh runs
preserve the choice.

**`projects/<name>/.claude/CLAUDE.md`** — nested CLAUDE.md that gives
agent-specific guidance for this project (inherits from factory).

**`projects/<name>/.gitignore`** — content depends on the
`--agentic-visibility` mode. All three modes share the "always ignored"
base block; `private` and `split` add agentic-layer exclusions on top.

**Always ignored (all modes — base block):**

```
.claude/state/
.claude/worktrees/
pipeline/
node_modules/
.env
.env.*
!.env.example
*.pem
*.key
credentials.json
*.p12
*.pfx
*.keystore
*.jks
.DS_Store
Thumbs.db
desktop.ini
$RECYCLE.BIN/
.AppleDouble
# feat-026: orchestrator-managed bug tracking (runtime artefacts)
docs/bugs.yaml
docs/bugs-archive/
# bug-013: orchestrator per-worktree runtime state — never commit
.feature-context.json
# bug-014 (investigate-005): comprehensive generated-artefact coverage
# build outputs (turbo / next / generic)
.turbo/
.next/
dist/
build/
storybook-static/
# compiler + bundler caches
.swc/
apps/*/.swc/
.vite/
.vitest-cache/
.eslintcache
*.tsbuildinfo
# Next.js generated types + static export
apps/*/next-env.d.ts
apps/*/out/
# Playwright outputs (reports + traces + browser cache)
apps/*/playwright-report/
apps/*/test-results/
apps/*/blob-report/
apps/*/playwright/.cache/
# package-manager logs
*.log
pnpm-debug.log*
npm-debug.log*
yarn-debug.log*
lerna-debug.log*
# bug-052: test-runner output is build-artefact, not source
coverage/
**/coverage/
*.lcov
.nyc_output/
.coverage
# bug-115: Python bytecode artifacts. Tracked .pyc files break
# `git worktree add` on Windows because they're held open by lingering
# uvicorn / pytest processes — empirical motivator: gotribe-tribe-directory
# /fix-bugs round 3 2026-05-16 (24 of 28 dispatches died at worktree add).
# Legacy projects with already-tracked .pyc files: run
# `node scripts/audit-tracked-pycache.mjs <projectDir> --apply` to untrack.
**/__pycache__/
*.pyc
*.pyo
```

**Additional exclusions by mode:**

- **`public`** — no additional entries. Agentic layer + plans + contexts are
  all tracked by the project's git repo. (This matches the pre-refactor
  behavior; use only for factory-internal projects that ship the agentic
  layer as a deliverable.)

- **`private` (default)** — append these to the base block, gitignoring the
  agentic layer so it stays on disk but doesn't leak when the repo pushes
  to a public remote:

  ```
  # agentic-visibility: private — hides the agentic layer from git
  .claude/agents/
  .claude/skills/
  .claude/hooks/
  .claude/rules/
  .claude/templates/
  plans/
  contexts/
  ```

  **Still tracked in `private` mode**: `brief.md`, `companion/`, `apps/`,
  `packages/`, `docs/`, `schemas/`, `scripts/`, root config
  (`package.json`, `tsconfig.json`, `turbo.json`, `pnpm-workspace.yaml`),
  `.env.example`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`,
  `.claude/models.yaml`, `.mcp.json`, `mcp-defaults-design.json`, `justfile`.

- **`split`** — same `.gitignore` body as `private` for the **outer** repo.
  Additionally, step 8 creates a **second** git repo at
  `projects/<name>/apps-and-packages/.git` that tracks ONLY `apps/` +
  `packages/` + app-relevant root config copied into that subtree. See
  step 8 for the split-mode git-init procedure.

The mode selected for the project is recorded in the project's root
`CLAUDE.md` frontmatter as `agenticVisibility: <mode>` so that
`--force` refreshes preserve it.

### 6b. Validate `--agentic-visibility` flag

- Parse the flag from `$ARGUMENTS`. Valid values: `public`, `private`, `split`.
- Default when flag omitted: `private`.
- Any other value → error:
  ```
  --agentic-visibility: invalid value '<got>'. Valid: public | private | split.
  ```
- In refresh mode (`--force`), if the flag is supplied AND the existing
  project's `CLAUDE.md` frontmatter has a different `agenticVisibility`,
  error with:
  ```
  Project was scaffolded with agenticVisibility=<old>; requested <new>.
  Changing visibility after init requires manual .gitignore surgery + git
  history rewrite. To force a change, delete projects/<name>/ and re-run.
  ```
- If the flag is omitted in refresh mode and frontmatter has a value, use the
  frontmatter value (preserve original choice).

### 7. If a `--proposal*` flag was supplied, invoke `/draft-brief`

Run BEFORE git init so the initial commit captures the drafted brief, not
the empty template:

- Exactly-one check: if more than one of `--proposal`, `--proposal-file`,
  `--proposal-url` is present, error: "Only one of --proposal,
  --proposal-file, --proposal-url may be supplied."
- `cd projects/<name>/` first (so `/draft-brief` resolves its own factory
  paths relative to the project).
- Compose the draft-brief invocation:
  - `--proposal "<text>"` → `/draft-brief "<text>"`
  - `--proposal-file <path>` → resolve `<path>` against the ORIGINAL CWD
    (pre-cd) to an absolute path, then `/draft-brief <abs-path>`
  - `--proposal-url <url>` → `/draft-brief <url>`
- Capture draft-brief's report verbatim for the return payload under
  `draftResult`. If draft-brief fails (non-zero or missing deps), include
  its error under `draftResult.error` and continue — the scaffold itself
  is still valid, user can re-run `/draft-brief` after fixing.
- Skip this step entirely in refresh mode (`--force`) — `--proposal*`
  flags with `--force` are accepted but route through `/draft-brief`'s
  normal preserve-or-overwrite logic, not re-scaffold.

### 8. Initialize git (INIT MODE ONLY — SKIP IN REFRESH)

Base case (`public` or `private`):

- `cd projects/<name> && git init`
- `git add -A && git commit -m "chore: initialize project <name> from factory (agenticVisibility=<mode>)"`
  (append `" with drafted brief"` if a proposal was supplied)
- Do NOT re-init or re-commit in refresh mode — user's git state is preserved

**Split mode additions (`--agentic-visibility=split`):**

After the outer `git init` + initial commit (which now tracks everything
non-agentic per the `private` `.gitignore` body), bootstrap the inner
app-only repo:

1. `mkdir -p projects/<name>/apps-and-packages`
2. Move (not copy) app-code subdirs into it: `apps/`, `packages/` — via
   `git mv` so the outer repo's history records the move. Root config
   (`package.json`, `tsconfig.json`, `turbo.json`, `pnpm-workspace.yaml`)
   stays at the outer root; a minimal mirror (`package.json` with
   `"workspaces"` pointing to `../apps-and-packages/{apps,packages}`) is
   added inside `apps-and-packages/` so the inner repo can `pnpm install`
   standalone if cloned alone.
3. `cd apps-and-packages && git init && git add -A && git commit -m "chore: initialize app-code repo for <name>"`
4. Write `projects/<name>/apps-and-packages/README.md` explaining the
   split: "This is the public-ready app-code repo for `<name>`. The
   factory + agentic layer lives one directory up at `projects/<name>/`."
5. Outer `.gitignore` ALSO adds `apps-and-packages/.git/` (so the inner
   repo's history is not tracked by the outer repo).

Refresh mode: skip all git-init work. If the user's requested visibility
differs from the existing project's frontmatter, step 6b already errored
out — so we never reach here in a mode mismatch.

### 9. Self-verify

Read back at least:

- `projects/<name>/brief.md` — first line is `---` (frontmatter fence)
- `projects/<name>/.claude/CLAUDE.md` — file exists and non-empty
- One file from each of `.claude/{agents,skills,hooks,rules}/` — confirms
  the copy worked
- `projects/<name>/.git/HEAD` — confirms git was initialized (init mode)
- `projects/<name>/CLAUDE.md` frontmatter contains
  `agenticVisibility: <mode>` matching the resolved flag

**Visibility-specific checks (init mode):**

- **`public`**: `git -C projects/<name> ls-files .claude/agents/` returns
  non-empty (agentic layer IS tracked).
- **`private`**: `git -C projects/<name> ls-files .claude/agents/` returns
  empty (agentic layer is NOT tracked); `.claude/agents/` still exists on
  disk (agents can still run).
- **`split`**: both `projects/<name>/.git/HEAD` AND
  `projects/<name>/apps-and-packages/.git/HEAD` exist. Outer repo's
  `ls-files apps/` returns empty (app code moved to inner). Inner repo's
  `ls-files` includes `apps/` + `packages/` entries.

If any check fails, return `{ success: false, reason: "..." }` WITHOUT
rolling back — partial state is easier to debug than an invisible cleanup.

### 10. Return structured JSON

```json
{
  "success": true,
  "mode": "init" | "refresh",
  "projectPath": "projects/<name>",
  "agenticVisibility": "public" | "private" | "split",
  "filesCopied": {
    "agents": N,
    "skills": N,
    "hooks": N,
    "rules": N,
    "templates": N,
    "schemas": N
  },
  "preserved": ["projects/<name>/brief.md", "projects/<name>/assets/", "..."],
  "overwritten": ["projects/<name>/.claude/agents/analyst.md", "..."],
  "backups": ["projects/<name>/.claude/agents/analyst.md.bak-2026-04-18T00-00-00Z", "..."],
  "innerRepoPath": "projects/<name>/apps-and-packages",
  "draftResult": null,
  "nextStep": "Author brief.md at projects/<name>/brief.md (or rely on drafted content if --proposal was supplied), then run `/start-build <name>` from the factory root to drive the end-to-end pipeline (analyze → design → architect → pm → build). `/start-build --dry-run` previews the walk without invoking agents."
}
```

`innerRepoPath` is only present when `agenticVisibility: "split"`; omitted
(or `null`) otherwise.

When a `--proposal*` flag triggers `/draft-brief`, `draftResult` is:

```json
"draftResult": {
  "success": true,
  "filledSections": [1, 3, 6, 11, 12],
  "inferredSections": [4, 5, 7, 8, 15],
  "todoSections": [9, 13, 14, 16, 17, 18, 19, 20],
  "frontmatterPrefilled": true,
  "validationPassed": true,
  "validationErrors": []
}
```

In init mode, `preserved` and `overwritten` and `backups` are empty arrays.
In refresh mode with `--reset-brief`, `overwritten` includes `brief.md`.

## Overwrite Policy Matrix

| File / dir                                                         | No `--force` | `--force` (preserve default)                                                                      | `--force --reset-brief`    |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------- | -------------------------- |
| `brief.md`                                                         | abort        | preserved                                                                                         | overwritten (backup saved) |
| `assets/`, `companion/`, `docs/`, `plans/`, `contexts/`            | abort        | preserved                                                                                         | preserved                  |
| `.git/`                                                            | abort        | preserved (no reinit)                                                                             | preserved                  |
| `.claude/{agents,skills,hooks,rules}/`                             | abort        | re-copied (backups of changed files) — still gitignored in `private`/`split`; tracked in `public` | re-copied                  |
| `.claude/settings.json`                                            | abort        | re-copied (backup saved)                                                                          | re-copied                  |
| `.claude/models.yaml`                                              | abort        | preserved (user may have tuned)                                                                   | preserved                  |
| `.claude/CLAUDE.md`, project `CLAUDE.md`, `.gitignore`, `justfile` | abort        | re-copied (backup saved)                                                                          | re-copied                  |

## Edge Cases

- **User runs in a non-factory directory**: check for `.claude/agents/`
  and `brief-template.md` at CWD. If absent, error: "This doesn't look
  like the factory repo. Run from the agentflow-phase2 root."
- **`projects/<name>/` exists but `.git/` is missing**: treat as
  inconsistent state, refuse to `--force`. Ask user to either delete the
  directory or manually `git init` it first.
- **Factory `brief-template.md` missing** (task 016 not shipped): error
  clearly: "brief-template.md not found at factory root — task 016 must
  ship before /new-project can seed briefs." Do not create a broken project.
- **Backup file already exists for the same timestamp** (shouldn't happen
  in normal operation): append a disambiguator: `.bak-{timestamp}-{N}`
- **Name collision with reserved words** (`templates`, etc.): error
  before touching filesystem.
- **Git init fails** (e.g., git not on PATH, or already-inited parent):
  return `{ success: false }` with the git error. Do NOT leave partial
  `.claude/` copies behind if this is the only failure — but also don't
  recursively delete without confirmation. Let the user clean up and retry.

## See also

- `/delete-project <name>` — the inverse op. Removes
  `projects/<name>/`, prunes registered git worktrees, and sweeps
  `proposals/<name>-proposal.md` + `projects/<name>*.git/` siblings.
  Preview-by-default; pass `--yes` to commit, `--dry-run` to print
  only.
