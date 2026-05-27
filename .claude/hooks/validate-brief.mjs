#!/usr/bin/env node
// .claude/hooks/validate-brief.mjs
//
// PreToolUse hook. When Write / Edit / MultiEdit targets brief.md, simulate
// the operation in-memory, validate the result against the frontmatter JSON
// Schema + code-block requirements, and block the tool call if invalid.
//
// Contract: reads tool-call JSON on stdin. Always exits 0. Signals deny via
// hookSpecificOutput JSON on stdout with permissionDecision = "deny".
// Any other tool (or any write not targeting brief.md) is allowed through.
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BRIEF_PATH = path.join(PROJECT_DIR, "brief.md");
const SCHEMA_PATH = path.join(
  PROJECT_DIR,
  "schemas",
  "brief-frontmatter.schema.json",
);

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw || "{}");
} catch {
  allow();
}

const toolName = payload.tool_name || "";
const toolInput = payload.tool_input || {};
const filePath = toolInput.file_path || toolInput.path || "";

if (!["Write", "Edit", "MultiEdit"].includes(toolName)) allow();
if (!filePath) allow();

function normalize(p) {
  return p
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, "/$1");
}
const targetNorm = normalize(path.resolve(PROJECT_DIR, filePath));
const briefNorm = normalize(BRIEF_PATH);
if (targetNorm !== briefNorm) allow();

let newContent;
try {
  if (toolName === "Write") {
    newContent = toolInput.content || "";
  } else if (toolName === "Edit") {
    const cur = fs.existsSync(BRIEF_PATH)
      ? fs.readFileSync(BRIEF_PATH, "utf8")
      : "";
    const oldStr = toolInput.old_string || "";
    const newStr = toolInput.new_string || "";
    if (toolInput.replace_all) {
      newContent = cur.split(oldStr).join(newStr);
    } else {
      const idx = cur.indexOf(oldStr);
      if (idx === -1) {
        allow();
      }
      newContent = cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length);
    }
  } else if (toolName === "MultiEdit") {
    const cur = fs.existsSync(BRIEF_PATH)
      ? fs.readFileSync(BRIEF_PATH, "utf8")
      : "";
    newContent = cur;
    for (const edit of toolInput.edits || []) {
      const oldStr = edit.old_string || "";
      const newStr = edit.new_string || "";
      if (edit.replace_all) {
        newContent = newContent.split(oldStr).join(newStr);
      } else {
        const idx = newContent.indexOf(oldStr);
        if (idx === -1) allow();
        newContent =
          newContent.slice(0, idx) +
          newStr +
          newContent.slice(idx + oldStr.length);
      }
    }
  }
} catch {
  allow();
}

let matter, Ajv, addFormats;
try {
  matter = (await import("gray-matter")).default;
  const AjvModule = await import("ajv/dist/2020.js");
  Ajv = AjvModule.default || AjvModule.Ajv2020 || AjvModule;
  addFormats = (await import("ajv-formats")).default;
} catch {
  process.stderr.write(
    "validate-brief hook: Ajv/gray-matter not installed; skipping brief validation.\n",
  );
  allow();
}

const errors = [];

if (!fs.existsSync(SCHEMA_PATH)) {
  allow();
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
let parsed;
try {
  parsed = matter(newContent);
} catch (err) {
  deny(
    `Proposed brief.md has invalid YAML frontmatter: ${err.message}. Fix the \`---\` block before saving.`,
  );
}

for (const key of Object.keys(parsed.data)) {
  if (parsed.data[key] instanceof Date) {
    parsed.data[key] = parsed.data[key].toISOString().slice(0, 10);
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(parsed.data)) {
  for (const err of validate.errors || []) {
    errors.push(`frontmatter ${err.instancePath || "/"}: ${err.message}`);
  }
}

const REQUIRED = [
  { num: 7, title: "Architecture Overview" },
  { num: 10, title: "Navigation Schema" },
];
const lines = newContent.split("\n");
const sections = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^##\s+(\d+)\.\s+(.+?)\s*$/);
  if (m) sections.push({ num: Number(m[1]), start: i });
}
for (let i = 0; i < sections.length; i++) {
  sections[i].end = sections[i + 1] ? sections[i + 1].start : lines.length;
}
for (const { num, title } of REQUIRED) {
  const section = sections.find((s) => s.num === num);
  if (!section) {
    errors.push(`§${num} (${title}) section heading not found`);
    continue;
  }
  const slice = lines.slice(section.start, section.end);
  if (!slice.some((l) => /^\s*```/.test(l))) {
    errors.push(`§${num} (${title}) missing required fenced code block`);
  }
}

if (errors.length === 0) allow();

deny(
  "Proposed brief.md would be invalid. Fix these before saving:\n" +
    errors.map((e) => `  - ${e}`).join("\n") +
    "\n\nRun `/validate-brief` after editing to confirm, or `node scripts/validate-brief.mjs --all --keep-going` for the full error set.",
);
