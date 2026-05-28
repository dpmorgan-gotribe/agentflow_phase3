# Phase 2 inventory — working scratch for feature_list.json

Walk of `C:\Development\ps\claude\claude_\agentflow_phase2`. Source of truth for Pass 3 (boundary review) and Pass 4 (drafting). `[UNFINISHED]` flag means stub, in-flight rename, or partial integration in Phase 2.

---

## A. Subagents (`.claude/agents/*.md`) — 16, all shipped

| #   | Slug                    | Purpose                                                                                                                                                                                  | Mode |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | analyst                 | Brief → research, N style options, assets, mood, flows, screens.json, requirements. Fans out 5 parallel workers via Agent tool.                                                          | A    |
| 2   | architect               | Post-signoff: architecture.yaml + .env.example + credentials/deployment checklists. Hash-detect re-runs.                                                                                 | A    |
| 3   | backend-builder         | Stack-agnostic; dispatches to `.claude/skills/agents/back-end/{slug}/`. Generates code + happy-path tests in `apps/api/`. Hybrid TDD 60%.                                                | B    |
| 4   | bug-fixer               | Narrow patcher for `/fix-bugs`. Smallest diff. Bug-class discriminator drives shape.                                                                                                     | B    |
| 5   | git-agent               | Worktree lifecycle, branch mgmt, merge-to-main, conflict routing. Boundary-only.                                                                                                         | B    |
| 6   | mobile-frontend-builder | Stack-agnostic (`expo-rn`, `flutter`); dispatches to `agents/mobile/{stack}`. `apps/mobile/`.                                                                                            | B    |
| 7   | perceptual-reviewer     | Vision-LLM (Tier 4). mockup PNG vs live PNG → structured discrepancies. Findings only, not a fixer.                                                                                      | B    |
| 8   | project-manager         | `--mode=tasks` (tasks.yaml v2 + feature-grouping) / `--mode=kit-change-request` detour.                                                                                                  | A    |
| 9   | reviewer                | Last agent before merge. 8-dimension review (architecture, security, compliance, maintainability, a11y, perf, brief-delivery, design-conformance). Stack-aware (loads §Review).          | B    |
| 10  | security                | OWASP Top 10 + CWE Top 25 + ASVS L1. PM-flagged security-sensitive features only. P0/P1/P2 with CWE IDs.                                                                                 | B    |
| 11  | skills-agent            | Meta. `--scope=design` (playwright, icons8, unsplash, chrome-devtools, image-generator) / `--scope=build` (per architecture.yaml). Idempotent. Flags missing.                            | A    |
| 12  | systemic-fixer          | Cross-file root-cause for systemic bugs. Suspects build pipeline first. Multi-file authorized.                                                                                           | B    |
| 13  | tester                  | Hybrid TDD edge-cases + integration + Playwright (web) / Maestro (mobile). 80% coverage gate. Flags genuine product bugs back to builder. Write-test-only.                               | B    |
| 14  | ui-designer             | Mockups (N×M), ui-kit (tokens + primitives + patterns + layouts), screens composed from kit. Vision-capable. [UNFINISHED: hardcoded MCP scope in frontmatter; refactor-003 task 041]     | A    |
| 15  | walkthrough-reviewer    | Vision-LLM (Tier 5). Sequenced screenshots + network + console → behavioral findings (dup-request, no-op controls, broken nav, theme inconsistency, silent net failures). Findings only. | B    |
| 16  | web-frontend-builder    | Stack-agnostic; `agents/front-end/{slug}/`. `apps/web/`. Never hardcodes, always kit-consumes, reads `data-kit-*`.                                                                       | B    |

---

## B. Workflow skills (`.claude/skills/*/`) — operator-invoked `/command`

**Design-pipeline skills (Mode A):**

