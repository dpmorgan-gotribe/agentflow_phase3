---
task-id: "018"
title: "/scan-assets Skill (Asset Scanner)"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["001"]
estimated-scope: small
---

# 018: /scan-assets Skill

## What This Task Produces

A skill at `.claude/skills/asset-scanner/SKILL.md` that detects and catalogs user-supplied brand assets.

## Scope

From blueprint lines 656-696:

### SKILL.md

```yaml
---
name: asset-scanner
description: Detect and catalog user-supplied brand assets at ./assets/. Run first during Analyst phase.
when_to_use: pipeline start, before mockups, when user mentions brand assets
allowed-tools: Read Bash Glob
---
```

### Skill Steps

1. Check if `./assets/` exists — if not, write empty `docs/asset-inventory.json`
2. Glob `./assets/**/*` and catalog by subdirectory
3. For images: extract dimensions via `file` or `identify`
4. For fonts: detect format and family name from filename
5. For logos/icons (SVG): read file to get viewBox
6. For `colors.json`: parse and validate hex values
7. For wireframes: note screen/page name from filename stem
8. For brand-guide PDFs: mark for later parsing by Analyst
9. Write `docs/asset-inventory.json`

### Output Format

The JSON structure from blueprint lines 677-695 with: `hasUserAssets`, `logos`, `icons`, `fonts`, `images`, `wireframes`, `brandGuides`, `colors`.

### Graceful Degradation

If `assets/` is empty or missing, produce `{ "hasUserAssets": false }` and continue without error.

## Acceptance Criteria

- [ ] `.claude/skills/asset-scanner/SKILL.md` exists
- [ ] Handles missing/empty assets directory gracefully
- [ ] Output JSON format matches blueprint specification
- [ ] Catalogs all six asset types (logos, icons, fonts, images, wireframes, brand-guides)
- [ ] Writes to `docs/asset-inventory.json`

## Human Verification

Drop a test SVG logo and a colors.json into assets/ — does the skill's logic produce the expected inventory?
