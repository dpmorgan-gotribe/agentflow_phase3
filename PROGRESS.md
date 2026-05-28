# PROGRESS.md — Session handoff log (append-only)

> Append a new dated section at the bottom each session. Latest at the bottom; reverse-chronological reading is a foot-gun.

---

## 2026-05-27 — Phase 0 kickoff

- **Goal:** rebuild agentflow Phase 2 onto a harness baseline (ported from agentmark) with sync-phase-plan + evidence-gated discipline + RESEARCH.md adopts.
- **Rows seeded:** 134 in `feature_list.json` (Phase 0: 61, Phase 1: 26, Phase 2: 22, Phase 3: 25).
- **Reference docs in this dir:** `agentflow_rebuild_prompt.md` (the prompt that scoped this work), `RESEARCH.md` (overlay), `inventory-scratch.md` (Phase 2 walk).
- **Open items:** ANTHROPIC_API_KEY not set in current shell; Claude Code session auth covers harness build, but orchestrator runs will need it.

## 2026-05-27 — Harness baseline shipped (rows 001-015 + 029)

- **Done:** 16 rows flipped to passes:true. Commit `[master]` baseline + cleanup. See `evidence/phase0-step-{001..015,029}-result.txt`.
- **Inventory of shipped:** 6 root artifacts, folder skeleton, .claude/settings.json, 7 hooks, 2 subagents (evaluator + retro), 11 skills (6 Phase 2 ports + 5 harness-new).
- **Verifications run:** verify-gate selftest PASS; block-dangerous probes; syntax-check on all .mjs hooks.
- **STOP GATE phase0-step-016 (HUMAN — harness baseline smoke):** pending operator validation.

## 2026-05-27 — Orchestrator shared infra + bulk Phase 2 port (rows 017-061 mostly)

