# Brief Authoring Spec — Gotribe Hardening Curriculum

This file is consumed by the sub-agents authoring brief.md for each tier-1 and tier-2 project. **Read this first**, then read your assigned outlines, then write briefs that conform.

## Source-of-truth files

| File                                                                                                     | Purpose                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gotribe-briefs/tier-1-atomic.md`                                                                        | 20 tier-1 outlines                                                                                                                                                                 |
| `gotribe-briefs/tier-2-combining.md`                                                                     | 5 tier-2 outlines                                                                                                                                                                  |
| `brief-template.md` (factory root)                                                                       | Required 20-section structure (markdownlint MD043 enforced)                                                                                                                        |
| `C:\Development\ps\claude\claude_\agentflow\agentflow_version2\agentflow\projects\gotribe_new2\brief.md` | The full GoTribe brief — **shared visual design (§2), personas (§6), security stance (§17 of theirs), regulatory base (§18 of theirs)**. Pull these into every brief consistently. |
| `.claude/rules/testing-policy.md`                                                                        | Strategy A/C/D + coverage thresholds + Strategy-C `/test/seed` contract. Cited verbatim in every brief's §17.                                                                      |

## Procedure per project

1. Run the new-project Skill: `Skill(skill="new-project", args="<project-name>")`.
2. Verify scaffold succeeded: `projects/<name>/brief.md` exists, contains the empty template.
3. Read your assigned outline from `gotribe-briefs/tier-1-atomic.md` (or `tier-2-combining.md`).
4. Read GoTribe's brief.md once (cache in your context for §2/§6 reuse).
5. Write `projects/<name>/brief.md` per the section spec below — completely overwrite the seeded template.

## Frontmatter (mandatory, identical across all briefs except project-name)

```yaml
---
$schema: ./schemas/brief-frontmatter.schema.json
version: "1.0.0"
status: draft
project-name: "<actual-project-name>"
author: "gotribe-curriculum"
created: 2026-05-07
last-modified: 2026-05-07
brief-schema-version: "1.0"
companion-files: []
tags: ["gotribe-curriculum", "<tier-1 or tier-2>", "<capability-slug>"]
amendments: []
---
```

## H1

Always exactly: `# Project Brief` (do NOT personalize the H1).

## Section spec (all 20 mandatory; markdownlint MD043 fails if any are missing or renamed)

### §1 Vision & Principles

2-4 sentences. Frame as: "A factory-hardening test project. Proves [factory capability]. Slice of GoTribe surface: [domain]. Definition of done: ships clean through `/start-build` with no human intervention beyond design gates." Add 2-3 directional principles ("prefer X over Y").

### §2 Visual Design Requirements

**Reuse this verbatim across every brief in the curriculum** — consistency lets us catch design-conformance regressions across the whole batch:

- Brand palette (from GoTribe brief §2):
  - Primary green `#6B9B37` (logo + primary CTAs)
  - Secondary teal `#14b8a6`
  - Header/footer charcoal `#3D3D3D`
  - Semantic: success `#22c55e`, warning `#eab308`, error `#ef4444`, info `#3b82f6`
  - Notification badge red `#E53935`
- Typography: Inter (system fallback). Sizes xs(12)/sm(14)/base(16)/lg(18)/xl(20)/2xl(24)/3xl(30).
- Header: dark charcoal, centered logo, light-gray icons, red badge for unread counts.
- Bottom tab bar (mobile briefs): dark charcoal, light-gray inactive, lighter pill for active.
- Cards: white, rounded corners, light shadow.
- Logo: green chameleon "gotribe" wordmark — placeholder OK; real asset lives in factory `assets/`.

If the brief has no UI (rare), still include the palette + typography block — the design tokens are downstream-consumed.

### §3 Problem Statement

The user-facing problem THIS slice solves, narrowed to scope. Don't restate full GoTribe. 3-5 sentences. Avoid solution-language.

### §4 Core Entities

Tier 1: 1-3 entities. Tier 2: 4-7 entities.
For each: what it is, what it owns, what it relates to. **Do not include any entity outside the outline's scope.** Use entity names from GoTribe brief §4.

### §5 Key Distinctions

Terms a reader could conflate. Format: "X is not Y because Z." If the brief has none (likely for narrow tier-1 projects), write one sentence explaining why ("Not applicable — single-entity scope; no terminology overlap.").

### §6 User Personas

Tier 1: 1 persona only. Tier 2: 2 personas. Pull from GoTribe brief §6 (Sarah Seeker, Marcus Founder, Elena Admin, James Contributor, Priya Steward). Truncate the persona to fit this brief's scope; don't restate the full GoTribe persona.

### §7 Architecture Overview

Mandatory fenced code block (markdownlint MD043 invariant). ASCII art showing client → API → DB (or the actual topology). Plus a 2-3 sentence narrative naming the stack picks from the outline.

```text
┌──────────┐     ┌──────────┐     ┌──────────┐
│  client  │ ──> │   api    │ ──> │    db    │
└──────────┘     └──────────┘     └──────────┘
```

### §8 Infrastructure Architecture

Single-node Docker Compose. 3-5 sentences. No multi-node, no Yggdrasil, no K3s — those are deferred per `gotribe-briefs/INDEX.md`. Mention: hosting (local dev only for the curriculum), CI gate (lint + typecheck + test), production target (none — these are factory-hardening test projects).

