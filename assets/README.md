# Factory assets

This directory is mostly a placeholder at factory level. Generated projects each get their own `projects/<slug>/assets/` directory cloned at `/new-project` time.

## What can live here at factory level

- Brand-agnostic icons / fonts that every project may want as a starting point (drop-only; agents won't pick from here unless an explicit operator decision is captured in `DECISIONS.md`)
- Reference visuals for the harness itself (architecture diagrams, agent-flow PNGs)
- Asset-pipeline test fixtures used by `scripts/scan-assets-*.test.mjs` (none currently)

## What does NOT live here

- Per-project assets — those go to `projects/<slug>/assets/` after `/new-project`
- Asset inventory output (`asset-inventory.json`) — that's per-project, lives at `projects/<slug>/docs/asset-inventory.json`
- Generated mockups, screens, ui-kit primitives — those are per-project pipeline outputs

## Per-project structure

When `/new-project <slug>` runs, the project's `assets/` is initialized empty. `/scan-assets` then walks it and emits `docs/asset-inventory.json` + `assets/INVENTORY.md`. The canonical per-project structure is documented inside `.claude/skills/scan-assets/SKILL.md`.