- **Done:** +38 rows flipped (total 54/61 Phase 0).
- **Bulk port strategy:** Phase 2 → Phase 3 via `cp` for proven TypeScript + skills + templates + scripts + schemas + contracts + tests. 6325 lines of orchestrator/src/, 46 test files, 16 schemas, 26 contract source files, ~40 Phase 2 skills, 16 subagents (preserving Phase 2 prompts since rebuild prompt said "subagent prompts come during execution" — Phase 2 prompts are battle-tested starting points).
- **Verifications:**
  - `pnpm install` → 312 packages OK, sharp built (~55s)
  - `pnpm --filter orchestrator test` → 46 test files PASS, **1182/1182 tests PASS** (~56s)
  - `pnpm --filter orchestrator typecheck` → 144 errors, IDENTICAL to Phase 2 (Phase 2 inherited debt in vision-LLM test fixtures; doesn't block test execution)
- **Bug-134 resolution:** picked canonical `invoke-agent.ts`; excluded `.bug-134-final` companion per phase0-step-022 plan.
- **Skipped stubs:** `_phase1-smoke.ts` (empty Phase 2 export — not load-bearing).
- **Rows flipped this batch (passes:true):** 017-026, 028, 030-034, 035-041, 043-047, 051-054, 056-061 (38 rows).
- **Rows NOT YET DONE in Phase 0:**
  - 016 (HUMAN harness smoke) — pending operator
  - 027 (HUMAN /new-project smoke) — **CURRENT STOP GATE**
  - 042 (lessons-agent + agent-expert + html-verifier authoring) — NEEDS_WORK; defer to follow-up session
  - 048 (HUMAN Phase 0 closure) — needs operator + retro after rows 042, 049, 050, 055 land
  - 049, 050, 055 (RESEARCH adopts + POST-MVP cost-projection) — deferred until orchestrator runs prove the baseline
- **STOP GATE phase0-step-027 (HUMAN — /new-project smoke test):** operator exercises `/new-project test-app --proposal-file proposals/hatch-proposal.md` (or similar) and signs off in `evidence/phase0-step-027-result.txt`.

## 2026-05-28 — /new-project gate cleared + Phase 0 finishers (rows 027, 042, 049, 050, 055)

- **Done:** +5 rows. Phase 0 now **59/61 passing (97%)**.
- **/new-project test-app gate (phase0-step-027):** operator ran `/new-project test-app --proposal-file proposals/hatch-proposal.md --agentic-visibility=private` cleanly. 18 agents + 50 skills + 7 hooks + 2 rules + 18 templates + 16 schemas + 5 validators cloned. Hatch brief drafted with 7 AI-filled + 10 inferred + 3 TODO sections. 3 warnings surfaced as factory gaps — all addressed (see below).
- **Factory gaps closed:** improved `assets/README.md`; added 3 canonical templates (`.claude/templates/project-{turbo.json,tsconfig.json,package.json}.template`); MCP per-agent sync skip confirmed as expected.
- **Row 042 (3 net-new agents):** html-verifier (Haiku) + lessons-agent (Sonnet) + agent-expert (Opus). Resolves Phase 2's [UNFINISHED] flag.
- **Row 049 (RESEARCH adopt):** confirmed `excludeDynamicSections: true` wired in Phase 2 invoke-agent.ts:2626; switched factory `.claude/models.yaml` to `provider: anthropic-api`; documented `ENABLE_PROMPT_CACHING_1H=1`; cache-hit metric confirmed in budget-tracker.
- **Row 050 (RESEARCH adopt):** `scripts/hook-regression.mjs` with 24 fixtures, **24/24 PASS in <2s**.
- **Row 055 (POST-MVP adopt):** `orchestrator/src/cost-projection.ts` + 15-test suite (all pass) + `/preview-cost` operator skill.
- **Outstanding (2 of 61):**
  - **phase0-step-016 (HUMAN harness baseline smoke)** — pending operator (5 sub-checks; can run any time).
  - **phase0-step-048 (HUMAN Phase 0 closure)** — **CURRENT STOP GATE.** Operator runs `/phase-gate 0` → reads `reports/phase-0-gate-<date>.md` → spot-checks 5 random rows → tags `phase-0-done` + `phase-1-start`.

## 2026-05-28 — phase 0 gate report generated

- Report: `reports/phase-0-gate-2026-05-28.md`
- Inputs: 61 phase0 rows, 59 passes:true (96.7%), 2 passes:false (both human-inspection: step-016, step-048).
- Retro verdict: READY FOR OPERATOR REVIEW with **one hard blocker** — Section 4b plan-parity drift = **0/5 (0%)**. Every Phase 0 scope section (§0a–§0i) in `phase-plan.md` is still `[to be filled]`; `/sync-phase-plan` was never invoked during Phase 0. Per CLAUDE.md "Rebuild guarantee", drift >20% blocks phase close.
- Required before closure: (1) run `/sync-phase-plan` across all 9 Phase 0 sections; (2) close phase0-step-016 (5 sub-check operator walk); (3) re-run `/phase-gate 0` to confirm drift <20%; (4) operator signs off phase0-step-048 and applies `phase-0-done` + `phase-1-start` tags.
- Awaiting human approval before phase 1 starts.

## 2026-05-28 — phase 0 gate report re-run after /sync-phase-plan

- Report: `reports/phase-0-gate-2026-05-28.md` (overwritten — same-date path; supersedes the earlier run).
- Trigger: commit `22d22d2` bulk-filled §0a–§0g + §0i (238 insertions) and `cebd726` reverted the forced anthropic-api default per the lesson from step-049.
- Row counts unchanged: 59/61 passes:true (96.7%); same 2 human-inspection rows open (step-016, step-048).
- Section 4b plan-parity audit: **5/5 OK = 100%** (was 0/5 in the prior run). Hard blocker cleared.
- §0h "Phase 0 closure (row 048)" intentionally remains `[to be filled]` — it records the outcome of this gate and is filled after operator sign-off.
- DECISIONS.md: ADR-001 carries an inline 2026-05-28 revision (factory does NOT pin auth provider). Open question (blocker 3): operator decides whether to leave the inline revision or author ADR-003 as a formal supersession.
- Gate status: **READY FOR HUMAN SIGN-OFF.** 6 open items in Section 6 are operator-decision items, not gate blockers.
- Next: operator reads the report, optionally closes step-016, signs off step-048, then `git tag phase-0-done && git tag phase-1-start`.

## 2026-05-28 — Phase 0 closure prep: 6-item batch resolving gate-report Section 6

Following the green Phase 0 gate report, ran a single-batch resolution of the 6 operator-decision items + the optional CLAUDE.md amendment (per operator "go with [the amendment]" instruction). All items resolved mechanically; ready for the operator to tag.

- **ADR-003 authored** (DECISIONS.md): formal supersession of ADR-001's auth-default clause. Factory does NOT pin a `provider:` default; auth selection delegated to `~/.claude/models.yaml`. Cross-refs ADR-001 + LESSONS phase0-step-049 + commits 5324311/cebd726.
- **ADR-004 authored** (DECISIONS.md): introduces `polished: "waived"` third-state for factory-build perf rows with intrinsically fast implementations. Scope guardrail: Mode A stages + builder/tester dispatch + verifier tiers still require mandatory `/polish-pass`.
- **Polish-pass waived on 2 rows**: phase0-step-050 (hook-regression, 24/24 PASS <2s) + phase0-step-055 (cost-projection, <1ms/forecast pure-function). Each row has `polished: "waived"` + `polished_waiver_reason` field per ADR-004. Helper at `scripts/_waive-polished.mjs`.
- **2 retroactive lessons captured** in LESSONS.md: (a) phase0-step-027 — /new-project surfaces factory gaps the planning pass missed (technique: walk every SKILL.md body for `Write|Create|mkdir` to enumerate class-2 generated artifacts); (b) phase0-step-042 — scaffolding docs are SPECS, not implementations; check spec→implementation gap before marking ports complete.
- **Phase 3 typecheck-debt note** added to phase-plan.md Phase 3 section: 144 errors are inherited Phase 2 debt in vision-LLM test fixtures; do NOT file as Phase 3 regressions; in scope for rows phase3-step-006 + phase3-step-007 to fix as part of their wiring work.
- **Phase 1 §-skeleton seeded** in phase-plan.md (5 subsections: §A pipeline machinery, §B stage wiring, §C HITL gates, §D supplementary skills, §E Phase 1 closure). Each subsection has a `[to be filled]` placeholder with a one-line scope hint so `/sync-phase-plan` has slots to fill incrementally during Phase 1 rather than requiring another bulk retroactive fill at the Phase 1 gate.
- **CLAUDE.md amendment** under §Hard rules: new "RESEARCH adopts" section codifies the lesson from phase0-step-049 — don't silently apply operator-facing default changes via factory project-level overrides; document tradeoff + require explicit operator opt-in.

**Outstanding for the operator** (each is non-blocking):

- phase0-step-016 HUMAN smoke (5 sub-checks) — judge ship-ready OR run sub-checks. Harness is empirically working (used to flip 59 rows + run /phase-gate twice).
- Tag `phase-0-done` + `phase-1-start` when ready.

After tagging, I fill §0h with operator name + date + final row count + git tag applied, commit, and we're into Phase 1.
