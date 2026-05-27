#!/usr/bin/env node
/**
 * Validate an architecture.yaml against schemas/architecture.schema.json.
 *
 * Usage:
 *   node scripts/validate-architecture.mjs <path/to/architecture.yaml>
 *
 * Exit code: 0 on success, 1 on validation error.
 *
 * Called from:
 *   - .claude/skills/architect/SKILL.md self-verify step
 *   - feat-009 reviewer agent's architecture-sanity check
 *   - CI workflow step (future)
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(scriptDir, "..");
const schemaPath = join(factoryRoot, "schemas", "architecture.schema.json");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/validate-architecture.mjs <path>");
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const raw = readFileSync(resolve(input), "utf8");
const parsed = yaml.load(raw);

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

console.log(`OK — ${input} validates against schemas/architecture.schema.json`);
