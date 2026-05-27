import { z } from "zod";

/**
 * Screen-state fixture schema — feat-029.
 *
 * feat-028's parity-verifier compares the BUILT app's rendered DOM against
 * the DESIGNED mockups. But the built app starts EMPTY (no boards, no
 * cards, no settings configured) while the mockups depict POPULATED state
 * (3 boards × 4 columns × 12 cards). Without seeding the app to match the
 * mockup's data shape, the DOM-diff is comparing apples to oranges — every
 * screen comes back as "everything missing".
 *
 * A `ScreenFixture` is the pre-comparison seed payload: a JSON object that
 * the dev-only `__seedFromUrl` helper applies to localStorage on
 * `?_seed=<screenId>` query param. Two derivation paths feed it:
 *
 *   - **Pattern A — `mockup-auto`**: produced by
 *     `scripts/derive-fixture-from-mockup.mjs` which walks the mockup's
 *     `[data-kit-component="Card"]` / `Column` / `Board` nodes and maps
 *     them to the app's `@repo/types` schema. Covers ~80% of screens.
 *
 *   - **Pattern B — `flow-context`**: for dynamic screens that can't be
 *     statically seeded (search-empty needs a typed query mid-flow), the
 *     fixture inherits a base `storeState` then defines `preActions[]` —
 *     an ordered click/type/wait list `scripts/seed-app-state.mjs` plays
 *     against the running dev server before the snapshot fires.
 *
 *   - **`hand-authored`**: operator-edited fallback when both patterns
 *     produce stubs.
 *
 * Per-project fixtures live at
 * `<projectDir>/docs/screens/webapp/fixtures/<screenId>.fixture.json`
 * (gitignored — derived per run; regenerate when types evolve).
 *
 * Source: plans/active/feat-029-screen-state-fixtures.md §Phase 0.
 */

/**
 * Where the fixture's `storeState` came from. Drives downstream tooling:
 *
 *   - `mockup-auto` fixtures regenerate cleanly each
 *     `/build-to-spec-verify` run; a stale auto fixture is harmless.
 *   - `flow-context` fixtures must NOT have their `storeState` overwritten
 *     by the auto-derive script — the operator may have hand-tuned the
 *     base state OR the fixture inherits via the documented
 *     `@inherit-from:<screenId>` sentinel string (resolved by the seeder
 *     at runtime; opaque to the schema).
 *   - `hand-authored` fixtures are operator-owned end-to-end.
 */
export const ScreenFixtureDerivedFromSchema = z.enum([
  "mockup-auto",
  "flow-context",
  "hand-authored",
]);
export type ScreenFixtureDerivedFrom = z.infer<
  typeof ScreenFixtureDerivedFromSchema
>;

/**
 * One pre-snapshot action `scripts/seed-app-state.mjs` plays against the
 * running dev server after navigation but before the differ snapshots the
 * DOM. Mirrors a tiny subset of the Playwright action surface — enough to
 * get from a seeded base state to a screen-specific transient state
 * (modal-open, search-result-empty, settings-tab-selected, …).
 *
 *   - `click` requires `selector`
 *   - `type`  requires `selector` + `value`
 *   - `press` requires `value` (key name like "Enter" / "Escape")
 *   - `wait`  requires `timeoutMs` (no selector means "fixed delay")
 *
 * Cross-action invariants (selector-required-for-click etc.) are NOT
 * enforced by the schema — the seeder validates at runtime + reports a
 * clear error. Keeps the schema declarative + composable.
 */
export const ScreenFixturePreActionSchema = z.object({
  kind: z.enum(["click", "type", "press", "wait"]),
  selector: z.string().optional(),
  value: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
});
export type ScreenFixturePreAction = z.infer<
  typeof ScreenFixturePreActionSchema
>;

/**
 * The fixture itself. `storeState` is opaque to the schema — its shape is
 * the app's own store-slice contract (Zustand / Jotai / Svelte rune state)
 * and the seeder hands it to the dev-only `__seedFromUrl` helper verbatim.
 * Validation against `@repo/types` happens at the auto-derive script's
 * level (Phase 1) where it has access to the project's type modules.
 *
 * `routePath` is where the differ navigates AFTER applying `?_seed=` —
 * defaults to `/` because most fixtures target the home screen. For
 * sub-routes the fixture overrides (`"/settings"` / `"/board/board-1"`).
 *
 * `version` is locked at `"1.0"` for v1; future bumps go through a
 * documented migration in `screen-fixtures.ts`.
 */
export const ScreenFixtureSchema = z.object({
  version: z.literal("1.0"),
  screenId: z.string().min(1),
  derivedFrom: ScreenFixtureDerivedFromSchema,
  derivedAt: z.string().datetime(),
  storeState: z.record(z.string(), z.unknown()),
  routePath: z.string().default("/"),
  preActions: z.array(ScreenFixturePreActionSchema).default([]),
});
export type ScreenFixture = z.infer<typeof ScreenFixtureSchema>;

/**
 * JSON Schema export — mirrors the `ParityVerifyOutputJsonSchema` pattern.
 * Emitted to `schemas/screen-fixture.schema.json` for non-SDK consumers
 * (CI tooling, fixture-authoring linters, future fixture generators).
 */
export const ScreenFixtureJsonSchema = z.toJSONSchema(ScreenFixtureSchema);
