import { readFileSync } from "node:fs";
import { UserFlowsManifestSchema } from "../packages/orchestrator-contracts/src/user-flows-manifest.ts";
const m = JSON.parse(
  readFileSync(
    "./projects/finance-track-pre-build/docs/user-flows-manifest.json",
    "utf8",
  ),
);
const r = UserFlowsManifestSchema.safeParse(m);
if (r.success) {
  const interactionsCount = m.flows.filter(
    (f) => (f.interactions || []).length,
  ).length;
  const seedingCounts = m.flows.reduce((acc, f) => {
    const t = f.seedingTier || "none";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});
  console.log("OK: schemaVersion=" + m.schemaVersion);
  console.log(
    "flows with interactions:",
    interactionsCount,
    "/",
    m.flows.length,
  );
  console.log("seedingTier counts:", JSON.stringify(seedingCounts));
} else {
  console.error("FAIL");
  console.error(JSON.stringify(r.error.issues, null, 2));
  process.exit(1);
}
