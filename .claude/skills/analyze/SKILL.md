---
name: analyze
description: First pipeline stage. Analyzes brief.md, user assets, and the competitive landscape. Produces research + N style options + asset recommendations + mood board + per-platform flows + per-platform screens.json + requirements + brief-summary. Orchestrates phase-3 and phase-4 workers in parallel via the Agent tool.
when_to_use: start of every new project after brief.md is validated; re-run when brief changes materially
argument-hint: [--style-count N] [--use-assets] [--platforms webapp,mobile,admin] [--skip-research] [--skip-integrations]
allowed-tools: Read Write Bash Grep Glob WebSearch WebFetch Agent Skill
---

# /analyze — The Analyst Stage

First stage of every pipeline. You produce the artifacts every downstream
agent reads instead of re-reading the brief. See the agent definition at
`.claude/agents/analyst.md` for the role, output discipline, and parallel
orchestration pattern.

## Steps

### 1. Parse arguments

From `$ARGUMENTS` extract (defaults in parens):

- `--style-count N` (1) — number of styles to generate. Integer ≥1. This is the ONLY place N is set for the run — `/mockups` reads it from `brief-summary.json.styleCount` and renders exactly what the Analyst produced. To change N after `/analyze` has run, re-invoke `/analyze --style-count=<new N>`; do NOT pass `--style-count` to `/mockups` (the skill rejects it).
- `--use-assets` (false) — asset-mode flag. Switches from `standard` to
  `useAssets` (all styles use user's colors/icons; variations are
  typography/spacing only).
- `--platforms a,b,c` (auto) — override platform detection. Comma-separated
  list. If omitted, detect from brief.md §2/§8/§11 and companion files.
- `--skip-research` (false) — skip phase 2 (dev mode). Produces a stub
  `competitors.md` with a warning.
- `--skip-integrations` (false) — skip phase 2.5 (dev mode). Produces a
  stub `integrations-options.md` with a warning. Downstream architect
  stage will then work from brief alone to decide vendors.

Validate:

- `--style-count` must be a positive integer. Reject otherwise with exit
  error.
- `--use-assets` requires user to have at least `assets/logos/` OR
  `assets/icons/` OR `assets/colors.json`. If none, warn: "--use-assets
  was requested but no user assets present; falling back to standard mode."

### 2. Phase 1 — Gate + inventory (sequential)

Run in order, abort on first failure:

**2a. Validate the brief.** Invoke the `/validate-brief` skill. If it
reports errors, abort: `Analysis aborted: brief.md failed validation. Fix
and rerun.`

**2b. Scan user assets.** Invoke `/scan-assets`. This produces
`docs/asset-inventory.json`. You need it for phase 3 workers.

**2c. Brand-guide PDF extraction (conditional).** If
`assets/brand-guides/*.pdf` exists, extract via vision into
`docs/brand-extracted.yaml` with these keys:

```yaml
brand:
  name: "..."
  voice: "..."
  tone: "..."
typography:
  heading_name: "..."
  body_name: "..."
  mono_name: "..." # optional
colors:
  primary: "#XXXXXX"
  secondary: "#XXXXXX"
  # ...any others the PDF specifies
logos:
  usage_rules:
    - "clear-space: 1x logo height on all sides"
    - "minimum-size: 80px wide"
rules:
  - "never combine primary with accent on same surface"
  - "..."
```

Fields the PDF doesn't specify: omit. Don't fabricate.

### 3. Phase 2 — Competitive research (sequential)

If `--skip-research`: write a stub `docs/analysis/shared/competitors.md`:

```markdown
# Competitive Research

<!-- NEEDS CLARIFICATION: competitive research skipped via --skip-research.
     Downstream styles will use brief-only assumptions. -->
```

Otherwise: invoke a single sub-worker using the `research.md` sub-skill.

**Construct the worker prompt:**

1. Read `.claude/skills/analyze/research.md`
2. Read `brief.md` (full)
3. Read `docs/asset-inventory.json` (for wireframe context)

Invoke the Agent tool with:

- `subagent_type: analyst`
- `description: "Competitive research"`
- `prompt`: the research.md content + the brief.md content + style count
  context ("Research N−1 competitors; N=$styleCount")

