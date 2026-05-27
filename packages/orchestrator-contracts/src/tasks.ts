import { z } from "zod";

/**
 * tasks.yaml v2 (refactor-004): PM output for the feature-graph phase.
 *
 * Authoritative spec: scaffolding/09-034b-output-contract-zod-schemas.md
 * + schemas/tasks.schema.json + schemas/feature.schema.json.
 *
 * Cross-field invariants the orchestrator MUST enforce beyond Zod's
 * structural checks (documented here; implementation in
 * orchestrator/feature-graph.ts phase 7):
 *
 *   1. Every feature.tasks[].agent must be a member of the same
 *      feature.agent_sequence. Schema can't express this cleanly.
 *   2. Every feature.depends_on[] reference must resolve to another
 *      feature.id in the same TasksV2 document.
 *   3. feature.depends_on[] must not form a cycle (DFS at load).
 *   4. Every task.depends_on[] must resolve to another task.id within
 *      the SAME feature (cross-feature task deps expressed at
 *      feature.depends_on level).
 *   5. summary_counts (if present) should agree with computed counts;
 *      disagreement = warning, not hard fail.
 */

export const FeatureIdSchema = z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/);

export const AgentSequenceMember = z.enum([
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
  "tester",
  "reviewer",
  "git-agent",
  "security",
  "devops",
  // feat-064 (2026-05-08) — narrow-scope patch agent for /fix-bugs
  // loop dispatches. Replaces tier-specific builders for cheap bug
  // classes (compile / runtime / parity / orphan / flow-execution).
  // Mode B feature builds keep web/backend/mobile-frontend-builder.
  "bug-fixer",
  // feat-070 (2026-05-11) — cross-file root-cause variant of bug-fixer
  // routed for systemic bug classes (systemic-divergence,
  // tooling-css-pipeline-broken, tooling-config-mismatch,
  // tooling-test-seed-contract-broken, pixel-systemic-divergence,
  // clustered-systemic-divergence). Higher turn budget + multi-file
  // edit authority. See feat-066 v2 Phase 5.
  "systemic-fixer",
  // feat-068 (2026-05-12) — Tier 4 vision-LLM perceptual review agent.
  // ONE invocation per screen per fix-loop iteration. Compares mockup PNG
  // vs live PNG, emits structured findings. Read-only; produces no diffs.
  // Dispatched directly by orchestrator/src/perceptual-review.ts —
  // NOT routable through agent_sequence (review is a verifier-side
  // step, not a fix-loop step).
  "perceptual-reviewer",
  // feat-069 (2026-05-13) — Tier 5 AI walkthrough behavioral review agent.
  // ONE invocation per fix-loop iteration. Consumes the walkthrough script's
  // evidence bundle (screenshots + network log + console log) and emits
  // structured behavioral findings. Read-only; dispatched directly by
  // orchestrator/src/walkthrough-review.ts — NOT routable through
  // agent_sequence.
  "walkthrough-reviewer",
]);
export type AgentSequenceMember = z.infer<typeof AgentSequenceMember>;

export const TaskAgent = z.enum([
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
  "perceptual-reviewer",
  "walkthrough-reviewer",
  "tester",
  "reviewer",
  "security",
  "devops",
  // feat-064 (2026-05-08) — narrow-scope patch agent for /fix-bugs loop.
  // Synthetic Tasks created by dispatchAgentsForBug carry agent: "bug-fixer";
  // tasks.yaml in Mode B never carries this (PM doesn't recruit it).
  "bug-fixer",
  // feat-070 (2026-05-11) — see AgentSequenceMember entry above.
  // Synthetic Tasks for systemic bug classes carry agent: "systemic-fixer".
  "systemic-fixer",
]); // excludes git-agent — lifecycle is orchestrator-owned, never a task agent
export type TaskAgent = z.infer<typeof TaskAgent>;

/**
 * Per-task screen assignment (feat-012). Frontend-builder tasks declare the
 * exact `{platform}/{screenId}` set they own; backend / tester / reviewer /
 * devops tasks MUST leave this empty.
 *
 * Values resolve against `docs/screens-manifest.json.files[]` — the PM
 * populates this list by parsing `docs/analysis/{platform}/flows.md` and
 * matching screen filenames to manifest entries.
 *
 * Cross-field invariants (enforced by scripts/validate-tasks-yaml.mjs +
 * PM self-verify):
 *   - non-frontend agents → screens.length === 0 (hard fail)
 *   - frontend agent on a non-skipped surface with screens.length === 0 →
 *     warning (some frontend work is kit-only / routing-only; don't hard-fail)
 *   - Same `{platform}/{screenId}` in two features → warnings[] entry in
 *     tasks.yaml (PM doesn't auto-resolve; flow decomposition is wrong)
 */
export const TaskScreenRef = z
  .string()
  .regex(/^(webapp|mobile|admin|desktop)\/[a-z0-9][a-z0-9-]*$/);
export type TaskScreenRef = z.infer<typeof TaskScreenRef>;

export const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,80}$/),
    agent: TaskAgent,
    depends_on: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    integration_ref: z.string().optional(),
    status: z
      .enum(["pending", "in-progress", "completed", "blocked", "skipped"])
      .default("pending"),
    estimated_screens: z.number().int().nonnegative().optional(),
    screens: z.array(TaskScreenRef).default([]),
    summary: z.string().max(200).optional(),
    notes: z.string().optional(),
  })
  .superRefine((task, ctx) => {
    const isFrontend =
      task.agent === "web-frontend-builder" ||
      task.agent === "mobile-frontend-builder";
    if (!isFrontend && task.screens.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screens"],
        message: `task.agent=${task.agent} must not declare screens[]; only frontend builders own screens`,
      });
    }
  });
export type Task = z.infer<typeof TaskSchema>;

export const FeatureSchema = z.object({
  id: FeatureIdSchema,
  worktree: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  branch: z.string().regex(/^feat\/[a-z][a-z0-9-]{1,48}$/),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  depends_on: z.array(FeatureIdSchema).default([]),
  skip: z.array(z.enum(["web", "mobile", "backend"])).default([]),
  agent_sequence: z.array(AgentSequenceMember).min(1),
  tasks: z.array(TaskSchema).min(1),
  summary: z.string().max(200).optional(),
  brief_reference: z.string().optional(),
  /**
   * bug-015 Phase 2: glob list of files this feature is expected to mutate.
   * PM authors at task-graph emission time. Orchestrator uses overlap
   * detection to serialize features that share files (auto-add depends_on).
   * Conservative — when in doubt, list more globs.
   */
  affects_files: z.array(z.string()).default([]),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const TasksV2Schema = z.object({
  version: z.literal("2.0"),
  generated_at: z.string().datetime().optional(),
  project_name: z.string().optional(),
  architecture_ref: z.string().optional(),
  ui_kit_version: z.string().optional(),
  features: z.array(FeatureSchema),
  summary_counts: z
    .object({
      total_features: z.number().int().nonnegative(),
      total_tasks: z.number().int().nonnegative(),
      by_agent: z.record(z.string(), z.number().int().nonnegative()),
      by_priority: z.object({
        P0: z.number().int().nonnegative(),
        P1: z.number().int().nonnegative(),
        P2: z.number().int().nonnegative(),
        P3: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  warnings: z.array(z.string()).default([]),
});
export type TasksV2 = z.infer<typeof TasksV2Schema>;