- analyze (task 019) — first stage; 5 parallel phases via Agent tool. Re-invokable with flags.
- architect (task 020) — also a direct skill.
- mockups (task 023) — N styles × M apps; populates `docs/selected-style.json` via `/pick-style`.
- pick-style (gate 2 operator action) — selects style; locks binding.
- stylesheet (task 024) — `packages/ui-kit/` scaffold with tokens + primitives + patterns + layouts. v1.0.0 + CHANGELOG.
- stylesheet-primitives — [UNFINISHED] likely a subscope of stylesheet.
- screens (task 025) — composes screens from kit with `data-kit-*` attrs. Emits `docs/screens/{platform}/*.html` + manifest.
- visual-review (task 025b) — Playwright screenshots; design rubric; iterates with designer.
- user-flows-generator (task 026) — Mermaid/SVG flow diagrams; gate 4 binding.
- scan-assets (task 019b) — walks `assets/`, emits `docs/asset-inventory.json` (logos, icons, fonts, wireframes, colors).
- skills-audit — design or build scope; flags missing.
- register-mcp-servers (task 041) — registers per `architecture.yaml.mcp_servers[]`.
- validate-brief — frontmatter + 20-section + cross-field invariants. [UNFINISHED: Phase 2 validation per feat-011]

**Brief / project lifecycle skills:**

- new-project — scaffolds `projects/<name>/`; clones factory resources; seeds brief.md; `--proposal*` auto-fills; `--agentic-visibility` flag.
- draft-brief — freeform proposal → 20-section brief.md; accepts `--proposal "<text>"`.
- delete-project — soft-archive; `--nuke` hard.
- check-existing-work — pre-flight audit: architecture, tasks, worktrees. Resume readiness.

**Build-orchestration skills (Mode B):**

- start-build (task 035) — Mode B entrypoint. Reads tasks.yaml v2. `--dry-run`, `--max-concurrent`, `--require-pr-review`.
- pause-build — halts mid-graph; preserves state.
- dag-status — live DAG dashboard.

**Bug/fix skills (Phase 3):**

- build-to-spec-verify (task 037) — 5-tier verifier. [UNFINISHED: Tiers 4-5 stubs feat-068, feat-069]
- parity-verify — pixel-parity structural. [UNFINISHED: Phase 2 feat-067]
- fix-bugs — manual loop driver against `docs/bugs.yaml`. `--max-iterations`, `--max-concurrent`, `--dry-run`.

**Planning skills (operator detours):**

- plan-bug, plan-feature, plan-investigation, plan-refactor, plan-archive, plan-search, plan-status
- idea, idea-list (unclear scope; [UNFINISHED]), idea-promote

**Context / session skills:**

- save-context — snapshot stage context to `.claude/context/`.
- load-context-chain — cumulative prompt assembly from prior stages.
- quota-status — token+cost dashboard; integrates `~/.claude/models.yaml`.

**Agent-as-skill shims (also operator-callable):**

- backend-builder, mobile-frontend-builder, web-frontend-builder, tester, reviewer, git-agent, pm

---

## C. Stack skills (loaded by builder agents, not operator-invoked)

**Backend cores (finished):**

- node-fastify — Fastify 5 + better-sqlite3 + Zod. REST.
- node-trpc-nest — NestJS + tRPC + Prisma. Type-inferred full-stack.
- python-fastapi — FastAPI + SQLAlchemy + Pydantic. Async.

**Frontend cores (finished):**

- react-next — Next.js 14 App Router + React 19 + Tailwind.
- svelte-kit — SvelteKit 2 + Svelte 5 + Tailwind.

**Mobile cores (finished):**

- expo-rn — Expo 52 + React Native 0.77 + EAS Build.

**Vendor stack skills (all [UNFINISHED] stubs):**

- calcom-embed, mux-player-react, next-sanity, plausible-analytics, react-email, resend-transactional, sanity-studio, turnstile-widget

**Analyzer subscopes (`analyze/*.md`, finished):**

- research.md, styles.md, assets.md, inspirations.md, flows.md, screens.md, integrations.md

**Template:**

- agents/\_template/SKILL.md — boilerplate for new stack/vendor skills.

---

## D. Orchestrator modules (`orchestrator/src/*.ts`) — 37 files

**Factory infra (all finished):**

