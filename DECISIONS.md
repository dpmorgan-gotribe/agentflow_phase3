# DECISIONS.md — Architectural Decision Record (ADR) log

> Append a new ADR when an architectural commitment is made or changed. ADRs are immutable once
> accepted; superseded ADRs link to their successor. Recent at the bottom.

## ADR format

```
## ADR-NNN — <title>
- **Status:** proposed | accepted | superseded by ADR-MMM
- **Date:** YYYY-MM-DD
- **Context:** <why the decision is needed>
- **Decision:** <what we decided>
- **Consequences:** <what changes downstream>
- **Alternatives considered:** <one-line each, with why-rejected>
- **References:** <row-ids, links, citations>
```

---

## ADR-000 — Adopt agentmark harness baseline pattern

- **Status:** accepted
- **Date:** 2026-05-27
- **Context:** Phase 2 accumulated 200+ bugs whose fixes never made it back into the scaffolding plan. Rebuilding from those scaffolding files would resurface every one. The agentmark project ships a harness baseline (evidence-gated row flips, evaluator subagent, /sync-phase-plan rebuild guarantee) that closes the drift loop.
- **Decision:** Adopt the agentmark harness as Phase 0 baseline. Port its 22 scaffolding files (`scaffolding/phase-0-harness/*.md`) as the harness layer; layer Phase 2 capabilities on top.
- **Consequences:** `phase-plan.md` becomes a living rebuild manifest. `/sync-phase-plan` is mandatory after every row close. Evaluator + retro subagents become first-class. Evidence-read enforcement via PreToolUse hook.
- **Alternatives considered:**
  - Rebuild from Phase 2's scaffolding alone — rejected: re-opens the 200-bug surface
  - Build a custom harness — rejected: agentmark is battle-tested + matches our row-shipping cadence
- **References:** `agentflow_rebuild_prompt.md`, `scaffolding/phase-0-harness/` (in agentmark), feature_list.json rows phase0-step-001 through phase0-step-016

## ADR-001 — Cross-worktree prompt-cache reuse via excludeDynamicSections

- **Status:** accepted
- **Date:** 2026-05-27
- **Context:** Phase 2's parallel worktree fan-out (Mode B) misses Anthropic prompt cache on every worktree because the SDK auto-injects per-machine cwd/git/platform sections into the system prefix. Per RESEARCH.md §A.1 + §F.6, this is the highest single-ROI performance issue in the entire system.
- **Decision:** Set `excludeDynamicSections: true` on every `query()` call in the orchestrator. Default `auth-provider.ts` to API-key mode (Max OAuth is ToS-violating for headless SDK + breaks cache_control as of Mar 2026). Set `ENABLE_PROMPT_CACHING_1H=1`.
- **Consequences:** ProjectDiscovery precedent: cache-hit ratio 7% → 84%. For 4-worktree Mode B run with ~10K-token prefix, this saves 30K tokens of cache writes per run (~$0.09 on Sonnet × N runs/day). First-turn cache reads in worktrees 2-4 become non-zero.
- **Alternatives considered:**
  - Keep Max OAuth (current Phase 2 default) — rejected: ToS violation + HTTP 400 on cache_control
  - Defer the change — rejected: cheap to ship from day one
- **References:** RESEARCH.md §A "Agentflow Retrieval Layer" + §F "Advanced Prompt Caching", row phase0-step-049

## ADR-002 — Hybrid TDD authority split (builder 60% / tester 80%)

- **Status:** accepted
- **Date:** 2026-05-27 (inherited from Phase 2 feat-004)
- **Context:** Single-agent test authoring conflates implementation context with test skepticism, producing tests that confirm the bug rather than catch it.
- **Decision:** Builder ships happy-path unit + component tests with implementation (60% coverage scope). Tester adds edge-case unit + integration + E2E (Playwright web / Maestro mobile) on top (80% total coverage). Tester is write-test-only — cannot edit source.
- **Consequences:** Each builder dispatch ships paired tests. Tester catches genuine product bugs and routes back to builder (retry cap 3). `tester-diff-audit.ts` (phase3-step-009) scans tester diffs for 6 anti-patterns (assertion loosening, etc.) and blocks dispatch on violation.
- **Alternatives considered:**
  - Tester-only (no builder tests) — rejected: tester has no implementation context; produces vacuous tests
  - Builder-only (no tester) — rejected: builder cannot self-skeptic; misses edge cases
- **References:** `.claude/rules/testing-policy.md` (phase0-step-025), rows phase2-step-008 + phase3-step-009

