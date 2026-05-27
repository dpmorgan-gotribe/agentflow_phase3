---
name: stylesheet
description: Assemble the framework-agnostic core of the @repo/ui-kit package (tokens + globals + fonts + Tailwind config + HTML preview-bootstrap + illustrations) from the winning style at docs/selected-style.json. Pre-architect; no React primitives yet — those land via /stylesheet-primitives after /architect picks the stack.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[--nanobanana]"
---

# /stylesheet — UI Kit assembly (agnostic core)

Third pipeline stage (after `/analyze` + `/mockups` + gate 2, before `/screens`). Consumes the winning style from `docs/selected-style.json` and produces the **framework-agnostic core** of the canonical `@repo/ui-kit` package — tokens, globals, fonts, Tailwind config, HTML preview-bootstrap fragment, illustrations, and a components plan. These outputs are everything `/screens` needs (it writes pure HTML and never touches React); they are also the foundation the sibling `/stylesheet-primitives` skill builds React primitives on top of post-architect.

Skill name is `stylesheet` for historical continuity with earlier scaffolding; this skill ships the agnostic half of the kit.

## Companion skill: /stylesheet-primitives (post-architect)

Feat-074 split the original /stylesheet skill into two: this one (pre-architect, agnostic, fast — unblocks `/screens` immediately) and `/stylesheet-primitives` (post-architect, stack-aware, generates React primitives + patterns + layouts + barrel + Storybook for `architecture.yaml.tooling.stack.web_framework`).

- `/stylesheet` (here) ships: `tokens/`, `styles/` (globals/fonts/tailwind.config/preview-bootstrap), `lib/cn`, `lib/cva`, `lib/motion`, optional `illustrations/`, `.components-plan.json`, **stub `package.json`** (exports only the agnostic surface — no React peerDeps yet), `design-system-preview.html`, gate-3 signoff hand-off.
- `/stylesheet-primitives` (sibling) ships: `src/primitives/*.tsx`, `src/patterns/*.tsx`, `src/layouts/*.tsx`, `src/index.ts` public barrel, the FULL `package.json` (with React peerDeps + Storybook deps), filled-in 022b ESLint rules + validate-consumer, and `storybook-static/`. It auto-fires when `/architect` completes and runs in parallel with gate-5 credentials drop.

`/screens` consumes only the outputs of THIS skill (HTML preview-bootstrap, tokens.json, globals.css, fonts.css, tailwind.config.ts, components plan). It does not need React primitives.

Builders (Mode B `web-frontend-builder` etc.) consume both — they need the React primitives from `/stylesheet-primitives` plus the agnostic tokens/styles from here.

Gate-3 signoff (HITL review) now reviews **only the HTML preview** (`docs/design-system-preview.html`). Storybook moves to a `/stylesheet-primitives`-internal artifact reviewed at build time (no separate gate). User-accepted trade-off per investigate-028.

## Prerequisites

- `/mockups` completed and ONE of:
  - HITL gate 2 wrote `docs/selected-style.json` (multi-style path), or
  - `/mockups` single-style fast path auto-wrote it
- `docs/selected-style.json` parses against `SelectedStyleSchema` (task 034b — refactor-003 added the `iconLibrary` field)
- `docs/mockups/style-{K}/manifest.json` exists for the winning style K (used for asset de-dup)
- `packages/ui-kit/` skeleton exists (scaffolded at `/new-project` step 5b by tasks 026+027)
- Task 022b's consumer-contract templates already copied into `packages/ui-kit/` at `/new-project` step 5b (CONTRACT.md, tsconfig.consumer.json, scripts/validate-consumer.ts stub, eslint-plugin/)
- Task 041 has provisioned the ui-designer-scoped MCP servers; if `--nanobanana` is active, `image-generator` is in scope

## Inputs (ordered by authority)

1. `docs/selected-style.json` → `styleId`, `styleName`, `dials`, `stylesSourceRef`, `iconLibrary`, `nanobananaUsed`, `mockupsManifest`
2. `docs/analysis/shared/styles.md` block at `stylesSourceRef` → **authoritative** source for exact hex palette, typography (family + scale), spacing scale, radius scale, shadow definitions, characteristics. Do not re-derive from mockups when this block is complete; the Analyst already specified the values.
3. `docs/analysis/shared/assets.md` → font URLs + icon library choice for this style (also echoed in `selected-style.json.iconLibrary`)
4. `docs/mockups/style-{K}/manifest.json` → already-downloaded asset inventory (de-dup against the full download wave)
5. `docs/brand-extracted.yaml` (optional) → overrides styles.md where it has stronger sources (e.g., exact typography family names from a brand-guide PDF)
6. `docs/selected-style.json.iconLibrary` → which icon library the kit standardizes on. **Refactor-003 change:** this field now lives on the selected-style contract (locked at gate 2), not on `architecture.yaml.tooling.icon_library` — architect runs POST-design in refactor-003, so `architecture.yaml` doesn't exist when `/stylesheet` runs. Each analyst style block in `assets.md` declares its own icon library (Lucide for minimal, Phosphor for playful, etc.); gate 2's backing server copies the winning style's value into `selected-style.json.iconLibrary`. The kit ships with exactly one library for visual coherence across all apps — the one carried by the winning style. User-supplied icons in `asset-inventory.json.icons[]` still take precedence — they're used verbatim rather than swapped for library equivalents.
7. `docs/asset-inventory.json` → user-supplied fonts / icons / logos / colors take precedence over anything downloaded or researched

**Fallback (gap-fill only):** `node-vibrant` on approved mockups is a last-resort color extractor when `styles.md` AND `brand-extracted.yaml` both have a gap in palette specification. If both are complete, skip node-vibrant entirely.

## Arguments — `$ARGUMENTS`

- `--nanobanana` (boolean flag) — whether the orchestrator-provided pipeline run includes `--flags=nanobanana`. Trust `.mcp.json`'s registration of `image-generator` rather than re-parsing the flag. Only gates the illustrations step; everything else is always code-gen.

## Output: `packages/ui-kit/` structure (agnostic core — what this skill ships)

