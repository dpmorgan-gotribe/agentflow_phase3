---
name: start-build
description: Kick off the autonomous build phase (Mode B) for a project — reads docs/tasks.yaml, opens parallel git worktrees per feature, runs each feature's agent_sequence (builder → security → tester → reviewer), merges to main. Invoked AFTER gates 1-5 have resolved manually via /analyze, /mockups, /stylesheet, /screens, /user-flows-generator, /architect, /pm. Refuses to run until all Mode A artifacts + gate signoffs are in place.
when_to_use: after /pm has produced docs/tasks.yaml AND gate 5 has resolved (docs/credentials-confirmed.txt contains `proceed` or `defer:`); when the user says "start building", "kick off the build", "run Mode B", "ship it"
argument-hint: "<project> [--flags=<csv>] [--dry-run] [--require-pr-review] [--max-concurrent=<N>]"
allowed-tools: Read Bash Grep Glob
model: inherit
---

# /start-build — Mode B autonomous build driver

Invokes the factory orchestrator (`orchestrator/` at factory root, task 035) in feature-graph mode against a named project. Does NOT walk Mode A stages — those are driven by explicit user invocations of the individual skills (`/analyze`, `/mockups`, `/stylesheet`, `/screens`, `/user-flows-generator`, `/architect`, `/pm`) with HITL gates in between.

Once this skill fires, the build runs autonomously to completion (or retry-exhaustion). No more human-in-the-loop until a reviewer flags a feature as `blocked` or all retries exhaust.

## The intended pipeline

```
MODE A — design + planning, HITL-gated, manually driven:

  /analyze                               → gate 1  (requirements signoff)
  /mockups                               → gate 2  (pick-style: pick one of N styles)
  /stylesheet                            → gate 3  (design-system signoff, binds ui-kit version)
  /screens
  /visual-review                         (optional — skip with operator note)
  /user-flows-generator                  → gate 4  (design sign-off; binds screensManifestHash)
  /architect                             → gate 5  (credentials: fill .env, drop docs/credentials-confirmed.txt)
  /pm --mode=tasks                       (emits docs/tasks.yaml v2)

MODE B — build, autonomous, this skill owns it:

  /start-build <project>
    ↓
  orchestrator feature-graph:
    1. git-agent-bootstrap (creates .claude/worktrees/)
    2. For each feat-* in tasks.yaml respecting depends_on:
       a. git-agent checkout-feature  (worktree + branch)
       b. run feature.agent_sequence  (backend / web / mobile / security / tester / reviewer)
       c. git-agent close-feature     (merge to main; conflicts route back)
    3. Exit when last feature merges or retries exhaust
```

`/start-build` is the single autonomous seam. Everything before it is deliberate, user-initiated work. Everything after it is orchestrator-owned.

## Arguments

- `<project>` (required) — project directory under `projects/`. Must exist and must have passed Mode A (see §Prerequisites).
- `--flags=<csv>` — forwarded to the orchestrator's stage dispatch (e.g. `nanobanana` for image generation; ignored in Mode B most of the time)
- `--dry-run` — simulate the feature DAG walk, report which features would run in which wave + estimated cost; invoke no agents
- `--require-pr-review` — opt INTO gate 6 (pr-review); pause each feature after reviewer-approval to wait for `docs/gate-6-approved-feat-X.txt` file-drop before merge. Default behavior (bug-054, 2026-05-06): trust the reviewer agent — auto-merge on `verdict: approved`. The reviewer IS the merge gate; opt in only for paranoid flows wanting human inspection between reviewer-approve and merge.
- `--max-concurrent=<N>` — override `maxConcurrentFeatures` (default from `~/.claude/models.yaml`, typically 3)

Rejected inputs:

- Missing `<project>` → error with a list of available `projects/*/`
- `<project>` exists but `docs/tasks.yaml` is missing → error: "Mode A has not completed. Run /pm --mode=tasks first (or start from /analyze if earlier stages are also missing)."
- `docs/credentials-confirmed.txt` missing or starts with `abort` → error: "Gate 5 has not resolved. Populate .env per .env.example, then write `proceed` (or `defer:...`) to docs/credentials-confirmed.txt."

## Prerequisites (hard gates before Mode B can fire)

Check each; abort on any missing:

| Artifact                                           | Stage that writes it    | If missing, run                    |
| -------------------------------------------------- | ----------------------- | ---------------------------------- |
| `projects/<p>/docs/brief-summary.json`             | `/analyze`              | `/analyze`                         |
| `projects/<p>/docs/selected-style.json`            | `/mockups` + gate 2     | `/mockups` then `/pick-style`      |
| `projects/<p>/packages/ui-kit/package.json`        | `/stylesheet` + gate 3  | `/stylesheet`                      |
| `projects/<p>/docs/screens-manifest.json`          | `/screens`              | `/screens`                         |
| `projects/<p>/docs/user-flows-manifest.json`       | `/user-flows-generator` | `/user-flows-generator`            |
| `projects/<p>/docs/signoff-*.json` (approved:true) | gate 4                  | signoff gate 4 (HITL or file-drop) |
| `projects/<p>/.claude/architecture.yaml`           | `/architect`            | `/architect`                       |
| `projects/<p>/.env.example`                        | `/architect`            | `/architect`                       |
| `projects/<p>/docs/credentials-confirmed.txt`      | gate 5 (user)           | user fills .env + drops the file   |
| `projects/<p>/docs/tasks.yaml` (version 2.0)       | `/pm --mode=tasks`      | `/pm --mode=tasks`                 |

