---
task-id: "034"
title: "Output Contract Enforcement (7 Layers)"
status: pending
priority: P2
tier: 8 — Quality & Ship
depends-on: ["012", "022"]
estimated-scope: medium
---

# 034: Output Contract Enforcement

## What This Task Produces

A seven-layer defense-in-depth system that prevents agents from returning prose instead of structured output AND catches visual/semantic violations that escape mechanical checks.

Refactor-001 added Layer 7 (LLM-based visual critique via `/visual-review`) on top of the blueprint's original six. Layer 4 also grew an anti-slop grep pattern set alongside its original HTML-shape checks.

## Scope

### Layer 1: Prompt Engineering

Already embedded in agent system prompts (Task 022 for UI Designer; same pattern for all builders 029/030). The CRITICAL OUTPUT RULES:

1. ALWAYS write HTML output to the file path specified
2. NEVER include HTML in response text
3. Response should ONLY contain file path and status
4. DO NOT explain the HTML, add markdown, or wrap in backticks
5. Self-verify by reading back files before reporting complete

For kit-consuming agents (029/030), an additional rule: CONTRACT.md embedded verbatim in the system prompt (six rules + escape hatches + enforcement section — from task 022b).

### Layer 2: File-Based Output

Already specified in agent definitions. HTML → files, response → status + file paths only. Structured JSON returned inline for stage outputs (validated in Layer 3).

### Layer 3: Constrained Decoding (API-level)

Zod schemas for each stage's output — see task **034b** for the concrete `packages/orchestrator-contracts/` package and the full schema list.

Schemas relevant to refactor-001:

