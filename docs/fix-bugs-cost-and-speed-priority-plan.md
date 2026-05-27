# /fix-bugs cost + speed reduction — priority plan

**Created**: 2026-05-05
**Owner**: factory orchestrator track
**Source investigations**: `investigate-016` (bug count + dispatch count) + `investigate-017` (tokens-per-dispatch)
**Empirical baseline**: finance-track-01 — $45.95 spend, 54 bugs, ~5h wall-clock at C=5 (~10h at C=3)
**Combined target**: ~$5-15/project, ~1-2h wall-clock at C=3 — **~70% cost reduction, ~80% wall-clock reduction**

## The cost formula

```
total_cost = bugs × agents_per_bug × tokens_per_dispatch × $/token
                ↑              ↑                      ↑
           feat-051+052    feat-053             feat-055 + bug-053
```

Each follow-up plan attacks a different multiplier. Combined effect is multiplicative, not additive — drop bug count by 50% AND tokens-per-dispatch by 25% = 62% combined reduction.

## Priority-ordered execution plan

Plans are ranked by **(savings × confidence) / engineering effort**. Ship in order; each unlocks compound savings on the next.

### Wave 1 — pure prevention (TIER 1: ship first)

Wave 1 plans STOP bugs from being filed in the first place. Every bug they prevent saves the FULL downstream dispatch cost of all later optimizations combined.

#### 1. **feat-051** — PM AppShell-mandate task template

- **Status**: filed, draft
- **Branch**: `feat/pm-appshell-mandate-task-template`
- **Engineering**: ~1 day (PM skill update + stack-aware variants + 1 regression test)
- **Savings**: ~$15-25/project (eliminates ~22 of 54 finance-track-01 bugs at the source)
- **Risk**: low — additive task-notes injection; existing PM behavior preserved
- **Empirical pre-validation**: react-next/SKILL.md ALREADY has the AppShell mandate (lines 195-200) — PM tasks override it. This fix puts the mandate where it's load-bearing.
- **Why first**: highest expected-value action in the entire stack. Multiplies all downstream savings.

#### 2. **feat-052** — Per-feature parity-smoke at close-feature

- **Status**: filed, draft
- **Branch**: `feat/per-feature-parity-smoke`
- **Engineering**: ~1.5 days (parity-verify subset filter + close-feature integration + retry routing + tests)
- **Savings**: ~$5-10/project (catches divergences AT FIRST FEATURE; subsequent features inherit corrected master)
- **Risk**: medium — adds a per-feature pre-merge gate; if implementation has a bug, blocks merges. Mitigated by retry-budget cap.
- **Why second**: defense-in-depth for the bugs feat-051 doesn't catch (other patterns; non-AppShell-class divergences).

### Wave 2 — dispatch-count collapse (TIER 1: ship next)

Wave 2 attacks the dispatches-per-bug multiplier. Even after feat-051+052 land, residual bugs accumulate; this layer collapses N redundant dispatches into 1.

#### 3. **feat-053** — Class-batched fix-dispatch

- **Status**: filed, draft
- **Branch**: `feat/class-batched-fix-dispatch`
- **Engineering**: ~2-3 days (group-by-pattern helper + per-pattern worktree + per-pattern dispatch context + tests)
- **Savings**:
  - Wall-clock: ~$10/project saved input + ~$10/project saved cache-creation (R2 telemetry win) = **~-20/project**
  - Wall-clock: 22 dispatches → 1 dispatch saves ~21 × 28min = ~10h at C=1 / ~2h at C=5
- **Risk**: medium-high — pattern-aware grouping is new; merge cascade for batched edits is the trickiest piece (additive-concat resolver from bug-034 Phase A handles same-region edits)
- **Why third**: depends on feat-051+052's bug-count reduction landing first (otherwise feat-053's batched-context risks exceeding 200K context window if bugs are in the hundreds). Most engineering risk; ship after the prevention layers de-risk it.

### Wave 3 — per-dispatch tax (TIER 2: low-effort, immediate)

Wave 3 attacks the tokens-per-dispatch multiplier. Each dispatch (whether batched or singleton) carries a fixed output-token tax + plan-file overhead.

#### 4. **feat-055** — Trim agent output instruction to sentineled JSON only

