/**
 * feat-069 — AI walkthrough behavioral review (Tier 5 detection layer).
 *
 * Single-invocation dispatcher that:
 *   - Runs scripts/ai-walkthrough.mjs to produce the evidence bundle
 *     (screenshots + network log + console log + manifest)
 *   - Cascade-skips when the walkthrough script failed / produced 0
 *     screenshots / invokeAgent not provided / tier 5 disabled
 *   - Invokes the walkthrough-reviewer agent ONCE with the full bundle as
 *     pre-loaded context (mirrors the original feat-069 plan body's "single
 *     Claude API call" cost model)
 *   - Reads the agent's `docs/build-to-spec/walkthrough/review.json`
 *   - Normalizes findings (severity / category) and returns a
 *     WalkthroughReviewOutput consumed by build-to-spec-verify.
 *
 * Empirical canonical motivator: bug-094 (delete-fires-multiple-times in
 * reading-log-02). Static perceptual review can't see the 6 duplicate
 * DELETE requests; only behavioral + network evidence can.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ParityVerifyOutput,
  PerceptualReviewOutput,
  WalkthroughFinding,
  WalkthroughReviewOutput,
} from "@repo/orchestrator-contracts";
import { WalkthroughReviewOutputSchema } from "@repo/orchestrator-contracts";

import type { InvokeAgentFn } from "./feature-graph.js";

const WALKTHROUGH_AGENT = "walkthrough-reviewer" as const;
const WALKTHROUGH_OUT_DIR = "docs/build-to-spec/walkthrough";

export interface WalkthroughReviewContext {
  /** Project under review — should be the verify worktree's cwd (bug-090). */
  projectDir: string;
  /** Factory root (for invokeAgent's cwd resolution). */
  factoryRoot: string;
  /** Dev-server URL (from build-to-spec-verify's shared boot handle). */
  baseUrl: string;
  /** Tier 3 output. Findings here are passed as alreadyFiled context. */
  parity?: ParityVerifyOutput;
  /** Tier 4 output. Findings here are also passed as alreadyFiled context. */
  perceptual?: PerceptualReviewOutput;
  /** Agent dispatch seam — wraps Claude Agent SDK. */
  invokeAgent: InvokeAgentFn;
  /** Pipeline run id (for telemetry passthrough). */
  pipelineRunId?: string;
  /**
   * Test seam — replaces the dynamic import of `scripts/ai-walkthrough.mjs`.
   * Default: dynamic-import the real runner. Tests stub to avoid spawning
   * Playwright.
   */
  runWalkthroughScript?: (args: {
    projectDir: string;
    baseUrl: string;
  }) => Promise<{
    ok: boolean;
    stepsRun: number;
    screenshotsCount: number;
    errors: string[];
    warnings: string[];
    durationMs: number;
    outDir: string;
    manifestPath: string | null;
  }>;
}

/** Severity normalization — same shape as perceptual-review's. */
function normalizeSeverity(raw: unknown): "P0" | "P1" | "P2" {
  if (typeof raw !== "string") return "P1";
  const v = raw.trim().toLowerCase();
  // Empirical 2026-05-13: agent emits "warning"/"info"/"error" in addition to
  // P0/P1/P2 vocabulary. Defensive parsing covers both.
  if (
    v === "p0" ||
    v === "critical" ||
    v === "high" ||
    v === "error" ||
    v === "blocker" ||
    v === "1"
  )
    return "P0";
  if (
    v === "p2" ||
    v === "info" ||
    v === "minor" ||
    v === "low" ||
    v === "polish" ||
    v === "nit" ||
    v === "trivial" ||
    v === "3"
  )
    return "P2";
  return "P1";
}

