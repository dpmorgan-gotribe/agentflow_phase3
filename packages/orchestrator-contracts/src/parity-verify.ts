import { z } from "zod";

/**
 * `/parity-verify` output contract — feat-028.
 *
 * Structural DOM-diff + computed-style audit comparing the BUILT app to the
 * DESIGNED mockups under `docs/screens/{platform}/*.html`. Closes the
 * dominant `kanban-webapp-10`-class divergence the post-build verifiers
 * miss: the **shell-stripping** pattern where the builder treats each
 * screen as a content island and silently drops the surrounding AppShell /
 * sidebar / topbar that the mockup wraps it in. The flow synthesizer
 * (feat-022 / feat-025) asserts on `data-screen-id` of the rendered page;
 * it doesn't care that the entire app shell around it is missing.
 *
 * v1 mechanism: walk the DOM of (mockup HTML, built page) at desktop
 * viewport, project each tree to a `data-kit-component / data-kit-variant /
 * data-kit-size` skeleton, diff structurally; ALSO capture a curated
 * computed-style snapshot for the page-root + AppShell containers + each
 * `[data-kit-component]` and diff with per-property tolerance. Emits one
 * `ParityDivergence` per (screen, pattern) tuple — patterns are the
 * recurring failure modes investigate-009 catalogued (shell-stripping,
 * layout-regrouping, token-drift, etc.). Pixel-diff explicitly deferred
 * with cutover criteria documented in
 * `plans/active/feat-028-visual-parity-verifier.md` §Non-goals.
 *
 * Source: plans/active/feat-028-visual-parity-verifier.md §Phase 2.
 */

/**
 * The recurring divergence patterns investigate-009 enumerated. Verifier
 * scripts classify each individual structural / style difference into ONE
 * pattern per (screen, pattern) tuple. `uncategorized` is the fallback for
 * the long-tail of one-off mismatches that don't fit a known cluster
 * (those still surface; they just don't get a curated suggested-fix in
 * the bug-plan template).
 */
export const ParityPatternSchema = z.enum([
  "shell-stripping", // Pattern A — built page omits the surrounding AppShell/sidebar/topbar
  "layout-regrouping", // Pattern D — kit primitives present but reorganised/regrouped
  "token-drift", // Pattern C — color / font-family / radius value differs from token
  "copy-sizing-drift", // Pattern B — heading levels / font-sizes mismatched
  "spacing-token-drift", // Pattern E — padding / margin / gap drifts off-token
  "identity-contract-broken", // Pattern F — logo / brand mark / illustration missing or swapped
  "uncategorized",
  // feat-066 v2 (2026-05-11) — systemic patterns. The audit-computed-styles
  // classifier folds buckets over a threshold into ONE
  // `systemic-divergence` bug instead of N individual drifts (bug-078).
  // Phase 2 + Phase 6 add the other two when those ship.
  "systemic-divergence", // bug-078 — single (screen, pattern) tuple over fold threshold
  "pixel-systemic-divergence", // feat-067 (Phase 2) — pixel-diff whole-screen mismatch (diffRatio > SYSTEMIC threshold)
  "pixel-minor-divergence", // feat-067 (Phase 2) — pixel-diff sub-systemic mismatch (MINOR < diffRatio ≤ SYSTEMIC)
  "clustered-systemic-divergence", // feat-071 (Phase 6) — clusterer-fold across bugs
]);
export type ParityPattern = z.infer<typeof ParityPatternSchema>;

/**
 * One missing-or-mismatched primitive selector. `selector` is a
 * `[data-kit-component="X"]`-style locator (or a path-style segment when
 * the diff walked nested kit nodes). Used for both `variantDrift[]` (where
 * mockup + built nodes match by position but their `data-kit-variant` /
 * `data-kit-size` differs) AND embedded inside the `detail` block where
 * the position itself differs.
 */
export const ParityVariantDriftSchema = z.object({
  selector: z.string().min(1),
  mockupValue: z.string(),
  builtValue: z.string(),
});
export type ParityVariantDrift = z.infer<typeof ParityVariantDriftSchema>;