The worker returns markdown. Write its output to
`docs/analysis/shared/competitors.md`.

### 3.5 Phase 2.5 — Integrations research (sequential, single worker)

Research-only. Produces `docs/analysis/shared/integrations-options.md` —
a menu of 2–3 vendor candidates per integration category the project
needs. The architect (task 020, post-design) reads this file and picks
one per slot. This phase does NOT pick vendors.

If `--skip-integrations`: write a stub
`docs/analysis/shared/integrations-options.md`:

```markdown
# Integration Options — Research Menu

<!-- NEEDS CLARIFICATION: integrations research skipped via --skip-integrations.
     /architect will fall back to brief-only vendor picks. -->
```

Record `integrationsResearched: 0` in the return JSON.

Otherwise: invoke a single sub-worker using the `integrations.md` sub-skill.

**Construct the worker prompt:**

1. Read `.claude/skills/analyze/integrations.md` (sub-skill spec)
2. Read `brief.md` (full) — focus on §7.3, §8, §12, §13, §14
3. Read `docs/analysis/shared/competitors.md` (phase 2 output — reveals
   vendor picks competitors use that the brief may not name)
4. Read `docs/asset-inventory.json` (sometimes hints at assumed stack)

Invoke the Agent tool with:

- `subagent_type: analyst`
- `description: "Integrations research"`
- `prompt`: the integrations.md content + brief.md excerpts + competitors.md

The worker returns markdown + a structured trailer reporting the category
count:

```
<!-- integrationsResearched: N -->
```

Parse N from the trailer (or count `^## Category:` headings if missing)
and record it for the stage-return JSON. Write the body to
`docs/analysis/shared/integrations-options.md`.

Budget note: ~$0.30–0.80 per run (WebSearch + WebFetch heavy). Tracked by
orchestrator (036) against the analyze-stage budget cap.

### 4. Phase 3 — Shared analysis (3 workers IN PARALLEL)

Prepare three Agent calls to run concurrently. Compose each prompt from
the matching sub-skill file plus shared context.

**Shared context** for all three workers:

- `brief.md` content
- `docs/asset-inventory.json`
- `docs/brand-extracted.yaml` if present
- `docs/analysis/shared/competitors.md` (just produced)
- `$styleCount`, `$assetMode` (standard | useAssets)

**Worker A — Styles:**

- Sub-skill: `.claude/skills/analyze/styles.md`
- Output target: `docs/analysis/shared/styles.md`
- First line MUST be `<!-- assetMode: standard -->` or
  `<!-- assetMode: useAssets -->` depending on the flag.

**Worker B — Assets:**

- Sub-skill: `.claude/skills/analyze/assets.md`
- Output target: `docs/analysis/shared/assets.md`
- This worker recommends URLs only — it does NOT download anything.

**Worker C — Inspirations:**

- Sub-skill: `.claude/skills/analyze/inspirations.md`
- Output target: `docs/analysis/shared/inspirations.md`

**Launch all three in a single message with three Agent tool calls.** They
run concurrently. Write each result to its target file. If any worker
fails, report which one and continue with the others (don't abort the
whole phase for one failure).

### 5. Phase 4 — Per-platform analysis (N workers IN PARALLEL)

**5a. Detect platforms.** Unless `--platforms` was supplied, detect from:

- brief.md §2 mentions "mobile" / "web" / "admin" → platform candidates
- brief.md §8 infrastructure mentions specific frameworks (Expo, Next.js,
  Electron) → platform candidates
- brief.md §11 screen catalog section names starting with `admin-`,
  `mobile-`, `web-` → platform candidates
- `companion/platform-briefs/*.md` files if present (phase 1 pattern for
  multi-platform briefs)

**Canonicalize to:** `webapp` | `mobile` | `admin` | `desktop`. If
nothing detected, default to `webapp`.