/**
 * Normalize one finding from the agent's JSON output. Accepts a wide
 * field-name alias surface — empirical 2026-05-13 first-run on reading-log-02
 * showed the agent emitting `stepIdx` (not `step`), `title` (not `element`),
 * `detail` (not `observation`), and `evidence` as a STRING (not array).
 * Defensive parsing keeps the contract permissive while the agent's
 * vocabulary stabilizes via prompt-engineering iterations.
 */
function normalizeFinding(
  raw: unknown,
  fallbackIdx: number,
): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const stepRaw = obj.step ?? obj.stepNumber ?? obj.stepIndex ?? obj.stepIdx;
  const step =
    typeof stepRaw === "number"
      ? Math.max(1, Math.floor(stepRaw))
      : typeof stepRaw === "string" && /^\d+$/.test(stepRaw)
        ? Math.max(1, parseInt(stepRaw, 10))
        : 1;
  // element / observation: try canonical names first, then agent-natural
  // aliases (title / detail / description).
  const element =
    typeof obj.element === "string"
      ? obj.element
      : typeof obj.title === "string"
        ? obj.title
        : null;
  const observation =
    typeof obj.observation === "string"
      ? obj.observation
      : typeof obj.detail === "string"
        ? obj.detail
        : typeof obj.description === "string"
          ? obj.description
          : null;
  if (!element || !observation) return null;
  const severity = normalizeSeverity(obj.severity ?? obj.tier ?? obj.priority);
  const expected = typeof obj.expected === "string" ? obj.expected : undefined;
  const category = typeof obj.category === "string" ? obj.category : undefined;
  // evidence: schema expects string[]. Accept either string[] OR a single
  // string (wrap) OR absent (empty array). JSON-stringify nested non-string
  // values rather than drop them.
  const evidenceRaw = obj.evidence;
  let evidence: string[] = [];
  if (Array.isArray(evidenceRaw)) {
    evidence = evidenceRaw
      .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  } else if (typeof evidenceRaw === "string" && evidenceRaw.length > 0) {
    evidence = [evidenceRaw];
  }
  const id = typeof obj.id === "string" ? obj.id : `walkthrough-${fallbackIdx}`;
  const normalized: Record<string, unknown> = {
    id,
    step,
    element,
    observation,
    severity,
    evidence,
  };
  if (expected !== undefined) normalized.expected = expected;
  if (category !== undefined) normalized.category = category;
  return normalized;
}

/**
 * feat-069 B.2 — deterministic duplicate-request detector.
 *
 * Reads the walkthrough's network.ndjson + manifest.json and emits
 * synthetic findings for any interaction-step time window where a single
 * URL fired ≥ 3 times. This catches the bug-094 class (multi-fetcher
 * subscription producing N requests per single user trigger) WITHOUT
 * depending on the LLM agent to notice the pattern in the log.
 *
 * Empirical motivator (2026-05-13 B.2 first run): reading-log-02's
 * search-fill on `/books/seed-book-1` produced 4× GET /books?q=test+query
 * + 2× GET /tags within 544ms — exactly the multi-subscriber pattern
 * bug-094 surfaced from manual inspection. The LLM agent reviewed the
 * network log but didn't surface this; the deterministic detector does.
 *
 * Tuning:
 *  - Threshold ≥ 3 (under that = legitimate retry or React StrictMode 2×)
 *  - Skip /_next/ asset bundles (legitimate page-load multiplication)
 *  - Severity: ≥ 6 → P0 (matches bug-094's 6×); 3-5 → P1
 *  - Only checked on interaction steps (route-visits naturally fan out)
 */
