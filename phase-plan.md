# phase-plan.md — the canonical rebuild manifest

> **This is a living document.** It evolves with shipped reality via `/sync-phase-plan` (phase0-step-014).
> If you rebuilt the system from this doc alone (starting from a clean repo at `phase-N-start`),
> you should arrive at the currently-shipped system — same modules, same wiring, same hooks, same
> rules. Drift between this doc and the code is what causes the 200-bugs-of-rediscovery problem
> that Phase 2 hit.
>
> The frozen kickoff snapshot of any phase is `git show phase-N-start:phase-plan.md`.
> The working copy is always the source of truth.
>
> Source of truth for capability scope: `feature_list.json` (134 rows). This doc encodes the _why_
> behind those rows + the architectural decisions they implement.

---

# Phase 0 — Build the factory

## Goal

Produce a working agentic factory in `.claude/` plus orchestrator/, packages/, schemas/, scaffolding/,
scripts/, 6 root artifacts. Factory is capable of running `/new-project` end-to-end and dispatching
all 16+ subagents through Mode A and Mode B pipelines.

## Definition of done

- All Phase 0 rows in `feature_list.json` (phase0-step-001 through phase0-step-061) have `passes: true` with evidence
- `phase0-step-048` HUMAN closure signed off
- `git tag phase-0-done`

## Scope sections (filled by /sync-phase-plan as rows close)

### §0a Harness baseline (rows 001-016, 042)

**Folder + root artifacts**

- Factory tree: `.claude/{agents,skills,hooks,rules,templates,state}/`, `schemas/`, `scaffolding/`, `packages/`, `scripts/`, `orchestrator/{src,tests,scripts}/`, `evidence/`, `contracts/`, `contexts/`, `investigations/`, `reports/`, `projects/`, `docs/` (added 2026-05-27 after phase0-step-002)
- 6 root artifacts: `CLAUDE.md` (startup ritual + retry policy 1-5 + test policy + protected-files reference + factory↔project split rule), `PROGRESS.md` (append-only, recent-at-bottom convention), `phase-plan.md` (this file, living rebuild manifest per ADR-000), `feature_list.json` (134-row machine ledger), `LESSONS.md` (capture format + tag discipline), `DECISIONS.md` (ADR-000 adopt-harness, ADR-001 cache-prefix-reuse revised, ADR-002 hybrid-TDD) (added 2026-05-27 after phase0-step-003)

**.claude/settings.json hook wiring**

- PreToolUse Bash → `block-dangerous.sh` (added after phase0-step-004)
- PreToolUse Write|Edit|MultiEdit → `enforce-boundaries.sh` + `validate-brief.mjs` + `verify-gate.mjs` (added after phase0-step-004)
- PreToolUse \* → `detect-loop.mjs` (added after phase0-step-004)
- PostToolUse Read → `track-read.mjs`; Write|Edit → prettier (best-effort) (added after phase0-step-004)
- Stop → `commit-on-stop.mjs` (added after phase0-step-004)
- SessionStart → `additionalContext` reminder pointing at `/load-context-chain` (added after phase0-step-004)
- Permissions allow list: Read/Grep/Glob (\*), just \*, git read-only (status/diff/log/branch/show/rev-parse), ls/pwd/which, pnpm run/test/typecheck/lint, docker compose/ps/logs/exec/inspect (added after phase0-step-004)
- Permissions deny list: rm \*, curl|, wget, git push --force, docker rm/rmi/volume rm/prune, npm/pnpm/yarn/bun publish (added after phase0-step-004)

**Safety hooks (4 ported from Phase 2)**

- `block-dangerous.sh` denies: rm -rf / variants (slash, tilde, dot), fork bomb, force-push to main/master, git reset --hard, git clean -fd, SQL DROP TABLE/DATABASE/TRUNCATE TABLE, npm/pnpm/yarn/bun publish, eas submit, vercel --prod, fly/flyctl deploy, netlify deploy --prod, docker push :latest, prisma migrate reset, drizzle-kit drop, supabase db reset, aws s3 sync --delete (added after phase0-step-005)
- `block-dangerous.sh` exempts: `git push --force-with-lease`, `<pkg-mgr> publish --dry-run` (added after phase0-step-005)
- `block-dangerous.sh` fail-closed when neither jq nor python on PATH (added after phase0-step-005)
- `enforce-boundaries.sh` denies writes outside `$CLAUDE_PROJECT_DIR` with cross-platform path normalization (Windows `C:/`, mingw `/c/`, case-insensitive) (added after phase0-step-006)
- `enforce-boundaries.sh` carve-out: writes under `~/.claude/projects/{slug}/**` allowed (harness-state) (added after phase0-step-006)
- `enforce-boundaries.sh` denies basename match: .env, .env.local, \*.pem, \*.key, id_rsa/ed25519/ecdsa/dsa, credentials.json, firebase-adminsdk-\*.json, \*.p12, \*.pfx, \*.keystore, \*.jks (intentional exceptions: .env.example, google-services.json, GoogleService-Info.plist) (added after phase0-step-006)
- `detect-loop.mjs` blocks 3rd identical action; signature = sha256(tool + file/command + content[:200] + extra[:200]); rolling state at `.claude/state/recent-attempts.json` capped at 50 (added after phase0-step-007)
- `detect-loop.mjs` extra-discriminator fields: offset, limit, old_string, pattern, subagent_type, description, taskId, status, subject, query, url, width, height, filename, time, text, textGone, skill, args (added after phase0-step-007)
- `detect-loop.mjs` carve-out: mcp**playwright**browser\_{resize,navigate,wait_for,take_screenshot,close} bypass (capture loops are inherently iterative) (added after phase0-step-007)
- `detect-loop.mjs` fail-open on unparseable input; atomic state write via temp + rename (added after phase0-step-007)
- `validate-brief.mjs` activates only on Write|Edit|MultiEdit targeting brief.md (path-normalized); simulates operation in-memory; validates frontmatter via Ajv 2020 + gray-matter Date→string normalization + §7/§10 code-block presence; fail-open when deps not installed OR schema absent (added after phase0-step-029)

**Net-new harness hooks (3)**

- `verify-gate.mjs` denies Write|Edit|MultiEdit on feature_list.json when the edit flips any row's `passes:false → true` without that row's `evidence` path appearing in `.claude/state/evidence-reads.json` for the current session (added 2026-05-27 after phase0-step-008)
- `verify-gate.mjs` self-test mode via `--selftest` (returns 0 on PASS, 1 on FAIL) (added after phase0-step-008)
- `track-read.mjs` PostToolUse Read appends `{tool, file_path, timestamp}` to `evidence-reads.json` capped at 500 entries; atomic write via temp + rename; fail-open on state-write failure (added after phase0-step-009)
- `commit-on-stop.mjs` on Stop event: if `git status --porcelain` non-empty, `git add -A && git commit -F-` with message `checkpoint: <session-id> <YYYY-MM-DD HH:MM>`; never amends; never `--no-verify`; never blocks session termination (added after phase0-step-010)

