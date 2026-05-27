---
name: parity-verify
description: Visual-parity verifier — runs structural DOM-diff + computed-style audit comparing the BUILT app's rendered DOM against the DESIGNED mockups. Sub-stage of /build-to-spec-verify; consumes per-screen ScreenFixture seeds (feat-029) before snapshotting so the comparison is apples-to-apples (populated vs populated). Deterministic; no LLM dispatch.
when-to-use: invoked by /build-to-spec-verify (orchestrator stage — see build-to-spec-verify skill) AFTER reachability + flow-execution; never invoked manually except for diagnostic re-runs against a green build
allowed-tools: Read Write Bash Grep Glob
model: inherit
---

# /parity-verify — Visual-parity verifier (DOM-skeleton + computed-style audit)

The deterministic verifier that catches the **kanban-webapp-10 class of gap** (the builder strips `<AppShell>` + `<Sidebar>` from every page; downstream flow assertions still pass because they only check `data-screen-id`; the rendered app looks NOTHING like the mockup) BEFORE the orchestrator emits "complete".

This skill is a **deterministic script wrapper** — it shells out to two pure-Node scripts (`scripts/diff-kit-skeleton.mjs` + `scripts/audit-computed-styles.mjs`), pre-seeds the dev server with screen-state fixtures (`scripts/seed-app-state.mjs` per feat-029), aggregates the resulting structural + style divergences, and emits a typed JSON contract (`ParityVerifyOutputSchema`). No LLM dispatch. No vision calls. ~$0/run.

## Pipeline overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ /build-to-spec-verify (parent skill, orchestrator stage)                │
│                                                                         │
│   ┌─────────────────────┐ ┌─────────────────────┐ ┌──────────────────┐ │
│   │ reachability scan   │ │ flow E2E synth      │ │ parity-verify    │ │
│   │ (orphan components) │ │ (run synth specs)   │ │ (THIS SKILL)     │ │
│   └─────────────────────┘ └─────────────────────┘ └──────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                                                            │
                  ┌─────────────────────────────────────────┴──────┐
                  │                                                │
        ┌─────────▼──────────┐                       ┌─────────────▼─────────┐
        │ DOM-skeleton diff  │                       │ Computed-style audit  │
        │ diff-kit-skeleton  │                       │ audit-computed-styles │
        │ (shell-stripping)  │                       │ (token-drift)         │
        └─────────┬──────────┘                       └─────────────┬─────────┘
                  │                                                │
                  └──────────────┬─────────────────────────────────┘
                                 │
                ┌────────────────▼────────────────┐
                │ ParityVerifyOutput              │
                │ (divergences[], severity, ...)  │
                └────────────────┬────────────────┘
                                 │
              ┌──────────────────▼─────────────────┐
              │ scripts/file-bug-plan.mjs           │
              │ (per (screen, pattern) → bug-NNN) │
              └─────────────────────────────────────┘