function detectDuplicateRequestPatterns(args: {
  projectDir: string;
}): WalkthroughFinding[] {
  const outDir = join(args.projectDir, WALKTHROUGH_OUT_DIR);
  const networkPath = join(outDir, "network.ndjson");
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(networkPath) || !existsSync(manifestPath)) return [];

  let networkLines: Array<{
    kind: string;
    ts: number;
    method?: string;
    url?: string;
    status?: number;
  }> = [];
  try {
    const raw = readFileSync(networkPath, "utf8");
    networkLines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
  } catch {
    return [];
  }

  let manifest: { steps?: Array<Record<string, unknown>> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];

  const findings: WalkthroughFinding[] = [];
  for (const step of steps) {
    const kind = typeof step.kind === "string" ? step.kind : "route-visit";
    // Only check interaction steps — route-visits naturally trigger N
    // requests (data load + analytics + asset chunks).
    if (kind === "route-visit") continue;
    const tsBefore = typeof step.tsBefore === "number" ? step.tsBefore : null;
    const tsAfter = typeof step.tsAfter === "number" ? step.tsAfter : null;
    if (tsBefore === null || tsAfter === null) continue;

    const stepReqs = networkLines.filter(
      (l) =>
        l.kind === "request" &&
        typeof l.ts === "number" &&
        l.ts >= tsBefore &&
        l.ts <= tsAfter &&
        typeof l.url === "string" &&
        // Strip Next.js asset bundles — legitimate page-load fanout, not
        // an interaction-handler bug.
        !l.url.includes("/_next/") &&
        // Strip font / google-fonts requests for the same reason.
        !l.url.includes("fonts.googleapis.com") &&
        !l.url.includes("fonts.gstatic.com"),
    );
    if (stepReqs.length === 0) continue;

    // Bucket by method + path (strip origin).
    const counts = new Map<string, number>();
    for (const r of stepReqs) {
      const path = (r.url ?? "").replace(/^https?:\/\/[^/]+/, "");
      const key = `${r.method ?? "GET"} ${path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count < 3) continue;
      const stepIdx =
        typeof step.step === "number" ? step.step : findings.length + 1;
      const url = typeof step.url === "string" ? step.url : "(unknown)";
      const windowMs = tsAfter - tsBefore;
      findings.push({
        id: `walkthrough-deterministic-${stepIdx}-${key.replace(/[^a-z0-9]/gi, "-").slice(0, 30)}`,
        step: stepIdx,
        element: `${kind} on ${url}`,
        observation: `Single ${kind} interaction produced ${count} \`${key}\` requests within ${windowMs}ms (expected 1). Indicates multi-fetcher subscription, missing useCallback memoization, useEffect-without-deps, or duplicate component rendering — the empirical pattern bug-094 surfaced from manual inspection.`,
        expected: "One request per user interaction.",
        category: "duplicate-request",
        severity: count >= 6 ? "P0" : "P1",
        evidence: [
          `network.ndjson time-window ${tsBefore}-${tsAfter} (step ${stepIdx})`,
          `count: ${count}× ${key}`,
        ],
      });
    }
  }
  return findings;
}

/**
 * Read the agent's review.json + normalize findings into the
 * WalkthroughReviewOutput shape. Returns a degraded output on read/parse
 * failure (empty findings + an error entry).
 */
