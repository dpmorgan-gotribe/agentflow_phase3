#!/usr/bin/env node
// scripts/_flip-passes.mjs
//
// Internal helper: flip passes:true + closed_at on a list of row IDs in
// feature_list.json. Used during execution to batch-mark completed rows.
//
// Usage: node scripts/_flip-passes.mjs <row-id> [<row-id> ...]
//
// Will exit non-zero if any cited row's evidence file does not exist.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname || ".", "..");
const FL = path.join(ROOT, "feature_list.json");
const TODAY = new Date().toISOString().slice(0, 10);

const targetIds = process.argv.slice(2);
if (targetIds.length === 0) {
  console.error("usage: _flip-passes.mjs <row-id> [<row-id> ...]");
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(FL, "utf8"));
const byId = new Map(data.rows.map((r, i) => [r.id, { row: r, idx: i }]));

const missing = [];
const noEvidence = [];
const flipped = [];

for (const id of targetIds) {
  const found = byId.get(id);
  if (!found) {
    missing.push(id);
    continue;
  }
  const evPath = path.join(ROOT, found.row.evidence || "");
  if (!found.row.evidence || !fs.existsSync(evPath)) {
    noEvidence.push({ id, evPath });
    continue;
  }
  if (found.row.passes === true) {
    continue; // already flipped
  }
  found.row.passes = true;
  found.row.closed_at = TODAY;
  found.row.attempt_count = (found.row.attempt_count || 0) + 1;
  flipped.push(id);
}

if (missing.length) {
  console.error("UNKNOWN ROW IDS:", missing.join(", "));
  process.exit(2);
}
if (noEvidence.length) {
  console.error("MISSING EVIDENCE for:");
  for (const m of noEvidence) console.error(`  ${m.id}: ${m.evPath}`);
  process.exit(2);
}

fs.writeFileSync(FL, JSON.stringify(data, null, 2) + "\n");

console.log(`flipped ${flipped.length} row(s) to passes:true (closed_at=${TODAY}):`);
for (const id of flipped) console.log(`  ${id}`);
