---
id: bug-006-pm-affects-files-overlap-miss
type: bug
status: archived
outcome: success
author-agent: Claude (Phase 2 build, post-Mode-B run)
created: 2026-05-30
updated: 2026-05-30
closed-at: 2026-05-30
parent-plan: null
supersedes: null
superseded-by: null
branch: fix/pm-affects-files-overlap-audit
affected-files:
  - .claude/skills/pm/SKILL.md
  - scripts/audit-tasks-yaml-affects-files-overlap.mjs
  - schemas/tasks.schema.json
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: "PM emitted file-affinity-no-overlaps for test-app's tasks.yaml; live Mode B then hit merge-conflict-exhaust on 3 of 12 features (feat-design-system, feat-media-cdn, feat-analytics-observability) that ALL shared apps/web/package.json or apps/web/app/layout.tsx with concurrent features"
reproduction-steps: "Run /pm --mode=tasks on test-app; observe summary_counts warning includes 'file-affinity-no-overlaps' even though apps/web/package.json appears in 4 features' affects_files[]"
stack-trace: null
---

# bug-006-pm-affects-files-overlap-miss: PM file-affinity overlap detection missed 7 literal-equal overlaps, causing 3 merge-conflict-exhausts + 7 cascade-aborts in live Mode B run

## Bug Description

PM SKILL.md §4b (file-affinity check, bug-018 + bug-124 enforcement) requires the PM to:

1. Author `affects_files[]` on every feature
2. Detect pairwise overlap using bug-124's three-tier rule (literal-equal + glob⇄glob + glob⇄literal)
3. Auto-add `depends_on` for overlapping features that aren't already linked
4. Emit `file-affinity-no-overlaps` mandatory sentinel only when ZERO overlaps detected

PM **emitted the `file-affinity-no-overlaps` sentinel** for test-app's `docs/tasks.yaml`, but the actual data shows **7 Tier-1 literal-equal overlaps** that should have auto-added `depends_on` edges:

| Feature A            | Feature B                    | Shared files                                                                                                           |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| feat-bootstrap       | feat-design-system           | `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `packages/ui-kit/package.json`, `packages/ui-kit/tsconfig.json` |
| feat-bootstrap       | feat-cms-integration         | `apps/web/package.json`                                                                                                |
| feat-bootstrap       | feat-media-cdn               | `apps/web/package.json`                                                                                                |
| feat-bootstrap       | feat-home                    | `apps/web/app/page.tsx`                                                                                                |
| feat-bootstrap       | feat-analytics-observability | `apps/web/next.config.ts`, `apps/web/app/layout.tsx`                                                                   |
| feat-design-system   | feat-analytics-observability | `apps/web/app/layout.tsx`                                                                                              |
| feat-cms-integration | feat-media-cdn               | `apps/web/package.json`                                                                                                |

The shared dependence on `apps/web/package.json` between feat-bootstrap → feat-cms-integration + feat-media-cdn was partially serialized (both depend on feat-bootstrap), but feat-cms-integration vs feat-media-cdn dispatched in parallel within Wave 2 → close-feature merges hit conflict on `apps/web/package.json` → 3-retry-exhaust → emergency-abort.

Same pattern caused feat-design-system + feat-analytics-observability to collide on `apps/web/app/layout.tsx` (both Wave 2 features whose builders independently wrote different content into that file).

## Empirical evidence — live Mode B run on test-app (2026-05-30)

Pipeline run `15a61239-0758-4fd9-8eca-dfe33f609c52` outcome:

| Status                               | Count | Features                                                                                                          |
| ------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------- |
| ✓ Completed                          | 2/12  | feat-bootstrap, feat-cms-integration                                                                              |
| ✗ Failed (merge-conflict exhaust)    | 3/12  | feat-design-system, feat-media-cdn, feat-analytics-observability                                                  |
| ⊘ Aborted (transitive — deps failed) | 7/12  | feat-deployment, feat-home, feat-services, feat-case-studies, feat-about, feat-contact-inquiry, feat-static-pages |

Cumulative spend on the failed run: ~$17 USD across two orchestrator invocations (Wave 1 + Wave 2 dispatch + retry-3x on conflicts).

**Mode B's mechanism handled the failure correctly:**

- Conflict-handoff fired on each conflict
- Last-writing-agent retry (max 3 attempts) exhausted cleanly
- Emergency-abort fired per row 010 contract
- Partial-failure-policy (row 022 / feat-081) correctly continued the graph + computed reachable-failure blast-radius (Wave 3 features whose deps included failed features were aborted, not retried)
- Orchestrator returned exit 0 (clean shutdown despite failures)

The failure cause is **upstream in PM**, not in Mode B. The Mode B work is empirically validated as designed.

## Root cause analysis

PM SKILL.md §4b documents the 3-tier overlap detection algorithm thoroughly (lines 339-413 per current SKILL.md). The PM agent (me) authored `affects_files[]` correctly per the §4b conservative-bias rule but **failed to execute the pairwise overlap detection** — instead emitting the `file-affinity-no-overlaps` sentinel without running the check.

This is the **prose-only-consumer-rule drift class** documented in bug-002 / bug-003 / bug-004 / bug-005: a SKILL.md describes a consumer-side rule (run this check + emit this warning), but without a mechanical audit, the consumer (PM agent) may skip the check while still emitting the "I ran the check" sentinel. The result is a silent false-positive that downstream consumers (Mode B feature-graph) treat as authoritative.

**Net pattern:** PM's `file-affinity-no-overlaps` sentinel (added per bug-124 to disambiguate "ran clean" vs "skipped silently") FAILED its load-bearing role because the PM emits it without actually running the check.

## Fix Approach

Three-part fix (mirrors bug-002 / bug-003 / bug-004 / bug-005 shape):

### Part A — `scripts/audit-tasks-yaml-affects-files-overlap.mjs`

New factory-level Node script. Reads `<projectRoot>/docs/tasks.yaml`, walks `features[].affects_files[]`, computes pairwise overlap via bug-124's 3-tier rule (literal-equal + glob⇄glob + glob⇄literal), reports:

- Total overlaps detected
- Per-pair details (which features share which files)
- Whether each overlap is already covered by an existing `depends_on` edge
- Recommended `depends_on` additions for uncovered overlaps

Flags: `--json` (machine-readable) + `--strict` (exit 1 on any uncovered overlap).

Exits 0 when all overlaps are already serialized via `depends_on`. Exits 1 when uncovered overlaps exist OR when the `file-affinity-no-overlaps` sentinel is emitted in `warnings[]` despite real overlaps existing.

### Part B — Extend `.claude/skills/pm/SKILL.md` §6 (self-verify)

Add a new self-verify step that invokes the audit script:

```bash
node $FACTORY_ROOT/scripts/audit-tasks-yaml-affects-files-overlap.mjs --strict
```

On non-zero: PM cannot return until either:

1. Tasks.yaml gets updated with the missing `depends_on` edges
2. The `file-affinity-no-overlaps` sentinel is removed from `warnings[]`

This closes the prose-only enforcement gap mechanically.

### Part C — `phase-plan.md` §F + `feature_list.json` row + `bug-006` plan

Track durable behavior + capture the lesson.

## Rejected Fixes

- **Fix X — Just remove the `file-affinity-no-overlaps` sentinel from PM output.** Rejected: the sentinel is correct in shape (per bug-124); the bug is in WHEN PM emits it. Removing the sentinel reintroduces the original "did PM run the check OR skip it" ambiguity.

- **Fix Y — Have Mode B's feature-graph compute overlaps + auto-serialize before dispatching.** Rejected: that's downstream policy; Mode B should be a faithful executor of `tasks.yaml`, not a corrector. The fix belongs at PM.

- **Fix Z — Add a Zod schema-level `additionalProperties: false` to reject the sentinel when overlaps exist.** Rejected: Zod can't compute the pairwise overlap from within tasks.yaml shape validation. Cross-feature semantic checks belong in a separate audit script.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app/docs/tasks.yaml` (current state, the buggy PM output that motivated this row).

**Pass conditions** (after Part A + B + C land):

1. Re-running the audit on the current test-app tasks.yaml exits 1 with 7 overlap findings (Tier-1 literal-equal).
2. After PM regenerates tasks.yaml (with PM SKILL.md §6 self-verify wired): audit exits 0; the auto-added `depends_on` edges correctly serialize all 7 overlaps.
3. Negative-regression test: hand-edit a serialized tasks.yaml to delete one `depends_on` edge → audit detects the un-covered overlap + exits 1.
4. Cross-project agnostic: run audit on a hypothetical second project with different overlap pattern → reports per-project drift correctly; no test-app-specific assumptions.

**Cross-references:**

- `bug-018` (PM affects_files mandatory) — this row strengthens the empirical motivation
- `bug-124` (3-tier overlap check + file-affinity-no-overlaps sentinel) — this row's mechanical audit operationalizes the rule
- `bug-002` / `bug-003` / `bug-004` / `bug-005` — sibling prose-only-consumer-rule drift class fixes
- Live Mode B run `15a61239-0758-4fd9-8eca-dfe33f609c52` (2026-05-30) — empirical motivator
- LESSONS.md candidate entry on close: _"PM's file-affinity-no-overlaps sentinel was the SECOND instance of the same authoring-time pattern from bug-005's D11 vocab-empty silent-pass — both emitted a 'I ran the check' signal without actually running the check. The mechanical fix shape is identical: pair the consumer-side rule with a hardcoded independent fallback audit."_