function readAgentReview(reviewJsonPath: string): {
  findings: WalkthroughFinding[];
  alreadyFiled: string[];
  summary: string | undefined;
  errors: Record<string, string>;
} {
  if (!existsSync(reviewJsonPath)) {
    return {
      findings: [],
      alreadyFiled: [],
      summary: undefined,
      errors: {
        agentOutput: `agent did not write review.json at ${reviewJsonPath}`,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reviewJsonPath, "utf8"));
  } catch (err) {
    return {
      findings: [],
      alreadyFiled: [],
      summary: undefined,
      errors: {
        agentOutput: `failed to parse review.json: ${(err as Error).message}`,
      },
    };
  }
  if (raw === null || typeof raw !== "object") {
    return {
      findings: [],
      alreadyFiled: [],
      summary: undefined,
      errors: { agentOutput: "review.json was not a JSON object" },
    };
  }
  const obj = raw as Record<string, unknown>;
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const normalizedFindings = rawFindings
    .map((f, i) => normalizeFinding(f, i))
    .filter((f): f is Record<string, unknown> => f !== null);
  // Schema-validate the per-finding shape via WalkthroughReviewOutputSchema's
  // findings array element schema. Mismatches degrade to empty + error entry.
  const parseRes =
    WalkthroughReviewOutputSchema.shape.findings.safeParse(normalizedFindings);
  const findings: WalkthroughFinding[] = parseRes.success ? parseRes.data : [];
  const alreadyFiled = Array.isArray(obj.alreadyFiled)
    ? obj.alreadyFiled.filter((s): s is string => typeof s === "string")
    : [];
  const summary = typeof obj.summary === "string" ? obj.summary : undefined;
  const errors: Record<string, string> = {};
  if (!parseRes.success) {
    errors.findingsSchema = `agent emitted ${rawFindings.length} findings but ${rawFindings.length - findings.length} failed schema validation`;
  }
  if (
    obj.errors !== undefined &&
    typeof obj.errors === "object" &&
    obj.errors !== null
  ) {
    for (const [k, v] of Object.entries(
      obj.errors as Record<string, unknown>,
    )) {
      if (typeof v === "string") errors[k] = v;
    }
  }
  return { findings, alreadyFiled, summary, errors };
}

/**
 * Format the upstream findings (parity + perceptual) as alreadyFiled hints
 * for the walkthrough-reviewer's prompt context. Each entry is "tier:screen:
 * pattern-or-element" so the agent can dedup against drift already filed.
 */
function formatUpstreamAlreadyFiled(
  parity?: ParityVerifyOutput,
  perceptual?: PerceptualReviewOutput,
): string[] {
  const out: string[] = [];
  if (parity) {
    for (const d of parity.divergences) {
      out.push(`parity:${d.screen}:${d.pattern}`);
    }
  }
  if (perceptual) {
    for (const review of perceptual.reviews) {
      for (const f of review.findings) {
        out.push(`perceptual:${review.screen}:${f.element}`);
      }
    }
  }
  return out;
}

/**
 * Default walkthrough-script runner. Dynamically imports the real
 * `scripts/ai-walkthrough.mjs`. Tests override via `ctx.runWalkthroughScript`.
 */
async function defaultRunWalkthroughScript(args: {
  projectDir: string;
  baseUrl: string;
}): ReturnType<NonNullable<WalkthroughReviewContext["runWalkthroughScript"]>> {
  const specifier = "../../scripts/ai-walkthrough.mjs";
  const mod = (await import(specifier)) as unknown as {
    runAiWalkthrough: (opts: {
      projectDir: string;
      baseUrl: string;
    }) => Promise<{
      ok: boolean;
      stepsRun: number;
      screenshotsCount: number;
      errors: string[];
      warnings: string[];
      durationMs: number;
      outDir: string;
      manifestPath: string | null;
    }>;
  };
  return mod.runAiWalkthrough({
    projectDir: args.projectDir,
    baseUrl: args.baseUrl,
  });
}

/**
 * Main entry point. Runs the walkthrough script + dispatches the agent +
 * normalizes results. Returns an empty + skipped output when cascade-skip
 * rules suppress the run.
 */
