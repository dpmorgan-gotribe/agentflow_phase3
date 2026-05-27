import { z } from "zod";

/**
 * feat-023 — PM-stage brief coverage assertion contracts.
 *
 * Three companion files form the coverage chain:
 *
 *   1. `docs/brief-capabilities.json` — authoritative catalog of every
 *      brief §11 / §12 capability the project must deliver. Authored at
 *      `/analyze` time alongside requirements.md (the same parsing pass
 *      that walks §11/§12 emits this companion JSON).
 *
 *   2. `docs/tasks-coverage.json` — PM's mapping from each capability ID
 *      to ≥1 task ID in `docs/tasks.yaml`, OR an explicit `deferred[]`
 *      entry with reason. Emitted between PM step 7b (file-affinity) and
 *      step 8 (write tasks.yaml).
 *
 *   3. `docs/tasks.yaml` — the real task graph (existing). Sanity-cross-
 *      referenced by the audit script to catch PM typos that would let a
 *      capability appear "covered" while pointing at a non-existent task.
 *
 * The audit script `scripts/audit-brief-coverage.mjs` consumes all three
 * and emits `BriefCoverageOutput` JSON. The orchestrator runs the script
 * after the `/pm` stage emits tasks.yaml; failure (`uncovered.length > 0`
 * or `typoErrors.length > 0`) fails the stage. `deferred[]` entries flow
 * into `coverageWarnings` on the gate-4 sign-off file so the human sees
 * them before approving design + greenlighting Mode B.
 *
 * Capability IDs follow `cap-{section}-{slug}` — e.g. `cap-12-column-rename`,
 * `cap-11-help-route`. Source field cites the brief location.
 *
 * Authoritative spec: plans/active/feat-023-pm-stage-brief-coverage-assertion.md
 */

/** Capability category — derives from brief markup (§19 milestone level). */
export const CapabilityCategory = z.enum(["core", "optional", "stretch"]);
export type CapabilityCategory = z.infer<typeof CapabilityCategory>;

/** Capability ID pattern: `cap-{section-number}-{kebab-slug}`. */
export const CapabilityId = z
  .string()
  .regex(/^cap-\d+(?:\.\d+)?-[a-z][a-z0-9-]*$/);
export type CapabilityId = z.infer<typeof CapabilityId>;

/** A single brief capability entry. */
export const BriefCapability = z.object({
  id: CapabilityId,
  /** Citation back to brief.md — e.g. `brief.md#12` or `brief.md#11.4`. */
  source: z.string().min(1),
  /** Concise one-line description of what the brief promises. */
  summary: z.string().min(1),
  /** Severity of dropping this capability. */
  category: CapabilityCategory,
});
export type BriefCapability = z.infer<typeof BriefCapability>;

/** `docs/brief-capabilities.json` shape — emitted by /analyze. */
export const BriefCapabilities = z.object({
  version: z.literal("1.0"),
  capabilities: z.array(BriefCapability),
});
export type BriefCapabilities = z.infer<typeof BriefCapabilities>;

/** Deferral entry — a capability the PM (or human) has agreed to defer. */
export const CoverageDeferral = z.object({
  capability: CapabilityId,
  /** Free-text justification — surfaces in gate-4 sign-off. */
  reason: z.string().min(1),
  /**
   * Who approved the deferral. `pm-agent-decision` for PM-initiated;
   * `human:<name>` for human-driven post-gate-4 deferrals.
   */
  approvedBy: z.string().min(1),
});
export type CoverageDeferral = z.infer<typeof CoverageDeferral>;

/**
 * `docs/tasks-coverage.json` shape — emitted by /pm between step 7b
 * (file-affinity) and step 8 (write tasks.yaml).
 */
export const TasksCoverage = z.object({
  version: z.literal("1.0"),
  /**
   * Map from capability ID → list of task IDs (in tasks.yaml) that
   * deliver it. ≥1 entry per covered capability; capabilities not in
   * `covers` AND not in `deferred[]` are flagged as uncovered.
   */
  covers: z.record(CapabilityId, z.array(z.string().min(1)).min(1)),
  deferred: z.array(CoverageDeferral).default([]),
});
export type TasksCoverage = z.infer<typeof TasksCoverage>;

/** A single uncovered-capability error. */
export const UncoveredCapability = z.object({
  capability: CapabilityId,
  source: z.string().min(1),
  summary: z.string().min(1),
  category: CapabilityCategory,
});
export type UncoveredCapability = z.infer<typeof UncoveredCapability>;

/** A single typo / dangling-task-reference error. */
export const TypoError = z.object({
  capability: CapabilityId,
  /** The non-existent task ID the PM claimed in covers[]. */
  claimedTaskId: z.string().min(1),
});
export type TypoError = z.infer<typeof TypoError>;

/** A surfaced deferral the gate-4 reviewer will see. */
export const SurfacedDeferral = z.object({
  capability: CapabilityId,
  category: CapabilityCategory,
  reason: z.string().min(1),
  approvedBy: z.string().min(1),
  source: z.string().min(1),
  summary: z.string().min(1),
});
export type SurfacedDeferral = z.infer<typeof SurfacedDeferral>;

/**
 * Output of `scripts/audit-brief-coverage.mjs`. Printed to stdout +
 * consumed by the orchestrator gate after the /pm stage.
 *
 * Exit code:
 *   - `0` when `ok: true` (no uncovered + no typos; deferred is fine)
 *   - `1` when `ok: false` (uncovered.length > 0 OR typoErrors.length > 0)
 */
export const BriefCoverageOutput = z.object({
  ok: z.boolean(),
  uncovered: z.array(UncoveredCapability).default([]),
  deferred: z.array(SurfacedDeferral).default([]),
  typoErrors: z.array(TypoError).default([]),
});
export type BriefCoverageOutput = z.infer<typeof BriefCoverageOutput>;
