---
task-id: "009"
title: "Loop Detection Hook (Circuit Breaker)"
status: complete
priority: P0
tier: 2 — Safety & Guardrails
depends-on: ["001"]
estimated-scope: small
---

# 009: Loop Detection Hook

## What This Task Produces

A PreToolUse hook at `.claude/hooks/detect-loop.mjs` that blocks the third identical attempt at the same action.

## Scope

Implement from blueprint lines 1110-1157:

### How It Works

1. Read tool input from stdin
2. Hash the action: `{tool_name}:{file_path}:{first 200 chars of content}`
3. Load `.claude/state/recent-attempts.json` (create if missing)
4. Count identical hashes
5. If count >= 3: deny with message "LOOP DETECTED — try a fundamentally different approach or escalate with /plan-bug"
6. Otherwise: append attempt, write state file (keep last 50 entries), allow

### Key Design

- Uses SHA-256 hash truncated to 12 chars
- State file persists across sessions
- Max 50 entries prevents file bloat
- Feeds the escalation ladder: attempt 3 = run /plan-investigation

## Acceptance Criteria

- [ ] `.claude/hooks/detect-loop.mjs` exists
- [ ] Uses crypto.createHash for SHA-256
- [ ] Reads/writes `.claude/state/recent-attempts.json`
- [ ] Blocks at 3 identical attempts
- [ ] Denial message references `/plan-bug`
- [ ] Keeps only last 50 entries

## Human Verification

Test mentally: an agent tries to write the same fix three times. On the third try, does it get blocked with a clear message to change approach?
