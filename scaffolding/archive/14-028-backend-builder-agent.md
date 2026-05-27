---
task-id: "028"
title: "Backend Builder Agent"
status: pending
priority: P2
tier: 7 — Build Pipeline
depends-on: ["020", "027"]
estimated-scope: medium
---

# 028: Backend Builder Agent

## What This Task Produces

1. Agent definition at `.claude/agents/backend-builder.md`
2. Skill at `.claude/skills/build-backend/SKILL.md`

## Scope

### Agent Definition

```yaml
---
name: backend-builder
description: Stack-agnostic backend builder. Reads architecture.yaml.tooling.stack.backend_framework, dispatches to the matching stack skill, generates code per that skill's canonical layout + idioms into apps/api/.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
permissionMode: acceptEdits
maxTurns: 30
---
```

### System Prompt

- **Dispatch via stack skill (feat-002).** Read `architecture.yaml.tooling.stack.backend_framework` (e.g. `node-trpc-nest`, `python-fastapi`). Load `.claude/skills/agents/back-end/{stack-slug}/SKILL.md` verbatim into the working prompt context. The stack skill provides: canonical layout, idioms, testing recipe, stack-specific commands (lint / typecheck / test), gotchas, dependency pins, anti-patterns. **Do not generate hardcoded Next/NestJS/Prisma output** — the stack skill drives every stack-specific choice.
- Read `.claude/architecture.yaml` focusing on backend sections (apps.api, integrations with `deployment: vendor | self-hosted`)
- Read `docs/tasks.yaml` (v2 per refactor-004) for assigned tasks — filter `features[].tasks[]` to those where `agent: backend-builder` AND the parent feature's `skip[]` does NOT include `backend`. Tasks run within the feature's worktree at `.claude/worktrees/{features[i].worktree}/`.
- **Read `.env` for runtime secrets** — user-authored at gate 5 (refactor-003) after `/architect` emits `.env.example` with placeholder rows. `block-dangerous.sh` (task 007) blocks general agent `.env` reads; backend-builder inherits a sanctioned exception because runtime config is load-bearing for build-and-test. Missing required-now keys surface as loud failures at container startup / first API call — correct failure mode since the user was warned at gate 5 via `docs/credentials-checklist.md`.
- Generate into `apps/api/` following the loaded stack skill's §Canonical layout.
- Use `@repo/types` (Node stacks) or the generated `packages/python-types/` mirror (Python stacks) for shared schemas — never re-declare.
- Run the stack skill's §Commands `lint && typecheck && test` as self-verify gate after every implementation file written. Failure retries up to 2× with error context fed back. Per `feat-004-builder-tdd-hybrid`: builder also generates happy-path unit tests alongside code.

### Inputs

