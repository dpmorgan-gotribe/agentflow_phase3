import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BuildToSpecVerifyOutput,
  type BuildToSpecVerifyOutput as BuildToSpecVerifyOutputType,
  type FlowFailure,
  type FlowPrimaryCause,
  type OrphanComponent,
  type OrphanRoute,
  type ParityVerifyOutput,
  type ParityDivergence,
} from "@repo/orchestrator-contracts";
import { runParityVerify, type ParityVerifyContext } from "./parity-verify.js";
import {
  runPerceptualReview,
  perceptualReviewToViolations,
} from "./perceptual-review.js";
import {
  runWalkthroughReview,
  walkthroughReviewToViolations,
} from "./walkthrough-review.js";
import type {
  PerceptualReviewOutput,
  WalkthroughReviewOutput,
} from "@repo/orchestrator-contracts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bootDevServer,
  readPersistenceLayerSlug,
  teardownDevServer,
  type DevServerHandle,
} from "./dev-server.js";
import {
  runDiscriminators,
  type DiscriminatorResult,
} from "./pre-verify-discriminators.js";

/**
 * feat-022 Phase 4 — orchestrator-side wrapper for the
 * `/build-to-spec-verify` deterministic skill.
 *
 * This is NOT an LLM dispatch. It shells out to two pure scripts
 * (`scripts/audit-app-reachability.mjs` + `scripts/synthesize-flow-e2e.mjs`),
 * aggregates their output, optionally auto-files bug plans for each
 * violation via `scripts/file-bug-plan.mjs`, and returns a typed
 * `BuildToSpecVerifyOutput` that the post-Mode-B step in
 * `feature-graph.ts` consumes.
 *
 * The synthesizer's emitted spec files persist as a regression suite for
 * the next run — we don't actually EXECUTE them here (that requires a live
 * dev server + Playwright runtime, which the project owns; the orchestrator
 * stages on the green-build assumption that `pnpm playwright test` ran as
 * part of the tester step). For the gap-detection pass we need the static
 * reachability layer plus the existence + parseability of the spec files.
 *
 * Future versions (v2) will run the synthesized specs against a temporary
 * dev server during this stage; v1 keeps the runtime cost at ~$0 by
 * relying on the existing tester-stage Playwright invocation to surface
 * any regressions of the synthesized specs on the next run.
 */

