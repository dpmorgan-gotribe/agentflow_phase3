---
name: mockups
description: Generate N styles × M apps of HTML mockups and an interactive review index for style selection. Writes docs/selected-style.json on single-style runs; defers to HITL gate on multi-style runs.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[archetypes-per-app] [--nanobanana]"
---

# /mockups — Style-selection gate

Second pipeline stage (after `/analyze` + `/skills-audit --scope=design`, before `/stylesheet`). Generates an N-styles × M-apps HTML grid + interactive review index. Humans pick one style; that selection binds every downstream stage.

## Prerequisites

- `/analyze` completed successfully
- `docs/analysis/shared/{styles,assets,inspirations}.md` exist
- `docs/analysis/{platform}/screens.json` per detected platform exists
- `docs/brief-summary.json` exists + lists `detectedPlatforms` (this is M) + `styleCount` (this is N)
- `docs/asset-inventory.json` catalogs user assets
- **Per-style design dials come from `docs/analysis/shared/styles.md`** (refactor-002 Dials block per style). If a style block lacks its Dials field, abort with a refactor-002 compliance error — NO fallback to `architecture.yaml` (which doesn't exist yet at this pipeline position; architect runs post-design per refactor-003).
- `.mcp.json` provisioned with design-stage servers (`icons8`, `unsplash`, `playwright`, `chrome-devtools`, plus `image-generator` when `--flags=nanobanana` is active for the run). Provisioning happens at `/new-project` step 5b from `mcp-defaults-design.json`.

## Inputs (explicit paths)

1. `docs/brief-summary.json` → `detectedPlatforms` (M) + `styleCount` (N)
2. `docs/analysis/shared/styles.md` → N style blocks, each with hex palette, typography, spacing, radius, shadow, named references, dials, characteristics
3. `docs/analysis/shared/assets.md` → per-style font URLs + icon library choice
4. `docs/analysis/shared/inspirations.md` → mood keywords + reference designs
5. `docs/analysis/{platform}/screens.json` → authoritative screen list (NOT `companion/navigation-schema.json`)
6. `docs/asset-inventory.json` → user-supplied logos / colors / fonts / icons / wireframes / brand-guides
7. `docs/brand-extracted.yaml` (optional) → extracted brand-guide PDF content
8. `assets/wireframes/*.{png,jpg,svg}` (optional) → layout blueprints consumed via the ui-designer agent's vision capability

## Arguments — `$ARGUMENTS`

Two positional, both optional:

- **`archetypes-per-app` (integer, default 1)** — how many representative screens per app per style. NOT the number of styles — that's set by `/analyze --style-count=N` and read from `brief-summary.json.styleCount`.
- **`--nanobanana`** (boolean flag) — whether the pipeline run includes `--flags=nanobanana`. The orchestrator propagates this; this skill trusts `.mcp.json` to reflect the correct provisioning.

### `archetypes-per-app` behavior

| Value                        | Mockups generated                                                                                          | Purpose                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `1` (default)                | `N × M × 1` — one archetype per app per style                                                              | Cheapest complete grid for style selection      |
| `C > 1`                      | Up to `N × M × C` — C archetypes per app per style (capped per-app when fewer are available; emit warning) | Richer comparison when styles are close to tied |
| `0` / negative / non-integer | Reject with error: `/mockups expects a positive integer archetypes-per-app or no argument`                 | —                                               |

### Rejected arguments

- **`--style-count` (or `--styleCount`, `--styles`, `-n`)** — REJECT immediately with:
  ```
  /mockups aborted: --style-count is an /analyze argument, not a /mockups one.
  The number of styles (N) is set at analysis time and flows through
  brief-summary.json.styleCount + docs/analysis/shared/styles.md.
  To change N, re-run: /analyze --style-count=<N>
  /mockups will then render exactly what /analyze produced.
  ```
  The `/mockups` skill reads N from `brief-summary.json`; it is NOT a per-invocation parameter.

## Steps

### 1. Parse arguments, load inputs

**Reject unknown / misrouted flags BEFORE loading any input.** If `$ARGUMENTS` contains any of `--style-count`, `--styleCount`, `--styles`, `-n`, abort immediately with the message in the §Rejected arguments block above. These are `/analyze` flags, not `/mockups` flags.

Parse `$ARGUMENTS` into `archetypesPerApp` (positional, default 1) and `nanobananaOn` (flag). Read `brief-summary.json` to get `detectedPlatforms` + `styleCount` (this is the source of truth for N — do NOT accept N from the command line). Load `styles.md`, `assets.md`, `inspirations.md`, each `screens.json`, `asset-inventory.json`, and `brand-extracted.yaml` if present.

### 2. Validate per-style dials AND styles.md ↔ brief-summary consistency

**Consistency check** (refactor-003 — closes silent-drift hole):

Count the number of `## Style N:` blocks in `docs/analysis/shared/styles.md`. Assert it equals `brief-summary.json.styleCount`. If they differ, abort immediately:

```
/mockups aborted: styles.md has {actual} `## Style` blocks but
brief-summary.json says styleCount={expected}. The Analyst's output is out
of sync with what it reported.

Causes:
- styles.md was hand-edited after /analyze ran
- /analyze was interrupted mid-run
- brief-summary.json was hand-edited

Fix: re-run /analyze --style-count={desired N} to regenerate both in sync.
Do NOT hand-patch one side — the downstream /stylesheet and /screens
stages bind to brief-summary.styleCount as ground truth.
```

**Per-style dials validation** (refactor-002):

For each of the N style blocks in `styles.md`, confirm the block has a Dials field with `design_variance`, `motion_intensity`, `visual_density` each as integers in 1–10. If any style is missing dials, abort immediately:

```
/mockups aborted: style-03 in docs/analysis/shared/styles.md is missing its
Dials field (refactor-002 per-style dials). Re-run /analyze with
refactor-002-aligned analyst, or patch the styles.md block by hand, before
/mockups can proceed. Architecture-yaml fallback is not available at this
pipeline position (architect runs post-design per refactor-003).
```

### 3. Pick archetypes per app

For each app in `detectedPlatforms`:

- Read the app's `screens.json`
- Apply the **archetype-selection algorithm** below to pick `archetypesPerApp` screens:
  1. **home / dashboard / landing** — preferred index 0
  2. **list** — screen with `section === "list"` or `"index"`
  3. **detail** — `section === "detail"` or `"show"`
  4. **form** — screen with a form component dominant
  5. **empty-state** — screen metadata marks it as empty-state variant
  6. **error-state** — same pattern
  7. **auth** — login / signup / reset
  8. **settings** — settings page
  9. **notification** / **toast** preview if relevant

- Stop when `archetypesPerApp` reached or list exhausted
- If classification is ambiguous, skip; never duplicate a screen

**Fallback when no canonical home exists** (one-screen admin portals, calculators, kiosks): use the **first screen in `screens.json`** as the representative archetype. Record `archetype: "fallback-first-screen"` in the per-style manifest. Every app contributes at least one mockup regardless of how exotic its inventory is.

If the effective archetype count for an app is `< archetypesPerApp`, cap at what's available and record a warning: `warnings: ["app=mobile has only 4 archetypes; generated 4 instead of 5"]`.

### 4. Re-run idempotency — clean slate

Before generating:

- Remove any existing `docs/mockups/style-{K}/` directories for all `K ∈ [0, styleCount)`
- Remove existing `docs/mockups/index.html` and `docs/mockups/manifest.json`
- **Leave** `docs/mockups/archive/` untouched (that's the HITL gate's working set, populated by task 036 after selection)
- **Leave** any pre-existing `docs/selected-style.json` from a prior gate untouched, UNLESS this is a single-style fast path (N=1), which overwrites it

### 5. Generate mockups — two-pass per style

For each style `K` in `0..N-1`:

#### Pass 1 — HTML with asset markers

Invoke the `ui-designer` agent for each `(app, archetype)` pair under style K. The agent's system prompt already carries the opinionated identity + hard bans + named-references table (task 022). Pass:

- The style's block from `styles.md` (palette, typography, spacing, radius, shadow, dials, references, characteristics)
- The screen spec from `screens.json` (components, icons, flows, navigation)
- The matching wireframe image from `assets/wireframes/` if `asset-inventory.json.wireframes[]` lists one for this screen (agent consumes via vision)
- Mood context from `inspirations.md` (1-2 relevant reference cites)
- Asset-inventory fields for user assets that must be used verbatim
- **Tailwind preview-bootstrap requirement (refactor-007 — load-bearing).** Every emitted mockup HTML MUST include the Tailwind Play CDN `<script>` + an inline `<script>tailwind.config = {...}</script>` block in `<head>`. Without these, any Tailwind utility class the mockup uses (`bg-accent-500`, `font-display`, `rounded-md`, etc.) resolves to nothing and the mockup renders unstyled — a silent failure that anti-slop greps cannot catch. Two acceptable patterns:
  1. **Self-contained mockup** (legacy / pre-`/stylesheet`): the `ui-designer` inlines the script tags + a hand-authored `tailwind.config` mirroring the style's palette directly in `<head>`. Acceptable for `/mockups` runs that fire BEFORE `/stylesheet` has produced the kit.
  2. **Bootstrap-fragment inlined**: when `packages/ui-kit/src/styles/preview-bootstrap.html` exists (post-`/stylesheet`), inline its contents verbatim. Future `/screens` runs use this same fragment — keeping mockups + screens visually identical at preview time.
     In either pattern, the mockup MUST be openable in a browser via `file://` and render with the style's palette + typography + spacing applied. Verify in Pass 2 by spot-checking one rendered file (or via the chrome-devtools MCP if scoped).
- **Theme opt-out attribute on `<html>` (refactor-007.1 — silent-dark-mode-flip guard).** Every mockup's root `<html>` element MUST set `data-theme` to the style's authored mode — `data-theme="light"` for light-default styles (white / off-white surface.base) or `data-theme="dark"` for dark-default styles (near-black surface.base). Without this attribute, the kit's `tokens.css` `prefers-color-scheme: dark` media query auto-flips a light-default mockup to dark colors when the reviewer's OS is in dark mode (and vice-versa) — making the mockup look fundamentally different from the style block the analyst authored. Pin the chosen mode explicitly so reviewers see the same chrome regardless of their OS preference. Example: `<html lang="en" data-theme="light">` for an Editorial-Vercel-style light mockup.
- Instruction to emit ASSET MARKERS where external imagery / fonts / icons belong:
  - `{{FONT:Geist}}` — font family placeholder (resolved to Google Fonts `<link>` in pass 2)
  - `{{ICON:chevron-right}}` — icon placeholder (resolved to inline SVG via Icons8 MCP or user asset)
  - `{{HERO:invoice-empty}}` — hero image placeholder (resolved via Unsplash MCP or `image-generator` when `--nanobanana`)
  - `{{AVATAR:seed-name}}` — avatar placeholder (resolved via `picsum.photos/seed/seed-name/64/64` or `image-generator`)
  - `{{EMPTY:topic-generic}}` — empty-state illustration placeholder (resolved via unDraw vectors or `image-generator`)

Write the HTML to `docs/mockups/style-{K}/{app}/{screen-id}.html` with markers unresolved. **Run the anti-slop self-check** (below) before accepting each Write — regenerate the single mockup once on violation, then proceed with a warning if still violating.

#### Pass 2 — resolve markers to real assets

After all `(app, archetype)` HTML files for style K are written:

1. Grep every written `.html` for marker patterns: `{{FONT:...}}`, `{{ICON:...}}`, `{{HERO:...}}`, `{{AVATAR:...}}`, `{{EMPTY:...}}`
2. Collect the distinct set across this style's mockups (de-dup within style)
3. **Cross-style de-dup**: check `docs/mockups/style-{K'}/manifest.json.assets[]` for all already-processed styles K' < K. If an asset was already fetched (same library + same name), reuse the local copy rather than re-billing the MCP.
4. Fetch missing assets via the hybrid fallback table (§Hybrid Fallback below)
5. Replace markers in each HTML file with resolved content:
   - Fonts → `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` in `<head>`
   - Icons → inline SVG or `<svg>` spritesheet reference
   - Hero → `<img src="...">` with Unsplash credit line in footer if applicable
   - Avatars → `<img src="https://picsum.photos/seed/.../64/64">`
   - Empty-state → inline SVG from unDraw, recolored to the style's primary token

### Hybrid fallback table

For every asset a mockup needs:

| Asset                    | User has                                                                                  | User missing + `--nanobanana` ON                          | User missing + `--nanobanana` OFF                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Logo                     | `assets/logos/*` — reference via `<img src="relative-path">` — NEVER redraw as inline SVG | Generate via `image-generator`, style-matched             | Wordmark rendered in style's display font; no symbolic logo                                         |
| Colors                   | `assets/colors.json` or `brand-extracted.yaml`                                            | Research-derived palette from styles.md (NEVER generated) | Same (palettes are never image-generated)                                                           |
| Fonts                    | `assets/fonts/*.woff2` via `@font-face`                                                   | Google Fonts URL from assets.md                           | Same                                                                                                |
| Icons                    | `assets/icons/*.svg`                                                                      | `icons8` MCP by keyword                                   | Same                                                                                                |
| Hero image               | `assets/images/*`                                                                         | `unsplash` MCP first, `image-generator` only on miss      | `unsplash` MCP → `picsum.photos/seed/{seed}/{w}/{h}` deterministic → CSS-gradient only on full miss |
| Empty-state illustration | `assets/illustrations/*`                                                                  | Generate via `image-generator`                            | unDraw MIT vector set, inline SVG                                                                   |
| Avatars                  | `assets/avatars/*`                                                                        | `image-generator` for diverse placeholder portraits       | `picsum.photos/seed/{word}/64/64` — seeded, deterministic                                           |
| Wireframes               | Read as layout blueprint via vision (agent consumes)                                      | (same — wireframes are user-supplied only)                | (same)                                                                                              |

**Partial-wireframe rule.** Low-fidelity wireframes (sketches, whiteboard photos) contribute ONLY layout structure. Colors / typography / polish come from the style's palette regardless. Record provenance as `hybrid` in the manifest.

### Anti-pattern: CSS tone-blocks as imagery substitute

**This is the #1 cause of mockups shipping with no real imagery.** Subagents often try to be "helpful" by inlining CSS tone blocks (`div { background: #C9432A; aspect-ratio: 4/3 }`) wherever a hero image or case-study thumbnail belongs — skipping the `{{HERO:...}}` marker + Pass 2 resolution entirely. The result: mockups look like placeholders, not real designs.

**Corollary anti-pattern: inline-redrawn user logo.** Subagents commonly try to be "helpful" by redrawing the user's logo as approximate inline SVG (e.g. "a simplified chameleon silhouette in `#6B9B37`"). This is the same failure mode — the rendered mockup doesn't show the user's actual brand mark, just a crude proxy. Hard rule: when `asset-inventory.json.logos` has a file, the mockup MUST reference it via `<img src="{relative-path-to-asset}" alt="..." class="brand-logo">` — NEVER redraw. The relative path from `docs/mockups/style-K/{app}/{screen}.html` back to `assets/logos/file.png` is `../../../../assets/logos/file.png` (four `..` hops: screen → app → style → mockups → docs → project root → assets). Verifier: grep each mockup HTML for `<svg` elements in `class="brand"` / `class="logo-"` / header regions — if found AND user has a logo file, flag as anti-pattern violation.

**Related anti-pattern: duplicating the brand name as text next to the logo.** When a user supplies a logo file, treat the file as the COMPLETE brand lockup. Do NOT add an adjacent `<span>` / `<h1>` rendering the project name as text (e.g. `<img src="logo.png"> <span class="wordmark">gotribe</span>`). If the logo is just a mark (no wordmark baked in), that's a deliberate brand choice — respect it; the user knows their own logo better than the agent does. If the user wants a separate wordmark treatment in the mockup, they'll supply a second asset (e.g. `assets/logos/wordmark.svg`). Subagent prompts MUST instruct: "Render the logo as `<img>` only. Do NOT add text wordmark spans, `<h1>` brand names, or any text rendering of the project name adjacent to the logo." Verifier: grep each mockup for `<span class="[^"]*(?:wordmark|brand-word|logo-word|brand-name)[^"]*"` — if present, flag as anti-pattern violation and remove in cleanup.

**Hard rule for Pass 1 subagent prompts:**

1. For every hero / case-study / testimonial photo position, emit a `{{HERO:seed-name}}` marker. DO NOT inline CSS tone blocks as a permanent substitute.
2. **Exception — the style's `characteristics` field explicitly prefers no imagery.** Example: Style 0 Pentagram-minimal, whose aesthetic IS tone-blocks-as-content. In that case, OMIT the marker entirely — don't emit `{{HERO:...}}` and don't expect Pass 2 to fill one. This is recorded in the per-style manifest as `imageryPolicy: "none"`.
3. **Verifier:** after Pass 1 writes, grep each HTML for `aspect-ratio.*\/.*;\s*background:\s*#` patterns — a CSS tone-block is a 2-decimal-aspect-ratio div with a solid hex bg and no `<img>` child. If found AND the style's imageryPolicy is not `"none"`, flag as an anti-pattern violation and regenerate the single mockup once with the marker rule re-emphasised.
4. Pass 2 then resolves `{{HERO:seed-name}}` via the hybrid fallback table above. With `--nanobanana` off, the chain is Unsplash MCP → picsum seeded → CSS-gradient only if both miss.

Subagents getting this wrong is the default failure mode; explicit prompt-level forbidding is necessary.

### 6. Anti-slop self-check (before each Write)

Before writing any `*.html` file, grep the generated HTML against these banned patterns:

- **Raw hex not on palette**: `/#[0-9a-fA-F]{6}\b/` cross-referenced against the style's palette (styles.md) — flag any hex not on the approved list
- **AI-lila gradients on interactive elements**: `/linear-gradient\([^)]*(?:purple|violet|#8b5cf6|#a855f7|#7c3aed)/i` — allow ONLY if styles.md declares this gradient explicitly for this style
- **Lorem ipsum** anywhere in body copy
- **Cliché copy bigrams**: `/\b(Elevate|Seamless|Unleash|Next-Gen|Empower|Transform your)\b/i`
- **Emoji section headers**: any `<h1>`, `<h2>`, `<h3>` starting with a single emoji followed by text
- **Placeholder leakage**: `TODO`, `[insert X]`, `REPLACE_ME`, `Lorem ipsum`
- **3-col card grid as default**: skipped unless `components` list explicitly requires it
- **Unstyled defaults**: `<button>` / `<input>` elements with no `class` attribute
- **Tailwind preview-bootstrap presence** (refactor-007 — silent-styling-failure guard): `grep -c 'cdn.tailwindcss.com' <file>` MUST return ≥1 AND `grep -c 'tailwind.config' <file>` MUST return ≥1. Without both, every Tailwind class in the mockup resolves to nothing in a browser and the page renders unstyled. The other anti-slop checks pass regardless because they're regex-mechanical — only the bootstrap-presence check catches this category. Use a sibling mockup or `packages/ui-kit/src/styles/preview-bootstrap.html` (when it exists) as the source of truth for the script tags.
- **Theme opt-out attribute on `<html>`** (refactor-007.1 — silent-dark-mode-flip guard): `grep -E '<html[^>]*\sdata-theme="(light|dark)"' <file>` MUST match. Pins the mockup to the style's authored mode and prevents the OS `prefers-color-scheme: dark` media query from auto-flipping the canvas. Light-default styles → `data-theme="light"`; dark-default styles → `data-theme="dark"`.

On any match:

1. Regenerate that one mockup (re-invoke the ui-designer with the violation list quoted in the prompt). Preserve the layout.
2. If the regenerated HTML still violates, emit it anyway and record the residual in `warnings[]` — Layer 6 (032b `/verify-html`) + Layer 7 (025b `/visual-review`) will catch anything that slips through.
3. Regeneration bound: **1 retry per mockup, in-skill.** This is separate from the orchestrator's Layer 5 stage-wide retry.

These checks complement Layer 4 (`.claude/hooks/validate-html-write.sh`) which is framework-level; the in-skill self-check catches issues early so the skill doesn't burn tokens regenerating after a hook rejection.

### 7. Emit per-style artifacts

For each style K, after Pass 2 completes:

**`docs/mockups/style-{K}/dials.yaml`** — seeded from the style's Dials field in `styles.md`:

```yaml
styleId: style-02
styleName: Paper · Editorial
design_variance: 6 # 1=symmetric / 10=experimental
motion_intensity: 2 # 1=static / 10=cinematic
visual_density: 3 # 1=airy / 10=cockpit-dense
lastEditedAt: null
lastEditedBy: null
```

The HITL gate server (task 036) accepts `POST /api/dials/{styleId}` to update these values. The skill only emits the static file.

**`docs/mockups/style-{K}/manifest.json`** — per-mockup provenance ledger:

```json
{
  "version": "1.0",
  "styleId": "style-02",
  "generatedAt": "2026-04-20T15:12:00Z",
  "mockups": [
    {
      "app": "webapp",
      "screen": "home",
      "path": "docs/mockups/style-02/webapp/home.html",
      "archetype": "home",
      "wireframeUsed": null,
      "selfCheckPassed": true
    }
  ],
  "assets": [
    {
      "type": "font",
      "name": "Geist",
      "source": "google-fonts",
      "provenance": "researched"
    },
    {
      "type": "icon",
      "name": "chevron-right",
      "source": "icons8",
      "provenance": "researched"
    },
    {
      "type": "icon",
      "name": "plus",
      "source": "user",
      "provenance": "user",
      "path": "assets/icons/plus.svg"
    },
    {
      "type": "hero",
      "name": "invoice-empty",
      "source": "unsplash",
      "provenance": "stock"
    }
  ],
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 1,
  "imagesVectorFallbackCount": 0
}
```

Provenance enum: `user` / `researched` / `generated` / `hybrid` / `stock` / `vector`.

### 8. Emit top-level rollup

**`docs/mockups/manifest.json`** — flat summary for the review UI + HITL gate + downstream stages:

```json
{
  "version": "1.0",
  "generatedAt": "2026-04-20T15:12:00Z",
  "styleCount": 10,
  "appsCovered": ["webapp", "mobile", "admin"],
  "archetypesPerAppPerStyle": 1,
  "mockupsGenerated": 30,
  "nanobananaUsed": false,
  "styles": [
    {
      "styleId": "style-00",
      "styleName": "Neutral · One blue",
      "paletteSwatch": ["#2563eb", "#18181b", "#f4f4f5"],
      "namedReferences": ["Linear", "Notion", "Vercel"],
      "dials": {
        "design_variance": 4,
        "motion_intensity": 3,
        "visual_density": 6
      },
      "mockupCount": 3,
      "dialsPath": "docs/mockups/style-00/dials.yaml",
      "manifestPath": "docs/mockups/style-00/manifest.json"
    }
  ]
}
```

### 9. Render `docs/mockups/index.html`

Read `.claude/templates/mockups-index-template.html` + replace placeholders:

| Placeholder            | Value                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{{PROJECT_NAME}}`     | from `brief.md` §1                                                                                                                       |
| `{{MANIFEST_JSON}}`    | inlined JSON of all styles (same shape as top-level manifest.json, one entry per (style, app, archetype) cell when archetypesPerApp > 1) |
| `{{NANOBANANA_STATE}}` | `"on"` or `"off"`                                                                                                                        |
| `{{IMAGE_BUDGET}}`     | static ceiling from `models.yaml.stages.mockups.imageGenCallsCap` (orchestrator-resolved) when nanobanana is on; omitted when off        |
| `{{GATE_API_BASE}}`    | base URL for the HITL gate server (e.g., `http://localhost:8733`); orchestrator (task 035) passes this as input at render time           |

Write to `docs/mockups/index.html`. No build step — the template is self-contained HTML + inline CSS/JS.

### 10. Single-style fast path (`styleCount === 1`)

When `docs/brief-summary.json.styleCount === 1` (the analyst produced only one style):

- Generate mockups as above at `docs/mockups/style-00/{app}/{screen}.html`
- Emit `docs/mockups/index.html` as a single-style preview (same template, one row)
- **Auto-write** `docs/selected-style.json`:

```json
{
  "version": "1.0",
  "styleId": "style-00",
  "styleName": "<from styles.md>",
  "selectedAt": "<now>",
  "selectedBy": "auto-single-style",
  "dials": { <from styles.md#style-00> },
  "iconLibrary": "<from assets.md#style-00>",
  "appsCovered": [<detectedPlatforms>],
  "mockupsManifest": "docs/mockups/style-00/manifest.json",
  "stylesSourceRef": "docs/analysis/shared/styles.md#style-00",
  "nanobananaUsed": <bool>
}
```

This bypasses the HITL gate; orchestrator advances directly to `/stylesheet`.

### 11. Multi-style path exit

When `styleCount > 1`, the skill exits **WITHOUT** writing `docs/selected-style.json`. The orchestrator (task 035) then transitions to gate 2 (task 036) which spins the HTTP server + waits for `docs/selected-style.json` to appear via `POST /api/select`.

### 12. Return JSON

Emit to stdout matching `MockupsOutput` (034b):

```json
{
  "success": true,
  "styleCount": 10,
  "appsCovered": ["webapp", "mobile", "admin"],
  "archetypesPerAppPerStyle": 1,
  "mockupsGenerated": 30,
  "mockupsPerStyle": { "style-00": 3, "style-01": 3 },
  "userAssetsUsed": [],
  "iconsFromMCP": 14,
  "imagesFromMCP": 0,
  "hybridWireframeCount": 0,
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 0,
  "imagesVectorFallbackCount": 0,
  "partialAssetRatio": "25/120 fonts+icons; remainder deferred to /stylesheet",
  "selfCheckRegenerations": 2,
  "reviewIndexPath": "docs/mockups/index.html",
  "warnings": []
}
```

## Output contract summary

**Multi-style** (`N > 1`):

- `docs/mockups/style-{K}/{app}/{screen}.html` per style × app × archetype
- `docs/mockups/style-{K}/dials.yaml` per style
- `docs/mockups/style-{K}/manifest.json` per style
- `docs/mockups/index.html` — interactive review grid
- `docs/mockups/manifest.json` — top-level rollup
- **No** `docs/selected-style.json` (gate 2 writes it)
- `docs/mockups/archive/` created empty (gate 2 populates it)

**Single-style** (`N = 1`):

- Same files + `docs/selected-style.json` auto-populated with `selectedBy: "auto-single-style"`

## `--nanobanana` behavior

The flag is propagated by the orchestrator (task 035). This skill only reads whether the `image-generator` MCP is registered in `.mcp.json`:

- **Flag on** — `image-generator` is in scope. Use it per the hybrid fallback table for hero / empty-state / avatar generation when the user has no matching asset.
- **Flag off** — `image-generator` is absent from `.mcp.json` (task 041 filtered it). All image needs fall back to Unsplash MCP + unDraw vectors + `picsum.photos/seed/{word}/w/h`. No image-gen calls happen; no budget is consumed.

The skill does not parse the flag itself; it trusts the MCP registry. It records `nanobananaUsed: <bool>` in every per-style manifest and in the top-level return JSON so downstream stages can audit image provenance.

## Integration Points

- **Task 018** (`/scan-assets`): produces `docs/asset-inventory.json` — prerequisite
- **Task 019** (`/analyze`): produces all `docs/analysis/shared/*` and per-platform files — prerequisite
- **Task 020** (Architect): **no dependency.** Architect runs POST-design per refactor-003; `/mockups` reads `design_dials` from `styles.md` and `icon_library` from `assets.md` (per-style), not from architect output.
- **Task 022** (UI Designer agent): provides the opinionated identity + hard bans + named references. This skill invokes that agent per `(style, app, archetype)` pair in Pass 1.
- **Task 022b** (UI Kit contract): `CONTRACT.md` is NOT yet active (mockups are HTML, not kit-composing code) but the anti-slop rules overlap intentionally — the self-check regex set here mirrors the `no-arbitrary-tailwind` / `no-hex-in-className` enforcement the builders will later apply.
- **Task 024** (`/stylesheet`): reads `docs/selected-style.json` + `docs/mockups/style-{K}/manifest.json` after this skill's gate. De-dupes its full-asset wave against this partial-wave manifest.
- **Task 032b** (`/verify-html`): invoked post-stage by the orchestrator; blocks advance on Layer 6 violations.
- **Task 034** (output contracts): Layer 4 hook validates each HTML Write; the anti-slop grep patterns above pre-empt hook rejections.
- **Task 034b** (schemas): this skill's return JSON matches `MockupsOutput`. `SelectedStyleSchema.selectedBy` must accept `"auto-single-style"` (already wired per refactor-003 34b update).
- **Task 035** (orchestrator): invokes this skill; passes `--nanobanana` flag state + `{{GATE_API_BASE}}`; on multi-style runs transitions to gate 2 after success.
- **Task 036** (HITL gates): runs the backing HTTP server for `/api/dials/*` and `/api/select`; writes `docs/selected-style.json` on selection; archives losing styles to `docs/mockups/archive/`.
- **Task 041** (MCP registration): provisions `icons8`, `unsplash`, `playwright`, `chrome-devtools`, and conditionally `image-generator` at `/new-project` step 5b (refactor-003 `--scope=design` invocation).

## HITL gate backing-server contract (task 036 must honor)

The index.html emitted here expects these endpoints:

- **`POST /api/dials/{styleId}`** — body is a JSON patch of the three dial values. Handler must fsync-write the full updated `dials.yaml` to disk **before** returning 200. Unsaved edits lost on browser close is acceptable — each slider change debounces to ~300ms then POSTs. Return body echoes persisted values.
- **`POST /api/select`** — body is `{ styleId: "style-03" }`. Handler atomically:
  1. Reads current `docs/mockups/style-03/dials.yaml` for final dial values
  2. Writes `docs/selected-style.json` matching `SelectedStyleSchema` (034b, including `iconLibrary` from `assets.md#style-03`)
  3. Moves every other `docs/mockups/style-{K}/` directory (K ≠ 03) to `docs/mockups/archive/style-{K}/`
  4. Returns 200 with the written selected-style payload so the UI can confirm

Server lifecycle: started when orchestrator enters gate 2, killed when `docs/selected-style.json` is written. Port assignment is dynamic; the skill embeds the port into index.html via `{{GATE_API_BASE}}` at render time.

## Partial-asset download discipline

This is the FIRST of two MCP download waves. The boundary between "partial" and "full" is **what HTML is produced at each stage**, not a pre-computed asset list.

- **Scope:** only MCP servers whose `scoped_to[]` includes `ui-designer` in `.mcp.json` (populated from `mcp-defaults-design.json` at `/new-project` step 5b per refactor-003 — **NOT** from `architecture.yaml` which doesn't exist yet), further filtered by `feature_flag`
- **What this wave downloads:** ONLY assets surfaced by Pass 2 — heading/body fonts actually used in the representative mockups, icons actually placed in them, hero/bg images for the ≤2-3 screens that need imagery. By construction a subset of the full kit.
- **Deferred to `/stylesheet`:** every asset referenced by the remaining screens (full icon inventory across all `screens.json`, full font weight range for Storybook, all empty-state illustrations). `/stylesheet` runs its FULL wave against the **winning style's** complete screen list.
- **De-duplication across styles:** before each MCP call, check already-processed styles' `manifest.json.assets[]` — if style-00 downloaded `icon:chevron-right` from Icons8 and style-01 uses the same library, reuse the local copy rather than re-billing the MCP.

## File-based output (CRITICAL)

HTML, JSON, and YAML go to files. Response text contains **ONLY** status + file paths + the return-JSON summary. No HTML in response text. No markdown-wrapped code blocks for generated HTML. Self-verify by reading back files before reporting complete.

## Post-stage verification

After this skill completes, the orchestrator (task 035) invokes `/verify-html` (task 032b) against `docs/mockups/`. On failure, the orchestrator retries this stage with violations injected as feedback (Layer 5, max 3 attempts). `/visual-review` (025b) runs later against `/screens` output, **NOT** against `/mockups` — mockups are throwaway previews, not the final product.

## Error handling

- `brief-summary.json` missing → abort: `/mockups requires /analyze output. Run /analyze first.`
- Any style block in `styles.md` missing its Dials field → abort (see step 2)
- `archetypesPerApp` is 0 / negative / non-integer → reject with usage error
- `--style-count` (or `--styleCount`, `--styles`, `-n`) passed → reject immediately: this is an `/analyze` argument, not a `/mockups` one (see §Rejected arguments)
- `count(## Style blocks in styles.md) !== brief-summary.json.styleCount` → abort with drift message (see step 2 consistency check)
- `.mcp.json` missing a server listed in `mcp-defaults-design.json` → warn but proceed; fallback table handles missing servers gracefully (e.g., Unsplash missing → CSS gradient placeholder)
- Anti-slop self-check exceeds 1 retry → emit with residual warnings, don't block
- Layer 4 hook rejects a Write → counted as anti-slop failure; same retry logic
- Layer 5 stage retry (from orchestrator) → the whole skill re-runs; step 4's idempotency ensures clean state

## Related skills / files

- `.claude/skills/mockups/SKILL.md` — this file
- `.claude/templates/mockups-index-template.html` — review grid + modal viewer template
- `.claude/agents/ui-designer.md` — the agent this skill invokes
- `.claude/templates/ui-kit-contract.md` — kit consumption rules (NOT yet active at mockup stage; mockups are HTML, not kit-composing code — but the anti-slop overlap is intentional)
- `scaffolding/09-034b-output-contract-zod-schemas.md` — `MockupsOutput` + `SelectedStyleSchema` contracts
- `scaffolding/21-035-orchestrator-core.md` — stage invocation + Layer 5 retry logic
- `scaffolding/22-036-hitl-gates.md` — gate 2 HTTP server + `/api/dials` + `/api/select`
- `scaffolding/11-041-mcp-server-registration.md` — `.mcp.json` provisioning (design scope at `/new-project`)
