import { z } from "zod";

/**
 * `docs/user-flows-manifest.json` schema — feat-038 Phase 1.
 *
 * The manifest authored by `/user-flows-generator` (gate 4 sign-off
 * artefact) and consumed by:
 *
 *   - `scripts/build-user-flows.mjs` — assembles the navigable
 *     `docs/user-flows.html` viewer that renders each flow's screen
 *     sequence in iframes for the design-signoff HITL.
 *   - `scripts/synthesize-flow-e2e.mjs` — emits Playwright specs under
 *     `apps/web/e2e/synthesized/flow-N.spec.ts` for the verify pipeline's
 *     flow-execution stage. Today reads only the legacy screen
 *     breadcrumbs (`steps[]`); Phase 2 will rewrite to consume the new
 *     structured `interactions[]` action script.
 *   - The orchestrator's `build-to-spec-verify` stage as the source of
 *     truth for "what flows must pass".
 *
 * ## Why two flow-step concepts coexist (`steps[]` + `interactions[]`)
 *
 * The legacy `steps[]` field is a screen-breadcrumb sequence — each entry
 * names a screen-id + the mockup HTML file the viewer iframes. It drives
 * the user-flows.html sign-off viewer + a heuristic-based synthesizer that
 * infers Playwright clicks from screen-id transitions. That works for
 * navigation-shaped flows but produces theatrical specs for any flow that
 * needs form fills, network waits, or assertions on populated UI state
 * (the kanban-09 / repo-health-01-class bug feat-038 was filed against).
 *
 * The new `interactions[]` field is a structured Playwright action script
 * — each entry is a discriminated union over 10 action kinds. Phase 2's
 * synthesizer rewrite emits one Playwright statement per interaction,
 * deterministically. Both fields can coexist on a single flow during the
 * Phase 1 → Phase 3 migration window (Phase 1 lays down the schema; Phase
 * 3 updates `/user-flows-generator` to author both fields; Phase 2's
 * synthesizer rewrite reads `interactions[]` when present, falls back to
 * the screen-breadcrumb heuristic when absent).
 *
 * ## SeedingTier
 *
 * Per `.claude/rules/testing-policy.md §E2E data-seeding strategy`, the
 * seeding strategy is stack-determined (per the project's persistence
 * layer) but the per-flow signal feeding the strategy is binary:
 *
 *   - `read-only` — the flow only reads existing state. Strategy A's
 *     localStorage-clear baseline OR Strategy D's intercept-and-fake
 *     responses cover it cheaply.
 *   - `mutation` — the flow writes state (creates/updates/deletes). Phase
 *     2's synthesizer wraps mutation flows in a `test.describe.serial`
 *     block + emits the per-stack seed/cleanup pattern declared by the
 *     stack skill.
 *
 * Defaults to `read-only` when absent (safest assumption — won't trigger
 * mutation-tier serial-execution overhead for flows that don't need it).
 *
 * ## Schema versioning
 *
 * `schemaVersion` is a NEW top-level field tracking the manifest's
 * structural contract. v1.0 is the original (screen-breadcrumb only)
 * shape; v2.0 adds `interactions[]` + `seedingTier` + this field itself.
 * Manifests without `schemaVersion` are treated as v1.0 by readers (the
 * Zod schema makes the field optional with no implicit default — readers
 * decide v1.0 fallback semantics per their needs).
 *
 * ## Cross-references
 *
 * - `plans/active/feat-038-deepen-synthesize-flow-e2e-and-data-seeding.md`
 *   §Phase 1 — the schema design this file implements.
 * - `.claude/rules/testing-policy.md §E2E data-seeding strategy` — the
 *   per-stack-skill strategy table that consumes `seedingTier`.
 * - `schemas/user-flows-manifest.schema.json` — hand-mirrored JSON schema
 *   for non-SDK consumers (CI tooling, validators, future linters).
 */

