// stylesheet-primitives.ts — Zod schema for /stylesheet-primitives return JSON.
// Covers the React-surface subset of the kit (12 mandatory primitives + N
// extended + 12 canonical patterns + N custom + 5 layouts + 022b artifacts).
//
// feat-002 (parallelize-stylesheet-primitives): adds `failedComponents[]`
// to surface per-component failures that hit max retries from the Stage 2
// + Stage 3 audit + retry loops. Backward-compatible: existing consumers
// that don't read `failedComponents` are unaffected; empty array when all
// pass.

import { z } from "zod";

/**
 * One entry per component that failed the post-stage audit AND exhausted
 * its retry budget (max 2 per component). Surfaces to the orchestrator
 * so downstream stages (PM, builders) see which kit primitives/patterns/
 * layouts are unstable. The orchestrator-side gate decides whether to
 * abort the run OR mark `needsHumanReview` and continue with the kit's
 * happy-path subset.
 */
export const FailedComponentSchema = z.object({
  /** Tier the component belongs to. */
  tier: z.enum(["primitive", "pattern", "layout"]),
  /** kebab-case directory name (e.g. "button", "empty-state", "app-shell"). */
  name: z.string(),
  /** Audit dimensions that failed on the final retry attempt. */
  dimensions: z.array(z.string()),
  /** Retry attempts consumed before giving up (0..maxRetries — typically 2). */
  retryAttempts: z.number().int().min(0).max(2),
  /**
   * When true, the orchestrator surfaces this to the operator at the gate.
   * When false (rare — used for non-blocking advisory findings), continues
   * silently.
   */
  needsHumanReview: z.boolean(),
});

export type FailedComponent = z.infer<typeof FailedComponentSchema>;

/**
 * Return JSON shape from /stylesheet-primitives. The orchestrator validates
 * against this schema before consuming. Backward-compatible with pre-feat-002
 * outputs (failedComponents defaults to []).
 */
export const StylesheetPrimitivesOutputSchema = z.object({
  success: z.boolean(),
  kitVersion: z.string(),
  webFramework: z.string(),
  primitiveCount: z.number().int().nonnegative(),
  patternCount: z.number().int().nonnegative(),
  layoutCount: z.number().int().nonnegative(),
  primitivesShipped: z.array(z.string()),
  patternsShipped: z.array(z.string()),
  layoutsShipped: z.array(z.string()),
  storybookBuildPath: z.string().nullable(),
  barrelPath: z.string(),
  packageJsonPath: z.string(),
  /** feat-002 — per-component failures after max retries (empty if clean). */
  failedComponents: z.array(FailedComponentSchema).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  /** Telemetry — populated by the orchestrator-side wrapper. */
  cost: z.number().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  noChange: z.boolean().default(false),
});

export type StylesheetPrimitivesOutput = z.infer<
  typeof StylesheetPrimitivesOutputSchema
>;