**Subagents (evaluator + retro, ported from agentmark)**

- `evaluator` (Sonnet, tools: Read/Glob/Grep/Bash) — fresh-context skeptical reviewer; first line of output literally `PASS` or `NEEDS_WORK`; reads target row + evidence + diff; plan-parity check on durable behavior (validation/retry/rate-limit/cache/schema/control-flow inversion/new dep); auto-NEEDS_WORK on missing evidence OR protected-files policy violation without exception block (added after phase0-step-011)
- `retro` (Sonnet, tools: Read/Glob/Grep/Bash) — phase-gate report generator; reads feature_list + LESSONS + DECISIONS + git log + current+frozen phase-plan + sample 3 evidence files; **Section 4b drift hard gate: < 80% parity blocks phase close**; prints 7-section report to stdout (caller saves) (added after phase0-step-012)

**Harness skills (11)**

- 6 ported from Phase 2: `check-existing-work` (greps plans/active+archive+superseded; returns summaries with file refs, never plan bodies), `plan-bug` / `plan-feature` / `plan-investigation` (mini-plan authors with frontmatter contracts), `save-context` (snapshot to `contexts/<YYYY-MM-DD-HHMM>-<slug>.md`), `load-context-chain` (walks chain backward at session start) (added after phase0-step-013)
- 2 harness-new (port from agentmark): `capture-lesson` (append to LESSONS.md with mistake/technique pairing + tags ≥2 ≤6 kebab-case + optional PROGRESS.md one-liner), `consult-lessons` (tag-exact pass scores 3 + keyword-anywhere scores 1 + recency +1 if <30d; top 3-5 returned) (added after phase0-step-013)
- `sync-phase-plan` (rebuild guarantee; 9-step contract; durable-vs-noise classifier; SCAFFOLDING MISS counter when no §-section matches; hard pause for human approval; no auto-apply; deltas as unified diff with `(added YYYY-MM-DD after <row-id>)` provenance per line) (added after phase0-step-014)
- `phase-gate` (invokes retro subagent via Task tool; saves output to `reports/phase-{N}-gate-{YYYY-MM-DD}.md`; warns if `passes:true` < 80% before retro; does NOT auto-advance phase; does NOT tag git refs) (added after phase0-step-015)
- `polish-pass` (verifies row's perf/cost budget from phase-plan.md; produces `evidence/{row-id}-bench.json` with `passes_budget` boolean; flips `polished:false → true`; refuses on `passes:false`; one row per invocation) (added after phase0-step-015)

**Net-new subagents authored 2026-05-28 (closes Phase 2 [UNFINISHED])**

- `html-verifier` (Haiku) — 6-point HTML contract (valid HTML, tokens not raw, primitives not ad-hoc, required metadata, no markdown leakage, no placeholder content); emits per-file JSON verdict; Layer 6 of scaffolding/10-034 output-contracts (added after phase0-step-042)
- `lessons-agent` (Sonnet) — auto-invoked on 4 trigger conditions (builder-multi-attempt, reviewer-recurring-issue, plan-archive-surprise, stage-failed-recovered); writes to 3 scopes (global = operator-approval-only recommendation; project = `docs/lessons.md`; agent = `.claude/agent-memory/<name>/MEMORY.md`); structured format with Trigger/Source/What-happened/Root-cause/What-worked/Generalizable-rule/Scope/Tags (added after phase0-step-042)
- `agent-expert` (Opus) — meta-agent self-improvement loop; ≥3-instance pattern threshold; PROMOTION PROPOSAL hard pause for operator approval before depositing to `.claude/agents/` or `.claude/skills/`; archived versions kept in `_archive/`; semantic versioning in description (added after phase0-step-042)

### §0b Shared orchestrator infra (rows 017-025)

**Auth + model + budget + state**

- `orchestrator/src/auth-provider.ts::resolveAuthOptions(cfg, baseEnv)` — pure resolver, never mutates process.env; 4 providers: `claude-max-subscription` (forceLoginMethod: "claudeai", unsets ANTHROPIC_API_KEY defensively), `anthropic-api` (requires non-empty env var, throws descriptive error on absence, mirrors custom key name to ANTHROPIC_API_KEY for SDK), `bedrock` (sets CLAUDE_CODE_USE_BEDROCK=1 + optional AWS_REGION), `vertex` (sets CLAUDE_CODE_USE_VERTEX=1 + optional GOOGLE_CLOUD_PROJECT); exhaustiveness guard on switch (added after phase0-step-017)
- `orchestrator/src/model-config.ts::readModelConfig()` — merges `~/.claude/models.yaml` + `.claude/models.yaml`; project > user precedence; `ANTHROPIC_MODEL` env has highest precedence; per-agent tier/effort/budget/stallTimeoutMs resolvable by slug; FACTORY_DEFAULT_AGENT_TIERS pinned for bug-fixer/systemic-fixer/perceptual-reviewer/walkthrough-reviewer (tier:building, effort:medium) (added after phase0-step-018)
- `orchestrator/src/budget-tracker.ts` — per-pipeline cumulative USD accumulator; per-model breakdowns (Haiku/Sonnet/Opus); `perPipelineMaxUsd` cap (default per ~/.claude/models.yaml); `perStageMaxUsd[stageName]` per-stage caps; `assertWithinPipelineBudget(projectedUsd)` pre-check; `BudgetExceededError` sentinel; tracks `cacheReadInputTokens` + `cacheCreationInputTokens` per dispatch (added after phase0-step-019)
- `orchestrator/src/retry-counters.ts` — 5-tier table: layer5=3, visual-review=3, task-retry=2, merge-conflict=3, kit-change-request=2; per-counter increment + cap-check (added after phase0-step-020)
- `orchestrator/src/state-persistence.ts` — snapshot/restore to `.claude/state/{pipelineRunId}/counters.json`; atomic write via temp + rename; load-on-resume for crash recovery (added after phase0-step-020)
- `orchestrator/src/pause.ts::pauseRun()` — atomic write to `.claude/state/{pipelineRunId}/paused.json`; flushes feature-graph progress; throws `PauseSignal` sentinel (added after phase0-step-021)
- `orchestrator/src/agent-mcp-config.ts` — parses agent frontmatter `mcp_servers: [...]`; filters factory `.mcp.json` to per-dispatch subset; tolerates missing/malformed agent files (returns null for back-compat) (added after phase0-step-021)

**Dispatch core**

- `orchestrator/src/invoke-agent.ts` — SDK dispatch wrapper; canonical post-bug-134 (`.bug-134-final` companion explicitly excluded); systemPrompt uses preset `claude_code` with `excludeDynamicSections: true` so dispatches 2-N hit prompt cache across worktrees (orchestrator/src/invoke-agent.ts:2626) (added after phase0-step-022)
- `invoke-agent.ts` integrates: budget-tracker pre-query + post-return spend recording; agent-mcp-config per-dispatch MCP subset; bug-fix context injection (deferred stub from Phase 2; real impl in phase3-step-008); tester-diff audit post-tester (deferred stub; real impl in phase3-step-009); worktree seed/commit/install for Mode B (added after phase0-step-022)

**CLI**

- `orchestrator/src/cli.ts` — Commander entry; flags `--resume-from-stage`, `--dry-run`, `--require-pr-review`, `--max-concurrent`, `--pipeline-run-id`, `--bugs-yaml-mode`; delegates to `runCli()` (added after phase0-step-023)
- `orchestrator/src/cli-runner.ts::runCli()` — Mode A (runPipeline) → Mode B (runFeatureGraph) → rounds-orchestrator handoff; state-directory creation; pipelineRunId generation; context snapshot flow; resume flag handling (unfinished seams from Phase 2 preserved; remaining wiring lands in Phase 1/2/3 rows that consume each mode) (added after phase0-step-023)

**Protected files (hard guard)**

- `orchestrator/src/protected-files.ts::verifyProtectedFiles(worktreePath)` called post-dispatch by `runFixBugsLoop` before merge cascade; 4 invariant classes: PROTECTED_FILES (absolute paths must exist), first-match tuples (one of {.mjs,.js,.cjs,.ts} must exist), PROTECTED_PACKAGES_FILES (every `packages/<name>/package.json` must exist), PROTECTED_CONTENT_INVARIANTS (file must contain substring, e.g. `@tailwind base` in globals.css) (added after phase0-step-024)
- On violation: dispatch marked `status: failed` via `transitionFailedDispatch`; `closePerBugWorktree` SKIPPED (commit stays in per-bug branch, doesn't merge to fix/bugs-yaml-iter); structured stderr `[fix-bugs-loop] WARNING: unit <id> ... rolling back...`; one `[protected-files-violation] <path>: <reason>` entry per violation pushed to `bug.errorLog` (added after phase0-step-024)

**Rules**

- `.claude/rules/protected-files-policy.md` — 4-class enforcement; canonical machine manifest = `orchestrator/src/protected-files.ts`; empirical motivator reading-log-02 bug-077 (deleted postcss.config.mjs); bug-111 extension covers backend canonical entrypoints (apps/api/src/api/main.py + alternates); soft layer in bug-fixer.md + systemic-fixer.md system prompts (added after phase0-step-025)
- `.claude/rules/testing-policy.md` — hybrid TDD: builder 60% happy-path / tester 80% edge+integration+E2E; tester is write-test-only (bug-024 constraint); external-API tests MUST mock (bug-119 constraint, pytest-httpx for Python / vi.spyOn+msw for TS / page.route for Playwright); brief-scoped-out enrichment constraint (bug-133); 3 seeding strategies (A localStorage / D page.route intercept / C /test/seed contract with /test/seed-baseline + /test/cleanup + /test/ws-event for WebSocket); 6 anti-patterns disqualify "interpretive latitude" (investigate-023 seed-shape, URL-substitution, assertion-loosening, removed-assertions, long-sleep, type-coercion-fixtures); retry ladder builder 2× / tester 3× / max 3 retries per task (added after phase0-step-025)

### §0c Project lifecycle skills (rows 026-029)

- `/new-project <slug>` — scaffolds `projects/<slug>/`; regex `^[a-z][a-z0-9-]{1,48}$`; reserved-name rejection (active/archive/templates/test/shared/factory); clones .claude/{agents,skills,hooks,rules,templates,state}/, schemas/, brief-template.md, project-{turbo,tsconfig,package}.json.template, .mcp.json (filtered to design-scope); --force preserves user content + backups factory-owned files with `.bak-{ISO}`; --reset-brief requires --force; --proposal "<text>" | --proposal-file <path> | --proposal-url <url> (mutually exclusive, auto-invokes /draft-brief after scaffold); --agentic-visibility=public|private|split controls .claude/ git-tracking (private = gitignored, default; public = tracked; split = two git roots with app code separated) (added after phase0-step-026)
- `/draft-brief` — freeform proposal → 20-section brief.md with frontmatter prefilled; HTML-comment NEEDS_CLARIFICATION markers on unfillable sections; --proposal "<text>" | --proposal-file <path> | --proposal-url <url> sources (added after phase0-step-028)
- `/validate-brief` skill — 5 modes: --frontmatter (schema), --structure (MD043 against canonical heading list), --codeblocks (§5 competitor fenced list + §9 master-index integrity), --companions (every companion-files[].path resolves), --brief-capabilities (when present, IDs unique + active §9.x has matching cap- entries); exit code + `brief.md:<line>: <message>` format (added after phase0-step-028)
- `/scan-assets` — walks `assets/`, emits `docs/asset-inventory.json` + `assets/INVENTORY.md`; categories: logos, fonts, colors, photos.{selfies,people,products[sku]}, video.{broll,drone,references}, ugcReviews, brandGuides, referenceImages, copy, audio, html; html-extractor for `assets/html/` produces optional inferredBrandStyle slot (sources/palette/fonts/logoCandidates/heroCopy/debug); offline-by-default (no remote fetches); separate `logo-promoter.mjs` auto-promotes rank ≤3 candidates only (added after phase0-step-028)
- `/delete-project <slug>` — soft-archive to `archive/<slug>/` default; --nuke for hard delete; --dry-run for preview; --yes confirms hard delete; preserves all user data on soft path (added after phase0-step-028)
- `/check-existing-work [keywords]` — pre-flight audit; greps plans/active+archive+superseded; returns summaries with file refs only (never plan bodies); verdict line "Related work exists" or "No related work found"; missing dirs treated as empty (not error) (added after phase0-step-028)
- `.claude/hooks/validate-brief.mjs` — PreToolUse Write|Edit|MultiEdit on brief.md; cross-platform path normalization; simulates Write/Edit/MultiEdit operation in-memory; validates resulting content; deny via hookSpecificOutput JSON; fail-open if Ajv/gray-matter not installed or schema absent (gates on phase0-step-030 schemas + phase0-step-031 deps) (added after phase0-step-029)

### §0d Schemas + contracts + templates (rows 030-034)

**16 JSON schemas (schemas/) — ported Phase 2 verbatim**

- brief-frontmatter (project-name, version, status, brief-schema-version, etc.), brief-capabilities (per-section capability flags), navigation, architecture (apps/persistence/stack/compliance/vendors/env-vars), tasks (v2 with features[]/agent_sequence[]), tasks-coverage, feature, feature-context (snapshot for retry context), screens (discriminated union: batch shape vs single-screen retry), screen-fixture, user-flows-manifest (flows[]/name/screens[]/steps[]/seedingTier/kind), bugs-yaml, build-to-spec-verify-output, parity-verify-output, visual-review-report (per-screen rubric), signoff (gate 3 with reviews[]/visualReviewReportHash/uiKitVersion) (added after phase0-step-030)

**@repo/orchestrator-contracts package — 26 source modules + 121 tests**

- src/{architect,brief-coverage,bugs-yaml,build-to-spec-verify,builder,common,feature-context,feature-graph-progress,gates,git-agent,index,model-config,parity-verify,paused-state,perceptual-review,pm,quota-status,reviewer,round-state,screen-fixtures,security,stages,tasks,tester,user-flows-manifest,walkthrough-review}.ts (added after phase0-step-031)
- common.ts exports `RoundState`, `StageSchemas` lookup; stages.ts covers 21 stage definitions; v0.1.0; brief-signoff (gate 3) version-locks ui-kit (added after phase0-step-031)
- `pnpm --filter orchestrator test` → 46 test files / 1182 tests pass (with 144 typecheck errors inherited from Phase 2 in perceptual-review/walkthrough-review test fixtures; doesn't block test execution) (added after phase0-step-031)

**ui-kit templates (.claude/templates/)**

- `ui-kit-contract.md` — 6 consumption rules (public-barrel-only imports, no raw HTML/className, no literal token values, no arbitrary Tailwind, request missing primitives, layout-only spacing) + escapes (tokens object for runtime theming, cn utility, cva for component-local variants) + 3 enforcement layers (ESLint plugin, validate-consumer.ts, Reviewer gate) (added after phase0-step-032)
- ESLint plugin 4 rules: no-arbitrary-tailwind (blocks bg-[#...] / p-[...]), no-deep-imports (blocks @repo/ui-kit/primitives/button), no-hex-in-className (blocks inline hex in class), no-inline-style-tokens (blocks style={{ color: '#...' }}) (added after phase0-step-032)
- `ui-kit-tsconfig-consumer.json` — path alias exposing only `@repo/ui-kit` (not subpaths); `ui-kit-validate-consumer.ts` — runtime validator script template (real code authored by /stylesheet task) (added after phase0-step-032)

**Other templates (.claude/templates/)**

- HTML scaffolds: `mockups-index-template.html`, `user-flows-template.html`, `worktrees-README.md` (added after phase0-step-033)
- 4 Dockerfile templates (express, fastify, trpc-nest, fastapi) + 4 dev-multi-tier templates (same stacks) — node-express has template support but no corresponding stack skill (operator-customization path) (added after phase0-step-033)
- 4 E2E seed templates: playwright-global-setup (globalSetup hook), seed-intercept (page.route for external API mocking), seed-localstorage (per-test reset), seed-db (/test/seed contract with bulk-insert transactional behavior) (added after phase0-step-033)
- `.claude/architecture.yaml.template` — sections: apps, persistence, stack, compliance, vendors, env-vars; consumed by /architect; validates against schemas/architecture.schema.json (added after phase0-step-034)
- `.claude/models.yaml` — extends ~/.claude/models.yaml; agents:{} for per-agent tier/effort overrides; budget:{} for perPipelineMaxUsd overrides; stallTimeoutMs:{} per-agent override map (built-in defaults: builders 25min, tester 20min, reviewer/security 10min, git-agent null); stallTimeoutMode: lenient (mark feature failed) | strict (pause orchestrator); auth-provider config under top-level `provider:` key (operator-chosen; factory does NOT pin — see ADR-001 revision 2026-05-28) (added after phase0-step-034)

### §0e Subagents (rows 035-042)

**Mode A subagents**

- `analyst` — 5-worker parallel fan-out via Task tool: A) competitive research (WebSearch/Fetch), B) voice/archetype synthesis, C) visual signature (reads inferredBrandStyle from asset-inventory as soft prior), D) per-direction mockup rendering, E) shared analysis; Worker A emits `docs/analysis/shared/research_brief.yaml` (schema lean-marketing/research-brief v1.0); sub-worker prompts INLINE in agent body (Phase 2 LESSONS phase1-step-031..040 pattern) (added after phase0-step-035)
- `architect` — single-shot per pipeline (hash-detect re-run); emits architecture.yaml + .env.example + credentials-checklist.md + deployment-checklist.md; credentials-diff section on re-run with changed inputs (added after phase0-step-036)
- `project-manager` — `--mode=tasks` (decomposes requirements+architecture into tasks.yaml v2 with features[]/agent_sequence[]/task graph; feature-grouping heuristics: shared flow / catalogue entry / integration; emits security_sensitive flag per feature); `--mode=kit-change-request` (detour authors mini-plans for UI-kit primitives) (added after phase0-step-036)
- `ui-designer` — mockups (N styles × M apps), ui-kit (tokens+primitives+patterns+layouts), screens composed from kit, vision-capable; Phase 2 [UNFINISHED] hardcoded MCP scope in frontmatter retained — dynamic resolution available via invoke-agent + agent-mcp-config but not yet wired into this agent file (added after phase0-step-036)
- `skills-agent` — meta-agent; --scope=design (playwright/icons8/unsplash/chrome-devtools/image-generator) | --scope=build (per architecture.yaml.tooling.mcp_servers[]); idempotent; flags missing (does NOT auto-author by default) (added after phase0-step-036)