export interface BuildToSpecVerifyContext {
  projectDir: string;
  /** Repo root for the factory itself (where scripts/ lives). Defaults to process.cwd(). */
  factoryRoot?: string;
  /** When true, file bug plans for each violation. Default true. */
  autoFileBugPlans?: boolean;
  /**
   * feat-026 — pipelineRunId + iteration forwarded into bug entries
   * appended to `docs/bugs.yaml`. Optional; defaults are "unknown" + 1
   * when absent so standalone (non-orchestrator) verifier runs still
   * write a usable file.
   */
  pipelineRunId?: string;
  iteration?: number;
  /** Test seam — replaces the spawn() helper. Default uses `node`. */
  runScript?: (args: {
    script: string;
    projectDir: string;
    cwd: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Test seam — replaces fileBugPlan import; receives the structured violation. */
  fileBugPlan?: (args: {
    projectDir: string;
    violation: BugPlanViolation;
    relatedOrphan?: OrphanComponent;
    pipelineRunId?: string;
    iteration?: number;
    /**
     * feat-027 Phase D — when set, the bug-author tags the resulting
     * bugs.yaml entry with `dependsOnBugId: <id>`. The bug-fix loop uses
     * this to defer dependent timeouts until the cascade root resolves.
     * Optional; only flow-execution-failure bugs with primaryCause:
     * "timeout-no-evidence" carry it.
     */
    dependsOnBugId?: string;
  }) => Promise<{ planId: string; planPath: string; bugYamlId?: string }>;
  /**
   * feat-025 Phase 3 — test seam for the flow-execution runner. Replaces
   * the `runSynthesizedFlows()` import from `scripts/run-synthesized-flows.mjs`.
   * If omitted in tests, the runner is invoked via dynamic import (same
   * pattern as `fileBugPlan`).
   */
  runFlows?: (args: {
    projectDir: string;
    factoryRoot: string;
  }) => Promise<RunFlowsResult>;
  /**
   * feat-025 Phase 3 — when false, skip the flow-execution stage entirely
   * (only run reachability + synthesis). Default true. Tests that don't
   * exercise execution can opt out without supplying a stub.
   */
  executeFlows?: boolean;
  /**
   * feat-028 Phase 4 — when false, skip the visual-parity stage entirely.
   * Default true. The stage is also a runtime no-op (returns ok:true,
   * screensChecked:0) when the project has no
   * `docs/screens/{platform}/*.html` mockups, so most callers don't need
   * to disable it explicitly.
   */
  runParity?: boolean;
  /**
   * feat-028 Phase 4 — test seam replacing the parity-verify wrapper.
   * Defaults to `runParityVerify` from `./parity-verify.js`. Tests stub
   * to inject canned divergences without booting Playwright.
   */
  parityVerify?: (ctx: ParityVerifyContext) => Promise<ParityVerifyOutput>;
  /**
   * feat-068 — when false, skip the Tier 4 vision-LLM perceptual review.
   * Default true; perceptual review is a no-op when parity didn't run (no
   * source PNGs on disk) so the default-on stance is safe for parity-less
   * projects too. Cost: ~$0.005-0.01 per screen × N screens per iteration.
   */
  runPerceptual?: boolean;
  /**
   * feat-073 — round-state orchestration. When set, gates expensive
   * detection tiers on round-state: Tier 4 (perceptual review) only fires
   * when 4 is in the set; future Tier 5 (walkthrough) only when 5 is in
   * the set. Cheap tiers (0-3) always fire regardless. When unset,
   * back-compat behavior (every tier fires unless individually disabled
   * via runParity / runPerceptual / etc.). The runRoundsOrchestrator
   * wrapper (Phase B) sets this from the active round's enabledTiers.
   */
  enabledTiers?: ReadonlySet<import("@repo/orchestrator-contracts").TierId>;
  /**
   * feat-068 — test seam replacing the perceptual-review wrapper. Defaults
   * to `runPerceptualReview` from `./perceptual-review.js`. Tests stub to
   * inject canned findings without making real LLM calls.
   */
  perceptualReview?: typeof import("./perceptual-review.js").runPerceptualReview;
  /**
   * feat-069 — when false, skip the Tier 5 AI walkthrough behavioral review.
   * Default true; the walkthrough is a no-op when round 5 isn't in enabledTiers
   * OR when invokeAgent is not provided OR when the walkthrough script
   * produces zero screenshots.
   */
  runWalkthrough?: boolean;
  /**
   * feat-069 — test seam replacing the walkthrough-review wrapper. Defaults
   * to `runWalkthroughReview` from `./walkthrough-review.js`. Tests stub to
   * inject canned findings without making real LLM / Playwright calls.
   */
  walkthroughReview?: typeof import("./walkthrough-review.js").runWalkthroughReview;
  /**
   * bug-091 follow-up — test seam replacing the dev-server pre-boot. Defaults
   * to `bootDevServer` from `./dev-server.js`. Tests stub to skip the actual
   * boot (which spawns processes + waits up to 60s for HTTP probes — kills
   * test timeouts when an empty tmp project root can't satisfy the wait).
   * Production keeps the real bootDevServer.
   */
  bootDevServer?: typeof import("./dev-server.js").bootDevServer;
  /**
   * bug-112 Patch D — gate the pre-flight `pnpm install` step. Defaults to
   * `true` (production behavior). Tests pass `false` to skip the install
   * (the tmp project roots they seed don't need it + would hit the network).
   */
  runPreflightInstall?: boolean;
  /**
   * feat-068 — invokeAgent seam plumbed through from the orchestrator so
   * perceptualReview can dispatch the perceptual-reviewer agent with the
   * same SDK auth + budget tracking as fix-loop dispatches. When unset,
   * perceptual review is skipped (warning surfaced).
   */
  invokeAgent?: import("./feature-graph.js").InvokeAgentFn;
  /**
   * bug-090 — when set, bug-filing writes (docs/bugs.yaml + plans/active/)
   * go to THIS path while everything else (reach + synth + dev-server +
   * runFlows + parityVerify + perceptual) reads from `projectDir`. Lets the
   * fix-bugs loop point projectDir at the dedicated verify worktree (fresh
   * `fix/bugs-yaml-iter` state) while keeping the loop's own bugs.yaml
   * read/write loop at the operator-facing projectRoot. Defaults to
   * `projectDir` (pre-bug-090 behavior) when unset — preserves /start-build
   * post-Mode-B verify semantics where there's no separate verify worktree.
   */
  bugFilingProjectDir?: string;
}

/**
 * Output shape from `scripts/run-synthesized-flows.mjs`. Matches the JSON
 * the runner emits to stdout. Mirrors `BuildToSpecVerifyOutput.flows` plus
 * pre-flight gating fields (`reason` / `remediation`) when Playwright
 * isn't installed.
 */
export interface RunFlowsResult {
  ok: boolean;
  reason?: string;
  remediation?: string;
  browser?: string;
  flows: {
    passed: string[];
    failed: FlowFailure[];
    skipped: string[];
  };
  devServerStartedMs?: number;
  totalRunMs?: number;
  warnings?: string[];
}

/**
 * feat-028 Phase 4 — minimal serializable shape for a parity divergence
 * the bug-author template consumes. Mirrors `ParityDivergence` from the
 * contracts package; defined inline to avoid forcing the bug-author script
 * (a .mjs CLI helper) to import the Zod-generated type.
 */
export interface ParityViolationShape {
  screen: string;
  pattern: string;
  severity: "P0" | "P1" | "P2";
  detail: {
    missing: string[];
    extra: string[];
    variantDrift: {
      selector: string;
      mockupValue: string;
      builtValue: string;
    }[];
    styleDrift: {
      selector: string;
      property: string;
      mockupValue: string;
      builtValue: string;
    }[];
  };
}

export type BugPlanViolation =
  | (FlowFailure & { kind: "flow-failure" })
  | (FlowFailure & { kind: "runtime-error" })
  | (FlowFailure & { kind: "dev-server-compile" })
  | (OrphanComponent & { kind: "orphan-component" })
  | (OrphanRoute & { kind: "orphan-route" })
  | (ParityViolationShape & { kind: "parity-divergence" });

/**
 * feat-056 Gap A (2026-05-06) — classify `runSynthesizedFlows` pre-flight
 * failures (Playwright not installed, dev-server didn't respond, runner
 * crashed) into a synthetic FlowFailure so the downstream cascade-root
 * file-bug logic catches them. Without this, the verifier soft-gates
 * these as warnings and bugs.yaml stays empty — the silent-success
 * antipattern. Maps known `reason` strings from
 * `scripts/run-synthesized-flows.mjs` to existing FlowPrimaryCause enum
 * values; unknown reasons fall back to `timeout-no-evidence`.
 */
const TOOL_REASON_TO_CAUSE: Record<string, FlowPrimaryCause> = {
  "dev-server-not-ready": "dev-server-compile",
  "playwright-not-installed": "runtime-error",
  "playwright-runner-threw": "runtime-error",
  "playwright-runner-failed-to-start": "runtime-error",
  // feat-057 Phase B: separate reason for missing chromium binary so the
  // file-bug-plan defaultAgentSequence routes to operator-action retry-
  // target instead of dispatching futile builder retries (no builder agent
  // can install a runtime binary).
  "playwright-browser-missing": "runtime-error",
};

function synthesizeToolFailure(
  reason: string,
  remediation?: string,
  stderrTail?: string,
): FlowFailure {
  const primaryCause: FlowPrimaryCause =
    TOOL_REASON_TO_CAUSE[reason] ?? "timeout-no-evidence";
  const out: FlowFailure = {
    flowId: "tooling-pre-flight",
    flowName: "tool pre-flight (dev-server / playwright)",
    step: 0,
    fromScreenId: null,
    expectedScreenId: null,
    actualScreenId: null,
    selector: null,
    screenshotPath: null,
    htmlDumpPath: null,
    primaryCause,
    message: remediation ? `${reason}: ${remediation}` : reason,
  };
  // bug-057 (2026-05-06) — propagate captured stderr into the FlowFailure
  // so file-bug-plan.mjs can enrich bug.summary + errorLog with the actual
  // failure detail. Truncate defensively at 1500 chars (matches schema cap).
  if (stderrTail && stderrTail.length > 0) {
    out.stderrTail = stderrTail.slice(0, 1500);
  }
  return out;
}

/**
 * bug-112 Patch D — `pnpm install` from the project root. Used by the
 * verifier's pre-flight when `<projectDir>/node_modules` is absent.
 * Mode B's `installAfterCommit` covers post-merge installs during the
 * feature graph; this closes the gap for manual / fix-bugs-loop / operator-
 * reentry paths where the project's deps may not be present.
 */
async function runPreflightInstall(projectDir: string): Promise<void> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "pnpm.cmd" : "pnpm";
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, ["install"], {
      cwd: projectDir,
      windowsHide: true,
      shell: isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    if (child.stdout) child.stdout.on("data", () => {});
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          stderrTail.push(line);
          if (stderrTail.length > 50) stderrTail.shift();
        }
      });
    }
    child.on("error", (err) => rejectP(err));
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else
        rejectP(
          new Error(
            `pnpm install exited with code ${code}. stderr tail:\n${stderrTail.slice(-15).join("\n")}`,
          ),
        );
    });
  });
}

/**
 * Default `runScript` implementation. Spawns `node <script> <projectDir>`
 * from the factory root, captures stdout/stderr, returns parseable JSON.
 */
