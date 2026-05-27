---
name: pick-style
description: CLI-equivalent of HITL gate 2's /api/select — pick one style from /mockups output, write docs/selected-style.json, archive losing styles. Unblocks /stylesheet + /screens testing before task 036 (the full HTTP gate server) ships.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "--styleId=style-K [--no-archive]"
---

# /pick-style — Manual style selection

Out-of-order companion to `/mockups`. When `/mockups` runs in multi-style mode it defers to HITL gate 2 for style selection — gate 2's full HTTP server is task 036 (Phase F). This skill is the CLI-equivalent that lets humans pick a style from the command line so downstream skills (`/stylesheet`, `/screens`, `/visual-review`) can be exercised before 036 ships.

**This skill does NOT replace gate 2.** Gate 2 (036) provides the web UI + interactive dial editing + visual-diff review. `/pick-style` writes the same `docs/selected-style.json` contract, so downstream stages see identical output regardless of which path picked the style.

## Prerequisites

- `/mockups` completed; `docs/mockups/manifest.json` exists and lists ≥2 styles
- `docs/mockups/style-{K}/manifest.json` + `dials.yaml` exist for the chosen K
- `docs/analysis/shared/styles.md` + `assets.md` exist (read for iconLibrary + styleName)
- `docs/brief-summary.json` exists (read for detectedPlatforms → `appsCovered`)

## Arguments — `$ARGUMENTS`

- **`--styleId=<id>` (required)** — one of the style IDs in `docs/mockups/manifest.json.styles[].styleId` (e.g. `style-0`, `style-1`, ...)
- **`--no-archive`** (optional) — skip moving losing styles to `docs/mockups/archive/`. Useful when iterating: pick style-1 to test /stylesheet, then re-run `--styleId=style-0 --no-archive` without losing style-1's mockups. Default: archive losing styles.

## Steps

### 1. Parse + validate arguments

- Extract `--styleId` from `$ARGUMENTS`. If missing, error: `"/pick-style requires --styleId=<id>. Available IDs listed in docs/mockups/manifest.json."`
- Check `docs/mockups/manifest.json.styles[]` for a style with matching `styleId`. If not found, error with the list of available IDs.
- Extract `--no-archive` boolean flag.

### 2. Read inputs

