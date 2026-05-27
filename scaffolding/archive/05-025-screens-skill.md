---
task-id: "025"
title: "/screens Skill + /user-flows-generator"
status: pending
priority: P2
tier: 6 — Design Pipeline
depends-on: ["024", "022b", "025b"]
estimated-scope: medium
---

# 025: /screens Skill + /user-flows-generator

## What This Task Produces

1. Skill at `.claude/skills/screens/SKILL.md` — composes every remaining screen from `@repo/ui-kit` only; supports batch and **single-screen** invocation (the latter is the retry path for task 025b `/visual-review`)
2. Skill at `.claude/skills/user-flows-generator/SKILL.md` — produces the navigable `docs/user-flows.html` for final sign-off
3. Template at `.claude/templates/user-flows-template.html`

## Why This Scope (per refactor-001)

Two important changes from the prior spec:

1. **Kit-consuming composition.** Screens are HTML previews — not React — so they consume the kit via its **CSS surface** (`tokens.css`, `globals.css`, `fonts.css`, and Tailwind utilities resolved through the kit's `tailwind.config.ts`), not via TypeScript imports. The primitives' visual contract is therefore: the HTML uses the same Tailwind utility classes the React primitive would emit, against the same token-driven Tailwind theme. Enforcement of this for HTML is **not** 022b's validate-consumer/ESLint (those skip `.html` files and target `.tsx?/jsx?` consumers — they activate at `/build-frontend` when HTML → JSX). For HTML, enforcement is: (a) the anti-slop grep shared with 023, (b) Layer 6 HTML verifier (032b — regex for raw hex, missing tokens), (c) Layer 7 visual-review (025b — rubric). If a screen needs a primitive/pattern/layout or variant that doesn't exist in the kit, the skill STOPS and requests a kit bump — it never builds locally.
2. **Single-screen invocation mode.** Task 025b's visual-review retry loop re-invokes `/screens` for a single failing screen with `retry-feedback.md` injected. The skill must accept `--screen {platform}/{screen-id}` as an alternate invocation mode that writes only that one file and returns minimal output.

## Scope

### /screens Skill

```yaml
---
name: screens
description: Generate all remaining screens (beyond the mockup gate's representative set) composing from @repo/ui-kit only. Supports single-screen retry invocation for /visual-review.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[--screen <platform>/<screen-id>] [--nanobanana]"
---
```

### Prerequisites

- `/stylesheet` completed — `packages/ui-kit/` exists at `ui-kit@1.0.0`; Storybook build succeeded
- `docs/selected-style.json` exists and validates
- `docs/analysis/{platform}/screens.json` exists per detected platform
- Task 022b artifacts present inside the kit (CONTRACT.md, eslint-plugin, validate-consumer.ts)

### Batch invocation (default)

1. Read `docs/brief-summary.json` → list of target platforms
2. For each target platform, read `docs/analysis/{platform}/screens.json` (v3.0 schema from task 019 phase 4) — the authoritative full screen list. Do NOT read `companion/navigation-schema.json` directly — that was a user input the Analyst already consumed; per-platform screens.json carries richer navigation + component + icon + flow data per screen.
3. Read `docs/selected-style.json` → the style to apply
4. Read `packages/ui-kit/src/index.ts` → catalog the available primitives / patterns / layouts
5. Identify screens still needing rendering (the set in `screens.json` minus the representative set already rendered by `/mockups`)
6. For each remaining screen in each platform's screens.json:
   a. Pick a **layout** from the kit matching the screen's `section` (e.g., `AppShell` for dashboards, `FocusedTask` for forms, `Marketing` for landing)
   b. Use the screen's `components[]` array to pick patterns + primitives from the kit's barrel; compose their equivalent HTML using the same Tailwind utility classes the React primitive would emit
   c. Use the screen's `icons[]` array to pick icon names from the kit's icon barrel; inline the icon SVG from `packages/ui-kit/src/icons/generated/` (the icons are shipped as both React components AND as standalone SVG files usable in HTML)
   d. Use the screen's `navigation` block to render header/footer/sidebar state
   e. Each HTML file begins with a `<link rel="stylesheet">` to `packages/ui-kit/src/styles/globals.css` (which `@import`s tokens.css and fonts.css). No other CSS is allowed in the HTML.
   f. **Emit `data-kit-*` attributes on every element that represents a kit primitive / pattern / layout.** These attributes are the deterministic translation key builders (029 / 030) use to convert HTML → JSX without pattern-matching on Tailwind class strings. Attribute schema:
   - `data-kit-component="<PascalCaseName>"` — names the kit component (e.g., `Button`, `Card`, `DataTable`)
   - `data-kit-variant="<variantKey>"` — the CVA variant passed as the `variant` prop
   - `data-kit-size="<sizeKey>"` — if the component has a size variant, the size key
   - `data-kit-props='<JSON>'` — stringified JSON of any other props to spread (e.g., `'{"disabled":true}'`)
   - `data-kit-layout="<LayoutName>"` — on the root wrapper of a screen, names the kit layout (e.g., `AppShell`, `SplitView`, `Marketing`)
   - Pure layout wrappers (`<div>` used for flex/grid) do NOT carry these attributes — builders leave them as `<div>` with layout-utility classes intact.
     g. **Consumer rule for HTML:** no inline styles; no arbitrary Tailwind values (`p-[13px]`); no raw hex; use only utility classes that resolve through the kit's `tailwind.config.ts`. Run the anti-slop grep from task 023 before writing.
     g. Write to `docs/screens/{platform}/{screen-id}.html`
7. Emit `docs/screens-manifest.json` with the SHA-256 set (see hash algorithm below)
8. Report progress in batches of 20. **Do NOT invoke `/user-flows-generator` from this skill** — the orchestrator (035) runs it after `/visual-review` has produced `docs/visual-review/report.json`, since the viewer embeds visual-review badges sourced from that report.

### Single-screen invocation — `--screen {platform}/{screen-id}`

Used by the visual-review retry loop (task 025b). When invoked with `--screen`:

1. Skip the manifest-hash calculation for the whole set (only one screen is affected)
2. Read `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` if it exists and **inject it into the generation prompt verbatim** so the model addresses the specific violations
3. Read `docs/screens/{platform}/{screen-id}.html` (the failing version) as context — the regenerated output must address the failed rules while preserving unchanged aspects
4. Generate only `docs/screens/{platform}/{screen-id}.html`
5. Leave all other files alone (do not touch other screens, user-flows.html, manifest hash, or sign-off)
6. Do NOT invoke `/user-flows-generator` from this path
7. Return minimal JSON: `{ "success": true, "screen": "webapp/dashboard", "attempt": <from orchestrator>, "feedbackApplied": true }`

The orchestrator (task 035) owns the retry counter and re-invokes `/visual-review` after this single-screen run completes.

### Kit-only composition — the hard rule

```
STOP and request a kit bump if:
- A screen needs a component not in the kit (missing primitive, pattern, or layout)
- A screen needs a variant not in the kit (e.g., Button "danger-outline" when only destructive exists)
- A screen needs an icon not in `packages/ui-kit/src/icons/`

Do NOT:
- Build the missing component locally
- Inline any styling to work around a missing variant
- Import from deep paths to access internals

When stopping, emit a `kit-change-request.md` at `docs/screens/kit-change-requests/{screen-id}.md` listing:
- What's missing
- Why this screen needs it
- Suggested API shape (e.g., `<Button variant="danger-outline">`)

The orchestrator (task 035) halts `/screens`, invokes **PM agent in `--mode=kit-change-request`** (refactor-003 dual-mode — see task 021), bumps the kit (via /stylesheet re-run), and resumes `/screens` once the kit is at a new minor version.

**Kit-change-request under refactor-003.** When `/screens` emits a kit-change-request during design, the orchestrator invokes PM in `--mode=kit-change-request` (writes `plans/active/kit-change-request-{id}.md` mini-plan), NOT the main PM tasks-graph mode. PM in kit-change-request mode reads only the emitted request + current kit version; it does NOT require `architecture.yaml` to exist yet. The main PM stage (post-architect) later subsumes any mini-plans that landed during design — each becomes a "Kit v1.X.Y: implement primitive Z per plans/active/kit-change-request-{id}.md" task entry in `docs/tasks.yaml`. Orchestrator (035 §Kit-change-request detour) owns the flow; 025 only needs to emit the request file.
```

### Batching strategy for large apps (450+ screens)

- Group by feature area and user journey
- Generate in batches of 20-40 per invocation
- Checkpoint contexts between batches
- Retry failed batches only, not entire set

### `--nanobanana` interaction

Same as `/mockups`: flag propagated by orchestrator; this skill trusts the MCP registry. When absent, hero/illustration usage inside screens falls back to Unsplash / unDraw / picsum per the hybrid fallback table. Record in return JSON.

### Anti-slop self-check (shared with 023)

Before writing each `*.html` file, run the same banned-pattern grep from task 023. One in-skill regeneration retry, then emit with warnings — Layer 6 (032b) and Layer 7 (025b) are the safety nets.

### /user-flows-generator Skill (blueprint lines 1872-1916)

1. Read `docs/screens/**/*.html` — catalog every rendered screen
2. Read `docs/analysis/{platform}/flows.md` per detected platform — the Analyst has already grouped screens into flows with 100% coverage; don't re-derive journeys, use what's there
3. Read `docs/brief-summary.json` for persona list
4. Merge per-platform flows into a unified manifest, tagging each flow with its platform
5. Generate `docs/user-flows-manifest.json`
6. Inject manifest into viewer template
7. Write `docs/user-flows.html`

### User Flows Viewer Template (blueprint lines 1922-1996)

Self-contained HTML with:

- Sidebar navigation by persona and journey
- iframe embedding current screen with device frame chrome
- Device switcher (mobile, tablet, desktop) — same viewport sizes as 025b: 390×844 / 820×1180 / 1400×900
- Target switcher (webapp, mobile, admin)
- Step annotations
- Visual-review badge per screen: pulls status from `docs/visual-review/report.json` — shows `pass` / `fail` / `needs-human-review` next to each screen link
- Sign-off form that `POST`s to the HITL gate server's `/api/signoff` endpoint (analogous to `/mockups`' `/api/select`). The gate server (task 036) receives the form body, validates against `signoff.schema.json`, recomputes the two hashes, rejects on mismatch, and on success writes `docs/signoff-{timestamp}.json` and returns 200. The static HTML cannot write files directly; the same `{{GATE_API_BASE}}` placeholder pattern from `/mockups` is used here.

