#!/usr/bin/env node
// .claude/hooks/track-read.mjs
//
// PostToolUse hook on Read. Appends {tool, file_path, timestamp} to
// .claude/state/evidence-reads.json so verify-gate.mjs can consult it.
//
// Contract: reads PostToolUse JSON on stdin. Always exits 0. Never blocks.
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, ".claude", "state");
const READS_FILE = path.join(STATE_DIR, "evidence-reads.json");
const WINDOW_SIZE = 500; // cap to avoid unbounded growth

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

const toolName = payload.tool_name || "";
if (toolName !== "Read") process.exit(0);

const filePath =
  payload.tool_input?.file_path || payload.tool_input?.path || "";
if (!filePath) process.exit(0);

let entries = [];
if (fs.existsSync(READS_FILE)) {
  try {
    entries = JSON.parse(fs.readFileSync(READS_FILE, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
}

entries.push({
  tool: "Read",
  file_path: filePath,
  timestamp: Date.now(),
});

try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = READS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries.slice(-WINDOW_SIZE), null, 2));
  fs.renameSync(tmp, READS_FILE);
} catch (err) {
  process.stderr.write(`track-read: failed to write state: ${err.message}\n`);
}

process.exit(0);
