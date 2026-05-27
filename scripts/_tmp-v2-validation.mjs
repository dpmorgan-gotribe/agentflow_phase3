#!/usr/bin/env node
// scripts/_tmp-v2-validation.mjs — feat-066 v2 Phase 1 + 5 validation harness.
//
// Standalone invoker for /build-to-spec-verify with autoFileBugPlans:true so
// new bugs land in docs/bugs.yaml + plans/active/. Use this after a fresh
// reading-log-02 verifier pass to count what bug-078's classifier defaults +
// discriminators catch.
//
// Usage:
//   node scripts/_tmp-v2-validation.mjs <projectDir>

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirArg = process.argv[2];
if (!projectDirArg) {
  console.error("Usage: node scripts/_tmp-v2-validation.mjs <projectDir>");
  process.exit(2);
}

const __filename = fileURLToPath(import.meta.url);
const factoryRoot = path.resolve(path.dirname(__filename), "..");
const projectDir = path.resolve(factoryRoot, "projects", projectDirArg);

console.log(`[v2-validation] factoryRoot: ${factoryRoot}`);
console.log(`[v2-validation] projectDir:  ${projectDir}`);
console.log(`[v2-validation] starting...`);

const startedAt = Date.now();

const tsModuleUrl = pathToFileURL(
  path.join(factoryRoot, "orchestrator/src/build-to-spec-verify.ts"),
).href;
const { runBuildToSpecVerify } = await import(tsModuleUrl);

try {
  const out = await runBuildToSpecVerify({
    projectDir,
    factoryRoot,
    autoFileBugPlans: true,
    pipelineRunId: "v2-validation-2026-05-11",
    iteration: 1,
  });
  console.log(`[v2-validation] DONE in ${Date.now() - startedAt}ms`);
  console.log(`[v2-validation] === SUMMARY ===`);
  console.log(`  ok: ${out.ok}`);
  console.log(
    `  orphanComponents: ${out.reachability?.orphanComponents?.length ?? 0}`,
  );
  console.log(`  orphanRoutes: ${out.reachability?.orphanRoutes?.length ?? 0}`);
  console.log(`  flowsPassed: ${out.flows?.passed?.length ?? 0}`);
  console.log(`  flowsFailed: ${out.flows?.failed?.length ?? 0}`);
  if (out.parity) {
    console.log(`  parityDivergences: ${out.parity.divergences?.length ?? 0}`);
  }
  console.log(`  bugPlansFiled: ${out.bugPlansFiled?.length ?? 0}`);
  console.log(`  warnings: ${out.warnings?.length ?? 0}`);
  if (out.flows?.failed?.length > 0) {
    console.log(`[v2-validation] === FLOW FAILURES (per-class breakdown) ===`);
    const byCause = new Map();
    for (const f of out.flows.failed) {
      const cause = f.primaryCause ?? "unknown";
      byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
    }
    for (const [cause, count] of byCause.entries()) {
      console.log(`  ${cause}: ${count}`);
    }
  }
  if (out.parity?.divergences?.length > 0) {
    console.log(`[v2-validation] === PARITY DIVERGENCES (per-pattern) ===`);
    const byPattern = new Map();
    for (const d of out.parity.divergences) {
      byPattern.set(d.pattern, (byPattern.get(d.pattern) ?? 0) + 1);
    }
    for (const [pattern, count] of byPattern.entries()) {
      console.log(`  ${pattern}: ${count}`);
    }
  }
  console.log(`[v2-validation] === FULL JSON ===`);
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(`[v2-validation] FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
