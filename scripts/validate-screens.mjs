#!/usr/bin/env node
// scripts/validate-screens.mjs
//
// Validates a per-platform screens.json against schemas/screens.schema.json
// (v3.0 format). Called by the analyst's phase-4 sub-worker before returning,
// and by task 035's orchestrator as a post-phase gate.
//
// Usage:
//   node scripts/validate-screens.mjs <path-to-screens.json>
//
// Exit codes: 0 = valid, 1 = invalid (schema violations), 2 = invocation error.
// Error lines: <path>:<json-pointer>: <ajv message>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SIBLING = path.resolve(__dirname, "..");
const CWD = process.cwd();

// Resolve schema: prefer CWD (project-local copy), fall back to script sibling
// (factory). Mirrors validate-brief.mjs pattern.
const SCHEMA_IN_CWD = path.join(CWD, "schemas", "screens.schema.json");
const SCHEMA_IN_SIBLING = path.join(
  SCRIPT_SIBLING,
  "schemas",
  "screens.schema.json",
);
const SCHEMA_PATH =
  fs.existsSync(SCHEMA_IN_CWD) || !fs.existsSync(SCHEMA_IN_SIBLING)
    ? SCHEMA_IN_CWD
    : SCHEMA_IN_SIBLING;

function die(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

async function loadDep(name) {
  try {
    return await import(name);
  } catch (err) {
    die(
      2,
      `Missing dependency: ${name}. Run \`pnpm install\` in project root or factory root.\n` +
        `Underlying error: ${err.message}`,
    );
  }
}

const [, , target] = process.argv;
if (!target) {
  die(
    2,
    "Usage: validate-screens.mjs <path-to-screens.json>\n" +
      "Validates a v3.0 screens.json against schemas/screens.schema.json.",
  );
}

if (!fs.existsSync(target)) {
  die(2, `Target file not found: ${target}`);
}

if (!fs.existsSync(SCHEMA_PATH)) {
  die(2, `Schema not found at ${SCHEMA_PATH}`);
}

const AjvModule = await loadDep("ajv/dist/2020.js");
const Ajv = AjvModule.default || AjvModule.Ajv2020 || AjvModule;
const addFormats = (await loadDep("ajv-formats")).default;

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
let data;
try {
  data = JSON.parse(fs.readFileSync(target, "utf8"));
} catch (err) {
  die(2, `${target}: invalid JSON — ${err.message}`);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

if (validate(data)) {
  // Extra sanity: cross-check screen IDs are unique
  const ids = (data.app?.screens || []).map((s) => s.id);
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length > 0) {
    for (const id of duplicates) {
      process.stderr.write(`${target}: duplicate screen id '${id}'\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `\u2713 ${target} — v3.0 screens.json valid (${ids.length} screens)\n`,
  );
  process.exit(0);
}

for (const err of validate.errors || []) {
  const pointer = err.instancePath || "/";
  const paramStr =
    err.params && Object.keys(err.params).length > 0
      ? ` (${JSON.stringify(err.params)})`
      : "";
  process.stderr.write(`${target}:${pointer}: ${err.message}${paramStr}\n`);
}
process.exit(1);
