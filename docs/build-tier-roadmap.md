# Build-tier roadmap — from design-signoff to shippable PR

**Date**: 2026-04-22
**Status**: approved (ready to execute)
**Source**: `plans/active/investigate-002-build-tier-readiness-gap.md` + 5 human-resolved open questions

This is the master roadmap for the post-design build tier. It lists every plan we intend to execute to reach the MVP goal, names the four must-have acceptance criteria that fold into those plans, and points at `post-mvp-scaffolding/` for items we're explicitly deferring. Use this doc to verify coverage before starting the next implementation plan.

## MVP goal

**Autonomous generation of shippable apps from a brief with little-to-no human interaction, with humans only gating at design decisions (gates 1–4) and the credentials file-drop (gate 5).**

Concretely: the user writes `brief.md` (or `/draft-brief` from a proposal), runs the pipeline, approves gates 1 → 2 → 3 → 4 → 5, and the orchestrator then runs the build tier autonomously to produce a **PR awaiting human approval before merge to main**. Gate 6 (human PR review) is the final HITL touch point before code lands on `main`.

## Decision log — 5 questions resolved

From `investigate-002` Recommendation's open questions, resolved by user on 2026-04-22:

1. **Autonomous-run target** — humans approve design stages (gates 1–4); build tier runs autonomously after gate 5. Gate 6 (human PR review before merge) is a new gate we add to `task-036-hitl-gates-server`.
2. **"Production quality" definition** — reviewer agent explicitly lists which quality dimensions it owns: architecture adherence, security, compliance per brief §14, maintainability signals, a11y beyond visual-review (semantic HTML + keyboard flows + ARIA), performance signals. Uncovered dimensions are known-gaps.
3. **First autonomous project** — mindapp-v2 re-run from gate-4 signoff state. No redoing design; resume at `/architect`.
4. **Reviewer playbook** — `reviewer-playbook.md` is a required artefact of `refactor-005-reviewer-alignment`. Concrete pass/fail criteria per dimension. Not AI-judgment blackbox.
5. **Brief-delivery check** — add to reviewer's scope (Option A: static analysis walking `tasks.yaml.features[]` + confirming committed code matches each feature's description). Option B (runtime walkthrough of every P0 feature) deferred to `post-mvp-scaffolding/brief-delivery-validation-depth.md`.

## Current state inventory (2026-04-22)

From `investigate-002` §Phase 1:

- **Agents shipped (3)**: analyst, ui-designer, git-agent
- **Skills shipped (28)**: 21 pipeline + 6 stack shelf + 1 template
- **Schemas shipped (9)**: architecture, brief-frontmatter, feature, feature-context, navigation, screens, signoff, tasks, visual-review-report
- **Hooks + rules + templates**: 4 + 1 + 13
- **Orchestrator runtime**: **zero code** — `orchestrator/index.ts` does not exist
- **Scaffolding tasks pending**: 20 (of which 026 + 027 are work-done-spec-pending)

Design tier validated end-to-end on mindapp-v2 (80 screens / 41 pass / 39 fail visual-review / gate-4 viewer rendered). Build tier has zero runtime code.

## The 8 critical-path plans (execute in this order)

Dependencies indicated as `[blocks: X]` + `[depends-on: Y]`. Critical path = 5 plans; 3 extension plans follow immediately.

### Phase I — Foundational runtime (plans 1 + 2)

Run both in parallel; they have no inter-dependency.

#### 1. `task-035-orchestrator-runtime` — P0, large

**Scope**: `orchestrator/index.ts` + `packages/orchestrator-contracts/` + `runStage()` + `runPipeline()` + `runFeature()` + `runFeatureGraph()` + Claude Agent SDK wrapper.

**Folds in (must-have acceptance criteria)**:

- **Cost enforcement**: orchestrator tracks cumulative `query()` cost via response metadata; aborts cleanly (checkpoint context first) when cumulative exceeds `perPipelineMaxUsd` per `.claude/models.yaml`
- **Retry-counter persistence** at `.claude/state/{pipelineRun}/counters.json` so crash-recovery preserves retry state

