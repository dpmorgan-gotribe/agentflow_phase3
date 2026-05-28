---
id: bug-001-draft-brief-over-restrains-portfolio-briefs
type: bug
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-28
updated: 2026-05-28
parent-plan: investigate-001-phase3-stylesheet-screens-quality-regression-vs-phase2
supersedes: null
superseded-by: null
branch: fix/draft-brief-over-restrains-portfolio-briefs
affected-files:
  - .claude/skills/draft-brief/SKILL.md
  - brief-template.md
  - schemas/brief-frontmatter.schema.json
feature-area: mode-a-design-pipeline
priority: P0
attempt-count: 0
max-attempts: 5
error-message: null
reproduction-steps: "Re-run /draft-brief against proposals/hatch-proposal-text.md (or equivalent Hatch agency proposal); inspect output brief.md §1 + §2 for restraint clauses"
stack-trace: null
---

# bug-001-draft-brief-over-restrains-portfolio-briefs: /draft-brief flattens portfolio / agency / studio briefs with one-size-fits-all restraint boilerplate

## Bug Description

`/draft-brief` translates a freeform proposal into a structured `brief.md`. The current skill body emits restraint boilerplate uniformly across all brief classes — including portfolio / agency / studio / creative-service / designer-personal-site / boutique-hotel / restaurant / fashion-house / gallery sites where the design itself IS the value proposition.

**Expected behavior** — For projects where the site is the proof of work, `/draft-brief` should emit ambition-encouraging directional principles ("Embrace visual ambition — the site IS the proof of work. Show distinctive typography, story-driven motion, full-bleed imagery, signature visual motifs.") and skip the SaaS-grade restraint clauses.

**Actual behavior** — `/draft-brief` emits restraint clauses regardless of brief class. Concretely, P3 `projects/test-app/brief.md` §1 directional principles include:

> **"Prefer plain typographic confidence over agency tropes. No parallax hijacking, no cursor-follow gimmicks, no 'we're disruptive' copy."**

…for what is supposed to be a creative agency's portfolio site, where agency tropes ARE the proof of work. The ui-designer then correctly reads the brief, self-restrains accordingly, and produces flat brand-safe output. Confirmed empirically in `investigate-001`:

| Output                         | P2 brief (organic-authored, ambition-allowing)                            | P3 brief (/draft-brief, restraint-clauses)                                                          |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `home.html` line count         | 1,616                                                                     | 771                                                                                                 |
| Inline `<style>` blocks        | 1 (marquee scroll + grain noise overlay)                                  | 0                                                                                                   |
| `<svg>` count                  | 28                                                                        | 11                                                                                                  |
| Hero treatment                 | full-bleed h-[100vh] photo + grain + 88px display + italic "Real." accent | 4:5 aspect ratio thumbnail-card + 5xl heading + generic "Editorial · 47 projects · est. 2003" badge |
| Marquee partner-roster section | preserved                                                                 | absent                                                                                              |
| Operator score                 | "rich, brand-aligned, comparable to gulia reference"                      | "1/10 — fundamentally off vs the mockup"                                                            |

The bug is in `/draft-brief`'s lack of brief-class awareness — every proposal gets SaaS-grade restraint regardless of whether it's a Stripe-style B2B SaaS or a portfolio site whose entire purpose is to look exceptional.

## Reproduction Steps

1. Stage a Hatch-class proposal at `projects/<slug>/proposals/proposal.md` (the agency description that produced both P2 and P3 briefs is the canonical reproduction case — same proposal landed correctly-styled in P2 and over-restrained in P3).
2. Run `/draft-brief` against the proposal.
3. Inspect the output `brief.md` §1 "Vision & Principles" directional-principles bullets + §2 "Visual Design Requirements" body.
4. **Observe**: restraint phrasing present despite the proposal being for a portfolio-class project. Concrete trigger phrases that should NOT appear in portfolio briefs:
   - "Prefer plain typographic confidence over agency tropes"
   - "No parallax hijacking, no cursor-follow gimmicks"
   - "no 'we're disruptive' copy"
   - "Prefer fast first paint over heavy interactivity" (when interactivity IS the proof point)
   - "Color: restrained palette — neutrals plus one accent" (when the brand actually has a vivid palette)
