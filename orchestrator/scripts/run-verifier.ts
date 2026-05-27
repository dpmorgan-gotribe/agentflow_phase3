// Operator driver to invoke runBuildToSpecVerify against a project end-to-end
// and write the output to docs/_tmp-verify-output.json for inspection. The
// canonical production path is `feature-graph.ts` (Mode B) or
// `fix-bugs-loop.ts` (the loop); this script is the standalone probe for
// running the 6 tiers (build-sanity / reachability / synth-flows / parity /
// perceptual / walkthrough) against a single project on demand.
//
// Usage:
//   pnpm --filter orchestrator exec tsx scripts/run-verifier.ts <projectDir>
//   pnpm --filter orchestrator exec tsx scripts/run-verifier.ts <projectDir> --enabled-tiers=0,1,2
//   pnpm --filter orchestrator exec tsx scripts/run-verifier.ts <projectDir> --round=1
//
// --enabled-tiers=<list>: restrict the run to a subset of tiers (e.g. `0,1,2`
//   for Round 1 STRUCTURAL only — cheap initial probe before paying for
//   parity/perceptual/walkthrough). Default: all 6 tiers fire.
// --round=N: shorthand for the canonical feat-073 round → tier map:
//   round 1 → 0,1,2 ; round 2 → 0,1,2,3 ; round 3 → 0,1,2,3,4 ;
//   round 4 → 0,1,2,3,4,5 ; round 5 → 0,1,2,3,4,5.
//
// Wires invokeAgent + BudgetTracker so Tier 4 (perceptual) + Tier 5
// (walkthrough) actually fire — without this plumbing they silently skip
// with "invokeAgent not provided" warnings.
//
// Empirically validated 2026-05-13 against reading-log-02: $1.50 + 15.6 min
// wall-clock for a 5-screen project (4 perceptual + 1 walkthrough dispatch).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync } from "node:fs";
import { runBuildToSpecVerify } from "../src/build-to-spec-verify.js";
import { BudgetTracker } from "../src/budget-tracker.js";
import { createInvokeAgent } from "../src/invoke-agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = new Map(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1
        ? [a.slice(2), "true"]
        : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const projectDir = resolve(positional[0] ?? process.cwd());
if (!existsSync(projectDir)) {
  console.error(`projectDir not found: ${projectDir}`);
  process.exit(2);
}

// --enabled-tiers=0,1,2 OR --round=N: restrict which tiers fire.
// feat-073 round → tier map. Round 5 enables all 6 tiers (final-gate);
// rounds 4 + 5 are identical in tier coverage.
const ROUND_TO_TIERS: Record<string, number[]> = {
  "1": [0, 1, 2],
  "2": [0, 1, 2, 3],
  "3": [0, 1, 2, 3, 4],
  "4": [0, 1, 2, 3, 4, 5],
  "5": [0, 1, 2, 3, 4, 5],
};

let enabledTiers: Set<number> | undefined;
const tiersFlag = flags.get("enabled-tiers");
const roundFlag = flags.get("round");
if (tiersFlag) {
  enabledTiers = new Set(
    tiersFlag
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
} else if (roundFlag) {
  const tiers = ROUND_TO_TIERS[roundFlag];
  if (!tiers) {
    console.error(`unknown --round value: ${roundFlag} (expected 1-5)`);
    process.exit(2);
  }
  enabledTiers = new Set(tiers);
}

const factoryRoot = resolve(__dirname, "../..");

async function main() {
  console.log(`Running verifier against ${projectDir}`);
  console.log(`Factory root: ${factoryRoot}`);
  const startedAt = Date.now();
  const pipelineRunId = `tmp-verify-${Date.now()}`;
  // Wire invokeAgent so Tier 4 (perceptual) + Tier 5 (walkthrough) can
  // dispatch their LLM agents. Without this the orchestrator skips both
  // with the "invokeAgent not provided" warning.
  const budget = new BudgetTracker({
    perPipelineMaxUsd: 10,
    perStageMaxUsd: {},
  });
  const invokeAgent = createInvokeAgent({
    projectRoot: projectDir,
    budget,
    flags: [],
    pipelineRunId,
  });
  if (enabledTiers) {
    console.log(
      `enabledTiers: ${[...enabledTiers].sort().join(",")} (subset run — pass no flags to fire all 6 tiers)`,
    );
  }
  const result = await runBuildToSpecVerify({
    projectDir,
    factoryRoot,
    autoFileBugPlans: true,
    pipelineRunId,
    iteration: 1,
    invokeAgent,
    ...(enabledTiers ? { enabledTiers } : {}),
  });
  const elapsedMs = Date.now() - startedAt;

  const outPath = resolve(projectDir, "docs/_tmp-verify-output.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

  console.log(`\n=== verifier done in ${(elapsedMs / 1000).toFixed(1)}s ===`);
  console.log(`ok: ${result.ok}`);
  console.log(`warnings: ${result.warnings?.length ?? 0}`);
  console.log(
    `reachability orphans: ${result.reachability?.orphanComponents?.length ?? 0}`,
  );
  console.log(`flows passed: ${result.flows?.passed?.length ?? 0}`);
  console.log(`flows failed: ${result.flows?.failed?.length ?? 0}`);
  console.log(`bug plans filed: ${result.bugPlansFiled?.length ?? 0}`);
  console.log(`output written to: ${outPath}`);

  if (result.flows?.failed) {
    console.log(`\n=== flow failures by primaryCause ===`);
    const byCause = new Map<string, string[]>();
    for (const f of result.flows.failed) {
      const cause = f.primaryCause ?? "unknown";
      if (!byCause.has(cause)) byCause.set(cause, []);
      byCause.get(cause)!.push(f.flowId);
    }
    for (const [cause, ids] of byCause.entries()) {
      console.log(`  ${cause}: ${ids.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error("verifier crashed:", err);
  process.exit(1);
});