Users commonly write `"web"` in their brief — that's a detection signal,
not the canonical name. The analyst emits `webapp` in all outputs
(`detectedPlatforms`, file paths like `docs/analysis/webapp/...`, screens
manifest `appType`). This matches `PlatformId` from
`@repo/orchestrator-contracts` (see 034b's `common.ts`). Build-time
directory targets (`apps/web/`) are a separate Target enum derived later
by the architect (020) via `platformIdToTarget()`.

**Argument validation.** If `--platforms` is supplied, each value MUST
match `PlatformId` (`webapp | mobile | admin | desktop`). If a user
supplies `web`, reject with:
`"--platforms: 'web' is not canonical. Use 'webapp' (PlatformId). See 034b common.ts."`

**5b. Read the brief slice per platform.** For each platform, identify
which section of the brief (or which companion file) describes that
platform's screens. If multiple platforms share one brief, extract the
relevant portions.

**5c. Spawn one subagent per platform.** Compose each prompt from both
`flows.md` AND `screens.md` sub-skills — the same worker produces both
outputs for the platform so coverage tracking stays consistent.

**Prompt composition:**

```
Read .claude/skills/analyze/flows.md
Read .claude/skills/analyze/screens.md
Brief slice for platform: {platform-specific content}
Competitors: {competitors.md content, for flow-pattern reference}
companion/navigation-schema.json (if present — this is user-supplied
  structural input): {content}

Produce:
  A) docs/analysis/{platform}/flows.md (per flows.md sub-skill)
  B) docs/analysis/{platform}/navigation-schema.md (section-level nav)
  C) docs/analysis/{platform}/screens.json (per screens.md sub-skill,
     v3.0 schema)

100% screen coverage required. Every screen in the brief slice must
appear in at least one flow. Validate screens.json against
schemas/screens.schema.json before returning.
```

**Launch all N platform workers in a single message.** Wait for all to
complete. Write each output set.

**5d. Coverage validation.** For each platform, compute and write
`docs/analysis/{platform}/coverage.md`:

```markdown
# Coverage Report — {platform}

- Screens in brief: {N}
- Screens extracted: {M}
- Coverage: {M/N \* 100}%

## Orphaned (in brief, not in any flow)

- {screen-id}

## Extras (in screens.json, not in brief — investigate)

- {screen-id}
```

Abort the whole stage if any platform has <80% coverage. Warn on
80-99%. Pass at 100%.

### 6. Phase 5 — Synthesis (sequential)

**6a. Aggregate clarifications.** Walk every artifact produced in phases
1-4. Collect `[NEEDS CLARIFICATION]` / `<!-- NEEDS CLARIFICATION -->`
markers.

**6b. Write `docs/requirements.md`:**

```markdown
# Requirements — {project-name}

## Targets

- {platform}: {screenCount} screens

## Personas

(from brief §6 + any journey-derived additions from phase 4 flows.md)

### {persona-name}

- Primary goal: ...
- Top tasks: ...

## Features by Target

### {platform}

- {feature} (priority: {priority})

## Integrations

See `docs/analysis/shared/integrations-options.md` for the full research
menu. The analyst does NOT pick vendors — that's the architect's job at
post-signoff stage (refactor-003). This section lists the integration
CATEGORIES the project needs, each with a brief signal (what the brief
says / what competitors use / what the feature set implies):

- {category}: {brief signal — e.g. "brief §7.3 names ThirdWeb" or
  "competitor Hylo uses Stripe Connect" or "inferred from §12 email flows"}

## Compliance Flags

- {flag} — {what it requires}

## Skills Needed

(technologies the Skills Agent must source; derived from brief §7/§8/§9 +
competitors' stacks + selected style's icon-library choice)

- {skill-name}: {why needed}

## Open Questions

- {marker collected from phases 1-4}
```

**6b.1 Write `docs/brief-capabilities.json`** (feat-023 — PM-stage coverage assertion).

The same §11/§12 parsing pass that builds requirements.md ALSO emits a machine-readable capability catalog that `/pm` consumes downstream. Every bullet / numbered item in brief §11 (User stories) and §12 (Functional requirements) becomes one entry; the brief itself does not change format.

Schema (validated by `schemas/brief-capabilities.schema.json`; Zod mirror at `packages/orchestrator-contracts/src/brief-coverage.ts`):

```json
{
  "version": "1.0",
  "capabilities": [
    {
      "id": "cap-12-column-rename",
      "source": "brief.md#12",
      "summary": "Users can rename a column inline (click title → input → enter to save)",
      "category": "core"
    },
    {
      "id": "cap-11.4-help-route",
      "source": "brief.md#11.4",
      "summary": "/help route documenting keyboard shortcuts",
      "category": "optional"
    }
  ]
}
```

Authoring rules:

- **`id` pattern**: `cap-{section}-{kebab-slug}`. `{section}` is the brief heading number (e.g. `12`); subsection-scoped capabilities use a decimal (`11.4`). The slug must be globally unique within the file.
- **`source`**: cite back to brief.md with the section anchor (`brief.md#12` or `brief.md#11.4`). PM uses this when surfacing uncovered gaps in error messages.
- **`summary`**: one concise line; quote the brief's wording where possible. This is what the human sees if the capability turns up in the gate-4 sign-off's `coverageWarnings[]` block.
- **`category`**: derive from brief §19 milestone level + brief §11 priority markers:
  - `core` — brief §19 Milestone 1 OR brief §11 marked "MUST" / "P0" / "critical"
  - `optional` — brief §19 Milestone 2+ OR brief §11 marked "SHOULD" / "P1" / "P2"
  - `stretch` — brief §11 marked "MAY" / "nice-to-have" / "P3" / "post-launch"

  When in doubt, choose `core` — over-classification surfaces capabilities to the PM but doesn't fail downstream gates.

**Granularity**: one capability per discrete brief bullet point. "Card editing" is too coarse if the brief lists "card title", "card description", "card priority" as separate bullets — split into three capabilities. (Per plan open question #1: coarsening loses signal; finer granularity requires brief reformat.)

**Validation**: after writing, run `node -e "JSON.parse(require('fs').readFileSync('docs/brief-capabilities.json'))"` and confirm Ajv-validation passes via `/validate-brief` (which validates this companion when present).

**6c. Write `docs/brief-summary.json`** — the compact machine-readable
index:

```json
{
  "projectName": "...",
  "detectedPlatforms": ["webapp", "mobile"],
  "targets": [
    { "platformId": "mobile", "appId": "...", "screenCount": 28 },
    { "platformId": "webapp", "appId": "...", "screenCount": 42 }
  ],
  "personas": [{ "id": "casual-runner", "name": "...", "primaryGoal": "..." }],
  "integrations": ["apple-sign-in", "stripe", "expo-eas-updates"],
  "compliance": ["gdpr", "coppa-under-13-exclusion"],
  "skillsNeeded": ["expo-eas-ota", "neon-rls"],
  "assetMode": "standard",
  "styleCount": 1,
  "openQuestions": ["Testing strategy not specified in brief §17"],
  "mcpHints": ["icons8", "unsplash", "image-generator"]
}
```

**Field naming:** `detectedPlatforms` uses `PlatformId` values (design-side:
`webapp | mobile | admin | desktop`). `targets[].platformId` is the same
enum. The architect (task 020) later reads this and applies
`platformIdToTarget()` to produce build-side `Target` values (`web |
mobile | admin | api`) for the `architecture.yaml.apps.*` block and the
actual `apps/{target}/` directory names. Design-side vs build-side split
is documented in 034b's `common.ts`.

**6d. Scaffold per-style asset directories.** For K in 0..styleCount-1:

```bash
mkdir -p assets/styles/style-K/fonts
mkdir -p assets/styles/style-K/icons
```

Parse `docs/analysis/shared/styles.md` to extract each style's palette.
Write `assets/styles/style-K/palette.json` with the exact colors from
styles.md:

```json
{
  "primary": "#6B9B37",
  "secondary": "#14b8a6",
  "accent": "#f59e0b",
  "background": "#ffffff",
  "surface": "#f9fafb",
  "textPrimary": "#111827",
  "textSecondary": "#6b7280",
  "error": "#DC2626",
  "success": "#16A34A"
}
```

**NOT** a placeholder — real values from the styles.md block.

**6e. Aggregate components across platforms (post-components-gap fix).**

After every phase-4 `screens.json` is written + validated, invoke the components aggregator to produce a cross-platform component catalog that `/stylesheet` consumes at gate 3:

```bash
node scripts/aggregate-components.mjs
```

The script (factory-level, runs inside the project's CWD):

1. Walks every `docs/analysis/{platform}/screens.json`
2. De-dupes the union of `components[]` arrays across platforms
3. Classifies each entry into one of four tiers using the canonical mapping (primitive / pattern / layout / project-specific composition)
4. Counts per-component screen usage + platforms covered
5. Writes `docs/analysis/shared/components.md` with four tier-tables + a coverage summary + a machine-readable JSON trailer (parsed by `/stylesheet`)

This catalog is load-bearing: `/stylesheet` reads `components.md` to guarantee every analyst-identified component gets rendered in `docs/design-system-preview.html` and binds a `componentsApproved[]` list at HITL gate 3. Without it, project-specific compositions (e.g. `wallet-balance`, `vote-button`, `chat-bubble`) leak past the design-system review and end up consumed by `/screens` across hundreds of screens with no prior approval.

If the script reports `success: false` or `uniqueComponents: 0` → abort and report. Likely cause: screens.json files malformed or missing `components[]` arrays.

### 7. Self-verification

Before reporting complete, verify:

- All required output files exist and non-empty:
  - `docs/asset-inventory.json`
  - `docs/analysis/shared/{competitors,integrations-options,styles,assets,inspirations,components}.md`
  - `docs/analysis/{platform}/{flows.md,navigation-schema.md,screens.json,coverage.md}` per detected platform
  - `docs/requirements.md`
  - `docs/brief-summary.json`
  - `docs/brief-capabilities.json` (feat-023 — every brief §11/§12 bullet
    has a corresponding `cap-{section}-{slug}` entry; consumed by `/pm`'s
    coverage step)
  - `assets/styles/style-{0..N-1}/palette.json` with real values
  - `docs/brand-extracted.yaml` if `assets/brand-guides/*.pdf` existed
- Each `screens.json` validates against `schemas/screens.schema.json`
  (run `node scripts/validate-screens.mjs <path>`)
- `docs/brief-summary.json` is valid JSON
- `integrations-options.md` is research-only — grep for forbidden decision
  language ("we recommend", "best choice", "pick X") should return zero
  matches (unless `--skip-integrations` was used, in which case the file
  is a stub)
- Coverage is ≥80% per platform (else abort-level failure)
- All `[NEEDS CLARIFICATION]` markers are listed in requirements.md's
  Open Questions section

### 8. Report

Emit structured JSON to stdout (one line per key for readability):

```json
{
  "success": true,
  "detectedPlatforms": ["webapp", "mobile"],
  "screensByPlatform": { "webapp": 42, "mobile": 28 },
  "coverageByPlatform": { "webapp": 100, "mobile": 97 },
  "styleCount": 1,
  "assetMode": "standard",
  "skillsNeeded": ["expo-eas-ota", "neon-rls"],
  "mcpHints": ["icons8", "unsplash", "image-generator"],
  "openQuestions": 3,
  "integrationsResearched": 9,
  "warnings": ["mobile coverage is 97% — 1 orphaned screen: about.html"]
}
```

This shape is what `AnalyzeOutput` (task 034b) validates. Keys of the
per-platform records use `PlatformId` values. `integrationsResearched`
is the count of `## Category:` headings in `integrations-options.md`
(0 if `--skip-integrations`).

Then append a human-readable summary:

```
Analysis complete for {projectName}.

Artifacts:
  Shared: docs/analysis/shared/{competitors,integrations-options,styles,assets,inspirations}.md
  Per-platform: docs/analysis/{platform}/{flows.md, navigation-schema.md, screens.json, coverage.md}
  Synthesis: docs/requirements.md, docs/brief-summary.json
  Asset directories: assets/styles/style-{0..N-1}/

Coverage:
  webapp: 100% (42 screens)
  mobile: 97% (28 screens) — 1 orphan: about.html

Integrations researched: 9 categories (see integrations-options.md)

Next: HITL gate reviews outputs, then /mockups.
```

## Running costs

Phase 2 (research) + phase 3 (3 parallel) + phase 4 (N parallel per platform)
is roughly the same wall-clock time as 4 sequential workers, but N+4 total
API calls. Default budget (from `~/.claude/models.yaml`): `$3.00` for
`analyze` stage. Tracked by the orchestrator (task 036), not this skill.

## Argument parsing pseudo-code

Bash-friendly argument parsing at the start of the skill:

```bash
# Defaults
STYLE_COUNT=1
ASSET_MODE="standard"
PLATFORMS=""          # empty = auto-detect
SKIP_RESEARCH="false"
SKIP_INTEGRATIONS="false"

# Parse $ARGUMENTS
args="$ARGUMENTS"
while [[ -n "$args" ]]; do
  case "$args" in
    --style-count*)
      STYLE_COUNT=$(echo "$args" | sed -E 's/.*--style-count[= ]+([0-9]+).*/\1/')
      args="${args#*--style-count[= ]*[0-9]*}"
      ;;
    --use-assets*)
      ASSET_MODE="useAssets"
      args="${args#*--use-assets}"
      ;;
    --platforms*)
      PLATFORMS=$(echo "$args" | sed -E 's/.*--platforms[= ]+([a-z,]+).*/\1/')
      args="${args#*--platforms[= ]*[a-z,]*}"
      ;;
    --skip-research*)
      SKIP_RESEARCH="true"
      args="${args#*--skip-research}"
      ;;
    --skip-integrations*)
      SKIP_INTEGRATIONS="true"
      args="${args#*--skip-integrations}"
      ;;
    *)
      args="${args# }"
      [[ "$args" == "" ]] && break
      args="${args#[^ ]*}"
      ;;
  esac
done
```

(You can also parse declaratively in the skill's Read logic — this is a
reference shape.)

## Error handling

- `brief.md` missing → abort: "No brief.md at project root. Run
  `/new-project <name> --proposal '...'` first."
- `/validate-brief` fails → abort with its error output.
- A phase-3 worker fails → log error, continue with remaining workers;
  the failed artifact is listed in warnings.
- A phase-4 platform fails → log error, continue with other platforms;
  coverage-abort rule still applies to completed platforms.
- Schema validation fails on screens.json → retry up to 2× with
  validation errors fed back to the worker. After 3 total attempts,
  abort and report "screens extraction failed for {platform}".

## Related skills / files

- `.claude/skills/analyze/research.md` — phase 2 sub-skill (competitors)
- `.claude/skills/analyze/integrations.md` — phase 2.5 sub-skill (integrations-options research menu)
- `.claude/skills/analyze/styles.md` — phase 3a sub-skill
- `.claude/skills/analyze/assets.md` — phase 3b sub-skill
- `.claude/skills/analyze/inspirations.md` — phase 3c sub-skill
- `.claude/skills/analyze/flows.md` — phase 4 sub-skill (flows half)
- `.claude/skills/analyze/screens.md` — phase 4 sub-skill (screens half)
- `schemas/screens.schema.json` — v3.0 validator for screens.json
- `scripts/validate-screens.mjs` — schema validation runner
- `.claude/agents/analyst.md` — agent definition (inherited by subagents)

## Gate 1 Handoff (post-stage HITL pause)

When `/analyze` completes, the orchestrator pauses for human review of `docs/requirements.md`, `docs/brief-summary.json`, and each platform's `flows.md` / `screens.json` / `coverage.md`. To resume, write ONE of the following directives to **`docs/gate-1-approved.txt`**:

- **`proceed`** — requirements approved; pipeline continues to `/skills-audit --scope=design` + `/mockups`
- **`revise:<note>`** — reject with a note; pipeline halts. Re-run `/analyze --style-count=<N>` (or hand-edit artefacts) then drop a fresh `proceed`.
- **`abort`** — stop the pipeline entirely; no further stages fire.

File-watch is implemented in `orchestrator/src/gate-server-lifecycle.ts`. Directive parsing is strict (trailing whitespace + `#` comments ignored). Writing `proceed` is a one-way commit — analyst outputs become immutable for downstream stages; any post-signoff mutation drifts screens/flows hashes and invalidates gate 4 later.