/**
 * One computed-style mismatch. `property` is a CSS property name
 * (`color`, `padding-left`, `border-radius`, …); the differ reports
 * mockup vs built values verbatim from `getComputedStyle()`. Numeric
 * properties tolerate ±1px drift; color / font-family are exact-match.
 */
export const ParityStyleDriftSchema = z.object({
  selector: z.string().min(1),
  property: z.string().min(1),
  mockupValue: z.string(),
  builtValue: z.string(),
});
export type ParityStyleDrift = z.infer<typeof ParityStyleDriftSchema>;

/** Per-pattern detail block emitted by the differ. */
export const ParityDivergenceDetailSchema = z.object({
  /** kit-skeleton selectors present in mockup but missing from built */
  missing: z.array(z.string()).default([]),
  /** kit-skeleton selectors present in built but absent from mockup */
  extra: z.array(z.string()).default([]),
  /** matched-position primitives whose variant/size attribute drifted */
  variantDrift: z.array(ParityVariantDriftSchema).default([]),
  /** computed-style mismatches on the curated selector list */
  styleDrift: z.array(ParityStyleDriftSchema).default([]),
  /**
   * feat-067 Phase C (2026-05-11) — relative path under `<projectDir>` to
   * the diff-overlay PNG produced by audit-pixel-diff when the pattern is
   * `pixel-{minor,systemic}-divergence`. Empty / undefined for all other
   * pattern types (structural / computed-style audits don't produce
   * images). The bug-fix-context envelope reads this path so dispatched
   * agents see the diff via the Read tool's image support.
   */
  diffPngPath: z.string().optional(),
  /**
   * feat-067 Phase C — pixel-diff statistics. Free-form pass-through used
   * by the bug-author body template for diagnostic ("18% pixel diff;
   * 65,232 of 362,400 pixels differ"). Only set for pixel-* patterns.
   */
  pixelStats: z
    .object({
      diffPixels: z.number().int().nonnegative(),
      totalPixels: z.number().int().nonnegative(),
      diffRatio: z.number().min(0).max(1),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ParityDivergenceDetail = z.infer<
  typeof ParityDivergenceDetailSchema
>;

/**
 * One divergence row: the (screen, pattern) tuple that bug-author groups
 * into a single `parityDivergenceBody()` plan. Severity defaults to P1;
 * the `shell-stripping` pattern is auto-promoted to P0 by the verifier
 * script because it breaks every downstream flow assertion (a missing
 * AppShell means no nav surface = no flow can fire).
 */
export const ParityDivergenceSchema = z.object({
  screen: z.string().min(1), // e.g. "home"
  pattern: ParityPatternSchema,
  detail: ParityDivergenceDetailSchema,
  severity: z.enum(["P0", "P1", "P2"]).default("P1"),
});
export type ParityDivergence = z.infer<typeof ParityDivergenceSchema>;

/**
 * Top-level contract returned by `runParityVerify()` + folded into
 * `BuildToSpecVerifyOutput.parity` (feat-028 Phase 4). `ok === true` iff
 * `divergences.length === 0`. The schema does NOT enforce this cross-field
 * invariant (consistent with feat-022's `BuildToSpecVerifyOutput`
 * convention) — the orchestrator validates it after parse.
 *
 * `costUsd` is 0 for v1 (no LLM dispatch — pure DOM walk + computed-style
 * read in headless Playwright).
 */
export const ParityVerifyOutputSchema = z.object({
  ok: z.boolean(),
  screensChecked: z.number().int().nonnegative(),
  divergences: z.array(ParityDivergenceSchema).default([]),
  warnings: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type ParityVerifyOutput = z.infer<typeof ParityVerifyOutputSchema>;

/**
 * JSON Schema export — mirrors the `BuildToSpecVerifyOutputJsonSchema`
 * pattern from feat-022. Emitted to
 * `schemas/parity-verify-output.schema.json` for non-SDK consumers
 * (CI tooling, external validators, future bugs-yaml linters).
 */
export const ParityVerifyOutputJsonSchema = z.toJSONSchema(
  ParityVerifyOutputSchema,
);
