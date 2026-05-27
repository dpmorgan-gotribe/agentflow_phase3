#!/usr/bin/env node
// scripts/validate-brief.mjs
//
// Runtime validator for brief.md. The /validate-brief skill (task 017) and
// the CI workflow (.github/workflows/validate-brief.yml) both call this.
//
// Flags (see scaffolding task 015 for the full contract):
//   --frontmatter   YAML frontmatter vs schemas/brief-frontmatter.schema.json
//   --codeblocks    §7 + §10 each contain a fenced code block
//   --companions    Every companion-files[].path exists; if type:navigation
//                   also validate against schemas/navigation.schema.json
//   --structure     Delegate to markdownlint-cli2 with .markdownlint.jsonc.
//                   No-op + warning if that config hasn't shipped (task 016).
//   --all           Run all four in order. Stops on first failure unless
//                   --keep-going is passed.
//
// Exit codes:
//   0  all checks passed
//   1  at least one check reported a validation error
//   2  invocation error (missing file, bad args, missing deps)
//
// Error-line format (every failure prints one line per error):
//   brief.md:<line>: <json-pointer>: <message>
// The skill + CI rely on this format — don't change without updating task 017.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve paths relative to CWD so the script works both ways:
//   - From factory root: node scripts/validate-brief.mjs --all
//   - From inside a project: node ../../scripts/validate-brief.mjs --all
// The script is a pure tool — it validates whatever brief lives in the
// directory it's invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SIBLING = path.resolve(__dirname, "..");
const PROJECT_ROOT = process.cwd();

// If CWD has no brief.md but the script's sibling directory does, fall
// back to that. Keeps `npm run validate-brief` working from any CWD within
// the factory repo, while still letting projects supply their own brief.
const BRIEF_IN_CWD = path.join(PROJECT_ROOT, "brief.md");
const BRIEF_IN_SIBLING = path.join(SCRIPT_SIBLING, "brief.md");
const RESOLVED_ROOT =
  fs.existsSync(BRIEF_IN_CWD) || !fs.existsSync(BRIEF_IN_SIBLING)
    ? PROJECT_ROOT
    : SCRIPT_SIBLING;

const BRIEF_PATH = path.join(RESOLVED_ROOT, "brief.md");
const SCHEMA_PATH = path.join(
  RESOLVED_ROOT,
  "schemas",
  "brief-frontmatter.schema.json",
);
const NAV_SCHEMA_PATH = path.join(
  RESOLVED_ROOT,
  "schemas",
  "navigation.schema.json",
);
const MARKDOWNLINT_CONFIG = path.join(RESOLVED_ROOT, ".markdownlint.jsonc");

