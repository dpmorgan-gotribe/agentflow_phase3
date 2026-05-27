---
name: visual-review
description: Screenshot every generated screen at three viewports (mobile 390×844, tablet 768×1024, desktop 1440×900) via Playwright MCP and run the seven-section visual rubric (rubric.md) against each. Emit structured retry-feedback.md per failure and an aggregate report.json. Stateless — retry counter is owned by the orchestrator (035). Runs after /screens + /verify-html, before /user-flows-generator.
when-to-use: after /screens completes and /verify-html (032b) has passed; before /user-flows-generator
allowed-tools: Read Write Bash Grep Glob
---

# /visual-review — Layer 7 LLM Visual Critique

Renders each generated screen at 3 viewports, runs the rubric, emits
retry-feedback on failure. The orchestrator (035) decides whether to retry
or escalate; this skill is stateless.

## Arguments

From `C:/Users/nagro/.claude/projects/C--Development-ps-claude-claude--agentflow-phase2/memory/` extract (defaults in parens):

- `--platforms a,b,c` (all detected) — restrict review to these platforms.
  If omitted, read `docs/brief-summary.json.detectedPlatforms` and review all.
- `--screen {platform}/{id}` (none) — review ONE screen only. Orchestrator
  uses this after a retry to confirm the fix landed. Skips pre-flight
  checks that require whole-set invariants.
- `--skip-chrome-devtools` (false) — omit Lighthouse + a11y side-channel
  even if the MCP is present. Useful for fast iteration.
- `--timeout-per-screen` (90) — seconds before a screen is marked
  `review-timeout` and added to `needsHumanReview` without consuming retry
  budget.

## Steps

### 1. Pre-flight

Abort cleanly (no side effects, no screenshots written) on any failure:

- `docs/selected-style.json` exists and parses against `SelectedStyleSchema`
  (034b). If missing, error: "No selected-style.json — run /mockups and the
  gate-2 HITL first."
- `docs/screens-manifest.json` exists. If missing, error: "No
  screens-manifest.json — run /screens first."
- At least one `docs/screens/{platform}/*.html` exists for each detected
  platform (from `docs/brief-summary.json`). Missing platform → error with
  the platform name.
- Playwright MCP is available. Probe with `mcp__playwright__browser_install`
  or `browser_navigate` to a `data:` URL. If unreachable, error:
  "Playwright MCP unreachable — task 041 must register it before
  /visual-review can run."
- Chrome DevTools MCP probed the same way; **absence is NOT fatal** — set
  `chromeDevToolsAvailable: false` and skip the lighthouse + a11y fields.

Single-screen mode (`--screen platform/id`) relaxes the checks: only
asserts that specific HTML file exists. Skip the "at least one per
platform" rule.

### 2. Spin a local static server

The Playwright MCP cannot open `file://` URLs with relative asset paths
reliably — we serve over HTTP so `../../../packages/ui-kit/src/tokens/tokens.css`
and `../../../assets/logos/*.png` resolve.

Use the bundled helper `scripts/visual-review-preflight.mjs` (factory-owned,
copied into each project by `/new-project`):

- **Preflight check** (synchronous, exits non-zero on missing inputs):

  ```bash
  node scripts/visual-review-preflight.mjs check projects/<name>
  ```

  Returns JSON `{ success, projectDir, screens[], screenCount, selectedStyle }`
  on success. On failure: exits 1 with `{ success: false, reason, issues[] }`.
  Abort the skill on non-zero exit — do NOT proceed to serve.

- **Start static server** (spawns detached http-server, writes lockfile):

  ```bash
  node scripts/visual-review-preflight.mjs serve projects/<name> [startPort=4173]
  ```

  Returns JSON `{ pid, port, rootDir, startedAt, lockfilePath }`. The helper
  finds the first free dynamic port ≥ startPort (auto-advances on collision)
  and writes the lockfile at `pipeline/visual-review-{ISO-timestamp}.lockfile`.
  Serves the project root — NOT just `docs/` — so `../../../packages/ui-kit/`
  and `../../../assets/` resolve. Cache is disabled (`-c-1`) so retries see
  fresh HTML.