### §9 Backend Module Architecture

One short paragraph per backend module (1-3 modules typically). Name the module the same as the §4 entity it owns. Example: "`@app/tribes` — owns the Tribes table; exposes `tribes.list`, `tribes.get` via tRPC; no mutations."

### §10 Navigation Schema

Mandatory fenced code block. JSON listing screens with `path` + `screen` keys. Keep it under 30 entries. Admin-only screens flagged with `"admin": true`.

```json
{
  "routes": [{ "path": "/", "screen": "home" }]
}
```

### §11 Screen Catalog

One bullet per screen from the outline's screen count. Format: `**screen-id** — purpose (one line); primary actions; permission gate if any`.

### §12 Key Features Summary

Flat bullet list. Tier 1: 5-8 features. Tier 2: 8-15 features. **Anything not listed here is out of scope and the PM will not generate tasks for it.**

### §13 Security

3-6 bullets. Default block for every brief that has auth: bcrypt password hashing (cost ≥10), JWT (HS256 ≥256-bit secret, 15-min access + 7-day refresh), Zod input validation at every public boundary, CORS allowlist, rate limit 100req/15min per IP, helmet security headers. Add brief-specific items (e.g., XSS guard for wiki briefs, webhook-signature validation for Stripe briefs).

### §14 Regulatory Notes

- GDPR: right-to-deletion via DB cascade (named).
- No PII beyond email + display name unless brief explicitly requires it.
- For Stripe briefs: PCI DSS handled by Stripe Connect (no card data touches our servers).
- For map briefs: Mapbox tile attribution required.
- For tier-1 briefs without payments/maps/PII beyond email: just the GDPR sentence.

### §15 Success Metrics

3-6 bullets, quantitative where possible. Include factory-hardening metrics, not user metrics:

- "Build pipeline reaches `/start-build` `complete` status without human intervention on first run"
- "Tester E2E suite green at first run; no genuine-product-bug flags"
- "Reviewer overallVerdict = approved on first run"
- "Coverage ≥80% combined per `.claude/rules/testing-policy.md`"
  Plus 1-2 brief-specific metrics tied to the capability under test.

### §16 Development Workflow

3-5 sentences. main branch protected; feature worktrees per task per orchestrator Mode B; pre-commit lint+typecheck gate; PR review = the reviewer agent's pass; archive completed plans via `/plan-archive`.

### §17 Testing Strategy

Cite `.claude/rules/testing-policy.md` by name. Name the strategy this brief uses (A: localStorage, C: real DB + `/test/seed`+`/test/seed-baseline`+`/test/cleanup`, D: external-only mocked). Coverage: 60% builder happy-path, 80% combined. List the test layers per the policy table (builder happy-path unit + tester edge unit + integration + E2E web/mobile + full-suite-coverage). For external-API briefs (Stripe, Mapbox, S3): explicit mention of the bug-119 mocking constraint.

### §18 Deployment Pipeline

1 paragraph. Local Docker Compose for tests; no production deploy (these are factory-hardening test projects). CI gates: lint → typecheck → builder unit tests → tester edge + integration → tester E2E → reviewer pass. Rollback: not applicable (no prod).

### §19 Milestones & Timeline

1-2 milestones max. M1: "MVP build through `/start-build` green path." Date: 2026-05-15 (aspirational; gates the next brief in the curriculum). Tier 2 briefs add: M2: "Cross-feature integration verified" (1 week after M1).

### §20 Appendix

3-5 lines:

- Source outline: `gotribe-briefs/tier-{N}-{atomic|combining}.md` § {brief-number}
- Curriculum index: `gotribe-briefs/INDEX.md`
- Promotes to (tier-1 only): the tier-2 brief that consumes this brief's learnings
- GoTribe full brief: `C:\Development\ps\claude\claude_\agentflow\agentflow_version2\agentflow\projects\gotribe_new2\brief.md` (read-only reference)

## Hard rules

1. **Exactly 20 sections**, headings exactly as in `brief-template.md` (markdownlint MD043 will fail otherwise). Don't drop, rename, reorder, or merge.
2. **No "see other doc" stubs**. Every section has substantive content.
3. **No scope creep**. If the outline says "out of scope: X", do not include X under any heading. PM agent reads §12 and will generate tasks for everything listed there.
4. **Visual design (§2) is identical across all 25 briefs**. Copy-paste the block from this spec verbatim.
5. **§17 cites `.claude/rules/testing-policy.md` by path** every time. Stack-skill `§Testing` blocks bind to it.
6. **Frontmatter dates** = 2026-05-07 in all briefs (today's date).
7. **No emoji** anywhere unless the outline explicitly requires (none do).
8. **Stack picks come from the outline**. Do not invent new stacks. If the outline says `node-fastify`, the brief says `node-fastify`.

## Sanity-check before exit

Before reporting back, for each brief:

- Run: `node scripts/validate-brief.mjs --project projects/<name>` from factory root. Capture exit code + any errors.
- If validation fails on a section that requires a fenced code block (§7, §10), check that you included one.
- If validation fails on missing frontmatter fields, fix the frontmatter and re-run.
- Report validation pass/fail per project in your final summary.
