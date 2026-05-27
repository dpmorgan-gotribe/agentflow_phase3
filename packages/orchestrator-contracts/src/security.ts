import { z } from "zod";

/**
 * SecurityAgentOutput — bug-011 contract.
 *
 * The `security` agent is dispatched on features PM marks security-sensitive
 * (typically those handling untrusted input, client-side state, auth, or
 * sensitive data). It performs specialist code-review against OWASP Top 10
 * (2021) + CWE Top 25, BELOW reviewer's MVP-light 15-item security pass
 * (which runs on every feature).
 *
 * Read-first like reviewer — does NOT rewrite tests or refactor code. Emits
 * structured findings the orchestrator's reviewer step routes on.
 *
 * Authoritative methodology: `docs/security-checklist.md`.
 * Agent prompt: `.claude/agents/security.md`.
 */

/**
 * The 10 OWASP Top 10 (2021) categories. Each finding cites one (or more
 * via comma-separated string in CWE descriptions).
 */
export const OwaspCategory = z.enum([
  "A01:2021-Broken-Access-Control",
  "A02:2021-Cryptographic-Failures",
  "A03:2021-Injection",
  "A04:2021-Insecure-Design",
  "A05:2021-Security-Misconfiguration",
  "A06:2021-Vulnerable-and-Outdated-Components",
  "A07:2021-Identification-and-Authentication-Failures",
  "A08:2021-Software-and-Data-Integrity-Failures",
  "A09:2021-Security-Logging-and-Monitoring-Failures",
  "A10:2021-Server-Side-Request-Forgery",
]);
export type OwaspCategory = z.infer<typeof OwaspCategory>;

/**
 * Severity classification per finding. Drives `overallVerdict` derivation
 * and operator triage urgency.
 *
 *   P0 — proven exploit path with minimal preconditions; auth bypass;
 *        secret exposure. Feature MUST NOT merge until fixed.
 *   P1 — high-confidence pattern matching a CWE; needs builder fix
 *        before merge. No demonstrated exploit but pattern is clear.
 *   P2 — defense-in-depth nit; not exploitable as-is but improves
 *        posture. Track for follow-up; doesn't block merge.
 */
export const SecuritySeverity = z.enum(["P0", "P1", "P2"]);
export type SecuritySeverity = z.infer<typeof SecuritySeverity>;

/**
 * Builder agents the orchestrator can route security retries to. Most
 * security findings route to a frontend or backend builder; rarely to
 * tester (for missing security regression tests).
 */
export const SecurityRetryAgent = z.enum([
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
  "tester",
]);
export type SecurityRetryAgent = z.infer<typeof SecurityRetryAgent>;

/**
 * Per-finding structure. CWE id is the most-specific Mitre CWE
 * (e.g., "CWE-79" for XSS); cite multiple comma-separated when a single
 * finding hits multiple (e.g., "CWE-79,CWE-94" for XSS via script
 * injection).
 */
export const SecurityFinding = z.object({
  /** Stable per-report finding ID (e.g., "F-001"). Useful for cross-referencing in PR comments. */
  id: z.string().regex(/^F-\d{3,}$/),
  severity: SecuritySeverity,
  owaspCategory: OwaspCategory,
  /** CWE identifier(s); comma-separated for multi-CWE findings. */
  cweId: z.string().regex(/^CWE-\d+(,CWE-\d+)*$/),
  /** Path relative to worktree root. */
  file: z.string().min(1),
  /** 1-based line number where the issue is located. Optional for cross-file findings. */
  line: z.number().int().positive().optional(),
  /** Short title (1 line). */
  title: z.string().min(1).max(200),
  /** Longer description with context. */
  description: z.string().min(1),
  /** Concrete fix as code change OR 2-3 sentence prose. */
  suggestedFix: z.string().min(1),
  retryTarget: SecurityRetryAgent,
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

/**
 * Per-task outcome — security agent reports completion + finding count
 * per task. Tasks are dispatched per PM's tasks.yaml (e.g., "card-detail-
 * security-review").
 */
export const SecurityTaskResult = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "failed", "skipped"]),
  /** Count of findings attributed to this task's review scope. */
  findingsCount: z.number().int().nonnegative(),
  /** Optional reason when status === "failed" or "skipped". */
  errors: z.string().optional(),
});
export type SecurityTaskResult = z.infer<typeof SecurityTaskResult>;

/**
 * Coverage report — which OWASP categories the agent walked vs
 * deliberately skipped (with reasons). Operator + reviewer use this to
 * trust the report's completeness.
 */
export const SecurityChecklistCoverage = z.object({
  /** OWASP category strings the agent did the deeper analysis on. */
  covered: z.array(z.string()).default([]),
  /** OWASP category + reason for skipping (e.g., "A07 — no auth flows in this feature"). */
  skipped: z.array(z.string()).default([]),
});
export type SecurityChecklistCoverage = z.infer<
  typeof SecurityChecklistCoverage
>;

/**
 * Final output the security agent emits. Wrapped in
 * <<<TASK_OUTCOME>>>...<<<END_TASK_OUTCOME>>> sentinels per bug-007's
 * extraction contract.
 *
 * `overallVerdict` derivation:
 *   - `blocked`        — any P0 finding present
 *   - `needs-revision` — any P1 finding present (no P0)
 *   - `approved`       — zero P0/P1 findings (P2 allowed but tracked)
 */
export const SecurityAgentOutput = z.object({
  tier: z.literal("security"),
  featureId: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  tasksCompleted: z.array(SecurityTaskResult).default([]),
  tasksFailed: z.array(SecurityTaskResult).default([]),
  tasksSkipped: z.array(SecurityTaskResult).default([]),
  findings: z.array(SecurityFinding).default([]),
  checklistCoverage: SecurityChecklistCoverage,
  overallVerdict: z.enum(["approved", "needs-revision", "blocked"]),
  /** 1-3 sentence human summary; surfaces in PR descriptions + operator review. */
  summary: z.string().min(1).max(2000),
});
export type SecurityAgentOutput = z.infer<typeof SecurityAgentOutput>;
