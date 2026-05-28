#!/usr/bin/env node
// .claude/hooks/verify-gate.mjs
//
// PreToolUse hook on Write/Edit/MultiEdit. When the target is
// feature_list.json AND the proposed change flips a row's passes:false→true,
// the hook denies unless the row's evidence file has been Read this session
// (per .claude/state/evidence-reads.json, populated by track-read.mjs).
//
// Contract: reads tool-call JSON on stdin. Always exits 0. Signals deny via
// hookSpecificOutput JSON on stdout. Any other tool, or any write/edit not
// targeting feature_list.json, is allowed through.
//
// Self-test: --selftest flag runs an internal probe and exits 0/1.
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FEATURE_LIST_PATH = path.join(PROJECT_DIR, "feature_list.json");
const READS_FILE = path.join(
  PROJECT_DIR,
  ".claude",
  "state",
  "evidence-reads.json",
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

function normalize(p) {
  return p
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, "/$1");
}

// --- Self-test mode ---
if (process.argv.includes("--selftest")) {
  const cur = `[{"id":"x","passes":false,"evidence":"evidence/x-result.txt"}]`;
  const next1 = `[{"id":"x","passes":true,"evidence":"evidence/x-result.txt"}]`;
  const flips = detectFlips(cur, next1);
  if (flips.length !== 1 || flips[0].id !== "x") {
    console.error("selftest FAIL: expected 1 flip");
    process.exit(1);
  }
  const next2 = `[{"id":"x","passes":false,"evidence":"evidence/x-result.txt"}]`;
  if (detectFlips(cur, next2).length !== 0) {
    console.error("selftest FAIL: expected 0 flips on no-change");
    process.exit(1);
  }
  console.log("verify-gate selftest PASS");
  process.exit(0);
}

function detectFlips(curText, nextText) {
  let cur, next;
  try {
    cur = JSON.parse(curText);
    next = JSON.parse(nextText);
  } catch {
    return [];
  }
  const curRows = Array.isArray(cur) ? cur : cur.rows || [];
  const nextRows = Array.isArray(next) ? next : next.rows || [];
  const curById = new Map(curRows.map((r) => [r.id, r]));
  const flips = [];
  for (const nr of nextRows) {
    const cr = curById.get(nr.id);
    if (cr && cr.passes === false && nr.passes === true) {
      flips.push({ id: nr.id, evidence: nr.evidence });
    }
  }
  return flips;
}

function readsList() {
  if (!fs.existsSync(READS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(READS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

const targetNorm = normalize(path.resolve(PROJECT_DIR, filePath));
const fixtureNorm = normalize(FEATURE_LIST_PATH);
if (targetNorm !== fixtureNorm) allow();

if (!fs.existsSync(FEATURE_LIST_PATH)) allow();

const curText = fs.readFileSync(FEATURE_LIST_PATH, "utf8");
let nextText;
try {
  if (toolName === "Write") {
    nextText = toolInput.content || "";
  } else if (toolName === "Edit") {
    const oldStr = toolInput.old_string || "";
    const newStr = toolInput.new_string || "";
    if (toolInput.replace_all) {
      nextText = curText.split(oldStr).join(newStr);
    } else {
      const idx = curText.indexOf(oldStr);
      if (idx === -1) allow();
      nextText =
        curText.slice(0, idx) + newStr + curText.slice(idx + oldStr.length);
    }
  } else if (toolName === "MultiEdit") {
    nextText = curText;
    for (const edit of toolInput.edits || []) {
      const oldStr = edit.old_string || "";
      const newStr = edit.new_string || "";
      if (edit.replace_all) {
        nextText = nextText.split(oldStr).join(newStr);
      } else {
        const idx = nextText.indexOf(oldStr);
        if (idx === -1) allow();
        nextText =
          nextText.slice(0, idx) + newStr + nextText.slice(idx + oldStr.length);
      }
    }
  }
} catch {
  allow();
}

const flips = detectFlips(curText, nextText);
if (flips.length === 0) allow();

const reads = readsList();
const readPaths = new Set(
  reads.map((r) => normalize(path.resolve(PROJECT_DIR, r.file_path || ""))),
);

const unverified = flips.filter((f) => {
  if (!f.evidence) return true;
  const want = normalize(path.resolve(PROJECT_DIR, f.evidence));
  return !readPaths.has(want);
});

if (unverified.length === 0) allow();

const list = unverified
  .map((f) => `  - ${f.id} (evidence: ${f.evidence || "<missing>"})`)
  .join("\n");

deny(
  `VERIFY-GATE: cannot flip passes:false → true without reading the row's evidence this session.\n` +
    `Unverified flips:\n${list}\n` +
    `Read each evidence file with the Read tool, then re-attempt the flip. ` +
    `(Evidence-read log: ${READS_FILE})`,
);