// ─── InteractionStep — discriminated union over the action vocabulary ──────
//
// The 10 kinds enumerated in feat-038 §Phase 1. Vocabulary is intentionally
// finite — the synthesizer's job is mechanical translation (one Playwright
// statement per step), not LLM-flavored interpretation. New kinds land
// additively under a `schemaVersion` bump.

/** Navigate the page to a route. Always the first step of a flow. */
export const NavigateInteractionSchema = z.object({
  kind: z.literal("navigate"),
  /** Route relative to the dev-server base URL (e.g. `/`, `/report/foo/bar`). */
  to: z.string().min(1),
});
export type NavigateInteraction = z.infer<typeof NavigateInteractionSchema>;

/** Type a value into a form field. Mirrors `page.fill(selector, value)`. */
export const FillInteractionSchema = z.object({
  kind: z.literal("fill"),
  /** Playwright selector (`[data-testid=…]` preferred for stability). */
  selector: z.string().min(1),
  /** Literal value to type. The synthesizer inlines this verbatim. */
  value: z.string(),
});
export type FillInteraction = z.infer<typeof FillInteractionSchema>;

/** Click an element. Mirrors `page.click(selector)`. */
export const ClickInteractionSchema = z.object({
  kind: z.literal("click"),
  selector: z.string().min(1),
});
export type ClickInteraction = z.infer<typeof ClickInteractionSchema>;

/** Pick an option from a select element. Mirrors `page.selectOption(selector, option)`. */
export const SelectInteractionSchema = z.object({
  kind: z.literal("select"),
  selector: z.string().min(1),
  /** Option value or label, per Playwright's selectOption semantics. */
  option: z.string(),
});
export type SelectInteraction = z.infer<typeof SelectInteractionSchema>;

/** Wait for a network response matching a URL pattern. Mirrors `page.waitForResponse(...)`. */
export const WaitForResponseInteractionSchema = z.object({
  kind: z.literal("waitForResponse"),
  /** Substring or regex source the synthesizer compiles into a RegExp. */
  urlPattern: z.string().min(1),
  /** Optional HTTP status to assert on the response. */
  status: z.number().int().positive().optional(),
});
export type WaitForResponseInteraction = z.infer<
  typeof WaitForResponseInteractionSchema
>;

/** Wait for a selector to attach to the DOM. Mirrors `page.waitForSelector(...)`. */
export const WaitForSelectorInteractionSchema = z.object({
  kind: z.literal("waitForSelector"),
  selector: z.string().min(1),
  /** Optional millisecond timeout (Playwright default is 30000). */
  timeout: z.number().int().positive().optional(),
});
export type WaitForSelectorInteraction = z.infer<
  typeof WaitForSelectorInteractionSchema
>;

/** Assert an element is visible. Mirrors `expect(locator).toBeVisible()`. */
export const AssertVisibleInteractionSchema = z.object({
  kind: z.literal("assertVisible"),
  selector: z.string().min(1),
});
export type AssertVisibleInteraction = z.infer<
  typeof AssertVisibleInteractionSchema
>;

/** Assert an element's text content. Mirrors `expect(locator).toHaveText(text)`. */
export const AssertTextInteractionSchema = z.object({
  kind: z.literal("assertText"),
  selector: z.string().min(1),
  text: z.string(),
});
export type AssertTextInteraction = z.infer<typeof AssertTextInteractionSchema>;

/** Assert the current URL matches a regex pattern. Mirrors `expect(page).toHaveURL(...)`. */
export const AssertUrlMatchesInteractionSchema = z.object({
  kind: z.literal("assertUrlMatches"),
  /** Regex source string the synthesizer compiles into a RegExp. */
  pattern: z.string().min(1),
});
export type AssertUrlMatchesInteraction = z.infer<
  typeof AssertUrlMatchesInteractionSchema
>;

/**
 * Capture a screenshot at this step. Cross-cuts with parity-verify (which
 * snapshots whole screens at fixture-seeded URLs); flow-step screenshots
 * are useful for debugging assertion failures + future visual-diff tie-in.
 */
