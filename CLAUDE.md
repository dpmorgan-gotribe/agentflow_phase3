# Agentflow Phase 3 — Factory CLAUDE.md

## What this repo is

This is the **factory** that generates agentic apps. Phase 3 is a rebuild of `agentflow_phase2` onto a harness pattern (ported from `agentmark`). It holds:

- **Agentic resources** under `.claude/` — agents, skills, hooks, rules, templates that are _cloned into_ generated projects
- **Orchestrator** under `orchestrator/` — the TypeScript SDK driver for Mode A (design) and Mode B (build)
- **Shared contracts + schemas** under `packages/orchestrator-contracts/` and `schemas/`
- **Factory scripts** under `scripts/` + `orchestrator/scripts/`
- **Generated projects** under `projects/<slug>/` (each an independent unit)

## Startup ritual (read on every fresh session)

1. **Read `PROGRESS.md`** (last entry) — what shipped, what's in flight, what's blocked
2. **Read the active row in `feature_list.json`** — current task, its `steps[]`, `expected_outcomes[]`, `evidence` path
3. **Run `/load-context-chain`** (once that skill exists; phase0-step-015) — replay prior session context
4. **Read `LESSONS.md`** if the row hits a previously-failed surface
5. **Run `/check-existing-work [keywords]`** (phase0-step-013) — search prior plans for related work

## Hard rules (NON-NEGOTIABLE)

### RESEARCH adopts

- When a RESEARCH.md (or similar research-doc) recommendation would CHANGE an operator-facing default — auth provider, billing tier, deployment target, model selection, env vars consumed at runtime — DO NOT silently apply via a factory project-level override.
- Instead: document the tradeoff in the relevant docs/ file (e.g. `docs/agent-sdk-auth-providers.md` for auth choices) AND require explicit operator opt-in. Factory project-level overrides are reserved for choices the project genuinely requires (per-agent tier pin for unusual workloads, per-feature budget overrides) — not for defaults that apply broadly.
- See LESSONS.md "RESEARCH adopts must be validated against operator setup" (phase0-step-049) + DECISIONS.md ADR-003 (auth-default supersession) for the empirical motivator.

### Plan/Archive system

- Before any non-trivial work: `/check-existing-work` → `/plan-feature`|`/plan-bug`|`/plan-refactor`|`/plan-investigation`
- Get plans approved (draft → approved) before implementing
- Work on the plan's branch; log attempts in the plan's Attempt Log
- After work: `/plan-archive` with outcome + lessons
- Lessons feed `LESSONS.md` via `/capture-lesson`
- NEVER try the same fix twice — check the attempt log

### Retry policy

- Attempt 1-2: try different approaches
- Attempt 3: `/plan-investigation`
- Attempt 4: try investigation's recommendation
- Attempt 5: STOP and escalate
- NEVER exceed 5 attempts on the same error

### Test policy

- No test rot. Red tests block the row that surfaced them.
- Default fix: fix the TEST when its assertion has drifted from intent (most common).
- Touch production code ONLY with evidence the production code is genuinely wrong AND the test correctly describes intent.
- Unacceptable: `.skip`, comments, "pre-existing rot" deferrals.
- Per-test retry cap (5) still applies — escalate to investigation, don't leave red.

### Brief protocol (when working inside a generated project)

- `brief.md` at project root is canonical specification
- Read brief.md FIRST before starting any work
- Never ask the user for information that is in the brief
- Reference brief sections, never copy content from them
- If brief.md is missing or invalid, STOP and report
- Run `/validate-brief` if you suspect issues

### Protected files

- See `.claude/rules/protected-files-policy.md`
- Canonical machine manifest: `orchestrator/src/protected-files.ts`
- 4 classes: absolute paths, packages glob, content invariants, first-match tuples
- Post-dispatch guard rolls back any violating merge

### Output contracts

- Agents that author code write to files; return only structured status
- Never include code in agent response text
- Self-verify by reading back files before reporting complete

## Rebuild guarantee

`phase-plan.md` is a **living rebuild manifest**, not a frozen kickoff doc. After every row close, run `/sync-phase-plan` (phase0-step-014) to fold durable behavior into the plan. The evaluator subagent (phase0-step-011) rejects rows where shipped behavior diverges from the plan. At phase boundaries, the retro subagent (phase0-step-012) samples 5 random rows for drift — >20% drift blocks phase close.