export async function runWalkthroughReview(
  ctx: WalkthroughReviewContext,
): Promise<WalkthroughReviewOutput> {
  const start = Date.now();
  const warnings: string[] = [];

  // Ensure output dir exists upfront so the agent's Write succeeds.
  const outputDir = join(ctx.projectDir, WALKTHROUGH_OUT_DIR);
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    warnings.push(
      `walkthrough: failed to mkdir output dir ${outputDir}: ${(err as Error).message}`,
    );
  }

  // Step 1: run the walkthrough script (B.1 — route sweep only).
  const runScript = ctx.runWalkthroughScript ?? defaultRunWalkthroughScript;
  let scriptOut: Awaited<
    ReturnType<NonNullable<WalkthroughReviewContext["runWalkthroughScript"]>>
  >;
  try {
    scriptOut = await runScript({
      projectDir: ctx.projectDir,
      baseUrl: ctx.baseUrl,
    });
  } catch (err) {
    warnings.push(
      `walkthrough: script threw — ${(err as Error).message}; treating as no-screenshots cascade-skip`,
    );
    return {
      ok: true,
      stepsRun: 0,
      findings: [],
      alreadyFiled: [],
      errors: {
        script: (err as Error).message,
      },
      warnings,
      durationMs: Date.now() - start,
      costUsd: 0,
      skippedReason: "walkthrough-script-failed",
    };
  }

  for (const w of scriptOut.warnings) warnings.push(`walkthrough: ${w}`);
  if (scriptOut.screenshotsCount === 0) {
    warnings.push(
      "walkthrough: 0 screenshots produced — likely dev-server unavailable or all routes errored",
    );
    return {
      ok: true,
      stepsRun: scriptOut.stepsRun,
      findings: [],
      alreadyFiled: [],
      errors: scriptOut.errors.length
        ? { script: scriptOut.errors.join(" / ") }
        : {},
      warnings,
      durationMs: Date.now() - start,
      costUsd: 0,
      skippedReason: "no-screenshots",
    };
  }

  // Step 2: dispatch the walkthrough-reviewer agent with the full bundle as
  // pre-loaded context. The agent reads the artefacts directly from disk —
  // we just point it at the manifest + the alreadyFiled hints.
  const taskId = "walkthrough-review";
  const reviewJsonPath = join(outputDir, "review.json");
  const manifestRel = scriptOut.manifestPath
    ? scriptOut.manifestPath
        .slice(ctx.projectDir.length + 1)
        .replace(/\\/g, "/")
    : `${WALKTHROUGH_OUT_DIR}/manifest.json`;
  const alreadyFiledUpstream = formatUpstreamAlreadyFiled(
    ctx.parity,
    ctx.perceptual,
  );
  const preLoadedContext = buildWalkthroughPreload({
    projectDir: ctx.projectDir,
    manifestRel,
    reviewJsonPath,
    taskId,
    stepsRun: scriptOut.stepsRun,
    screenshotsCount: scriptOut.screenshotsCount,
    alreadyFiledUpstream,
  });

  const syntheticTask = {
    id: taskId,
    agent: WALKTHROUGH_AGENT,
    depends_on: [],
    skills: [],
    status: "pending" as const,
    screens: [],
  };

  let costUsd = 0;
  let agentErrors: Record<string, string> = {};
  try {
    const result = await ctx.invokeAgent({
      agent: WALKTHROUGH_AGENT,
      cwd: ctx.projectDir,
      featureContext: {
        id: "walkthrough-review",
        branch: "walkthrough-review",
        priority: "P1",
      },
      tasks: [
        syntheticTask as unknown as Parameters<InvokeAgentFn>[0]["tasks"][number],
      ],
      preLoadedContext,
    });
    costUsd = result.costUsd;
    const taskOutcome = result.taskStatus[taskId];
    if (taskOutcome !== "completed") {
      const errMsg = result.errors[taskId] ?? "agent did not return success";
      warnings.push(`walkthrough: agent failed: ${errMsg}`);
      agentErrors = { dispatch: errMsg };
    }
  } catch (err) {
    warnings.push(`walkthrough: invokeAgent threw — ${(err as Error).message}`);
    agentErrors = { dispatch: (err as Error).message };
  }

  // Step 3: read the agent's review.json (even on agent-failure — it might
  // have written partial output before erroring).
  const review = readAgentReview(reviewJsonPath);

  // Step 4: deterministic duplicate-request detection (feat-069 B.2). The
  // LLM agent occasionally misses cross-step pattern recognition; the
  // deterministic detector guarantees bug-094-class catches regardless of
  // agent attention. Merge results, dedup by (step, category) tuple.
  const deterministicFindings = detectDuplicateRequestPatterns({
    projectDir: ctx.projectDir,
  });
  const allFindings: WalkthroughFinding[] = [...review.findings];
  for (const det of deterministicFindings) {
    const duplicate = allFindings.some(
      (existing) =>
        existing.step === det.step && existing.category === det.category,
    );
    if (!duplicate) allFindings.push(det);
  }

  const errors: Record<string, string> = { ...agentErrors, ...review.errors };
  const ok = allFindings.length === 0 && Object.keys(errors).length === 0;

  const out: WalkthroughReviewOutput = {
    ok,
    stepsRun: scriptOut.stepsRun,
    findings: allFindings,
    alreadyFiled: review.alreadyFiled.length
      ? review.alreadyFiled
      : alreadyFiledUpstream,
    errors,
    warnings,
    durationMs: Date.now() - start,
    costUsd,
  };
  if (review.summary !== undefined) out.summary = review.summary;
  return out;
}