5. **Compare** against `agentflow_phase2/projects/test-app/brief.md` for the same proposal — note absence of restraint boilerplate; presence of ambition-encouraging language ("strong typography, generous whitespace, full-bleed imagery, motion that supports story", "egg/emergence motif — curved shapes, hatching/cracking texture treatment").

## Error Output

No runtime error. The brief is structurally valid (passes `/validate-brief`) — it's the CONTENT that's wrong. The downstream regression surface that surfaces the bug is `/screens` quality (see investigate-001).

```
N/A — semantic regression, not a runtime error.
```

## Root Cause Analysis

(To be populated during implementation; preliminary read below.)

Preliminary hypothesis from `investigate-001`:

`.claude/skills/draft-brief/SKILL.md` does not detect brief class. Its prompt-construction templates apply SaaS-grade restraint defaults to every brief regardless of whether the project category is "site-as-portfolio" (design IS the product) vs "site-as-utility" (design SUPPORTS the product). The result is a brief whose §1 + §2 actively suppress the very characteristics a portfolio brief should celebrate.

Implementation likely needs to:

1. Add a brief-class detection pass at the start of `/draft-brief`, classifying the input proposal into one of N brief classes (working draft: `site-as-portfolio` / `b2b-saas` / `consumer-utility` / `internal-tool` / `marketplace` / `content-publication` / `learning-platform` / `…`).
2. Branch the §1 + §2 template emission on detected class.
3. Carry the class forward into `brief.md` frontmatter as `brief-class: <slug>` so downstream skills (ui-designer / mockups / stylesheet / screens) can read it.

The actual root-cause inspection needs to read the current `draft-brief/SKILL.md` body to confirm the restraint phrases are baked-in template text vs LLM-improvised. If they're baked-in template text, the fix is template-level. If they're LLM-improvised under prompt guidance, the fix is prompt-level guidance about ambition-encouragement for portfolio class.

## Fix Approach

(To be finalized after root-cause inspection.)

Preliminary scope:

1. **Brief-class taxonomy** — Define a closed set of brief classes in `schemas/brief-class-taxonomy.json` (working set: `site-as-portfolio`, `b2b-saas`, `consumer-utility`, `internal-tool`, `marketplace`, `content-publication`, `learning-platform`, `fintech`, `health`, `e-commerce`, `community-social`). Each entry carries: slug, description, examples, visual-ambition-default (one of `embrace` / `balanced` / `restrained`), one-paragraph "what this class needs from the design".
2. **Detection pass in /draft-brief** — Add a classification step at the start of /draft-brief that reads the proposal and emits a class slug with confidence. Multi-class proposals (e.g. "agency that also sells a SaaS product") pick the dominant class for the SITE being built; emit the secondary class as a brief.md frontmatter hint.
3. **Class-aware §1 + §2 templates** — `draft-brief/SKILL.md` gets a per-class template branch for the Vision & Principles + Visual Design Requirements sections. The `site-as-portfolio` branch:
   - Replaces "Prefer plain typographic confidence over agency tropes" with "Embrace distinctive typography — the site IS the proof of work"
   - Replaces "No parallax hijacking, no cursor-follow gimmicks" with "Use motion that supports story — scroll-cued reveals, full-bleed photo crossfades, signature visual motifs the brand can own"
   - Replaces "Color: restrained palette — neutrals plus one accent" with "Color: confident palette extracted from the brand's existing identity; if missing, propose a palette that matches the brand voice"
   - Adds an "Visual Signature" principle prompting the agent to invent a recurring visual motif (egg-crack texture for Hatch, etc.)
4. **brief.md frontmatter additions** — Add `brief-class: <slug>` (required) + optionally `brief-class-secondary: <slug>` to `schemas/brief-frontmatter.schema.json`. Existing briefs without the field get a `brief-class: legacy-uncategorized` migration value.
5. **brief-template.md update** — The template's placeholder brief gains a class declaration + class-appropriate placeholder content.
6. **Downstream propagation** — ui-designer's dispatch context (via stage-runner.ts → invoke-agent.ts) should surface `brief-class` so /mockups + /stylesheet + /screens can adapt their default doctrines.

