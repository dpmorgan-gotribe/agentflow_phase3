// Operator driver to invoke runWalkthroughReview against a project end-to-end
// with a live invokeAgent + walkthrough script. The canonical production path
// is runBuildToSpecVerify → Tier 5 dispatch; this script is the manual probe
// for empirical validation against a single project without running the full
// verifier (Tiers 0-4 are skipped).
//
// Usage: pnpm --filter orchestrator exec tsx scripts/run-walkthrough.ts <projectDir> [baseUrl]
//
// Empirically validated 2026-05-13 against reading-log-02: $0.35-$1.01 per
// run, ~4-15 min wall-clock depending on screen count + agent verbosity.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { BudgetTracker } from "../src/budget-tracker.js";
import { createInvokeAgent } from "../src/invoke-agent.js";
import { runWalkthroughReview } from "../src/walkthrough-review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(__dirname, "../..");

const projectDir = resolve(process.argv[2] ?? process.cwd());
const baseUrl = process.argv[3] ?? "http://localhost:3000";

if (!existsSync(projectDir)) {
  console.error(`projectDir not found: ${projectDir}`);
  process.exit(2);
}

async function main(): Promise<void> {
  console.log(`Running walkthrough review against ${projectDir}`);
  console.log(`Factory root: ${factoryRoot}`);
  console.log(`Base URL: ${baseUrl}`);

  const budget = new BudgetTracker({
    perPipelineMaxUsd: 5,
    perStageMaxUsd: {},
  });
  const invokeAgent = createInvokeAgent({
    projectRoot: projectDir,
    budget,
    flags: [],
    pipelineRunId: `tmp-walkthrough-${Date.now()}`,
  });

  const startedAt = Date.now();
  const result = await runWalkthroughReview({
    projectDir,
    factoryRoot,
    baseUrl,
    invokeAgent,
    pipelineRunId: `tmp-walkthrough-${Date.now()}`,
  });
  const elapsedMs = Date.now() - startedAt;

  console.log("");
  console.log(`=== walkthrough done in ${(elapsedMs / 1000).toFixed(1)}s ===`);
  console.log(`ok: ${result.ok}`);
  console.log(`stepsRun: ${result.stepsRun}`);
  console.log(`findings: ${result.findings.length}`);
  console.log(`warnings: ${result.warnings?.length ?? 0}`);
  console.log(`cost: $${result.costUsd.toFixed(4)}`);
  if (result.skippedReason) {
    console.log(`skippedReason: ${result.skippedReason}`);
  }
  if (result.summary) {
    console.log(`summary: ${result.summary}`);
  }
  if (result.findings.length > 0) {
    console.log("");
    console.log("=== findings ===");
    for (const f of result.findings) {
      console.log(
        `  step ${f.step} [${f.severity}] (${f.category ?? "—"}): ${f.element}`,
      );
      console.log(`    observation: ${f.observation}`);
      if (f.expected) console.log(`    expected: ${f.expected}`);
      console.log(`    evidence: ${f.evidence.join(", ")}`);
    }
  }
  if (Object.keys(result.errors ?? {}).length > 0) {
    console.log("");
    console.log("=== errors ===");
    for (const [k, v] of Object.entries(result.errors)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  if ((result.warnings?.length ?? 0) > 0) {
    console.log("");
    console.log("=== warnings ===");
    for (const w of result.warnings ?? []) {
      console.log(`  - ${w}`);
    }
  }
}

main().catch((err) => {
  console.error("walkthrough runner crashed:", err);
  process.exit(1);
});
