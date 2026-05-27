---
task-id: "023"
title: "/mockups Skill — the N × M style-selection gate"
status: pending
priority: P2
tier: 6 — Design Pipeline
depends-on: ["022", "018", "022b"]
estimated-scope: medium
---

# 023: /mockups Skill — the N × M style-selection gate

## What This Task Produces

Skill at `.claude/skills/mockups/SKILL.md`. The second pipeline stage. Generates an `N` styles × `M` detected apps grid of HTML mockups (default: one representative screen per app per style; expandable via argument). Emits an interactive review index with a full-screen modal viewer and per-style dial editor. The HITL selection at this gate writes `docs/selected-style.json` — the binding handshake to every downstream stage (`/stylesheet`, `/screens`, `/visual-review`, 029, 030).

## Why This Scope (per refactor-001)

The prior spec modeled `/mockups` as a per-screen generator with a count argument referring to total screen count. Refactor-001 reframes it as **the style-selection gate** whose primary job is letting a human pick one direction from N by scanning the same representative screens rendered in each style across every detected app. Concrete changes:

- Grid is `N × M` (styles × apps), not `N × S` (styles × total screens)
- Count argument now means "archetypes per app per style," not a total cap
- Per-style `dials.yaml` + `manifest.json` artifacts added
- Interactive review UX with modal viewer (prior art: `plans/active/refactor-001-style-grid-preview.html`)
- `--nanobanana` opt-in flag propagates to asset fetching
- Anti-slop self-check at write time catches AI-lila gradients, lorem ipsum, cliché copy
- Single-style fast path unchanged — auto-writes `docs/selected-style.json`

## Scope

### SKILL.md frontmatter

```yaml
---
name: mockups
description: Generate N styles × M apps of HTML mockups and an interactive review index for style selection. Writes docs/selected-style.json on single-style runs; defers to HITL gate on multi-style runs.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[count] [--nanobanana]"
---
```

### Prerequisites

- `/analyze` completed successfully; `docs/analysis/shared/{styles,assets,inspirations}.md` and `docs/analysis/{platform}/screens.json` exist
- `docs/brief-summary.json` exists and lists detected platforms (M)
- `docs/asset-inventory.json` catalogs user assets (from `/scan-assets`)
- **Per-style `design_dials` come from `docs/analysis/shared/styles.md`** (refactor-002 Dials block). Each mockup card surfaces the dials inline; gate 2's backing server persists user edits to `docs/mockups/{styleId}/dials.yaml` and writes the winning style's final dials into `docs/selected-style.json.dials` at HITL commit. **No architect output is read at this stage** — refactor-003 moved architect post-design, so `architecture.yaml.tooling.design_dials` does not yet exist when `/mockups` runs. (Architect later mirrors `selected-style.json.dials` into `architecture.yaml.tooling.design_dials` for downstream consumers; it does not decide them fresh.)
- Task 041 (MCP registration) has provisioned `icons8`, `unsplash`, `playwright`, `chrome-devtools`, and (when `--nanobanana` is active) `image-generator`. Refactor-003 moves this registration to `/new-project` step 5b (factory-default list); by the time `/mockups` runs these servers are already in `.mcp.json`.

### Inputs (explicit paths)

1. `docs/brief-summary.json` → `detectedPlatforms: ["webapp", "mobile", "admin", ...]` — this is M. Also carries `styleCount: N`.
2. `docs/analysis/shared/styles.md` → N style blocks. Each block carries: hex palette, typography (family + scale), spacing scale, radius scale, shadow definitions, named references, **proposed dials (variance/motion/density)**, characteristics.
3. `docs/analysis/shared/assets.md` → per-style font URLs and icon library choice
4. `docs/analysis/shared/inspirations.md` → mood keywords, reference screenshots
5. `docs/analysis/{platform}/screens.json` (one per detected platform) → authoritative screen list with `section`, `components`, `icons`, `flows`, `navigation` per screen
6. `docs/asset-inventory.json` → user's supplied logos, colors, fonts, wireframes
7. `docs/brand-extracted.yaml` (optional) → extracted brand-guide PDF content
8. `assets/wireframes/*.{png,jpg,svg}` (optional) → layout blueprints, consumed via vision