export const ScreenshotInteractionSchema = z.object({
  kind: z.literal("screenshot"),
  /** Filename slug (synthesizer prefixes with the flow id). */
  name: z.string().min(1),
});
export type ScreenshotInteraction = z.infer<typeof ScreenshotInteractionSchema>;

/**
 * Mock an HTTP response via Playwright's `page.route()` interception.
 * Required for any flow whose state cannot be reproduced live (rate-limited,
 * private, network-failure, 4xx/5xx error states). Synthesizer emits the
 * page.route() call at the position the operator places this step in
 * `interactions[]` — must be BEFORE the navigate that triggers the request,
 * per Playwright route-registration semantics.
 *
 * Example (rate-limit synthetic state):
 *   { kind: "mock", urlPattern: "/api/report/", method: "GET", status: 429,
 *     body: { error: "rate_limited", retryAfter: 60 }, contentType: "application/json" }
 */
export const MockInteractionSchema = z.object({
  kind: z.literal("mock"),
  /**
   * URL substring or regex source. Synthesizer compiles into a RegExp and
   * passes to page.route() — matches any request whose URL contains the
   * pattern. Include leading slash for path-only patterns ("/api/report/").
   */
  urlPattern: z.string().min(1),
  /** HTTP status code to return (100-599). */
  status: z.number().int().min(100).max(599),
  /**
   * Response body. String passes through verbatim; object is JSON.stringify'd
   * before send (with contentType auto-defaulting to application/json).
   */
  body: z.union([z.string(), z.record(z.string(), z.unknown())]),
  /** Response Content-Type header. Defaults to application/json for objects, text/plain for strings. */
  contentType: z.string().optional(),
  /** HTTP method to match. Defaults to GET. */
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
});
export type MockInteraction = z.infer<typeof MockInteractionSchema>;

/**
 * Discriminated union over the 11 InteractionStep kinds. Use Zod's
 * `discriminatedUnion("kind", ...)` so type-narrowing is automatic on the
 * consumer side: `if (step.kind === "fill") step.value` is type-safe.
 */
export const InteractionStepSchema = z.discriminatedUnion("kind", [
  NavigateInteractionSchema,
  FillInteractionSchema,
  ClickInteractionSchema,
  SelectInteractionSchema,
  WaitForResponseInteractionSchema,
  WaitForSelectorInteractionSchema,
  AssertVisibleInteractionSchema,
  AssertTextInteractionSchema,
  AssertUrlMatchesInteractionSchema,
  ScreenshotInteractionSchema,
  MockInteractionSchema,
]);
export type InteractionStep = z.infer<typeof InteractionStepSchema>;

// ─── SeedingTier ────────────────────────────────────────────────────────────

/**
 * Per-flow signal feeding the per-stack seeding strategy. Binary by
 * design; the strategy choice (A/C/D) lives at the stack-skill level per
 * `.claude/rules/testing-policy.md §E2E data-seeding strategy`.
 */
export const SeedingTierSchema = z.enum(["read-only", "mutation"]);
export type SeedingTier = z.infer<typeof SeedingTierSchema>;

// ─── Legacy screen-breadcrumb step ─────────────────────────────────────────

/**
 * Existing `steps[]` entry shape — preserved from v1.0 with two empirical
 * leniencies after surveying shipped manifests at feat-038 Phase 1 time:
 *
 *   - `file` may be `null` when the screen-id doesn't have a corresponding
 *     mockup HTML file yet (book-swap manifests have several such steps —
 *     pre-build artefacts where the flow names a planned screen that
 *     hasn't been mocked).
 *   - `status` includes `"not-reviewed"` alongside the canonical
 *     visual-review trio (pass / fail / needs-human-review). Pre-build
 *     manifests use it for screens not yet through the visual-review pass.
 *
 * The `status` field drives the per-step badge in the user-flows.html
 * viewer; a `"not-reviewed"` step renders as a neutral pill.
 */