| Input                                                    | Source                                                  | Purpose                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/architecture.yaml`                              | `/architect` output (refactor-003, post-signoff)        | Stack choices, integration vendors, data models, routing                                                                                     |
| `docs/tasks.yaml`                                        | `/pm --mode=tasks` output                               | Assigned backend tasks with `integration-ref` pointers                                                                                       |
| `.env`                                                   | User-authored at gate 5                                 | Runtime secrets: `STRIPE_SECRET_KEY`, `THIRDWEB_SECRET_KEY`, `RESEND_API_KEY`, etc. Must be filled before `/build-backend` runs.             |
| `.env.example`                                           | `/architect` output                                     | Reference for which keys exist; used for sanity-checking env vars referenced in generated code match what the architect told the user to set |
| `packages/types/`                                        | `/stylesheet` indirect + `@repo/orchestrator-contracts` | Shared Zod schemas                                                                                                                           |
| `packages/orchestrator-contracts/`                       | Task 034b                                               | Output schemas the backend validates against                                                                                                 |
| Self-hosted config templates in `docs/config/*.template` | `/architect` output for self-hosted integrations        | Pointers to deployment config, NOT built into the app                                                                                        |

### /build-backend Skill — stack-agnostic dispatcher (feat-002) + hybrid TDD (feat-004)

Steps:

1. Read `architecture.yaml` — extract `tooling.stack.backend_framework`. If null → abort (no backend tier for this project); mark any assigned `agent: backend-builder` tasks as `skipped`.
2. Load `.claude/skills/agents/back-end/{backend_framework}/SKILL.md` verbatim into prompt context. If the skill doesn't exist → abort with "Stack skill missing — re-run /skills-audit --scope=build --auto-author-stack-skills". (Orchestrator handles this abort per refactor-004 §Feature-graph phase step 3.)
3. Load `.claude/rules/testing-policy.md` into prompt context — the cross-stack hybrid-TDD contract.
4. Read `docs/tasks.yaml` (v2); filter to `features[].tasks[]` where `agent: backend-builder` AND parent feature's `skip[]` doesn't include `backend`.
5. For each feature in the filtered set:
   - Orchestrator has already opened the worktree via git-agent (per refactor-004); this skill runs with `CWD=.claude/worktrees/{features[i].worktree}/`.
   - For each assigned task in the feature (respecting `depends_on` within the feature):
     - Generate implementation files per the loaded stack skill's §Canonical layout + §Idioms.
     - **Generate sibling happy-path test file** per the stack skill's §Testing pattern (feat-004 hybrid). Test covers: canonical success case of every public function / endpoint; primary branch of each non-trivial conditional; positive input-validation at public boundaries. See `.claude/rules/testing-policy.md` §"What counts as 'happy path'" for the full shape.
     - **Run stack skill's full self-verify command block** — `lint && typecheck && test` with coverage. On failure, retry up to 2× with error context fed back. On persistent failure, escalate to orchestrator (per-task retry, max 3 per refactor-004).
     - **Assert 60% line coverage** on files the builder authored (stack skill's coverage flag parses this). Below 60% → generate more tests or escalate; don't silently continue.
   - After all feature tasks complete + all tests pass + coverage ≥ 60%, return success; orchestrator advances to the next agent in `feature.agent_sequence[]` (typically `tester` — who adds edge cases + integration + E2E + raises total to 80% per testing-policy.md).
6. Report files created per task; emit return JSON matching `BackendBuildOutput` (034b) with `stackSlug`, `testsWritten`, `coverageBuilderScope` fields.

## Acceptance Criteria

- [ ] `.claude/agents/backend-builder.md` exists + is STACK-AGNOSTIC — no hardcoded NestJS / Prisma / tRPC references in the agent system prompt
- [ ] `.claude/skills/build-backend/SKILL.md` exists with the dispatch procedure above
- [ ] Skill reads `architecture.yaml.tooling.stack.backend_framework` and loads the matching `.claude/skills/agents/back-end/{slug}/SKILL.md` prompt pack verbatim
- [ ] Skill aborts with a clear error if the referenced stack skill is missing (no silent fallback)
- [ ] Skill reads `docs/tasks.yaml` v2 (refactor-004) — filters features[].tasks[] where `agent: backend-builder` AND `feature.skip[]` doesn't include `backend`
- [ ] Skill runs inside the feature's worktree (CWD handled by orchestrator per refactor-004 §runFeature)
- [ ] Self-verify uses the stack skill's `lint && typecheck && test` command block (NOT hardcoded `pnpm typecheck && pnpm lint`)
- [ ] **feat-004 hybrid TDD**: builder generates happy-path sibling test file alongside every implementation file per the stack skill's §Testing pattern
- [ ] **feat-004 coverage**: builder runs test command with `--coverage`; asserts ≥ 60% line coverage on files it authored (from `.claude/rules/testing-policy.md`)
- [ ] **feat-004 scope discipline**: builder does NOT write edge-case / integration / E2E tests — those are tester's scope (SKILL.md references testing-policy.md for the full split)
- [ ] Agent reads `.claude/rules/testing-policy.md` into prompt context at dispatch time
- [ ] Return JSON includes `stackSlug` + `testsWritten` + `coverageBuilderScope` fields (034b `BackendBuildOutput` update pending)
- [ ] `model: inherit` used (orchestrator assigns model)

## Human Verification

Is the dispatch pattern clear? When architect picks `backend_framework: python-fastapi`, does the builder load `.claude/skills/agents/back-end/python-fastapi/SKILL.md` and produce FastAPI code — not NestJS? Verify with a synthetic architecture.yaml fixture + a dry-run of the skill.