**Mode B subagents — builders (3 stack-polymorphic)**

- `backend-builder` — reads architecture.yaml.tooling.stack.backend_framework, dispatches to .claude/skills/agents/back-end/{slug}/; generates code + sibling happy-path tests into apps/api/; hybrid TDD 60% builder scope (added after phase0-step-037)
- `web-frontend-builder` — same pattern; .claude/skills/agents/front-end/{slug}/; apps/web/; reads `data-kit-*` attrs from HTML mockups; never hardcodes, always kit-consumes (added after phase0-step-037)
- `mobile-frontend-builder` — same; .claude/skills/agents/mobile/{slug}/; apps/mobile/ (added after phase0-step-037)

**Mode B subagents — quality (3)**

- `tester` — hybrid TDD edge cases + integration + E2E (Playwright web / Maestro mobile); 80% coverage gate; write-test-only (no source edits — bug-024 constraint); flags genuine product bugs back to builder via `genuineProductBugs[]` (retry cap 3); brief-scoped-out enrichment (bug-133) flagged via `enrichmentSuggestion[]` advisory channel (added after phase0-step-038)
- `reviewer` — last agent before merge; 8-dimension review (architecture, security, compliance, maintainability, a11y, performance, brief-delivery, design-conformance); stack-aware (loads stack-skill §Review block additively); emits ReviewerOutput with overallVerdict (approved|needs-revision|blocked) + retryTargets[] routing back to builders (added after phase0-step-038)
- `security` — dispatched only on PM-flagged security_sensitive features; OWASP Top 10 (2021) + CWE Top 25 + ASVS L1 against branch diff; emits P0/P1/P2 findings with CWE IDs + retryTargets[]; complements reviewer's MVP-light 15-item pass; runs post-builders, pre-reviewer (added after phase0-step-038)

