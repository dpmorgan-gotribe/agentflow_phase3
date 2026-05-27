---
task-id: "024"
title: "/stylesheet Skill — UI Kit Assembly"
status: pending
priority: P2
tier: 6 — Design Pipeline
depends-on: ["023", "022b"]
estimated-scope: medium
---

# 024: /stylesheet Skill — UI Kit Assembly

## What This Task Produces

Skill at `.claude/skills/stylesheet/SKILL.md` — consumes the winning style chosen at the `/mockups` gate and produces the canonical **`@repo/ui-kit`** package: a single versioned front-end toolkit (tokens + globals + primitives + patterns + layouts + illustrations + Storybook) that is the binding source of truth for every downstream screen and build agent.

Skill name stays `/stylesheet` for continuity with prior scaffolding; the output is the full kit, not just a stylesheet.

## Why This Scope (per refactor-001)

The prior spec produced `packages/tokens/` + `packages/ui/primitives/` as separate packages. Refactor-001 collapses them into a single semver'd `@repo/ui-kit` for the three reasons that made the single-kit pattern win:

1. **One public API prevents downstream drift.** Frontend builders consume `@repo/ui-kit` barrel only; no deep imports, no parallel kits, no per-app re-styling.
2. **Tokens are the atomic truth.** Everything above them — stylesheet, primitives, patterns, layouts — is derived or composed. A token change propagates automatically.
3. **Semver communicates breaking changes.** The kit locks at `ui-kit@1.0.0` after this skill; token changes are major bumps, API changes minor, variants/fixes patch.

Concrete changes from prior scaffolding:

- Output is one package: `packages/ui-kit/` matching spec §2 structure
- Canonical source is W3C DTCG `tokens.json` (spec §5 Stage 2 schema); `tokens.css` + `tokens.ts` + `tailwind.config.ts` are generated
- Tiered components: primitives (≥20), patterns (≥12), layouts (≥5); each with CVA variants
- Storybook is **required**, not optional — it's the visual contract builders review
- `--nanobanana` flag gates only the illustrations/ step; everything else is code-gen
- 022b's consumer contract artifacts (ESLint plugin, tsconfig.consumer.json, validate-consumer.ts) are produced here as part of the kit
- Dark mode is implicit via CSS custom properties — no separate "dark" build

## Scope

### SKILL.md frontmatter

```yaml
---
name: stylesheet
description: Assemble the @repo/ui-kit package (tokens + styles + primitives + patterns + layouts + illustrations + Storybook) from the winning style at docs/selected-style.json. Produces the versioned toolkit every downstream agent imports.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[--nanobanana]"
---
```

### Prerequisites

- `/mockups` completed and one of:
  - HITL gate has written `docs/selected-style.json` (multi-style path), or
  - `/mockups` auto-wrote it during the single-style fast path
- `docs/selected-style.json` parses against `SelectedStyleSchema` (task 034b)
- `docs/mockups/style-{K}/manifest.json` exists for the winning style K (used for asset de-dup)
- Task 041 has provisioned the ui-designer-scoped MCP servers; if `--nanobanana` is active, `image-generator` is in scope

### Inputs (ordered by authority)

1. `docs/selected-style.json` → `styleId`, `styleName`, `dials`, `stylesSourceRef`, `nanobananaUsed`, `mockupsManifest`
2. `docs/analysis/shared/styles.md` block at `stylesSourceRef` → **authoritative** source for exact hex palette, typography (family + scale), spacing scale, radius scale, shadow definitions, characteristics. Do not re-derive from mockups when this block is complete; the Analyst already specified the values.
3. `docs/analysis/shared/assets.md` → font URLs + icon library choice for this style
4. `docs/mockups/style-{K}/manifest.json` → already-downloaded asset inventory (de-dup against the full download wave)
5. `docs/brand-extracted.yaml` (optional) → overrides styles.md where it has stronger sources (e.g., exact typography family names from a brand-guide PDF)
6. `docs/selected-style.json.iconLibrary` → which icon library the kit standardizes on. **Refactor-003 change:** this field now lives on the selected-style contract (locked at gate 2), not on `architecture.yaml.tooling.icon_library` — architect runs POST-design in refactor-003, so architecture.yaml doesn't exist when `/stylesheet` runs. Each analyst style block in `assets.md` declares its own icon library (Lucide for minimal, Phosphor for playful, etc.); gate 2's backing server copies the winning style's value into `selected-style.json.iconLibrary`. The kit ships with exactly one library for visual coherence across all apps — the one carried by the winning style. User-supplied icons in `asset-inventory.json.icons[]` still take precedence — they're used verbatim rather than swapped for library equivalents.
7. `docs/asset-inventory.json` → user-supplied fonts/icons/logos take precedence over anything downloaded

