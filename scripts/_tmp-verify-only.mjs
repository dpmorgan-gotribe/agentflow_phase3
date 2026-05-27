#!/usr/bin/env node
// scripts/_tmp-verify-only.mjs — bug-071 validation harness.
//
// Standalone invoker for /build-to-spec-verify: runs reachability +
// synthesis + flow-execution + parity-audit pipeline against a project,
// without dispatching any LLM agents. Produces JSON output identical to
// what the orchestrator's runFeatureGraph would consume.
//
// Usage:
//   node scripts/_tmp-verify-only.mjs <projectDir>

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirArg = process.argv[2];
if (!projectDirArg) {
  console.error("Usage: node scripts/_tmp-verify-only.mjs <projectDir>");
  process.exit(2);
}

const __filename = fileURLToPath(import.meta.url);
const factoryRoot = path.resolve(path.dirname(__filename), "..");
const projectDir = path.resolve(factoryRoot, "projects", projectDirArg);

console.log(`[verify-only] factoryRoot: ${factoryRoot}`);
console.log(`[verify-only] projectDir:  ${projectDir}`);
console.log(`[verify-only] starting...`);

const startedAt = Date.now();

// Import the TS module via tsx — the orchestrator's package has tsx as a
// dep; this script is invoked through `pnpm --filter orchestrator exec
// node` so the resolution works.
const tsModuleUrl = pathToFileURL(
  path.join(factoryRoot, "orchestrator/src/build-to-spec-verify.ts"),
).href;
const { runBuildToSpecVerify } = await import(tsModuleUrl);

try {
  const out = await runBuildToSpecVerify({
    projectDir,
    factoryRoot,
    // Don't auto-file bug plans during this validation; we just want to
    // see what failures the verifier would report.
    autoFileBugPlans: false,
    pipelineRunId: "verify-only-validation",
    iteration: 1,
  });
  console.log(`[verify-only] DONE in ${Date.now() - startedAt}ms`);
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(`[verify-only] FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