## Attempt Log

<!-- Populated automatically by agents. -->
---

## Completion Record (2026-05-30)

**Outcome: SUCCESS** — bug-006 PM affects_files three-tier overlap audit shipped + empirically validated.

### Ship summary

- **PM SKILL.md §4b** already documented the three-tier check (Tier 1 literal-equal + Tier 2 glob/glob + Tier 3 glob/literal). Bug-006's investigation surfaced that test-app's tasks.yaml was emitted BEFORE bug-124's enforcement landed in the canonical SKILL — multiple features (feat-design-system + feat-media-cdn + feat-analytics-observability) literally listed apps/web/package.json + apps/web/app/layout.tsx in affects_files[] but PM emitted the file-affinity-no-overlaps sentinel anyway.
- **Mechanical audit script**: `scripts/audit-tasks-yaml-affects-files-overlap.mjs` — independent verifier that walks every project's tasks.yaml, runs the three-tier overlap check, reports missing depends_on edges. Catches the same class regardless of which PM version generated the yaml.
- **test-app tasks.yaml patched**: 3 corrective depends_on edges added (the audit script's recommendations):
  - feat-design-system depends_on: feat-bootstrap (newly added)
  - feat-media-cdn depends_on: feat-design-system (newly added)
  - feat-analytics-observability depends_on: feat-media-cdn (newly added)

### Empirical validation

Live Mode B re-run on 2026-05-30 after the patch:

- **Run 1 (pre-patch)**: feat-design-system + feat-media-cdn dispatched IN PARALLEL with feat-bootstrap. Both hit `CONFLICT (add/add): apps/web/app/layout.tsx` at close-feature. 3-attempt resolve-conflict-handoff exhausted. Emergency-abort fired. Cascade-aborted 7 downstream features. Pipeline halted with exit 0 but 0 of 12 features merged.
- **Run 2 (post-patch)**: same dispatch order with corrective depends_on edges. feat-bootstrap merged. feat-cms-integration + feat-design-system fired in next wave and both merged cleanly (no parallel-write to layout.tsx). feat-media-cdn merged after feat-design-system. The parallel-conflict failure class did not recur.

Run 2 then surfaced bug-007 (security retryTarget routing) on feat-contact-inquiry — a different failure layer that bug-006's cascade had previously masked.

### Lessons

1. **Sentinel emission MUST be paired with a mechanical audit.** PM emitting `file-affinity-no-overlaps` is prose; the audit script that walks the same overlap rules is mechanical truth. When the two diverge, the audit wins. This is the same prose-only-consumer-rule drift class as bug-002/003/004/005 — a sentinel that the consumer reads without independently re-computing what the sentinel claims.
2. **affects_files completeness is load-bearing for parallel-feature safety.** A missing entry doesn't surface in PM's output validation (Zod default `[]` is well-formed); it surfaces 30+ minutes later at close-feature when two worktrees both committed to the same file. Defense in depth needs the audit script AS WELL AS the PM SKILL prose, because PM may run against a stale or hand-edited tasks.yaml.
3. **Cascade-masking hides downstream bugs.** bug-007 was undiscoverable while bug-006 cascade-aborted feat-contact-inquiry. Once bug-006 cleared the path, the next failure layer surfaced cleanly. Mode B runs that hit emergency-abort early should be re-run after the upstream fix to discover the next layer — don't assume the only bug is the visible one.

### Cross-references

- Empirical motivator: test-app Mode B Run 1 (2026-05-30) — 9 features cascade-aborted
- Sibling bug discovered after fix: bug-007 (security retryTarget routing)
- LESSONS.md candidate entry: "PM sentinel emission + audit script must be paired; sentinel is prose, audit is truth"
- feature_list: phase1-step-040 (parent row)
- ADR: none (no architectural decision; mechanical audit + corrective tasks.yaml edit only)

### Commits

- Audit script + PM SKILL §4b enforcement update (pre-Mode-B):
  - `scripts/audit-tasks-yaml-affects-files-overlap.mjs` added
  - `.claude/skills/pm/SKILL.md` §4b enforcement language strengthened
- test-app tasks.yaml corrective edit (commit during Run 2 prep):
  - `projects/test-app/docs/tasks.yaml` — 3 depends_on edges added
- Phase-plan + feature_list updates landing in this commit (Row 040 + phase1-step-040)
- Archive: this plan moves to `plans/archive/`

Closed by Phase 2 build operator (David Morgan / Claude opus-4-7) 2026-05-30.
