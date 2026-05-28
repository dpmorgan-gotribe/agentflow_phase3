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

- **Status:** accepted (revised 2026-05-28 — auth-provider change reverted)
- **Date:** 2026-05-27 (revised 2026-05-28)
- **Context:** Phase 2's parallel worktree fan-out (Mode B) misses Anthropic prompt cache on every worktree because the SDK auto-injects per-machine cwd/git/platform sections into the system prefix. Per RESEARCH.md §A.1 + §F.6, this is a high-ROI performance issue.
- **Decision (load-bearing):** Set `excludeDynamicSections: true` on every `query()` call in the orchestrator. This is auth-mode-independent.
- **Decision (recommended, not enforced):** When operator uses `provider: anthropic-api`, also set `ENABLE_PROMPT_CACHING_1H=1` in env (1h TTL improves long-loop cache economics).
- **Consequences:** ProjectDiscovery precedent: cache-hit ratio 7% → 84%. For 4-worktree Mode B run with ~10K-token prefix, this saves 30K tokens of cache writes per run.
- **Alternatives considered:**
  - Defer the change — rejected: cheap to ship from day one.

### Revision 2026-05-28 — reverted forced API-key default

The original 2026-05-27 ADR also said "Default `auth-provider.ts` to API-key mode (Max OAuth is ToS-violating for headless SDK + breaks cache_control as of Mar 2026)." That change was made at the factory project level via `.claude/models.yaml`. **Reverted 2026-05-28** after the operator flagged that:

1. They run on a Claude Max 20x subscription with no `ANTHROPIC_API_KEY`. Forcing API-key default breaks their orchestrator runs.
2. The RESEARCH.md claims about Max OAuth being ToS-violating for SDK use were treated as authoritative without operator validation. The right behavior is to surface the tradeoff in `docs/agent-sdk-auth-providers.md` and let the operator choose, not to pin a factory-level default that overrides the user's own `~/.claude/models.yaml`.
3. `excludeDynamicSections: true` is the load-bearing performance change. Auth-mode choice is the operator's call.

Lesson captured in `LESSONS.md` (will be added next /capture-lesson run): "Do not pin operator-facing defaults from RESEARCH.md claims without validating against the actual operator's setup. Factory project-level overrides of user-home config are aggressive; recommend, document, and let the operator opt in."

- **References:** RESEARCH.md §A "Agentflow Retrieval Layer" + §F "Advanced Prompt Caching", row phase0-step-049, docs/agent-sdk-auth-providers.md

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

## ADR-003 — Auth-provider default is operator-chosen (supersedes ADR-001 auth-default clause)

- **Status:** accepted
- **Date:** 2026-05-28
- **Context:** ADR-001 (original) included a "Default `auth-provider.ts` to API-key mode" clause citing RESEARCH.md claims about Max OAuth being ToS-violating for headless SDK use. That default was implemented (commit 5324311 — added `provider: anthropic-api` to factory `.claude/models.yaml`) and immediately reverted (commit cebd726) after the operator flagged that they run on Claude Max 20x with no `ANTHROPIC_API_KEY`. ADR-001 was revised inline rather than formally superseded; the Phase 0 retro flagged the inline-revision approach as in tension with the "ADRs are immutable once accepted" log convention.
- **Decision:** Formalize the reversion via this ADR. **The factory does NOT pin a `provider:` default.** `auth-provider.ts` continues to support all 4 providers (`claude-max-subscription`, `anthropic-api`, `bedrock`, `vertex`); selection is delegated entirely to `~/.claude/models.yaml` (user-home, operator-managed). Factory `.claude/models.yaml` MUST NOT set a top-level `provider:` key.
- **Consequences:**
  - Operator's existing user-home auth setup wins; no factory-level surprise overrides.
  - Cache-prefix-reuse via `excludeDynamicSections: true` (the load-bearing performance change from ADR-001) remains active and is auth-mode-independent.
  - `ENABLE_PROMPT_CACHING_1H=1` is recommended in CLAUDE.md for `anthropic-api` users on long runs; no-op for Max subscribers.
  - ADR-001's "Decision (auth)" clause is superseded by this ADR. ADR-001's "Decision (cache prefix reuse)" clause remains in force. Downstream rows referencing ADR-001 should cross-check ADR-003 for the current auth posture.
  - Establishes a precedent: factory project-level overrides of `~/.claude/models.yaml` are reserved for choices the project genuinely requires (per-agent tier pin for unusual workloads, per-feature budget overrides). Operator-facing defaults like auth provider are not factory's call.
- **Alternatives considered:**
  - Leave ADR-001 inline revision as-is — rejected: tension with immutable-ADR convention; cleaner downstream pointer if formalized.
  - Re-pin `provider: anthropic-api` with operator approval — rejected: operator does not have an API key; the user-home config is the right authority for auth.
- **References:** ADR-001 (revised, DECISIONS.md lines 33-54), LESSONS.md "RESEARCH adopts must be validated against operator setup" (phase0-step-049), `.claude/models.yaml`, `docs/agent-sdk-auth-providers.md`, commits 5324311 (introduce) + cebd726 (revert), Phase 0 Gate Report 2026-05-28 Section 6 blocker #3.

## ADR-004 — Polished waiver for factory-build perf rows with intrinsically fast implementations