**Depends on**: nothing (but plan-author reads investigate-002 + refactor-004 Appendix D + feat-002/003/004 specs)
**Blocks**: every build-tier plan
**Estimated size**: 800-1500 LOC across orchestrator/ + contracts package

#### 2. `task-036-hitl-gates-server` — P0, medium

**Scope**: HTTP server backing gates 2 + 4; file-drop watcher for gate 5; spec extension to formalize gates 1 + 3 + 6 as file-drop pattern.

**Folds in (must-have acceptance criteria)**:

- **Gate 1 (requirements review)**: orchestrator pauses after `/analyze` + `/scan-assets` complete; file-watch for `docs/gate-1-approved.txt` containing `proceed` / `revise:<section>` / `abort`. Mirrors gate-5 pattern.
- **Gate 3 (design-system approval)**: orchestrator pauses after `/stylesheet` emits `docs/design-system-preview.html`; file-watch `docs/gate-3-approved.txt`. Same pattern.
- **Gate 6 (human PR review before merge)**: new gate after reviewer approves in feat-009. `git-agent` creates the PR; file-watch `docs/gate-6-approved.txt`. On approved: git-agent merges into main. On `abort`: PR stays open for manual handling. Default opt-in for first 5 autonomous runs; future flag `--auto-merge-after-reviewer` to disable once trust builds.

**Depends on**: `task-035` (gates hook into orchestrator `runStage()`)
**Blocks**: full end-to-end autonomous run
**Estimated size**: 500-800 LOC (HTTP server + file-watcher + templates shipped already + docs)

### Phase II — Post-design agents (plans 3 + 4 + 5)

Sequential (each depends on the previous).

#### 3. `refactor-005-reviewer-alignment` — P0, small

**Scope**: Update `scaffolding/18-032-reviewer-agent.md` to reflect refactor-004 (feature-graph) + feat-004 (testing-policy) + feat-002 (stack dispatch). Author `docs/reviewer-playbook.md` with concrete review dimensions + per-dimension pass/fail criteria.

**Dimensions the playbook must cover**:

1. Architecture adherence — does code follow architecture.yaml's slot choices + structure?
2. Security — starter 15-20-item checklist (top real-world failures: SQLi, XSS, auth bypass, CSRF, rate limiting, secret leakage, SSRF, CORS misconfig, input validation, output encoding, crypto misuse, session fixation, IDOR, file-upload abuse, rate-limit bypass). ASVS L1 full expansion is deferred to `post-mvp-scaffolding/security-checklist-grounding.md`.
3. Compliance per brief §14 — GDPR consent, COPPA age gate, data retention, export flow
4. Maintainability — lint passes, no TODOs in shipped code, public API documented via JSDoc/tsdoc, no `any` without comment justifying, no dead imports
5. A11y (MVP depth) — checklist: focus-visible exists, keyboard-reachable interactives, semantic landmarks, form labels. Axe-core integration deferred to `post-mvp-scaffolding/a11y-deep-coverage.md`.
6. Performance signals — web: bundle-size diff vs prior build, Largest Contentful Paint target 2.5s on Lighthouse; mobile: bundle size; backend: p95 endpoint response <200ms (lighthouse / artillery)
7. **Brief-delivery (new per answer #5)** — walks `tasks.yaml.features[]` confirming each is `status: completed` + committed code matches the feature's description

**No agent file or skill runtime authored here** — this is spec-refresh only. feat-009 does the implementation.

**Depends on**: nothing
**Blocks**: feat-009 (reviewer implementation)
**Estimated size**: ~800 LOC across updated scaffolding file + new playbook

#### 4. `feat-005-architect-implementation` — P0, medium

**Scope**: `.claude/agents/architect.md` + `.claude/skills/architect/SKILL.md`. Reads design signoff + brief + analyst outputs; produces `architecture.yaml` (v2 with `tooling.stack` per feat-002) + `.env.example` + credentials checklist + deployment checklist + **must-have infrastructure minimum**.

**Folds in (must-have acceptance criterion)**:

- **Infrastructure minimum**: architect emits `docker-compose.yml` for local dev (backend + database + optional Redis/queue per integrations) + `.github/workflows/ci.yml` (or equivalent per architecture.yaml.meta.ciProvider) with typecheck + lint + test + build jobs. Without this, first run's app can't boot on the user's machine beyond `pnpm install`.

**Depends on**: task-035 runtime
**Blocks**: feat-006 (pm needs architecture.yaml as input)
**Estimated size**: ~1000 LOC: agent file + skill steps + templates for docker-compose + CI workflow + .env.example generator + 3 checklist generators

#### 5. `feat-006-pm-implementation` — P0, medium

**Scope**: `.claude/agents/project-manager.md` + `.claude/skills/pm/SKILL.md`. Dual-mode: `--mode=tasks` (main; produces v2 tasks.yaml with `features[]` + `agent_sequence[]`) + `--mode=kit-change-request` (detour mini-plan). Feature-grouping heuristic per feat-003 refactor-004 spec.

**Depends on**: feat-005 (needs architecture.yaml)
**Blocks**: feat-007 (builders need tasks.yaml)
**Estimated size**: ~800 LOC

### Phase III — Builders (plan 6)

#### 6. `feat-007-builder-runtimes` — P0, medium (bundled 028/029/030)

**Scope**: 3 agent files + 3 skill files for backend-builder, web-frontend-builder, mobile-frontend-builder. Stack-dispatcher pattern per feat-002. Happy-path sibling-test generation per feat-004. Worktree CWD per refactor-004 / feat-003.

Bundled because ~70% of the code is shared: dispatch logic, stack-skill load, file-write + commit pattern, self-verify command block, retry-on-fail. Bundling saves triplication.

**Folds in (must-have acceptance criteria)**:

- **Seed data**: backend-builder generates `prisma/seed.ts` (or stack-equivalent like `scripts/seed.ts` for drizzle; `api/seeds/` for django/fastapi) from brief §12 "data needed to demonstrate the app" + `docs/analysis/{platform}/screens.json` example data references. Without seed data, apps boot with empty DB — not demonstrable.
- **Observability wiring**: when `architecture.yaml.apps.*.integrations.monitoring` names a vendor (Sentry, PostHog, etc.), backend-builder wires init calls + error-capture middleware; web/mobile builders wire matching client SDK init + page-view tracking.

**Depends on**: feat-006 (tasks.yaml + architecture.yaml)
**Blocks**: feat-008 (tester)
**Estimated size**: ~1500 LOC across 3 agent files + 3 skill files + shared dispatch helper

### Phase IV — Quality agents (plans 7 + 8)

#### 7. `feat-008-tester-implementation` — P0, small

**Scope**: `.claude/agents/tester.md` + `.claude/skills/test/SKILL.md` per feat-004 narrow-scope + `.claude/rules/testing-policy.md` (already shipped). Tester dispatches via stack skill §Testing blocks; adds edge cases + integration + E2E; enforces 80% total coverage.

**Depends on**: feat-007 (builders must have shipped code + happy-path tests to extend)
**Blocks**: feat-009 (reviewer runs after tester)
**Estimated size**: ~600 LOC

#### 8. `feat-009-reviewer-implementation` — P0, medium

**Scope**: `.claude/agents/reviewer.md` + `.claude/skills/review/SKILL.md` per refactor-005's refreshed spec + `reviewer-playbook.md`. Covers 7 dimensions from answer #2.

**Depends on**: refactor-005 (playbook must exist) + feat-008 (tester produces coverage numbers reviewer consumes)
**Blocks**: gate 6 (reviewer approval is input to PR gate)
**Estimated size**: ~1000 LOC + dimension-specific checklists

## Dependency graph

```
                    ┌─────────────────────────────────┐
                    │ 2. task-036-hitl-gates-server   │
                    │    (gates 1 + 3 + 6 formalized) │
                    └─────────────────────────────────┘
                                    ↑ parallel
                                    │
[START] →  1. task-035-orchestrator-runtime
            │
            ↓
         3. refactor-005-reviewer-alignment (spec refresh; runs parallel with 4)
            │
            ↓
         4. feat-005-architect-implementation
            │  (includes docker-compose + CI)
            ↓
         5. feat-006-pm-implementation
            │
            ↓
         6. feat-007-builder-runtimes (bundled 028/029/030)
            │  (includes seed data + observability wiring)
            ↓
         7. feat-008-tester-implementation
            │
            ↓
         8. feat-009-reviewer-implementation
            │  (uses refactor-005's playbook)
            ↓
         [gate 6: human PR review — task-036 handles]
            │
            ↓
         [MVP exit — first autonomous run on mindapp-v2]
```

## Coverage verification

Does this 8-plan roadmap + the 4 must-have acceptance criteria cover the full brief→PR path? Checked against each pipeline stage:

| Stage                                                         |    Exists pre-roadmap?    | Covered by roadmap? | Notes                                                                                                                                                                                                    |
| ------------------------------------------------------------- | :-----------------------: | :-----------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/new-project` (bootstrap)                                    |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| `/draft-brief` (proposal → brief)                             |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| `/analyze`                                                    |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| Gate 1 (requirements review)                                  |             ✗             |        **✓**        | Formalized in task-036                                                                                                                                                                                   |
| `/skills-audit --scope=design`                                |         spec only         |          —          | Works today without explicit runtime because design-stage MCPs are pre-registered at `/new-project` step 5b; runtime skill deferred                                                                      |
| `/mockups`                                                    |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| Gate 2 (style selection)                                      | ✓ (template + pick-style) |          ✓          | task-036 adds HTTP server                                                                                                                                                                                |
| `/stylesheet`                                                 |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| Gate 3 (design-system approval)                               |             ✗             |        **✓**        | Formalized in task-036                                                                                                                                                                                   |
| `/screens`                                                    |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| `/visual-review`                                              |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| `/user-flows-generator`                                       |             ✓             |          ✓          | No change                                                                                                                                                                                                |
| Gate 4 (sign-off)                                             |   ✓ (template + schema)   |          ✓          | task-036 adds HTTP server                                                                                                                                                                                |
| `/architect`                                                  |             ✗             |        **✓**        | feat-005                                                                                                                                                                                                 |
| **Infrastructure (docker-compose + CI)**                      |             ✗             |        **✓**        | feat-005 must-have                                                                                                                                                                                       |
| Gate 5 (credentials)                                          |             ✗             |        **✓**        | task-036 file-drop watcher                                                                                                                                                                               |
| `/pm`                                                         |             ✗             |        **✓**        | feat-006                                                                                                                                                                                                 |
| `/skills-audit --scope=build`                                 |             ✗             |          ✗          | **Deferred** (extension plan 9; shipped stack skills cover react-next + node-trpc-nest so skippable for mindapp-v2 re-run)                                                                               |
| `/register-mcp-servers --scope=build`                         |             ✗             |          ✗          | **Deferred** (extension plan 10; usually no-op)                                                                                                                                                          |
| git-agent `bootstrap`                                         |      ✓ (agent file)       |          ✗          | **Deferred** (extension plan 12; skill runtime not needed for orchestrator to orchestrate git; it handles calls directly) — ACTUALLY PUNT: orchestrator calls `git` CLI for bootstrap op inside task-035 |
| `runFeature()` loop starts                                    |             —             |          ✓          | task-035                                                                                                                                                                                                 |
| git-agent `checkout-feature`                                  |      ✓ (agent file)       |          ✓          | orchestrator invokes; task-035 handles                                                                                                                                                                   |
| `backend-builder`                                             |             ✗             |        **✓**        | feat-007                                                                                                                                                                                                 |
| **Seed data generation**                                      |             ✗             |        **✓**        | feat-007 must-have                                                                                                                                                                                       |
| `web-frontend-builder`                                        |             ✗             |        **✓**        | feat-007                                                                                                                                                                                                 |
| `mobile-frontend-builder`                                     |             ✗             |        **✓**        | feat-007 (null-skip if no mobile tier)                                                                                                                                                                   |
| **Observability wiring**                                      |             ✗             |        **✓**        | feat-007 must-have                                                                                                                                                                                       |
| `tester`                                                      |             ✗             |        **✓**        | feat-008                                                                                                                                                                                                 |
| `reviewer`                                                    |             ✗             |        **✓**        | feat-009                                                                                                                                                                                                 |
| git-agent `close-feature` → merge to feature branch           |      ✓ (agent file)       |          ✓          | task-035 orchestrator invokes                                                                                                                                                                            |
| `git-agent bootstrap-pr` (create PR from all merged features) |             ✗             |        **✓**        | Folded into task-036 Gate 6                                                                                                                                                                              |
| **Gate 6 (human PR review before merge to main)**             |             ✗             |        **✓**        | task-036 must-have                                                                                                                                                                                       |
| `lessons-agent` updates `docs/lessons.md`                     |             ✗             |          ✗          | **Deferred** (extension plan 13; manual aggregation works for first run)                                                                                                                                 |

**Coverage verdict**: **complete for MVP** — every stage from brief to "PR awaiting human approval" has a plan that ships it. Extension plans (9-13) add quality-of-life runtimes; deferrals (`post-mvp-scaffolding/`) add depth + polish once observed data justifies.

## Extension plans (after the 8 critical-path)

These land after MVP exit. They're needed for a complete factory but not for the first autonomous run.

9. `feat-010-skills-audit-runtime` — dual-scope skill (design + build) for the skills-agent. Needed when future projects pick stacks outside the shipped 5.
10. `feat-011-register-mcp-servers-runtime` — dual-scope MCP registration skill. Usually no-op (design MCPs already registered at /new-project time).
11. `feat-012-html-verifier` — Layer 6 CSS/token validator. Tightens the loop between /screens + /visual-review.
12. `feat-013-git-agent-skill-runtime` — skill runtime matching feat-003's 5-op spec (we get away without it in MVP by having task-035 call `git` CLI directly).
13. `feat-014-lessons-agent` — watches `plans/archive/` + auto-updates `docs/lessons.md` + selectively pushes to `~/.claude/CLAUDE.md`.

## Post-MVP scaffolding

13 deferred items stubbed in `post-mvp-scaffolding/`:

| File                                 | Trigger for revisit                                        |
| ------------------------------------ | ---------------------------------------------------------- |
| `multi-project-concurrency.md`       | User runs 2+ pipelines at once                             |
| `factory-self-upgrade.md`            | 3+ projects exist + factory evolves                        |
| `python-stack-codegens.md`           | A brief picks python backend                               |
| `mobile-stack-codegens.md`           | A brief picks Flutter / native mobile                      |
| `quickstart-command.md`              | After build tier ships (demo polish)                       |
| `agent-expert-meta-agent.md`         | 4th+ new agent needed                                      |
| `app-store-compliance.md`            | First project submits to App Store / Play Store            |
| `mutation-testing-policy.md`         | After tester produces real test output                     |
| `partial-failure-policy.md`          | After first autonomous run shows failure patterns          |
| `cost-projection-preview.md`         | After 3-5 runs yield cost-baseline data                    |
| `a11y-deep-coverage.md`              | After reviewer's a11y checklist misses something           |
| `security-checklist-grounding.md`    | After reviewer's starter checklist misses issues           |
| `brief-delivery-validation-depth.md` | After static brief-delivery (Option A) proves insufficient |
| `runtime-signoff-gate.md`            | After 2-3 runs expose design-vs-build drift                |

`post-mvp-scaffolding/README.md` indexes all of these with return criteria.

## Exit criteria — when is MVP done?

MVP is complete when **all 8 critical-path plans are archived with outcome: success** AND:

1. `mindapp-v2` re-run successfully resumes from its gate-4 signoff state
2. `/architect` emits valid `architecture.yaml` + `.env.example` + checklists + `docker-compose.yml` + CI config
3. Gate 5 opens; user fills `.env`; `docs/credentials-confirmed.txt` drops `proceed`
4. `/pm --mode=tasks` emits valid v2 tasks.yaml with features[]
5. Feature-graph runs; builders produce code in per-feature worktrees; typecheck + lint + tests pass per feature
6. Tester adds edge cases + integration + E2E; coverage ≥80% total
7. Reviewer runs 7 dimensions; all pass OR human reviews flagged items
8. git-agent creates PR via task-036's gate-6 mechanic
9. Human approves `docs/gate-6-approved.txt` → PR merges to main
10. `docs/lessons.md` reflects lessons from the run (manually aggregated; lessons-agent comes later)

## Things we're explicitly NOT targeting for MVP

### Deploy + infrastructure (bundle — punted per investigate-003 2026-04-22)

- **Cloud deploy automation**: PR merges to main; human deploys to their cloud manually. No Vercel push / Fly deploy / Terraform apply in MVP. See `post-mvp-scaffolding/iac-stack-shelf.md`.
- **Multi-env separation (dev / test / prod)**: single `.env` via gate 5; no staging environment; no per-env secrets config. Local dev via docker-compose. See `post-mvp-scaffolding/multi-env-deploy.md`.
- **IaC tooling (Terraform / Pulumi / CDK / Ansible / Helm)**: feat-005 emits only `docker-compose.yml` + `.github/workflows/ci.yml`. No cloud resource provisioning. See `post-mvp-scaffolding/iac-stack-shelf.md`.
- **CI/CD deploy automation beyond PR checks**: CI runs typecheck + lint + test on PR. No deploy-on-merge, no PR preview deploys, no gate-7 prod approval. See `post-mvp-scaffolding/ci-cd-deploy-automation.md`.
- **Client-supplied infrastructure** (on-prem k8s, existing Terraform stacks): architect surfaces in credentials-checklist as "manual deploy required; not automated for MVP"; human handles.
- **Production secrets management**: beyond single `.env.example`. No Doppler / AWS Secrets Manager / Vault integration.
- **Infra-level monitoring** (CloudWatch hosts / Datadog agents / uptime checks): feat-007 wires SDK-level observability (Sentry / PostHog in code); infra-level belongs with IaC.
- **DNS / certs / CDN provisioning**: part of the deferred IaC bundle.
- **Compliance-driven infrastructure** (SOC2 VPC isolation / HIPAA encrypted backups / GDPR data residency): reviewer flags in playbook output; architect doesn't auto-configure.

### Other non-targets (from earlier scoping)

- **Mobile App Store submission**: handled by `post-mvp-scaffolding/app-store-compliance.md`
- **Multi-project concurrent builds**: handled by `post-mvp-scaffolding/multi-project-concurrency.md`
- **Factory self-upgrade** + in-flight project protection
- **Stack skills beyond the shipped 5** (react-next / svelte-kit / node-trpc-nest / python-fastapi / expo-rn)
- **Mutation testing / axe-core / ASVS L1 full security checklist**: starter variants land in MVP; depth in post-MVP
- **Runtime sign-off gate (gate 7 concept)**: static sign-off via gate 4 is sufficient for MVP
- **Factory marketing / onboarding UX** (`/quickstart`)

## Next step

Begin `task-035-orchestrator-runtime` implementation. First write the full plan file (`plans/active/task-035-orchestrator-runtime.md` — or `plans/active/refactor-006-orchestrator-runtime.md` if we want a refactor prefix since it's transforming scaffolding-spec-into-code). Then execute per the plan's approach steps.

## Approval record

- **2026-04-22 v1.0**: 5 open questions resolved by user; 4 must-have acceptance criteria assigned to host plans; 13 post-MVP items stubbed; this roadmap authored.
- **2026-04-22 v1.1** (this patch): investigate-003-infrastructure-as-code drafted + punted to post-MVP without executing. 3 new stubs added (`iac-stack-shelf.md` + `multi-env-deploy.md` + `ci-cd-deploy-automation.md`) — bundle together when revisited. §Things we're explicitly NOT targeting extended with a "Deploy + infrastructure" sub-section. task-035 scope unchanged.
- **Next approval needed**: promote task-035-orchestrator-runtime plan draft → approved; begin Phase 1 implementation.