### Sign-off JSON schema (blueprint lines 2002-2014)

The sign-off form MUST emit a file at `docs/signoff-{timestamp}.json` matching this exact schema — the orchestrator (task 036) watches for it and refuses to proceed without all fields:

```json
{
  "version": "1.0",
  "signedAt": "2026-04-14T16:15:42Z",
  "clientName": "Acme Corp / Jane Doe",
  "approved": true,
  "comments": "Free text from reviewer, may be empty string",
  "screensApproved": 483,
  "screensManifestHash": "sha256:7a3f2c1...",
  "visualReviewReportHash": "sha256:...",
  "uiKitVersion": "1.0.0"
}
```

Create `schemas/signoff.schema.json` (JSON Schema draft-07) enforcing:

- `version`: string, currently `"1.0"`
- `signedAt`: ISO-8601 timestamp (UTC, Zulu suffix)
- `clientName`: non-empty string
- `approved`: boolean — if false, pipeline halts for revisions
- `comments`: string (may be empty)
- `screensApproved`: integer, must equal the count in the manifest
- `screensManifestHash`: string, `sha256:` prefix + 64 hex chars
- `visualReviewReportHash`: string, `sha256:` prefix + 64 hex chars — locks in the visual-review state at sign-off time
- `uiKitVersion`: string, matches `packages/ui-kit/package.json.version` — ensures the sign-off is bound to a specific kit release

