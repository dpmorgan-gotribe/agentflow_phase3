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
