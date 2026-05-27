---
name: scan-assets
description: Detect and catalog user-supplied brand assets at ./assets/ into docs/asset-inventory.json. Run first during Analyst phase.
when_to_use: pipeline start, before mockups, when user mentions brand assets
argument-hint: (no args)
allowed-tools: Read Write Bash Grep Glob
---

# /scan-assets — Catalog User-Supplied Brand Assets

User assets ALWAYS override generated or researched assets (CLAUDE.md rule).
This skill walks `./assets/` and produces `docs/asset-inventory.json` — a
structured catalog that downstream agents (UI Designer, Web/Mobile Frontend
Builder) read to decide "use the user's logo" vs "generate one".

The skill MUST gracefully degrade when `./assets/` is missing or empty —
most projects don't have user assets, and the pipeline must keep running.

## Steps

### 1. Check if `./assets/` exists

- `[ -d assets ] && echo ok`
- If absent OR empty: write `docs/asset-inventory.json` with
  `{ "hasUserAssets": false }` and stop.
- `mkdir -p docs` first if `docs/` doesn't exist.

### 2. Glob the tree

- `ls -1 assets/**/* 2>/dev/null` (or Glob tool with `assets/**/*`)
- Skip `assets/README.md` — it's documentation, not an asset.

### 3. Catalog by subdirectory

The directory layout (from blueprint §6) is canonical:

| Subdirectory                  | Goes into inventory field | Notes                                 |
| ----------------------------- | ------------------------- | ------------------------------------- |
| `assets/logos/`               | `logos` (object)          | Keys: primary, mark, wordmark         |
| `assets/icons/`               | `icons` (array)           | Each SVG = one icon                   |
| `assets/fonts/`               | `fonts` (array)           | Group by family; collect weights      |
| `assets/images/hero/`         | `images.hero` (array)     | Per-screen hero images                |
| `assets/images/backgrounds/`  | `images.backgrounds`      | Tiling backgrounds                    |
| `assets/images/placeholders/` | `images.placeholders`     | Placeholder / empty-state imagery     |
| `assets/wireframes/`          | `wireframes` (array)      | PNG/PDF — screen name = filename stem |
| `assets/brand-guides/`        | `brandGuides` (array)     | PDFs, for later Analyst parsing       |
| `assets/colors.json`          | `colors` (object)         | Explicit palette override             |

Anything not matching these slots: include under `images.placeholders` as a
fallback, or note it in an `other` array if truly uncategorized.

### 4. Per-file enrichment

For each file, extract metadata appropriate to its type:

**SVG (logos, icons)**: read the file, grep for `viewBox="..."`:

```
grep -oE 'viewBox="[^"]+"' assets/logos/primary.svg | head -1
```

**Raster images (PNG/JPG/WebP — hero, backgrounds, placeholders,
wireframes)**: extract dimensions. Platform-aware:

- Try `identify -format "%wx%h" <file>` (ImageMagick, rarely on Windows)
- Fall back to Python PIL:
  `python -c "from PIL import Image; im=Image.open('<path>'); print(f'{im.width}x{im.height}')"`
- Fall back to filename parsing if neither works (e.g., `hero-1920x1080.png`)
- If dimensions can't be determined, omit them — don't block inventory.

**Fonts (.woff2/.ttf/.otf)**: detect format from extension, family from
filename convention (`<family>-<weight>.<ext>` → family, weight). No
fontconfig dependency — filename parsing is sufficient for the common case.
Group files under their shared family, collect weights into an array:

```
{ "family": "AcmeSans", "weights": [400, 700],
  "files": ["assets/fonts/acme-sans-400.woff2", "assets/fonts/acme-sans-700.woff2"] }
```

**colors.json**: parse as JSON. Validate each value is a `#` + 3/6/8 hex chars.
Skip invalid entries and note in a stderr warning; don't fail the scan.

**Wireframes**: screen name = filename stem. `admin-dashboard.png` →
`screen: admin-dashboard`. Keep the path.

**Brand guides (PDFs)**: just capture the paths. Downstream Analyst agent
parses them later — we don't extract content here.

### 5. Write `docs/asset-inventory.json`

Shape (blueprint §6):

```json
{
  "hasUserAssets": true,
  "logos": {
    "primary": { "path": "assets/logos/primary.svg", "viewBox": "0 0 240 60" },
    "mark": { "path": "assets/logos/mark.svg", "viewBox": "0 0 60 60" },
    "wordmark": { "path": "assets/logos/wordmark.svg", "viewBox": "0 0 360 60" }
  },
  "icons": [
    {
      "name": "search",
      "path": "assets/icons/search.svg",
      "viewBox": "0 0 24 24"
    }
  ],
  "fonts": [
    {
      "family": "AcmeSans",
      "weights": [400, 700],
      "files": [
        "assets/fonts/acme-sans-400.woff2",
        "assets/fonts/acme-sans-700.woff2"
      ]
    }
  ],
  "images": {
    "hero": [
      {
        "path": "assets/images/hero/dashboard.png",
        "width": 1920,
        "height": 1080
      }
    ],
    "backgrounds": [],
    "placeholders": []
  },
  "wireframes": [
    {
      "screen": "admin-dashboard",
      "path": "assets/wireframes/admin-dashboard.png"
    }
  ],
  "brandGuides": ["assets/brand-guides/brand-guide.pdf"],
  "colors": { "primary": "#6B9B37", "secondary": "#14b8a6" }
}
```

Use 2-space indentation. Keys in the order above. Omit empty top-level
fields ONLY if the category didn't exist at all — otherwise keep the empty
array/object so downstream code can always read `inventory.icons.length`
without branching on undefined.

### 6. Report to user

Report counts, not paths:

```
Asset inventory written: docs/asset-inventory.json
  Logos:       {N} ({primary? / mark? / wordmark?})
  Icons:       {N}
  Fonts:       {N} families, {M} files total
  Images:      {N} hero, {M} backgrounds, {L} placeholders
  Wireframes:  {N}
  Brand guides: {N}
  Colors:      {N} palette entries  (or "none — no colors.json")
```

## Graceful Degradation

- **`./assets/` missing**: `{ "hasUserAssets": false }`, exit 0
- **`./assets/` exists but empty**: same — `{ "hasUserAssets": false }`
- **`./assets/colors.json` malformed**: include `colors: {}` in inventory
  and print a stderr warning: `scan-assets: assets/colors.json is invalid JSON, skipped.`
- **A file has unreadable metadata** (e.g., corrupted PNG): include the path
  but omit the metadata fields. Don't abort the scan for one bad file.

## Edge Cases

- **No logos but other assets present**: `hasUserAssets: true` with
  `logos: {}`. UI Designer will fall back to generated logos.
- **A logo exists in `logos/` but doesn't match the primary/mark/wordmark
  naming convention**: put it under `logos.other` with the filename stem as
  the key. Don't drop it silently.
- **`assets/colors.json` contains named tokens that aren't hex**: accept
  them as-is only if they're valid CSS color names or CSS variables; else
  skip with a stderr warning. Downstream agents may expect hex.
- **Case mismatch on Windows** (e.g., `Assets/` vs `assets/`): always glob
  the lowercase `assets/`. Windows filesystems are typically case-insensitive
  so this works; warn if nothing matches and the user may have used a
  different case.