### Screens manifest hash algorithm (blueprint line 2017)

1. Build the manifest: sorted list of `{path, sha256}` for every file in `docs/screens/**/*.html`
2. Compute each file's SHA-256 over its bytes
3. Compute `screensManifestHash` = SHA-256 of the JSON-stringified sorted manifest (no whitespace, LF line endings)
4. Embed the hash in the viewer template as a hidden field; sign-off form submits it unchanged
5. Write the manifest itself to `docs/screens-manifest.json` for audit
6. Compute `visualReviewReportHash` the same way over `docs/visual-review/report.json`

Orchestrator (task 036) re-computes both hashes when it detects the sign-off file. If either hash doesn't match the current state, the sign-off is rejected — enforcing "if anything changes after sign-off, a new sign-off is needed" (L2017) **and** "a sign-off binds a specific visual-review state."

### Versioning archive (blueprint lines 2019-2022)

Every `/screens` run — not just the first — must:

1. Before generating, check if `docs/user-flows.html` already exists
2. If yes, copy it to `docs/user-flows-archive/{previous-timestamp}.html` (derive timestamp from the existing file's sign-off, or file mtime as fallback)
3. If a corresponding `docs/signoff-{timestamp}.json` exists, copy it alongside to the archive directory
4. Generate the new `docs/user-flows.html`

Single-screen invocations do NOT trigger archiving (only one file changed; user-flows.html regenerates at the next full batch run).

### Return JSON

**Batch invocation:**

```json
{
  "success": true,
  "styleId": "style-03",
  "uiKitVersion": "1.0.0",
  "screensGenerated": 48,
  "batches": [{ "batchId": 1, "screens": 20, "duration": "2m14s" }],
  "failedScreens": [],
  "kitChangeRequests": [],
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 4,
  "imagesVectorFallbackCount": 0,
  "screensManifestHash": "sha256:..."
}
```

**Single-screen invocation (`--screen` mode):**

```json
{
  "success": true,
  "screen": "webapp/dashboard",
  "attempt": 2,
  "feedbackApplied": true,
  "nanobananaUsed": false
}
```

## Integration Points

- **Task 022** (UI Designer agent): invokes this skill
- **Task 022b** (UI Kit contract): CONTRACT.md rules apply — this skill is the first big consumer; `validate-consumer.ts` should pass on the generated HTML (adapted to HTML, not just TS/TSX)
- **Task 023** (/mockups): consumed the representative set; `/screens` handles the remainder. Anti-slop grep patterns re-used.
- **Task 024** (/stylesheet): produced `packages/ui-kit/` at `1.0.0` — this skill pins that version
- **Task 025b** (/visual-review): runs after this skill's batch invocation; re-invokes in single-screen mode on failure
- **Task 032b** (/verify-html): Layer 6 runs post-stage; its violations feed Layer 5 retry
- **Task 034b** (schemas): `ScreensOutput` schema must cover both batch and single-screen return shapes; `SignoffOutput` schema adds `visualReviewReportHash` + `uiKitVersion`
- **Task 035** (orchestrator): invokes in batch mode by default; invokes in `--screen` mode from the visual-review retry loop; owns retry counters
- **Task 036** (HITL gates): consumes `docs/user-flows.html` as the final sign-off gate; rejects sign-offs with stale hashes

## Acceptance Criteria

- [ ] Both skills exist as SKILL.md files
- [ ] `/screens` reads `docs/analysis/{platform}/screens.json` as primary source (NOT `companion/navigation-schema.json`)
- [ ] `/screens` reads `docs/selected-style.json` and `packages/ui-kit/package.json` version
- [ ] **Kit-only rule** documented and enforced: missing components trigger `docs/screens/kit-change-requests/{screen-id}.md` and halt the batch
- [ ] Anti-slop self-check reused from task 023
- [ ] **Single-screen mode** accepts `--screen {platform}/{screen-id}` and consumes `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` when present
- [ ] Single-screen mode writes only the one target file; does not regenerate manifest, user-flows.html, or archive
- [ ] Single-screen mode returns minimal JSON with `screen`, `attempt`, `feedbackApplied`
- [ ] Batching strategy documented for large apps (20-40 per batch; retry failed batches only)
- [ ] `/user-flows-generator` reads `docs/analysis/{platform}/flows.md` instead of re-deriving journeys
- [ ] User flows template is self-contained HTML (no build step)
- [ ] Viewer template embeds visual-review badges (pass / fail / needs-human-review) per screen
- [ ] Viewer device-switcher viewports match 025b (390×844 / 820×1180 / 1400×900)
- [ ] `schemas/signoff.schema.json` created with the nine required fields (adds `visualReviewReportHash` + `uiKitVersion`)
- [ ] Sign-off form produces `docs/signoff-{timestamp}.json` matching the schema
- [ ] Manifest hash algorithm implemented for BOTH screens AND visual-review report; `docs/screens-manifest.json` written alongside
- [ ] Orchestrator rejects sign-off when either hash is stale OR uiKitVersion differs from `packages/ui-kit/package.json`
- [ ] `docs/user-flows-archive/` directory populated on each full-batch re-run (previous version preserved); single-screen invocations do NOT trigger archiving
- [ ] FINAL HITL GATE noted: "client signs off on user flows before code generation"
- [ ] Batch return JSON matches `ScreensOutput` in 034b; single-screen return JSON matches the minimal shape
- [ ] `/screens` does NOT auto-invoke `/user-flows-generator`; orchestrator owns the screens → visual-review → user-flows-generator sequence
- [ ] HTML consumption mechanism documented: `<link>` to kit globals.css, inline SVG icons from `icons/generated/`, Tailwind utilities resolved via kit config. Enforcement for HTML is anti-slop grep + 032b + 025b — NOT 022b's validate-consumer (which targets TS/TSX)
- [ ] Sign-off form uses `POST /api/signoff` to the HITL gate server (036); `{{GATE_API_BASE}}` placeholder threaded through same as 023
- [ ] Kit-change-request detour flow flagged as a cross-task dependency on 021 (PM) + 035 (orchestrator)
- [ ] `data-kit-*` attribute contract emitted on every HTML element that corresponds to a kit primitive / pattern / layout (schema: `data-kit-component`, `data-kit-variant`, `data-kit-size`, `data-kit-props`, `data-kit-layout`); builders 029 / 030 read these for deterministic HTML → JSX translation

## Human Verification

1. Run `/screens` in batch mode after `/stylesheet` succeeded. Are all remaining screens rendered? Does every HTML file import from kit CSS/tokens only — no raw hex, no arbitrary Tailwind values?
2. Hand-inject a screen whose `components[]` requires a primitive not in the kit (e.g., a `<Breadcrumbs>` when only `Breadcrumb` exists). Does `/screens` halt, write `docs/screens/kit-change-requests/{screen-id}.md`, and stop the batch?
3. Run `/screens --screen webapp/dashboard` after authoring `docs/visual-review/webapp/dashboard/retry-feedback.md`. Does the regenerated HTML address the feedback? Are other screens untouched?
4. Open `docs/user-flows.html`. Does every screen link carry a visual-review badge?
5. Sign off in the viewer. Does `docs/signoff-{timestamp}.json` include `visualReviewReportHash` and `uiKitVersion`?
6. After sign-off, edit one screen by hand. Does the orchestrator reject the sign-off as stale when re-evaluating?
7. Bump `packages/ui-kit/package.json.version` from `1.0.0` to `1.1.0`. Does the orchestrator reject the sign-off because uiKitVersion differs?

## Additional Notes

This is the most important gate in the pipeline. Sign-off binds four things together: (a) the full rendered screen set, (b) the visual-review state, (c) the UI Kit version, (d) the client's approval timestamp. Any of those changing invalidates the sign-off.