/**
 * Build the pre-loaded context block for the walkthrough-reviewer's user
 * prompt. Names the artefact paths (relative to projectDir) the agent
 * should read + the upstream findings to dedup against.
 */
function buildWalkthroughPreload(args: {
  projectDir: string;
  manifestRel: string;
  reviewJsonPath: string;
  taskId: string;
  stepsRun: number;
  screenshotsCount: number;
  alreadyFiledUpstream: string[];
}): string {
  const reviewJsonRel = args.reviewJsonPath
    .slice(args.projectDir.length + 1)
    .replace(/\\/g, "/");
  return [
    "## Walkthrough evidence bundle",
    "",
    `The walkthrough script just completed:`,
    `- stepsRun: ${args.stepsRun}`,
    `- screenshotsCount: ${args.screenshotsCount}`,
    "",
    "### Files to read (paths are relative to your cwd):",
    `- ${args.manifestRel} — step manifest (per-step screenId + routePattern + screenshot filename + timestamp window)`,
    `- docs/build-to-spec/walkthrough/network.ndjson — one JSON line per network request + response`,
    `- docs/build-to-spec/walkthrough/console.ndjson — one JSON line per console event + uncaught error`,
    `- docs/build-to-spec/walkthrough/step-*.png — one screenshot per step, named by stepIdx + slug`,
    "",
    "### Output path (write your findings here):",
    `- ${reviewJsonRel}`,
    "",
    "### Synthetic task id (use this in your sentineled outcome JSON):",
    `- ${args.taskId}`,
    "",
    "### alreadyFiled (do NOT re-report these — they're covered by upstream tiers):",
    args.alreadyFiledUpstream.length === 0
      ? "(none — upstream tiers found nothing on the screens you'll see)"
      : args.alreadyFiledUpstream.map((s) => `- ${s}`).join("\n"),
  ].join("\n");
}

/**
 * Flatten findings into one-bug-per-finding violations for
 * build-to-spec-verify to file via fileBugPlan. Each violation maps 1:1 to
 * a `walkthrough-divergence` bug plan + bugs.yaml entry.
 */
export function walkthroughReviewToViolations(
  output: WalkthroughReviewOutput,
): {
  step: number;
  element: string;
  observation: string;
  expected?: string;
  category?: string;
  severity: WalkthroughFinding["severity"];
  evidence: string[];
}[] {
  const out: ReturnType<typeof walkthroughReviewToViolations> = [];
  for (const finding of output.findings) {
    const entry: ReturnType<typeof walkthroughReviewToViolations>[number] = {
      step: finding.step,
      element: finding.element,
      observation: finding.observation,
      severity: finding.severity,
      evidence: finding.evidence,
    };
    if (finding.expected !== undefined) entry.expected = finding.expected;
    if (finding.category !== undefined) entry.category = finding.category;
    out.push(entry);
  }
  return out;
}