- auth-provider — Anthropic / Claude Max / Bedrock / Vertex resolver. Env copy mutation, never process.env.
- model-config — merged `.claude/models.yaml` + `~/.claude/models.yaml`. Per-agent model, effort, budget, stallTimeoutMs.
- budget-tracker — pipeline-wide cost accumulator; per-model breakdowns; BudgetExceededError.
- agent-mcp-config — parses frontmatter `mcp_servers: []`; filters factory `.mcp.json`.
- pause — `pauseRun()` writes paused.json atomically; throws PauseSignal.
- retry-counters — 5-tier table (layer5=3, visual-review=3, task-retry=2, merge-conflict=3, kit-change-request=2). Snapshot/restore.
- state-persistence — `.claude/state/{pipelineRunId}/counters.json`. Atomic.

**Mode A pipeline:**

- stages-array — canonical Mode A stage list. [UNFINISHED: placeholder z.unknown schema; task-034b]
- stage-runner — runs one slash-command stage; budget pre-check; Layer-5 retry (max 3).
- pipeline — Mode A orchestrator; walks STAGES; file-drop gate watcher; state persistence.
- project-state — detects completed Mode A stages by primary output file.
- brief-coverage-gate — post-/pm gate; shells `scripts/audit-brief-coverage.mjs`.
- kit-change-request-detour — design-phase detour; reruns /stylesheet ± /architect; 2-per-pipeline cap.
- visual-review-retry — per-screen regen + re-review; 3 per screen; feeds `needsHumanReview[]`.

**Mode B build orchestration:**

- tasks-loader — load + validate `docs/tasks.yaml`.
- feature-graph — Mode B executor; per-task agent dispatch; worktree commit; deps install; pr-review gate. [UNFINISHED: perceptual integration + fine-grained pause]
- invoke-agent — SDK dispatch wrapper; bug-fix context injection; output validation; tester-diff audit; worktree seed/commit/install. [UNFINISHED: bug-134 transition; `.bug-134-final` companion backup file]
- gate-server-lifecycle — file-drop gate-{n}-approved.txt watcher; directive parser (proceed/revise/reject/abort/defer). MVP no-op HTTP server.
- rounds-orchestrator — outer 1→4 round loop wrapping `runFixBugsLoop`. Final-gate round 5. Outer-cap (default 8).

**Verify + bugfix (Phase 3):**

- build-to-spec-verify — orchestrator wrapper; shells reachability + synth-flows; runs discriminators, parity, perceptual, walkthrough. [UNFINISHED: perceptual/walkthrough integration]
- pre-verify-discriminators — cheap ~10ms FS checks for systemic misconfigs.
- parity-verify — Playwright per-screen DOM-skeleton + computed-styles diff. Stub `compareScreen` injectable.
- audit-pixel-diff — pure-function PNG diff (pixelmatch + PNG.sync); env threshold overrides.
- perceptual-review — Tier 4 dispatcher; per-screen vision-LLM with mockup+live PNG.
- walkthrough-review — Tier 5 dispatcher; single agent call with evidence bundle.
- tester-diff-audit — 6 anti-pattern scanner over `git diff` (seed-shape, URL-sub, assertion-loosening, removed-assertions, long-sleep, type-coercion, brief-enrichment).
- dev-server — boot/teardown; stack-aware backend port; pnpm+uv spawn; taskkill (Win) / process.kill (POSIX).
- fix-bugs-loop — reads bugs.yaml; clusters; dispatches bug-fixer/systemic-fixer; verifies; merges; iteration cap 10. Protected-files guard. [UNFINISHED: clustering integration, final merge cascade]
- cluster-bugs — pre-dispatch grouping by (source, pattern, screen); fold ≥threshold into systemic-divergence parent.
- bug-fix-context — pre-loaded context per bug.source; walks `apps/web/app/**/page.tsx` for `data-screen-id`; markdown block for prompt.
- protected-files — hard guard; 4 classes (files, tuples, packages, content invariants); rolls back merge.
- verify-worktree — dedicated `.claude/worktrees/verify/` on `fix/bugs-yaml-iter`; lazy create + reset --hard.

**Shared utilities:**