```

## What the verifier does

For each screen the project ships (`docs/screens/<platform>/*.html`):

1. **Pre-comparison seed** (feat-029) — apply the per-screen `ScreenFixture` so the built app renders populated state matching the mockup. Without this, every screen comes back as "everything missing" because the empty app shows no boards/cards while the mockup shows 3 boards × 12 cards. See §Fixture system below.
2. **Structural DOM-skeleton diff** — walk both the mockup HTML and the built page's rendered DOM, project each kit-component instance to its `(data-kit-component, data-kit-variant, data-kit-size)` triple plus position, then diff. Catches `shell-stripping`, `layout-regrouping`, `identity-contract-broken` patterns. Driven by `scripts/diff-kit-skeleton.mjs`.
3. **Computed-style audit** — for the curated selector list (page-root + AppShell containers + each `[data-kit-component]`), capture `getComputedStyle()` snapshots from BOTH sides + diff with per-property tolerance (±1px for spacing; exact-match for color/font-family). Catches `token-drift`, `copy-sizing-drift`, `spacing-token-drift`. Driven by `scripts/audit-computed-styles.mjs`.
4. **Pattern classification** — bucket each individual mismatch into one of the seven `ParityPatternSchema` clusters (per `investigate-009`). Auto-promote `shell-stripping` to P0 (breaks every downstream flow assertion).
5. **Bug filing** — emit one `bug-NNN-parity-<pattern>-<screen>.md` per (screen, pattern) tuple via `scripts/file-bug-plan.mjs` with `source: "visual-parity"`.

## Arguments

The orchestrator wrapper at `orchestrator/src/parity-verify.ts` invokes the underlying scripts; these are the args it builds:

For `diff-kit-skeleton.mjs` + `audit-computed-styles.mjs`:

- `--project-dir <path>` — enables fixture auto-resolve from `<projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json`
- `--screen <id>` — kebab-case mockup screen id
- `--platform <name>` (default `webapp`) — used by auto-resolve
- `--fixture <path>` — explicit fixture override (skips auto-resolve)

For `seed-app-state.mjs` (per-screen pre-snapshot):

- `--fixture <path>` (required) — resolved per the routing above
- `--base-url <url>` (required) — running dev server's URL (e.g. `http://localhost:3000`)
- `--fixtures-dir <path>` — sibling fixture lookup for `@inherit-from:` references

## Fixture system (feat-029)

Every parity comparison needs the built app pre-populated to match the mockup. Two derivation paths populate the `<projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json` artifact, both governed by `ScreenFixtureSchema` (`packages/orchestrator-contracts/src/screen-fixtures.ts`):

### Pattern A — `mockup-auto`

`scripts/derive-fixture-from-mockup.mjs --project-dir <path> --screen <id>` walks the mockup HTML for visible kit primitives (`Card`, `Column`, `Board`, `Tag`, `Priority`) + maps to the app's `@repo/types` schema. Covers ~80% of screens (`home`, `card-modal`, `settings`, `empty-no-board`, `not-found`).

Run automatically by the orchestrator each `/build-to-spec-verify` invocation — fixtures are gitignored + regenerated per run so they always match the current `@repo/types` shape.

### Pattern B — `flow-context`

For screens whose state can't be statically derived (`search-empty` requires a typed query mid-flow; `card-modal` requires a click on an existing card to open), the operator hand-authors a fixture with `derivedFrom: "flow-context"` + a `preActions[]` list of ordered `click` / `type` / `press` / `wait` actions:

```json
{
  "version": "1.0",
  "screenId": "search-empty",
  "derivedFrom": "flow-context",
  "derivedAt": "2026-04-28T12:00:00.000Z",
  "storeState": "@inherit-from:home",
  "routePath": "/",
  "preActions": [
    { "kind": "click", "selector": "[aria-label='Search']" },
    {
      "kind": "type",
      "selector": "input[type='search']",
      "value": "zzznoresult"
    },
    { "kind": "wait", "timeoutMs": 500 }
  ]
}
```

The `@inherit-from:<screenId>` sentinel resolves at seed-time to the base fixture's `storeState` — keep it shallow (one level only; chained inheritance is rejected).

### Pattern C — `hand-authored`

Operator-edited fallback when both auto-derive and flow-context produce stubs. The auto-derive script emits this label when no kit primitives match the kanban archetype — that's the cue for the operator to fill in the JSON manually.

### `--fixture` routing in the verifier

Each differ script accepts a `--fixture <path>` flag. Resolution order:

1. **Explicit override** — `--fixture <path>` provided + file exists → use it
2. **Auto-resolve** — `--project-dir <path>` provided → look for `<projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json`
3. **No-seed fallback** — neither matches → run the comparison without seeding (still useful for marketing/auth screens that don't need data)

The pure-function `resolveFixturePath()` exported from both `diff-kit-skeleton.mjs` + `audit-computed-styles.mjs` implements this precedence; the orchestrator wrapper calls it once per screen + passes the result downstream to `seed-app-state.mjs`.

## `data-kit-*` contract (consumed)

The differ assumes every kit primitive on the mockup HTML carries the attributes documented in `.claude/skills/screens/SKILL.md` §5:

| Attribute            | Used by                                     | Notes                                                   |
| -------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `data-kit-component` | DOM-skeleton walker (BOTH scripts)          | PascalCase primitive name — primary key for matching    |
| `data-kit-variant`   | DOM-skeleton walker                         | CVA variant key — surfaces as `variantDrift`            |
| `data-kit-size`      | DOM-skeleton walker                         | Surfaces as `variantDrift` independently from `variant` |
| `data-kit-props`     | `derive-fixture-from-mockup.mjs`            | JSON-stringified props bag — extracts `priority` etc.   |
| `data-kit-layout`    | (unused by parity; informational)           | Belongs to the root `<body>` only                       |
| `data-screen-id`     | seed-app-state, flow synthesizer (feat-022) | Pin point for `waitForSelector` after navigate          |

Builder skills (`.claude/skills/agents/front-end/{react-next,svelte-kit}/SKILL.md` §2a) enforce that the `data-kit-*` attributes survive HTML→JSX/Svelte translation — the kit primitives emit them on render. Stripping those attributes (or stripping the AppShell wrapper that contains them) is the dominant divergence pattern this verifier catches.

## Per-screen fixture authoring guidance

When `derive-fixture-from-mockup.mjs` produces a stub fixture (`isStub: true`), the operator workflow is:

1. **Inspect the output JSON** — confirm `derivedFrom: "hand-authored"` + `storeState` is empty
2. **Decide A vs B vs C**:
   - Static populated state → Pattern C: hand-author the `storeState` directly. Reference `@repo/types` from your project for the shape.
   - Dynamic transient state (modal open, search active, settings tab selected) → Pattern B: set `derivedFrom: "flow-context"`, optionally `storeState: "@inherit-from:home"`, then list `preActions[]`.
3. **Validate** — `node -e "import('./packages/orchestrator-contracts/src/screen-fixtures.ts').then(m => console.log(m.ScreenFixtureSchema.parse(JSON.parse(require('node:fs').readFileSync('docs/screens/webapp/fixtures/search-empty.fixture.json','utf8')))))"`
4. **Test the seed locally** — start the dev server, navigate to `/?_seed=<screenId>`, verify the app populates as expected
5. **Re-run parity-verify** — `node scripts/diff-kit-skeleton.mjs <mockup> <built> <screenId> --fixture <path>` should produce a meaningful divergence report (not "everything missing")

For small projects with fixtures that need to live across regenerations, set `derivedFrom: "hand-authored"` — the auto-derive script never overwrites those.

## Builder skill cross-references (feat-029 §2c)

The fixture system depends on EVERY built project shipping a dev-only `__seedFromUrl` helper that reads `?_seed=<id>` + applies the fixture's `storeState` to localStorage. Builders enforce this:

- **react-next**: see `.claude/skills/agents/front-end/react-next/SKILL.md` §2c — `apps/web/src/lib/dev-seed.ts` + `useDevSeedOnMount()` in Providers + `process.env.NODE_ENV` production guard
- **svelte-kit**: see `.claude/skills/agents/front-end/svelte-kit/SKILL.md` §2c — `apps/web/src/lib/dev-seed.ts` + `applyDevSeedFromUrl()` in `+layout.svelte` `onMount` + `import.meta.env.DEV` production guard

The grep-based self-verify in each skill catches missing wiring before the orchestrator gets to parity-verify (which would otherwise produce no useful signal).

## Output contract

Returns `ParityVerifyOutput` (`packages/orchestrator-contracts/src/parity-verify.ts`):

```ts
{
  ok: boolean,                      // true iff divergences.length === 0
  screensChecked: number,
  divergences: Array<{
    screen: string,                 // e.g. "home"
    pattern: ParityPattern,         // shell-stripping | layout-regrouping | token-drift | ...
    detail: {
      missing: string[],            // kit selectors in mockup, absent from built
      extra: string[],              // kit selectors in built, absent from mockup
      variantDrift: ParityVariantDrift[],
      styleDrift: ParityStyleDrift[],
    },
    severity: "P0" | "P1" | "P2",   // shell-stripping auto-promoted to P0
  }>,
  warnings: string[],
  durationMs: number,
  costUsd: number,                  // 0 — no LLM dispatch
}
```

Each divergence becomes a bug-plan via `scripts/file-bug-plan.mjs` with `source: "visual-parity"` and routes through the standard `runFixBugsLoop` retry ladder. The bug-fix builder consumes the `detail.*[]` arrays directly to know which selectors to add back to the page.

## Cross-references

- **Parent**: `.claude/skills/build-to-spec-verify/SKILL.md` (orchestrator stage that wraps this)
- **Schemas**: `packages/orchestrator-contracts/src/parity-verify.ts` (output) + `packages/orchestrator-contracts/src/screen-fixtures.ts` (input fixtures)
- **Scripts**: `scripts/diff-kit-skeleton.mjs`, `scripts/audit-computed-styles.mjs`, `scripts/derive-fixture-from-mockup.mjs`, `scripts/seed-app-state.mjs`
- **Builder contracts**: `.claude/skills/agents/front-end/react-next/SKILL.md` §2a §2b §2c, `.claude/skills/agents/front-end/svelte-kit/SKILL.md` §2a §2b §2c
- **Source plans**: `plans/active/feat-028-visual-parity-verifier.md` + `plans/active/feat-029-screen-state-fixtures.md`
- **Investigation**: `plans/archive/investigate-009-*.md` (the divergence-pattern catalog this skill encodes)