The orchestrator will also validate `docs/tasks.yaml` against `schemas/tasks.schema.json` before any feature fires.

### Operator step — Playwright browser binary (bug-037 Phase D / feat-056 Gap D)

**One-time per project, after first `pnpm install` succeeds.** The post-Mode-B `/build-to-spec-verify` flow-execution stage runs synthesized Playwright specs that need the chromium binary installed (~150MB download). Two-line operator step:

```bash
cd projects/<name>
pnpm -C apps/web exec playwright install chromium
```

**Why operator-step (not auto)**: a post-install hook would download 150MB on every fresh `pnpm install` (slow + bandwidth-noisy). Lazy install (download on first spec dispatch) makes the first build's wall-clock 30s+ slower with a confusing pause. Operator-step is explicit + cached at the user level (Playwright keeps binaries in `~/.cache/ms-playwright/` so subsequent projects on the same machine reuse the install).

**Gap-A enforcement (feat-056)**: when the binary is missing, `/build-to-spec-verify` now classifies the failure as a `runtime-error` tool-failure bug (was: silent warning) → bug-fix loop dispatches a hint to install. Pre-install once per machine to skip this round-trip.

## Steps

### 1. Parse + validate arguments

Extract `<project>` from positional. If empty, list projects and exit:

```
/start-build requires a project name.
Available projects:
  - revolution-pictures (ready for Mode B — 12 features, 46 tasks)
  - hatch-2            (ready for Mode B — 5 features merged, 3 pending)
  - mindapp            (Mode A incomplete — run /analyze)
```

(The status column is optional polish; for v1, just list names.)

### 2. Prerequisite check

For each artifact in the §Prerequisites table, verify it exists. Missing artifact → emit a specific error pointing at the skill that would produce it. Do NOT attempt to run Mode A stages from this skill.

Also verify `docs/credentials-confirmed.txt`:

- Missing → abort with gate-5 instructions
- Starts with `abort` → abort with user's message
- Starts with `proceed` → continue
- Starts with `defer:A,B` → continue, but warn that features depending on deferred integrations may fail

### 3. Confirm (live runs)

Unless `--dry-run`:

```
About to run Mode B for revolution-pictures:
  - 12 features, 46 tasks
  - concurrent features: 3 (from ~/.claude/models.yaml)
  - budget cap: $150
  - require-pr-review: false (default — auto-merge on reviewer approval per bug-054)

Features will be built in git worktrees under .claude/worktrees/.
Each feature runs: backend → web → mobile → security → tester → reviewer → git-agent merge.
The orchestrator will NOT pause for human input during Mode B unless a reviewer
flags a feature as `blocked` or retries exhaust.

Proceed? [y/N]
```

User says no → exit 0 with no work done.

### 4. Invoke the orchestrator

```bash
cd <factory-root>
pnpm --filter orchestrator start generate <project> --resume-feature-graph [flags]
```

The `--resume-feature-graph` flag skips Mode A entirely — the orchestrator goes straight to `git-agent-bootstrap` + the feature loop. Forwards `--flags`, `--dry-run`, `--require-pr-review`, `--max-concurrent`.

Stream stdout verbatim. The orchestrator emits structured log lines:

```
[feature-graph] wave 1: opening feat-project-bootstrap
[git-agent] worktree created at .claude/worktrees/feat-project-bootstrap
[web-frontend-builder] dispatching react-next skill
[web-frontend-builder] wrote apps/web/src/... (N files)
[web-frontend-builder] happy-path tests: 8 written, 8 pass
[tester] edge-case tests: 12 written, 12 pass, coverage 82%
[reviewer] approved
[git-agent] merging feat-project-bootstrap → main
[feature-graph] wave 2: unblocking feat-cms-content-model, feat-booking-inquiry, ...
```

### 5. Report exit

On exit 0:

```
/start-build revolution-pictures complete.
12/12 features merged to main.
Total spend: $87.20 / $150 budget
Branches remaining: (none — all merged)
Feature branch diffs: git log --graph --oneline main~30..main
```

On non-zero, surface the failing feature + its state:

```
/start-build revolution-pictures halted.
Failed feature: feat-booking-inquiry (attempt 3/3 of web-frontend-builder failed)
See .claude/worktrees/feat-booking-inquiry/ for in-progress state
Logs: projects/revolution-pictures/pipeline/feature-graph/feat-booking-inquiry.log
Resume with: /start-build revolution-pictures  (orchestrator picks up where it left off)
```

### 6. Self-verify

