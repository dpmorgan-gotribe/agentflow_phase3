---
name: stack-skill-template
description: Template for authoring per-stack prompt packs. Copy this file to .claude/skills/agents/{tier}/{stack-slug}/SKILL.md and fill every section. Do not ship the _template directory to projects.
stack_tier: none
stack_slug: _template
maturity: template
---

# Stack-skill template

Per-stack skills live at `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md` where:

- `tier` ∈ `front-end` | `back-end` | `mobile`
- `stack-slug` is the exact value that appears in `architecture.yaml.tooling.stack.*` (e.g. `react-next`, `python-fastapi`)

Builders dispatch at runtime by reading `architecture.yaml.tooling.stack.<slot>` and loading the matching SKILL.md into their composition prompt. The skill is therefore a **prompt pack**, not a slash-command skill — it's consumed verbatim by the invoking builder, not invoked directly.

## Frontmatter contract

Every stack-skill SKILL.md must have frontmatter:

```yaml
---
name: <stack-slug> # must match the directory name
description: <one sentence — what this pack teaches the builder>
stack_tier: front-end | back-end | mobile
stack_slug: <same as name>
maturity:
  shipped | draft | experimental # shipped = factory-authored + human-reviewed;
  # draft = /skills-audit auto-research;
  # experimental = try-at-your-own-risk
authoredAt: <ISO-8601 date>
dependencyPinsRefreshedAt: <ISO-8601 date> # last time §Dependency pins was reviewed
---
```

## Required sections (in order)

### 1. Canonical layout

Show the directory structure a builder should produce inside the feature worktree. Use the same tree syntax as `/new-project` SKILL.md. Be concrete — name real files (routes, entrypoints, config), not placeholders.

### 2. Idioms

5-10 bullet points naming the stack's preferred patterns. Each bullet is a one-liner. Examples: "Use server components by default; opt into `"use client"` only where interactivity is required." / "Prefer tRPC input + output Zod schemas over manual TypeScript types." / "Every SvelteKit route file co-locates `+page.svelte` + `+page.server.ts`."

### 3. Testing

Mandatory block — binds to `feat-004-builder-tdd-hybrid`. Cover:

- **Test-file naming convention**: the exact relationship between a production file and its test sibling (e.g. `src/foo.ts` → `src/foo.test.ts`; or `src/foo/` directory → `src/foo/foo.test.ts`).
- **Test runner command**: the single canonical command for running one file's tests (`pnpm vitest run <file>`, `pytest path/to/test.py`, etc.).
- **Mocking patterns**: how this stack mocks its most common external dep (db, http, clock).
- **Minimum coverage expectation**: "builder happy-path coverage: 60% line; tester edge-case + integration + E2E raises total to 80%." (This matches the cross-stack policy in `.claude/rules/testing-policy.md` — restate here for context.)
- **One example test** showing the arrange / act / assert shape in this stack's idiom. Not a full suite — just the pattern.

### 4. Commands

Every command the builder runs in self-verify, plus the dev-loop commands humans use. Stack-skills MUST provide at least `lint`, `typecheck`, `test`, `build`. Include `dev` if applicable. Format:

```
lint:      <exact command>
typecheck: <exact command>
test:      <exact command>
build:     <exact command>
dev:       <exact command>
```

Builders run `lint && typecheck && test` as a self-verify gate. Failure there retries up to 2× before escalating.

### 5. Gotchas

Concrete failure modes this stack commonly exhibits, and how to sidestep them. Each bullet names the symptom + the fix. Examples for react-next: "Hydration mismatch when using `Date.now()` in a client component — hoist into `useEffect` or use `next/dynamic` with `ssr: false`." Examples for python-fastapi: "Circular imports between `models.py` and `schemas.py` — split into `models/` package with lazy references via `TYPE_CHECKING`."

### 6. Review

