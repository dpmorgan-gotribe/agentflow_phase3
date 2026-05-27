# Agentic Visibility — project git-tracking modes

`/new-project` accepts `--agentic-visibility=<public|private|split>` to
control whether the "agentic layer" (agent definitions, skill definitions,
hooks, rules, plans, contexts) is tracked by the project's git repo. The
chosen mode is recorded in the project's root `CLAUDE.md` frontmatter as
`agenticVisibility: <mode>` and preserved across `--force` refreshes.

**Default: `private`** — the safer default. Prevents the agentic layer from
leaking when a project repo is pushed to a public remote.

## Why this flag exists

Projects under `projects/<name>/` bundle two distinct things:

1. **The app code itself** — `apps/`, `packages/`, root config
   (`package.json`, `tsconfig.json`, `turbo.json`, `pnpm-workspace.yaml`),
   `docs/`, `brief.md`, `schemas/`, user assets.
2. **The agentic layer that built the app** — `.claude/agents/*`,
   `.claude/skills/*/SKILL.md`, `.claude/hooks/*`, `.claude/rules/*`,
   `.claude/templates/*`, `plans/active/*`, `contexts/*`.

Group 2 is internal tooling. If a project pushes to a public remote
(open-source release, client handoff, portfolio push), group 2 leaks:

- Agent system prompts are visible to anyone who reads the repo
- Skill definitions expose the factory's internal workflows
- Plan history reveals how a feature was built + debugging turns + retry
  counts + failed attempts
- Hook scripts may contain factory-internal safety logic

For factory-internal projects where the agentic layer IS the deliverable
(e.g. a demo showing the factory at work), group 2 should ship alongside
the app — that's `public` mode. For client work or open-source releases,
it should stay private — that's `private` or `split`.

## The three modes

### `public` — everything tracked (legacy behavior)

The project's single `.git` tracks both the app code AND the agentic layer.

**`.gitignore` body** (base block only):

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
*.p12 *.pfx *.keystore *.jks
.DS_Store
Thumbs.db
```

**Tracked**: everything not matching the above, including `.claude/agents/`,
`.claude/skills/`, `.claude/hooks/`, `.claude/rules/`, `.claude/templates/`,
`plans/active/`, `plans/archive/`, `contexts/`.

**Use when**: factory-internal projects, agentic collaboration, auditable
demo deliverables. **Don't use** when the repo will push to a public remote.

### `private` (DEFAULT) — agentic layer kept on disk, ignored by git

Single `.git` at the project root. `.gitignore` excludes the agentic layer
so it stays on disk (agents still run locally) but doesn't commit.

**`.gitignore` body** (base block + agentic exclusions):

```
# [base block — same as public mode]
...

# agentic-visibility: private — hides the agentic layer from git
.claude/agents/
.claude/skills/
.claude/hooks/
.claude/rules/
.claude/templates/
plans/
contexts/
```

**Tracked**: `brief.md`, `companion/`, `apps/`, `packages/`, `docs/`,
`schemas/`, `scripts/`, root config, `.env.example`, `CLAUDE.md`,
`.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/models.yaml`,
`.mcp.json`, `mcp-defaults-design.json`, `justfile`.

**Ignored** (but still on disk): agentic layer.

**Use when**: most projects. Default for a reason.

**Trade-off**: work history (plans, contexts) isn't captured in git. If you
want that history preserved somewhere, push the full project to a
factory-internal private remote (e.g. internal GitHub org) and push only
the tracked subset to the public remote. The `split` mode below formalizes
that pattern.

### `split` — two git repos, two remotes

Outer repo at `projects/<name>/` tracks the agentic layer AND the
plan/context history (for factory-internal use). Inner repo at
`projects/<name>/apps-and-packages/` tracks ONLY the app code (for the
public remote).

Structure after `/new-project <name> --agentic-visibility=split`:

```
projects/<name>/
├── .git/                                 # outer repo — factory-internal
├── .gitignore                            # same as `private` + ignores apps-and-packages/.git/
├── .claude/                              # agentic layer, tracked by outer .git
│   ├── agents/
│   ├── skills/
│   ├── hooks/
│   ├── rules/
│   └── templates/
├── plans/                                # tracked by outer .git
├── contexts/
├── docs/
├── brief.md
├── CLAUDE.md
└── apps-and-packages/
    ├── .git/                             # inner repo — public-ready
    ├── README.md                         # explains the split
    ├── package.json                      # workspace mirror
    ├── apps/                             # tracked by inner .git (via git mv from outer)
    └── packages/                         # same
