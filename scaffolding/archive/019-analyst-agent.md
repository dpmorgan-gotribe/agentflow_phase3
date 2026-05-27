---
task-id: "019"
title: "Analyst Agent + /analyze Skill"
status: complete
priority: P2
tier: 5 — Planning Agents
depends-on: ["015", "016", "017", "018", "018c"]
estimated-scope: large
---

# 019: Analyst Agent + /analyze Skill

## Why This Matters

The Analyst is the pipeline's translation layer. Everything downstream — UI
Designer, Architect, PM, Web/Mobile Frontend Builders — reads the Analyst's
structured outputs instead of re-reading the raw brief. The Analyst scope
defines what those downstream agents have to work with.

**Critical design decision (2026-04-18)**: phase 1 AgentFlow's analyst produced
far more than "read the brief, extract requirements". It produced competitive
research, N distinct style options (colors + typography + spacing fully
specified), per-style asset recommendations with Google Fonts / icon-library
URLs, a mood board with design-system references, per-platform user flows
mapped to screens, and per-platform screen catalogs in v3.0 schema format
(every screen with navigation state + components + icons + flows). Without
this, the UI Designer can't produce a comprehensive stylesheet, and the
Mockups stage can't generate screens consistently.

This task rebuilds that scope.

## What This Task Produces

1. Agent definition at `.claude/agents/analyst.md`
2. Skill at `.claude/skills/analyze/SKILL.md`
3. Six sub-skills at `.claude/skills/analyze/` for phase-internal workers
   (see §Skill structure below) — these are called by the main skill
   via the Agent tool for parallel execution

## Scope

### Agent Definition

```yaml
---
name: analyst
description: Analyzes brief.md, user assets, and competitive landscape. Produces research, styles, asset recommendations, mood board, per-platform flows + screens, and requirements. The pipeline's translation layer from brief → everything downstream.
tools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, Agent
model: inherit
maxTurns: 60
effort: max
---
```

System prompt themes (full content in the agent file):

- Senior business analyst + UX researcher. Thorough, structured, sceptical.
- Outputs are read by other agents — format is a contract. Precision required.
- Default to inference with explicit assumptions flagged; escalate with
  `[NEEDS CLARIFICATION]` markers when brief is silent on something
  load-bearing.
- Will orchestrate parallel sub-workers via the Agent tool for phases 3 and 4.

### /analyze Skill — 5 Phases

The skill is orchestrated in 5 phases. Within each phase, workers run in
parallel via the Agent tool where dependencies allow.

#### Phase 1 — Gate + inventory (sequential)

1. `/validate-brief` — abort on failure
2. `/scan-assets` → `docs/asset-inventory.json`
3. **Brand-guide PDF extraction** (new): if
   `assets/brand-guides/*.pdf` exists, read it via vision and extract brand
   fields into `docs/brand-extracted.yaml`:
   - `brand.name`, `brand.voice`, `brand.tone`
   - `typography.heading_name`, `typography.body_name`,
     `typography.mono_name` (family names, not URLs yet)
   - `colors.primary`, `colors.secondary`, `colors.accent`, etc. (as many as
     the PDF specifies — may be partial)
   - `logos.usage_rules[]` (clear-space, minimum-size, background rules)
   - `rules[]` (free-text "do not combine X with Y" kind of rules)
     Downstream (UI Designer via task 022) reads this file — NOT the PDF.

#### Phase 2 — Competitive research (sequential, foundational)

A single worker produces `docs/analysis/shared/competitors.md`. Format
aligned with phase 1 AgentFlow's `analyze-research` skill:

- **App category**: primary + sub-category
- **Competitors**: N = `styleCount - 1` when styleCount > 1, else 1-2
  representative competitors for research context. For each:
  - URL, core features, unique selling points
  - Visual style: primary hex, secondary hex, typography family, density,
    corner-radius style, animation style
  - User flow patterns (onboarding, core actions, monetization)
  - Strengths / weaknesses
- **Industry best practices** for the category
- **UX patterns common in this category**
- **Market gaps** — opportunities
- Uses `WebSearch` + `WebFetch` tools

This feeds phases 3 and 4.

#### Phase 3 — Shared analysis (3 workers, parallel via Agent tool)

Spawn three subagents simultaneously — they are independent and share
`competitors.md` as input.

**Worker A — Styles** produces `docs/analysis/shared/styles.md`:

- N distinct style options (N = `--style-count`, default 1)
- **Style 0** = user's vision from brief (colors from brief, layout
  patterns from wireframes if present, icons from `assets/icons/`)