// Sections that MUST contain a fenced code block per blueprint §3.
const CODEBLOCK_REQUIRED_SECTIONS = [
  { num: 7, title: "Architecture Overview" },
  { num: 10, title: "Navigation Schema" },
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function die(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function readBriefOrExit() {
  if (!fs.existsSync(BRIEF_PATH)) {
    die(2, `brief.md not found at ${BRIEF_PATH}`);
  }
  return fs.readFileSync(BRIEF_PATH, "utf8");
}

async function loadDep(name) {
  try {
    return await import(name);
  } catch (err) {
    die(
      2,
      `Missing dependency: ${name}. Run \`pnpm install\` (or \`npm install\`) in ${PROJECT_ROOT}.\n` +
        `Underlying error: ${err.message}`,
    );
  }
}

// Given a brief.md body and a YAML key, return its 1-indexed line number.
function lineOfKey(briefText, key) {
  const lines = briefText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^${key}\\s*:`))) return i + 1;
  }
  return null;
}

// Collect all H2 sections (## <num>. <title>) and their line ranges.
function collectSections(briefText) {
  const lines = briefText.split("\n");
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(\d+)\.\s+(.+?)\s*$/);
    if (m) sections.push({ num: Number(m[1]), title: m[2], start: i });
  }
  // Compute end lines (exclusive): next section's start, or EOF.
  for (let i = 0; i < sections.length; i++) {
    sections[i].end = sections[i + 1] ? sections[i + 1].start : lines.length;
  }
  return sections;
}

function sectionHasCodeblock(briefText, section) {
  const lines = briefText.split("\n");
  const slice = lines.slice(section.start, section.end);
  return slice.some((l) => /^\s*```/.test(l));
}

const BRIEF_CAPABILITIES_PATH = path.join(
  PROJECT_ROOT,
  "docs",
  "brief-capabilities.json",
);
const BRIEF_CAPABILITIES_SCHEMA_PATH = path.join(
  RESOLVED_ROOT,
  "schemas",
  "brief-capabilities.schema.json",
);

// --------------------------------------------------------------------------
// Checks
// --------------------------------------------------------------------------

async function checkFrontmatter() {
  const briefText = readBriefOrExit();
  if (!fs.existsSync(SCHEMA_PATH)) {
    die(2, `Schema not found at ${SCHEMA_PATH}`);
  }

  const matter = (await loadDep("gray-matter")).default;
  const AjvModule = await loadDep("ajv/dist/2020.js");
  const Ajv = AjvModule.default || AjvModule.Ajv2020 || AjvModule;
  const addFormats = (await loadDep("ajv-formats")).default;

  const parsed = matter(briefText);
  // gray-matter parses YAML dates (`created: 2026-04-18`) as JS Date objects.
  // The JSON Schema declares these fields as `type: string, format: date`.
  // Normalize Date → ISO date string so Ajv sees the expected type.
  for (const key of Object.keys(parsed.data)) {
    if (parsed.data[key] instanceof Date) {
      parsed.data[key] = parsed.data[key].toISOString().slice(0, 10);
    }
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (validate(parsed.data)) {
    process.stdout.write("\u2713 Frontmatter valid\n");
    return true;
  }

  for (const err of validate.errors || []) {
    const pointer = err.instancePath || "/";
    const field = pointer.split("/").pop() || Object.keys(err.params)[0];
    const line = lineOfKey(briefText, field) ?? "?";
    process.stderr.write(`brief.md:${line}: ${pointer}: ${err.message}\n`);
  }
  return false;
}

function checkCodeblocks() {
  const briefText = readBriefOrExit();
  const sections = collectSections(briefText);
  const missing = [];

  for (const { num, title } of CODEBLOCK_REQUIRED_SECTIONS) {
    const section = sections.find((s) => s.num === num);
    if (!section) {
      missing.push({ num, title, reason: "section heading not found" });
    } else if (!sectionHasCodeblock(briefText, section)) {
      missing.push({ num, title, reason: "no fenced code block" });
    }
  }

  if (missing.length === 0) {
    process.stdout.write(
      `\u2713 Code blocks present in ${CODEBLOCK_REQUIRED_SECTIONS.map(
        (s) => `\u00A7${s.num}`,
      ).join(", ")}\n`,
    );
    return true;
  }

  for (const m of missing) {
    process.stderr.write(
      `brief.md: \u00A7${m.num} (${m.title}) missing required code block\n`,
    );
  }
  return false;
}

async function checkCompanions() {
  const briefText = readBriefOrExit();
  const matter = (await loadDep("gray-matter")).default;
  const parsed = matter(briefText);
  const companions = parsed.data["companion-files"] || [];

  let allOk = true;

  for (let i = 0; i < companions.length; i++) {
    const c = companions[i];
    const fullPath = path.resolve(PROJECT_ROOT, c.path);

    if (!fs.existsSync(fullPath)) {
      if (c.required) {
        process.stderr.write(
          `brief.md: companion-files[${i}].path '${c.path}': file not found\n`,
        );
        allOk = false;
      }
      continue;
    }

    try {
      fs.accessSync(fullPath, fs.constants.R_OK);
    } catch {
      process.stderr.write(
        `brief.md: companion-files[${i}].path '${c.path}': not readable\n`,
      );
      allOk = false;
      continue;
    }

    if (c.type === "navigation") {
      if (!fs.existsSync(NAV_SCHEMA_PATH)) continue;
      const navSchema = JSON.parse(fs.readFileSync(NAV_SCHEMA_PATH, "utf8"));
      // Skip placeholder schemas (detected via $comment marker).
      if (String(navSchema.$comment || "").startsWith("PLACEHOLDER")) continue;

      let data;
      try {
        data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (err) {
        process.stderr.write(
          `brief.md: companion-files[${i}].path '${c.path}': invalid JSON (${err.message})\n`,
        );
        allOk = false;
        continue;
      }

      const AjvModule = await loadDep("ajv/dist/2020.js");
      const Ajv = AjvModule.default || AjvModule.Ajv2020 || AjvModule;
      const addFormats = (await loadDep("ajv-formats")).default;
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(navSchema);
      if (!validate(data)) {
        for (const err of validate.errors || []) {
          process.stderr.write(
            `brief.md: companion-files[${i}].path '${c.path}': ${err.instancePath || "/"}: ${err.message}\n`,
          );
        }
        allOk = false;
      }
    }
  }

  if (allOk) {
    process.stdout.write("\u2713 All companion files present and valid\n");
  }
  return allOk;
}

/**
 * feat-023 — when docs/brief-capabilities.json exists alongside brief.md,
 * validate it against schemas/brief-capabilities.schema.json. The file is
 * authored by /analyze; pre-feat-023 projects won't have it (no-op pass).
 */
async function checkBriefCapabilities() {
  if (!fs.existsSync(BRIEF_CAPABILITIES_PATH)) {
    process.stdout.write(
      "✓ brief-capabilities.json not present (skipped — pre-feat-023 project)\n",
    );
    return true;
  }
  if (!fs.existsSync(BRIEF_CAPABILITIES_SCHEMA_PATH)) {
    process.stderr.write(
      `WARNING: ${BRIEF_CAPABILITIES_SCHEMA_PATH} not found; cannot validate brief-capabilities.json\n`,
    );
    return true;
  }
  const AjvModule = await loadDep("ajv/dist/2020.js");
  const Ajv = AjvModule.default || AjvModule.Ajv2020 || AjvModule;
  const addFormats = (await loadDep("ajv-formats")).default;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(BRIEF_CAPABILITIES_PATH, "utf8"));
  } catch (err) {
    process.stderr.write(
      `brief-capabilities.json: invalid JSON (${err.message})\n`,
    );
    return false;
  }

  const schema = JSON.parse(
    fs.readFileSync(BRIEF_CAPABILITIES_SCHEMA_PATH, "utf8"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const err of validate.errors || []) {
      process.stderr.write(
        `brief-capabilities.json: ${err.instancePath || "/"}: ${err.message}\n`,
      );
    }
    return false;
  }

  // Cross-field: capability IDs must be unique within the file.
  const seen = new Map();
  for (const cap of data.capabilities || []) {
    if (seen.has(cap.id)) {
      process.stderr.write(
        `brief-capabilities.json: duplicate capability id '${cap.id}' (also at index ${seen.get(cap.id)})\n`,
      );
      return false;
    }
    seen.set(cap.id, seen.size);
  }

  process.stdout.write(
    `✓ brief-capabilities.json validates (${data.capabilities.length} capabilities)\n`,
  );
  return true;
}

function checkStructure() {
  if (!fs.existsSync(MARKDOWNLINT_CONFIG)) {
    process.stderr.write(
      `WARNING: ${MARKDOWNLINT_CONFIG} not found (task 016 not yet shipped). --structure is a no-op.\n`,
    );
    process.stdout.write("\u2713 Structure (markdownlint) skipped\n");
    return true;
  }

  const result = spawnSync("npx", ["markdownlint-cli2", BRIEF_PATH], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    shell: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status === 0) {
    process.stdout.write("\u2713 Structure (markdownlint) valid\n");
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const keepGoing = args.delete("--keep-going");
const runAll = args.delete("--all");

if (runAll && args.size > 0) {
  die(
    2,
    `--all cannot be combined with other check flags: ${[...args].join(", ")}`,
  );
}

const checks = [];
if (runAll || args.has("--frontmatter"))
  checks.push(["frontmatter", checkFrontmatter]);
if (runAll || args.has("--codeblocks"))
  checks.push(["codeblocks", checkCodeblocks]);
if (runAll || args.has("--companions"))
  checks.push(["companions", checkCompanions]);
if (runAll || args.has("--brief-capabilities"))
  checks.push(["brief-capabilities", checkBriefCapabilities]);
if (runAll || args.has("--structure"))
  checks.push(["structure", checkStructure]);

if (checks.length === 0) {
  die(
    2,
    "Usage: validate-brief.mjs [--frontmatter] [--codeblocks] [--companions] [--brief-capabilities] [--structure] [--all [--keep-going]]",
  );
}

let allOk = true;
for (const [name, fn] of checks) {
  const ok = await fn();
  if (!ok) {
    allOk = false;
    if (runAll && !keepGoing) break;
  }
}

if (allOk) {
  if (runAll) process.stdout.write("\u2713 Brief validation passed\n");
  process.exit(0);
}
process.exit(1);