Stack-specific checks the **reviewer** agent runs IN ADDITION to `docs/reviewer-playbook.md`'s generic 7 dimensions. Builder-facing guidance lives in §Gotchas + §Anti-patterns above; this section is reviewer-facing pass/fail criteria.

Format per check:

```
#### <dimension> — <concern>
Invocation:  <exact grep or command>
Threshold:   <pass/fail rule>
Retry target: <backend-builder | web-frontend-builder | mobile-frontend-builder>
Playbook §:  <which generic dimension this augments, e.g. "§1 architecture" or "§6 performance">
```

Each stack skill MUST ship ≥3 stack-specific checks in this section. The reviewer loads this block verbatim via `.claude/skills/reviewer/SKILL.md` step 2 (filter-then-load). Missing block → reviewer emits `stack-review-block-missing: <slug>` warning and falls back to the generic playbook only.

### 7. Dependency pins

Exact versions for everything the builder should install + why. Pin major version at minimum; pin exact patch for anything known-flaky. Include a `dependencyPinsRefreshedAt` date in frontmatter — if the date is older than 90 days, `/skills-audit --scope=build` flags the skill for refresh.

Format:

```
@repo/* workspace:*
<runtime>    <version>     # why pinned
<framework>  <version>     # why pinned
<orm>        <version>     # why pinned
<test-lib>   <version>     # why pinned
```

### 7. Anti-patterns

Things a builder might do in this stack that it should NOT. One-liners with the reason. Examples: "Never `useEffect`-fetch in a server component — use RSC data-fetch or move to client." "Never synchronous-await a transaction inside a request handler without `async def` — FastAPI will block the event loop."

### 8. References

Links + short citations:

- Official docs (one or two primary links)
- Canonical community patterns (e.g. "Lee Robinson's Next.js App Router patterns", "Drizzle's ts-lang relational queries guide")
- The factory blueprint section, if relevant (e.g. "§17 blueprint Appendix E — stack-skill shelf")

## What stack-skills do NOT contain

- **Component specifications** — those live in `@repo/ui-kit` (tokens, primitives, patterns, layouts). Stack skills assume the kit is present; they teach HOW to consume it in their stack, not WHAT to build.
- **Business logic** — stack-skills are generic across projects. Project-specific content lives in `brief.md` + `architecture.yaml` + `docs/requirements.md`.
- **Integration-specific guidance** — that's the vendor-skill tier (e.g. `.claude/skills/stripe-connect/SKILL.md`). Stack-skills assume vendor skills are loaded separately via `architecture.yaml.tooling.skills.build[]`.
- **CSS tokens / palette values** — the winning style at `docs/selected-style.json` + `packages/ui-kit/src/tokens/tokens.json` drive these; stack skills use them via `var(--color-*)` references but don't define them.

## Maturity levels

- **shipped** — human-reviewed, factory-maintained. These are the default backbone (react-next, svelte-kit, node-trpc-nest, python-fastapi, expo-rn in feat-002's initial drop).
- **draft** — auto-researched by `/skills-audit --scope=build` when architect picks a stack-slug whose SKILL.md isn't shipped. Requires human review before first production use; the skills-audit emits a TODO marker in the skill body until reviewed.
- **experimental** — shipped but lightly validated. Use at own risk; may have incomplete gotchas / anti-patterns / dependency pins.

## Discovery

`/skills-audit --scope=build` (task 038) reads `architecture.yaml.tooling.stack.*`, resolves each slot to a directory under `.claude/skills/agents/`, and either:

- Confirms the SKILL.md is present + recent (`dependencyPinsRefreshedAt` <90 days old) → nothing to do
- Finds the SKILL.md missing → with `--auto-author-stack-skills`, researches via WebSearch + writes a `draft` maturity skill for human review; without the flag, aborts with a message pointing here
- Finds the SKILL.md stale (>90 days) → flags for refresh with a warning (does not block)

See `scaffolding/23-038-skills-agent.md` for the full discovery logic.
