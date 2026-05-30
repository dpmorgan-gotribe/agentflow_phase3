---
name: pm
description: Dual-mode Project Manager skill. --mode=tasks produces docs/tasks.yaml v2 from architecture.yaml + requirements.md + flows. --mode=kit-change-request produces a kit-bump mini-plan from a docs/screens/kit-change-requests/*.md file. Cross-field invariant enforcement + schema validation + retry loop.
when_to_use: mode=tasks after /architect resolves (post-signoff pipeline); mode=kit-change-request when /screens or a builder emits docs/screens/kit-change-requests/*.md
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "--mode=tasks | --mode=kit-change-request --request-file=<path>"
---

# /pm — dual-mode Project Manager

Runs in one of two modes. The orchestrator (task-035) controls invocation position; this skill enforces the mode contract + writes the appropriate outputs.

## Arguments

- `--mode=<tasks | kit-change-request>` (required). Invocation without `--mode` is rejected with a clear error.
- `--request-file=<path>` (required only when `--mode=kit-change-request`). Must be an absolute or project-relative path to an existing `docs/screens/kit-change-requests/*.md` file.

## Prerequisites

### mode=tasks

- `/architect` has resolved — `.claude/architecture.yaml` exists and validates against `schemas/architecture.schema.json`
- `docs/requirements.md` exists
- `docs/brief-summary.json` exists
- `brief.md` §12 + §19 readable
- Per-platform `docs/analysis/{platform}/flows.md` present (from `/analyze`)
- `packages/ui-kit/package.json` exists (for `ui_kit_version` field)

### mode=kit-change-request

- `--request-file` resolves to an existing `docs/screens/kit-change-requests/*.md`
- `packages/ui-kit/package.json` + `packages/ui-kit/CHANGELOG.md` exist
- Does NOT require `.claude/architecture.yaml` — design-phase detours fire pre-architect

## Outputs

### mode=tasks

| Path                       | Purpose                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/tasks.yaml`          | v2 task graph. `features[]` + `tasks[]`. Validates against `schemas/tasks.schema.json`.                                                                                                                                                       |
| `docs/tasks-coverage.json` | feat-023 brief-coverage claim: maps every brief §11/§12 capability to ≥1 task ID OR explicit deferral. Validates against `schemas/tasks-coverage.schema.json`. Skipped when `docs/brief-capabilities.json` is absent (pre-feat-023 projects). |

### mode=kit-change-request

| Path                                      | Purpose                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `plans/active/kit-change-request-{id}.md` | Mini-plan scoping exactly one primitive / pattern / layout. References emitting screen. Carries proposedKitVersion. |

## mode=tasks steps

### 0. Mandatory output fields (bug-018)

Before doing ANY authoring work, read `schemas/feature.schema.json` from disk
to confirm the field shape — DO NOT rely on memory:

```bash
head -120 schemas/feature.schema.json | grep -A 4 "^    \"\(affects_files\|skip\|priority\|brief_reference\)\":"
```

The following fields MUST be populated on every feature, even when the value
is the empty-list sentinel:

| Field            | Required? | Empty allowed?                                                                           |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `id`             | YES       | no                                                                                       |
| `priority`       | YES       | no — pick P0-P3 explicitly                                                               |
| `agent_sequence` | YES       | no — must have ≥1 entry                                                                  |
| `tasks`          | YES       | no — must have ≥1 entry                                                                  |
| `affects_files`  | YES       | yes (`[]`) ONLY when feature genuinely touches no shared files; otherwise populate fully |
| `depends_on`     | YES       | yes (`[]`) when feature has no upstream deps                                             |
| `skip`           | YES       | yes (`[]`) when feature touches all surfaces                                             |

**Critical: `affects_files` is NOT optional in spirit even though Zod marks
it `.default([])`.** The field is present in every project's
`schemas/feature.schema.json` under `properties.affects_files` (regenerated
from `packages/orchestrator-contracts/src/tasks.ts` FeatureSchema). If you
catch yourself thinking "the schema doesn't expose this field" — STOP and
re-grep the schema file. That claim has been wrong every time it's been
made (per bug-018, 3 of 4 PM agents on 2026-04-28 falsely reported the
field missing).

**If your re-grep genuinely shows the field missing, the project schema
has drifted from the factory canonical (bug-019).** Do NOT silently patch
the schema yourself as a side-effect of PM. Run the sync script first, then
retry:

```bash
node ../../scripts/sync-project-schemas.mjs .
```

(Path is relative to the project root; the script's `--dry-run` flag previews
without modifying anything. The script is idempotent — re-run safely.)

**3-step heuristic for populating `affects_files`** (per step 4b):

1. Walk each task's `summary` for file/module hints (e.g., "render
   empty-no-board" → `apps/web/src/components/board/**`).
2. Walk each task's `screens[]` and map to component paths
   (`webapp/home` → `apps/web/app/page.tsx` + `apps/web/src/components/board/**`).
3. Walk the feature's `integration_ref` for backend-side paths
   (`integrations.api.database` → `apps/api/src/db/**`).

Conservative bias: when in doubt, list MORE globs. False positives over-serialize
(~5 min wall-clock cost); false negatives cause runtime merge conflicts (~$5+ each).

### 1. Argument + prereq gate

- Verify `--mode=tasks` is set. Missing mode → abort with message.
- Read `.claude/architecture.yaml` — abort with "requires /architect to have run" if missing.
- Read `docs/requirements.md`, `docs/brief-summary.json`, `brief.md`, every `docs/analysis/{platform}/flows.md`.
- Read `packages/ui-kit/package.json.version` for `ui_kit_version` field.

### 2. Build feature graph via heuristic

For each integration in `architecture.yaml.apps.*.integrations.*` where `deployment: vendor | self-hosted`:

1. Check if the integration belongs to a known user-flow (look for `integration:category` mentions in flows.md). If yes, merge into the flow's feature.
2. Otherwise, check if the integration maps to a brief §11 catalogue entry. If yes, use that feature slug.
3. Otherwise, single-integration feature.

Apply in precedence order. The result is a set of proposed `features[]` entries.

For each flow in `docs/analysis/{platform}/flows.md`:

1. Create a feature (if not already created by integration grouping above).
2. Tasks inside: one backend-builder task for any API endpoint implied by the flow, one frontend-builder task per relevant platform, one tester task, one reviewer task.

### 2b. Resolve screens per frontend task (feat-012)

Between grouping (step 2) and composition (step 3), bind each frontend task to its explicit screen set. This replaces the wildcard `docs/screens/{platform}/*.html` scope with an authoritative per-task list so builders know exactly which screens they own.

Inputs:

- `docs/analysis/{platform}/flows.md` — per-platform flows with `**Screens**:` sequences (`welcome.html → signup.html → ...`)
- `docs/screens-manifest.json` — authoritative `files[]` with `{ path, platform, screenId, sha256 }` entries (produced by `/screens` — exists when PM runs per the refactor-003 ordering: `pm` depends on `architect` → `user-flows` → `visual-review` → `screens`)

Algorithm, per frontend task (`agent` is `web-frontend-builder` or `mobile-frontend-builder`):

1. Identify the feature's originating flow(s) (via `brief_reference` / the integration-flow mapping from step 2)
2. Extract screen filenames from each flow's `**Screens**:` section (strip `.html`, split on `→` + `,` whitespace)
3. For each filename, match against `screens-manifest.files[]` where `platform` equals the task's surface (`webapp` for web-frontend-builder; `mobile` for mobile-frontend-builder)
4. Populate `task.screens[]` with the matched `{platform}/{screenId}` strings. De-dupe; preserve flow order where possible.

Example: `feat-auth` maps to flow 1 in `docs/analysis/webapp/flows.md` whose screens are `welcome.html → signup.html → verify-email.html`; manifest has matching entries. The web-frontend-builder task gets:

```yaml
screens: [webapp/welcome, webapp/signup, webapp/verify-email]
```

Non-frontend tasks (backend-builder / tester / reviewer / security / devops) MUST leave `screens` unset (Zod superRefine rejects otherwise).

**Overlap detection.** After all features + tasks have their `screens[]` populated, scan for any `{platform}/{screenId}` that appears on tasks in ≥2 different features. For each collision:

- Emit `tasks.yaml.warnings[]`: `screen-overlap: {platform}/{screenId} claimed by feat-A, feat-B — flow decomposition likely wrong; reconcile at gate 4`
- DO NOT auto-resolve. This signals that the Analyst's flow grouping placed a shared screen in two flows; human should adjust flows.md and re-run PM.

**Empty-screens warning.** If a frontend task on a non-skipped surface has `screens.length === 0`, emit `tasks.yaml.warnings[]`: `frontend-task-zero-screens: feat-X task-Y — kit-only or routing-only work, or missing flow mapping`. Warning only; some UI work is kit-scaffolding and doesn't touch named screens.

### 2c. Surface routePattern per frontend task (bug-025)

For each frontend task whose `screens[]` includes screens whose `screens.json` entry has a `routePattern` field, surface that mapping in the task's `summary` so the builder reads it as part of its dispatch context. This prevents two builders from independently inventing different URLs for the same screen:

```yaml
- id: feat-home
  tasks:
    - id: home-screen
      agent: web-frontend-builder
      screens: [webapp/home]
      summary: "Home page (route: /). Form submit navigates to /report/:owner/:repo per webapp/report.routePattern."
```

If the screens.json entry lacks `routePattern` (older project pre-bug-025), emit a `tasks.yaml.warnings[]`: `missing-route-pattern: webapp/{screenId} — re-run /screens to populate routePattern, OR add it to docs/screens-manifest.json`. Builders without an authoritative routePattern fall back to `/{screen-id}` heuristic which is wrong for dynamic routes.

**bug-114 upgrade (2026-05-16): missing-route-pattern is HARD-FAILED at gate 4, not warned**. The bug-114 motivator (gotribe-tribe-directory) showed that the warning-only behavior allowed shipping a manifest with `routePattern: null` on every screen — the verifier's perceptual + parity tiers then visited heuristic URLs that 404'd, producing 4 cascading false-positive bugs that the fix-loop spent ~$15 dispatching builders against. After bug-114 ships:

- `/screens` self-verifies that every `files[]` entry has a non-empty `routePattern` BEFORE writing the manifest (cheapest layer; fails at design time).
- PM re-validates here and ALSO surfaces missing routePattern as an error blocking gate 4 signoff (defense in depth; catches projects where `/screens` was bypassed or the manifest was hand-edited).
- The `tasks.yaml.warnings[]` entry is renamed to `tasks.yaml.errors[]` for this class; the orchestrator's gate-4 validator treats `errors[]` as a hard block.

Operator unblock for pre-bug-114 projects: re-run `/screens` to regenerate the manifest with populated `routePattern`, OR hand-edit `docs/screens-manifest.json` to add `routePattern` per screen (using the heuristics documented in `/screens` §8).

### 3. Compose tasks.yaml structure

```yaml
version: "2.0"
generated_at: "{now-ISO-8601}"
project_name: "{from brief-summary.projectName}"
architecture_ref: .claude/architecture.yaml
ui_kit_version: "{from packages/ui-kit/package.json.version}"
features:
  - id: feat-{slug}
    worktree: feat-{slug}
    branch: feat/{slug}
    priority: P0|P1|P2|P3
    depends_on: [...]
    skip: [...] # web | mobile | backend surfaces NOT touched by this feature
    agent_sequence: [
        backend-builder,
        web-frontend-builder,
        mobile-frontend-builder,
        tester,
        reviewer,
      ] # trimmed per skip[]
    summary: "..."
    brief_reference: "brief.md §12 / docs/analysis/webapp/flows.md#flow-N"
    tasks:
      - id: { kebab-slug }
        agent: { one of agent_sequence members }
        depends_on: [...] # other task.id within this feature
        skills: [stack-skill-slug-1, vendor-skill-slug-2]
        priority: P0|P1|P2|P3
        integration_ref: architecture.yaml#apps.api.integrations.payments # when applicable
        estimated_screens: N # on frontend tasks (count — advisory)
        screens: [webapp/login, webapp/signup] # feat-012: REQUIRED on frontend tasks (exact scope); MUST be absent/[] on backend/tester/reviewer/devops
        status: pending
        summary: "..."
summary_counts:
  total_features: N
  total_tasks: M
  by_agent: { ... }
  by_priority: { P0: n, P1: n, P2: n, P3: n }
warnings: [...]
```

### 4. Enforce cross-field invariants

Before writing:

1. For each task, confirm `task.agent` appears in its parent `feature.agent_sequence[]`. If not, either add the agent to the sequence (preferred) or reassign the task (rarely correct).
2. DFS-walk `feature.depends_on[]` to detect cycles. On cycle: reshape the graph (break the cycle at the lowest-priority edge) or surface as a warning + abort.
3. For each task, confirm `task.depends_on[]` entries all resolve to other task.id values **within the same feature**. Cross-feature deps belong at `feature.depends_on`; move them up if present.
4. For each integration in architecture.yaml with `requiredNow: true`, confirm at least one `P0` task references it via `integration_ref`. If not, bump the corresponding task to P0 or emit a warning.
5. **Screens ownership (feat-012)**. Non-frontend tasks (`backend-builder` / `tester` / `reviewer` / `security` / `devops`) MUST have `screens: []`. Zod superRefine rejects otherwise at validation time; catch earlier by refusing to populate the field. Frontend tasks on a non-skipped surface SHOULD have ≥1 screen entry; zero-screen frontend tasks emit a warning (see step 2b).

### 4b. File-affinity check (bug-015 Phase 2 — MANDATORY per bug-018)

After step 4 invariants pass, populate `feature.affects_files[]` and serialize features that share files. **This pushes parallel-feature merge conflicts back to the PM stage where they're a one-line dependency edit, instead of letting them surface at runtime in close-feature where they cost $5+ per conflict (per kanban-webapp-08 incident).**

**bug-018 enforcement: this step is NON-NEGOTIABLE.** Three of four PM agents on 2026-04-28 fabricated reasons to skip it ("affects_files not in schema" — false in every case). Before claiming the field is unavailable, run the §0 grep. If you genuinely believe the schema is broken, that's a separate bug — file it via /plan-bug; do NOT silently skip the field.

Algorithm, per feature:

1. **MUST author `affects_files[]`** — a glob list of files this feature is expected to mutate. Derive conservatively from task summaries + screens. For a `feat-board-core` with tasks "render-empty-no-board", "dnd-kit-cards-and-columns", "inline-card-edit", expected globs include:
   - `apps/web/src/components/board/**` (component scope)
   - `apps/web/src/store/board.ts` OR `apps/web/src/store/index.ts` (state scope — pick whichever the architect chose; see Phase 3 below)
   - `apps/web/app/page.tsx` (route scope, if the home route changes)

   When in doubt, list MORE globs. False positives (over-serializing) cost ~5min of wall-clock per feature; false negatives (under-serializing) cost $5+ per merge conflict.

   **Per-package tsconfig completeness invariant (bug-119).** Every `packages/<name>/` workspace member that the feature touches — whether mentioned in `task.summary`, referenced via `@repo/<name>` in any task's summary/notes, or implied by a glob entry under `packages/<name>/` — MUST have BOTH `packages/<name>/tsconfig.json` AND `packages/<name>/package.json` explicitly listed in `affects_files[]`. Skipping the tsconfig is the silent-failure path: the builder authors `packages/<name>/src/*.ts` (per workspace skeleton expectations), `pnpm -r typecheck` walks the package, finds no tsconfig, falls back to the root config (which lacks `jsx: "react-jsx"`), and emits TS17004 cascade against every `.tsx` reachable through the workspace. Empirical motivator: `gotribe-tribe-wizard` 2026-05-17 — feat-bootstrap reviewer blocker 2 of 3 (`packages/utils/tsconfig.json` absent → TS17004 cascade across every webapp screen).

   Authoring procedure: after drafting `affects_files[]`, walk every distinct `packages/<name>/` prefix in the list. For each, assert BOTH `packages/<name>/tsconfig.json` and `packages/<name>/package.json` are present as literal entries. If absent, ADD them — do not rely on builders to infer. The same rule applies to packages mentioned via `@repo/<name>` in task summaries even when no glob explicitly names a path under that package.

2. **Detect overlap pairs (bug-124 enforcement — three-tier check).** After all features have `affects_files[]`, compute pairwise overlap using ALL THREE of these rules. Two features overlap if ANY rule fires:
   - **Tier 1 — literal-equal.** If any entry in feature A's `affects_files[]` is byte-identical to any entry in feature B's, they overlap. **This rule MUST be checked first and on its own — do not require either side to contain a `*` glob to trigger.** Empirical motivator (bug-124, gotribe-event-calendar 2026-05-17): `feat-tribes-route` + `feat-test-seed-routes` both listed `apps/api/src/server.ts` literally; an overlap-detection that required at least one `*` to expand against would silently miss this, dispatch both in parallel, and hit `CONFLICT (add/add)` at close-feature — costing ~$15.76 of aborted work + cascading 3 dependent features into failure.
   - **Tier 2 — glob ⇄ glob.** If a glob in feature A and a glob in feature B share any path that BOTH would minimatch (e.g. A=`apps/web/src/**` and B=`apps/web/src/components/**` — A's `**` matches everything under B's path, so they overlap on anything B touches).
   - **Tier 3 — glob ⇄ literal.** If a glob in feature A minimatches a literal entry in feature B (e.g. A=`apps/api/src/plugins/**` and B=`apps/api/src/plugins/db.ts` — both target the same file).

3. **Auto-add `depends_on`** for overlapping features that aren't already linked:
   - If A and B overlap AND neither `A in B.depends_on` nor `B in A.depends_on`: add `B → depends_on: [..., A]` (sequence the higher-numbered feature on the lower-numbered one — stable + arbitrary)
   - Emit `tasks.yaml.warnings[]`: `file-affinity-serialization: feat-A and feat-B both touch {path-glob} — auto-added feat-B depends_on feat-A`

4. **Skip the auto-serialization** for features with the SAME `affects_files[]` glob if both are already in a wave that the user explicitly approved as parallel-safe (e.g., both touch `apps/web/components/{specific-feature}/**` where the paths are disjoint despite the parent glob). Heuristic: if no SHARED leaf path exists despite the glob match, no overlap. (Most common false-positive source.)

5. **MANDATORY sentinel — `file-affinity-no-overlaps` (bug-124).** If the three-tier check ran across all feature-pairs AND found ZERO overlaps, emit exactly one `tasks.yaml.warnings[]` entry: `file-affinity-no-overlaps: ran 3-tier overlap check across N features × P pairs; no shared files detected`. This turns "no `file-affinity-serialization` warnings present" from an AMBIGUOUS signal ("ran clean OR skipped silently") into a load-bearing CLEAN signal. Absence of BOTH `file-affinity-serialization` AND `file-affinity-no-overlaps` after a PM run is now a hard signal that step 4b was skipped (bug-018 failure mode). The orchestrator's tasks.yaml validator (`scripts/validate-tasks-yaml.mjs`) enforces this: when `features.length >= 2` and neither warning is present, exit non-zero with `affects-files-overlap-check-skipped`.

**Example A — kanban-webapp (modify/modify; Tier 1 literal-equal)**:

```yaml
- id: feat-board-core
  affects_files:
    - apps/web/src/store/index.ts # ← shared with settings-data
    - apps/web/src/components/board/**
    - apps/web/app/page.tsx
- id: feat-settings-data
  affects_files:
    - apps/web/src/store/index.ts # ← shared with board-core
    - apps/web/src/components/settings/**
    - apps/web/app/settings/page.tsx
  depends_on: [feat-bootstrap, feat-board-core] # ← auto-added because of store/index.ts
```

**Example B — gotribe-event-calendar (add/add on canonical backend entry; Tier 1 literal-equal; bug-124 empirical)**:

```yaml
- id: feat-tribes-route
  affects_files:
    - apps/api/src/routes/tribes.ts
    - apps/api/src/middleware/current-tribe.ts
    - apps/api/src/server.ts # ← shared with test-seed-routes
- id: feat-test-seed-routes
  affects_files:
    - apps/api/src/routes/test-seed.ts
    - apps/api/src/server.ts # ← shared with tribes-route
    - apps/api/src/plugins/**
  depends_on: [feat-db-schema-seed, feat-tribes-route] # ← auto-added because of server.ts
```

Neither feature exists on master at dispatch time; both backend-builders independently AUTHOR `apps/api/src/server.ts` on disjoint branches. Without the Tier 1 literal-equal serialization, the close-feature merge hits `CONFLICT (add/add)` — which the orchestrator's lockfile-resolver does NOT handle. Empirically: 3 retries → emergency-abort → cascade-failure of dependents.

**Example C — react-next monorepo (Tier 3 glob ⇄ literal)**:

```yaml
- id: feat-db-plugin
  affects_files:
    - apps/api/src/plugins/db.ts # ← matched by feat-plugins's **
- id: feat-plugins-overhaul
  affects_files:
    - apps/api/src/plugins/** # ← matches db.ts
  depends_on: [feat-db-plugin] # ← auto-added because plugins/** ⊇ plugins/db.ts
```

**Limitation**: PM doesn't know the EXACT files agents will touch — it works from task summaries. The heuristic is conservative (over-serializes when uncertain). Phase 3 (architect feature-sliced module structure) is the long-term fix that makes this check a no-op for state modules.

### 4c. Brief-coverage authoring (feat-023)

After step 4b file-affinity is settled and BEFORE writing tasks.yaml in step 5, emit `docs/tasks-coverage.json` mapping every brief capability (from `docs/brief-capabilities.json`) to ≥1 task ID OR an explicit deferral with reason. This is the authoritative coverage claim that the post-stage gate (`scripts/audit-brief-coverage.mjs`) audits. **Silent omissions become impossible** because the audit fails the `/pm` stage when a capability is neither covered nor deferred.

Inputs:

- `docs/brief-capabilities.json` — authored at `/analyze` time; lists every brief §11/§12 capability the project must deliver. Schema: `schemas/brief-capabilities.schema.json`.
- The in-memory `features[].tasks[].id` set you've drafted in steps 2-4.

Algorithm:

1. Read `docs/brief-capabilities.json`. If absent, emit `tasks.yaml.warnings[]: brief-capabilities-missing — pre-feat-023 project; coverage audit will be skipped` and skip this step (legacy behavior). Otherwise:
2. For EACH capability in the catalog:
   - **Find the task(s) that deliver it.** The mapping is heuristic: scan task `summary` + `notes` for keywords from `capability.summary`; check the parent feature's `brief_reference`; if the capability is core, prefer P0 tasks. List ALL tasks that contribute (e.g. one backend + one frontend task may both be required for `cap-12-card-create`).
   - **If you cannot map it to any task**, decide whether to:
     - **Add a task** — preferred when the capability is `core`. Walk back to step 2 and add the missing task to the appropriate feature.
     - **Defer it** — only acceptable when the capability is `optional` / `stretch` OR when the human has explicitly scoped it out. Add to `deferred[]` with a concrete reason.
3. Author the mapping per the schema below.

Schema (Zod mirror: `packages/orchestrator-contracts/src/brief-coverage.ts`; JSON Schema: `schemas/tasks-coverage.schema.json`):

```json
{
  "version": "1.0",
  "covers": {
    "cap-12-card-create": ["task-board-core-card-create"],
    "cap-12-card-edit-inline": ["task-board-core-inline-card-edit"],
    "cap-12-column-rename": ["task-board-core-column-rename"]
  },
  "deferred": [
    {
      "capability": "cap-11.4-help-route",
      "reason": "MVP scope: brief §11.4 marked optional; user can re-add post-launch",
      "approvedBy": "pm-agent-decision"
    }
  ]
}
```

Authoring rules:

- `covers[<capability-id>]` MUST be an array with ≥1 entry. Empty arrays are rejected.
- Every task ID in `covers` MUST also exist in `tasks.yaml` (cross-checked by the audit; dangling refs are reported as `typoErrors`).
- `deferred[].approvedBy = "pm-agent-decision"` when YOU decide to defer; use `"human:<name>"` when honoring a human-scoped deferral from the brief.
- **Core deferrals require `coverage-warning`**: if you defer a capability with `category: "core"`, ALSO emit a `tasks.yaml.warnings[]` entry: `coverage-warning: deferred core capability cap-X — reason`. The orchestrator surfaces these to the gate-4 sign-off file's `coverageWarnings[]` block so the human sees them before greenlighting Mode B.

After authoring, the orchestrator (post-step) runs `node scripts/audit-brief-coverage.mjs <projectRoot>` automatically and fails the `/pm` stage on `uncovered.length > 0` or `typoErrors.length > 0`. You don't need to invoke the audit yourself — but you can preview-run it locally to verify your mapping before returning.

### 4d. LAYOUT MANDATE injection for page-rendering tasks (feat-051)

After 4c brief-coverage settles and BEFORE step 5 writes tasks.yaml, inject the **LAYOUT MANDATE** boilerplate into `task.notes` for every web-frontend task that renders an app page. This is **NON-NEGOTIABLE** when the task is page-rendering — without it, builders systematically strip `<AppShell>` and the project ships 22+ shell-stripping bugs.

**Empirical evidence (the bug this step prevents)**: finance-track-01 2026-05-05 verifier surfaced 22 `visual-parity / shell-stripping` P0 bugs — every page rendered as a stand-alone island instead of wrapping in `<AppShell sidebar=... header=...>`. 22 different web-frontend-builder dispatches across 22 feature worktrees independently chose NOT to wrap. The stack-skill (`react-next/SKILL.md` lines 195-200) HAS the mandate, but PM's task-proximal `notes` overrule stack-skill conventions when both are visible to the builder. The fix lives at PM, not the stack-skill.

**Detection rule** — inject the mandate when ALL of these are true:

1. `task.agent === "web-frontend-builder"` (or `mobile-frontend-builder` — mobile gets a stack-aware variant; see below)
2. `task.affects_files[]` contains a glob that matches `apps/web/app/**/page.tsx` (Next.js App Router) OR `apps/web/src/pages/**/*.tsx` (Vite/Pages Router) OR mobile-equivalent screen files
3. `task.screens[]` is non-empty (the task renders ≥1 designed screen)

**Mandate content (react-next stack — v1)** — append to `task.notes` (preserve existing notes; separate with a blank line if notes already contain content):

```
LAYOUT MANDATE (per react-next SKILL.md §AppShell wrapping):
the rendered tree MUST wrap in the layout primitive the matching mockup
uses — typically `<AppShell sidebar={<Sidebar>…</Sidebar>} header={<TopBar>…</TopBar>}>`
imported from @repo/ui-kit. Mockup at docs/screens/webapp/<screen-id>.html
shows the exact composition. Do NOT replace this with a custom nav
implementation — the AppShell primitive is the binding contract per
stylesheet §9e + per-feature parity-verify enforcement.
```

Where `<screen-id>` is `task.screens[0]` (the primary screen this task renders). When the task renders multiple screens, list them all: `Mockup at docs/screens/webapp/<screen-1>.html (and <screen-2>.html, ...)`.

**Stack-aware variants (read `architecture.yaml.tooling.stack.web_framework` and `mobile_framework`)**:

- `react-next` → emit the mandate above (v1; shipped).
- `react-vite` → identical mandate (`@repo/ui-kit` AppShell primitive is stack-agnostic; same import path).
- `svelte-kit` → adapt: replace `<AppShell sidebar={...} header={...}>` with `<AppShell sidebar header>...</AppShell>` (Svelte slot syntax).
- `expo` (mobile) → different primitive — replace the AppShell sentence with: `the rendered tree MUST be wrapped in NavigationContainer + the screen-stack primitive defined in @repo/ui-kit/mobile/Shell. Do NOT replace this with custom navigation.`
- Any other stack → emit a `tasks.yaml.warnings[]` entry: `feat-051-layout-mandate-skipped: stack <X> has no documented layout primitive — investigate before resuming` AND skip the injection (don't emit a generic mandate that may not match the kit).

**Backend / tester / reviewer / devops tasks** — DO NOT inject the mandate. The detection rule's `agent === web-frontend-builder` (or mobile equivalent) gate ensures this; non-page-rendering web-frontend tasks (e.g. a task that only edits `apps/web/src/lib/utils.ts`) ALSO don't get the mandate because rule 2 fails.

**Idempotence**: when re-running PM (e.g. after a kit-change-request that triggers regeneration), check if `task.notes` already contains the literal string `LAYOUT MANDATE` — if so, skip the injection. The mandate text is byte-stable across stack-variants of the same stack.

### 5. Write + validate

- Serialize with js-yaml (`noRefs: true, lineWidth: 120`) to `docs/tasks.yaml`.
- Run `node scripts/validate-tasks-yaml.mjs docs/tasks.yaml`. Must exit 0.
- On schema validation failure: retry steps 2-5 up to 3 times with the validation error as context. After 3 failures: abort with the error messages.

### 6. Self-verify

1. Schema validation passed.
2. Cross-field invariants (1-4 above) all hold.
3. No zero-task features.
4. Every feature's worktree + branch name follows the `feat-{slug}` / `feat/{slug}` convention.
5. **Per-package tsconfig completeness (bug-119).** For each feature, grep `affects_files[]` for every distinct `packages/<name>/` prefix. Assert both `packages/<name>/tsconfig.json` and `packages/<name>/package.json` appear as literal entries. If a prefix appears (via any glob OR via `@repo/<name>` in task summaries) without both companions, abort with `affects-files-missing-package-tsconfig: feat-X claims packages/<name>/ but doesn't list tsconfig.json` — fix step 4b authoring + retry. This invariant is load-bearing: missing per-package tsconfig.json silently triggers the workspace-recursive-typecheck-jsx-cascade failure (TS17004 across every `.tsx` reachable) that motivated bug-119.