- **Status**: filed, draft (this turn)
- **Branch**: `feat/trim-agent-output-instruction`
- **Engineering**: ~30 min (single-string edit + 2 test additions)
- **Savings**: ~$10/project (~22% of Sonnet output cost)
- **Risk**: very low — graceful fallback for agents ignoring the instruction; outcome JSON parser preserved
- **Why fourth**: independently shippable, can land BEFORE Wave 1+2 if engineering bandwidth opens. Zero coupling to bug-count or dispatch-grouping.
- **Implementation note**: ship as fast-track if Wave 1+2 are blocked on PM coordination.

#### 5. **feat-054** — Reviewer playbook 8th dimension (design-conformance)

- **Status**: filed, draft
- **Branch**: `feat/reviewer-playbook-design-conformance`
- **Engineering**: ~4h (playbook section + reviewer agent prompt update + empirical synthesis)
- **Savings**: ~$3-5/project (defense-in-depth; primary catches are feat-051+052)
- **Risk**: very low — additive playbook dimension; reviewer is read-first
- **Why fifth**: lowest leverage of the wave — feat-051+052 catch most cases; feat-054 backstops residual misses. Worth shipping but not urgent.

### Wave 4 — operational hygiene (TIER 3: nice-to-have)

#### 6. **bug-053** — Plan-file dedup when stable bug-id exists

- **Status**: filed, draft (this turn)
- **Branch**: `bug/bug-plan-file-dedup`
- **Engineering**: ~1h (helper + integration + tests + finance-track-01 cleanup script)
- **Savings**: $0 directly (bugs.yaml already deduped; fix-bugs loop unaffected); ~5-10s per Glob walk during dispatch
- **Risk**: very low — idempotence extension on already-idempotent yaml-write path
- **Why sixth**: not a cost lever, but eliminates operational noise (317 plan files for 54 bugs) and unblocks `/check-existing-work` accuracy. Ship when an engineering hour is free.

## Aggregate forecast

Combined savings forecast assuming all 6 plans ship (best case):

| Plan     | Cost saved | Wall-clock saved | Cumulative cost ($45.95 baseline) | Cumulative wall-clock (5h baseline) |
| -------- | ---------- | ---------------- | --------------------------------- | ----------------------------------- |
| baseline | -          | -                | $45.95                            | 5h                                  |
| feat-051 | ~$15-25    | ~3-4h            | $20-30                            | 1-2h                                |
| feat-052 | ~$5-10     | ~30-60 min       | $15-25                            | 1-1.5h                              |
| feat-053 | ~$10-20    | ~1-2h            | $5-15                             | 30-60 min                           |
| feat-055 | ~$5-10     | ~0               | $0-10                             | 30-60 min                           |
| feat-054 | ~$2-3      | ~0               | $-2-7                             | 30-60 min                           |
| bug-053  | ~$0        | ~5-10 min        | unchanged                         | 25-55 min                           |

**Best-case fresh-project /fix-bugs run**: ~$5-15 spend, ~30-60 min wall-clock at C=3. **~85% cost reduction + ~85% wall-clock reduction** vs finance-track-01 baseline.

### 7. **bug-054** — fix-bugs-loop merge cascade runs in shared projectRoot → fails on dirty tree [P1, BLOCKING current finance-track-01 run]

- **Status**: filed, draft (this turn, surfaced from in-flight finance-track-01 audit)
- **Branch**: `bug/fix-bugs-loop-merge-cascade-dirty-tree`
- **Engineering**: ~2-3h (move merge cascade to fixup-worktree + regression test)
- **Savings**: $0 directly; **unblocks merges currently failing** when projectRoot accumulates uncommitted state from sibling stages (`/build-to-spec-verify` writing failure artifacts, synthesizer rewriting flow-X.spec.ts)
- **Risk**: medium — touches the merge-cascade hot path. Mitigated by Phase D's regression test (dirty-projectRoot scenario).
- **Why elevated to P1**: the current finance-track-01 run already lost `bug-parity-account-create-modal-shell-stripping` to this bug (3 attempts × 28min = ~1.5h dispatch cost burned). Future bugs in the loop will hit the same trap as projectRoot accumulates more dirt across iterations.

## Dependencies + sequencing

