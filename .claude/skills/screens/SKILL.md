---
name: screens
description: Generate all remaining screens (beyond the /mockups representative set) composing from @repo/ui-kit only. Emits data-kit-* attributes for deterministic HTML → JSX translation by builders. Supports single-screen retry invocation used by /visual-review's retry loop.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "[--screen <platform>/<screen-id>] [--nanobanana]"
---

# /screens — Kit-only screen composition

Fourth design-pipeline stage (after `/analyze` + `/mockups` + gate 2 + `/stylesheet` + gate 3). Composes every remaining screen from `packages/ui-kit`'s CSS + icon surfaces into `docs/screens/{platform}/{screen-id}.html`. The single-screen mode is the retry path `/visual-review` (task 025b) fires when a screen fails its rubric.

Screens are HTML previews (not React) — builders (tasks 029 / 030) convert to JSX later. That conversion is deterministic because every kit-component instance carries `data-kit-*` attributes that name its component / variant / size / props.

## Prerequisites

- `/stylesheet` (slimmed, framework-agnostic — feat-074) completed: `packages/ui-kit/src/tokens/`, `packages/ui-kit/src/styles/` (including `preview-bootstrap.html`, `globals.css`, `tailwind.config.ts`), and `docs/design-system-preview.html` all exist. React primitives + Storybook do NOT exist yet — those land via `/stylesheet-primitives` post-architect.
- `docs/selected-style.json` exists and validates against `SelectedStyleSchema` (034b)
- `docs/signoff-stylesheet-{timestamp}.json` exists (gate 3 has sealed the kit; gate-3 reviews the HTML design-system-preview only — Storybook moves to a post-architect review surface)
- `docs/analysis/{platform}/screens.json` (v3.0) exists per detected platform
- `docs/analysis/shared/components.md` exists (produced by `/analyze` step 6e) + `.components-plan.json` in the kit (produced by `/stylesheet` step 8.5)
- Task 022b artifacts (CONTRACT.md, eslint-plugin/, scripts/validate-consumer.ts, tsconfig.consumer.json) are **post-architect** outputs of `/stylesheet-primitives`. `/screens` does NOT consume them (they enforce builder discipline against React primitives, which don't yet exist).

## Inputs (ordered by authority)

1. `docs/selected-style.json` → styleId, iconLibrary, dials, uiKitVersion (implicit via `packages/ui-kit/package.json.version`)
2. `docs/signoff-stylesheet-{timestamp}.json` → `componentsApproved[]` — the load-bearing allowlist. **Any screen whose `components[]` contains a name NOT in `componentsApproved` is rejected by this skill** (it emits a kit-change-request instead).
3. `docs/analysis/{platform}/screens.json` (v3.0) per platform → authoritative full screen list with per-screen `navigation`, `components[]`, `icons[]`, `flows[]`. Do NOT read `companion/navigation-schema.json` — that was a user input the Analyst already consumed.
4. `packages/ui-kit/.components-plan.json` → map of analyst-name → PascalCase kit-name + custom-pattern set. (Pre-feat-074 this skill also read `packages/ui-kit/src/index.ts` for the live primitive catalog; that barrel is now authored post-architect by `/stylesheet-primitives`. `.components-plan.json` is the authoritative source pre-architect.)
5. `packages/ui-kit/package.json.version` → pinned into every screen's return manifest + sign-off contract. Pre-feat-074 the version was `1.0.0`; with the split, this skill consumes the `0.1.0-tokens-only` stub written by slimmed `/stylesheet`. `/stylesheet-primitives` later bumps to `0.2.0-primitives` post-architect.
6. `docs/mockups/style-{K}/manifest.json` for the winning K → identifies screens already rendered at `/mockups` time; those are NOT regenerated (handled by the representative-set subtraction below).
7. `docs/analysis/shared/components.md` → cross-platform component inventory (for the kit-only check + usage-count reporting).

## Arguments — `$ARGUMENTS`

Two optional forms:

- **`--screen <platform>/<screen-id>`** — single-screen retry mode (see §Single-screen invocation). Used by `/visual-review`'s retry loop.
- **`--nanobanana`** — boolean flag; propagated by orchestrator. Same semantics as `/mockups`: trusts `.mcp.json` for actual server registration.

Default (no flags) is batch mode over all remaining screens across all detected platforms.

## Batch invocation (default)

### 1. Load inputs

- Read `docs/brief-summary.json` → `detectedPlatforms[]`
- Read `docs/selected-style.json` → `styleId`, `iconLibrary`
- Read `packages/ui-kit/package.json` → `version` (pin this into the return JSON)
- Read the most-recent `docs/signoff-stylesheet-{timestamp}.json` → extract `componentsApproved[]`
- Read `packages/ui-kit/.components-plan.json` → maps analyst-name → kit PascalCase
- Read each `docs/analysis/{platform}/screens.json` into memory

### 2. Identify remaining screens

For each platform:

- Full set = all screens in `screens.json.app.screens[]`
- Already-rendered set = screen IDs appearing in `docs/mockups/style-{K}/manifest.json.mockups[]` (the representative set from `/mockups`)
- Remaining set = full set − already-rendered set. Generate HTML for every screen in remaining set.

Note: `/mockups` produces one representative per app-per-style. The mockups directory for losing styles was archived by gate 2 / `/pick-style`. Only the winning style's mockups count as "already rendered" against downstream regeneration — those files live under `docs/mockups/style-{K}/{app}/{screen}.html` and are re-copyable to `docs/screens/{platform}/{screen-id}.html` directly if their `components[]` matches (and the `data-kit-*` attribute pass has been applied — see step 4).

### 3. Enforce the kit-only rule BEFORE writing any screen

For each remaining screen, union its `components[]` + `icons[]` against `componentsApproved[]` (from gate 3 signoff). Any mismatch →

- Emit `docs/screens/kit-change-requests/{platform}-{screen-id}.md` with:
  - Screen ID + path + which missing component / variant / icon triggered
  - Why the screen needs it (quoted description from screens.json)
  - Suggested API shape (e.g., `<Button variant="danger-outline">` or `<Breadcrumbs>` (plural, if only `Breadcrumb` singular exists)
- **Halt the batch.** Emit return JSON with `success: false, kitChangeRequests: [...]` and exit.

Orchestrator (035) halts this skill, invokes **PM agent in `--mode=kit-change-request`** (refactor-003 — task 021), which writes `plans/active/kit-change-request-{id}.md`. The orchestrator then bumps the kit via `/stylesheet` re-run (minor bump if adding component/variant; patch if fix), closes gate 3 on the new kit version, and resumes `/screens` once the kit version has advanced.

**Kit-change-request minimum viable trigger set:**

- A `components[]` name maps to a kit PascalCase in `.components-plan.json` BUT that PascalCase isn't in `componentsApproved[]` (rejected at gate 3)
- A `components[]` name doesn't map anywhere (analyst invented a new composition post-gate-3)
- A `variants` field in screens.json names a CVA variant not present in the primitive's `.variants.ts`
- An `icons[]` name isn't in `packages/ui-kit/src/icons/generated/`

### 3.5. Build the shared preamble — coherence across parallel agents

Before fanning out composition agents, assemble a single **shared-preamble** block that EVERY concurrent ui-designer subagent receives identically. This is the "same starting ink" for every parallel agent — prevents subtle drift without requiring `/visual-review` (025b) to catch every copy-voice / density / imagery inconsistency after the fact.

**The preamble is the single source of per-run coherence.** It is assembled once at the start of a batch run and included verbatim at the top of every agent prompt.

**Required preamble sections:**

1. **Style block (authoritative, verbatim from `docs/analysis/shared/styles.md#{stylesSourceRef}`)** — full palette (9 color tokens with hex), typography (heading/body/mono families + scale), spacing scale, radius + shadow + density, dials. Agents do NOT re-derive these; they read them from the preamble.

2. **Kit reference** — `uiKitVersion` + path to `globals.css` + the analyst-name → kit-PascalCase map (from `.components-plan.json`). Agents use ONLY these names in `data-kit-component` attributes.

3. **Chrome rules (extracted from brief §2)** — the global chrome pattern derived from the winning style's mockup output (header bg, sidebar visibility, notification-badge color, logo placement). Copied verbatim from the mockup file `docs/mockups/style-{K}/{platform}/{archetype}.html`'s header/footer structure.

4. **Voice + copy rules** — a short explicit block the skill extracts from brief §2 plus hard defaults:

   ```
   Voice: {from brief §2, e.g. "adult-serious", "irreverent", "warm-editorial"}
   Button labels: Sentence case ("Start a project", NOT "Start A Project" or "START A PROJECT")
   Headings: Sentence case (first word capitalised, rest lowercase unless proper noun)
   Metadata labels (form labels, table headers): Sentence case
   Helper text + body copy: sentence case, full sentences, ending with a period
   Never use clichés: no "Elevate", "Seamless", "Unleash", "Next-Gen", "Empower", "Transform your"
   ```

5. **Imagery seed convention** — ONE explicit pattern for picsum seeds + one for avatar seeds so agents don't each invent their own naming:

   ```
   Hero / content imagery: picsum.photos/seed/{project}-{noun-phrase-kebab}/{w}/{h}
     e.g. gotribe-tribe-findhorn, gotribe-event-harvest
   Avatars: picsum.photos/seed/{project}-avatar-{slug}/{size}/{size}
     e.g. gotribe-avatar-sarah-wei, gotribe-avatar-marcus-brennan
   ```

6. **Empty-state + error-state copy defaults** — short canonical pattern every agent falls back to:

   ```
   Empty: "No {noun-plural} yet." + optional helper sentence + primary action
     e.g. "No proposals yet." / "Be the first to start a governance thread." / "New proposal"
   Error (inline): "Couldn't load {noun}." + recovery button labeled "Retry" or "Refresh"
   Error (full-page): "Something went wrong." + 1-sentence context + primary button to home
   ```

7. **Density dial interpretation** — the numeric `visual_density` is re-stated as concrete defaults so two parallel agents reading the dial pick the same spacing:

   ```
   visual_density: {N}
   → default padding inside cards: spacing.{X}
   → default gap between list items: spacing.{Y}
   → default line-height body: {Z}
   → table row height: {H}px
   ```

**Write the preamble to `docs/screens/.shared-preamble.md`** at the start of a batch run. Every spawned agent prompt begins with: "Read `docs/screens/.shared-preamble.md` verbatim. It is the coherence contract for this run. Do not deviate." Retry attempts use the same file — so a re-run inherits the identical starting ink.

**Single-screen mode (`--screen`) ALSO reads `.shared-preamble.md`** so retry-fix agents respect the same contract. If the file is missing (edge case), abort with a message instructing to run batch mode once first.

### 4. Compose each remaining screen

For each screen in the remaining set:

**4a. Pick the layout.** Map the screen's `section` → kit layout:

| screens.json `section`          | Layout                    |
| ------------------------------- | ------------------------- |
| `dashboard`, `home`, `discover` | `AppShell`                |
| `form`, `wizard`, `auth-action` | `FocusedTask`             |
| `list-detail`, `split`          | `SplitView`               |
| `marketing`, `landing`, `hero`  | `Marketing`               |
| `signin`, `signup`, `auth`      | `Auth`                    |
| anything else                   | `AppShell` (safe default) |

The chosen layout's PascalCase name is emitted as `data-kit-layout="AppShell"` on the root `<body>` wrapper.

**4b. Use the `components[]` array to compose.** For each component name, look up its kit equivalent in `.components-plan.json`. Emit the HTML equivalent of what the React primitive would render, using the same Tailwind utility classes the primitive's `.variants.ts` would produce. Every kit-component emission carries the `data-kit-*` attribute set (see §5).

**4c. Use the `icons[]` array.** For each icon name, inline the SVG from `packages/ui-kit/src/icons/generated/{name}.svg` directly into the HTML. Icons inherit `currentColor` from their parent so the kit's text-color tokens propagate automatically.

**4d. Use the `navigation` block** (from screens.json per-screen) to render header / footer / sidebar states. Match `header.variant`, `footer.variant`, `sidemenu.visible` + items + active-section exactly.

**4e. CSS linkage.** Each HTML file's `<head>` contains TWO things — a `<link>` to the kit's `globals.css` AND the kit's preview-bootstrap fragment (Tailwind Play CDN + inline `tailwind.config`). Both are required. Without the bootstrap, every Tailwind utility class (`bg-accent-500`, `font-display`, `rounded-md`, etc.) resolves to nothing and the screen renders unstyled — the kit's `globals.css` only provides token CSS variables + a base reset, NOT compiled Tailwind utilities.

```html
<!-- 1. Kit tokens + reset + Google Fonts (CSS variable definitions) -->
<link rel="stylesheet" href="../../../packages/ui-kit/src/styles/globals.css" />

<!-- 2. Tailwind Play CDN — compiles utility classes against the kit's theme -->
<script src="https://cdn.tailwindcss.com"></script>
<script>
  // The inline tailwind.config block is read verbatim from
  // packages/ui-kit/src/styles/preview-bootstrap.html — do NOT hand-author.
  tailwind.config = {
    /* kit-derived theme.extend referencing var(--color-*) */
  };
</script>
```

The script + config block come from `packages/ui-kit/src/styles/preview-bootstrap.html` — `/stylesheet` step 7 emits it. Read that file at `/screens` time and inline its contents verbatim after the `<link>`. **Do NOT hand-roll the script tag or the config object** — the file IS the contract; out-of-sync configs cause subtle palette drift across screens. If the file doesn't exist, abort with: `preview-bootstrap.html missing — re-run /stylesheet to regenerate.`

No inline `<style>` blocks anywhere else. No external CSS beyond the kit's `globals.css` link + the Tailwind CDN script. Anti-slop checks (step 7) verify both the link AND the bootstrap presence.

**Production-time builders are unaffected.** `/build-web` and `/build-mobile` translate HTML→JSX and run a real Tailwind build at app-build time. The Play CDN is preview-only — it makes design-pipeline HTML render correctly in a browser without a build step. Production apps don't ship the CDN.

**4e.1. Screen identity attribute on `<body>` (feat-022 — flow-driven E2E + reachability).** Every screen's root `<body>` element MUST carry `data-screen-id="{screen-id}"` — exactly the kebab-case screen id used in the file path (`docs/screens/{platform}/{screen-id}.html` → `data-screen-id="{screen-id}"`). This is the single thread the post-build flow synthesizer (`/build-to-spec-verify`) uses to assert "after clicking X on screen A, the page now shows screen B". One attribute per screen, machine-grep-stable.

```html
<!-- docs/screens/webapp/home.html -->
<body data-kit-layout="AppShell" data-screen-id="home">
  ...
</body>

<!-- docs/screens/webapp/card-modal.html -->
<body data-kit-layout="FocusedTask" data-screen-id="card-modal">
  ...
</body>
```

The attribute mirrors the file's basename without `.html`. The same value is required on the page-root render in built React/Svelte code (see the corresponding stack skills' §1 / §2). Without it, the synthesizer cannot tell whether a click landed on the expected exit-screen and falls back to URL-pattern heuristics — fragile and likely to false-fire on SPAs where one URL renders multiple screens. Add this BEFORE writing each `*.html`; the anti-slop self-check (step 7) verifies presence.

**4e.2. Theme opt-out attribute on `<html>` (refactor-007.1 — second silent-styling guard).** Every screen's root `<html>` element MUST set `data-theme` to the picked style's mode — `"light"` for light-default styles, `"dark"` for dark-default. Read the picked style's `characteristics` block in `docs/analysis/shared/styles.md` (or the resolved `surface.base` color in `docs/selected-style.json` — surface.base = `#FFFFFF` or near-white → `light`; surface.base = near-black → `dark`).

```html
<html lang="en" data-theme="light">
  <!-- light-default style (Editorial Vercel, Quiet Telemetry, etc.) -->
</html>
```

```html
<html lang="en" data-theme="dark">
  <!-- dark-default style (Dense Console, Midnight Press, etc.) -->
</html>
```

Without this attribute, the kit's `tokens.css` `prefers-color-scheme: dark` media query auto-flips a light-default style to dark colors when the reviewer's OS is in dark mode — turning a chosen white-canvas into black silently. The attribute opts OUT of system-preference auto-switching and pins the screen to the picked style's authored mode.

The `design-system-preview.html` already follows this convention (`<html lang="en" data-theme="light">`). Match it on every screen so the reviewer sees the same chrome on both surfaces.

**Path-depth reminder:** screens live at `docs/screens/{platform}/{screen-id}.html` — 3 directory hops from project root. Relative paths from that depth are:

- Kit CSS: `../../../packages/ui-kit/src/styles/globals.css` (3 hops)
- User logo: `../../../assets/logos/{file}.png` (3 hops)
- User icons: `../../../assets/icons/{name}.svg` (3 hops)
- Mockup cross-reference: `../mockups/archive/style-{K}/{platform}/{screen}.html` (kept here for convenience)

Count hops deliberately. A 4-hop path (`../../../../`) lands at `projects/` parent and silently 404s at runtime — the browser shows broken images and no stylesheet, which surfaces as "no CSS at all" in review.

**4f. No wordmark text next to the user logo (anti-pattern propagated from /mockups).** When referencing `assets/logos/{file}.png` via `<img>`, do NOT add a separate `<span>` / `<h1>` rendering the project name as text next to it. The logo file is the complete brand lockup. If the design requires a visible wordmark and the user's logo is the mark only (no text baked in), that's a deliberate brand choice — respect it. Verifier: grep each HTML for `<span[^>]*class="[^"]*(?:wordmark|brand-word|logo-word|brand-name|brandText|word-mark)"` or any `<span>` / `<h1>` / `<h2>` immediately following a logo `<img>` element and containing only the project name; if found, flag as anti-pattern violation and strip.

**4g. Mobile-frame convention (mobile platform only).** Mobile screens render inside a centered 390×844 device-frame wrapper so reviewers see the screen at phone scale, not viewport-width. Every mobile HTML emits identical wrapper markup:

```html
<body
  style="margin: 0; background: var(--color-neutral-100); display: grid; place-items: center; min-height: 100vh;"
>
  <div
    class="phone-frame"
    style="width: 390px; height: 844px; background: var(--color-surface-base); border-radius: 48px; padding: 14px; box-shadow: 0 30px 60px rgba(0,0,0,0.35); border: 1px solid #1a1a1a; overflow: hidden; position: relative; display: flex; flex-direction: column;"
  >
    <header style="flex-shrink: 0; /* header chrome — fixed height */">
      ...
    </header>
    <main
      style="flex: 1; min-height: 0; overflow-y: auto; /* THIS is the scroll region */"
    >
      ...
    </main>
    <nav style="flex-shrink: 0; /* bottom tab bar — fixed height */">...</nav>
  </div>
</body>
```

**Critical:** frame uses `height: 844px` (NOT `min-height`) so it never expands past phone size. Inner content uses `display: flex; flex-direction: column` with the middle `<main>` set to `flex: 1; min-height: 0; overflow-y: auto` — this is the ONLY scroll region. Header + tab bar stay pinned with `flex-shrink: 0`. If you use `min-height: 844px` + `overflow: hidden` (the common wrong pattern), the frame grows past phone size and clips content without scrolling — image assets below the clip line silently vanish from the reviewer's view.

The outer `<body>` uses `background: var(--color-neutral-100)` so the page area around the phone frame is identical across mobile screens. The frame's `border-radius: 48px` + `padding: 14px` + `box-shadow` is the phone-chrome convention. Deviating from these values causes the reviewer to see different "phones" per screen — avoid.

**Webapp main-content width rule.** The webapp main content region (between sidebar and edge of viewport) should use `width: 100%` with NO `max-width` constraint. A `max-width: N px` on `<main>` leaves dead horizontal space on wide displays and makes tables / lists look centered-but-cramped. Content density is the kit's job (spacing tokens) — not an outer width cap. If a specific pattern needs a prose-width read (case-study narrative), use `FocusedTask` layout instead of capping `<main>` width.

**4h. Write to `docs/screens/{platform}/{screen-id}.html`**.

### 5. `data-kit-*` attribute contract

Every element representing a kit primitive / pattern / layout carries deterministic attributes so builders (029 / 030) can translate HTML → JSX without regex-scanning Tailwind strings.

| Attribute            | Value                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `data-kit-component` | PascalCase primitive/pattern name — `Button`, `Card`, `DataTable`, `EmptyState`, `WalletBalance`              |
| `data-kit-variant`   | CVA variant key — `primary`, `ghost`, `destructive`, `elevated`                                               |
| `data-kit-size`      | Size variant — `sm`, `md`, `lg`; omit if the component has no size variant                                    |
| `data-kit-props`     | JSON-stringified prop object for anything not covered by variant/size — `'{"disabled":true,"loading":false}'` |
| `data-kit-layout`    | ONLY on the root `<body>` wrapper — names the kit layout                                                      |

Pure layout wrappers (e.g. a `<div class="grid grid-cols-3">` used for flex/grid composition) do NOT carry these attributes — builders leave them as `<div>` with utility classes intact. Only kit-component-emitting elements get the tags.

**Example:**

```html
<body data-kit-layout="AppShell">
  <header data-kit-component="AppShell" data-kit-props='{"slot":"header"}'>
    <h1 class="text-xl font-semibold">Dashboard</h1>
    <button
      data-kit-component="Button"
      data-kit-variant="primary"
      data-kit-size="md"
      class="..."
    >
      + New tribe
    </button>
  </header>
  <main class="grid grid-cols-3 gap-6">
    <!-- layout div, no data-kit-* -->
    <article data-kit-component="Card" data-kit-variant="elevated" class="...">
      ...
    </article>
  </main>
</body>
```

### 6. Batching + concurrency strategy for large apps (450+ screens)

**Batch grouping.** Group remaining screens by `flows[]` membership — screens in the same flow render together, which keeps the shared-preamble context warm across agents working on related UI. Each batch is 20-40 screens worth of work.

**Concurrency within a batch.** Each screen in the batch is composed by one ui-designer subagent. Multiple agents run concurrently:

- **Default concurrency: 8** — spawn 8 ui-designer subagents in parallel per wave; each agent pulls one screen off the batch queue. When an agent completes, the next screen from the queue spawns. Each screen takes ~30-60s; at 8-wide, a 778-screen project completes in ~50-80 min wall-clock (vs ~9-13 hrs sequential).
- **Configurable** via `~/.claude/models.yaml`:

  ```yaml
  stages:
    screens:
      concurrency: 8 # default — safe with other local programs (e.g. Premiere Pro) running
      maxConcurrency: 16 # upper cap; skill refuses to exceed
      burstDelay: 0 # ms between spawn-waves if API rate-limit warnings surface
  ```

  `concurrency` is the steady-state number of agents running at once. `maxConcurrency` is an absolute cap — even if the project override requests higher, the skill clamps to this. `burstDelay` is inserted between wave-spawns when the orchestrator reports API rate-limit warnings (default 0 = spawn as fast as possible).

- **Why 8 is the default:** Each Claude Code subagent is a Node.js subprocess that mostly sits idle waiting on streaming API responses; local CPU/GPU load per agent is minimal (~200-500 MB RAM, brief CPU bursts on tool calls). The real constraint is Anthropic API rate limits, not the local machine. 8 concurrent requests sits well below typical tier rate-limits, leaves observability headroom (the orchestrator can eyeball a wave of 8 completions before spawning the next wave), and keeps local resources free for other intensive programs. Push to 12-16 for headless overnight runs; don't go above 16 without confirming the project's Anthropic tier sustains the burst rate.

**Shared-preamble delivery.** Every concurrent agent's prompt begins with the same instruction to read `docs/screens/.shared-preamble.md` (built in step 3.5). The preamble file is written once per batch run — agents don't need to coordinate; they all read the same source of truth.

**Observability.** Emit a progress line after each wave returns: `wave {N}: {W} screens completed · {T} total so far · ETA {ETA}`. On any single agent returning with `success: false`, the orchestrator logs the failure but the other agents in the wave continue — one failed screen doesn't block the wave.

**Failure + retry.** On batch failure (e.g. API rate-limit burst, transient network blip), retry only the failed screens — completed screens' output is preserved. Retry uses the same shared-preamble so the re-tries inherit identical starting ink.

**Checkpoint.** Checkpoint context between batches via `/save-context`. `docs/screens-manifest.json` is written once at the end of the FULL batch run, not per-sub-batch.

### 7. Anti-slop self-check (shared with 023)

Before writing each `*.html`, grep the generated HTML against the same banned-pattern set from `/mockups` SKILL.md step 6:

- Raw hex not on the kit's palette
- AI-lila gradients on interactive elements (unless styles.md declared them)
- Lorem ipsum / TODO / REPLACE_ME
- Cliché bigrams (Elevate / Seamless / Unleash / Next-Gen / Empower / Transform your)
- Emoji section headers
- Arbitrary Tailwind values (`p-[13px]`, `text-[#FF0000]`) — forbidden per 022b's CONTRACT.md
- Inline `style="..."` attributes containing hex values
- Unstyled `<button>` / `<input>` with no `class` and no `data-kit-component`

**Plus the preview-bootstrap presence check (refactor-007 — silent-styling-failure guard):**

- `grep -c 'cdn.tailwindcss.com' <file>` MUST return ≥1 — Tailwind Play CDN script is in `<head>`
- `grep -c 'tailwind.config' <file>` MUST return ≥1 — inline config block is in `<head>`
- `grep -c 'globals.css' <file>` MUST return ≥1 — kit tokens are linked

If any of these three return 0, the screen will render unstyled in a browser even though every other check passes (Tailwind classes don't resolve without the CDN compiler). This is a SILENT failure mode — anti-slop's mechanical regex set passes because the class names are valid Tailwind syntax, just unresolved. The bootstrap-presence check is the only programmatic catch before a human opens the file and sees a blank page.

**Plus the theme-opt-out presence check (refactor-007.1 — silent-dark-mode-flip guard):**

- `grep -E '<html[^>]*\sdata-theme="(light|dark)"' <file>` MUST match — root `<html>` element pins to a theme matching the picked style's authored mode (light-default → `data-theme="light"`; dark-default → `data-theme="dark"`).

**Plus the screen-identity presence check (feat-022 — flow-driven E2E + reachability guard):**

- `grep -E '<body[^>]*\sdata-screen-id="[a-z][a-z0-9-]*"' <file>` MUST match — root `<body>` element carries `data-screen-id="{screen-id}"` matching the file's basename without `.html` (e.g. `docs/screens/webapp/home.html` → `data-screen-id="home"`).

Without this attribute the post-build `/build-to-spec-verify` synthesizer cannot assert "after clicking X on screen A the page is now showing screen B" — it falls back to URL-pattern heuristics which false-fire on SPAs that render multiple screens at one URL. Mockup → built-page parity also requires the matching attribute on the page-root render in the corresponding stack skill (see react-next §1, svelte-kit §1).

Without this, the kit's `tokens.css` `prefers-color-scheme: dark` media query auto-flips a light-default style to dark colors when the reviewer's OS is in dark mode (and vice-versa). The user picked one mode at gate 2; auto-flipping that choice based on system preference is silent visual drift — it makes the screen look fundamentally different from the design-system-preview.html (which DOES set the attribute) and from what the user approved at gate 3. This check is the only programmatic catch before a human opens the file and sees a black-on-light or white-on-dark surprise.

One in-skill regeneration retry per violation. Emit with warnings on second failure — Layer 6 (032b `/verify-html`) + Layer 7 (025b `/visual-review`) are the safety nets.

### 8. Write `docs/screens-manifest.json`

After all remaining screens are written, compute the canonical manifest:

```json
{
  "version": "1.0",
  "generatedAt": "2026-04-21T12:00:00Z",
  "uiKitVersion": "1.0.0",
  "styleId": "style-0",
  "totalScreens": 483,
  "platforms": {
    "webapp": 406,
    "mobile": 298,
    "admin": 77
  },
  "files": [
    {
      "path": "docs/screens/webapp/home.html",
      "platform": "webapp",
      "screenId": "home",
      "sha256": "a1b2c3...",
      "routePattern": "/"
    },
    {
      "path": "docs/screens/webapp/filter-tribes.html",
      "platform": "webapp",
      "screenId": "filter-tribes",
      "sha256": "...",
      "routePattern": "/?focus=:focus"
    }
  ]
}
```

The `files[]` array is sorted by path. Each `sha256` is over that file's bytes. This manifest IS the input to the `screensManifestHash` that gate 4 binds — see §Screens manifest hash algorithm.

**Every `files[]` entry MUST include `routePattern`** (bug-114). Downstream verifier stages — perceptual-review (Tier 4) + parity-verify (Tier 3) + walkthrough-review (Tier 5) — consume `routePattern` to navigate to the live build's matching URL. Without it, `orchestrator/src/parity-verify.ts resolveBuiltUrl` falls back to the `/{screenId}` heuristic (line 333-337), which produces non-existent URLs like `/tribe-directory-browse` → 404 → false-positive perceptual + parity findings. Empirical motivator: gotribe-tribe-directory 2026-05-15 — screens-manifest authored with no routePattern caused 4 of 11 bug-fix-loop failures (bug-011 perceptual page-not-found + 3 parity cascade findings, all from the verifier visiting non-existent URLs).

**How to derive `routePattern`:**

1. **First screen of each user flow (per `docs/user-flows-manifest.json`)** — typically `/` (the home / entry route). Look at `flow.steps[0].expectedScreenId`; for the FIRST screen of the FIRST flow, default to `/` unless the flow's manifest explicitly names another entry.
2. **Screens with `<screen-id>` matching a noun-pattern like `<noun>-detail`, `<noun>-edit`, `<noun>-{verb}`** — likely a per-resource detail/action page; emit `/{noun}/:slug` or `/{noun}/:id` (use `:slug` when the project's URL semantics suggest slugs, `:id` for numeric IDs). The brief's §11 capabilities + `architecture.yaml.apps.web.routes` (if present) name the right shape.
3. **Filter / subset views (`<noun>-filtered`, `<noun>-empty-state`)** — same path as the base list view but with a query param: `/?focus=:focus` for the gotribe `tribe-directory-empty-state` case. Empty-state is a DATA condition on a real route, not a separate route.
4. **Auxiliary pages (`about`, `contact`, `pricing`, `404`)** — `/<kebab-screen-id>`.
5. **When in doubt, populate with the heuristic `/{kebab-screen-id}` AND emit a manifest warning** — `tasks.yaml.warnings[]: "routePattern auto-defaulted for {screenId}; operator should review at gate 4"`. Better to ship a populated-but-imperfect routePattern than nothing.

**Dynamic-segment syntax:** colon-prefixed (`:slug`, `:id`) is the framework-agnostic convention shipped by bug-025. Builders translate to their stack's syntax (Next.js `[slug]`, React Router `:slug`, etc.) at code-gen time. The manifest stays portable.

**Self-verify before writing the manifest:** assert `files.every(f => typeof f.routePattern === "string" && f.routePattern.length > 0)`. If ANY entry lacks routePattern, do NOT write the manifest — instead emit a hard error explaining which screens are missing routePattern. The PM stage's §2c (bug-025) already emits a warning when routePattern is missing per-task, but the warning isn't load-bearing — by the time PM fires, the screens are already authored without the field. Failing in /screens is the cheapest detection layer (bug-114).

### 9. Report (batch mode)

Emit progress every 20 screens (`completed N / M, elapsed Xs, ETA Ys`). Do NOT invoke `/user-flows-generator` from this skill — the orchestrator (035) invokes it AFTER `/visual-review` has produced `docs/visual-review/report.json`, since the viewer embeds visual-review badges sourced from that report.

### 10. Return JSON (batch)

```json
{
  "success": true,
  "styleId": "style-0",
  "uiKitVersion": "1.0.0",
  "screensGenerated": 483,
  "screensByPlatform": { "webapp": 406, "mobile": 298, "admin": 77 },
  "batches": [
    { "batchId": 1, "screens": 40, "duration": "3m12s", "failedScreens": [] },
    { "batchId": 2, "screens": 40, "duration": "2m58s", "failedScreens": [] }
  ],
  "failedScreens": [],
  "kitChangeRequests": [],
  "nanobananaUsed": false,
  "imagesGeneratedCount": 0,
  "imagesStockCount": 4,
  "imagesVectorFallbackCount": 0,
  "screensManifestHash": "sha256:a1b2c3...",
  "screensManifestPath": "docs/screens-manifest.json"
}
```

Matches `ScreensOutput` (batch variant) in task 034b.

## Single-screen invocation — `--screen <platform>/<screen-id>`

Fired by `/visual-review`'s retry loop (task 025b / 035 orchestrator retry counter).

### 1. Read retry context

- `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` — the failing-rule feedback from Layer 7. **Inject this file's contents verbatim into the generation prompt** so the model addresses the specific violations.
- `docs/screens/{platform}/{screen-id}.html` — the failing version. Preserve unchanged aspects; regenerate ONLY what the feedback flagged.
- `docs/analysis/{platform}/screens.json` — find the single screen's spec.

### 2. Skip batch-level work

- Do NOT recompute the manifest (only one file changes)
- Do NOT touch `docs/user-flows.html`
- Do NOT archive anything
- Do NOT run gate-3 allowlist re-check (it was cleared on the first pass; this regeneration is just tweaking presentation within the approved component set)

### 3. Regenerate the single file

Compose as per §4 using the kit. Apply the retry feedback. Run the anti-slop self-check. Write ONLY `docs/screens/{platform}/{screen-id}.html`.

### 4. Return minimal JSON

```json
{
  "success": true,
  "screen": "webapp/dashboard",
  "attempt": 2,
  "feedbackApplied": true,
  "nanobananaUsed": false
}
```

The orchestrator (035) owns the attempt counter + re-invokes `/visual-review` after this returns. The retry ladder caps at 3 attempts per screen (configurable per `~/.claude/models.yaml`); past that, the orchestrator flags the screen `needs-human-review` in the visual-review report.

## Kit-only composition — the hard rule

```
STOP and request a kit bump if:
- A screen needs a component not in the kit (missing primitive, pattern, or layout)
- A screen needs a variant not in the kit (e.g., Button "danger-outline" when only destructive exists)
- A screen needs an icon not in packages/ui-kit/src/icons/generated/

DO NOT:
- Build the missing component locally
- Inline any styling to work around a missing variant
- Import from deep paths to access internals
- Lower the bar by using an ugly-but-working substitute

WHEN STOPPING, emit docs/screens/kit-change-requests/{platform}-{screen-id}.md listing:
- What's missing
- Why this screen needs it
- Suggested API shape (e.g., Button variant="danger-outline")
```

**Refactor-003 kit-change-request detour.** Orchestrator invokes **PM agent in `--mode=kit-change-request`** (task 021 dual-mode; NOT main `--mode=tasks`). PM writes `plans/active/kit-change-request-{id}.md` — a mini-plan scoped to the kit addition only; does NOT require `architecture.yaml` to exist yet (it doesn't — architect runs post-design-signoff). Orchestrator bumps `/stylesheet`, re-runs gate 3 for the new kit version, then resumes `/screens` from where it stopped. Main PM stage (post-architect) later subsumes each mini-plan as a task in `docs/tasks.yaml`.

## Screens manifest hash algorithm

1. Walk `docs/screens/**/*.html` (sorted lexicographically by path)
2. Compute SHA-256 over each file's bytes
3. Build the manifest as a JSON array of `{ path, sha256 }` entries (sorted by path)
4. JSON-stringify with NO whitespace + LF line endings
5. Compute `screensManifestHash` = SHA-256 of that canonical string, prefixed `sha256:`
6. Write the un-stringified manifest (pretty-printed, optional) to `docs/screens-manifest.json` for audit
7. `visualReviewReportHash` is computed the same way over `docs/visual-review/report.json`

Orchestrator (task 036) re-computes both hashes when it detects a new `docs/signoff-{timestamp}.json`. If either hash doesn't match the current state, the sign-off is **rejected** — enforcing "if anything changes after sign-off, a new sign-off is needed" AND "a sign-off binds a specific visual-review state." The `uiKitVersion` field in signoff is similarly re-checked against `packages/ui-kit/package.json.version`.

## Versioning archive (every batch run — not single-screen)

Every FULL batch `/screens` run (not `--screen` retries):

1. Before generating, check if `docs/user-flows.html` already exists
2. If yes, copy it to `docs/user-flows-archive/{previous-timestamp}.html` — derive timestamp from the existing file's corresponding `docs/signoff-{timestamp}.json` or file mtime as fallback
3. If a corresponding `docs/signoff-{timestamp}.json` exists, copy it alongside to the archive directory
4. Generate the new `docs/user-flows.html` (actually `/user-flows-generator` does this; `/screens` just preserves the old one)

Single-screen invocations do NOT trigger archiving — only one file changed; `docs/user-flows.html` regenerates at the next full batch run.

## Anti-slop self-check (shared with `/mockups`)

Same regex set as `/mockups` SKILL.md step 6:

- Raw hex not on palette
- AI-lila gradient (`linear-gradient(*, #8b5cf6|#a855f7|#7c3aed, *)`) unless styles.md declared it for this style
- Lorem ipsum anywhere
- Cliché bigrams (Elevate / Seamless / Unleash / Next-Gen / Empower / Transform your)
- Emoji section headers
- Placeholder leakage (TODO / REPLACE_ME / [insert X])
- Arbitrary Tailwind values (`p-[13px]`)
- Inline `style="..."` with hex
- Unstyled controls (no class, no `data-kit-component`)

**One retry per violation, in-skill.** Emit with warnings after second failure.

## HTML consumer contract (refactor-001 + 022b nuance)

HTML screens consume the kit via its CSS surface — `tokens.css`, `globals.css`, `fonts.css`, Tailwind utilities resolved through the kit's `tailwind.config.ts`. They do NOT `import` kit primitives like a React consumer would.

**022b enforcement note:** `validate-consumer.ts` + the ESLint plugin target `.ts` / `.tsx` / `.js` / `.jsx` files — they skip `.html` entirely. That means 022b's programmatic validation does NOT fire on `/screens` output. For HTML, enforcement is:

- **Layer 4a (skill-time)**: the anti-slop grep above catches `p-[13px]`, raw hex, inline styles
- **Layer 6 (post-stage)**: task 032b `/verify-html` scans for token-reference correctness + deep-import equivalents
- **Layer 7 (post-stage)**: task 025b `/visual-review` runs the rubric against rendered screenshots

The `data-kit-*` attribute contract is the bridge: when `/build-web` (029) or `/build-mobile` (030) converts HTML → JSX, each `data-kit-component` + `data-kit-variant` becomes a `<Button variant="primary">` with no pattern-matching against Tailwind strings. 022b's validator then fires against the resulting `.tsx` and catches any violations introduced by the builder.

## Integration Points

- **Task 022** (UI Designer agent): invokes this skill
- **Task 022b** (UI Kit contract): CONTRACT.md rules apply at HTML composition time (anti-slop grep), but `validate-consumer.ts` + ESLint plugin skip HTML — they fire at builder time on the translated JSX
- **Task 023** (`/mockups`): consumed the representative set; `/screens` handles the remainder. Anti-slop grep patterns re-used.
- **Task 024** (`/stylesheet`): produced `packages/ui-kit/` at `1.0.0` — this skill pins that version. `.components-plan.json` + gate 3 `componentsApproved[]` are the kit-only-rule basis.
- **Task 025b** (`/visual-review`): runs after this skill's batch mode; re-invokes this skill in `--screen` mode on failure
- **Task 032b** (`/verify-html`): Layer 6 runs post-stage; its violations feed Layer 5 retry via orchestrator
- **Task 034b** (schemas): `ScreensOutput` covers batch + single-screen return shapes; `SignoffOutput` adds `visualReviewReportHash` + `uiKitVersion`
- **Task 035** (orchestrator): invokes in batch mode by default; invokes `--screen` from visual-review retry loop; owns retry counters
- **Task 036** (HITL gates): consumes `docs/user-flows.html` as the final sign-off gate (gate 4); rejects sign-offs with stale hashes
- **Task 029** (web-frontend-builder) / **030** (mobile-frontend-builder): consume `data-kit-*` attributes to translate HTML → JSX deterministically

## File-based output (CRITICAL)

HTML, JSON go to files. Response text contains ONLY status + paths + return-JSON summary. No HTML in response text. No markdown-wrapped code blocks for generated HTML. Self-verify by reading back files before reporting complete.

## Error handling

- `docs/selected-style.json` missing → abort: "`/screens` requires `docs/selected-style.json`. Complete gate 2 (`/pick-style`) first."
- `docs/signoff-stylesheet-*.json` missing → abort: "Gate 3 sign-off required before `/screens`. Review + approve the kit."
- `packages/ui-kit/package.json.version` missing/malformed → abort
- Any screen triggers kit-change-request → emit request file, halt batch, return `{ success: false, kitChangeRequests: [...] }`
- `--screen` used with `--screen <unknown>` → abort with `available screens: [...]`
- Anti-slop self-check exceeds 1 retry → emit HTML with residual warnings; Layer 6 + 7 catch it
- Layer 6 hook rejects a Write → counted as anti-slop failure; same retry logic
- Layer 5 stage retry (orchestrator) → full re-invocation; step 2's screens-already-rendered subtraction keeps it idempotent

## Related skills / files

- `.claude/skills/screens/SKILL.md` — this file
- `.claude/skills/user-flows-generator/SKILL.md` — downstream stage, runs after visual-review
- `.claude/templates/user-flows-template.html` — viewer template consumed by user-flows-generator
- `schemas/signoff.schema.json` — gate 4 sign-off contract
- `scaffolding/06-025b-visual-review-skill.md` — partner skill (single-screen retry caller)
- `scaffolding/09-034b-output-contract-zod-schemas.md` — `ScreensOutput` + `SignoffOutput` schemas
- `scaffolding/19-032b-html-verifier-agent.md` — Layer 6 post-stage verifier

## Acceptance criteria

- [ ] `.claude/skills/screens/SKILL.md` exists with the frontmatter above
- [ ] Reads `docs/analysis/{platform}/screens.json` as primary source (NOT `companion/navigation-schema.json`)
- [ ] Reads `docs/selected-style.json` + `packages/ui-kit/package.json.version`
- [ ] Reads gate-3 signoff `componentsApproved[]` and enforces it as the kit-only allowlist
- [ ] Kit-only rule documented: missing components trigger `docs/screens/kit-change-requests/{platform}-{screen-id}.md` and halt the batch
- [ ] Anti-slop self-check reused from task 023
- [ ] Single-screen mode accepts `--screen <platform>/<screen-id>` and consumes `docs/visual-review/{platform}/{screen-id}/retry-feedback.md` when present
- [ ] Single-screen mode writes only one target file; does not regenerate manifest, user-flows.html, or archive
- [ ] Single-screen mode returns minimal JSON with `screen`, `attempt`, `feedbackApplied`
- [ ] Batching strategy documented for large apps (20-40 per batch; retry failed batches only)
- [ ] `data-kit-*` attribute contract documented (component / variant / size / props / layout)
- [ ] `<link>` to kit `globals.css` is the only allowed CSS import in the HTML
- [ ] Inline SVG icons from `packages/ui-kit/src/icons/generated/{name}.svg`
- [ ] Manifest hash algorithm documented for BOTH screens AND visual-review report
- [ ] `docs/screens-manifest.json` written at end of batch run
- [ ] Archive rule documented: every batch preserves prior `docs/user-flows.html` → `docs/user-flows-archive/{prev-ts}.html`; single-screen does NOT archive
- [ ] Skill does NOT auto-invoke `/user-flows-generator`; orchestrator owns the `screens → visual-review → user-flows-generator` sequence
- [ ] Kit-change-request detour flagged as cross-task dep on PM (021, `--mode=kit-change-request`) + orchestrator (035)
- [ ] Return JSON matches `ScreensOutput` in 034b (batch + single-screen variants)
- [ ] 022b `validate-consumer` + ESLint explicitly scoped to `.ts(x)/.js(x)` — NOT HTML; enforcement for HTML is anti-slop + 032b + 025b