- **Tear down** (always run — success OR failure path; wrap rubric loop in
  a try/finally):

  ```bash
  node scripts/visual-review-preflight.mjs stop <lockfilePath>
  ```

  Uses `taskkill /T /F` on Windows (kills the process tree — `npx` spawns
  http-server as a grandchild through cmd.exe's shim) and `kill -GROUP`
  on POSIX.

The helper is a tiny wrapper around http-server + taskkill/kill; it exists
because Windows `spawn` with shell:true returns the shim's pid, not
http-server's — naive `process.kill(pid)` does not tear down the grandchild.

### 3. Iterate screens

Build the work queue:

- Whole-set mode: read `docs/screens-manifest.json.files[]` (scoped to
  `--platforms` if supplied).
- Single-screen mode: just `[{platform, screenId, path}]` for the one screen.

For each screen in the queue, perform steps 3a-3f:

#### 3a. Render at three viewports

Three Playwright MCP calls per screen, each in sequence (Playwright holds
one browser context at a time):

1. `mcp__playwright__browser_resize` → `width: 390, height: 844`
2. `mcp__playwright__browser_navigate` → `http://localhost:{port}/docs/screens/{platform}/{screenId}.html`
3. `mcp__playwright__browser_wait_for` → network idle + `body` visible (2s max)
4. `mcp__playwright__browser_take_screenshot` → full-page PNG, save to
   `docs/visual-review/{platform}/{screenId}/mobile.png`

Repeat for `tablet` (768 × 1024) and `desktop` (1440 × 900). Reuse the
same browser context across the three captures — only resize + re-navigate.

If Playwright times out on any single viewport, record the partial result
and continue to the next viewport. If ALL three viewports fail for a
screen, mark the screen `review-timeout` and skip the rubric for it.

#### 3b. Chrome DevTools side-channel (optional)

If `chromeDevToolsAvailable`, after the desktop capture, invoke:

- `mcp__chrome-devtools__lighthouse` → extract score JSON
- `mcp__chrome-devtools__accessibility_tree` → extract violations

Cache both for step 3c's rubric output. Skip silently if either call fails
or if `--skip-chrome-devtools`.

#### 3c. Run the rubric

Read `.claude/skills/visual-review/rubric.md`. Compose a single LLM prompt
combining:

- The rubric markdown (verbatim — the 7 sections + dial-aware rules)
- The three PNG screenshots as vision inputs (mobile, tablet, desktop)
- The screen's HTML file contents (for motion + dark-mode static checks)
- `selected-style.json.dials` (for dial-aware adjustments)
- `packages/ui-kit/src/tokens/tokens.json` keys (for token-only validation)
- Lighthouse + a11y JSON if present

Invoke an Agent with:

```
subagent_type: general-purpose
description: "Visual rubric for {platform}/{screenId}"
prompt: {composed prompt — rubric + screenshots + HTML + dials + tokens}
```

The agent returns structured JSON:

```json
{
  "overall": "pass" | "fail",
  "rules": [
    {
      "id": "composition.single-primary-action",
      "passed": true,
      "severity": "error" | "warning" | "info",
      "detail": "..."
    },
    ...
  ],
  "lighthouse": { "performance": 92, "accessibility": 98 },
  "a11y": { "violations": [...] }
}
```

If the agent's response is not valid JSON or is missing required keys,
retry once with a strict schema reminder. After the second failure, emit
`overall: "needs-human-review"` and add the screen to
`needsHumanReview[]` with reason `"rubric-agent-invalid-response"`.

#### 3d. Write the critique

Write `docs/visual-review/{platform}/{screenId}/critique.md` (human-readable):

```markdown
# Visual Critique — {platform}/{screenId}

**Overall:** pass | fail | needs-human-review
**Reviewed at:** ISO timestamp
**Viewports:** mobile (390×844), tablet (768×1024), desktop (1440×900)

## Summary

- Composition: ✓ 5/5
- Type: ✓ 5/5
- Color: ✗ 2/4 (accent-budget fail, contrast-AA fail)
- States: ✓ 4/4
- Motion: ✓ 3/3
- Mobile: ✓ 4/4
- Slop-sniff: ✓ 3/3

## Failed rules

### color.accent-budget (error)

{detail from rubric}

### color.contrast-AA (error)

{detail from rubric}

## Lighthouse (desktop)

- Performance: 92 / 100
- Accessibility: 98 / 100

## A11y violations

- color-contrast: 2 occurrences — see retry-feedback.md
```

Screenshots are NOT embedded; they sit alongside as `mobile.png` /
`tablet.png` / `desktop.png`.

#### 3e. Pass → mark and move on

If `overall === "pass"`, record in the aggregate report and continue.

#### 3f. Fail → write retry-feedback.md

If `overall === "fail"`, write `docs/visual-review/{platform}/{screenId}/retry-feedback.md`:

```markdown
# Retry feedback — {platform}/{screenId}

**Do not regenerate the whole screen.** Apply these fixes and keep
everything else as-is.

## Failed rules

### 1. color.accent-budget (error)

**What:** Accent color (#6B9B37) covers ~18% of visible area at 1440×900
(target: <10%).

**Where:** The hero banner (`<section data-kit-component="Banner">`) and
the stats row (`<div data-kit-component="StatsRow">`) both use
`background: var(--color-accent-soft)`. Keep the banner; move the stats
row to `var(--color-surface-raised)`.

**How to fix:** Change the inline style on the stats row container to
`background: var(--color-surface-raised);`. Do not touch the banner.

### 2. mobile.touch-target-size (error)

**What:** "Edit" icon buttons in the data-table are 28×28px — below the
44×44 minimum. Flagged on the mobile screenshot.

**Where:** `<table data-kit-component="DataTable">` rows, last column.

**How to fix:** Change `data-kit-size="sm"` to `data-kit-size="md"` on
those buttons, or swap to a row-swipe gesture pattern.

## Unchanged rules

The 11 passing rules are listed in critique.md — do not regress those
while fixing the 2 above.
```

The retry-feedback is consumed by `/screens --screen {platform}/{id}` on
re-invocation (task 025 single-screen mode). Keep it actionable — every
fix references a specific DOM location and a specific code change.

### 4. Aggregate report

Write `docs/visual-review/report.json`. The report serves two downstream
consumers with different shape needs, so emit BOTH `screens[]` and
`violations[]`:

- `screens[]` is keyed per screen with `{platform, screenId, status, issues}` —
  consumed by `/user-flows-generator` to attach pass/fail/needs-human-review
  badges next to each iframe in the viewer.
- `violations[]` is a flat list of rule failures across all screens —
  consumed by the orchestrator's per-screen retry loop to pick which screens
  need a `/screens --screen` regen.

`generatedAt` is an alias of `runAt` kept for `/user-flows-generator` compatibility.

```json
{
  "version": "1.0",
  "runAt": "2026-04-21T18:35:00Z",
  "generatedAt": "2026-04-21T18:35:00Z",
  "styleId": "style-0",
  "screensReviewed": 24,
  "passed": 21,
  "failed": 3,
  "retriesTriggered": 0,
  "needsHumanReview": [],
  "screens": [
    {
      "platform": "webapp",
      "screenId": "discover-home",
      "status": "fail",
      "issues": [
        {
          "rule": "color.accent-budget",
          "severity": "error",
          "detail": "Accent covers ~18% of visible area (target <10%)"
        }
      ]
    },
    {
      "platform": "mobile",
      "screenId": "home",
      "status": "pass",
      "issues": []
    }
  ],
  "violations": [
    {
      "screen": "webapp/discover-home",
      "viewport": "desktop",
      "rule": "color.accent-budget",
      "severity": "error",
      "detail": "Accent covers ~18% of visible area (target <10%)"
    }
  ],
  "lighthouse": {
    "webapp/discover-home": { "performance": 92, "accessibility": 98 }
  },
  "chromeDevToolsAvailable": true,
  "perScreenDurationMs": {
    "webapp/discover-home": 12450
  }
}
```

Cross-check invariant: the count of `error`-severity entries across all
`screens[].issues[]` MUST equal the count of `error`-severity entries in
`violations[]`. Self-verify (step 5) enforces this.

- `retriesTriggered` is 0 when the skill runs directly. The orchestrator
  increments a separate counter for its own retry bookkeeping — this skill
  does not know or care.
- `needsHumanReview` is populated by the orchestrator AFTER the 3rd retry
  exhausts. The skill only populates it for `review-timeout` and
  `rubric-agent-invalid-response` cases where retry would not help.

### 5. Self-verify

Before reporting complete:

- Every screen in the work queue has either 3 screenshots + critique.md OR
  is marked `review-timeout` in the report
- `docs/visual-review/report.json` is valid JSON
- Sum of `passed + failed + needsHumanReview.length === screensReviewed`
- `report.json.screens.length === screensReviewed` (per-screen status block
  present for every screen the orchestrator/flows-generator expects)
- Count of error-severity entries flattened across `screens[].issues[]`
  equals count of error-severity entries in `violations[]` (dual-shape
  cross-check — guards against the two consumer views drifting)
- The static-server process is dead (`ps -p $PID` returns nothing)
- In single-screen mode, only that one screen's directory was touched
  under `docs/visual-review/` (no stale writes to other screens)

### 6. Return JSON

```json
{
  "success": true,
  "mode": "full" | "single-screen",
  "screensReviewed": 24,
  "passed": 21,
  "failed": 3,
  "retriesTriggered": 0,
  "reportPath": "docs/visual-review/report.json",
  "chromeDevToolsAvailable": true,
  "durationMs": 298450,
  "needsHumanReview": []
}
```

Must match `VisualReviewOutput` schema (task 034b, pending).

## Rubric

See `.claude/skills/visual-review/rubric.md`. Seven sections:

1. Composition (5 rules)
2. Type (5 rules)
3. Color (4 rules)
4. States (4 rules)
5. Motion (3 rules — static CSS analysis, not screenshot)
6. Mobile (4 rules — evaluated on 390×844 screenshot)
7. Slop-sniff (3 rules — gut check)

Total: 28 rules. Dial-aware adjustments per `selected-style.json.dials`.

## Cost and timeout

- Per-screen: 3 screenshots × 1 vision-LLM call ≈ --style-count=5.06–0.15 at Sonnet 4.6
- 50-screen app: ~--style-count=5.00–8.00 per pass, --style-count=50.00–20.00 including retries
- Per-screen timeout: 90s (override with `--timeout-per-screen`)
- Per-run timeout: 60 min for up to 100 screens; larger projects batch internally

Budget tracked by orchestrator (036) via reserve-commit pattern. Stage
cap: --style-count=25.00 per run (generous; adjust in `~/.claude/models.yaml.stages.visual-review`).

## MCP usage

- `playwright` — REQUIRED. Provides `browser_resize`, `browser_navigate`,
  `browser_wait_for`, `browser_take_screenshot`. Scoped to `ui-designer`
  - `html-verifier` agents in `architecture.yaml` (task 020 output).
- `chrome-devtools` — OPTIONAL. Provides `lighthouse` +
  `accessibility_tree`. Skill auto-detects and silently skips if absent.

Neither is a generative MCP. This skill is **observational, never generative** — No `--nanobanana` interaction. The flag, if propagated by the orchestrator, is ignored here.

## Single-screen retry mode (driven by /screens --screen)

When the orchestrator detects `report.json.failed > 0` and decides to
retry, it re-invokes `/screens --screen {platform}/{id}` (task 025
single-screen mode, cross-task dependency). That regenerates ONE HTML
file consuming `retry-feedback.md` as guidance.

After `/screens --screen` completes, the orchestrator re-invokes THIS
skill with the same `--screen` argument to re-review just that one
screen. The skill:

1. Reads existing `report.json` if present
2. Reviews the single screen
3. Updates report.json by replacing the old entry for that screen (not
   appending — deduped on `{platform}/{screenId}`)
4. Recomputes `passed` / `failed` totals
5. Leaves all other screen results unchanged

The `retriesTriggered` counter in report.json is never incremented by
the skill — the orchestrator manages that outside.

## Error handling

- **Pre-flight fail**: abort before spinning the server. Return
  `{success: false, reason: "..."}`.
- **Server spawn fail**: abort. Return
  `{success: false, reason: "static-server-failed: ..."}`. No screenshots
  written.
- **Playwright unreachable mid-run**: mark all remaining screens
  `review-timeout`, tear down the server, write partial report, return
  `{success: false, reason: "playwright-lost", partialReport: "..."}`.
- **Screen-level Playwright failure**: mark that one screen
  `review-timeout`, continue to the next screen.
- **Rubric-agent JSON malformed (twice)**: mark screen
  `needs-human-review`, continue.
- **Budget exhausted**: orchestrator kills the skill externally via the
  036 reserve-commit pattern. The lockfile + server teardown still run
  via the shell trap.

## Integration points

- **Task 035** (orchestrator): inserts `/visual-review` between `/screens`
  and `/user-flows-generator`; implements per-screen retry loop (max **3 attempts**,
  independent of HTML-verifier retry budget, orchestrator-owned counter — this
  skill remains stateless).
- **Task 034b** (output schemas): defines `VisualReviewOutput` — must match
  the return JSON shape in step 6.
- **Task 034** (output contracts): references this skill as Layer 7 in the
  six-layer defense-in-depth table.
- **Task 041** (MCP registration): `playwright` + `chrome-devtools` MUST be
  in the `--scope=design` catalog.
- **Task 036** (HITL gates): final sign-off gate blocks if
  `report.json.failed > 0` after retries — reviewer sees flagged screens
  inline with their critique.md.
- **Task 037** (Lessons agent): aggregates `violations[]` across projects
  → populates the anti-patterns log.
- **Task 025** (/screens): MUST support `--screen {platform}/{id}` — see
  the SKILL.md update in this task.

## Related files

- `.claude/skills/visual-review/rubric.md` — 28-rule checklist
- `.claude/skills/screens/SKILL.md` — single-screen retry mode (updated)
- `schemas/visual-review-report.schema.json` — aggregate-report validator
  (created alongside this skill)