```
packages/ui-kit/
├── package.json                # STUB — exports only ./styles/*.css + ./tokens/tokens.json; NO React peerDeps yet. Version pinned at "0.1.0-tokens-only". /stylesheet-primitives rewrites this with full deps + barrel.
├── CHANGELOG.md                # seeded with 0.1.0 entry on first run; appended per re-run; /stylesheet-primitives appends its 0.2.0+ entry.
├── CONTRACT.md                 # from task 022b — consumer rules (left alone if already present)
├── UI-KIT.md                   # living consumption guide — written by this skill; /stylesheet-primitives appends primitive-import examples
├── tsconfig.json
├── tsconfig.consumer.json      # from 022b — path aliases expose ONLY the public barrel (barrel itself written by /stylesheet-primitives)
├── .input-fingerprint.json     # hash of resolved inputs; enables no-op re-runs
├── .components-plan.json       # generation plan (canonical + custom) — consumed by /screens AND /stylesheet-primitives
├── src/
│   ├── tokens/
│   │   ├── tokens.json         # W3C DTCG — source of truth
│   │   ├── tokens.css          # generated — CSS custom properties + .dark override block
│   │   ├── tokens.ts           # generated — TypeScript types + runtime constants
│   │   └── README.md           # naming conventions + dark-mode derivation explanation
│   ├── styles/
│   │   ├── globals.css         # resets + base typography + imports tokens.css; STARTS with @tailwind base/components/utilities (bug-077 contract)
│   │   ├── fonts.css           # @font-face declarations (variable fonts where available)
│   │   ├── tailwind.config.ts  # consumes tokens via CSS vars
│   │   └── preview-bootstrap.html  # paste-ready Tailwind Play CDN fragment for /mockups + /screens HTML previews (refactor-007)
│   ├── lib/
│   │   ├── cn.ts               # clsx + twMerge
│   │   ├── cva.ts              # class-variance-authority setup
│   │   └── motion.ts           # shared motion presets from tokens.motion
│   ├── icons/
│   │   ├── generated/          # SVG → React components via svgr (asset prep; consumed by /stylesheet-primitives' barrel)
│   │   └── index.ts            # icon barrel (intermediate; re-exported from src/index.ts by /stylesheet-primitives)
│   └── illustrations/          # optional; gated by --nanobanana
│       ├── empty-states/
│       ├── onboarding/
│       ├── hero/
│       └── manifest.json       # provenance per illustration (generated | vector | user)
├── eslint-plugin/              # SKELETON from /new-project step 5b; rules filled in by /stylesheet-primitives (not here)
└── scripts/
    └── validate-consumer.ts    # SKELETON from /new-project step 5b; real implementation in /stylesheet-primitives
```

**Outputs NOT shipped by this skill** (deferred to `/stylesheet-primitives`):

- `src/primitives/*/` — React primitives (Button, Input, etc.)
- `src/patterns/*/` — React patterns (EmptyState, DataTable, etc.)
- `src/layouts/*/` — React layouts (AppShell, etc.)
- `src/index.ts` — the public barrel
- `.storybook/` + `storybook-static/` — Storybook config + build
- Full `package.json` with React peerDeps + Storybook devDeps
- Filled-in `eslint-plugin/rules/*.js` + real `scripts/validate-consumer.ts`

## Steps

### 1. Read the selected style (primary source)

- Parse `docs/selected-style.json`; abort if it fails `SelectedStyleSchema` validation (034b)
- Open `docs/analysis/shared/styles.md` and extract the block referenced by `stylesSourceRef`
- Parse hex palette, typography family + scale, spacing scale, radius scale, shadow definitions, characteristics
- Read `docs/selected-style.json.dials` — values drive token-scale choices (see "Dial → token mapping" below)
- Read `docs/selected-style.json.iconLibrary` — this is the kit's single icon library (refactor-003: locked at gate 2, not at architect time)

### 2. Fingerprint inputs + check for no-op re-run

Compute a SHA-256 hash of: `docs/selected-style.json` bytes + the extracted styles.md block + the resolved asset list (icon-library name, font families, user-asset paths + sizes). Compare against `packages/ui-kit/.input-fingerprint.json`:

- **Match AND** `packages/ui-kit/package.json` exists AND `packages/ui-kit/src/tokens/tokens.json` exists AND `docs/design-system-preview.html` exists → no-op re-run. Emit return JSON with `noChange: true, success: true` and exit without regenerating. (Note: pre-feat-074 this gate also required `storybook-static/index.html`; Storybook moved to `/stylesheet-primitives` step 7, so it is no longer part of this skill's no-op heuristic.)
- **Mismatch OR** kit missing → continue to step 3 and eventually overwrite `.input-fingerprint.json` at step 18.

This guarantees byte-identical output for identical inputs.

### 3. Resolve asset authorities (in order)

For every token category, check sources in this order and use the first concrete value found:

1. User assets in `docs/asset-inventory.json` (user fonts, user icons, user colors, user logos take precedence over everything else)
2. `docs/brand-extracted.yaml` (when gaps exist and the brand guide provides authoritative values)
3. The styles.md block (the Analyst's canonical specification)
4. `node-vibrant` fallback — **palette only, rare**; extracts dominant colors from approved mockup screenshots when styles.md + brand-extracted both have gaps

### 4. Generate `packages/ui-kit/src/tokens/tokens.json`

W3C DTCG format. Required top-level keys:

```json
{
  "color": {
    "neutral": { "50..950": "#..." },
    "accent": { "50..950": "#..." },
    "semantic": {
      "success": "#...",
      "warning": "#...",
      "danger": "#...",
      "info": "#..."
    },
    "surface": {
      "base": "#...",
      "raised": "#...",
      "overlay": "#...",
      "inverted": "#..."
    },
    "text": {
      "primary": "#...",
      "secondary": "#...",
      "tertiary": "#...",
      "inverted": "#..."
    },
    "border": { "subtle": "#...", "default": "#...", "strong": "#..." }
  },
  "typography": {
    "fontFamily": { "sans": "...", "mono": "...", "display": "..." },
    "fontSize": { "xs..6xl": "..." },
    "fontWeight": {
      "regular": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    },
    "lineHeight": { "tight": 1.1, "snug": 1.3, "normal": 1.5, "relaxed": 1.75 },
    "letterSpacing": { "tight": "-0.02em", "normal": "0", "wide": "0.04em" }
  },
  "spacing": { "0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24": "..." },
  "radius": { "none, sm, md, lg, xl, 2xl, full": "..." },
  "shadow": { "xs, sm, md, lg, xl": "..." },
  "motion": {
    "duration": { "instant, fast, normal, slow, slower": "..." },
    "easing": { "linear, standard, decel, accel, spring": "..." }
  },
  "zIndex": { "base, dropdown, sticky, overlay, modal, toast, tooltip": "..." }
}
```

Populate values from the step-3-resolved authorities. Accent ramp is derived from the style's accent color (LCH-based 50-950 scale). Neutral ramp is derived from the style's textPrimary/background/surface (warm-greys / cool-slates / true-neutrals depending on the style's characteristics).

**Token key index (dotted-identifier form for downstream readers):**

- `color.neutral.{50..950}`, `color.accent.{50..950}`
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

### 5. Dial → token mapping (from `docs/selected-style.json.dials`)

These integer dials (1-10) shift token defaults:

- `visual_density` ≤ 3 → spacing defaults to `spacing.6`/`spacing.8`; line-height `relaxed`; card-based list patterns
- `visual_density` ≥ 7 → spacing defaults to `spacing.2`/`spacing.3`; line-height `snug`; border-top dividers instead of cards in list patterns
- `motion_intensity` ≤ 3 → `motion.duration.normal = 150ms`; no spring easing by default; fades only
- `motion_intensity` ≥ 7 → `motion.duration.normal = 400ms`; spring easing named preset available; scroll-linked motion allowed
- `design_variance` ≤ 3 → layouts default to symmetric centered compositions
- `design_variance` ≥ 7 → layouts default to asymmetric; at least one layout pattern uses a broken grid

Record the applied dial mapping at the top of `packages/ui-kit/CHANGELOG.md`'s entry so re-runs know which dial value drove which default.

### 6. Generate derivatives

- **`tokens.css`** — every token as a CSS custom property (`--color-accent-500: #...`). Include a `.dark` override block with dark-mode values (see "Dark-mode derivation" below). One file — no separate light/dark builds.
- **`tokens.ts`** — typed exports so consumers can `import { tokens } from '@repo/ui-kit'` for runtime reads. This is the 022b-sanctioned escape hatch for dynamic style decisions that can't be expressed as class names.
- **`styles/tailwind.config.ts`** — extends theme by referencing CSS variables (`backgroundColor: { accent: 'var(--color-accent-500)' }`), so Tailwind utilities resolve to the kit's tokens.

#### Dark-mode derivation

If `styles.md` declares a `darkMode:` subsection for the selected style, use its hex values directly. If not (the common case — Analyst only specifies light mode), derive dark-mode tokens algorithmically:

- **Neutrals**: swap the ramp — `neutral.50` ↔ `neutral.950`, `neutral.100` ↔ `neutral.900`, …, `neutral.400` ↔ `neutral.600`; `neutral.500` stays
- **Surface tokens**: `surface.base = neutral.950`; `surface.raised = neutral.900`; `surface.overlay = neutral.800`; `surface.inverted = neutral.50`
- **Text tokens**: `text.primary = neutral.50`; `text.secondary = neutral.400`; `text.tertiary = neutral.600`; `text.inverted = neutral.950`
- **Border tokens**: `border.subtle = neutral.800`; `border.default = neutral.700`; `border.strong = neutral.600`
- **Accent + semantic ramps**: unchanged (same hues work in both modes; contrast comes from surface/text inversion)
- **Shadows**: reduce opacity by ~40% on dark (dark shadows are less visible against dark surfaces)

The derivation is deterministic. Document it in `packages/ui-kit/src/tokens/README.md` so any designer can see why a specific dark value was chosen.

### 7. Generate `packages/ui-kit/src/styles/`

- **`globals.css`** — CSS reset (modern normalize), focus-visible styles, scrollbar styling, base typography (body font + default leading), color-scheme meta. **MUST start with `@tailwind base; @tailwind components; @tailwind utilities;`** (bug-077 contract — without these directives, production consumers' Tailwind utility classes silently produce zero CSS). Then imports `tokens.css` at top of the rule sets:

  ```css
  /* @repo/ui-kit globals.css — required header (bug-077) */
  @tailwind base;
  @tailwind components;
  @tailwind utilities;

  @import "./fonts.css";
  @import "../tokens/tokens.css";

  /* ─────────── Reset + base typography below ─────────── */
  ```

  Production consumers (`apps/web/`) pair this with their own `apps/web/postcss.config.mjs` that loads the `tailwindcss + autoprefixer` PostCSS plugins. The directives + the postcss config together form the working pipeline; either one missing means utilities don't compile. See `.claude/skills/agents/front-end/react-next/SKILL.md §1b` for the consumer contract.

- **`fonts.css`** — `@font-face` declarations. Prefer variable fonts; declare `font-display: swap`. One family per declaration; don't lump.
- **`tailwind.config.ts`** — extends theme via `var(--...)` references only; no hex in config.
- **`preview-bootstrap.html`** (refactor-007 — load-bearing for `/mockups` + `/screens` HTML preview) — a paste-ready fragment that downstream skills inline into every preview HTML's `<head>`. It contains the Tailwind Play CDN script + an inline `<script>tailwind.config = {...}</script>` block whose theme.extend mirrors the kit's `tailwind.config.ts` exactly (with `var(--color-*)` references preserved as string values). Required because mockup/screen HTML files don't go through a build step — without the inline CDN, their utility classes (`bg-accent-500`, `font-display`, `rounded-md`, etc.) resolve to nothing and the page renders unstyled. Production consumers (apps/web/) bypass this fragment entirely — they consume `globals.css`'s `@tailwind` directives via their PostCSS pipeline (see bug-077 contract above + `.claude/skills/agents/front-end/react-next/SKILL.md §1b`). This fragment is preview-only.

  **Required shape** (emit this verbatim, replacing the `theme.extend` body with values derived from this run's `tailwind.config.ts`):

  ```html
  <!-- preview-bootstrap.html — inline this into every mockup/screen <head>.
       Generated by /stylesheet step 7. Do NOT hand-edit; re-run /stylesheet to regenerate. -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: ["class", '[data-theme="dark"]'],
      theme: {
        extend: {
          colors: {
            neutral: {
              50: "var(--color-neutral-50)",
              /* ...50→950 */ 950: "var(--color-neutral-950)",
            },
            accent: {
              50: "var(--color-accent-50)",
              /* ...50→950 */ 950: "var(--color-accent-950)",
            },
            secondary: {
              500: "var(--color-secondary-500)",
              600: "var(--color-secondary-600)",
            },
            highlight: {
              300: "var(--color-highlight-300)",
              500: "var(--color-highlight-500)",
            },
            success: "var(--color-success)",
            warning: "var(--color-warning)",
            danger: "var(--color-danger)",
            info: "var(--color-info)",
            surface: {
              base: "var(--color-surface-base)",
              raised: "var(--color-surface-raised)",
              overlay: "var(--color-surface-overlay)",
              inverted: "var(--color-surface-inverted)",
            },
            text: {
              primary: "var(--color-text-primary)",
              secondary: "var(--color-text-secondary)",
              tertiary: "var(--color-text-tertiary)",
              inverted: "var(--color-text-inverted)",
            },
            border: {
              subtle: "var(--color-border-subtle)",
              DEFAULT: "var(--color-border-default)",
              strong: "var(--color-border-strong)",
            },
          },
          fontFamily: {
            sans: "var(--font-family-sans)",
            mono: "var(--font-family-mono)",
            display: "var(--font-family-display)",
          },
          fontSize: {
            xs: "var(--font-size-xs)",
            sm: "var(--font-size-sm)",
            md: "var(--font-size-md)",
            lg: "var(--font-size-lg)",
            xl: "var(--font-size-xl)",
            "2xl": "var(--font-size-2xl)",
            "3xl": "var(--font-size-3xl)",
            "4xl": "var(--font-size-4xl)",
            "5xl": "var(--font-size-5xl)",
            "6xl": "var(--font-size-6xl)",
          },
          spacing: {
            0.5: "var(--spacing-0_5)",
            1: "var(--spacing-1)",
            2: "var(--spacing-2)",
            3: "var(--spacing-3)",
            4: "var(--spacing-4)",
            5: "var(--spacing-5)",
            6: "var(--spacing-6)",
            8: "var(--spacing-8)",
            10: "var(--spacing-10)",
            12: "var(--spacing-12)",
            16: "var(--spacing-16)",
            20: "var(--spacing-20)",
            24: "var(--spacing-24)",
          },
          borderRadius: {
            none: "var(--radius-none)",
            sm: "var(--radius-sm)",
            DEFAULT: "var(--radius-md)",
            md: "var(--radius-md)",
            lg: "var(--radius-lg)",
            xl: "var(--radius-xl)",
            "2xl": "var(--radius-2xl)",
            full: "var(--radius-full)",
          },
          boxShadow: {
            xs: "var(--shadow-xs)",
            sm: "var(--shadow-sm)",
            DEFAULT: "var(--shadow-md)",
            md: "var(--shadow-md)",
            lg: "var(--shadow-lg)",
            xl: "var(--shadow-xl)",
          },
          zIndex: {
            dropdown: "var(--z-dropdown)",
            sticky: "var(--z-sticky)",
            overlay: "var(--z-overlay)",
            modal: "var(--z-modal)",
            toast: "var(--z-toast)",
            tooltip: "var(--z-tooltip)",
          },
        },
      },
    };
  </script>
  ```

  Sync this fragment with `tailwind.config.ts` on every `/stylesheet` run — they are the same theme expressed once for the JIT build (TS) and once for the Play CDN (inline JS). Drift between them is a bug; the fingerprint hash (step 2) covers `tailwind.config.ts` so any change forces a regenerate of both files together.

### 8. Generate `packages/ui-kit/src/lib/`

- **`cn.ts`** — `clsx` + `tailwind-merge` composition. One default export `cn(...classes)`.
- **`cva.ts`** — `class-variance-authority` re-export + the kit's preferred `cva` factory wrapper with default `compoundVariants: []`.
- **`motion.ts`** — named presets derived from `tokens.motion.duration` + `tokens.motion.easing` (`fadeIn`, `slideUp`, `scaleIn`, `springPop`, etc.). Each preset returns a CSS string or a `framer-motion` variant object per the kit's motion abstraction.

### 8.5. Read components catalog + compute coverage union

**Load `docs/analysis/shared/components.md`** (produced by `/analyze` step 6e). Parse its machine-readable JSON trailer (fenced `json` block at end of file) to extract:

- `primitives[]` — analyst-observed primitive usage, mapped to canonical kit names
- `patterns[]` — analyst-observed pattern usage
- `layouts[]` — analyst-observed layout usage
- `projectSpecific[]` — custom compositions (e.g. `wallet-balance`, `vote-button`, `chat-bubble`, `stepper`) — one entry per component with `name`, `screenCount`, `platforms[]`
- `canonicalCoverage.primitivesUnused[]` / `patternsUnused[]` — canonical items the analyst DIDN'T call out

**Compute the generation plan** (union):

1. **All 20 canonical primitives** (12 core + 8 extended — see `/stylesheet-primitives` step 1c/1d for the rosters) are listed in the plan unconditionally (future-proofing; some are unused-now but may be needed by `/screens` retry passes or post-gate-4 edits). Analyst-observed primitives get preview priority. Authoring happens in `/stylesheet-primitives`.
2. **All 12 canonical patterns** (see `/stylesheet-primitives` step 2a for the table) are listed unconditionally. Authoring happens in `/stylesheet-primitives`.
3. **All 5 canonical layouts** (see `/stylesheet-primitives` step 3 for the table). Authoring happens in `/stylesheet-primitives`.
4. **ONE custom pattern per project-specific entry** — listed in the plan and authored later by `/stylesheet-primitives` step 2b. Pattern name derived from kebab-case → PascalCase (`wallet-balance` → `WalletBalance`). The custom pattern eventually lives under `src/patterns/custom/{name}/` with the same `{Name}.tsx` + `.variants.ts` + `.stories.tsx` + `index.ts` shape as canonical patterns.

**Record the plan** in `packages/ui-kit/.components-plan.json`:

```json
{
  "canonicalPrimitivesGenerated": 20,
  "canonicalPatternsGenerated": 12,
  "canonicalLayoutsGenerated": 5,
  "customPatternsGenerated": [
    {
      "name": "WalletBalance",
      "source": "wallet-balance",
      "screenCount": 13,
      "platforms": ["mobile"]
    },
    {
      "name": "VoteButton",
      "source": "vote-button",
      "screenCount": 18,
      "platforms": ["mobile"]
    }
  ],
  "canonicalUnused": {
    "primitives": ["Slider", "Accordion"],
    "patterns": ["CommandPalette"]
  }
}
```

Downstream: `/stylesheet-primitives` step 5's public barrel exports EVERY component in the plan (primitives + patterns + custom patterns + layouts). This skill's step 17 preview renders EVERY component with its analyst-derived screen count (or "Available, no current screens use it" for unused canonicals) — even though the React surface doesn't exist yet, the HTML preview asserts coverage so gate-3 can sign off on the FULL component set before `/stylesheet-primitives` runs.

### Steps 9, 10, 11 — MOVED to `/stylesheet-primitives` (feat-074)

- **Step 9 (Generate primitives — 12 core mandatory + 8 extended on-demand)** → `/stylesheet-primitives` step 1
- **Step 10 (Generate patterns — 12 canonical + N custom)** → `/stylesheet-primitives` step 2
- **Step 11 (Generate layouts — minimum 5)** → `/stylesheet-primitives` step 3

These steps are React-specific and bound to `architecture.yaml.tooling.stack.web_framework`, which doesn't exist yet at this pipeline stage. They run automatically after `/architect` completes (in parallel with gate-5 credentials drop) via the sibling skill `/stylesheet-primitives`.

Historical context (refactor-006): before feat-074's split, step 9 said "generate ≥20" in the aspirational voice and six projects (hatch, gotribe-v1, mindapp, mindapp-v2, runclub, test-app) shipped tokens-only without a single primitive. The ≥12 mandatory-primitive hard gate now lives in `/stylesheet-primitives` step 8.

This skill jumps from step 8.5 directly to step 12.

### 12. `--nanobanana` step (optional, illustrations only)

> _Note (feat-074): Steps 9, 10, 11 have moved to `/stylesheet-primitives`. This skill's flow is now 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 8.5 → 12 → 17 → 18-slimmed._

The `--nanobanana` flag gates only the illustrations step — everything else is always code-gen and runs regardless of flag state.

- **Flag on** (`.mcp.json` has `image-generator`): generate hero / empty-state / onboarding illustrations via `image-generator` MCP using prompt patterns that respect the selected style's palette + characteristics. Respect per-server budget cap. Provenance → `generated`.
- **Flag off**: skip generation; provide a small unDraw vector set in `illustrations/` with file headers tokenized on the accent color. `EmptyState` pattern accepts an `illustration` prop that falls back gracefully when no matching illustration exists. Provenance → `vector`.
- Record every illustration in `packages/ui-kit/src/illustrations/manifest.json` with `{ name, provenance, source, recoloredTo }`.

### Steps 13, 14, 16 — MOVED to `/stylesheet-primitives` (feat-074)

- **Step 13 (Fill in 022b artifacts — real eslint-plugin rules + validate-consumer.ts)** → `/stylesheet-primitives` step 4
- **Step 14 (Generate `src/index.ts` public barrel)** → `/stylesheet-primitives` step 5
- **Step 16 (Build Storybook)** → `/stylesheet-primitives` step 7

These steps depend on the React primitives, patterns, and layouts shipped by `/stylesheet-primitives`; they can't run pre-architect.

### 15. Write stub `package.json` (agnostic surface only)

This skill ships a **stub** `package.json` that exposes only the agnostic surface — tokens + CSS. The full `package.json` with React peerDeps + Storybook devDeps + `validate-consumer` script is authored by `/stylesheet-primitives` step 6 once the stack is known.

```json
{
  "name": "@repo/ui-kit",
  "version": "0.1.0-tokens-only",
  "main": "./src/tokens/tokens.json",
  "exports": {
    "./styles/globals.css": "./src/styles/globals.css",
    "./styles/fonts.css": "./src/styles/fonts.css",
    "./styles/preview-bootstrap.html": "./src/styles/preview-bootstrap.html",
    "./tokens/tokens.json": "./src/tokens/tokens.json",
    "./tokens/tokens.css": "./src/tokens/tokens.css"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.5",
    "class-variance-authority": "^0.7.1"
  }
}
```

Rationale:

- **No `"."` main export** yet — there's no public barrel (`src/index.ts`) at this stage. `/stylesheet-primitives` step 5 authors the barrel and step 6 rewrites this file to add the `"."` export.
- **No React peerDeps** — that's stack-aware (`web_framework` might be `react-next`, future `solid-start`, future `svelte-kit`, etc.). `/stylesheet-primitives` adds the right peerDeps per architecture.
- **No Storybook scripts/devDeps** — Storybook is React-bound and added in `/stylesheet-primitives` step 7.
- **Subpath exports are agnostic** — `globals.css`, `fonts.css`, `preview-bootstrap.html`, `tokens.json`, `tokens.css` are all framework-free and CAN be consumed by `/screens` (HTML output) right now.

The version `0.1.0-tokens-only` is a sentinel: `/stylesheet-primitives` bumps it to `0.2.0-primitives` (or higher) after authoring the barrel.

**Note on `exports` field as a 022b invariant**: The full `package.json` MUST restrict subpath access (no deep imports beyond `./styles/*` + `./eslint-plugin`). This stub satisfies that contract trivially (no React surface to import deeply yet); `/stylesheet-primitives` step 6 carries the full enforcement forward.

### 17. Generate `docs/design-system-preview.html`

Single standalone HTML page. This is NOT a docs grid. **The preview MUST read as a real, interactive application** — the reviewer evaluates whether the look + feel holds at production density, not whether each atom renders correctly in isolation.

**UX philosophy (applies to every project):**

1. **Real app chrome wraps everything.** Derive the header + sidebar + footer pattern from the winning style's `/mockups` output (read `docs/mockups/style-{K}/webapp/*.html` from the pre-archive working set OR from `docs/mockups/archive/style-{K}/` if `/pick-style` moved it). Use identical palette + type + spacing as the picked mockup. Gotribe example: dark charcoal `#3D3D3D` top header with logo + search + notifications-with-badge + avatar; left sidebar with nav items. Hatch example: minimal typographic-centered header, no sidebar. Mindapp example: mastery-color-tokened chrome. The preview must be recognisable as "the same product family" as the selected mockup.

2. **Reference real user assets by relative path — never inline-redraw.** `<img src="../assets/logos/{file}.{ext}">` for the logo. `<img src="../assets/icons/{name}.svg">` for every user-supplied icon. Icons inherit the filter/color treatment from the style's chrome (e.g. `filter: invert(1)` on dark-chrome headers for monochromatic SVGs). Drives home that the preview is real, not approximated.

3. **Every component is active — no greyed-out "unused canonical" state.** A Slider the analyst didn't call out is still draggable. A Popover the analyst didn't list still opens on click. Future screens may need them; reviewer should see the real behaviour today. "Unused" classification lives only in the tooltip metadata, never in visual treatment.

4. **No cards wrapping components with metadata clustered around them.** Components sit in realistic layouts (grids, lists, feeds, forms) — not in individual documentation boxes. Metadata moves to a **tooltip on hover** (see snippet below). When the reviewer hovers an outlined element, they see `ComponentName · tier · usage count · platforms`. When they're not hovering, the UI reads as a clean product.

5. **Organise content into realistic app sections, not a component taxonomy.** Sections derive from brief §11 screen catalog + analyst flows — e.g. for gotribe: Dashboard, Activity feed, Tribes list, Events, Governance, Marketplace, Messaging, Map, Forms, Feedback overlays, Content patterns, Special widgets. For hatch: Home hero, Service overview, Featured work, Testimonial, Contact. Each section uses the components that belong to that app surface, composed the way they'll be composed at `/screens` time.

6. **Everything that can be interactive IS interactive.** Explicit requirements:
   - Sliders / range inputs: draggable, reflect value
   - Tabs: click switches active tab
   - Accordion `<details>`: click expands/collapses
   - Switch / Checkbox / Radio: toggle on click
   - Chips (filter-bar): click to toggle active state
   - Rating: click a star to set rating
   - VoteButton: click to toggle upvote/downvote with count flip
   - Dialog: triggered by a real button; `<dialog>` element with `.showModal()`; Esc closes; backdrop click closes
   - Drawer: triggered by real button; slides in via `transform: translateX`; backdrop click closes
   - Toast: triggered by buttons; real `fireToast()` function appends to a toast stack with auto-dismiss
   - Popover: click to open, outside-click to close
   - FAB (if mobile is a detected platform): floats bottom-right, fires a toast on click
   - Search combobox: focus opens suggestions, blur closes
   - RichText editor: `contenteditable="true"` so reviewer can actually type

7. **Every rendered instance carries a `data-comp` attribute** with this shape: `"ComponentName · tier · usage-line"` (e.g. `"Button · primary variant · 571 screens · all platforms"`). The tooltip JS (below) splits on `·` and renders the parts with distinct styling.

**Tooltip implementation — ship this snippet verbatim in every preview:**

```html
<div id="tooltip"></div>
<style>
  #tooltip {
    position: fixed;
    z-index: 10000;
    pointer-events: none;
    background: var(--color-neutral-900);
    color: var(--color-neutral-50);
    padding: 8px 12px;
    border-radius: var(--radius-md);
    font-size: var(--font-size-xs);
    font-family: var(--font-family-mono);
    opacity: 0;
    transition: opacity 120ms ease;
    white-space: nowrap;
    box-shadow: var(--shadow-lg);
    max-width: 300px;
  }
  #tooltip.show {
    opacity: 1;
  }
  #tooltip .name {
    font-weight: var(--font-weight-semibold);
    color: var(--color-accent-300);
  }
  #tooltip .tier {
    opacity: 0.7;
    margin-left: 6px;
  }
  #tooltip .usage {
    display: block;
    margin-top: 2px;
    color: var(--color-neutral-300);
  }
  [data-comp] {
    cursor: help;
  }
  [data-comp]:hover {
    outline: 2px dashed rgba(107, 155, 55, 0.4);
    outline-offset: 2px;
    border-radius: 4px;
  }
</style>
<script>
  const tip = document.getElementById("tooltip");
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-comp]");
    if (!el) return;
    const parts = el.getAttribute("data-comp").split(" · ");
    tip.innerHTML =
      `<span class="name">${parts[0]}</span>` +
      `<span class="tier">${parts[1] || ""}</span>` +
      (parts.slice(2).length
        ? `<span class="usage">${parts.slice(2).join(" · ")}</span>`
        : "");
    tip.classList.add("show");
    tip.style.left =
      Math.min(e.clientX + 16, window.innerWidth - tip.offsetWidth - 12) + "px";
    tip.style.top =
      Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 12) +
      "px";
  });
  document.addEventListener("mousemove", (e) => {
    if (!tip.classList.contains("show")) return;
    tip.style.left =
      Math.min(e.clientX + 16, window.innerWidth - tip.offsetWidth - 12) + "px";
    tip.style.top =
      Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 12) +
      "px";
  });
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest("[data-comp]"))
      tip.classList.remove("show");
  });
</script>
```

The outline-on-hover + dashed rectangle is a universal affordance: hovering reveals every reviewable element at a glance. Reviewer can scan the page for olive dashed outlines to find anything unreviewed.

**Full-coverage assertion (unchanged).** Before writing the preview, verify: every entry in `components.md`'s JSON trailer (`primitives`, `patterns`, `layouts`, `projectSpecific` combined) has at least one corresponding rendered instance with a matching `data-comp` attribute. If any analyst-observed component is missing from the preview, abort — this is the load-bearing contract that prevents unreviewed components leaking into `/screens`.

**Grep-based verifier:** after writing, grep for `data-comp=` and confirm the unique component-name set matches `.components-plan.json`'s union. Abort on any mismatch (missing OR extra).

**Interaction smoke-check before emitting:** open the file in a headless browser (via the `chrome-devtools` MCP in the `ui-designer`-scoped set) and click each trigger (Open Dialog / Open Drawer / fire Toast). Confirm no JS errors in console. If the MCP isn't available at runtime, skip with a `warnings[]` note.

### 18. Finalize + verify (slimmed — agnostic outputs only; primitives gate moved to `/stylesheet-primitives` step 8)

This skill's verify covers ONLY the agnostic surface it ships. The ≥12-mandatory-primitive HARD GATE moves with the primitives — see `/stylesheet-primitives` step 8.

- Write `packages/ui-kit/CHANGELOG.md` entry — `0.1.0-tokens-only` release lists the token scales + dial values + agnostic assets shipped (illustrations manifest, fonts, icons-deduped). `/stylesheet-primitives` appends its `0.2.0-primitives` entry on its successful run.
- Write `packages/ui-kit/UI-KIT.md` — living consumption guide. At this stage: CSS-import examples (`@repo/ui-kit/styles/globals.css`, `/fonts.css`), Tailwind config import, preview-bootstrap consumption pattern, dial-change impact summary. `/stylesheet-primitives` appends primitive-import examples once the barrel exists.
- Write `packages/ui-kit/.input-fingerprint.json` — hash from step 2 + metadata (regeneration date, resolved-inputs summary). The fingerprint covers only this skill's resolved inputs; `/stylesheet-primitives` writes its own complementary fingerprint.
- Verify presence of every agnostic deliverable (abort with `success: false` if any are missing):
  - `packages/ui-kit/src/tokens/tokens.json` (W3C DTCG)
  - `packages/ui-kit/src/tokens/tokens.css` (with `.dark` block)
  - `packages/ui-kit/src/tokens/tokens.ts`
  - `packages/ui-kit/src/styles/globals.css` (starts with `@tailwind base/components/utilities` — bug-077 invariant)
  - `packages/ui-kit/src/styles/fonts.css`
  - `packages/ui-kit/src/styles/tailwind.config.ts`
  - `packages/ui-kit/src/styles/preview-bootstrap.html`
  - `packages/ui-kit/src/lib/cn.ts`, `cva.ts`, `motion.ts`
  - `packages/ui-kit/.components-plan.json`
  - `packages/ui-kit/package.json` (stub form per step 15)
  - `docs/design-system-preview.html` (from step 17)
- Run `pnpm typecheck` in the monorepo IF a tsconfig + node_modules already exist at project root. The agnostic surface has no React imports, so typecheck should pass with `noEmit`. If typecheck fails for reasons OUTSIDE this skill's outputs (e.g. an upstream package has TS errors), record as warning but don't fail.
- `validate-consumer` is NOT run against the kit itself — its purpose is to scan `apps/**`, which don't exist yet at this stage. The real implementation lands via `/stylesheet-primitives` step 4.
- **Bug-077 invariant check** — grep `packages/ui-kit/src/styles/globals.css` for `@tailwind base` `@tailwind components` `@tailwind utilities`. If any of the three directives is missing, fail with `globals-css-missing-tailwind-directives` — this is a load-bearing contract that production consumers' Tailwind utility classes depend on.
- **No `data-kit-component` retrofit yet** — that codemod targets `packages/ui-kit/src/{primitives,layouts}/**/*.tsx` which don't exist at this stage. Moved to `/stylesheet-primitives` step 8.
- Emit return JSON per the "Return JSON" section below.

## Full asset-download wave (second of two)

This is the SECOND MCP download wave — partial happened during `/mockups`; full runs here.

- **Scope**: only MCP servers scoped to `ui-designer` in `.mcp.json`, filtered by `feature_flag` (e.g. `image-generator` only when `--nanobanana` is on)
- **Budget**: respect per-server budget. Tracked by the orchestrator (035) against the stage-budget cap resolved from `~/.claude/models.yaml`. Enforced via reserve-commit (task 036 gate mechanics)
- **Download this wave**:
  - Full icon set referenced across all `docs/analysis/{platform}/screens.json` (via `icons` field per screen)
  - All font weights referenced in the kit's type scale (usually 400, 500, 600, 700 + italic variants if styles.md declares them)
  - Hero/background images for screens marked `hero: true` in screens.json
  - Empty-state illustrations for screens referenced by `EmptyState` pattern instantiations
- **De-duplication**: compare against `docs/mockups/style-{K}/manifest.json.assets[]` for the winning style K. Assets already downloaded there are reused, not re-billed
- **Failure policy**: if budget exhausts mid-download, write partial kit + `docs/design-system-gaps.md` listing missing assets with suggested manual fallbacks. Do NOT silently generate lower-quality substitutes

## Versioning policy

- First successful `/stylesheet` run locks `@repo/ui-kit@0.1.0-tokens-only` (sentinel — flags that primitives haven't shipped yet).
- `/stylesheet-primitives` bumps to `0.2.0-primitives` on its first successful run. From there, semver applies normally per its versioning policy.
- Re-runs of THIS skill (`/stylesheet`) bump according to what changed in the agnostic surface:
  - Token value change (hex, font family, scale value) → **major-equivalent** prerelease (`0.1.0` → `0.1.1-tokens-only` if patch-level; `0.1.0` → `0.2.0-tokens-only` if dial change). The prerelease tag stays until `/stylesheet-primitives` runs.
  - Illustration swap / preview-bootstrap shape change → **patch**.
- The skill writes a `packages/ui-kit/CHANGELOG.md` diff entry per re-run; `/stylesheet-primitives` appends its own.
- Downstream apps pin a specific version in their `package.json`; a version bump requires deliberate consumer update, not a silent rebuild.

## Re-run idempotency

Running `/stylesheet` twice with the same `docs/selected-style.json` and unchanged inputs must produce byte-identical agnostic-surface output (same token values, same globals.css, same preview-bootstrap fragment, same illustrations manifest, same design-system-preview.html). Step 2's fingerprint check enforces this.

## Return JSON

```json
{
  "success": true,
  "styleId": "style-03",
  "kitVersion": "0.1.0-tokens-only",
  "tokenCount": 128,
  "iconCount": 86,
  "illustrationsCount": 5,
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 0,
  "imagesVectorFallbackCount": 5,
  "assetsDownloaded": { "icons": 72, "fonts": 8, "images": 4 },
  "assetsDedupedFromMockups": 14,
  "tokensPackagePath": "packages/ui-kit/",
  "previewPath": "docs/design-system-preview.html",
  "componentsPlanPath": "packages/ui-kit/.components-plan.json",
  "previewBootstrapPath": "packages/ui-kit/src/styles/preview-bootstrap.html",
  "budgetExhausted": false,
  "gapsPath": null,
  "warnings": [],
  "noChange": false
}
```

Matches the agnostic-surface subset of `StylesheetOutput` in task 034b. The primitives/patterns/layouts/storybook fields are emitted by `/stylesheet-primitives` and merged downstream where consumers read both return JSONs.

## Output contract summary

- `packages/ui-kit/` exists (agnostic-surface populated per step-18 invariants)
- `packages/ui-kit/src/tokens/` + `src/styles/` + `src/lib/` + optional `src/illustrations/` + optional `src/icons/` present
- `packages/ui-kit/src/styles/globals.css` starts with `@tailwind base/components/utilities` (bug-077)
- `packages/ui-kit/src/styles/preview-bootstrap.html` present (refactor-007 contract for `/mockups` + `/screens`)
- `packages/ui-kit/.components-plan.json` present (consumed by `/screens` AND `/stylesheet-primitives`)
- `packages/ui-kit/package.json` is the stub form (no React peerDeps yet)
- `packages/ui-kit/CHANGELOG.md` entry written
- `docs/design-system-preview.html` is the gate-3 review artifact (HTML preview — no Storybook yet)
- `docs/design-system-gaps.md` exists ONLY when budget was exhausted mid-run
- Return JSON matches the agnostic subset of `StylesheetOutput` schema

## Post-stage verification

Orchestrator invokes `/verify-html` (task 032b) against `docs/design-system-preview.html`. Layer 6 catches mechanical issues. HITL gate 3 (task 036) runs against the HTML preview ONLY — human previews tokens + chrome + composition density + illustrations. Storybook is no longer part of gate 3 (per feat-074); it ships post-architect via `/stylesheet-primitives` step 7 and is reviewed implicitly by builders at build time, not by an HITL gate.

## Error handling

- `docs/selected-style.json` missing → abort: "`/stylesheet` requires `docs/selected-style.json`. Run `/mockups` first and complete gate 2."
- `SelectedStyleSchema` fails → abort with Zod error path and exit non-zero
- `packages/ui-kit/` skeleton missing → abort: "`packages/ui-kit/` skeleton not found. Run `/new-project <name> --force` to refresh scaffold."
- `--nanobanana` budget exhausted mid-download → write partial kit + `docs/design-system-gaps.md`, emit `budgetExhausted: true` in return JSON; orchestrator decides whether to retry with higher budget or surface to human
- `tokens.json` fails W3C DTCG schema validation → abort; either inputs were malformed or the generator has a bug
- `node-vibrant` fallback invoked BUT styles.md + brand-extracted.yaml both have complete palettes → abort; indicates a resolution-order bug. Fix step 3 before rerunning
- `pnpm typecheck` fails on the kit's agnostic surface (TS errors in tokens.ts / lib/\*.ts) → abort; surface TypeScript errors in return JSON's `warnings[]` and set `success: false`
- `globals.css` missing `@tailwind base/components/utilities` directives → abort with `globals-css-missing-tailwind-directives` (bug-077 invariant)
- `preview-bootstrap.html` missing or its inline `tailwind.config` block drifts from `tailwind.config.ts` → abort with `preview-bootstrap-drift` (refactor-007 invariant)

## Integration Points

- **Task 018** (`/scan-assets`): produces `docs/asset-inventory.json` — prerequisite (user assets have precedence)
- **Task 019** (`/analyze`): produces `docs/analysis/shared/styles.md` + `assets.md` — authoritative for tokens
- **Task 022** (ui-designer agent): invokes this skill with the winning style context
- **Task 022b** (UI Kit contract): consumer-contract artifact SKELETONS land inside `packages/ui-kit/` via `/new-project` step 5b; real implementations land via `/stylesheet-primitives` step 4 (NOT this skill — they reference React semantics)
- **Task 023** (`/mockups`): writes `docs/selected-style.json` (or gate 2 server does) + per-style manifest used for de-dup
- **Task 025** (`/screens`): composes screens from THIS skill's outputs ONLY (tokens.json, globals.css, preview-bootstrap.html, .components-plan.json); writes pure HTML; does NOT need primitives. Pins the kit version emitted here.
- **Task 025b** (`/visual-review`): LLM-critiques screens composed from this skill's tokens + chrome
- **Task 026** (Turborepo + pnpm workspace): `/new-project` step 5b scaffolds the monorepo baseline that this kit lives inside
- **Task 027** (shared packages skeleton): `/new-project` step 5b scaffolds empty `packages/ui-kit/` skeleton that this skill populates (agnostic surface) and `/stylesheet-primitives` later populates (React surface)
- **Task 032b** (`/verify-html`): validates `docs/design-system-preview.html`
- **Task 034b** (schemas): `StylesheetOutput` covers the union of this skill's + `/stylesheet-primitives`' return JSONs
- **Task 035** (orchestrator): invokes this skill after mockup gate 2 closes; propagates `--nanobanana` state. Per feat-074, the orchestrator ALSO dispatches `/stylesheet-primitives` post-/architect in parallel with gate-5
- **Task 036** (HITL gates): gate 3 serves the HTML preview (`docs/design-system-preview.html`) for human design-system review — Storybook moved out of gate 3 (feat-074)
- **Task 041** (MCP registration): provisions `icons8`, `unsplash`, conditionally `image-generator` at `/new-project` step 5b
- **feat-074** (factory): splits the original `/stylesheet` skill into pre-architect (this) + post-architect (`/stylesheet-primitives`); enables parallel project creation

## Related skills / files

- `.claude/skills/stylesheet/SKILL.md` — this file (agnostic core, pre-architect)
- `.claude/skills/stylesheet-primitives/SKILL.md` — sibling skill (React primitives, post-architect)
- `.claude/skills/mockups/SKILL.md` — preceding stage; de-dup partner
- `.claude/skills/screens/SKILL.md` — downstream consumer of this skill's HTML preview-bootstrap + tokens + components-plan
- `.claude/agents/ui-designer.md` — the agent whose identity this skill embodies
- `.claude/templates/ui-kit-contract.md` — 022b factory template for `CONTRACT.md`
- `.claude/templates/ui-kit-tsconfig-consumer.json` — 022b factory template for path aliases
- `.claude/templates/ui-kit-validate-consumer.ts` — 022b factory template for the grep validator
- `.claude/templates/ui-kit-eslint-plugin/` — 022b factory templates for the four ESLint rules (rules filled in by `/stylesheet-primitives` step 4)
- `scaffolding/09-034b-output-contract-zod-schemas.md` — defines `StylesheetOutput` + `SelectedStyleSchema`
- `scaffolding/21-035-orchestrator-core.md` — invokes this skill; post-stage retry logic; feat-074 added the `/stylesheet-primitives` auto-fire post-architect
- `scaffolding/22-036-hitl-gates.md` — gate 3 (design-system review) serves the HTML preview (post-feat-074)
- `scaffolding/11-041-mcp-server-registration.md` — `.mcp.json` provisioning
- `plans/active/feat-074-stylesheet-split-and-parallelize.md` — the plan that split the skill

## HITL gate 3 backing-server contract (task 036 must honor)

The artifact gate 3 reviews is **`docs/design-system-preview.html` ONLY** — the HTML preview generated by step 17. Storybook is no longer part of gate 3 (per feat-074); the React Storybook build moves to `/stylesheet-primitives` step 7, which runs post-architect outside the gate-3 review window. The user accepted this trade-off so the design-pipeline can finish without waiting for React-specific authoring (option 1 of 3 in investigate-028).

The gate server:

1. Serves `docs/design-system-preview.html` (and its referenced `/assets/` + `packages/ui-kit/src/styles/preview-bootstrap.html` resources) over HTTP (port assigned dynamically)
2. Surfaces a "Approve kit" / "Request changes" control
3. On approve → write `docs/signoff-stylesheet-{timestamp}.json` with `{ kitVersion, approvedAt, approvedBy, inputFingerprint, componentsApproved: [...] }`. The `componentsApproved` array is the FULL list of component names (from `.components-plan.json`) rendered on the preview. This is the handshake `/screens` reads to enforce: **any screen whose `components[]` array contains a name NOT in `componentsApproved` is rejected**. Prevents unreviewed components leaking into composed screens. The same signoff is consumed by `/stylesheet-primitives` to decide which extended primitives to author (only those in `componentsApproved[]`).
4. On "Request changes" → write `docs/design-system-feedback.md` with the reviewer's notes; orchestrator re-invokes this skill with the feedback as input context. If the reviewer objects to a specific component's look-and-feel, gate 3 can emit `componentsRejected: ["wallet-balance", ...]` which forces re-generation of only those entries in the next `/stylesheet` run.

Server lifecycle: started when orchestrator enters gate 3, killed when signoff is written. Port assigned dynamically; orchestrator passes the base URL to the reviewer.

## Acceptance criteria

- [ ] `.claude/skills/stylesheet/SKILL.md` exists with the frontmatter above (agnostic-core scope)
- [ ] Reads `docs/selected-style.json` and validates against `SelectedStyleSchema`
- [ ] Produces `packages/ui-kit/` matching the agnostic-core directory structure above
- [ ] `tokens.json` is W3C DTCG format with all required top-level keys (color / typography / spacing / radius / shadow / motion / zIndex)
- [ ] `tokens.css` + `tokens.ts` + `tailwind.config.ts` + `preview-bootstrap.html` are generated, not hand-authored
- [ ] `globals.css` starts with `@tailwind base/components/utilities` (bug-077 invariant)
- [ ] Dial → token mapping rules applied: `visual_density` drives spacing defaults, `motion_intensity` drives duration defaults, `design_variance` drives layout-template defaults
- [ ] `.components-plan.json` written with the full canonical + custom union (consumed by `/screens` AND `/stylesheet-primitives`)
- [ ] `--nanobanana` gates only the `illustrations/` step; everything else is always code-gen
- [ ] Illustrations fall back to unDraw vectors when `--nanobanana` is off
- [ ] `package.json` stub form: version `0.1.0-tokens-only`, exports only `./styles/*` + `./tokens/*`; no React peerDeps, no Storybook scripts (those land via `/stylesheet-primitives`)
- [ ] `docs/design-system-preview.html` covers every analyst-observed primitive + pattern + layout + custom component (verified by grep against `.components-plan.json`)
- [ ] Full asset-download wave respects budget; on exhaustion writes `docs/design-system-gaps.md` + partial kit
- [ ] De-duplicates against `docs/mockups/style-{K}/manifest.json.assets[]`
- [ ] Re-run with unchanged inputs is a no-op (`noChange: true` in return JSON; byte-identical agnostic surface)
- [ ] `packages/ui-kit/CHANGELOG.md` entry written per run
- [ ] Return JSON matches the agnostic subset of `StylesheetOutput` in task 034b
- [ ] Dark-mode derivation rules documented in `packages/ui-kit/src/tokens/README.md`
- [ ] Icon library resolution: `docs/selected-style.json.iconLibrary` is the single library the kit ships (refactor-003 — locked at gate 2, NOT from architect which runs later); user-supplied icons in `asset-inventory.json` still take precedence over library equivalents
- [ ] No primitives / patterns / layouts / barrel / Storybook authored here (those land in `/stylesheet-primitives`)
- [ ] Post-stage `/verify-html` invocation wired via orchestrator
- [ ] HITL gate 3 invariant: signoff binds `{ kitVersion, inputFingerprint }` — drift detection for downstream stages
- [ ] HITL gate 3 reviews HTML preview ONLY (no Storybook); user trade-off per feat-074

## Gate 3 Handoff (post-stage HITL pause)

When `/stylesheet` completes, the orchestrator pauses for human review of `docs/design-system-preview.html` (HTML preview only — Storybook is reviewed implicitly post-architect when `/stylesheet-primitives` ships it). To resume, write ONE of the following directives to **`docs/gate-3-approved.txt`**:

- **`proceed`** — design-system approved; pipeline continues to `/screens`. The kit version at `packages/ui-kit/package.json.version` (`0.1.0-tokens-only` at this stage) becomes the binding `uiKitVersion` for gate 4 sign-off. `/stylesheet-primitives` later bumps it.
- **`revise:<note>`** — reject with a note; pipeline halts. Hand-patch the kit OR re-run `/stylesheet` after editing inputs (e.g. `docs/selected-style.json` dials), then drop a fresh `proceed`.
- **`abort`** — stop the pipeline entirely.

The orchestrator recomputes the kit's `inputFingerprint` on drop; if `packages/ui-kit` is dirty relative to the fingerprint recorded at stage start, the gate rejects with `stale-kit` and the operator must re-run `/stylesheet` to produce a fresh preview.