- **Style 1..N-1** = research-inspired (one per competitor)
- **Per-style fully specified**:
  - 9-token color palette: primary, secondary, accent, background, surface,
    text-primary, text-secondary, error (`#DC2626`), success (`#16A34A`)
  - Typography: heading font family, body font family + 7-step scale
    (12/14/16/20/24/32/48) + Google Fonts URLs for both
  - Spacing: base unit (4px or 8px) + 8-step scale (4/8/12/16/24/32/48/64)
  - Corner radius: none / subtle / rounded / pill — single choice
  - Shadow depth: flat / subtle / raised — single choice
  - Density: compact / comfortable / spacious
  - 3 characteristics (one-liners describing the style's personality)
- **Asset Mode toggle** (via `--use-assets` flag):
  - `standard`: Style 0 uses user assets, 1+ use research-inspired
  - `useAssets`: ALL styles use user's colors/icons; variations are
    typography/spacing only
- Output starts with `<!-- assetMode: standard -->` or
  `<!-- assetMode: useAssets -->` metadata comment

**Worker B — Assets** produces `docs/analysis/shared/assets.md`:

- **Existing user assets inventory** (cross-check with
  `docs/asset-inventory.json` from phase 1)
- **Per-style asset recommendations** (N rows, one per style):
  - Fonts table with usage / family / Google Fonts URL per row
  - Icon library recommendation (Lucide / Heroicons / Phosphor / Feather /
    Tabler) with URL + key icon names needed
  - Color palette as JSON (must match styles.md exactly)
- **Missing assets action list** — what the UI Designer will need to
  acquire during `/mockups` (first batch) and `/stylesheet` (remainder)
- **IMPORTANT**: This worker produces recommendations + URLs ONLY.
  The actual font/icon file downloads are deferred to the UI Designer's
  `/mockups` skill (partial, for the representative set) and `/stylesheet`
  skill (full inventory for approved style).

**Worker C — Inspirations** produces
`docs/analysis/shared/inspirations.md`:

- Mood definition (primary mood, 5+ keywords, explicit "avoid" list)
- 5+ reference designs with real links (Dribbble / Behance / App Store /
  real apps) — each with "what to take" + "relevance" notes
- Design systems to reference (Linear / Stripe / Vercel / Notion / Figma
  / Slack / Discord / Spotify — pick 3-5 closest to the project's tone)
- Visual patterns to apply (table: pattern / where to use / how to adapt)
- Micro-interactions & animation references (loading / transitions /
  feedback / gestures)
- Typography mood examples

#### Phase 4 — Per-platform flows + screens (parallel per platform)

First, **detect platforms** from the brief:

- Read brief.md §2 (Visual Design), §8 (Infrastructure), §11 (Screen
  Catalog), and any `companion/platform-briefs/*.md` if present (phase 1
  supported multi-platform briefs via separate files)
- Detect: `web`, `mobile` (ios/android unified at this stage), `admin`
- Record detected platforms in `docs/brief-summary.json`

Then spawn one subagent PER PLATFORM (parallel via Agent tool). Each
subagent produces three outputs:

**`docs/analysis/{platform}/flows.md`** — user journeys:

- Per-persona flow narratives: "As [persona], I want [outcome],
  navigating: screen-a → screen-b → screen-c"
- Each flow has a `## Flow N: [Name]` heading
- **100% screen coverage requirement**: every screen in the platform's
  section of the brief (or in `companion/navigation-schema.json` if
  provided) MUST appear in ≥1 flow. Orphans auto-grouped into
  "Miscellaneous Flow" with a warning.

**`docs/analysis/{platform}/navigation-schema.md`** — section-level
navigation:

- Header variants per section (minimal / standard / admin / transparent)
- Footer/tab-bar per section (tabs + active tab)
- Sidemenu items per section (items + active section)
- Inherited by every screen in the section unless overridden

**`docs/analysis/{platform}/screens.json`** — v3.0 schema:

```json
{
  "version": "3.0",
  "generatedAt": "ISO-8601",
  "app": {
    "appId": "runclub-mobile",
    "appName": "RunClub",
    "appType": "mobile",
    "layoutSkill": "mobile",
    "defaultNavigation": {
      "header": { "variant": "standard", "actions": ["search", "notifications"] },
      "footer": { "variant": "tab-bar", "tabs": ["feed", "record", "groups", "profile"] },
      "sidemenu": { "visible": false }
    },
    "screens": [
      {
        "id": "feed",
        "file": "feed.html",
        "name": "Group Feed",
        "description": "Primary social feed showing group activity",
        "section": "feed",
        "navigation": {
          "header": { "variant": "standard", "actions": ["search", "notifications"] },
          "footer": { "variant": "tab-bar", "tabs": [...], "activeTab": "feed" },
          "sidemenu": { "visible": false }
        },
        "components": ["header", "bottom-nav", "run-card", "fab"],
        "icons": ["menu", "search", "notifications", "add"],
        "flows": ["daily-check-in", "view-friends-runs"]
      }
    ]
  }
}
```

Every screen MUST have:

- `id`, `file`, `name`, `description`, `section`
- Full `navigation` state (header + footer + sidemenu, matching the
  section's navigation-schema.md unless overridden)
- `components` array (min 2) — names must match primitives in task 024
- `icons` array (min 1)
- `flows` array (min 1) — use `miscellaneous` if not in any named flow

**Coverage validation**: after writing screens.json, verify 100%
coverage against the brief. Emit a `docs/analysis/{platform}/coverage.md`
report:

- Total screens in brief
- Screens extracted
- Coverage percentage
- Orphaned screens (in brief but not in any flow)
- Extra screens (in screens.json but not in brief — usually a bug)

**Large-brief chunking**: if a platform has >150 screens, chunk extraction
by section. Follow the pattern in phase 1's analyze.ts (lines 949-1070 —
extract sections from brief, spawn one worker per section, merge results).

#### Phase 5 — Synthesis + MCP hints (sequential)

1. **`docs/requirements.md`** — human-readable structured doc:
   - Targets (platforms detected)
   - Personas (from §6 + any journey-derived additions from phase 4 flows)
   - Features per target (cross-ref §12)
   - Integrations list (auth, payments, analytics, AI) — identified from
     brief §7/§8/§9 + competitors.md + selected style's icon-library choice
   - Compliance flags (§13/§14)
   - Skills needed (technologies the Skills Agent must source —
     extracted from brief + competitor stacks + style library choices)
   - Open questions: every `[NEEDS CLARIFICATION]` marker accumulated
     across all prior phases, plus gaps the analyst detected on its own

2. **`docs/brief-summary.json`** — compact machine-readable index:

```json
{
  "projectName": "...",
  "platforms": ["web", "mobile"],
  "targets": [{ "platform": "web", "appId": "...", "screenCount": 42 }, ...],
  "personas": [{ "id": "casual-runner", "name": "...", "primaryGoal": "..." }],
  "integrations": ["apple-sign-in", "stripe", "expo-eas-updates"],
  "compliance": ["gdpr", "coppa-under-13-exclusion"],
  "skillsNeeded": ["expo-eas-ota", "neon-rls"],
  "assetMode": "standard",
  "styleCount": 1,
  "openQuestions": ["Testing strategy not specified"],
  "mcpHints": ["icons8", "unsplash", "image-generator"]
}
```

3. **Per-style asset directory scaffolding**:
   - Create `assets/styles/style-0/` through `style-N-1/`
   - Each with `fonts/` + `icons/` subdirs (empty — UI Designer populates)
   - Each with `palette.json` populated from styles.md

### Skill structure

`.claude/skills/analyze/SKILL.md` is the orchestrator. It delegates to
sub-skills (same directory) via the Agent tool for parallelizable work:

```
.claude/skills/analyze/
├── SKILL.md                  # orchestrator — the one /analyze invokes
├── research.md               # competitors.md producer (phase 2)
├── styles.md                 # styles.md producer (phase 3 worker A)
├── assets.md                 # assets.md producer (phase 3 worker B)
├── inspirations.md           # inspirations.md producer (phase 3 worker C)
├── flows.md                  # per-platform flows producer (phase 4)
└── screens.md                # per-platform screens.json producer (phase 4)
```

The sub-skill files are prompt templates — instructions for subagents
spawned by the Agent tool. SKILL.md is what `/analyze` invokes.

### Arguments

- `[--style-count N]` — number of styles to generate (default 1). Phase 1
  convention: N=3 for review/comparison runs, N=1 for production.
- `[--use-assets]` — flag. Switches Asset Mode from `standard` to
  `useAssets`. All styles then use user's colors/icons with variations
  only in typography/spacing.
- `[--platforms web,mobile,admin]` — override platform detection. Rarely
  needed; default is auto-detect from brief.
- `[--skip-research]` — skip phase 2 (useful during development). Produces
  a stub `competitors.md` with a warning.

### Output Contract

All paths relative to project root:

**Required (fail if missing):**

- `docs/asset-inventory.json` (phase 1)
- `docs/analysis/shared/competitors.md` (phase 2, unless `--skip-research`)
- `docs/analysis/shared/styles.md` (phase 3a)
- `docs/analysis/shared/assets.md` (phase 3b)
- `docs/analysis/shared/inspirations.md` (phase 3c)
- For each detected platform:
  - `docs/analysis/{platform}/flows.md`
  - `docs/analysis/{platform}/navigation-schema.md`
  - `docs/analysis/{platform}/screens.json` (v3.0 schema, validates)
  - `docs/analysis/{platform}/coverage.md`
- `docs/requirements.md` (phase 5)
- `docs/brief-summary.json` (phase 5)
- `assets/styles/style-{0..N-1}/` directories with `palette.json`

**Conditional:**

- `docs/brand-extracted.yaml` — only if `assets/brand-guides/*.pdf` existed

**Return JSON:**

```json
{
  "success": true,
  "platforms": ["web", "mobile"],
  "screensByPlatform": { "web": 42, "mobile": 28 },
  "coverageByPlatform": { "web": 100, "mobile": 97 },
  "styleCount": 1,
  "assetMode": "standard",
  "skillsNeeded": [...],
  "mcpHints": [...],
  "openQuestions": [...],
  "warnings": [...]
}
```

### Self-verification

Before reporting complete:

- All required output files exist and are non-empty
- `screens.json` per platform validates against the v3.0 schema
- Coverage is ≥95% per platform (warn <100%, abort <80%)
- No `[NEEDS CLARIFICATION]` markers left unlisted in requirements.md
- `brief-summary.json` is valid JSON

## Acceptance Criteria

- [ ] `.claude/agents/analyst.md` exists with correct frontmatter (Agent tool
      included, maxTurns 60, effort max)
- [ ] `.claude/skills/analyze/SKILL.md` orchestrates 5 phases
- [ ] Six sub-skills exist: research.md, styles.md, assets.md,
      inspirations.md, flows.md, screens.md
- [ ] Phase 3 runs styles+assets+inspirations subagents in PARALLEL via
      the Agent tool
- [ ] Phase 4 runs per-platform subagents in PARALLEL via the Agent tool
- [ ] Asset Mode toggle implemented (`--use-assets` flag propagates to
      styles + assets sub-skills)
- [ ] `--style-count N` argument supported (default 1)
- [ ] Brand-guide PDF extraction produces `docs/brand-extracted.yaml`
      when a PDF is present
- [ ] screens.json per platform validates against v3.0 schema (include
      validator in self-verification)
- [ ] Every screen has components (min 2), icons (min 1), flows (min 1),
      full navigation state
- [ ] 100% screen coverage per platform (warn <100%, abort <80%)
- [ ] Large-brief chunking (>150 screens) implemented per phase-1 pattern
- [ ] `docs/requirements.md` aggregates all `[NEEDS CLARIFICATION]`
      markers into a single Open Questions section
- [ ] `docs/brief-summary.json` schema includes all listed fields
- [ ] `assets/styles/style-{0..N-1}/` scaffolded with `palette.json`
      populated from styles.md (NOT empty placeholder)
- [ ] HITL gate noted: "human reviews analysis outputs before /mockups"

## Downstream Implications

This task's outputs are consumed by:

- **020 Architect** — reads `docs/requirements.md` + `docs/brief-summary.json`
  - `docs/analysis/*/screens.json` (for component inventory when composing
    `architecture.yaml.tooling.required_primitives`) + `docs/brand-extracted.yaml`
  - `docs/analysis/shared/styles.md` (for preliminary MCP server selection
    based on chosen icon library)
- **021 PM** — reads `docs/requirements.md` primarily + `docs/brief-summary.json`
  for machine-readable integration list
- **022 UI Designer agent** — reads `docs/asset-inventory.json` +
  `docs/brand-extracted.yaml` + `docs/analysis/shared/styles.md` +
  `docs/analysis/shared/assets.md` + `docs/analysis/shared/inspirations.md`
  - `docs/analysis/{platform}/screens.json` per target
- **023 /mockups** — reads `docs/analysis/{platform}/screens.json` for
  screen list (NOT `companion/navigation-schema.json` which is a user
  input the analyst consumed upstream) + `styles.md` for per-style
  variants + `assets.md` for what to download (partial, representative
  set only)
- **024 /stylesheet** — reads `docs/selected-style.json` (written by HITL
  approval after /mockups) + the chosen style from `styles.md` +
  `assets.md` for the full font/icon inventory to download
- **025 /screens** — reads `docs/analysis/{platform}/screens.json` per
  target (NOT `companion/navigation-schema.json`) for the complete screen
  list + approved stylesheet output from task 024

## Human Verification

Run `/analyze` on the `runclub` test project (already drafted via
`/draft-brief`). Verify:

1. All required output files are produced
2. `docs/analysis/mobile/screens.json` validates against v3.0 schema
3. Every screen has components/icons/flows populated
4. Coverage reaches 100% (or flags orphans clearly)
5. `docs/analysis/shared/styles.md` has a complete Style 0 spec
6. `docs/analysis/shared/assets.md` lists Google Fonts URLs + icon library
   recommendation
7. `docs/analysis/shared/competitors.md` names 1-2 real competitors with
   actual visual style data
8. `docs/requirements.md` aggregates open questions from all phases
9. Phase 3 subagents ran in parallel (check wall-clock time vs sum of
   sequential times — should be ~1/3 of sequential)