The minimum-viable fix (Phase A) is just classes 1 + 2 + 3 — taxonomy + detection + class-aware templates. Frontmatter + propagation are Phase B improvements. Acceptance criteria below cover Phase A.

## Rejected Fixes

- **Fix A — Strip ALL restraint language from /draft-brief unconditionally.**
  Rejected because: restraint clauses are CORRECT for SaaS / utility / dashboard briefs where the design should support the product without competing with it. Stripping them would push the regression in the opposite direction — agency-y output on briefs that genuinely want clean restraint. The bug is one-size-fits-all, not the existence of restraint.

- **Fix B — Let operator manually edit the brief to remove restraint clauses post-/draft-brief.**
  Rejected because: same reason as feat-001 Rejected Alternative D — the factory's value proposition is "spec → working app, without operator hand-holding". The operator authoring the proposal shouldn't need to know which boilerplate lines to delete from a generated brief. Detection should be automatic.

- **Fix C — Have ui-designer ignore restraint clauses in the brief.**
  Rejected because: the brief is canonical per CLAUDE.md hard rules ("brief.md at project root is canonical specification… Never ask the user for information that is in the brief"). If the brief says "no agency tropes", the agent MUST honor it. The fix is in brief authoring, not in agent disobedience.

- **Fix D — Defer the fix to an ADR; the regression isn't blocking.**
  Rejected because: the operator empirically scored the resulting output 1/10 vs their Phase-2 baseline. The factory ships generated apps; the design-stage quality is the product. An ADR without a code fix is permission to keep shipping mediocre output. Same rationale as feat-001 Rejected Alternative C.

## Validation Criteria

**Empirical reproduction case** — same proposal as `projects/test-app` (Hatch agency description). Manual operator-confirmed source of truth.

**Pass conditions:**

1. Re-running `/draft-brief` on the Hatch-class proposal produces a `brief.md` whose §1 directional principles **does NOT contain** any of these phrases (case-insensitive substring):
   - "agency tropes"
   - "cursor-follow gimmicks"
   - "parallax hijacking"
   - "we're disruptive"
   - "restrained palette" (UNLESS the proposal explicitly requests restraint)
2. Re-running `/draft-brief` on the same proposal produces a `brief.md` whose §1 or §2 **DOES contain** ambition-encouragement language matching at least one of these patterns:
   - "embrace visual ambition" / "visual ambition" / "distinctive typography"
   - "signature visual motif" / "visual signature" / "brand motif"
   - "story-driven motion" / "scroll-cued reveals" / "motion that supports story"
3. The resulting `brief.md` frontmatter contains `brief-class: site-as-portfolio` (Phase B; not blocking Phase A acceptance if frontmatter not yet wired).
4. Negative-regression test — feeding a B2B SaaS proposal (`agentflow_phase2/projects/test-app/` once a SaaS proposal lands, OR a synthetic stripe-style proposal) to /draft-brief still emits the appropriate restraint clauses (or at least preserves them for that class). Restraint defaults are not removed wholesale — just suppressed for portfolio class.
5. Downstream check: after re-running `/draft-brief` + the existing `/mockups` + `/stylesheet` + `/screens` chain (with feat-001 changes also landed if available, otherwise current /screens) on the Hatch proposal, the resulting `docs/screens/webapp/home.html` is materially richer than the current P3 output. Heuristic metric: home.html ≥ 1,200 lines, ≥ 1 inline `<style>` block with custom CSS, ≥ 20 `<svg>` blocks, ≥ 1 full-bleed photo hero. (These thresholds are calibrated against the P2 1,616-line / 28-svg baseline.)

**Cross-references:**

- Pairs naturally with `feat-001-stylesheet-component-shapes` — feat-001 fixes the kit (Button gets the right shape; Nav primitive exists), bug-001 fixes the brief (ui-designer is given license to use ambition). Either one alone improves the output; both landed together restore P2-grade quality.
- May want a follow-up `/plan-investigation` for "what brief classes exist + what each class's design-default doctrine should be" — taxonomy design is its own piece of work; Phase A here just lands a starter set.

## Attempt Log

<!-- Populated automatically by agents. -->
