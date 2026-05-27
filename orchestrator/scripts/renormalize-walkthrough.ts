// Operator driver — re-parse an existing review.json from a prior walkthrough
// run through runWalkthroughReview's normalizer + dup-detector pipeline,
// stubbing the LLM dispatch + walkthrough capture script. Lets you iterate on
// the normalizer's schema-tolerance without re-paying the $0.40-$1.00/run
// LLM cost.
//
// Usage: pnpm --filter orchestrator exec tsx scripts/renormalize-walkthrough.ts
//
// Note: projectDir is hardcoded — clone + edit when running against other
// projects. Or generalize via argv if it becomes routine.

import { runWalkthroughReview } from "../src/walkthrough-review.js";
import type { InvokeAgentFn, InvokeAgentResult } from "../src/feature-graph.js";

const projectDir =
  "C:/Development/ps/claude/claude_/agentflow_phase2/projects/reading-log-02";

const stubScript = async () => ({
  ok: true,
  stepsRun: 5,
  screenshotsCount: 5,
  errors: [],
  warnings: [],
  durationMs: 100,
  outDir: projectDir + "/docs/build-to-spec/walkthrough",
  manifestPath: projectDir + "/docs/build-to-spec/walkthrough/manifest.json",
});

const stubAgent: InvokeAgentFn = (async (args): Promise<InvokeAgentResult> => {
  const taskId = args.tasks[0]?.id ?? "";
  return {
    taskStatus: { [taskId]: "completed" },
    errors: {},
    costUsd: 0,
  } as InvokeAgentResult;
}) as unknown as InvokeAgentFn;

const out = await runWalkthroughReview({
  projectDir,
  factoryRoot: process.cwd(),
  baseUrl: "http://localhost:3000",
  invokeAgent: stubAgent,
  runWalkthroughScript: stubScript,
});

console.log("findings:", out.findings.length);
for (const f of out.findings) {
  console.log(
    "  step",
    f.step,
    "[" + f.severity + "]",
    "(" + (f.category ?? "-") + ")",
    f.element,
  );
  console.log("    obs:", f.observation.slice(0, 120));
  console.log("    evidence:", f.evidence.length, "item(s)");
  if (f.evidence.length > 0)
    console.log("    evidence[0]:", f.evidence[0]!.slice(0, 100));
}
console.log("errors:", JSON.stringify(out.errors));
console.log("alreadyFiled:", out.alreadyFiled.length);
console.log("summary:", out.summary ?? "(none)");