- `AnalyzeOutput`
- `MockupsOutput` (extended with `styleCount`, `appsCovered`, `mockupsPerStyle`, `nanobananaUsed`, image-count fields, etc.)
- `SelectedStyleSchema` — **new**; validates `docs/selected-style.json` written by the HITL mockup gate
- `StylesheetOutput` (extended with `kitVersion`, primitives/patterns/layouts counts + lists, Storybook path, `noChange`, `budgetExhausted`, etc.)
- `ScreensOutput` — now a discriminated union: batch shape vs single-screen shape (the latter used by 025b's retry path)
- `VisualReviewOutput` — **new**; validates the 025b report
- `UserFlowsOutput`
- `SignoffOutput` (extended with `visualReviewReportHash` + `uiKitVersion`)
- `BuildWebFrontendOutput`, `BuildMobileFrontendOutput` — **new**

Task 034b owns the delivery of these schemas; this task owns the **policy** that every pipeline stage MUST validate its output against them before the orchestrator advances.

### Layer 4: Hook Validation (plus anti-slop grep)

Create `.claude/hooks/validate-html-write.sh` — a PostToolUse hook on Write|Edit that runs against any file written to `docs/mockups/`, `docs/screens/`, or `docs/user-flows.html`.

**Original HTML-shape checks** (blueprint lines 2086-2113):

- File starts with `<!doctype` or `<html` (not markdown, not prose)
- No markdown code fences (` ``` `) anywhere in the body
- No `<pre><code>` leakage
- Block the write if any check fails; structured error message identifies the rule and line

**Refactor-001 additions (anti-slop grep layer):**

Extend the hook to also reject writes containing any of these patterns:

```bash
# Anti-slop — reject and fail fast
grep -qE 'linear-gradient\([^)]*(purple|violet|#8b5cf6|#a855f7|#7c3aed)' "$FILE" && fail "AI-lila gradient detected"
grep -q "Lorem ipsum" "$FILE" && fail "Lorem ipsum placeholder"
grep -qE '\b(Elevate|Seamless|Unleash|Next-Gen|Empower|Transform your)\b' "$FILE" && fail "cliché copy bigram"
grep -qE '\[insert [^\]]+\]|REPLACE_ME|\bTODO\b' "$FILE" && fail "placeholder leak"
```

These are framework-level guards; each skill's own anti-slop self-check (023 / 025) is the earlier, cheaper filter — this hook is the backstop if the skill misses one.

### Layer 5: Retry with Feedback

Pattern documented for orchestrator (Task 035): when any validation fails, retry with the specific error in the prompt. **Max 3 retries per stage per failing file.**

Refactor-001 introduces a **second, parallel retry queue** for visual review:

- **HTML-verify queue** (Layer 6 / 032b): mechanical regex; runs after every HTML-producing stage; fails a file → orchestrator retries that file in the producing skill, max 3 attempts
- **Visual-review queue** (Layer 7 / 025b): LLM rubric; runs once per screen after `/screens`; fails a screen → orchestrator re-invokes `/screens --screen {id}` with the retry-feedback.md injected, max 3 visual retries per screen

Both queues have independent counters; a screen can hit 3 html-verify retries and still have its 3 visual-review retries available (though in practice, burning 6 retries on one screen is extreme — the orchestrator flags it for human review).

### Layer 6: Mechanical HTML Verifier (Haiku)

Independent agent using Haiku that checks every HTML file the UI Designer produced. Cheap, independent, catches self-evaluation bias. **Implemented as task 032b (`html-verifier` agent + `/verify-html` skill).** This task owns the policy — every HTML-producing stage must be followed by `/verify-html` before the orchestrator advances.

### Layer 7: LLM Visual Critique (Sonnet/Opus)

Independent LLM-based rubric check with vision — screenshots every screen at three viewports via Playwright and judges against the seven-section rubric (composition, type, color, states, motion, mobile, slop-sniff). **Implemented as task 025b (`/visual-review` skill).**

Layer 7 is additive to Layer 6:

- Layer 6 catches mechanical issues fast and cheap (raw hex, missing primitives, markdown leakage, unstyled defaults) — runs per-write
- Layer 7 catches visual issues that escape regex (accent over-saturation, broken hierarchy, missing empty/loading states, slop aesthetics) — runs per-screen after batch

Ordering: skill write → Layer 4 (PostToolUse hook validates each Write; blocks the agent's next tool call on violation) → Layer 6 (verifier, per file, after the stage batch completes) → Layer 7 (visual-review, per screen, after `/screens` batch completes). If any fails, Layer 5 retry kicks in on the appropriate queue.

### Layer 0: Consumer Contract (for kit-consuming agents only)

Not part of the blueprint's original six; added here because refactor-001 introduced task 022b's consumption contract for 029/030. `packages/ui-kit/eslint-plugin/` rules + `validate-consumer.ts` enforce the kit-only-import rule at lint + CI. This is conceptually Layer 0 (pre-stage enforcement on TS/TSX output); HTML uses Layers 4/6/7 instead.

## Cross-layer summary

| Layer | Target                         | Mechanism                                   | Invocation                          |
| ----: | ------------------------------ | ------------------------------------------- | ----------------------------------- |
|     0 | TS/TSX consumer code (029/030) | ESLint plugin + validate-consumer.ts (022b) | Lint + CI                           |
|     1 | All agents                     | System prompt rules                         | Always on                           |
|     2 | All agents                     | File-based output protocol                  | Always on                           |
|     3 | Stage outputs                  | Zod schemas (034b)                          | Orchestrator post-stage validate    |
|     4 | HTML writes                    | PostToolUse hook (shape + anti-slop)        | Every Write to docs/mockups/screens |
|     5 | Retries                        | Orchestrator re-invokes with feedback       | On any failure from layers 3/4/6/7  |
|     6 | HTML files                     | html-verifier agent (032b, Haiku)           | Post-stage, per file                |
|     7 | Screens (visual)               | /visual-review (025b, Sonnet+vision)        | Post-/screens, per screen           |

## Acceptance Criteria

- [ ] Zod schemas delivered via task 034b (`packages/orchestrator-contracts/`)
- [ ] `.claude/hooks/validate-html-write.sh` exists and runs the HTML-shape checks (Layer 4 core)
- [ ] Hook also runs the anti-slop grep set: AI-lila gradients, Lorem ipsum, cliché copy, placeholder leaks
- [ ] Hook emits structured violations so agents can fix in-place
- [ ] All seven layers documented in a reference file at `docs/output-contracts.md`
- [ ] Retry-with-feedback pattern documented (max 3 per queue per failing file)
- [ ] Two parallel retry queues explicitly documented (html-verify / mechanical vs visual-review / rubric)
- [ ] Layer 6 delivered via task 032b
- [ ] Layer 7 delivered via task 025b
- [ ] Layer 0 (consumer contract) delivered via task 022b — referenced here as a kit-specific variant
- [ ] Reference file cross-links to 022b, 025b, 032b, 034b for their layers

## Human Verification

1. Hand-author a mockup with `linear-gradient(to right, #a855f7, #3b82f6)` on a CTA. Does the Layer 4 hook block the write?
2. Hand-author a file starting with `# Overview` (markdown) instead of `<!doctype html>`. Does the hook block?
3. Simulate a generated screen with a bare `<button>` (no class). Does Layer 6 catch it?
4. Simulate a generated screen with `accent color covers ~30% of visible area`. Does Layer 7 flag `color.accent-budget`?
5. Run the full retry ladder on a deliberately failing mockup: does it give up at 3 attempts and escalate?