**Fallback (gap-fill only):** `node-vibrant` on approved mockups is a last-resort color extractor when `styles.md` AND `brand-extracted.yaml` both have a gap in palette specification. If both are complete, skip node-vibrant entirely.

### Output: `packages/ui-kit/` structure (spec §2)

```
packages/ui-kit/
├── package.json                # name: "@repo/ui-kit", version: "1.0.0"
├── CHANGELOG.md                # seeded with 1.0.0 release notes
├── CONTRACT.md                 # from task 022b — the consumer rules
├── UI-KIT.md                   # living consumption guide
├── tsconfig.json
├── tsconfig.consumer.json      # from 022b — path aliases expose only public barrel
├── src/
│   ├── index.ts                # PUBLIC BARREL — the only import surface for consumers
│   ├── tokens/
│   │   ├── tokens.json         # W3C DTCG — source of truth
│   │   ├── tokens.css          # generated — CSS custom properties
│   │   ├── tokens.ts           # generated — TypeScript types + runtime constants
│   │   └── README.md           # naming conventions
│   ├── styles/
│   │   ├── globals.css         # resets + base typography + imports tokens.css
│   │   ├── fonts.css           # @font-face declarations
│   │   └── tailwind.config.ts  # consumes tokens via CSS vars
│   ├── lib/
│   │   ├── cn.ts               # clsx + twMerge
│   │   ├── cva.ts              # class-variance-authority setup
│   │   └── motion.ts           # shared motion presets from tokens.motion
│   ├── primitives/             # ≥20 atomic, single-concept components
│   │   ├── button/
│   │   │   ├── Button.tsx
│   │   │   ├── Button.variants.ts       # cva-based variant definitions
│   │   │   ├── Button.stories.tsx       # Storybook
│   │   │   └── index.ts
│   │   ├── input/
│   │   ├── textarea/
│   │   ├── select/
│   │   ├── checkbox/
│   │   ├── radio/
│   │   ├── switch/
│   │   ├── slider/
│   │   ├── card/
│   │   ├── dialog/
│   │   ├── drawer/
│   │   ├── popover/
│   │   ├── tooltip/
│   │   ├── toast/
│   │   ├── badge/
│   │   ├── avatar/
│   │   ├── skeleton/
│   │   ├── separator/
│   │   ├── tabs/
│   │   └── accordion/
│   ├── patterns/               # ≥12 composed, context-aware components
│   │   ├── empty-state/
│   │   ├── error-state/
│   │   ├── data-table/
│   │   ├── form-field/          # Label + input + helper + error
│   │   ├── page-header/
│   │   ├── breadcrumbs/
│   │   ├── search-combobox/
│   │   ├── command-palette/
│   │   ├── file-uploader/
│   │   ├── filter-bar/
│   │   ├── pagination/
│   │   └── notification/
│   ├── layouts/                # ≥5 page-level shells
│   │   ├── app-shell/           # Sidebar + header + main
│   │   ├── split-view/          # Master-detail
│   │   ├── focused-task/        # Single column, max-w-prose
│   │   ├── marketing/           # Landing pages
│   │   └── auth/                # Sign-in / sign-up
│   ├── icons/
│   │   ├── generated/           # SVG → React components via svgr
│   │   └── index.ts             # icon barrel
│   └── illustrations/           # optional; gated by --nanobanana
│       ├── empty-states/
│       ├── onboarding/
│       └── hero/
├── eslint-plugin/              # from task 022b
│   ├── index.js
│   └── rules/
│       ├── no-deep-imports.js
│       ├── no-hex-in-className.js
│       ├── no-arbitrary-tailwind.js
│       └── no-inline-style-tokens.js
├── scripts/
│   └── validate-consumer.ts    # from task 022b
├── .storybook/                 # Storybook config
│   ├── main.ts
│   └── preview.ts
└── storybook-static/           # built Storybook output (produced during this skill's run)
```