export const FlowScreenStepSchema = z.object({
  screenId: z.string().min(1),
  platform: z.string().min(1),
  file: z.string().min(1).nullable(),
  status: z.enum(["pass", "fail", "needs-human-review", "not-reviewed"]),
  title: z.string().min(1),
});
export type FlowScreenStep = z.infer<typeof FlowScreenStepSchema>;

// ─── Persona ────────────────────────────────────────────────────────────────

/**
 * Persona stub authored by `/user-flows-generator` for the user-flows.html
 * viewer's persona-pill rendering. Optional — older manifests may omit it.
 */
export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  primaryGoal: z.string().min(1),
  flowIds: z.array(z.string().min(1)),
});
export type Persona = z.infer<typeof PersonaSchema>;

// ─── Flow ───────────────────────────────────────────────────────────────────

/**
 * feat-050 (2026-05-03) — per-flow required state declaration. Closes the
 * seed-mismatch failure class where a flow expects DB state contradicting
 * the project baseline (e.g. flow-1 "First-time setup" expects empty, but
 * baseline seeds 3 accounts).
 *
 * Three `kind` variants:
 *   - "baseline" (default; existing behavior) — call /test/seed-baseline
 *     before flow runs. Maps to per-suite globalSetup behavior.
 *   - "empty" — POST /test/cleanup on the listed tables; SKIP baseline
 *     for this flow's beforeAll. Use for "first-time-X" / "onboarding"
 *     flows whose first interaction asserts on the empty-state UI.
 *   - "custom" — POST /test/cleanup then POST /test/seed with the
 *     flow-specific fixtures. Use for synthetic-data flows (e.g. stale
 *     fx_cache, account naming differs from baseline).
 *
 * After the flow completes, the synthesizer emits an `afterAll` that
 * restores baseline so subsequent flows see clean state.
 *
 * The /test/seed and /test/cleanup endpoints already exist in all 3 backend
 * stack skills per bug-042 Phase A.5 — this plan exercises them, doesn't add
 * new endpoints.
 */
export const RequiredStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("baseline"),
  }),
  z.object({
    kind: z.literal("empty"),
    /** Tables to wipe before this flow runs (passed to /test/cleanup). */
    tablesToCleanup: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("custom"),
    /** Tables to wipe before seeding (cleanup runs first). */
    tablesToCleanup: z.array(z.string().min(1)).min(1),
    /** Fixtures POSTed to /test/seed; shape: { tableName: [row, ...] }. */
    fixtures: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
]);
export type RequiredState = z.infer<typeof RequiredStateSchema>;

/**
 * One user flow. `steps[]` (legacy) is required for backward compat with
 * existing manifests; `interactions[]` + `seedingTier` are the v2.0
 * additions and remain optional through the Phase 1 → Phase 3 migration
 * window. `requiredState` is feat-050 (v2.1).
 *
 * Cross-field invariants NOT enforced by the schema:
 *
 *   - When `interactions[]` is present, the first entry SHOULD be
 *     `{ kind: "navigate", to: ... }`. Phase 2's synthesizer can either
 *     enforce this at synthesis time OR auto-prepend a navigate step; the
 *     schema stays declarative.
 *   - `primaryPersona` SHOULD reference an id present in the top-level
 *     `personas[]`, but older manifests use freeform persona descriptions
 *     (see kanban-webapp's "Solo Task-Tracker (any user opening the app
 *     for the first time)") so the schema is lenient.
 *   - `requiredState` is only meaningful for projects with persistence_layer
 *     "real-db" (Strategy C). For "localStorage" / "external-api-only"
 *     stacks, the synthesizer ignores requiredState and emits the
 *     strategy-appropriate beforeEach instead.
 */