**Mode B subagents — fixers (2)**

- `bug-fixer` — narrow-scope patcher for /fix-bugs; receives pre-loaded context; emits smallest possible diff to clear failing artefact (E2E spec, parity verifier, dev-server boot); bug-class discriminator (flow-execution-failure, visual-parity, dev-server-compile, etc.) drives fix shape (added after phase0-step-039)
- `systemic-fixer` — cross-file root-cause fixer for SYSTEMIC bug classes (tooling-css-pipeline-broken, tooling-config-mismatch, tooling-test-seed-contract-broken, clustered-systemic-divergence); authorized to edit multiple files + infrastructure (opposite of bug-fixer's smallest-diff invariant); suspects build pipeline first (added after phase0-step-039)

**Mode B subagents — vision (2)**

- `perceptual-reviewer` (Sonnet, vision) — Tier 4 vision-LLM judge; compares mockup PNG vs live-rendered PNG; emits structured visible discrepancies (missing elements, wrong colors/sizing, hierarchy drift, polish issues); ONE invocation per screen per fix-loop; NOT a fix agent (produces findings only); receives upstream parity findings to avoid duplication (added after phase0-step-040)
- `walkthrough-reviewer` (Sonnet, vision) — Tier 5 behavioral judge; consumes Playwright-driven walkthrough evidence (sequenced screenshots + network log + console log); emits behavioral findings (duplicate-request, no-op controls, broken nav, theme inconsistency, network-failures-silent, console errors); ONE invocation per fix-loop iteration; receives parity + perceptual findings to avoid duplication (added after phase0-step-040)

**Mode B subagents — git-agent (1)**

- `git-agent` — owns worktree lifecycle, branch management, merge-to-main, conflict routing; ops: bootstrap, checkout-feature, close-feature, resolve-conflict-handoff, emergency-abort; invoked ONLY by orchestrator at feature boundaries; never inline; allowed-tools: Bash for git ops only, no Write/Edit (added after phase0-step-041)

**Net-new agents (covered separately in §0a)**

- `html-verifier`, `lessons-agent`, `agent-expert` — see §0a for full descriptions; complete Phase 2 [UNFINISHED] (added after phase0-step-042)

### §0f Stack skills + analyzer subscopes (rows 043-046)

**Backend cores (3)** — `.claude/skills/agents/back-end/`

- `node-fastify` (Fastify 5 + better-sqlite3 + Zod; REST routes, not tRPC; canonical layout: routes/+plugins/+db/+common/; Vitest + testcontainers) (added after phase0-step-043)
- `node-trpc-nest` (NestJS + tRPC + Prisma; full-stack type inference; modules/+services/+controllers/; Jest) (added after phase0-step-043)
- `python-fastapi` (FastAPI + SQLAlchemy + Pydantic; async-first; routes/+models/+services/; pytest) (added after phase0-step-043)

**Frontend cores (2) + mobile (1)** — `.claude/skills/agents/{front-end,mobile}/`

- `react-next` (Next.js 14 App Router + React 19 + Tailwind; app/+src/components/+src/hooks/+src/store/; Vitest+Playwright) (added after phase0-step-044)
- `svelte-kit` (SvelteKit 2 + Svelte 5 + Tailwind; src/routes/+src/lib/components/+src/lib/stores/; Vitest+Playwright) (added after phase0-step-044)
- `expo-rn` (Expo 52 + React Native 0.77 + EAS Build; src/screens/+src/components/+src/navigation/; Jest+Maestro) (added after phase0-step-044)

**Vendor stub packs (8)** — `.claude/skills/agents/vendor/` — all intentionally minimal; full integration per-need with current vendor docs

- calcom-embed, mux-player-react, next-sanity, plausible-analytics, react-email, resend-transactional, sanity-studio, turnstile-widget (added after phase0-step-045)
- Plus `agents/_template/SKILL.md` boilerplate for adding new stack/vendor skills (added after phase0-step-045)

**Analyzer subscopes (7)** — `.claude/skills/analyze/`

- research.md, styles.md, assets.md, inspirations.md, flows.md, screens.md, integrations.md — consumed by analyst's parallel sub-workers during /analyze fan-out (added after phase0-step-046)

**Per-stack testing-policy declarations (cross-cutting)**

- Each shipped stack-skill SKILL.md §Testing declares: test-file naming convention, test runner command (with + without coverage), mocking primitives (pytest-httpx for Python / vi.spyOn+msw for TS / page.route for Playwright), one example test, minimum-coverage restated from rules/testing-policy.md (added after phase0-step-043, phase0-step-044)
- WebSocket E2E patterns (feat-076): Pattern A (single-context Playwright + request.post("/test/ws-event")) covers ~80% of WS specs; Pattern B (two-browser-context broadcast) for canonical happy-path send/receive (added after phase0-step-044)

### §0g Scaffolding docs (row 047)

- `scaffolding/000-scaffolding-index.md` — master index; Tier 1-4 + Phase A-E structure (added after phase0-step-047)
- `scaffolding/10-034-output-contracts.md` — 7-layer defense for HTML output: §Layer 1 prompt, §2 file protocol, §3 Zod, §4 PostToolUse hook + anti-slop grep, §5 retry, §6 html-verifier Haiku (now implemented per phase0-step-042), §7 visual-review Sonnet+vision; plus Layer 0 consumer contract for kit (added after phase0-step-047)
- `scaffolding/12-026-turborepo-scaffold.md` — monorepo root + pnpm-workspace.yaml + turbo.json + app stubs (web, mobile, admin, api) + package stubs (types, ui-kit, api-client, utils, configs) + `pnpm.onlyBuiltDependencies` gate (bug-153 native-binding workaround for bcrypt/esbuild/sharp/bufferutil/utf-8-validate) (added after phase0-step-047)
- `scaffolding/13-027-shared-packages.md` — @repo/types, @repo/ui-kit (replacing @repo/tokens + @repo/ui), @repo/api-client, @repo/utils skeletons + ESLint plugin + validate-consumer.ts stubs + CONTRACT.md (added after phase0-step-047)
- `scaffolding/19-032b-html-verifier-agent.md` — Layer 6 Haiku spec; agent file authored in phase0-step-042 (added after phase0-step-047)
- `scaffolding/24-037-lessons-agent.md` — 3-scope lesson capture spec; agent file authored in phase0-step-042 (added after phase0-step-047)
- `scaffolding/25-040-app-store-compliance.md` — Apple/Google compliance gate spec (Phase 4+ scope; documented for future) (added after phase0-step-047)
- `scaffolding/26-039-agent-expert.md` — meta-agent self-improvement loop spec; agent file authored in phase0-step-042 (added after phase0-step-047)
- `scaffolding/archive/` — 40 archived Phase 2 scaffolding docs preserved for reference (added after phase0-step-047)

### §0h Phase 0 closure (row 048)

- **Closed:** 2026-05-28 (added after phase0-step-048)
- **Operator:** David Morgan (sign-off via /phase-gate 0 re-run; report at `reports/phase-0-gate-2026-05-28.md`)
- **Git tags applied:** `phase-0-done` + `phase-1-start` at HEAD (added after phase0-step-048)
- **Final row count:** 59/61 `passes:true` (96.7%). Outstanding rows: phase0-step-016 (HUMAN harness baseline smoke — deferred non-blocking; harness empirically validated through gate execution itself); phase0-step-048 (this row — closed via sign-off) (added after phase0-step-048)
- **Polish state:** 0 `polished:true`; 2 `polished:"waived"` per ADR-004 (rows 050 + 055 — factory-build perf rows with intrinsically fast implementations); all other rows `polished:false` (no /polish-pass ceremony run during Phase 0; Phase 1 rows that introduce perf-meaningful behavior will go through normal polish-pass) (added after phase0-step-048)
- **Plan-parity:** 5/5 (100%) on Section 4b retro sample after commit 22d22d2 retroactive bulk /sync-phase-plan; well above the 80% hard gate (added after phase0-step-048)
- **Lessons captured for Phase 0:** 3 entries in LESSONS.md tagged phase0-step-* (049 RESEARCH-adopts-must-be-validated, 027 /new-project surfaces factory gaps, 042 scaffolding docs are specs not implementations) (added after phase0-step-048)
- **ADRs accepted during Phase 0:** ADR-000 (adopt agentmark harness baseline), ADR-001 (cross-worktree cache via excludeDynamicSections; auth-default clause superseded by ADR-003), ADR-002 (hybrid TDD 60/80), ADR-003 (auth-provider is operator-chosen), ADR-004 (polished:"waived" third state for factory-build perf rows) (added after phase0-step-048)
- **Deferred to Phase 3:** 144 typecheck errors in orchestrator/tests/{perceptual,walkthrough}-review.test.ts — inherited Phase 2 debt; fix scope assigned to rows phase3-step-006 + phase3-step-007 (see "Phase 3 inherited debt" note in this file) (added after phase0-step-048)

### §0i RESEARCH adopts + factory-root scaffolds + post-MVP adopts (rows 049-061)

**RESEARCH.md adopts**

- `excludeDynamicSections: true` on every query() callsite in orchestrator (confirmed wired at orchestrator/src/invoke-agent.ts:2626 with full explanatory comment at lines 2615-2622); cross-worktree cache prefix reuse; per ProjectDiscovery precedent 7% → 84% cache-hit ratio; auth-mode-independent (works on Max + API-key + Bedrock + Vertex) (added after phase0-step-049)
- ENABLE_PROMPT_CACHING_1H=1 recommended for anthropic-api users on long fix-loop / multi-worktree runs (1h TTL = 2× input price for 1h vs 1.25× for 5min; break-even ≈ 25min continuous prefix reuse); no-op on claude-max-subscription (added after phase0-step-049)
- Cache-hit-ratio metric in budget-tracker: tracks cacheReadInputTokens + cacheCreationInputTokens per dispatch; derivable as cacheReadInputTokens / (inputTokens + cacheReadInputTokens) (added after phase0-step-049)
- Provider auth is operator-chosen; factory does NOT pin (reverted 2026-05-28 per ADR-001 revision — see DECISIONS.md) (added after phase0-step-049)
- `scripts/hook-regression.mjs` — 24 adversarial+benign fixtures across 5 PreToolUse hooks; --hook=<name> subset; --json for CI; runs <2s; 24/24 PASS baseline (added after phase0-step-050)
- `orchestrator/src/cost-projection.ts` — pure-function forecast(tier, inputTokens, expectedOutputTokens, cacheHitRatio?, cacheTtl?) → {costUsd, alternatives:{haiku, sonnet, opus}, breakdown:{inputUsd, cacheReadUsd, cacheWriteUsd, outputUsd}}; classifyForecast → "ok" | "warn" (≥50% cap) | "throw" (≥100% cap); May 2026 pricing baseline (Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 per MTok; cache read = 10% input; cache write 5m = 1.25× input, 1h = 2× input); 15-test suite passes; `/preview-cost` operator skill (added after phase0-step-055)

**Factory-root scaffolds**

- `brief-template.md` — canonical 20-section brief template with frontmatter ($schema, version, status, project-name, author, dates, brief-schema-version, companion-files, amendments); /new-project copies verbatim into projects/<slug>/brief.md (added after phase0-step-051)
- `mcp-defaults-design.json` — declarative design-scope MCP source list (playwright, icons8, unsplash, chrome-devtools, image-generator); scoped_to per agent; /register-mcp-servers --scope=design consumes; feature-flag gating (image-generator opt-in via --flags=nanobanana) (added after phase0-step-051)
- `.mcp.json` (factory root) — SDK-readable live MCP registration; distinct from mcp-defaults-design.json (source list); /register-mcp-servers writes here idempotently (added after phase0-step-057)
- Factory monorepo: `pnpm-workspace.yaml` (packages: ['packages/*', 'orchestrator']), `tsconfig.base.json` (shared compilerOptions), `package.json` (name: agentflow-phase3, scripts: validate-brief/generate/typecheck:all/test:all, devDeps: ajv/ajv-formats/gray-matter/js-yaml/markdownlint-cli2/playwright/sharp/tsx/zod, packageManager: pnpm@9.12.0) (added after phase0-step-051)
- `.claude/templates/project-{turbo,tsconfig,package}.json.template` — canonical project-side bootstrap templates with {{PROJECT_NAME}} placeholder; supersedes the ad-hoc generation /new-project did on 2026-05-28 (added after phase0-step-027 + phase0-step-051)
- `justfile` — curated whitelist of safe Bash recipes; pairs with `just`-only opt-in mode in .claude/settings.json for `--dangerously-skip-permissions` safety; recipes: test, build, typecheck, lint, dev, format, pipeline-run, fix-bugs, verify, scan-assets, validate-brief, etc. (added after phase0-step-052)
- `assets/README.md` — factory-vs-project structure doc; describes per-project assets pattern + factory-level placeholder usage (added after phase0-step-027)

**Scripts (54 files in scripts/)**

- 5 schema validators (validate-architecture, validate-brief, validate-feature-context, validate-screens, validate-tasks-yaml) — ajv-based CLI with structured exit codes (0 valid, 1 invalid, 2 file/schema not found); /validate-brief skill + tasks-loader.ts callsites (added after phase0-step-053)
- 15 factory helpers (build-screens-catalog, build-screens-manifest, build-user-flows, derive-fixture-from-mockup, retrofit-ui-kit-data-attrs, file-bug-plan, snapshot-project, sync-project-schemas, aggregate-components, ai-walkthrough, run-synthesized-flows, seed-app-state, archive-plans, detect-affects-files-overlaps, audit-tracked-pycache) — cross-wired callsites in skills + orchestrator (added after phase0-step-054)
- orchestrator/scripts/ — 6 internal CLI helpers (dag-status.mjs, parity-verify.ts, probe-quota.mjs, renormalize-walkthrough.ts, run-verifier.ts, run-walkthrough.ts) (added after phase0-step-061)

**Factory decision/reference docs (docs/)**

- reviewer-playbook.md (7-dimension review criteria binding for reviewer agent), security-checklist.md (security agent grounding), agent-sdk-auth-providers.md (4-provider semantic table for auth-provider.ts), agentic-visibility.md (--agentic-visibility flag spec for /new-project), build-tier-roadmap.md (5-tier verifier roadmap for Phase 3), fix-bugs-cost-and-speed-priority-plan.md (fix-bugs-loop strategy), tasks.yaml.template (PM output template) (added after phase0-step-058)

**Fixture + template libraries**

- gotribe-briefs/ (INDEX + \_authoring-spec + tier-1-atomic + tier-2-combining + tier-3-essence) — example brief library + authoring guidance; fixture for /draft-brief smoke (added after phase0-step-059)
- proposals/ (hatch-proposal, kanban-webapp-proposal) — example proposals as test fixtures for /new-project --proposal-file (added after phase0-step-059)
- plans/templates/ (bug-plan, feature-plan, investigation-plan, kit-change-request-plan, refactor-plan) — instantiation templates for plan-\* skills (added after phase0-step-059)

**Dev-experience config (factory root)**

- .markdownlint.jsonc + .markdownlint-cli2.jsonc — MD043 locks brief 20-section heading list + MD041 first-line H1 + MD025 only-one-H1; editor + pre-commit + CI integration (added after phase0-step-056)
- .gitignore + .prettierignore — node_modules, .claude/state runtime, .tmp-\* artifacts, build outputs (added after phase0-step-056)
- .github/workflows/validate-brief.yml — CI gate on PR brief edits; runs scripts/validate-brief.mjs + markdownlint-cli2 (added after phase0-step-056)

**Orchestrator workspace + test suite**

- orchestrator/package.json + tsconfig.json + vitest.config.ts — workspace bootstrap; pnpm install resolves 312 packages including sharp native build (added after phase0-step-060)
- orchestrator/tests/ — 46 test files + fixtures/ dir; covers 28 orchestrator modules + 6 scripts + 4 cross-cutting tests; vitest with parallel execution; `pnpm --filter orchestrator test` → 46 suites / 1182 tests pass; 144 typecheck errors inherited from Phase 2 in vision-LLM test fixtures (doesn't block tests; future Phase 3 rows touching perceptual/walkthrough may fix) (added after phase0-step-060)

---

# Phase 1 — Design pipeline (Mode A)

## Goal

13-stage sequential design pipeline with 5 HITL gates, kit-change-request detour, visual-review retry.

## Definition of done

- All Phase 1 rows in `feature_list.json` (phase1-step-001 through phase1-step-026) `passes: true` with evidence
- `phase1-step-026` HUMAN closure signed off
- `git tag phase-1-done`

## Scope sections (filled by /sync-phase-plan as rows close)

### §A Pipeline machinery (rows 001-008)

- `orchestrator/src/stages-array.ts` — 13-stage Mode A canonical order (analyze → skills-audit-design → mockups → stylesheet → screens → visual-review → user-flows → architect → stylesheet-primitives → pm → skills-audit-build → register-mcp-build → git-agent-bootstrap); per-stage `outputSchema` uses `MinimalStageOutput` from @repo/orchestrator-contracts (replaces Phase 2 `z.unknown()` placeholder; documented permissive shape with optional success/warnings/summary/artifacts fields + passthrough for extra keys); tightening per-stage to ArchitectOutputSchema / PmOutput / GitAgentOutput available as follow-up work paired with realistic test fixtures (added 2026-05-28 after phase1-step-001)
- `@repo/orchestrator-contracts::MinimalStageOutput` (stages.ts) — exports documented permissive stage-output Zod schema as the canonical replacement for Phase 2's z.unknown placeholder; used by every stage in STAGES that lacks a dedicated richer contract (added 2026-05-28 after phase1-step-001)
- **Operator-facing command grouping (ADR-005):** `PipelineStage.userInvokable: boolean` field flags which 6 of the 13 stages are operator-invokable commands. Operator-invokable: `analyze` (auto-runs `skills-audit-design`), `mockups`, `stylesheet` (stack-agnostic kit-core), `screens` (auto-runs `visual-review` + `user-flows`), `architect` (auto-runs `stylesheet-primitives` — stack-bound, stack chosen by `architecture.yaml.tooling.stack.web_framework`), `pm` (auto-runs `skills-audit-build` + `register-mcp-build` + `git-agent-bootstrap`). Internal stages retain per-stage retry/budget/gate mechanics; the flag is metadata for operator UX + documentation, not orchestration logic. `USER_INVOKABLE_STAGES` export from stages-array surfaces the 6-command subset. (added 2026-05-28 after phase1-step-001)
- **Stylesheet ↔ stylesheet-primitives separation (load-bearing, codified by ADR-005):** `/stylesheet` runs PRE-architect and ships a STACK-AGNOSTIC kit-core (tokens, agnostic styles, Tailwind config, HTML preview). `stylesheet-primitives` runs POST-architect (auto-run by /architect's orchestration sequence after the credentials-drop gate) and binds the kit-core to the chosen stack — React / Vue / Svelte / Angular / etc., dispatched by ui-designer to the matching skill in `.claude/skills/agents/front-end/{slug}/`. Architect's pick lives at `architecture.yaml.tooling.stack.web_framework`. The two stages are deliberately separated so the same kit-core can serve future projects on different stacks. (added 2026-05-28 after phase1-step-001)
- `orchestrator/src/stage-runner.ts` — single-stage executor; budget pre-query via budget-tracker; Layer-5 retry cap (3) on schema-validation fail; records spend post-return; 15-test suite covers retry/budget/schema-fail paths (added 2026-05-28 after phase1-step-002, ported from Phase 2)
- `orchestrator/src/pipeline.ts` — Mode A orchestrator walks STAGES respecting dependsOn; fileDropWaitForGate factory polls `.claude/state/{pipelineRunId}/gate-{n}-approved.txt`; integrates brief-coverage-gate post-pm; SaveContextFn logs-only MVP; 9-test suite passes (added 2026-05-28 after phase1-step-003, ported from Phase 2)
- `orchestrator/src/project-state.ts` — `detectStageCompletions()` + `detectOne(stageSlug)` per-stage; primary-output-file presence check (conservative — schema validation deferred to stage-runner); supports --resume-from-stage flag (added 2026-05-28 after phase1-step-004, ported from Phase 2)
- `orchestrator/src/kit-change-request-detour.ts` — design-phase detour cap = **2 per pipeline run** via retry-counters; invokes PM `--mode=kit-change-request`, reruns /stylesheet, optionally reruns /architect; escalates to human on exhaust; 8-test suite passes (added 2026-05-28 after phase1-step-005, ported from Phase 2)
- `orchestrator/src/visual-review-retry.ts` — per-screen retry cap = **3** (independent of Layer-5 counter); regenerates screen on error-severity violations + re-runs /visual-review; failed screens populate `needsHumanReview[]` feeding Gate 4; 8-test suite passes (added 2026-05-28 after phase1-step-006, ported from Phase 2)
- `orchestrator/src/gate-server-lifecycle.ts` — file-drop gate machinery; `waitForGateDecision()` polls FS for `gate-{n}-approved.txt` (or `gate-{n}-approved-{featureId}.txt` for feature-scoped gate 6); 5 directive parser: `proceed | revise: <reason> | reject: <reason> | abort | defer`; MVP no-op HTTP server (added 2026-05-28 after phase1-step-007, ported from Phase 2)
- `orchestrator/src/brief-coverage-gate.ts` — post-/pm gate; shells `scripts/audit-brief-coverage.mjs`; parses exit code + BriefCoverageOutput JSON (@repo/orchestrator-contracts/brief-coverage.ts); no-op + warn when brief.capabilities catalog DNE (legacy projects) (added 2026-05-28 after phase1-step-008, ported from Phase 2)

### §B Stage wiring — 13 Mode A stages (rows 009-023)

[to be filled by /sync-phase-plan after rows land — covers /analyze (5-worker fan-out) → /skills-audit --scope=design → /mockups (N styles × M apps) → /stylesheet + /stylesheet-primitives → /screens (data-kit-* attrs) → /visual-review (Playwright rubric) → /user-flows-generator (Mermaid/SVG) → /architect (hash-detect re-run) → /pm --mode=tasks → /skills-audit --scope=build → /register-mcp-servers → /git-agent bootstrap]

### §C HITL gates 1-5 (rows 010, 013, 018, 020, 026)

[to be filled by /sync-phase-plan after rows land — Gate 1 analyze sign-off, Gate 2 pick-style commit, Gate 3+4 design signoff combined, Gate 5 credentials, Phase 1 closure smoke]

### §D Supplementary skills (rows 024-025)

[to be filled by /sync-phase-plan after rows land — /idea + /idea-list + /idea-promote (brainstorm detour), /plan-refactor + /plan-archive + /plan-search + /plan-status (operator power tools)]

### §E Phase 1 closure (row 026)

[to be filled when row 026 HUMAN gate clears]

---

# Phase 2 — Build orchestration (Mode B)

## Goal

Parallel feature-graph executor with per-feature worktree, agent_sequence dispatch, protected-files rollback,
pause/resume, optional PR-review gate, partial-failure-policy.

## Definition of done

- All Phase 2 rows (phase2-step-001 through phase2-step-022) `passes: true` with evidence
- `phase2-step-020` HUMAN closure signed off
- `git tag phase-2-done`

[Scope sections filled by /sync-phase-plan]

---

# Phase 3 — Verify + bugfix

## Goal

5-tier verifier (build-sanity → reachability → synth-flows → parity → perceptual+walkthrough),
bug filing to docs/bugs.yaml, fix-bugs loop with bug-fixer + systemic-fixer + cluster-bugs + protected-files,
rounds-orchestrator wrapping 1→4 + final-gate round 5, runtime-signoff Gate 7.

## Definition of done

- All Phase 3 rows (phase3-step-001 through phase3-step-025) `passes: true` with evidence
- `phase3-step-021` HUMAN closure signed off
- `git tag phase-3-done`
- Factory ready for first real client project

## Phase 3 inherited debt — typecheck errors in vision-LLM test fixtures

`pnpm --filter orchestrator typecheck` emits **144 errors** inherited verbatim from Phase 2. All errors are localized to test fixtures in `orchestrator/tests/perceptual-review.test.ts` and `orchestrator/tests/walkthrough-review.test.ts` (mismatched discriminated-union literals in test mocks, implicit-any in callback args). They do NOT block test execution — `pnpm --filter orchestrator test` passes 1182/1182 because vitest uses tsx (type-erasing). The errors are documented at this layer rather than filed as a Phase 3 bug because the rows that own the erring modules (phase3-step-006 perceptual-review, phase3-step-007 walkthrough-review) are the natural place to fix them as part of their wiring work. Future evaluators should NOT file these as Phase 3 regressions — they are pre-existing Phase 2 debt knowingly inherited at the bulk port (phase0-step-060). Fixing them is in scope for rows phase3-step-006 and phase3-step-007 but does not block Phase 3 closure if other test fixtures pass.

## Scope sections (filled by /sync-phase-plan as rows close)

[to be filled — Phase 3 §-skeleton will be seeded at Phase 2 closure / Phase 3 kickoff per the same pattern as Phase 1 §A-§E above]

---

# Architectural commitments (cross-phase)

These commitments shape multiple phases. They are load-bearing and changing them retroactively requires
an ADR in `DECISIONS.md`.

## Factory ↔ project split

The repo is a **factory**; each app is a **project** under `projects/<slug>/`. /new-project clones
factory `.claude/` resources into the project (visibility controlled by --agentic-visibility:
public, private, or split). Never edit a project's `.claude/agents/` expecting it to propagate
back to the factory.

## Hybrid TDD (builder 60% / tester 80%)

Builder ships happy-path tests with code; tester adds edge-cases + integration + E2E. Tester is
write-test-only (cannot edit source). See `.claude/rules/testing-policy.md`.

## Evidence-gated row flips

Rows in `feature_list.json` cannot flip `passes:false → true` without the evidence file being read
in-session. Enforced by `verify-gate.mjs` PreToolUse hook (phase0-step-008) + `track-read.mjs`
PostToolUse hook (phase0-step-009).

## Cache-aware dispatch

Orchestrator passes `excludeDynamicSections: true` on every query() (phase0-step-049, wired at
`orchestrator/src/invoke-agent.ts:2626`). This is the load-bearing performance commitment and
is auth-mode-independent. Auth provider is operator-chosen (4 options: claude-max-subscription,
anthropic-api, bedrock, vertex) per ADR-001 revision 2026-05-28 — the factory does NOT pin a
default. For `anthropic-api` users on long fix-loop / multi-worktree runs,
`ENABLE_PROMPT_CACHING_1H=1` is recommended (1h TTL; break-even ≈25min continuous prefix reuse);
no-op on Max subscription where the Claude Code session manages caching.

## Vision routing

Perceptual + walkthrough reviewers default to Haiku 4.5. Escalation to Sonnet 4.6 fires on SSIM
dissimilarity >1% via phase3-step-022 prefilter. Cluster-bugs gets a Haiku second-pass for
defense-in-depth on cluster decisions.

## Worktree per feature

Mode B opens `.claude/worktrees/<featureId>/` per feature. Per-feature isolation lets
--max-concurrent N work without conflicts. close-feature merges + removes worktree
(unless --keep-worktrees).