```

The outer repo at `projects/<name>/` gets `apps-and-packages/.git/` in its
own `.gitignore` so the inner repo's history isn't duplicated.

**Use when**: you want full version history of both the work AND the
artefact, with different remote destinations (e.g. outer → `github.com/
factory-org/<name>-internal`, inner → `github.com/client-org/<name>`).

**Trade-off**: dev ergonomics are slightly worse — a full monorepo build
from the outer dir needs to recurse into `apps-and-packages/`. Root config
is duplicated between outer (workspace-aware) and inner (workspace-root
for standalone use).

## What each mode tracks — at a glance

| Path                     | `public` | `private` | `split` outer | `split` inner |
| ------------------------ | :------: | :-------: | :-----------: | :-----------: |
| `brief.md`               |    ✓     |     ✓     |       ✓       |       —       |
| `companion/`             |    ✓     |     ✓     |       ✓       |       —       |
| `docs/`                  |    ✓     |     ✓     |       ✓       |       —       |
| `schemas/`               |    ✓     |     ✓     |       ✓       |       —       |
| `scripts/`               |    ✓     |     ✓     |       ✓       |       —       |
| `apps/`                  |    ✓     |     ✓     |       —       |       ✓       |
| `packages/`              |    ✓     |     ✓     |       —       |       ✓       |
| root `package.json` etc. |    ✓     |     ✓     |       ✓       |       ✓       |
| `.env.example`           |    ✓     |     ✓     |       ✓       |       ✓       |
| `.env`, `*.key`, `*.pem` |    —     |     —     |       —       |       —       |
| `CLAUDE.md`              |    ✓     |     ✓     |       ✓       |       —       |
| `.claude/CLAUDE.md`      |    ✓     |     ✓     |       ✓       |       —       |
| `.claude/settings.json`  |    ✓     |     ✓     |       ✓       |       —       |
| `.claude/models.yaml`    |    ✓     |     ✓     |       ✓       |       —       |
| `.claude/agents/`        |    ✓     |     —     |       ✓       |       —       |
| `.claude/skills/`        |    ✓     |     —     |       ✓       |       —       |
| `.claude/hooks/`         |    ✓     |     —     |       ✓       |       —       |
| `.claude/rules/`         |    ✓     |     —     |       ✓       |       —       |
| `.claude/templates/`     |    ✓     |     —     |       ✓       |       —       |
| `.claude/state/`         |    —     |     —     |       —       |       —       |
| `.claude/worktrees/`     |    —     |     —     |       —       |       —       |
| `plans/`                 |    ✓     |     —     |       ✓       |       —       |
| `contexts/`              |    ✓     |     —     |       ✓       |       —       |
| `pipeline/`              |    —     |     —     |       —       |       —       |
| `node_modules/`          |    —     |     —     |       —       |       —       |

Legend: ✓ = tracked, — = not tracked (either gitignored or not present in
that repo's scope).

## Suggested remote configuration

- **`public`** — single remote, e.g. `origin` pointing to a public URL.
  Everything visible.
- **`private`** — single remote, typically a private URL. If you want to
  also push a public view, create a second branch that filters out the
  agentic layer, or use `split` instead.
- **`split`** — two remotes, one per git root:
  - Outer: `git remote add origin git@github.com:factory-org/<name>-internal.git`
  - Inner: `cd apps-and-packages && git remote add origin git@github.com:client-org/<name>.git`

## Changing visibility after the fact

`--agentic-visibility` is locked in at `/new-project` time and preserved
across refreshes. Changing it later requires:

1. `public` → `private`: add the `private` exclusions to `.gitignore`, then
   `git rm -r --cached .claude/agents/ .claude/skills/ .claude/hooks/
.claude/rules/ .claude/templates/ plans/ contexts/`, commit. Agents + plans
   stay on disk; git stops tracking. History remains — if you pushed the
   repo publicly before the change, the history already leaked. Consider
   rewriting history (BFG / `git filter-repo`) + force-pushing if that's a
   problem.
2. `private` → `public`: remove the agentic exclusions from `.gitignore`,
   `git add .claude/ plans/ contexts/`, commit.
3. Anything involving `split`: manually `git mv apps/ packages/` into / out
   of `apps-and-packages/` + init/destroy inner `.git`. Non-trivial.

Because history-rewrites are painful, `/new-project` refuses to silently
change visibility on a `--force` refresh. If the flag differs from the
existing project's `agenticVisibility`, the refresh errors out with a
message pointing here.

## FAQ

### "Will agents still work in `private` mode if `.claude/agents/` is gitignored?"

Yes. Git ignoring a path doesn't remove it from disk. Claude Code reads
agents / skills / hooks from disk regardless of git tracking. `/new-project`
still copies them into the project.

### "Why not just push the app code from `apps/` directly to a public remote without touching the outer repo?"

You could — that's effectively "DIY split mode" without the `split` flag.
The flag automates it: provides the inner repo + README + workspace mirror

- consistent `.gitignore` so both repos have clean histories.

### "What about secrets?"

The base block (shared by all three modes) ignores `.env`, `.env.*`,
`*.pem`, `*.key`, `credentials.json`, `*.p12`, `*.pfx`, `*.keystore`,
`*.jks`. Secrets never touch git regardless of visibility mode. This list
exists in `/new-project` SKILL.md step 6.

### "Can I track plans but not agents?"

Not via the flag. Edit `.gitignore` manually after scaffold — remove
`plans/` from the exclusion list. Document the hybrid mode in the
project's `CLAUDE.md` so future `--force` refreshes know not to reset it.