export const FlowSchema = z.object({
  id: z.string().min(1),
  /** Optional — when absent, defaults to manifest-level platform context. */
  platform: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  primaryPersona: z.string().optional(),
  /** Legacy screen breadcrumbs — required for v1.0 backward compat. */
  steps: z.array(FlowScreenStepSchema).default([]),
  /**
   * Legacy alternate field used by some manifests (book-swap) for a flat
   * id list. Optional; the canonical breadcrumb sequence lives in `steps`.
   */
  screenIds: z.array(z.string().min(1)).optional(),
  /**
   * v2.0 — structured Playwright action script. When present, Phase 2's
   * synthesizer emits one statement per entry instead of inferring clicks
   * from `steps[]`'s screen-id transitions.
   */
  interactions: z.array(InteractionStepSchema).optional(),
  /**
   * v2.0 — per-flow seeding signal feeding the per-stack strategy.
   * Defaults to `read-only` when absent.
   */
  seedingTier: SeedingTierSchema.optional(),
  /**
   * v2.1 (feat-050) — per-flow required state. When absent, defaults to
   * `{ kind: "baseline" }` (existing behavior). Closes the seed-mismatch
   * class where a flow's first interaction expects state contradicting
   * the project baseline.
   */
  requiredState: RequiredStateSchema.optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

// ─── Top-level manifest ─────────────────────────────────────────────────────

/**
 * `screensCounts` — counters the user-flows-generator computes from the
 * upstream visual-review report. Bookkeeping shape varies across shipped
 * manifests:
 *
 *   - `repo-health-dashboard-01` uses kebab-case `"needs-human-review"`.
 *   - `book-swap` uses camelCase `needsHumanReview`.
 *
 * The schema accepts both spellings so existing manifests validate. New
 * manifests SHOULD prefer kebab-case to stay consistent with the
 * visual-review report's own status enum, but this is advisory.
 */
export const ScreensCountsSchema = z.object({
  total: z.number().int().nonnegative().optional(),
  pass: z.number().int().nonnegative().optional(),
  fail: z.number().int().nonnegative().optional(),
  "needs-human-review": z.number().int().nonnegative().optional(),
  needsHumanReview: z.number().int().nonnegative().optional(),
});
export type ScreensCounts = z.infer<typeof ScreensCountsSchema>;

/**
 * The full `docs/user-flows-manifest.json` envelope. v1.0 fields are
 * required (so existing manifests validate); v2.0 additions are optional.
 *
 * Top-level `version` is the manifest format version literal — v1.0
 * historically, retained for compat. `schemaVersion` is the new Phase 1
 * field tracking the structural contract; readers SHOULD prefer
 * `schemaVersion` when present and treat absence as v1.0.
 */
export const UserFlowsManifestSchema = z.object({
  /** Legacy v1.0 manifest version literal. */
  version: z.string().min(1),
  /**
   * v2.0 — explicit structural-contract version. Optional during the
   * Phase 1 → Phase 3 migration window; readers default to `"1.0"` when
   * absent.
   */
  schemaVersion: z.string().min(1).optional(),
  generatedAt: z.string().datetime(),
  projectName: z.string().min(1),
  platforms: z.array(z.string().min(1)).min(1),
  uiKitVersion: z.string().min(1),
  screensManifestHash: z.string().min(1),
  visualReviewReportHash: z.string().min(1),
  flows: z.array(FlowSchema).min(1),
  personas: z.array(PersonaSchema).optional(),
  screensCounts: ScreensCountsSchema.optional(),
});
export type UserFlowsManifest = z.infer<typeof UserFlowsManifestSchema>;

/**
 * JSON Schema export — mirrors the `ParityVerifyOutputJsonSchema` /
 * `ScreenFixtureJsonSchema` pattern. Emitted to
 * `schemas/user-flows-manifest.schema.json` for non-SDK consumers (CI
 * validators, manifest linters, future viewer-renderer tooling).
 */
export const UserFlowsManifestJsonSchema = z.toJSONSchema(
  UserFlowsManifestSchema,
);
