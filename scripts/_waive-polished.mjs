#!/usr/bin/env node
// scripts/_waive-polished.mjs
//
// Helper for ADR-004 (Phase 0 Gate Report Section 6 blocker #4).
// Sets `polished: "waived"` + `polished_waiver_reason: "..."` on a row
// in feature_list.json. Used when /polish-pass is intentionally skipped
// because the row's implementation is at-floor performance (sub-second,
// pure-function, no I/O).
//
// Usage:
//   node scripts/_waive-polished.mjs <row-id> "<one-line reason>"
//
// Exit non-zero if row not found.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname || ".", "..");
const FL = path.join(ROOT, "feature_list.json");

const [, , id, reason] = process.argv;
if (!id || !reason) {
  console.error('usage: _waive-polished.mjs <row-id> "<one-line reason>"');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(FL, "utf8"));
const row = data.rows.find((r) => r.id === id);
if (!row) {
  console.error(`row not found: ${id}`);
  process.exit(2);
}

row.polished = "waived";
row.polished_waiver_reason = reason;

fs.writeFileSync(FL, JSON.stringify(data, null, 2) + "\n");
console.log(`waived polish-pass on ${id}: ${reason}`);