### Steps

1. **Read the selected style (primary source)**
   - Parse `docs/selected-style.json`; abort if it fails `SelectedStyleSchema` validation
   - Open `docs/analysis/shared/styles.md` and extract the block referenced by `stylesSourceRef`
   - Parse hex palette, typography family + scale, spacing scale, radius scale, shadow definitions, characteristics
   - Read `docs/selected-style.json.dials` — values drive token-scale choices (see "Dial → token mapping" below)

2. **Resolve asset authorities (in order)** — for every token category, check sources in this order and use the first concrete value found:
   - User assets in `docs/asset-inventory.json`
   - `docs/brand-extracted.yaml` (when gaps exist)
   - The styles.md block
   - `node-vibrant` fallback (palette only; rare)

3. **Generate `packages/ui-kit/src/tokens/tokens.json`** — W3C DTCG format. Required top-level keys:
   - `color.neutral.{50..950}` (the neutral ramp chosen for this style)
   - `color.accent.{50..950}` (accent ramp derived from the style's accent)
   - `color.semantic.{success, warning, danger, info}`
   - `color.surface.{base, raised, overlay, inverted}`
   - `color.text.{primary, secondary, tertiary, inverted}`
   - `color.border.{subtle, default, strong}`
   - `typography.fontFamily.{sans, mono, display}`
   - `typography.fontSize.{xs..6xl}`
   - `typography.fontWeight.{regular, medium, semibold, bold}`
   - `typography.lineHeight.{tight, snug, normal, relaxed}`
   - `typography.letterSpacing.{tight, normal, wide}`
   - `spacing.{0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24}`
   - `radius.{none, sm, md, lg, xl, 2xl, full}`
   - `shadow.{xs, sm, md, lg, xl}`
   - `motion.duration.{instant, fast, normal, slow, slower}`
   - `motion.easing.{linear, standard, decel, accel, spring}`
   - `zIndex.{base, dropdown, sticky, overlay, modal, toast, tooltip}`

4. **Generate derivatives:**
   - `tokens.css` — every token as a CSS custom property (`--color-accent-500: #...`), plus a `.dark` override block for dark-mode values (see "Dark-mode derivation" below)
   - `tokens.ts` — typed exports so consumers can `import { tokens } from '@repo/ui-kit'` for runtime reads (escape hatch per 022b)
   - `styles/tailwind.config.ts` — extends theme by referencing CSS variables, so Tailwind utilities resolve to the kit's tokens

   **Dark-mode derivation.** If the selected style's `styles.md` block declares a `darkMode:` subsection, use its hex values directly. If not (the common case — Analyst only specifies light mode), derive dark-mode tokens algorithmically:
   - Neutrals: swap the ramp — `neutral.50` ↔ `neutral.950`, `neutral.100` ↔ `neutral.900`, …, `neutral.400` ↔ `neutral.600`; `neutral.500` stays
   - Surface tokens: `surface.base` = `neutral.950`; `surface.raised` = `neutral.900`; `surface.overlay` = `neutral.800`; `surface.inverted` = `neutral.50`
   - Text tokens: `text.primary` = `neutral.50`; `text.secondary` = `neutral.400`; `text.tertiary` = `neutral.600`; `text.inverted` = `neutral.950`
   - Border tokens: `border.subtle` = `neutral.800`; `border.default` = `neutral.700`; `border.strong` = `neutral.600`
   - Accent + semantic ramps: unchanged (same hues work in both modes; contrast comes from surface/text inversion)
   - Shadows: reduce opacity by ~40% on dark (dark shadows are less visible against dark surfaces)

   This derivation is deterministic and documented in `packages/ui-kit/src/tokens/README.md` so a designer can see why any specific dark value was chosen.

5. **Dial → token mapping** (from `docs/selected-style.json.dials`):
   - `visual_density` ≤ 3 → use the wide end of the spacing scale (default to `spacing.6`/`spacing.8`); line-height `relaxed`
   - `visual_density` ≥ 7 → use the tight end (`spacing.2`/`spacing.3` defaults); line-height `snug`; border-top dividers instead of cards in list patterns
   - `motion_intensity` ≤ 3 → `motion.duration.normal` = `150ms`; no spring easing by default
   - `motion_intensity` ≥ 7 → `motion.duration.normal` = `400ms`; spring easing available as a named preset
   - `design_variance` ≤ 3 → layouts default to symmetric centered compositions
   - `design_variance` ≥ 7 → layouts default to asymmetric compositions; at least one layout pattern uses a broken grid

6. **Generate `packages/ui-kit/src/styles/`** — `globals.css` (resets, focus styles, scrollbar styling, base typography), `fonts.css` (@font-face + variable font loading), `tailwind.config.ts`

7. **Generate `packages/ui-kit/src/lib/`** — `cn.ts` (clsx + twMerge), `cva.ts` (class-variance-authority), `motion.ts` (presets from `tokens.motion`)

8. **Generate primitives** (minimum 20). Each primitive ships `.tsx` + `.variants.ts` + `.stories.tsx` + `index.ts`. Required variants per primitive:

   | Primitive              | Required variants                                                                                                             |
   | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
   | `Button`               | primary, secondary, ghost, destructive + sizes sm/md/lg + icon-only + disabled + loading                                      |
   | `Input`                | text, email, password, number, search + with-icon + with-error + disabled. `id`/`name` + `aria-describedby` for error linkage |
   | `Textarea`             | default, with-error, auto-resize                                                                                              |
   | `Select`               | native + styled (accessible; not a raw `<div>`)                                                                               |
   | `Checkbox`             | default, indeterminate, disabled                                                                                              |
   | `Radio` + `RadioGroup` | default, disabled; keyboard navigation within group                                                                           |
   | `Switch`               | default, disabled                                                                                                             |
   | `Slider`               | default, range, with-value                                                                                                    |
   | `Card`                 | default, interactive (hoverable), elevated; header/body/footer slots                                                          |
   | `Dialog`               | default, fullscreen (mobile); focus trap, Esc-to-close, backdrop                                                              |
   | `Drawer`               | left, right, bottom; mobile-first                                                                                             |
   | `Popover`              | default, anchored                                                                                                             |
   | `Tooltip`              | default, keyboard-accessible                                                                                                  |
   | `Toast`                | info, success, warning, error; auto-dismiss + action slot                                                                     |
   | `Badge`                | neutral, info, success, warning, error                                                                                        |
   | `Avatar`               | image, initials, fallback; size sm/md/lg                                                                                      |
   | `Skeleton`             | text, rect, circle, custom                                                                                                    |
   | `Separator`            | horizontal, vertical                                                                                                          |
   | `Tabs`                 | underline, pills; keyboard navigation                                                                                         |
   | `Accordion`            | single, multiple; animated                                                                                                    |

   Every component requires: default, hover, focus-visible, active, disabled interaction states; accessibility (proper ARIA, keyboard navigation, focus management, contrast AA minimum); dark mode via CSS variables (automatic if tokens.css is correct); responsive behavior.

9. **Generate patterns** (minimum 12). Each pattern composes primitives. Required:

   | Pattern          | What it composes                                                |
   | ---------------- | --------------------------------------------------------------- |
   | `EmptyState`     | Illustration slot + title + description + action Button         |
   | `ErrorState`     | inline + full-page variants; recovery action required           |
   | `DataTable`      | Table primitive + sort + selection + row skeleton states        |
   | `FormField`      | Label + input + helper + error; Zod schema integration optional |
   | `PageHeader`     | Title + description + actions slot; breadcrumb slot             |
   | `Breadcrumbs`    | Separator-driven; accessible                                    |
   | `SearchCombobox` | Input + Popover + keyboard nav                                  |
   | `CommandPalette` | Keyboard-first overlay; inline actions                          |
   | `FileUploader`   | Drag-drop + file list + progress                                |
   | `FilterBar`      | Chip row + "Add filter" + active-filter summary                 |
   | `Pagination`     | numbered + prev/next; responsive                                |
   | `Notification`   | Banner variant; actionable; dismissible                         |

10. **Generate layouts** (minimum 5):

    | Layout        | Shape                                                           |
    | ------------- | --------------------------------------------------------------- |
    | `AppShell`    | Sidebar + top bar + main; responsive (mobile: sidebar → drawer) |
    | `SplitView`   | Master-detail; resizable; mobile stacks                         |
    | `FocusedTask` | Single column, `max-w-prose`; centered reading                  |
    | `Marketing`   | Hero + sections + footer; no chrome                             |
    | `Auth`        | Split-screen or centered card                                   |

11. **`--nanobanana` step (optional, illustrations only)**
    - If flag on: generate hero / empty-state / onboarding illustrations via `image-generator` MCP using the spec §9 prompt patterns, respecting per-server budget from architecture.yaml
    - If flag off: skip generation; provide a small unDraw vector set in `illustrations/` with file headers tokenized on the accent color; EmptyState pattern accepts an `illustration` prop that falls back gracefully when no matching illustration exists
    - Provenance per illustration recorded in `packages/ui-kit/src/illustrations/manifest.json`

12. **Fill in 022b artifacts** (skeletons were created by task 027 at scaffold time):
    - Write real rule implementations into `packages/ui-kit/eslint-plugin/rules/*.js` (the four rules from 022b)
    - Write real `packages/ui-kit/scripts/validate-consumer.ts` (replacing 027's exit-0 stub)
    - Write `packages/ui-kit/tsconfig.consumer.json` exposing only the public barrel
    - **Do NOT touch** `packages/ui-kit/CONTRACT.md` — 027 already wrote it from the factory template at scaffold time; it's project-invariant and safe to leave alone across re-runs

13. **Generate `src/index.ts`** — the public barrel. Exports:
    - every primitive (named export)
    - every pattern (named export)
    - every layout (named export)
    - `tokens` object (escape-hatch runtime read)
    - `cn`, `cva` utilities
    - Icon named exports from `icons/index.ts`
    - Nothing else — no internal paths re-exported

14. **Write `package.json`** with:
    - `"name": "@repo/ui-kit"`, `"version": "1.0.0"`
    - `"main": "./src/index.ts"`, `"types": "./src/index.ts"`
    - `"exports"` field restricting subpath access to `./styles/globals.css`, `./styles/fonts.css`, and the ESLint plugin (no other subpaths resolvable)
    - Dependencies: `clsx`, `tailwind-merge`, `class-variance-authority`, React peer deps, `@storybook/react-vite` + Storybook essentials
    - Scripts: `build-storybook`, `storybook`, `validate-consumer` (wires to the script from 022b)

15. **Build Storybook** — run `pnpm build-storybook` (via Bash); the static output lives at `packages/ui-kit/storybook-static/`. This is the **visual contract** downstream builders and reviewers check.

16. **Generate `docs/design-system-preview.html`** — a single page rendering every primitive × every variant and every pattern in every state. Produced alongside (or derived from) the Storybook build for humans who just want a one-page visual audit.

17. **Generate `packages/ui-kit/CHANGELOG.md`** seeded with the `1.0.0` release entry (list of primitives, patterns, layouts; token scale; dial values).

18. **Verify and report** — run `pnpm typecheck`, `pnpm lint` against the kit (the ESLint plugin is disabled on kit internals via overrides per 022b). `validate-consumer` is NOT run against the kit itself — its purpose is to scan `apps/**`, which don't exist yet at this stage. Emit the return JSON.

### Full asset-download wave (second of two)

This is the SECOND MCP download wave — partial was during `/mockups`; full runs here.

- **Scope:** only MCP servers scoped to `ui-designer` in `architecture.yaml.tooling.mcp_servers`, filtered by `feature_flag`
- **Budget:** respect `architecture.yaml.tooling.budget.total_mcp_cost_usd` + `total_image_gen_calls` (the latter only applies when `--nanobanana` is on). Enforced by orchestrator via reserve-commit (task 036)
- **What to download now:**
  - Full icon set referenced across all `docs/analysis/{platform}/screens.json` (via `icons` field per screen)
  - All font weights referenced in the kit's type scale (usually regular, medium, semibold, bold + italic variants if styles.md declares them)
  - Hero/bg images for screens marked `hero: true` in screens.json
  - Empty-state illustrations for screens marked `section: empty-state` or referenced by `EmptyState` pattern instantiations
- **De-duplication:** compare against `docs/mockups/style-{K}/manifest.json.assets[]` for the winning style K. Assets already downloaded there are reused, not re-billed.
- **Failure policy:** if budget exhausts mid-download, write partial kit + `docs/design-system-gaps.md` listing missing assets with suggested manual fallbacks. Do not silently generate lower-quality substitutes.

### Versioning policy

- First successful run locks `ui-kit@1.0.0`
- Re-runs of `/stylesheet` bump according to what changed:
  - Token value change (hex, font family, scale value): **major** (e.g., `2.0.0`)
  - New primitive / new pattern / new layout / new variant: **minor** (`1.1.0`)
  - Bug fix / illustration swap / story addition: **patch** (`1.0.1`)
- The skill writes `packages/ui-kit/CHANGELOG.md` diff entry for every re-run
- Downstream apps pin a specific version in their `package.json`; a version bump requires deliberate consumer update (not a silent rebuild)

### Re-run idempotency

Running `/stylesheet` twice with the same `docs/selected-style.json` and unchanged inputs must produce byte-identical kit output (same token values, same component source, same Storybook build). The skill fingerprints its inputs (`selected-style.json` hash + resolved asset hashes) into `packages/ui-kit/.input-fingerprint.json`; on re-run, if the fingerprint matches and the kit already exists, exit with `"success": true, "noChange": true` without regenerating.

### Return JSON

```json
{
  "success": true,
  "styleId": "style-03",
  "kitVersion": "1.0.0",
  "tokenCount": 128,
  "primitiveCount": 20,
  "patternCount": 12,
  "layoutCount": 5,
  "primitivesList": ["button", "input", "textarea", "..."],
  "patternsList": ["empty-state", "data-table", "..."],
  "layoutsList": ["app-shell", "split-view", "..."],
  "iconCount": 86,
  "illustrationsCount": 5,
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 0,
  "imagesVectorFallbackCount": 5,
  "assetsDownloaded": { "icons": 72, "fonts": 8, "images": 4 },
  "assetsDedupedFromMockups": 14,
  "tokensPackagePath": "packages/ui-kit/",
  "storybookPath": "packages/ui-kit/storybook-static/index.html",
  "previewPath": "docs/design-system-preview.html",
  "budgetExhausted": false,
  "gapsPath": null,
  "warnings": [],
  "noChange": false
}
```

### Output contract summary

- `packages/ui-kit/` exists and `pnpm typecheck` passes
- `packages/ui-kit/src/index.ts` exports every primitive, pattern, layout; no internal paths
- `packages/ui-kit/storybook-static/` is built
- `packages/ui-kit/CHANGELOG.md` entry written
- `docs/design-system-preview.html` covers every primitive × every variant + every pattern × every state
- `docs/design-system-gaps.md` exists only when budget was exhausted mid-run
- Return JSON per the shape above (matches `StylesheetOutput` in 034b)

### Post-stage verification

Orchestrator invokes `/verify-html` (task 032b) against `docs/design-system-preview.html`. Layer 6 catches mechanical issues. HITL gate runs against the Storybook build — human previews the kit before `/screens` starts composing from it.

## Integration Points

- **Task 022** (ui-designer agent): invokes this skill
- **Task 022b** (UI Kit contract): CONTRACT.md, eslint-plugin, validate-consumer.ts artifacts land inside `packages/ui-kit/` here — they don't exist in the workspace before this skill runs
- **Task 023** (/mockups): writes `docs/selected-style.json` (or HITL gate 036 does); this skill reads it. Also writes `docs/mockups/style-{K}/manifest.json` which de-dups asset downloads here
- **Task 025** (/screens): composes screens from this kit only; must pin the exact kit version
- **Task 027** (shared packages): scaffolds the empty `packages/ui-kit/` skeleton earlier in the pipeline; this skill fills it in
- **Task 029** (web-frontend-builder) / **030** (mobile-frontend-builder): consume `@repo/ui-kit` at build time
- **Task 032b** (/verify-html): validates the design-system-preview.html
- **Task 034b** (schemas): `StylesheetOutput` schema must cover the return-JSON shape above
- **Task 035** (orchestrator): invokes this skill after mockup gate; passes `--nanobanana` state
- **Task 036** (HITL gates): runs the design-system review gate over the Storybook build
- **Task 041** (MCP registration): provides `icons8`, `unsplash`, conditionally `image-generator` based on flag

## Acceptance Criteria

- [ ] `.claude/skills/stylesheet/SKILL.md` exists with the frontmatter above
- [ ] Reads `docs/selected-style.json` and validates against `SelectedStyleSchema`
- [ ] Produces `packages/ui-kit/` matching the spec §2 directory structure
- [ ] `tokens.json` is W3C DTCG format with all required top-level keys (color/typography/spacing/radius/shadow/motion/zIndex)
- [ ] `tokens.css` + `tokens.ts` + `tailwind.config.ts` are generated, not hand-authored
- [ ] Dial → token mapping rules applied: visual_density drives spacing defaults, motion_intensity drives duration defaults, design_variance drives layout-template defaults
- [ ] ≥20 primitives present, each with `.tsx` + `.variants.ts` + `.stories.tsx` + `index.ts`
- [ ] Every primitive has the required variants from the table
- [ ] ≥12 patterns present, composed from primitives (not reinvented)
- [ ] ≥5 layouts present
- [ ] Every component has all 5 interaction states + dark-mode via CSS variables
- [ ] Accessibility: proper ARIA, keyboard navigation, focus management, contrast AA minimum; axe checks pass in Storybook
- [ ] CVA used for every variant definition (not ad-hoc className switching)
- [ ] `--nanobanana` gates only the `illustrations/` step; everything else is always code-gen
- [ ] Illustrations fall back to unDraw vectors when `--nanobanana` is off
- [ ] 022b artifacts (CONTRACT.md, eslint-plugin/, scripts/validate-consumer.ts, tsconfig.consumer.json) land inside `packages/ui-kit/`
- [ ] `src/index.ts` is the only public surface; no internal paths re-exported
- [ ] `package.json` `exports` field restricts subpath access to styles/\*.css + eslint-plugin
- [ ] `package.json` version starts at `1.0.0` on first run; re-runs follow semver bump rules
- [ ] Storybook build succeeds; `storybook-static/` populated
- [ ] `docs/design-system-preview.html` covers every primitive × variant + pattern × state
- [ ] Full asset-download wave respects budget; on exhaustion writes `docs/design-system-gaps.md` + partial kit
- [ ] De-duplicates against `docs/mockups/style-{K}/manifest.json.assets[]`
- [ ] Re-run with unchanged inputs is a no-op (`noChange: true` in return JSON; byte-identical kit)
- [ ] `packages/ui-kit/CHANGELOG.md` entry written per run
- [ ] Return JSON matches `StylesheetOutput` in task 034b
- [ ] HITL gate noted: "human reviews kit via Storybook + design-system-preview.html"
- [ ] Dark-mode derivation rules documented in `packages/ui-kit/src/tokens/README.md`
- [ ] Icon library resolution: `architecture.yaml.tooling.icon_library` overrides `assets.md` suggestions (kit ships one library for coherence); user-supplied icons in `asset-inventory.json` still take precedence over library equivalents
- [ ] `validate-consumer.ts` is NOT run against the kit itself in the verify step (glob targets `apps/*` only per 022b)
- [ ] Post-stage `/verify-html` invocation wired via orchestrator

## Human Verification

1. Run `/stylesheet` after a mockup gate. Does `packages/ui-kit/` contain every directory from the spec §2 structure?
2. Open `packages/ui-kit/src/tokens/tokens.json`. Do the hex values match the winning style's styles.md block exactly?
3. Does `packages/ui-kit/src/tokens/tokens.css` include both light and dark blocks? Does switching `.dark` on `<html>` in a browser flip the kit's colors correctly?
4. Build and open Storybook. Is every primitive visible? Does every pattern have a story?
5. Does `pnpm typecheck` pass for the whole monorepo after the kit is built?
6. Does `pnpm ui-kit:validate-consumer 'apps/*/src/**/*'` run and produce "no consumers yet" output (since builders haven't run)?
7. Re-run `/stylesheet` immediately. Is it a no-op with `noChange: true`? Is the kit byte-identical?
8. Edit `docs/selected-style.json.dials.visual_density` from 4 to 9. Re-run. Do the spacing defaults and list patterns shift noticeably?
9. Run `/stylesheet` with `--nanobanana` on. Are illustrations under `illustrations/` generated via Gemini? With the flag off, are unDraw vectors used instead?
10. Review `packages/ui-kit/CHANGELOG.md`. Does the 1.0.0 entry list every shipped primitive, pattern, and layout?
