#!/usr/bin/env node
// .claude/hooks/detect-loop.mjs
//
// PreToolUse circuit breaker. Blocks the THIRD identical action in a row,
// so blind retries can't burn attempts 3-5 of the retry ladder.
//
// Contract: reads the full PreToolUse payload on stdin. Always exits 0;
// signals deny via the newer hookSpecificOutput JSON on stdout.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, ".claude", "state");
const ATTEMPTS_FILE = path.join(STATE_DIR, "recent-attempts.json");

const MAX_PRIOR_IDENTICAL = 2;
const WINDOW_SIZE = 50;

function hashAction({ tool, file, content, extra }) {
  const sig = `${tool || ""}:${file || ""}:${(content || "").slice(0, 200)}:${(extra || "").slice(0, 200)}`;
  return crypto.createHash("sha256").update(sig).digest("hex").slice(0, 12);
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
  process.exit(0);
}

const toolInput = payload.tool_input || {};
const CAPTURE_TOOLS = new Set([
  "mcp__playwright__browser_resize",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_close",
]);
if (CAPTURE_TOOLS.has(payload.tool_name || "")) {
  process.exit(0);
}
const hash = hashAction({
  tool: payload.tool_name,
  file: toolInput.file_path || toolInput.path || toolInput.command,
  content: toolInput.content || toolInput.new_string || toolInput.prompt,
  extra: [
    toolInput.offset,
    toolInput.limit,
    toolInput.old_string,
    toolInput.pattern,
    toolInput.subagent_type,
    toolInput.description,
    toolInput.taskId,
    toolInput.status,
    toolInput.subject,
    toolInput.query,
    toolInput.url,
    toolInput.width,
    toolInput.height,
    toolInput.filename,
    toolInput.time,
    toolInput.text,
    toolInput.textGone,
    toolInput.skill,
    toolInput.args,
  ]
    .filter((v) => v !== undefined && v !== null)
    .join("|"),
});

let attempts = [];
if (fs.existsSync(ATTEMPTS_FILE)) {
  try {
    attempts = JSON.parse(fs.readFileSync(ATTEMPTS_FILE, "utf8"));
    if (!Array.isArray(attempts)) attempts = [];
  } catch {
    attempts = [];
  }
}

const prior = attempts.filter((a) => a.hash === hash).length;

if (prior >= MAX_PRIOR_IDENTICAL) {
  deny(
    `LOOP DETECTED: this exact action has been attempted ${prior + 1} times. ` +
      `Previous attempts failed. Try a fundamentally different approach, or ` +
      `escalate with /plan-bug (if this is a bug) or /plan-investigation ` +
      `(if the root cause is unclear).`,
  );
}

attempts.push({ hash, timestamp: Date.now(), tool: payload.tool_name || null });
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    ATTEMPTS_FILE,
    JSON.stringify(attempts.slice(-WINDOW_SIZE), null, 2),
  );
} catch (err) {
  process.stderr.write(`detect-loop: failed to write state: ${err.message}\n`);
}

process.exit(0);
