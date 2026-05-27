#!/usr/bin/env node
/**
 * Validate a .feature-context.json lockfile against
 * schemas/feature-context.schema.json. Used by git-agent's self-verify
 * after every lockfile write.
 *
 * Usage:
 *   node scripts/validate-feature-context.mjs <path/to/.feature-context.json>
 *
 * Exit code: 0 on success, 1 on validation error.
 *
 * Called from:
 *   - .claude/skills/git-agent/SKILL.md — checkout-feature, close-feature,
 *     resolve-conflict-handoff self-verify
 *   - orchestrator/feature-graph.ts (indirectly via GitAgentOutput parsing
 *     + FeatureContextSchema Zod mirror)
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(scriptDir, "..");
const schemaPath = join(factoryRoot, "schemas", "feature-context.schema.json");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/validate-feature-context.mjs <path>");
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const raw = readFileSync(resolve(input), "utf8");
const parsed = JSON.parse(raw);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const ok = validate(parsed);

if (!ok) {
  console.error(`Validation FAILED for ${input}:`);
  for (const err of validate.errors ?? []) {
    console.error(`  - ${err.instancePath || "<root>"}: ${err.message}`);
  }
  process.exit(1);
}

console.log(
  `OK — ${input} validates against schemas/feature-context.schema.json`,
);