async function defaultRunScript({
  script,
  projectDir,
  cwd,
}: {
  script: string;
  projectDir: string;
  cwd: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [script, projectDir], {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) =>
      resolveP({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
}

/**
 * Run the deterministic verification stage. Returns a parsed
 * `BuildToSpecVerifyOutput` (Zod-validated). On internal failure
 * (script crash, missing project, JSON parse fail) returns an `ok: false`
 * payload with a `warnings[]` entry — the caller decides whether to abort
 * the orchestrator's "complete" signal.
 */
export async function runBuildToSpecVerify(
  ctx: BuildToSpecVerifyContext,
): Promise<BuildToSpecVerifyOutputType> {
  const startedAt = Date.now();
  const factoryRoot = ctx.factoryRoot ?? process.cwd();
  const runScript = ctx.runScript ?? defaultRunScript;
  const projectDir = resolve(ctx.projectDir);
  // bug-090 — bug-filing writes go here (default to projectDir for pre-
  // bug-090 callers; fix-bugs-loop sets this explicitly to the operator's
  // projectRoot when projectDir is the verify worktree).
  const bugFilingProjectDir = ctx.bugFilingProjectDir
    ? resolve(ctx.bugFilingProjectDir)
    : projectDir;

  const warnings: string[] = [];

  // ── bug-112 Patch D: pre-flight pnpm install when node_modules absent ────
  // Mode B's installAfterCommit covers post-merge installs during the
  // feature graph. The verifier's manual / fix-bugs-loop / operator-reentry
  // paths have no equivalent. Without this gate, a project whose root
  // node_modules is missing produces a silent 60s frontend pre-boot timeout
  // (the empirical motivator from gotribe-tribe-directory 2026-05-15:
  // `'next' is not recognized` exited in ~1s but `last error: ` was empty
  // because of orthogonal dev-server gaps fixed under bug-112 Patches A+B+C).
  // Cheap when not needed (~1ms existsSync); 30-60s when needed (the
  // alternative is 60s silent timeout PLUS false-clean report PLUS Tier 3+4+5
  // cascade-skip).
  // Gated on package.json presence — a tmpdir with no package.json is not a
  // real project (test seam) so we skip. Tests can also opt out via
  // ctx.runPreflightInstall === false.
  if (
    ctx.runPreflightInstall !== false &&
    existsSync(resolve(projectDir, "package.json")) &&
    !existsSync(resolve(projectDir, "node_modules"))
  ) {
    const installStartedAt = Date.now();
    try {
      await runPreflightInstall(projectDir);
      warnings.push(
        `verifier pre-flight: ran pnpm install (took ${Date.now() - installStartedAt}ms; root node_modules was missing)`,
      );
    } catch (err) {
      warnings.push(
        `verifier pre-flight: pnpm install FAILED (${(err as Error).message}); dev-server spawn likely to fail next. Operator action: cd <projectDir> && pnpm install`,
      );
    }
  }

  // ── bug-078 / feat-066 v2 Phase 1B: deterministic pre-verify gate ────────
  // Run the cheap (~10ms) filesystem-only discriminators FIRST. When ANY
  // P0 discriminator hits, we short-circuit the entire expensive verifier
  // stage — the systemic bug masks every symptom-bug parity-verify + flow-
  // execution would otherwise file. Emit ONE root-cause bug per P0 hit;
  // skip reach + synth + flows + parity. P1/P2 hits are filed too but
  // don't trigger the short-circuit (they're warnings + reach/parity still
  // produces useful signal).
  const discriminatorHits = runDiscriminators(projectDir);
  const p0Hits = discriminatorHits.filter((h) => h.severity === "P0");
  for (const h of discriminatorHits) {
    warnings.push(`pre-verify-discriminator: ${h.pattern} — ${h.label}`);
  }
  if (p0Hits.length > 0) {
    return await emitDiscriminatorShortCircuit({
      ctx,
      projectDir,
      hits: discriminatorHits,
      warnings,
      startedAt,
    });
  }

  const reachScript = resolve(
    factoryRoot,
    "scripts/audit-app-reachability.mjs",
  );
  const synthScript = resolve(factoryRoot, "scripts/synthesize-flow-e2e.mjs");

  // Sanity: scripts must exist
  if (!existsSync(reachScript)) warnings.push(`missing script: ${reachScript}`);
  if (!existsSync(synthScript)) warnings.push(`missing script: ${synthScript}`);

  // Run both in parallel
  const [reachResult, synthResult] = await Promise.all([
    runScript({ script: reachScript, projectDir, cwd: factoryRoot }).catch(
      (err) => ({ stdout: "", stderr: String(err), exitCode: 1 }),
    ),
    runScript({ script: synthScript, projectDir, cwd: factoryRoot }).catch(
      (err) => ({ stdout: "", stderr: String(err), exitCode: 1 }),
    ),
  ]);

  // Parse reachability output
  let orphanComponents: OrphanComponent[] = [];
  let orphanRoutes: OrphanRoute[] = [];
  let scannedFiles = 0;
  let ignoredByAllowComment: string[] = [];
  try {
    const parsed = JSON.parse(reachResult.stdout);
    orphanComponents = (parsed.orphanComponents ?? []) as OrphanComponent[];
    orphanRoutes = (parsed.orphanRoutes ?? []) as OrphanRoute[];
    scannedFiles = Number(parsed.scannedFiles ?? 0);
    ignoredByAllowComment = parsed.ignoredByAllowComment ?? [];
  } catch (err) {
    warnings.push(
      `reachability script output parse failed: ${(err as Error).message}; stderr: ${reachResult.stderr.slice(0, 200)}`,
    );
  }

  // Parse synth output
  let generatedFiles: string[] = [];
  let synthOk = false;
  try {
    const parsed = JSON.parse(synthResult.stdout);
    // bug-156 — `skippedFiles` covers two distinct cases: (1) flows with empty
    // interactions[] (the historical skip-reason; nothing to run) and (2) flows
    // whose existing spec file carries a `FACTORY-SKIP-REGEN` marker (hand-
    // patches the synthesizer can't yet emit). The latter ARE runnable + must
    // join the runner's queue alongside generatedFiles, otherwise tier-2 silently
    // reports flows.passed:[] flows.failed:[] for a fully-functional spec set.
    const skippedFromMarker = (parsed.skippedFiles ?? []).filter(
      (p: string) => {
        try {
          const head = readFileSync(resolve(projectDir, p), "utf8")
            .split("\n")
            .slice(0, 5)
            .join("\n");
          return /FACTORY-SKIP-REGEN/.test(head);
        } catch {
          return false;
        }
      },
    );
    generatedFiles = [...(parsed.generatedFiles ?? []), ...skippedFromMarker];
    synthOk = parsed.ok === true;
    if (!synthOk && parsed.reason) {
      warnings.push(`synth: ${parsed.reason}`);
    }
    // bug-041 Phase A (2026-05-03): surface the synthesizer's warnings[] +
    // errors[] arrays so config-level gaps reach the operator. errors[] are
    // hard failures (specs generated but cannot run — e.g. webServer block
    // absent); warnings[] are informational. Both flow into the verifier's
    // warnings[] for now; auto-filing as bugs is a separate Phase D concern.
    for (const w of parsed.warnings ?? []) {
      warnings.push(`synth: ${w}`);
    }
    for (const e of parsed.errors ?? []) {
      warnings.push(`synth ERROR: ${e}`);
    }
  } catch (err) {
    warnings.push(
      `synth script output parse failed: ${(err as Error).message}; stderr: ${synthResult.stderr.slice(0, 200)}`,
    );
  }

  // ── bug-071 fix (2026-05-07): pre-boot dev-server ONCE for both runFlows
  // ── and parityVerify, share URL, teardown at end. ────────────────────────
  //
  // Pre-fix architecture: parityVerify auto-booted (works ✓) but tore down
  // before runFlows; runFlows shelled to scripts/run-synthesized-flows.mjs
  // which detected playwright.config.ts's `webServer:` block and DEFERRED
  // to playwright's auto-spawn (which 0-bytes for 180s on Windows under
  // nested pnpm shells — the actual bug-071). Net: synth-e2e tier was dead-
  // on-arrival; investigate-022 traced 5 of 8 manually-found review bugs
  // back to this wedge.
  //
  // Post-fix: orchestrator hoists the dev-server lifecycle. bootDevServer()
  // ALREADY sets ENABLE_TEST_SEED=1 in the backend env (dev-server.ts:230)
  // so /test/seed-baseline is reachable. With servers up before playwright
  // fires, `reuseExistingServer:!CI` (default in playwright.config.ts)
  // sees them + skips its own webServer spawn. Empirically validated
  // 2026-05-07: 6 synth-e2e specs run in 3min when servers pre-booted vs.
  // 0 specs / 180s timeout when playwright spawns fresh.
  const needsDevServer =
    (ctx.executeFlows !== false && generatedFiles.length > 0) ||
    ctx.runParity !== false;
  // bug-111 — hoisted ahead of pre-boot block so the catch handler can push a
  // synthesized FlowFailure when stderr matches a module-import-failure
  // signature. The original declarations live below at line 522-524 alongside
  // flowsPassed + flowsRan; this hoist exists so the pre-boot block can route
  // module-import-failures into the cascade-root file-bug-plan path.
  const flowsPassed: string[] = [];
  const flowsFailed: FlowFailure[] = [];
  let flowsRan = false; // bug-095 — set true when runFlows actually executed
  let sharedDevServerHandle: DevServerHandle | null = null;
  if (needsDevServer) {
    try {
      const persistenceLayer = readPersistenceLayerSlug(projectDir);
      const bootTimeoutMs = persistenceLayer === "real-db" ? 180_000 : 60_000;
      const bootDevServerFn = ctx.bootDevServer ?? bootDevServer;
      sharedDevServerHandle = await bootDevServerFn(projectDir, bootTimeoutMs);
      warnings.push(
        `dev-server: pre-booted at ${sharedDevServerHandle.baseUrl} (took ${Date.now() - sharedDevServerHandle.startedAtMs}ms)`,
      );
    } catch (err) {
      const errMessage = (err as Error).message;
      // bug-111 — when the pre-boot failure signature is a module-import
      // error (canonical: FastAPI `Could not import module "api.main"`;
      // Python: `ModuleNotFoundError`; Node: `Cannot find module`), the
      // root cause is project-source (entry file at wrong path) not
      // operator environment (uv/pnpm/port). Synthesize a runtime-error
      // FlowFailure and push to flowsFailed[] so the existing cascade-
      // root file-bug-plan path catches it. Non-module-import failures
      // (port collision, dependency missing, true 60s timeout) stay on
      // the warnings.push path — those are operator-environment issues.
      const moduleImportFailureMatch = errMessage.match(
        /(Could not import module "([^"]+)"|ModuleNotFoundError: No module named '([^']+)'|Cannot find module '([^']+)')/,
      );
      if (moduleImportFailureMatch) {
        const offendingModule =
          moduleImportFailureMatch[2] ??
          moduleImportFailureMatch[3] ??
          moduleImportFailureMatch[4] ??
          "unknown";
        flowsFailed.push({
          flowId: "backend-boot-failure",
          flowName: `backend dev-server failed to import \`${offendingModule}\``,
          step: 0,
          fromScreenId: null,
          expectedScreenId: null,
          actualScreenId: null,
          selector: null,
          screenshotPath: null,
          htmlDumpPath: null,
          primaryCause: "runtime-error",
          message: `Backend dev-server pre-boot failed at module import for \`${offendingModule}\`. The canonical app entrypoint is named in the relevant backend stack skill's §dev-orchestrator (e.g. python-fastapi expects \`apps/api/src/api/main.py\` so \`uv run uvicorn api.main:app --app-dir src\` resolves; node-fastify expects \`apps/api/src/server.ts\`; node-trpc-nest expects \`apps/api/src/main.ts\`). Builder authored the entry file at a non-canonical path. Fix: move the entry file to the canonical path (no import edits needed if absolute imports already resolve via the project's pyproject.toml / package.json package discovery). Then verify with the stack's importability probe — for FastAPI: \`(cd apps/api && uv run python -c "import importlib; importlib.import_module('api.main')")\` exits 0.`,
          stderrTail: errMessage.slice(0, 1500),
        });
        warnings.push(
          `dev-server pre-boot failed: module-import failure for \`${offendingModule}\` — auto-filed as runtime-error bug (bug-111 detection path).`,
        );
      } else {
        warnings.push(
          `dev-server pre-boot failed: ${errMessage}; runFlows + parityVerify will fall back to their own spawn paths (which trip bug-071 on Strategy C — synth-e2e likely 0-tests-run)`,
        );
      }
    }
  }

  // ── feat-025 Phase 3: execute synthesized flow specs ─────────────────────
  // Call the runner only when synthesis emitted at least one spec AND
  // executeFlows isn't explicitly disabled. The runner shells out to
  // `pnpm -C apps/web exec playwright test e2e/synthesized/`; it gracefully
  // degrades to `{ ok:false, reason:"playwright-not-installed" }` when the
  // project hasn't installed the runtime — we propagate that as a warning
  // (not a failure) so the verify stage stays soft-gated for v1.
  // flowsPassed / flowsFailed / flowsRan declared above (bug-111 hoist).
  if (ctx.executeFlows !== false && generatedFiles.length > 0) {
    let runResult: RunFlowsResult | null = null;
    try {
      const runFlows: NonNullable<BuildToSpecVerifyContext["runFlows"]> =
        ctx.runFlows ??
        (async ({ projectDir: pd, factoryRoot: fr }) => {
          const specifier = `../../scripts/run-synthesized-flows.mjs`;
          const mod = (await import(specifier)) as unknown as {
            runSynthesizedFlows: (args: {
              projectDir: string;
              devServerTimeoutMs?: number;
              baseUrlOverride?: string;
            }) => Promise<RunFlowsResult>;
          };
          // factoryRoot is unused by the runner (it doesn't shell to other
          // factory scripts) but we accept it for symmetry with reach/synth.
          void fr;
          // bug-062 (2026-05-07) — extend dev-server-not-ready timeout from
          // 60s default to 180s for Strategy C (real-db) projects. Empirical
          // motivator: reading-log-01 (first Strategy C ship) backend cold-
          // boot routinely exceeds 60s on Windows because Prisma migrate-on-
          // boot adds 5-15s + pnpm shell adds 3-5s + fastify init adds 2-5s.
          // 60s default fires before /health responds → 0 e2e tests run →
          // behavioral verification layer blocked. Strategy A/D projects
          // keep the 60s default since they don't boot a real backend.
          const persistenceLayer = readPersistenceLayerSlug(pd);
          const devServerTimeoutMs =
            persistenceLayer === "real-db" ? 180_000 : undefined;
          // bug-071 fix (2026-05-07) — pass pre-booted dev-server URL when
          // the orchestrator hoisted the boot above runFlows. The runner
          // detects this + skips its own spawn / playwright-webServer-
          // deferral path. With servers up, playwright's
          // `reuseExistingServer:!CI` (default) sees them + skips its own
          // webServer spawn (which is what 0-bytes for 180s on Windows).
          const baseUrlOverride = sharedDevServerHandle?.baseUrl;
          return mod.runSynthesizedFlows({
            projectDir: pd,
            ...(devServerTimeoutMs !== undefined ? { devServerTimeoutMs } : {}),
            ...(baseUrlOverride !== undefined ? { baseUrlOverride } : {}),
          });
        });
      runResult = await runFlows({ projectDir, factoryRoot });
      flowsRan = true;
    } catch (err) {
      // feat-056 Gap A — runner crash classifies as runtime-error tool
      // failure → cascade-root bug filed by downstream pipeline.
      // bug-057 — capture the err.message as stderrTail so the dispatched
      // agent has the actual crash detail.
      flowsFailed.push(
        synthesizeToolFailure(
          "playwright-runner-threw",
          (err as Error).message,
          (err as Error).stack ?? (err as Error).message,
        ),
      );
      warnings.push(`run-synthesized-flows threw: ${(err as Error).message}`);
    }
    if (runResult) {
      if (!runResult.ok && runResult.reason) {
        // feat-056 Gap A — classify pre-flight failures (dev-server
        // didn't start, Playwright not installed, etc.) into a synthetic
        // FlowFailure with the appropriate FlowPrimaryCause. The
        // downstream cascade-root file-bug logic at "feat-027 Phase D"
        // (~50 lines below) picks it up + dispatches to the correct
        // retry-target. Without this, bugs.yaml stays empty even when
        // the verifier's tooling can't run — silent-success antipattern.
        // bug-057 — pass remediation as stderrTail so file-bug-plan can
        // populate bug.errorLog with the captured stderr; the dispatched
        // agent reads it from retryContext.errorMessage.
        flowsFailed.push(
          synthesizeToolFailure(
            runResult.reason,
            runResult.remediation,
            runResult.remediation,
          ),
        );
        warnings.push(
          `flow-execution: ${runResult.reason}${runResult.remediation ? ` (${runResult.remediation})` : ""}`,
        );
      }
      for (const w of runResult.warnings ?? []) {
        warnings.push(`flow-execution: ${w}`);
      }
      flowsPassed.push(...runResult.flows.passed);
      flowsFailed.push(...runResult.flows.failed);
    }
  }

  const flows = {
    passed: flowsPassed,
    failed: flowsFailed,
    generated: generatedFiles,
  };

  // ── feat-022 + feat-025 Phase 4: auto-file bug plans ─────────────────────
  // For each flow failure, correlate with reachability orphans by
  // owningFeature (when known): emit ONE consolidated bug plan per (flow,
  // owning-feature) tuple — the bug-plan template renders both contexts
  // together so the builder fixes the wiring + the navigation in one pass.
  const bugPlansFiled: string[] = [];
  if (ctx.autoFileBugPlans !== false) {
    const fileBugPlan: NonNullable<BuildToSpecVerifyContext["fileBugPlan"]> =
      ctx.fileBugPlan ??
      (async ({
        // bug-090: ignore the per-call projectDir (= verifyCwd in fix-loop
        // dispatches) and write to the operator-facing bugFilingProjectDir
        // instead. The verifier reads from projectDir but bug-filing writes
        // (docs/bugs.yaml + plans/active/) must hit the loop-visible path
        // so the next iteration sees new entries. When unset,
        // bugFilingProjectDir falls back to projectDir (pre-bug-090).
        projectDir: _ignoredCallerProjectDir,
        violation,
        relatedOrphan,
        pipelineRunId: prid,
        iteration: it,
        dependsOnBugId,
      }) => {
        void _ignoredCallerProjectDir;
        const specifier = `../../scripts/file-bug-plan.mjs`;
        const mod = (await import(specifier)) as unknown as {
          fileBugPlan: (args: {
            projectDir: string;
            violation: BugPlanViolation;
            relatedOrphan?: OrphanComponent;
            pipelineRunId?: string;
            iteration?: number;
            dependsOnBugId?: string;
          }) => Promise<{
            planId: string;
            planPath: string;
            bugYamlId?: string;
          }>;
        };
        const callArgs: Parameters<typeof mod.fileBugPlan>[0] = {
          projectDir: bugFilingProjectDir,
          violation,
        };
        if (relatedOrphan !== undefined) callArgs.relatedOrphan = relatedOrphan;
        if (prid !== undefined) callArgs.pipelineRunId = prid;
        if (it !== undefined) callArgs.iteration = it;
        if (dependsOnBugId !== undefined)
          callArgs.dependsOnBugId = dependsOnBugId;
        return mod.fileBugPlan(callArgs);
      });

    // Track orphans already consumed by a consolidated flow-failure plan
    // so we don't double-file (orphan stand-alone plan + flow plan that
    // mentions the same orphan).
    const consumedOrphanPaths = new Set<string>();

    // ── feat-027 Phase D: classify failures by primaryCause ─────────────────
    // dev-server-compile + runtime-error bugs are CASCADE ROOTS — they
    // typically mask every downstream timeout. File them FIRST so the
    // bugs.yaml priority sort + the bug-fix loop see them before chasing
    // dependent failures. After they file, surface their bug IDs as a
    // `dependsOnBugId` on any subsequent flow-execution-failure tagged
    // with primaryCause: "timeout-no-evidence" so the loop suppresses /
    // defers them until the cascade root resolves.
    const cascadeRootFailures = flowsFailed.filter(
      (f) =>
        f.primaryCause === "dev-server-compile" ||
        f.primaryCause === "runtime-error",
    );
    const dependentFailures = flowsFailed.filter(
      (f) =>
        f.primaryCause !== "dev-server-compile" &&
        f.primaryCause !== "runtime-error",
    );
    const cascadeRootBugIds: string[] = [];

    // 0. cascade-root plans (dev-server-compile + runtime-error)
    for (const failure of cascadeRootFailures) {
      try {
        const kind: "runtime-error" | "dev-server-compile" =
          failure.primaryCause === "dev-server-compile"
            ? "dev-server-compile"
            : "runtime-error";
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: {
            ...failure,
            kind,
          },
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
        cascadeRootBugIds.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for ${failure.primaryCause} ${failure.flowId}: ${(err as Error).message}`,
        );
      }
    }

    // 1. flow-failure plans (consolidated with related orphan when matched)
    for (const failure of dependentFailures) {
      try {
        const relatedOrphan = correlateFlowFailureToOrphan(
          failure,
          orphanComponents,
        );
        if (relatedOrphan) consumedOrphanPaths.add(relatedOrphan.path);
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: {
            ...failure,
            kind: "flow-failure" as const,
          },
        };
        if (relatedOrphan) args.relatedOrphan = relatedOrphan;
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        // feat-027 Phase D: dependent timeouts → tag with the FIRST cascade-
        // root bug id so the bug-fix loop can defer them until the root fix
        // lands. The fileBugPlan helper accepts `dependsOnBugId` as a
        // post-construction hook (we extend it below).
        if (
          failure.primaryCause === "timeout-no-evidence" &&
          cascadeRootBugIds.length > 0 &&
          cascadeRootBugIds[0] !== undefined
        ) {
          args.dependsOnBugId = cascadeRootBugIds[0];
        }
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for flow ${failure.flowId}: ${(err as Error).message}`,
        );
      }
    }

    // 2. stand-alone orphan-component plans (skip any consumed above)
    for (const orphan of orphanComponents) {
      if (consumedOrphanPaths.has(orphan.path)) continue;
      try {
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: { ...orphan, kind: "orphan-component" },
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for orphan ${orphan.path}: ${(err as Error).message}`,
        );
      }
    }
    for (const route of orphanRoutes) {
      try {
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: { ...route, kind: "orphan-route" },
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for orphan-route ${route.path}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── feat-028 Phase 4: visual-parity stage ─────────────────────────────────
  // Runs AFTER reachability + flow synthesis + flow execution. Default-on;
  // operator can disable per-call via `runParity:false`. The stage gracefully
  // degrades to a no-op (returns ok:true, screensChecked:0) when the project
  // lacks `docs/screens/{platform}/*.html` mockups OR Playwright isn't
  // installed — both cases surface as warnings, not failures.
  //
  // bug-148 — Tier 3 (parity) gate now ALSO respects `ctx.enabledTiers`,
  // mirroring Tier 4 (perceptual) + Tier 5 (walkthrough) at lines ~1035 + ~1091.
  // Pre-bug-148 parity ran on Round 1 even though feat-073's Round 1
  // `enabledTiers` is `{0,1,2}`. Now parity skips when Tier 3 isn't in the
  // set, consistent with the other LLM-driven tiers. Back-compat: undefined
  // `enabledTiers` (non-rounds callers) falls through to the original behavior.
  let parity: ParityVerifyOutput | undefined;
  const parityTierEnabled =
    ctx.enabledTiers === undefined || ctx.enabledTiers.has(3);
  if (!parityTierEnabled) {
    warnings.push(
      "parity-verify skipped: Tier 3 not in enabledTiers (round-state gate; feat-073 / bug-148)",
    );
  }
  if (ctx.runParity !== false && parityTierEnabled) {
    const parityVerify = ctx.parityVerify ?? runParityVerify;
    try {
      // bug-071 fix (2026-05-07) — when sharedDevServerHandle is set, pass
      // its baseUrl to parityVerify (skipping its own auto-boot). When
      // pre-boot failed (handle null), fall back to the legacy autoBoot
      // path so parity still gets a server to render against.
      const parityArgs: ParityVerifyContext = sharedDevServerHandle
        ? {
            projectDir,
            factoryRoot,
            devServerUrl: sharedDevServerHandle.baseUrl,
            autoBootDevServer: false,
          }
        : {
            projectDir,
            factoryRoot,
            autoBootDevServer: true,
          };
      parity = await parityVerify(parityArgs);
      for (const w of parity.warnings) warnings.push(`parity: ${w}`);
    } catch (err) {
      warnings.push(`parity-verify threw: ${(err as Error).message}`);
    }
  }

  // ── bug-071 + feat-069: defer dev-server teardown until ALL consumers
  // ── have run. The walkthrough script (Tier 5) is the third consumer
  // ── (after runFlows + parityVerify). Teardown moves to AFTER the
  // ── walkthrough block below. ────────────────────────────────────────

  // Auto-file ONE bug per (screen, pattern) parity divergence — the
  // divergences are already merged by `mergeByScreenPattern` inside
  // `runParityVerify`, so each entry here maps 1:1 to a bug plan. When the
  // operator opted out of bug-plan filing entirely (`autoFileBugPlans:false`)
  // we still surface the divergences in the output for human review.
  if (ctx.autoFileBugPlans !== false && parity) {
    const fileBugPlan = ctx.fileBugPlan ?? defaultFileBugPlanResolver();
    for (const div of parity.divergences) {
      try {
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: {
            ...divToViolation(div),
            kind: "parity-divergence" as const,
          } as unknown as BugPlanViolation,
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for parity ${div.screen}/${div.pattern}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── bug-095: restore seed-baseline before Tier 4 + Tier 5 fire ─────────
  // The flow-execution stage (Tier 3) runs Playwright specs whose beforeAll
  // hits /test/cleanup to set up flow-specific seed state. By the time
  // flow-execution returns, the DB is partially-wiped. If Tiers 4+5 capture
  // their screenshots / network logs / agent reviews against THAT state,
  // they observe "book detail returns 404", "no API calls initiated", etc.
  // — all artefacts of post-cleanup state, NOT real product bugs.
  //
  // Empirical motivator: reading-log-02 /fix-bugs 2026-05-13. ~half of the
  // rounds-orchestrator's in-loop verifier findings traced to this class.
  //
  // Fix: hit POST /test/seed-baseline (canonical Strategy-C primitive) to
  // restore the read-only baseline before the visual tiers capture. The
  // endpoint is idempotent + 204-on-success; if absent (no backend, or
  // backend doesn't expose /test/seed-baseline), the call 404s and we log
  // a soft warning. Either way the verifier continues.
  const visualTiersWillFire =
    (ctx.enabledTiers === undefined ||
      ctx.enabledTiers.has(4) ||
      ctx.enabledTiers.has(5)) &&
    (ctx.runPerceptual !== false || ctx.runWalkthrough !== false);
  if (visualTiersWillFire && flowsRan && sharedDevServerHandle?.backendUrl) {
    const backendBase = sharedDevServerHandle.backendUrl.replace(/\/$/, "");
    const healthUrl = `${backendBase}/health`;
    const baselineUrl = `${backendBase}/test/seed-baseline`;

    // bug-104 (2026-05-13): pre-flight health check distinguishes "API down"
    // (connection-refused) from "API up but /test/* routes not registered"
    // (404 from a Fastify process that didn't see ENABLE_TEST_SEED=1).
    // Distinguishing helps debugging when bug-095's restore returns 404 —
    // empirically observed in verifier b18vw2rdn (2026-05-13) where the
    // operator's pre-existing API was on :3001 but its env didn't match
    // the orchestrator's test-seed contract.
    let healthOk: boolean | null = null;
    try {
      const healthRes = await fetch(healthUrl, { method: "GET" });
      healthOk = healthRes.ok;
    } catch {
      healthOk = null; // connection refused → API not listening
    }

    try {
      const res = await fetch(baselineUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        warnings.push(
          `bug-095: restored seed-baseline at ${baselineUrl} (${res.status}) before Tier 4+5 capture`,
        );
      } else if (res.status === 404 && healthOk === true) {
        warnings.push(
          `bug-095: seed-baseline restore at ${baselineUrl} returned 404 but /health returned 200 — likely ENABLE_TEST_SEED env not propagated to spawned API (bug-104 class). Tier 4+5 will observe post-cleanup DB state.`,
        );
      } else if (res.status === 404 && healthOk === null) {
        warnings.push(
          `bug-095: seed-baseline restore at ${baselineUrl} returned 404 AND /health connection-refused — API is not listening at ${backendBase}. Possible orchestrator spawn failure. Tier 4+5 will observe post-cleanup DB state.`,
        );
      } else {
        warnings.push(
          `bug-095: seed-baseline restore at ${baselineUrl} returned ${res.status} (health=${healthOk}) — Tier 4+5 may observe post-cleanup DB state`,
        );
      }
    } catch (err) {
      warnings.push(
        `bug-095: seed-baseline restore at ${baselineUrl} threw: ${(err as Error).message} (health=${healthOk}) — Tier 4+5 may observe post-cleanup DB state`,
      );
    }
  }

  // ── feat-068: Tier 4 vision-LLM perceptual review ──────────────────────
  // Runs AFTER parity-verify (Tier 3). Per-screen LLM call comparing mockup
  // PNG vs live PNG. Cascade contracts: receives parity findings as context
  // ("don't re-report these"); skips screens where parity already filed
  // systemic / shell-stripping bugs; skips when Tier 2 hit
  // dev-server-not-responding.
  let perceptual: PerceptualReviewOutput | undefined;
  let perceptualCost = 0;
  // feat-073 — round-state gating. When enabledTiers is set and Tier 4 is
  // NOT in it, short-circuit the entire perceptual-review dispatch (don't
  // even enumerate screens). When enabledTiers is unset, back-compat:
  // runPerceptual flag controls.
  const tier4Gated = ctx.enabledTiers !== undefined && !ctx.enabledTiers.has(4);
  if (tier4Gated) {
    warnings.push(
      "perceptual-review skipped: Tier 4 not in enabledTiers (round-state gate; feat-073)",
    );
  }
  if (!tier4Gated && ctx.runPerceptual !== false && ctx.invokeAgent) {
    // Derive screen list from pixel-diffs directory (parity-verify persists
    // both PNGs there for every screen post-feat-068 parity-verify change).
    // If parity didn't run OR found 0 screens, this dir is empty + perceptual
    // is a no-op.
    const pixelDir = join(projectDir, "docs", "build-to-spec", "pixel-diffs");
    let screenIds: string[] = [];
    try {
      if (existsSync(pixelDir)) {
        screenIds = readdirSync(pixelDir)
          .filter((f) => f.endsWith(".mockup.png"))
          .map((f) => f.replace(/\.mockup\.png$/, ""));
      }
    } catch (err) {
      warnings.push(
        `perceptual: failed to enumerate pixel-diffs dir: ${(err as Error).message}`,
      );
    }

    if (screenIds.length > 0) {
      const perceptualRunner = ctx.perceptualReview ?? runPerceptualReview;
      try {
        perceptual = await perceptualRunner({
          projectDir,
          factoryRoot,
          screenIds,
          ...(parity ? { parity } : {}),
          flowFailures: flows.failed,
          invokeAgent: ctx.invokeAgent,
          ...(ctx.pipelineRunId !== undefined
            ? { pipelineRunId: ctx.pipelineRunId }
            : {}),
        });
        for (const w of perceptual.warnings) warnings.push(`perceptual: ${w}`);
        perceptualCost = perceptual.costUsd;
      } catch (err) {
        warnings.push(`perceptual-review threw: ${(err as Error).message}`);
      }
    }
  } else if (ctx.runPerceptual !== false && !ctx.invokeAgent) {
    warnings.push(
      "perceptual-review skipped: invokeAgent not provided (verifier called without orchestrator dispatch plumbing)",
    );
  }

  // feat-069 — Tier 5 AI walkthrough behavioral review. Runs AFTER perceptual
  // (Tier 4) so the walkthrough-reviewer can see + dedup against parity +
  // perceptual findings.
  let walkthrough: WalkthroughReviewOutput | undefined;
  let walkthroughCost = 0;
  const tier5Gated = ctx.enabledTiers !== undefined && !ctx.enabledTiers.has(5);
  if (tier5Gated) {
    warnings.push(
      "walkthrough-review skipped: Tier 5 not in enabledTiers (round-state gate; feat-073)",
    );
  }
  if (
    !tier5Gated &&
    ctx.runWalkthrough !== false &&
    ctx.invokeAgent &&
    sharedDevServerHandle
  ) {
    const walkthroughRunner = ctx.walkthroughReview ?? runWalkthroughReview;
    try {
      walkthrough = await walkthroughRunner({
        projectDir,
        factoryRoot,
        baseUrl: sharedDevServerHandle.baseUrl,
        ...(parity ? { parity } : {}),
        ...(perceptual ? { perceptual } : {}),
        invokeAgent: ctx.invokeAgent,
        ...(ctx.pipelineRunId !== undefined
          ? { pipelineRunId: ctx.pipelineRunId }
          : {}),
      });
      for (const w of walkthrough.warnings) warnings.push(`walkthrough: ${w}`);
      walkthroughCost = walkthrough.costUsd;
    } catch (err) {
      warnings.push(`walkthrough-review threw: ${(err as Error).message}`);
    }
  } else if (!tier5Gated && ctx.runWalkthrough !== false && !ctx.invokeAgent) {
    warnings.push(
      "walkthrough-review skipped: invokeAgent not provided (verifier called without orchestrator dispatch plumbing)",
    );
  } else if (
    !tier5Gated &&
    ctx.runWalkthrough !== false &&
    !sharedDevServerHandle
  ) {
    warnings.push(
      "walkthrough-review skipped: no dev-server pre-boot handle (sharedDevServerHandle not available)",
    );
  }

  // ── feat-069: dev-server teardown moved here, AFTER walkthrough (Tier 5).
  // ── All three consumers (runFlows + parityVerify + walkthrough) have now
  // ── consumed the shared handle; safe to tear down. ────────────────────
  if (sharedDevServerHandle) {
    try {
      teardownDevServer(sharedDevServerHandle);
    } catch (err) {
      warnings.push(
        `dev-server teardown threw (orphan processes possible): ${(err as Error).message}`,
      );
    }
    sharedDevServerHandle = null;
  }

  // bug-113 — file PERCEPTUAL bugs BEFORE walkthrough bugs so walkthrough
  // findings can carry `dependsOnBugId` linkage to any perceptual
  // `page-not-found` bug on the same iteration. Empirical motivator:
  // gotribe-tribe-directory 2026-05-15 — the browse page rendered a
  // Next.js 404 (1 perceptual finding) which caused 4 cascade walkthrough
  // findings ("checkbox not found", "Clear filters not found", etc.) that
  // are all symptoms of the same broken route. Without dependsOnBugId,
  // /fix-bugs dispatches web-frontend-builder 5× for what is structurally
  // ONE fix. Pre-bug-113 ordering filed walkthrough first; bug-113 swaps
  // so the perceptual planIds are available when walkthrough files.
  //
  // Auto-file ONE bug per perceptual finding. Like parity bugs, each maps
  // 1:1 to a bug plan + bugs.yaml entry via fileBugPlan.
  const cascadeRootBugIdByScreen = new Map<string, string>();
  let firstPageNotFoundBugId: string | null = null;
  if (ctx.autoFileBugPlans !== false && perceptual) {
    const fileBugPlan = ctx.fileBugPlan ?? defaultFileBugPlanResolver();
    const violations = perceptualReviewToViolations(perceptual);
    for (const v of violations) {
      try {
        // feat-068 followup — pass through the richer finding fields
        // (description / category) so file-bug-plan can render them in
        // the bug body + persist into bugs.yaml's perceptual context.
        const violationPayload: Record<string, unknown> = {
          kind: "perceptual-finding" as const,
          screen: v.screen,
          element: v.element,
          severity: v.severity,
        };
        if (v.mockupValue !== undefined)
          violationPayload.mockupValue = v.mockupValue;
        if (v.actualValue !== undefined)
          violationPayload.actualValue = v.actualValue;
        if (v.description !== undefined)
          violationPayload.description = v.description;
        if (v.category !== undefined) violationPayload.category = v.category;
        const args: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: violationPayload as unknown as BugPlanViolation,
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(args);
        bugPlansFiled.push(planId);
        // bug-113 — remember `page-not-found` perceptual bugs so subsequent
        // walkthrough findings can declare dependsOnBugId on them.
        if (v.category === "page-not-found") {
          cascadeRootBugIdByScreen.set(v.screen, planId);
          if (firstPageNotFoundBugId === null) firstPageNotFoundBugId = planId;
        }
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for perceptual ${v.screen}/${v.element}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Auto-file ONE bug per walkthrough finding. Each maps 1:1 to a
  // walkthrough-divergence bug plan + bugs.yaml entry via fileBugPlan.
  // bug-113 — when ANY perceptual page-not-found bug was filed above,
  // walkthrough findings carry dependsOnBugId pointing to it (coarse:
  // first such planId for the whole iteration). The /fix-bugs loop
  // respects dependsOnBugId by suppressing dependents until the root
  // resolves, then re-verifies — if cascade dependents disappeared
  // because the root fixed, they're skipped; if they persist, they
  // dispatch normally. Per-flow scope (matching walkthrough flow to
  // the perceptual screen) is deferred — coarse iteration-wide scope
  // is correct because page-routing being broken anywhere blocks
  // confident walkthrough verdict on every flow.
  if (ctx.autoFileBugPlans !== false && walkthrough) {
    const fileBugPlanWalk = ctx.fileBugPlan ?? defaultFileBugPlanResolver();
    const violations = walkthroughReviewToViolations(walkthrough);
    for (const v of violations) {
      try {
        const violationPayload: Record<string, unknown> = {
          kind: "walkthrough-finding" as const,
          step: v.step,
          element: v.element,
          observation: v.observation,
          severity: v.severity,
          evidence: v.evidence,
        };
        if (v.expected !== undefined) violationPayload.expected = v.expected;
        if (v.category !== undefined) violationPayload.category = v.category;
        const args: Parameters<typeof fileBugPlanWalk>[0] = {
          projectDir,
          violation: violationPayload as unknown as BugPlanViolation,
        };
        if (ctx.pipelineRunId !== undefined)
          args.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) args.iteration = ctx.iteration;
        // bug-113 — link to first perceptual page-not-found bug if any.
        if (firstPageNotFoundBugId !== null) {
          args.dependsOnBugId = firstPageNotFoundBugId;
        }
        const { planId } = await fileBugPlanWalk(args);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for walkthrough step ${v.step}/${v.element}: ${(err as Error).message}`,
        );
      }
    }
  }

  const parityOk = parity ? parity.divergences.length === 0 : true;
  const perceptualOk = perceptual ? perceptual.ok : true;
  const walkthroughOk = walkthrough ? walkthrough.ok : true;
  const ok =
    orphanComponents.length === 0 &&
    orphanRoutes.length === 0 &&
    flows.failed.length === 0 &&
    parityOk &&
    perceptualOk &&
    walkthroughOk;

  const output: BuildToSpecVerifyOutputType = {
    ok,
    reachability: {
      orphanComponents,
      orphanRoutes,
      scannedFiles,
      ignoredByAllowComment,
    },
    flows,
    ...(parity ? { parity } : {}),
    ...(perceptual ? { perceptual } : {}),
    ...(walkthrough ? { walkthrough } : {}),
    bugPlansFiled,
    // feat-068+069: perceptual + walkthrough are the LLM dispatches; sum both.
    costUsd: perceptualCost + walkthroughCost,
    durationMs: Date.now() - startedAt,
    warnings,
  };

  // Validate before returning — guard against drift between this code +
  // the contract.
  return BuildToSpecVerifyOutput.parse(output);
}

/**
 * feat-028 Phase 4 — fold a `ParityDivergence` into a serializable
 * violation that `scripts/file-bug-plan.mjs#parityDivergenceBody()`
 * understands. The result is NOT a `FlowFailure | OrphanComponent | OrphanRoute`
 * (we cast the kind to `parity-divergence` at the call site); the
 * type-checker accepts the cast because the bug-author dispatch table
 * keys on `kind` and our new branch is wired in below.
 */
function divToViolation(div: ParityDivergence) {
  return {
    screen: div.screen,
    pattern: div.pattern,
    severity: div.severity,
    detail: div.detail,
  };
}

/**
 * Resolves the default `fileBugPlan` function via dynamic import. Mirrors
 * the inline-resolver pattern further up but extracted for the parity
 * branch. Tests pass `ctx.fileBugPlan` directly + this resolver isn't
 * touched.
 */
function defaultFileBugPlanResolver() {
  return async (args: {
    projectDir: string;
    violation: BugPlanViolation;
    relatedOrphan?: OrphanComponent;
    pipelineRunId?: string;
    iteration?: number;
  }) => {
    const specifier = `../../scripts/file-bug-plan.mjs`;
    const mod = (await import(specifier)) as unknown as {
      fileBugPlan: (a: typeof args) => Promise<{
        planId: string;
        planPath: string;
        bugYamlId?: string;
      }>;
    };
    return mod.fileBugPlan(args);
  };
}

/**
 * feat-025 Phase 4 — correlate a flow failure to an orphan component.
 *
 * Heuristic: an orphan component is "related" to a flow failure when the
 * flow's `expectedScreenId` (the screen the click should have landed on)
 * appears in the orphan's path, OR the orphan's exportNames contain a
 * component name that resembles the screen id (kebab → PascalCase).
 *
 * Examples:
 *   - flow expects "card-modal" + orphan path .../CardDetailModal.tsx
 *     → MATCH (path contains "modal" + screen contains "modal")
 *   - flow expects "settings" + orphan exports ["SettingsPanel"]
 *     → MATCH (export name contains "settings", case-insensitive)
 *
 * Returns the FIRST matching orphan or undefined. We deliberately don't
 * file multiple plans for one flow when several orphans loosely match —
 * the bug plan template handles only one related orphan, and
 * builder-feedback-loop tuning is cheaper with one plan per flow.
 */
function correlateFlowFailureToOrphan(
  failure: FlowFailure,
  orphans: readonly OrphanComponent[],
): OrphanComponent | undefined {
  // bug-039 (2026-05-02): expectedScreenId is nullable for v2.0 synth
  // path. When null, we have no screen-id to correlate on — skip
  // correlation; the bug entry is filed without a correlated orphan,
  // which is correct (correlation is heuristic + nice-to-have, not
  // load-bearing for the fix-loop dispatch).
  if (failure.expectedScreenId === null) return undefined;
  const screenId = failure.expectedScreenId.toLowerCase();
  const screenSlug = screenId.replace(/-/g, "");
  for (const orphan of orphans) {
    const pathLower = orphan.path.toLowerCase();
    if (pathLower.includes(screenSlug) || pathLower.includes(screenId)) {
      return orphan;
    }
    for (const name of orphan.exportNames ?? []) {
      const nameLower = name.toLowerCase();
      if (nameLower.includes(screenSlug) || nameLower.includes(screenId)) {
        return orphan;
      }
      // Also match individual screen-id tokens against PascalCase parts
      const tokens = screenId.split("-").filter((t) => t.length >= 4);
      if (tokens.some((t) => nameLower.includes(t))) {
        return orphan;
      }
    }
  }
  return undefined;
}

/**
 * bug-078 / feat-066 v2 Phase 1B — short-circuit helper.
 *
 * When at least one P0 discriminator hits, the verifier emits ONE synthetic
 * FlowFailure per hit (cascade-root classification via
 * `primaryCause: "dev-server-compile"`) + skips the expensive reach + synth +
 * flows + parity passes. The root-cause bug masks all symptom-bugs those
 * stages would otherwise file. P1/P2 hits ride along on the same return so
 * the operator still sees the lower-severity warnings.
 */
async function emitDiscriminatorShortCircuit(args: {
  ctx: BuildToSpecVerifyContext;
  projectDir: string;
  hits: DiscriminatorResult[];
  warnings: string[];
  startedAt: number;
}): Promise<BuildToSpecVerifyOutputType> {
  const { ctx, projectDir, hits, warnings, startedAt } = args;

  const synthetic: FlowFailure[] = hits.map((h) =>
    discriminatorToFlowFailure(h),
  );

  const bugPlansFiled: string[] = [];
  if (ctx.autoFileBugPlans !== false) {
    const fileBugPlan = ctx.fileBugPlan ?? defaultFileBugPlanResolver();
    for (const failure of synthetic) {
      try {
        const callArgs: Parameters<typeof fileBugPlan>[0] = {
          projectDir,
          violation: { ...failure, kind: "dev-server-compile" as const },
        };
        if (ctx.pipelineRunId !== undefined)
          callArgs.pipelineRunId = ctx.pipelineRunId;
        if (ctx.iteration !== undefined) callArgs.iteration = ctx.iteration;
        const { planId } = await fileBugPlan(callArgs);
        bugPlansFiled.push(planId);
      } catch (err) {
        warnings.push(
          `file-bug-plan failed for pre-verify-discriminator ${failure.flowId}: ${(err as Error).message}`,
        );
      }
    }
  }

  const output: BuildToSpecVerifyOutputType = {
    ok: false,
    reachability: {
      orphanComponents: [],
      orphanRoutes: [],
      scannedFiles: 0,
      ignoredByAllowComment: [],
    },
    flows: { passed: [], failed: synthetic, generated: [] },
    bugPlansFiled,
    costUsd: 0,
    durationMs: Date.now() - startedAt,
    warnings,
  };
  return BuildToSpecVerifyOutput.parse(output);
}

/**
 * Map a DiscriminatorResult to a FlowFailure shape so the existing
 * cascade-root file-bug pipeline ingests it without schema churn. The
 * `primaryCause: "dev-server-compile"` tag routes it into the priority-
 * resolved queue (cascade-root bugs file first + dependent bugs defer).
 */
function discriminatorToFlowFailure(h: DiscriminatorResult): FlowFailure {
  return {
    flowId: `pre-verify-${h.pattern}`,
    flowName: h.label,
    step: 0,
    fromScreenId: null,
    expectedScreenId: null,
    actualScreenId: null,
    selector: null,
    screenshotPath: null,
    htmlDumpPath: null,
    message:
      `${h.label}\n\n${h.detail}\n\nSuggested fix: ${h.fix}\n\n` +
      `Affected files: ${h.affectedFiles.join(", ")}`,
    primaryCause: "dev-server-compile",
  };
}