- **Status:** accepted
- **Date:** 2026-05-28
- **Context:** Phase 0 includes 2 rows with `category: "perf"` (phase0-step-050 hook-regression, phase0-step-055 cost-projection). Both pass functionally. Both have intrinsically fast implementations (24-fixture hook-regression runs in <2s; cost-projection is pure-function math at sub-millisecond per call). The `/polish-pass` skill expects a perf/cost budget declared in `phase-plan.md` and produces `evidence/{row-id}-bench.json` with `passes_budget: true`. For these rows there is no meaningful budget to verify — the implementation is already at floor performance.
- **Decision:** Introduce a third state for the `polished` field: `"waived"` (string) in addition to the existing boolean `true | false`. A waived row signals "polish ceremony intentionally skipped — perf is not a meaningful concern at this row's implementation profile." Must be paired with a `polished_waiver_reason` field containing a one-line justification. The phase-gate retro should treat `"waived"` as semantically equivalent to `true` for Section 2 (Optimizations) reporting.
- **Consequences:**
  - phase0-step-050 + phase0-step-055 flip `polished: "waived"` with reason captured.
  - Future factory-build infra rows can claim the waiver where it applies (sub-second execution, pure-function complexity, no I/O). Operator-facing or pipeline-runtime rows should still go through `/polish-pass` normally.
  - The waiver is NOT a license to skip polish-pass on rows where perf actually matters. Mode A stages, builder/tester dispatch, verifier tiers — all retain mandatory polish ceremony.
  - `feature_list.json` schema deviates slightly (polished becomes `boolean | "waived"`); document in any schema validator for feature_list as a known-good value.
- **Alternatives considered:**
  - Run /polish-pass anyway with a trivial budget — rejected: ceremony without signal pollutes the bench evidence corpus and gives retros false confidence in the polish-pass discipline.
  - Add a separate `polish_required: false` field — rejected: two fields for one concept; the string-literal "waived" state is denser.
- **References:** Phase 0 Gate Report 2026-05-28 Section 2 + Section 6 blocker #4, `feature_list.json` rows phase0-step-050 + phase0-step-055.

## ADR-005 — Operator-facing command grouping (Mode A pipeline UX)

- **Status:** accepted
- **Date:** 2026-05-28
- **Context:** Mode A's stages-array has 13 stages, each wired to a slash command. Some are conceptually operator-facing (`/analyze`, `/mockups`, etc.); others are internal sequencing detail (`/skills-audit --scope=design`, `/stylesheet-primitives`, `/register-mcp-servers --scope=build`, etc.). All 13 appear in Claude Code autocomplete with equal prominence, which obscures the operator's mental model of "which commands do I actually invoke."
- **Decision:** Add a `userInvokable: boolean` field to `PipelineStage`. **Six stages are operator-invokable; seven are internal sub-stages auto-run by their parent's orchestration sequence:**
  - `/analyze` → auto-runs `skills-audit-design`
  - `/mockups` → (single stage)
  - `/stylesheet` → (single stage; **stack-agnostic kit-core**: tokens, styles, Tailwind, HTML preview)
  - `/screens` → auto-runs `visual-review`, `user-flows`
  - `/architect` → auto-runs `stylesheet-primitives` (**stack-bound** — the chosen stack is read from `architecture.yaml.tooling.stack.web_framework`; React / Vue / Svelte / Angular all flow through the same stage with `ui-designer` dispatching to the matching skill in `.claude/skills/agents/front-end/{slug}/`)
  - `/pm` → auto-runs `skills-audit-build`, `register-mcp-build`, `git-agent-bootstrap`
- **Consequences:**
  - Pipeline mechanics unchanged: cli-runner still walks all 13 stages with per-stage retry / budget / gate machinery. The flag is metadata for operator UX + documentation.
  - Operator-facing docs (CLAUDE.md, phase-plan, gate-by-gate walkthroughs) describe 6 commands, not 13.
  - HITL gates remain at their natural boundaries: Gate 1 after `/analyze`, Gate 2 after `/mockups`, Gate 3+4 after the internal `user-flows` (tail of `/screens`), Gate 5 after `/architect` credentials drop (which precedes the auto-run `stylesheet-primitives`).
  - The `stylesheet` → `architect` → `stylesheet-primitives` ordering is preserved and made explicit: pre-architect, stylesheet ships a stack-agnostic kit-core; post-architect (after stack pick), stylesheet-primitives binds the kit-core to the chosen stack.
  - Future internal stages added to the pipeline default to `userInvokable: false` unless there's a strong reason to expose them.
- **Alternatives considered:**
  - Hide internal skills from autocomplete by renaming or moving to `.claude/skills/_internal/` — rejected: prevents debugging access; the skills are still real and may need manual invocation during development.
  - Collapse internal stages into their parents (one mega-stage per command) — rejected: loses per-sub-stage retry/budget/gate granularity that Phase 2's feat-074 (stylesheet-primitives) and visual-review-retry depend on.
  - Add a separate `parentCommand?: string` field for explicit child→parent linkage — rejected: redundant with `dependsOn` for parsing intent; the simpler boolean flag plus the auto-run mapping in stages-array's doc comment is sufficient.
- **References:** `orchestrator/src/stages-array.ts` (USER_INVOKABLE_STAGES export + per-command auto-run mapping in the doc comment), `packages/orchestrator-contracts/src/stages.ts` (PipelineStage.userInvokable), `feature_list.json` rows phase1-step-014 + 015 + 019 + 021 (descriptions updated to reflect grouping), CLAUDE.md "Pipeline overview", phase-plan.md §A.