- Exit code matches orchestrator's exit code
- No secrets in transcript (orchestrator redacts)
- Active worktrees cleaned up only by git-agent close-feature; mid-run crash leaves worktrees for inspection

## What this skill does NOT do

- **Does NOT run Mode A.** `/analyze`, `/mockups`, `/stylesheet`, `/screens`, `/user-flows-generator`, `/architect`, `/pm` are invoked by the user, one at a time, with HITL gate pauses between them. That manual cadence is deliberate: each gate is a human inspection point where the user can course-correct cheaply before the next stage spends more budget.
- **Does NOT scaffold a new project.** Use `/new-project <name> --proposal "..."` for that.
- **Does NOT pick a style, pick vendors, or author tasks.** Those decisions happen in `/mockups` + `/pick-style`, `/architect`, `/pm` respectively.
- **Does NOT skip gates.** If gate 5's `docs/credentials-confirmed.txt` is missing, the skill refuses.

## Error paths

- **Prereq missing** → abort with exact skill to run (see table above)
- **`docs/tasks.yaml` version ≠ 2.0** → abort: "tasks.yaml is v1 or malformed. Re-run /pm --mode=tasks."
- **`docs/credentials-confirmed.txt: abort`** → exit 0 with user message: "Gate 5 aborted by operator; no build fired."
- **Orchestrator binary missing** → error: "Factory orchestrator/ package not found. Run `pnpm install` at factory root."
- **Budget exceeded mid-run** → orchestrator halts + writes state; `/start-build` resumes on next invocation
- **A feature's reviewer returns `blocked`** → orchestrator routes back to the named builder for up to 3 attempts; persistent block → feature marked failed, orchestrator continues with other features where possible

## Examples

### Happy path — revolution-pictures after manual Mode A

```
/start-build revolution-pictures
→ Prereq check: all 10 artifacts present ✓
→ docs/credentials-confirmed.txt: proceed ✓
→ 12 features, 46 tasks, $150 budget
→ Proceed? y
→ orchestrator runs...
→ exit 0: 12/12 features merged, $87 spent
```

### Dry-run

```
/start-build revolution-pictures --dry-run
→ Prereq check: all 10 artifacts present ✓
→ Wave plan:
    Wave 1: feat-project-bootstrap
    Wave 2: feat-cms-content-model, feat-booking-inquiry, feat-contact-inquiry,
            feat-not-found, feat-analytics, feat-devops-ci  (6 concurrent, cap 3 → 2 sub-waves)
    Wave 3: feat-home, feat-galleries, feat-services, feat-about
    Wave 4: feat-case-studies
→ Estimated cost: $72-110 (based on per-feature budget-tracker estimates)
→ No agents invoked.
```

### Gate 5 not resolved

```
/start-build revolution-pictures
→ docs/credentials-confirmed.txt missing
→ ABORT: Gate 5 has not resolved.
→ Run: populate .env per .env.example, then write `proceed` to docs/credentials-confirmed.txt
```

### Resume after a crash / cancellation

```
/start-build revolution-pictures  # 3 features already merged, process killed mid-4th
→ Orchestrator detects 3 merged features + 1 half-complete worktree
→ Resumes feat-booking-inquiry from its last attempt state
→ Continues through remaining DAG
```

## Factory ↔ project scope

Factory-level skill only. Lives at `.claude/skills/start-build/SKILL.md` in the factory root. Not copied into `projects/<name>/.claude/skills/` by `/new-project` — it invokes the factory's `orchestrator/` binary against a named project, so it must run from factory root.

## Integration points

- **Task 035 orchestrator** — the binary this skill wraps (`orchestrator/src/cli.ts`)
- **`orchestrator/src/feature-graph.ts`** — the Mode B implementation this skill triggers via `--resume-feature-graph`
- **Task 036 HITL gates** — irrelevant to Mode B (no human gates after gate 5); orchestrator does not spawn gate servers during feature-graph phase
- **`git-agent`** — the worktree lifecycle owner; orchestrator invokes it at feature boundaries
- **Builders (`backend-builder`, `web-frontend-builder`, `mobile-frontend-builder`)** — invoked inside each feature worktree per agent_sequence
- **`tester`, `reviewer`** — final two agents in every agent_sequence

## Acceptance criteria

- [ ] `.claude/skills/start-build/SKILL.md` exists with the frontmatter above
- [ ] Accepts `<project>` as required positional; rejects with available-projects list when missing
- [ ] Checks all 10 prerequisite artifacts before invoking orchestrator
- [ ] Parses `docs/credentials-confirmed.txt` and respects `proceed` / `defer:` / `abort` / missing
- [ ] Always invokes orchestrator with `--resume-feature-graph` flag
- [ ] Does NOT run Mode A stages under any circumstances
- [ ] Does NOT scaffold projects
- [ ] Confirms before live Mode B run; skips confirmation for `--dry-run`
- [ ] Exit code matches orchestrator's exit code
- [ ] Factory-level only (NOT copied into per-project skill dirs)