- cli — Commander entry; flags (--resume-from-stage, --dry-run, --require-pr-review, --max-concurrent, --pipeline-run-id, --bugs-yaml-mode).
- cli-runner — Mode A → Mode B → rounds-orchestrator. [UNFINISHED: orchestration seams]
- index — barrel re-exports.
- round-state — pure `deriveRoundState()` + `bugsInRound()`.
- \_phase1-smoke — [STUB] empty export.
- invoke-agent.ts.bug-134-final — [STUB / IN-FLIGHT] companion backup of bug-134 rename.

---

## E. Hooks (`.claude/hooks/`) — 4, all load-bearing

- block-dangerous.sh — PreToolUse Bash; rm -rf /, force-push to main, SQL drop/truncate, npm publish, deploy cmds, Tier B data-wipe (prisma/drizzle/S3). Exempts `--force-with-lease`, `--dry-run`. Fail-closed (jq or python required).
- validate-brief.mjs — PreToolUse Write/Edit/MultiEdit on brief.md. Frontmatter + §7/§10 code-block presence. In-memory simulation. Deny via hookSpecificOutput.
- enforce-boundaries.sh — PreToolUse Write/Edit. Blocks outside `$CLAUDE_PROJECT_DIR` (harness-state exception `~/.claude/projects/{slug}/`). Blocks sensitive files (.env, _.pem, _.key, SSH, credentials.json, certs, .keystore). Cascades to git-agent.
- detect-loop.mjs — PreToolUse all tools. Blocks 3rd identical action (hash of tool + file/cmd + content). Carve-out: Playwright capture. Rolling state in `recent-attempts.json` (50). Fail-open on unparseable input.

---

## F. Rules (`.claude/rules/`) — 2

- protected-files-policy.md — 4 classes; canonical machine-readable manifest = `orchestrator/src/protected-files.ts`. Empirical: reading-log-02 bug-077 (deleted postcss.config.mjs regression).
- testing-policy.md — Hybrid TDD: builder 60% happy-path / tester 80% edge + integration + E2E. 3 hard constraints (external-API must mock, tester-no-source-edits, no brief-scoped-out enrichment). 3 seeding strategies (A localStorage, D page.route intercept, C /test/seed). 6 anti-patterns disqualify "interpretive latitude".

---

## G. Templates (`.claude/templates/`) — 16

- ui-kit-contract.md — 6 consumption rules + escapes + enforcement.
- ui-kit-eslint-plugin/ — 4 rules: no-arbitrary-tailwind, no-deep-imports, no-hex-in-className, no-inline-style-tokens.
- ui-kit-tsconfig-consumer.json — barrel-only path alias.
- ui-kit-validate-consumer.ts — consumer validator stub.
- mockups-index-template.html, user-flows-template.html — HTML scaffolds.
- worktrees-README.md — worktree practices + state recovery.
- Dockerfile templates × 4 (express, fastify, trpc-nest, fastapi).
- dev-multi-tier templates × 4 (same stacks).
- E2E seed templates × 4: playwright-global-setup, seed-intercept (page.route), seed-localstorage, seed-db (/test/seed contract).

---

## H. Schemas (`schemas/`) — 16 JSON schemas

brief-frontmatter, navigation, bugs-yaml, build-to-spec-verify-output, parity-verify-output, screen-fixture, screens (discriminated union), user-flows-manifest, brief-capabilities, architecture, feature-context, feature, signoff, tasks-coverage, tasks, visual-review-report.

---

## I. Packages (`packages/`) — 1

- @repo/orchestrator-contracts — Zod schemas + TS types for orchestrator↔agent. Exports: common.ts (RoundState, StageSchemas lookup), stages.ts (21 stages), tasks.ts (Task, WorkItem), feature-context.ts, git-agent.ts, model-config.ts. 121 tests. v0.1.0; brief-signoff (gate 3) version lock.

---

## J. Scaffolding (`scaffolding/`) — 8 active + 40 archived

Master index `000-scaffolding-index.md`. Tiers 1-4 + Phases A-E:

- Tier 1 (001-006): work mgmt (plans, skills)
- Tier 2 (007-010): safety (hooks, justfile)
- Tier 3 (011-014): config (models.yaml, settings.json, context skills)
- Tier 4 (015-019 + 5b monorepo): brief + bootstrap
- Phase A (01-06 / 022-025b): design pipeline (UI Designer → mockups → stylesheet → screens → visual-review → signoff)
- Phase B (07-08 / 020-021): post-design planning (Architect → PM, gate 5 between)
- Phase C (09-13 / 034b-034-041-026-027): contracts + infra
- Phase D (14-16 / 028-030): builders
- Phase E (17-26 / 031-040): quality + ship + lessons + agent-expert + app-store compliance

Notable active docs:

- 10-034-output-contracts.md — 7-layer defense (prompt → file protocol → Zod → PostToolUse + anti-slop → retry → Haiku html-verifier → Sonnet visual-review). Plus Layer 0 consumer contract.
- 12-026-turborepo-scaffold.md — monorepo root, pnpm-workspace, turbo.json, app/package stubs. `pnpm.onlyBuiltDependencies` gate (bug-153).
- 13-027-shared-packages.md — @repo/types, @repo/ui-kit, @repo/api-client, @repo/utils + ESLint plugin + validate-consumer + CONTRACT.md.
- 19-032b-html-verifier-agent.md — [UNFINISHED] Haiku Layer 6 agent.
- 24-037-lessons-agent.md — [UNFINISHED] error-pattern memory across global/project/agent scopes.
- 25-040-app-store-compliance.md — [UNFINISHED] Apple/Google compliance gate (4.3 spam, 4.2 min functionality, 2.5.2 code execution, 5.1.2 third-party AI, privacy manifest).
- 26-039-agent-expert.md — [UNFINISHED] meta-agent that detects patterns + authors new skills.

---

## K. Configuration

- `.claude/settings.json` (shipped): PreToolUse hooks (block-dangerous, enforce-boundaries, validate-brief, detect-loop). PostToolUse prettier on Write/Edit. SessionStart load-context reminder. Permissions allow Read/Grep/Glob, just, git read-only, ls, pnpm run/test/typecheck/lint, docker compose/ps/logs/exec/inspect. Deny rm, curl|, wget, force-push, docker rm/rmi/volume rm/prune, npm/pnpm/yarn/bun publish.
- `.claude/settings.local.json` (NOT shipped): developer additions (git mv, node, python, cp, Skill(draft-brief), docker netstat, pnpm install).
- `models.yaml` — not in phase2 dir; lives in `~/.claude/` or factory parent.
- `architecture.yaml.template` — at `.claude/` root.

---

## L. Pipeline / companion

- `pipeline/.gitkeep` — empty placeholder.
- `companion/.gitkeep` — empty placeholder.

---

## TOTALS

| Area                      | Count    | Unfinished                                                                                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents                 | 16       | 1 (ui-designer MCP scope)                                                                                                             |
| Workflow skills           | 43       | 4 (stylesheet-primitives, idea-list, validate-brief, build-to-spec-verify Tiers 4-5)                                                  |
| Stack-skill cores         | 6        | 0                                                                                                                                     |
| Stack-skill vendors       | 8        | 8 (all stubs)                                                                                                                         |
| Analyzer subscopes        | 7        | 0                                                                                                                                     |
| Orchestrator modules      | 37       | 4 + 2 stubs (stages-array schemas, feature-graph integration, invoke-agent bug-134, cli-runner seams, \_phase1-smoke, .bug-134-final) |
| Hooks                     | 4        | 0                                                                                                                                     |
| Rules                     | 2        | 0                                                                                                                                     |
| Templates                 | 16       | 0                                                                                                                                     |
| Schemas                   | 16       | 0                                                                                                                                     |
| Packages                  | 1        | 0                                                                                                                                     |
| Active scaffolding        | 8        | 4 (html-verifier, lessons-agent, app-store, agent-expert)                                                                             |
| **Distinct capabilities** | **~165** | **~22 unfinished**                                                                                                                    |