### Argument handling — `$ARGUMENTS`

Two positional arguments, both optional:

- **`count` (integer, default 1)** — archetypes per app per style
- **`--nanobanana`** — enables the `image-generator` MCP for this run (flag is propagated pipeline-wide by the orchestrator; this skill respects whatever the orchestrator set)

Behavior by `count`:

- **`count=1` (default)** — generate **one** representative archetype per app per style. Total mockups = `N × M`. The archetype is the app's canonical home/landing/dashboard, picked from `screens.json` by the archetype-selection algorithm (below). This is the cheapest complete grid for style selection.
- **`count=C` with C > 1** — generate C archetypes per app per style, greedy-picked by the algorithm. Total mockups = `N × M × C_effective` where `C_effective = min(C, archetypes_available_for_app)`. If an app has fewer than C archetypes available, cap and emit `warnings: ["app=mobile has only 4 archetypes; generated 4 instead of 5"]`.
- **`count=0` or negative** — reject with `"/mockups expects a positive integer count or no argument"`.
- **Non-integer** — reject with the same error.

**Why the shape changed from the prior spec:** the prior `count` was a total-across-all-screens cap used to defer work after initial review. Refactor-001 collapses the "representative preview" and "style selection" into one gate — `count=1` already gives full app-coverage across all styles, which is what's needed to pick. If the user wants more archetypes for a harder pick, they bump `count`.

### Archetype selection algorithm (for `count=C > 1`)

Per app, greedy-pick the first C archetypes available in this order (stop when C reached or list exhausted):

1. **home** / **dashboard** / **landing** — preferred index 0
2. **list** — any screen whose `section` is `list` or `index`
3. **detail** — any screen whose `section` is `detail` or `show`
4. **form** — any screen with a form component dominant
5. **empty-state** — any screen whose metadata marks it as an empty-state variant
6. **error-state** — same
7. **auth** — login/signup/reset
8. **settings** — settings page
9. **notification** / **toast** preview — if relevant

Classification uses `docs/analysis/{platform}/screens.json` fields (`section`, `components`, `flows`) + `docs/analysis/{platform}/flows.md` journey descriptions. If classification is ambiguous, skip that archetype slot; do not duplicate a screen.

**Fallback when index 0 is empty:** if an app has no canonical home/dashboard/landing screen (e.g., a one-screen admin portal, a calculator, a kiosk app), use the **first screen in `screens.json`** as the representative archetype. Record `archetype: "fallback-first-screen"` in the per-style manifest. This guarantees every app contributes at least one mockup to the grid regardless of how exotic its screen inventory is.

### Output directory layout

```
docs/mockups/
├── index.html                          # interactive chooser: N rows (styles) × M cols (apps); each cell is 1..C archetype thumbnails
├── manifest.json                       # top-level rollup (schema below)
├── style-00/
│   ├── dials.yaml                      # editable at gate; default from styles.md
│   ├── manifest.json                   # per-style mockup list + per-asset provenance
│   ├── webapp/home.html
│   ├── mobile/home.html
│   └── admin/dashboard.html
├── style-01/
│   └── ...
├── ...
└── archive/                            # empty folder created by this skill; populated by task 036 after the HITL gate picks a winner. This skill never moves anything into archive/.
```

For `count=C > 1`, each `{app}/` subdirectory contains C HTML files (e.g., `webapp/home.html`, `webapp/list.html`, `webapp/form.html`).