- `docs/mockups/manifest.json` → locate the winning style's entry (`styleName`, `paletteSwatch`, `namedReferences`, `dials`, `mockupCount`)
- `docs/mockups/style-{K}/dials.yaml` → current dial values (may have been edited post-generation; take these over manifest's snapshot)
- `docs/mockups/style-{K}/manifest.json` → `nanobananaUsed` flag + per-style asset list
- `docs/analysis/shared/styles.md` → full style block for the cross-reference + confirm `stylesSourceRef` section anchor
- `docs/analysis/shared/assets.md` → find the winning style's lane block; extract the iconLibrary (e.g. `lucide`, `phosphor`, `tabler`, `heroicons`, `iconoir`)
- `docs/brief-summary.json` → `detectedPlatforms` array (copied into `appsCovered`)

### 3. Resolve the `stylesSourceRef` anchor

The spec requires a heading-anchor-style reference into `styles.md`. Construct it by finding the line in styles.md that matches `^## Style K:` (or `^## Style K ` with variants) and computing the GitHub-style anchor slug: lowercase, spaces → `-`, strip non-alphanumeric-except-dash. Emit `docs/analysis/shared/styles.md#style-K-{slug}`.

Example: for `## Style 0: Eco-Charcoal (brief canonical)` → anchor `#style-0-eco-charcoal-brief-canonical`.

If the exact slug can't be computed, fall back to `docs/analysis/shared/styles.md#style-K` (downstream skills can find the block via the `## Style K:` prefix anyway).

### 4. Assemble `docs/selected-style.json`

Write to `docs/selected-style.json`. Shape matches the `SelectedStyleSchema` (task 034b — refactor-003 adds `iconLibrary`):

```json
{
  "version": "1.0",
  "styleId": "style-0",
  "styleName": "Eco-Charcoal",
  "selectedAt": "2026-04-21T00:00:00Z",
  "selectedBy": "pick-style",
  "dials": {
    "design_variance": 2,
    "motion_intensity": 3,
    "visual_density": 5
  },
  "iconLibrary": "lucide",
  "appsCovered": ["webapp", "mobile", "admin"],
  "mockupsManifest": "docs/mockups/style-0/manifest.json",
  "stylesSourceRef": "docs/analysis/shared/styles.md#style-0-eco-charcoal",
  "nanobananaUsed": false
}
```

`selectedBy` MUST be `"pick-style"` to distinguish from `/mockups`'s `"auto-single-style"` fast path and from task 036's `"hitl-gate-2"` production path. This flag is a provenance record — downstream stages behave identically, but the lineage is auditable.

### 5. Archive losing styles (default)

Unless `--no-archive` is supplied:

- For every `docs/mockups/style-{K}/` directory where K ≠ the winning styleId:
  - Move to `docs/mockups/archive/style-{K}/`
  - If `docs/mockups/archive/style-{K}/` already exists from a prior pick, append a timestamp suffix: `docs/mockups/archive/style-{K}.bak-{ISO-timestamp}/`
- Leave `docs/mockups/index.html` + `docs/mockups/manifest.json` untouched — they remain a record of all 5 styles; the archive move just clears the working set for `/stylesheet` to pick up on the winner without ambiguity

With `--no-archive`: leave all `style-*/` directories in place. `/stylesheet` reads `docs/selected-style.json` directly to know which to use — the other directories become inert until the next pick.

### 6. Self-verify + report

Before reporting complete, verify:

- `docs/selected-style.json` exists and contains all 10 required fields
- `styleId` matches `--styleId` argument
- `selectedBy` is `"pick-style"`
- `mockupsManifest` path resolves (file exists)
- `stylesSourceRef` anchor references an existing heading in styles.md (at minimum the `## Style K:` prefix)
- If `--no-archive` was false: no directory at `docs/mockups/style-{K}/` remains for any K ≠ winner

Report:

```
Picked: style-0 (Eco-Charcoal)
Wrote: docs/selected-style.json
Archived: 4 losing styles to docs/mockups/archive/  [or: "No archive (--no-archive)"]
Icon library: lucide (from assets.md#style-0 lane)
Next: /stylesheet (builds @repo/ui-kit from the picked style)
```

Plus return JSON (stdout, one line per key):

```json
{
  "success": true,
  "styleId": "style-0",
  "styleName": "Eco-Charcoal",
  "selectedAt": "2026-04-21T00:00:00Z",
  "dials": { "design_variance": 2, "motion_intensity": 3, "visual_density": 5 },
  "iconLibrary": "lucide",
  "appsCovered": ["webapp", "mobile", "admin"],
  "archivedCount": 4,
  "selectedStylePath": "docs/selected-style.json"
}
```

## Edge cases

- **No `/mockups` output found** → abort: `/mockups has not run. Cannot pick a style without mockups. Run /mockups first.`
- **`--styleId` doesn't match any style in manifest** → list available IDs + their names, then error
- **Style already picked** (`docs/selected-style.json` exists): overwrite is fine — this is the CLI-equivalent of picking a different style in gate 2's UI. Do NOT require a --force flag; humans using /pick-style are expected to iterate. If you want to protect against accidental overwrite, check + confirm in the caller.
- **Single-style run (N=1)**: `/mockups` already auto-wrote `docs/selected-style.json` with `selectedBy: "auto-single-style"`. `/pick-style` can still run and overwrite (e.g. to change dial values manually). Record `selectedBy: "pick-style"` so the provenance is accurate.
- **Prior archive collision**: if `docs/mockups/archive/style-{K}/` already exists, append `.bak-{ISO-timestamp}` to the new archive path.

## Relationship to task 036 (HITL gate 2)

Task 036 (Phase F) will ship the full HTTP gate server with:

- `POST /api/dials/{styleId}` — real-time dial editing from the review UI
- `POST /api/select` — atomic style selection + archive move
- Web UI with iframe previews + viewport switcher + "Choose this style" buttons

Both entry points write the same `docs/selected-style.json` contract. Downstream skills (`/stylesheet`, `/screens`, `/visual-review`) can't tell which path picked the style, and don't need to. `/pick-style` exists to unblock those downstream skills for development testing **before 036 ships**; once 036 is live, `/pick-style` remains a useful CLI fallback for automation / scripting / headless runs.

## Integration Points

- **Task 023** (`/mockups`): produces inputs (`docs/mockups/manifest.json`, per-style dials + manifests)
- **Task 024** (`/stylesheet`): reads `docs/selected-style.json` written here
- **Task 025** (`/screens`): transitively depends (after `/stylesheet` builds the kit)
- **Task 034b** (schemas): `SelectedStyleSchema` defines the contract this skill produces
- **Task 036** (HITL gates): production-path equivalent; `/pick-style` is the dev-mode bypass

## Acceptance criteria

- [ ] `.claude/skills/pick-style/SKILL.md` exists with the frontmatter above
- [ ] Accepts `--styleId=<id>` + optional `--no-archive`
- [ ] Reads `docs/mockups/manifest.json` to validate styleId + resolve metadata
- [ ] Reads per-style `dials.yaml` (not manifest's snapshot — in case dials were edited)
- [ ] Reads `assets.md` for iconLibrary
- [ ] Writes `docs/selected-style.json` with all 10 required fields + `selectedBy: "pick-style"`
- [ ] Archives losing styles by default; `--no-archive` preserves them
- [ ] Handles re-pick (overwrite `docs/selected-style.json` without --force)
- [ ] Self-verifies 6 post-conditions before reporting complete
- [ ] Emits return JSON on stdout
- [ ] Error paths cover: missing mockups, invalid styleId, prior-archive collision
