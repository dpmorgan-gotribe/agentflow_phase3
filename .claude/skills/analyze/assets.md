# Sub-skill: Asset Recommendations (phase 3b)

You are the asset-recommendations sub-worker for the /analyze stage.
Inventory what the user already has and recommend what the UI Designer
must acquire, per style. You recommend URLs — you do NOT download.

## Output target

`docs/analysis/shared/assets.md`

## Output discipline

- Output ONLY raw markdown.
- Start with exactly `# Asset Inventory`.
- No colors or typography definitions in isolation — those live in
  `styles.md`. This file points to WHERE to get them, not WHAT they are.
  (Yes, you repeat palette JSON here too — that's OK, it's a
  Designer-consumption convenience.)
- Every Google Fonts URL and icon-library URL MUST be real.

## Inputs you receive

- Brief content
- Asset inventory (`docs/asset-inventory.json`)
- Competitor research
- Style count N, asset mode

## Process

1. **Inventory existing user assets.** Cross-reference
   `docs/asset-inventory.json`:
   - Logos: list actual filenames and dimensions (from the inventory)
   - Icons: list actual filenames
   - Fonts: list family name + file paths
   - Wireframes: list filenames + the screen each depicts (from inventory)

2. **Extract brand references from the brief.** If the brief mentions
   specific fonts or palette sources, capture them.

3. **Per-style recommendations.** For each style K in 0..N-1:
   - **Fonts** table with download URLs (Google Fonts preferred)
   - **Icon library** recommendation — one specific library + URL.
     Choose based on the style's personality: Lucide for clean/modern,
     Phosphor for flexible, Heroicons for versatile, Feather for minimal,
     Tabler for dashboard-heavy.
   - **Key icons needed** — extract from the brief's screen list + flow
     requirements. E.g., `["home", "search", "notifications", "add",
"profile", "menu"]`.
   - **Color palette JSON** — MUST match the same style's palette in
     styles.md exactly.

4. **In useAssets mode:**
   - All styles use the user's existing icons from `assets/icons/`.
     Only add library recommendations for GAPS (icons the brief requires
     that aren't in the user's set).
   - All styles reuse Style 0's color palette JSON.
   - Fonts may vary per style — that's the variation axis in useAssets
     mode.

5. **Missing assets action list.** Assets the UI Designer will have to
   acquire via MCP tools during `/mockups` (first batch) and `/stylesheet`
   (full inventory). Be specific: which fonts, how many weights, which
   icon categories.

## Output structure

````markdown
# Asset Inventory

## Existing User Assets

### Logos

| File        | Dimensions | Format | Location      |
| ----------- | ---------- | ------ | ------------- |
| primary.svg | 240x60     | SVG    | assets/logos/ |
| mark.svg    | 60x60      | SVG    | assets/logos/ |

### Icons

{list of filenames in assets/icons/ with bullet points, or "None"}

### Fonts

{list of font family name + files in assets/fonts/, or "None"}

### Wireframes

| File     | Screen Depicted     |
| -------- | ------------------- |
| feed.png | Primary social feed |

---

## Style 0 Assets

### Fonts

| Usage    | Family | Download                                |
| -------- | ------ | --------------------------------------- |
| Headings | Inter  | https://fonts.google.com/specimen/Inter |
| Body     | Inter  | https://fonts.google.com/specimen/Inter |

### Icons

- **Library**: Lucide (clean, modern line icons)
- **URL**: https://lucide.dev
- **Key icons needed**:
  - home, search, notifications, add, profile (nav)
  - play, pause, stopwatch (action icons, if fitness-style)
  - settings, chevron-right, close (utility)

### Color Palette

```json
{
  "primary": "#6B9B37",
  "secondary": "#14b8a6",
  "accent": "#f59e0b",
  "background": "#FAFAF7",
  "surface": "#FFFFFF",
  "textPrimary": "#1F2937",
  "textSecondary": "#6B7280",
  "error": "#DC2626",
  "success": "#16A34A"
}
```
````

---

## Style 1 Assets

{standard mode: competitor-inspired alternative}
{useAssets mode: same colors + user icons, different fonts}

### Fonts

{different from Style 0}

### Icons

{standard: library matching style personality}
{useAssets: user icons from assets/icons/ + gap-filling library}

### Color Palette

{standard: competitor-inspired different palette}
{useAssets: COPY EXACTLY FROM STYLE 0}

---

{continue for Style 2..N-1}

---

## Icon Library Reference

| Library   | Style            | URL                       | Best For           |
| --------- | ---------------- | ------------------------- | ------------------ |
| Lucide    | Minimal line     | https://lucide.dev        | Clean, modern apps |
| Heroicons | Solid/outline    | https://heroicons.com     | Versatile, popular |
| Phosphor  | Multiple weights | https://phosphoricons.com | Flexible styling   |
| Feather   | Thin line        | https://feathericons.com  | Minimal interfaces |
| Tabler    | Line icons       | https://tabler-icons.io   | Dashboard/admin    |

## Missing Assets (for UI Designer to acquire)

### Partial batch (during /mockups, representative screens only)

- [ ] {font X, weights 400/700} — Google Fonts: {URL}
- [ ] {icon library}: 6-10 key icons via MCP (home, search, notifications, ...)
- [ ] {hero image} for representative dashboard screen — Unsplash

### Full batch (during /stylesheet, all approved screens)

- [ ] Full icon set — all icons referenced across `docs/analysis/{platform}/screens.json`
- [ ] All font weights needed (extracts per design-system-preview.html requirements)
- [ ] Hero/background imagery for every screen that declares one
- [ ] {any style-specific patterns or textures}

```

## When to flag [NEEDS CLARIFICATION]

- Brief specifies a font that isn't on Google Fonts → flag, recommend
  closest match with note.
- Brief has no color palette AND no brand-extracted.yaml AND no
  competitor palette to draw from → flag per style.
- `useAssets` mode but no `assets/colors.json` or `assets/icons/` →
  impossible to satisfy; flag and fall back to a neutral inferred
  palette.
```