Litmus test: `git checkout phase-N-start && rebuild from phase-plan.md` should produce the currently-shipped system. If it doesn't, `/sync-phase-plan` missed a drift.

## Pipeline overview (what we're building toward)

**Mode A (design)** — sequential, HITL-gated. **6 operator-invokable commands** (per ADR-005):

- `/analyze` (Gate 1: requirements review) — auto-runs `skills-audit-design`
- `/mockups` (Gate 2: `/pick-style` after mockups)
- `/stylesheet` (Gate 3: design-system signoff) — **stack-agnostic kit-core** (tokens, styles, Tailwind, HTML preview)
- `/screens` (Gate 4: signoff after auto-runs) — auto-runs `visual-review` + `user-flows`
- `/architect` (Gate 5: credentials drop) — auto-runs `stylesheet-primitives` (**stack-bound** — stack chosen by `architecture.yaml.tooling.stack.web_framework`; React / Vue / Svelte / Angular dispatched to the matching skill)
- `/pm --mode=tasks` — auto-runs `skills-audit-build` + `register-mcp-build` + `git-agent-bootstrap`

The other 7 stages are internal sequencing detail: pipeline mechanics (retry / budget / gate per stage) apply; they just don't appear in operator UX as standalone commands.

**Mode B (build)** — autonomous parallel feature graph: `/start-build` opens worktrees per feature, runs each feature's agent_sequence (builder → security → tester → reviewer), merges to main on reviewer approval. Refuses to run until Mode A artifacts + Gate 5 are in place.

**Phase 3 (verify+bugfix)** — 5-tier `/build-to-spec-verify`, file bugs to `docs/bugs.yaml`, `/fix-bugs` loop with bug-fixer + systemic-fixer + cluster-bugs + protected-files rollback. rounds-orchestrator wraps 1→4 + final-gate round 5.

## Model configuration

- System defaults: `~/.claude/models.yaml`
- Project overrides: `.claude/models.yaml`
- Resolution order: `ANTHROPIC_MODEL` env > project yaml > user yaml
- Budget caps enforced by orchestrator (`budget-tracker.ts`); exceeding `perPipelineMaxUsd` aborts the run
- Auth provider config in `models.yaml` under `provider:` (see `docs/agent-sdk-auth-providers.md`). **Factory default in Phase 3 = `anthropic-api`** (RESEARCH adopt, phase0-step-049). Max OAuth is a ToS violation for headless SDK use as of Feb 2026 and returns HTTP 400 on `cache_control` as of Mar 2026 — keep `anthropic-api` for orchestrator runs.
- **Required env for orchestrator runs:** `ANTHROPIC_API_KEY` set + `ENABLE_PROMPT_CACHING_1H=1` exported. The 1h cache TTL is the highest-ROI cache lever for long fix-loop / multi-worktree runs. Without it, cache writes are 1.25× input price for 5 min only; with it, 2× input price for 1h. The break-even is ~25 min of continuous prefix reuse — every Mode B run clears that easily.
- See DECISIONS.md ADR-001 for the full rationale (auth + caching + worktree-cache-reuse).

## Context preservation

- Before starting: `/load-context-chain` for prior state
- After significant steps: `/save-context`
- Checkpoints every 5 snapshots or at milestones
- Never read more than 5 snapshots deep without hitting a checkpoint

## Key file locations (factory)

- This file: `CLAUDE.md`
- Living plan: `phase-plan.md`
- Feature ledger: `feature_list.json`
- Lessons: `LESSONS.md`
- ADRs: `DECISIONS.md`
- Handoff log: `PROGRESS.md`
- Per-row evidence: `evidence/<row-id>-result.txt`
- Per-plan docs: `plans/active/<plan-id>.md`
- Context snapshots: `contexts/`
- Investigation docs: `investigations/`
- Phase-gate reports: `reports/`

## Key file locations (per generated project)

- Brief: `projects/<slug>/brief.md`
- Architecture: `projects/<slug>/.claude/architecture.yaml`
- Requirements: `projects/<slug>/docs/requirements.md`
- Task graph: `projects/<slug>/docs/tasks.yaml`
- Asset inventory: `projects/<slug>/docs/asset-inventory.json`
- Cloned `.claude/`: `projects/<slug>/.claude/` (visibility controlled by `--agentic-visibility` flag)