6. **Affects-files overlap mechanical audit (bug-006 — MANDATORY).** Invoke from the project cwd AFTER tasks.yaml is written:

   ```bash
   node $FACTORY_ROOT/scripts/audit-tasks-yaml-affects-files-overlap.mjs --strict
   ```

   The audit computes the bug-124 three-tier overlap rule across all feature pairs + cross-checks the `file-affinity-no-overlaps` sentinel against the empirical overlap count.

   **PM cannot return until** the audit exits 0. Two failure modes:
   - **`SENTINEL MISMATCH`**: PM emitted `file-affinity-no-overlaps` in `warnings[]` but real overlaps exist. Fix: add `depends_on` edges to serialize the uncovered overlaps (per audit's recommendations) AND remove the sentinel.
   - **`uncovered overlaps`**: real overlaps not covered by `depends_on` edges. Fix: auto-add edges per the audit's recommendations.

   Empirical motivator (bug-006, 2026-05-30): PM (Claude) emitted `file-affinity-no-overlaps` for test-app's tasks.yaml. Live Mode B then hit merge-conflict-exhaust on 3 of 12 features (feat-design-system, feat-media-cdn, feat-analytics-observability) that shared `apps/web/package.json` + `apps/web/app/layout.tsx` with concurrent features. Audit script catches this class mechanically; PM's prose-only enforcement of bug-018 + bug-124 was insufficient.

   This is the **sibling pattern to bug-002 / bug-003 / bug-004 / bug-005** — consumer-side rules in skill bodies need mechanical audits when shipped, not retroactively.

### 7. Emit PmTasksOutput JSON

```json
{
  "mode": "tasks",
  "success": true,
  "tasksYamlPath": "docs/tasks.yaml",
  "featuresCount": N,
  "tasksCount": M,
  "byAgent": { "backend-builder": n, "web-frontend-builder": n, ... },
  "byPriority": { "P0": n, "P1": n, "P2": n, "P3": n },
  "schemaValidated": true,
  "warnings": [...]
}
```

## mode=kit-change-request steps

### 1. Argument + prereq gate

- Verify `--mode=kit-change-request` AND `--request-file=<path>` are both set. Missing either → abort.
- Read the request file at `--request-file=<path>`. Must exist; must match `docs/screens/kit-change-requests/*.md` shape.
- Read `packages/ui-kit/package.json` + `packages/ui-kit/CHANGELOG.md`.
- DO NOT require `.claude/architecture.yaml` (design-phase detour).

### 2. Parse the request

The request file has frontmatter + a body describing what's needed. Extract:

- Requesting agent (`/screens`, `web-frontend-builder`, `mobile-frontend-builder`)
- Emitting screen ID (from filename or frontmatter)
- Requested component name
- Narrative: why the current kit doesn't cover it

### 3. Compute new kit version

Read `currentKitVersion` from `packages/ui-kit/package.json.version`. Compute `proposedKitVersion` as a minor bump (semver: `X.Y.Z` → `X.(Y+1).0`).

### 4. Author the mini-plan

Write `plans/active/kit-change-request-{id}.md` using `plans/templates/kit-change-request-plan.md` as the shape reference. Frontmatter:

```yaml
---
id: kit-change-request-{id}
type: refactor
status: draft
created: { YYYY-MM-DD }
branch: design/kit-bump-{id}
affected-files:
  - packages/ui-kit/CHANGELOG.md
  - packages/ui-kit/src/primitives/{NewComponent}.tsx   (or patterns/ or layouts/)
  - packages/ui-kit/stories/{NewComponent}.stories.tsx
feature-area: ui-kit
priority: P1
---
```

Body sections:

- `# Kit Change Request — {summary}` — one-line purpose
- `## Missing primitive / pattern / layout` — quote from request file
- `## Proposed addition` — **exactly ONE** component / pattern / layout. Reject a request if it implies multi-primitive bundling.
- `## Kit version bump` — `{current} → {proposed} (minor)`
- `## Consumers requiring regeneration` — list emitting screen + any other screens the PM spots as benefiting (grep screens-manifest.json for related patterns)

### 5. Self-verify

1. Mini-plan frontmatter parses as valid YAML.
2. Body has exactly ONE `## Proposed addition` subsection.
3. Proposed version is a valid semver minor bump over current.

### 6. Emit PmKitChangeRequestOutput JSON

```json
{
  "mode": "kit-change-request",
  "success": true,
  "miniPlanPath": "plans/active/kit-change-request-{id}.md",
  "requestedComponent": "{name}",
  "requestingAgent": "{agent}",
  "emittingScreen": "{screenId or null}",
  "currentKitVersion": "{semver}",
  "proposedKitVersion": "{semver}",
  "warnings": [...]
}
```

## Error paths

- **Missing `--mode`** → abort: "/pm requires --mode=tasks or --mode=kit-change-request".
- **Missing `--request-file` in kit-change-request mode** → abort: "/pm --mode=kit-change-request requires --request-file=<path>".
- **mode=tasks without architecture.yaml** → abort: "/pm --mode=tasks requires /architect to have produced .claude/architecture.yaml".
- **Schema validation fails 3x** → abort with validation errors listed.
- **Cross-field invariant violation can't be auto-fixed** → abort with the specific invariant + offending feature/task ID.
- **Multi-primitive mini-plan requested** → abort: "Kit-change-request must scope exactly one primitive/pattern/layout. Split into multiple requests."

## Integration Points

- **Task 035 orchestrator** reads tasks.yaml at Mode A → Mode B transition via `TasksV2Schema`.
- **Task 036 kit-change-request detour** (in `orchestrator/kit-change-request-detour.ts`) calls this skill via `invokePMKitChangeRequest` with `--mode=kit-change-request --request-file=<path>`.
- **Builders (028/029/030)** read their assigned tasks; resolve `integration_ref` to fetch vendor specifics from architecture.yaml.
- **Tester (031) + Reviewer (032)** placed last in `agent_sequence[]` by convention.

## Auto-run chain (ADR-005)

`/pm --mode=tasks` is an operator-invokable parent command. Per ADR-005, after this skill's primary work completes (`docs/tasks.yaml` v2 with features[] / agent_sequence[] / task graph), it **MUST automatically invoke 3 internal child skills in order via the Skill tool** (no internal gates between them; the chain runs end-to-end):

**Children to auto-run (in this order):**

1. **`skills-audit --scope=build`** — via `Skill(skill: "skills-audit", args: "--scope=build")`
   - Reads `.claude/architecture.yaml.tooling.mcp_servers[]` + current `.mcp.json`
   - Audits build-stage MCP availability; flags missing
   - On missing MCPs that the operator should review (e.g. OAuth-required servers), surface in return JSON but proceed to step 2

2. **`register-mcp-servers --scope=build`** — via `Skill(skill: "register-mcp-servers", args: "--scope=build")`
   - Registers missing build-stage MCPs into `.mcp.json` from `mcp-defaults-design.json`-equivalent + `architecture.yaml.tooling.mcp_servers[]`
   - Idempotent
   - On failures (e.g. OAuth needed), surface in return JSON + halt chain so operator can complete the OAuth flow then re-run `/pm` to resume

3. **`git-agent bootstrap`** — via `Skill(skill: "git-agent", args: "--op=bootstrap")`
   - Creates monorepo skeleton: apps/{web,mobile,api,admin}/ stubs + packages/{types,ui-kit,api-client,utils}/ + turbo.json + pnpm-workspace.yaml + `pnpm.onlyBuiltDependencies` gate (bug-153 workaround)
   - Initial commit + tag `mode-a-complete`
   - This is the final Mode A stage; on success, Mode A is complete and `/start-build` (Mode B) can begin

**Idempotency for each child:**

- `skills-audit --scope=build`: re-emits `docs/skills-audit/build.md` if architecture.yaml has changed; otherwise skip
- `register-mcp-servers --scope=build`: no-op if `.mcp.json` already contains every server in architecture.yaml.tooling.mcp_servers[]
- `git-agent bootstrap`: no-op if `apps/web/` already exists AND `git tag mode-a-complete` is set

Pipeline-mode double-invocation safe via the idempotency contracts above.

**Mode B handoff.** After git-agent-bootstrap completes, the entire Mode A pipeline is done. The operator advances to Mode B by invoking `/start-build`. The pm skill's auto-run chain does NOT include `/start-build` — that's a separate operator decision (Mode A → Mode B transition is a hard human boundary per the rebuild design).

## Acceptance criteria

- [ ] `.claude/skills/pm/SKILL.md` exists with frontmatter above
- [ ] Rejects invocations without `--mode=`
- [ ] Rejects `--mode=kit-change-request` without `--request-file=`
- [ ] `--mode=tasks` reads architecture.yaml + requirements.md + flows.md + brief
- [ ] `--mode=tasks` applies feature-grouping heuristic in precedence order
- [ ] `--mode=tasks` enforces 3 cross-field invariants before writing
- [ ] `--mode=tasks` schema-validates output via scripts/validate-tasks-yaml.mjs; retries ≤3x
- [ ] `--mode=tasks` emits warnings for requiredNow integrations lacking P0 task coverage
- [ ] `--mode=kit-change-request` does NOT require architecture.yaml
- [ ] `--mode=kit-change-request` rejects multi-primitive requests
- [ ] Return JSON validates against `PmOutputSchema` (discriminated on mode)