```
            feat-051 (PM mandate)
               │
               ▼
            feat-052 (per-feature parity-smoke)
               │
               ▼
            feat-053 (class-batched dispatch)
               │  (depends on bug count being reduced first
               │   so batched context fits 200K window)
               ▼
            feat-054 (reviewer playbook §8)
            [defense-in-depth; can ship parallel]


    INDEPENDENT (can ship anytime):
    feat-055 (output trim)         ─── parallel ───▶
    bug-053  (plan dedup)          ─── parallel ───▶
    bug-054  (merge cascade fix)   ─── parallel ───▶  [P1 — unblocks current run]
```

## Sequencing recommendation

**If single-developer (one stream) — UPDATED with bug-054**:

1. **Land bug-054 first** (~2-3h, P1, unblocks current finance-track-01 run)
2. Land feat-055 (30 min, free win, no coupling)
3. Land bug-053 cleanup (1h, hygiene)
4. Land feat-051 (PM mandate — biggest leverage)
5. Land feat-052 (per-feature parity-smoke — defense layer)
6. Empirical re-validation on a fresh project (book-swap or finance-track-02) → confirm bug-count drops to ~5-15
7. Land feat-053 (class-batched dispatch — now safe with reduced bug count)
8. Land feat-054 (reviewer §8 — final backstop)

**If parallel streams (2-3 developers)**:

- Stream A: bug-054 → feat-051 → feat-052 → empirical validation (2-4 days)
- Stream B: feat-053 (depends on Stream A's empirical confirmation that bug counts dropped) (2-3 days)
- Stream C: feat-055 + bug-053 + feat-054 (1-2 days, all independent)

## In-flight finance-track-01 recovery (operator action)

The current run (`2276b8a1-...`) is alive but its projectRoot has 36 uncommitted files. To unblock subsequent merges WITHOUT killing the orchestrator:

```
/pause-build finance-track-01 --yes
git -C projects/finance-track-01 stash push --include-untracked -m "fix-bugs-loop dirty tree recovery (bug-054)"
git -C projects/finance-track-01 status   # confirm clean
/resume-build finance-track-01
```

Stashed changes are recoverable; spot-check shows they're regeneratable artifacts (verifier failure dumps + synthesizer specs), not manual edits. This is a one-shot cleanup; once bug-054 lands, the merge cascade no longer pollutes projectRoot.

## Notes from in-flight audit

- **`bug-flow-flow-5-null` (needs-operator-review)** is NOT a fix-loop bug — it's bug-050 Phase B's auto-classification working as designed. The flow-5 manifest entry is malformed (`expectedScreenId: null`, malformed selector `[data-kit-component="Table"] >> [data-kit-component="Table"]`). Operator must fix the user-flows-manifest entry; no agent dispatch is appropriate. Working as designed.
- **bug-053 plan-file dedup leverage is bigger than initially forecast**: 13× plan files for the same flow-5 bug (`bug-021`, `bug-081`, `bug-142`, `bug-151`, `bug-160`, `bug-169`, `bug-178`, `bug-232`, `bug-286`, `bug-340`, `bug-372`, `bug-404`, `bug-436`). Across all parity bugs, 463 plan files exist for 54 unique bugs.yaml entries. The dedup will be visibly impactful for `/check-existing-work` accuracy.

## Validation gates

After each wave, run /fix-bugs against a fresh project + capture telemetry:

| Wave         | Validation target                                                                   |
| ------------ | ----------------------------------------------------------------------------------- |
| After Wave 1 | Fresh project /build-to-spec-verify shows ≤10 bugs (vs baseline 54)                 |
| After Wave 2 | /fix-bugs dispatch count drops from ~54 to ~10-15 (singletons + 1-2 pattern groups) |
| After Wave 3 | Per-dispatch Sonnet output tokens drop from ~7.4K to ~3.7K average                  |
| After Wave 4 | plans/active/ stays flat across re-runs of /build-to-spec-verify                    |

## Cross-references

- `plans/active/investigate-016-shift-left-bug-prevention-and-fix-loop-throughput.md` — first investigation (bug count + dispatch count axes)
- `plans/active/investigate-017-token-usage-reduction-for-bug-fix-process.md` — second investigation (tokens-per-dispatch axis)
- All 6 plans in this priority list live under `plans/active/` with their full design.