**Re-run idempotency.** Each invocation of `/mockups` first removes any existing `docs/mockups/style-{K}/` directories under the scope of this run (all K in `[0, styleCount)`) and any existing `docs/mockups/{index,manifest}.{html,json}`, then regenerates from scratch. `docs/mockups/archive/` is left untouched across re-runs (it's the HITL gate's working set, not this skill's). Pre-existing `docs/selected-style.json` from a prior gate is also left in place unless the re-run is a single-style fast path (which overwrites it).

### Hybrid fallback table (unchanged from prior spec; §6 L749-760)

For every asset a mockup needs, apply this table. "User has" means the asset appears in `docs/asset-inventory.json`; "User missing" means it does not:

| Asset                    | User has                                           | User missing (`--nanobanana` ON)                              | User missing (`--nanobanana` OFF)                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Logo                     | Use `assets/logos/primary.svg`                     | Generate via `image-generator` MCP, style-matched             | Use wordmark rendered in the style's display font; no symbolic logo |
| Colors                   | Use `assets/colors.json` or `brand-extracted.yaml` | Research-derived palette from styles.md (never generated)     | Same (palette decisions are never image-generated)                  |
| Fonts                    | Reference `assets/fonts/*.woff2` via `@font-face`  | Google Fonts URL from assets.md                               | Same                                                                |
| Icons                    | Use `assets/icons/*.svg`                           | `icons8` MCP by keyword                                       | Same                                                                |
| Hero image               | Use `assets/images/*`                              | `unsplash` MCP first, `image-generator` only on unsplash miss | `unsplash` MCP only; on miss, use a css-gradient placeholder card   |
| Empty-state illustration | Use `assets/illustrations/*`                       | Generate via `image-generator`                                | unDraw MIT vector set; inline SVG                                   |
| Avatars                  | Use `assets/avatars/*`                             | `image-generator` for diverse placeholder portraits           | `picsum.photos/seed/{word}/64/64` — seeded, deterministic           |
| Wireframes               | Read as layout blueprint via vision                | (same — wireframes are user-supplied only)                    | (same)                                                              |

**Partial-wireframe case:** if a wireframe is low-fidelity (sketch, whiteboard photo), extract only layout structure from it; colors/typography/polish come from the style's palette regardless of wireframe fidelity. Record provenance as `hybrid` in the manifest.

### Anti-slop self-check (before each Write)

Before writing any `*.html` file, grep the generated HTML against the banned patterns below. If any match, **regenerate that one mockup** (not the whole set) by re-invoking the ui-designer with the violation list quoted in the prompt — something like:

```
The following banned patterns were detected in your previous output for {screen}:
  - AI-lila gradient on line 42: "linear-gradient(135deg, #a855f7, #3b82f6)"
  - Copy cliché on line 17: "Elevate your workflow"
Regenerate this one mockup without those patterns. Preserve the layout.
```

If the regenerated mockup still violates, emit it with a `warnings[]` entry listing the residual violations but do not block the pipeline — Layer 6 (032b) and Layer 7 (025b) will catch anything that slips through. Regeneration is bounded to **1 retry per mockup**; this is in-skill, separate from the orchestrator's Layer 5 retry of the whole stage.

Banned patterns (implemented as string/regex checks in the skill):

- Raw hex in a style or class attribute that is NOT on the kit's token list: `/#[0-9a-fA-F]{6}\b/` + cross-reference against the style's declared palette (styles.md)
- Gradients on interactive elements: `/linear-gradient\([^)]*(?:purple|violet|#8b5cf6|#a855f7|#7c3aed)/i` — allow the gradient with explicit override only if styles.md declares it
- `Lorem ipsum` anywhere
- Cliché copy bigrams: `/\b(Elevate|Seamless|Unleash|Next-Gen|Empower|Transform your)\b/i`
- Emoji section headers: H1/H2/H3 starting with a single emoji followed by text
- Placeholder text leaking: `TODO`, `[insert X]`, `REPLACE_ME`
- 3-col card grid as default: skipped unless explicitly justified by the screen's `components` list
- `<button>` or `<input>` elements with no class attribute (unstyled defaults)

These checks are in addition to Layer 4 (`.claude/hooks/validate-html-write.sh`) which is framework-level. The self-check catches issues early so the skill doesn't burn tokens regenerating after a hook rejection.

### Per-style `dials.yaml`

At `docs/mockups/style-{K}/dials.yaml`. Seeded from the style's block in `styles.md` (which the Analyst populates per style per refactor-002). If a style block lacks a Dials field, that's a refactor-002 compliance bug — abort with a clear error rather than falling back to architecture.yaml (which doesn't exist yet at this pipeline position per refactor-003).

```yaml
# docs/mockups/style-02/dials.yaml
styleId: style-02
styleName: Paper · Editorial
design_variance: 6 # 1=symmetric / 10=experimental
motion_intensity: 2 # 1=static / 10=cinematic
visual_density: 3 # 1=airy / 10=cockpit-dense
lastEditedAt: null
lastEditedBy: null
```

The HITL gate (task 036) runs a local HTTP endpoint that accepts `POST /api/dials/{styleId}` to update these values. The skill emits the static file; the gate server mutates it. The file's final values at the moment of selection are what `/stylesheet` reads downstream via `docs/selected-style.json.dials`.

### Top-level `manifest.json` (rollup)

At `docs/mockups/manifest.json`. Flat summary consumed by the review UI, task 036 (HITL gate), and downstream stages that want a quick overview without walking per-style files.

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

### Per-style `manifest.json`

At `docs/mockups/style-{K}/manifest.json`. Catalogs every mockup generated for this style and every asset consumed, with provenance. This is the de-duplication source for the `/stylesheet` full-asset-download wave.

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
      "type": "font",
      "name": "Geist Mono",
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

### Review UX — `docs/mockups/index.html`

Generated from a template at `.claude/templates/mockups-index-template.html` (new file, owned by this task). The template is self-contained HTML + inline CSS/JS; no build step. Reference implementation: `plans/active/refactor-001-style-grid-preview.html`.

**Grid layout:** N rows (one per style) × M columns (one per detected app, labeled "Webapp · home" / "Mobile · home" / "Admin · dashboard"). When `count > 1`, each cell is a small carousel of the archetypes for that (style, app) pair.

**Per-row header:** index badge · style name · palette swatch · named references · dials badge · "Choose this style →" button

**Per-cell interaction:** clicking opens a full-screen modal showing the real scrollable mockup (iframe pointing to the HTML file). Modal chrome:

- Viewport switcher: 390×844 / 820×1180 / 1400×900
- Per-style dial editor (three sliders; on change, `POST /api/dials/{styleId}`)
- "Choose this style →" button (on click, `POST /api/select {styleId}` — the HITL gate handles the rest)
- Close (Esc / backdrop click / button)

**Sticky footer** shows `--nanobanana` state (on/off), image-gen budget remaining (if on), and "Waiting for selection…" until chosen.

**Template inputs** (placeholders the skill replaces):

- `{{PROJECT_NAME}}` — from brief.md §1
- `{{MANIFEST_JSON}}` — inlined JSON of all styles with name, refs, palette, dials, and archetype mockup paths (one entry per (style, app, archetype) cell when `count > 1`)
- `{{NANOBANANA_STATE}}` — `"on"` or `"off"`
- `{{IMAGE_BUDGET}}` — budget ceiling when nanobanana is on; shown as a static ceiling in the footer (not real-time remaining). Omitted when off. Per refactor-003 the ceiling comes from `models.yaml.stages.mockups.imageGenCallsCap` (orchestrator-resolved), not `architecture.yaml` (which doesn't exist yet at this pipeline position).
- `{{GATE_API_BASE}}` — base URL for the HITL gate server (e.g., `http://localhost:8733`). Written by the orchestrator (task 035) at render time; the skill receives it as an input argument alongside `--nanobanana`.

The backing HTTP endpoints (`/api/dials/*`, `/api/select`) are the responsibility of task 036 (HITL gates); this skill only emits the static HTML that calls them.

**Backing-server contract (task 036 must honor):**

- `POST /api/dials/{styleId}` — body is a JSON patch of the three dial values. Handler must fsync-write the full updated `dials.yaml` to disk **before** returning 200. Any unsaved edits are lost on browser close — that's acceptable because each slider-change triggers its own POST (debounced ~300ms on the client). Return body echoes the persisted values.
- `POST /api/select` — body is `{ styleId: "style-03" }`. Handler:
  1. Reads the current `docs/mockups/style-03/dials.yaml` for final dial values
  2. Writes `docs/selected-style.json` matching `SelectedStyleSchema` (034b)
  3. Moves every other `docs/mockups/style-{K}/` directory (K ≠ 03) to `docs/mockups/archive/style-{K}/`
  4. Returns 200 with the written `selected-style.json` payload so the UI can confirm
- Server lifecycle: started when the orchestrator enters the mockup gate, killed when `selected-style.json` is written. Port assignment is dynamic; the skill embeds the port into the index.html's JS at render time (placeholder `{{GATE_API_BASE}}`).

### Single-style fast path (`N = 1`)

When `docs/brief-summary.json.styleCount === 1` (i.e., the analyst produced only one style):

- Generate mockups directly at `docs/mockups/style-00/{app}/{screen}.html`
- Emit `docs/mockups/index.html` as a single-style preview grid (same template, N=1 row)
- **Auto-write** `docs/selected-style.json` with `styleId: "style-00"`, dials from `styles.md#style-00`, `selectedBy: "auto-single-style"`
- Skip the HITL gate; orchestrator advances to `/stylesheet` immediately

### `--nanobanana` behavior

The flag is propagated by the orchestrator (task 035) to this skill's invocation. This skill only reads whether the `image-generator` MCP is registered:

- **Flag on** — `image-generator` is in scope; use it per the hybrid fallback table for hero/empty-state/avatar generation
- **Flag off** — `image-generator` is absent from `.mcp.json` (task 041 filtered it); all image needs fall back to Unsplash MCP + unDraw vectors + `picsum.photos`

The skill does not parse the flag itself; it trusts the MCP registry. Record the flag state in every per-style manifest.

### Partial asset download (first of two MCP waves)

This is the FIRST of two MCP download waves (§14 L2231-2237). The boundary between "partial" and "full" is defined by **what HTML is produced at each stage**, not by pre-computed asset lists.

- **Scope:** only MCP servers whose `scoped_to[]` includes `ui-designer` in `.mcp.json` (populated from `mcp-defaults-design.json` at `/new-project` time per refactor-003, NOT from `architecture.yaml` which doesn't exist yet), further filtered by `feature_flag`
- **Order of operations (two-pass per style):**
  1. Generate the `N × M × C` representative mockup HTML using token placeholders / `{{ICON:name}}` / `{{FONT:family}}` markers where external assets would go
  2. Parse each written HTML file for those markers; collect the distinct set of assets needed across this style's mockups
  3. Fetch via the scoped MCP servers, honoring budget + de-dup; write resolved asset references back into the HTML (or emit as CSS `@font-face` + icon `<svg>` spritesheet)
- **What this wave downloads:** ONLY the assets surfaced by step 2 — headings/body fonts actually used in the representative mockups, icons actually placed in them, hero/bg images for the ≤2-3 screens that need imagery. By construction this is a subset of the full kit.
- **What's deferred to `/stylesheet`:** every asset referenced by the remaining screens (full icon inventory across all `screens.json`, full font weight range for the Storybook build, illustrations for all empty states, etc.). `/stylesheet` runs its FULL wave against the **winning style's** full screen list.
- **De-duplication across styles:** before each MCP call, check `docs/mockups/style-{K}/manifest.json.assets[]` across already-processed styles. If style-00 downloaded `icon:chevron-right` from Icons8, style-01 using the same icon library reuses the local copy rather than re-billing the MCP.

### Return JSON

```json
{
  "success": true,
  "styleCount": 10,
  "appsCovered": ["webapp", "mobile", "admin"],
  "archetypesPerAppPerStyle": 1,
  "mockupsGenerated": 30,
  "mockupsPerStyle": {
    "style-00": 3,
    "style-01": 3
  },
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

### Output contract summary

**Multi-style** (N > 1):

- `docs/mockups/style-{K}/{app}/{screen-id}.html` per style K, per app, per archetype
- `docs/mockups/style-{K}/dials.yaml` per style K
- `docs/mockups/style-{K}/manifest.json` per style K
- `docs/mockups/index.html` — interactive N × M review grid with modal viewer
- `docs/mockups/manifest.json` — top-level rollup
- **No** `docs/selected-style.json` — HITL gate (task 036) writes it after selection; this skill exits after rendering

**Single-style** (N = 1):

- Same files as above, plus
- `docs/selected-style.json` auto-populated with `styleId: "style-00"` and dials from `styles.md#style-00`

### File-based output (CRITICAL)

HTML, JSON, and YAML go to files. Response text contains ONLY status + file paths + return JSON summary. No HTML in response.

### Post-stage verification

After the skill completes, the orchestrator (task 035) invokes `/verify-html` (task 032b) against `docs/mockups/`. On failure, the skill retries with violations injected as feedback (§13 Layer 5, max 3 attempts). `/visual-review` (025b) runs later against `/screens` output, NOT against `/mockups` — mockups are throwaway previews, not the final product.

## Integration Points

- **Task 018** (/scan-assets): produces `docs/asset-inventory.json` — prerequisite
- **Task 019** (/analyze): produces all `docs/analysis/shared/*` and per-platform files — prerequisite
- **Task 020** (Architect): no dependency. Architect runs POST-design per refactor-003; /mockups reads design_dials from styles.md and icon_library from assets.md (per-style), not from architect output.
- **Task 022** (UI Designer agent): provides the opinionated identity + hard bans + named references — this skill is invoked by the ui-designer agent
- **Task 022b** (UI Kit contract): the CONTRACT.md is not yet active (mockups are HTML, not kit-composing code) but the anti-slop rules are shared; re-use the anti-slop pattern list
- **Task 024** (/stylesheet): reads `docs/selected-style.json` + `docs/mockups/style-{K}/manifest.json` after this skill's gate; de-dupes assets against the manifest
- **Task 032b** (/verify-html): invoked post-stage; blocks advance on Layer 6 violations
- **Task 034** (output contracts): Layer 4 hook validates each HTML Write; anti-slop grep patterns added here pre-empt hook rejections
- **Task 034b** (schemas): `MockupsOutput` schema extended with the new fields above; `SelectedStyleSchema.selectedBy` must accept the new enum value `"auto-single-style"` in addition to `"human"` — update 034b's schema accordingly
- **Task 035** (orchestrator): invokes this skill; passes `--nanobanana` flag state; on multi-style runs, transitions to HITL gate after success
- **Task 036** (HITL gates): runs the backing HTTP server for `/api/dials/*` and `/api/select`; writes `docs/selected-style.json` on selection; archives losing styles to `docs/mockups/archive/`
- **Task 041** (MCP registration): provisions `icons8`, `unsplash`, and conditionally `image-generator` based on `--nanobanana` flag

## Acceptance Criteria

- [ ] `.claude/skills/mockups/SKILL.md` exists with the frontmatter above
- [ ] `.claude/templates/mockups-index-template.html` exists; self-contained (no build); placeholder slots documented
- [ ] Reads `docs/analysis/{platform}/screens.json` as the primary screen source (NOT `companion/navigation-schema.json`)
- [ ] Reads `docs/analysis/shared/{styles,assets,inspirations}.md` and per-style dial defaults from styles.md
- [ ] Multi-style path: generates `docs/mockups/style-{K}/` subdirectories per style, with per-app subdirectories when M > 1
- [ ] Single-style path auto-writes `docs/selected-style.json` with `selectedBy: "auto-single-style"`
- [ ] Multi-style path exits WITHOUT writing `docs/selected-style.json` (task 036 writes it)
- [ ] `docs/mockups/index.html` rendered from the template is an interactive N × M grid with modal viewer
- [ ] Modal viewer supports the three viewport sizes (390×844, 820×1180, 1400×900) with a switcher
- [ ] Per-style `dials.yaml` emitted with values from `styles.md` style block's Dials field (refactor-002 per-style dials). Missing Dials field = abort with refactor-002 compliance error; no architect fallback since architect runs post-design per refactor-003.
- [ ] Per-style `manifest.json` emitted with `mockups[]` + `assets[]` + image-count fields + `nanobananaUsed`
- [ ] `count=1` default produces N × M × 1 mockups (one archetype per app per style)
- [ ] `count=C` with `C > 1` produces up to N × M × C; caps per app with warning when available archetypes < C
- [ ] Archetype selection algorithm documented and deterministic
- [ ] Invalid count (0, negative, non-integer) rejected with clear error
- [ ] Hybrid fallback table covers all eight asset types (logo / colors / fonts / icons / hero / empty-state / avatars / wireframes)
- [ ] Archetype-selection fallback to "first screen in screens.json" documented when no canonical home/dashboard/landing exists
- [ ] Hybrid-fallback branches differ by `--nanobanana` state (image-generator path vs stock/vector path)
- [ ] Anti-slop self-check runs before each Write and lists banned patterns; catches raw hex / AI-lila / lorem ipsum / copy clichés / unstyled defaults
- [ ] Self-check regeneration is bounded (1 retry, then emit with warning — don't block)
- [ ] Per-mockup provenance tracked in manifest (`user` / `researched` / `generated` / `hybrid` / `stock` / `vector`)
- [ ] Wireframe vision capability invoked when a wireframe exists for the screen (delegates to the ui-designer agent's vision)
- [ ] Asset priority respected (user > researched > generated)
- [ ] Partial asset download scoped — representative set only; remainder deferred to `/stylesheet`
- [ ] `--nanobanana` flag state recorded in every per-style manifest and in the top-level return JSON
- [ ] Return JSON matches the shape in this task (matches `MockupsOutput` in 034b)
- [ ] HITL gate protocol noted: "human picks one style at `docs/mockups/index.html`; task 036 writes `docs/selected-style.json` and archives losers"
- [ ] Post-stage `/verify-html` invocation wired via orchestrator (task 035)
- [ ] File-based output rule present verbatim (HTML/JSON/YAML to files, response = status only)
- [ ] Top-level `docs/mockups/manifest.json` schema documented and matches the rollup example
- [ ] Re-run idempotency documented: prior `style-{K}/` and top-level index/manifest are removed before regenerating; `archive/` is left untouched
- [ ] Partial-asset download operates two-pass (HTML first with markers → asset resolution from written HTML) — not pre-computed
- [ ] HITL gate backing-server contract documented (POST /api/dials fsync, POST /api/select atomic write+archive)
- [ ] `{{GATE_API_BASE}}` template placeholder documented; orchestrator passes the gate server URL at render time
- [ ] In-skill anti-slop regeneration is 1 retry per mockup, bounded; residual violations emitted with `warnings[]`
- [ ] Cross-task note added: 034b's `SelectedStyleSchema.selectedBy` must accept `"auto-single-style"` in addition to `"human"`

## Human Verification

1. Run `/mockups` on a project with 10 styles and 3 detected apps. Does `docs/mockups/` contain exactly 30 HTML files in the expected `style-{K}/{app}/home.html` layout?
2. Open `docs/mockups/index.html`. Does it show a 10-row × 3-column grid with modal viewer working on click?
3. Click "Choose this style" on row 5. Does `docs/selected-style.json` appear with the right `styleId` and dials? Do losing style directories move to `docs/mockups/archive/`?
4. Run `/mockups` with `--nanobanana` absent. Grep all `manifest.json` files: does `nanobananaUsed: false` hold everywhere? Is `imagesGeneratedCount: 0` everywhere?
5. Run `/mockups` with `--nanobanana` on. Does the image-generator MCP get called? Does the return JSON's `imagesGeneratedCount` match the total across per-style manifests?
6. Hand-inject a style block in `styles.md` that would produce `linear-gradient(135deg, #8b5cf6, #3b82f6)` on a CTA. Does the anti-slop self-check catch it before write?
7. Run `/mockups 3` on the same 10-style project. Does each cell become a 3-archetype carousel (home, list, form)?
8. Run on a project with `styleCount: 1`. Is `docs/selected-style.json` auto-written with `selectedBy: "auto-single-style"`? Does the orchestrator skip the gate?
