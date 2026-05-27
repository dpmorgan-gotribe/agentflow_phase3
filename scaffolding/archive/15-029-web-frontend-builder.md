---
task-id: "029"
title: "Web Frontend Builder Agent"
status: pending
priority: P2
tier: 7 — Build Pipeline
depends-on: ["020", "027", "022b", "024", "025", "028"]
estimated-scope: medium
---

# 029: Web Frontend Builder Agent

## What This Task Produces

1. Agent definition at `.claude/agents/web-frontend-builder.md`
2. Skill at `.claude/skills/build-web-frontend/SKILL.md`

Both are locked to the **UI Kit consumption contract** (task 022b). The builder translates the signed-off HTML screens in `docs/screens/` into production Next.js pages that import exclusively from `@repo/ui-kit`.

## Why This Scope (per refactor-001 + feat-002)

Four concrete changes from the prior spec:

1. **Stack-agnostic dispatcher (feat-002).** The builder is now STACK-AGNOSTIC. It reads `architecture.yaml.tooling.stack.web_framework` and loads `.claude/skills/agents/front-end/{stack-slug}/SKILL.md` verbatim into its prompt. The stack skill provides framework-specific canonical layout, idioms, testing recipe, commands, gotchas. The builder itself never hardcodes `Next.js` vs `SvelteKit` vs `Remix`. Initial shipped stacks: `react-next`, `svelte-kit`. Others auto-authored via `/skills-audit --scope=build --auto-author-stack-skills`.
2. **Kit-only imports enforced mechanically.** The builder embeds `packages/ui-kit/CONTRACT.md` in its system prompt verbatim AND runs `pnpm ui-kit:validate-consumer` against its output before reporting success. Any violation fails the build. **For non-React stacks** (Svelte / Vue / Solid): the kit exports CSS tokens + global styles + `data-kit-*` attribute contract; the stack skill provides the local Svelte / Vue / Solid primitive implementations that match the kit's visual + attribute contract (per `packages/ui-kit/CONTRACT.md` Rule 4).
3. **shadcn/ui dropped from the stated stack.** The UI Kit IS our component library; shadcn was the old spec's fallback for primitives we didn't have. The new kit has ≥20 primitives + ≥12 patterns + ≥5 layouts by construction (task 024).
4. **Kit version pinned and verified.** The builder reads `packages/ui-kit/package.json.version` and asserts it matches `docs/signoff-{timestamp}.json.uiKitVersion`. If they differ, the build aborts — sign-off is tied to a specific kit release (task 025).

## Scope

### Agent Definition

```yaml
---
name: web-frontend-builder
description: Stack-agnostic web frontend builder. Dispatches to the stack skill named in architecture.yaml.tooling.stack.web_framework. Translates docs/screens/**/*.html into components that consume @repo/ui-kit (React imports for react-* stacks; CSS+attribute contract for Svelte/Vue/Solid stacks). Runs ui-kit:validate-consumer post-generation; fails on any contract violation.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
permissionMode: acceptEdits
maxTurns: 40
skills: []
---
```

Note: `skills` frontmatter is empty — stack-specific skills (`react-patterns`, `nextjs-app-router`, `svelte-runes`, etc.) live in the DISPATCHED stack skill's prompt pack, not in agent frontmatter. The kit owns Tailwind config; builders don't hand-author it.

### System Prompt — the UI Kit Contract (verbatim embed)

The agent's system prompt begins with the opening mandate, then embeds the CONTRACT.md content from `packages/ui-kit/CONTRACT.md` (factory template at `.claude/templates/ui-kit-contract.md`) verbatim. The contract's six numbered rules live in the prompt unaltered — any plugin or skill update doesn't change them.

```
You are a Senior web-frontend engineer. You translate signed-off HTML
screens into production code using the stack the architect picked. You
consume the project's UI Kit and nothing else for UI.

## Stack dispatch (feat-002)

Your stack choice is LOCKED by `architecture.yaml.tooling.stack.web_framework`.
Read that value at the start of your run. Load
`.claude/skills/agents/front-end/{stack-slug}/SKILL.md` verbatim — that
pack gives you:

- Canonical project layout (where files live)
- Framework idioms (server components, runes, signals, etc.)
- Testing recipe (test runner, mocking patterns, example test)
- Commands (lint / typecheck / test / build / dev — exact invocations)
- Gotchas + anti-patterns for this stack
- Dependency pins

**Do not hardcode Next.js assumptions in your output. Do not hardcode Svelte
assumptions. The stack skill IS your framework guide.** If the stack skill
disagrees with anything below, the stack skill wins.

## Kit consumption varies by stack

- **React stacks (react-next, remix, etc.)**: import components from
  `@repo/ui-kit` directly. Every kit primitive is exported as a React component.
- **Non-React stacks (svelte-kit, vue-nuxt, solid-start)**: the kit exports CSS
  (`@repo/ui-kit/globals.css`, `@repo/ui-kit/tokens.css`) + the `data-kit-*`
  attribute contract. The stack skill tells you how to author local components
  (e.g., `src/lib/components/Button.svelte`) that match the kit's visual + attribute
  contract. You preserve `data-kit-component` + `data-kit-variant` attributes so
  build-phase tooling (testID, e2e locators) still works.

## Common inputs (all stacks)

- @repo/types for shared Zod schemas and types
- @repo/api-client for tRPC client hooks
- TypeScript strict mode

## Your inputs

1. `docs/signoff-{latest}.json` — the approved sign-off. You pin its
   `uiKitVersion` and refuse to build if `packages/ui-kit/package.json.version`
   differs.
2. `docs/screens/webapp/*.html` and `docs/screens/admin/*.html` — the
   HTML previews you translate into JSX. Structure and composition are
   authoritative; Tailwind classes in the HTML are your guide to which
   kit variants to pass.
3. `docs/selected-style.json` — the approved style (for sanity-checking
   that accent/font references in the HTML match the kit).
4. `architecture.yaml` — apps.web and apps.admin sections for routing,
   auth, state management.
5. `packages/ui-kit/src/index.ts` — the ONLY import surface for UI.

--- BEGIN UI KIT CONTRACT (from packages/ui-kit/CONTRACT.md) ---
[verbatim inclusion of the six numbered rules + allowed escape hatches
 + enforcement section + "when rules conflict with reality" section
 from the contract]
--- END UI KIT CONTRACT ---

## Translation rules (HTML → JSX)

The `/screens` skill (task 025) emits **data attributes** on every HTML element
that corresponds to a kit primitive / pattern / layout. This is the deterministic
translation key — you read these attributes, NOT the Tailwind class string (which
is a derived output of CVA and not reliably invertible).

Attribute shape 025 emits:

  <button data-kit-component="Button"
          data-kit-variant="primary"
          data-kit-size="md"
          data-kit-props='{"disabled":false}'
          class="<CVA-derived Tailwind classes>">
    Save
  </button>

Your translation:

  <Button variant="primary" size="md">Save</Button>

Rules:

- Element with `data-kit-component="X"` → `<X>` imported from `@repo/ui-kit`
- Element with `data-kit-variant="Y"` → pass `variant="Y"` prop
- Element with `data-kit-size="Z"` → pass `size="Z"` prop
- Element with `data-kit-props='{"k":"v", ...}'` → spread the JSON as extra props
- Top-level element with `data-kit-layout="AppShell"` → wrap the whole screen in `<AppShell>`
- Text nodes and children that have no `data-kit-*` attributes transfer verbatim
- Remove ALL Tailwind class strings from the JSX — the kit component applies its own classes via CVA at runtime. The HTML's Tailwind was only for the preview render.
- If an HTML element has `data-kit-component` but your kit's barrel doesn't export that name, STOP and emit a kit-change-request (see below). Do NOT build it locally.
- If an HTML element has NO `data-kit-*` attributes (e.g., pure layout `<div>` wrappers for CSS grid/flex): keep as `<div>` with the same Tailwind utility classes (layout utilities are allowed per the kit contract rule 6).

## Post-generation enforcement

After writing each app's source, you MUST run:
  pnpm ui-kit:validate-consumer 'apps/web/{app,src}/**/*.{ts,tsx}'
  pnpm ui-kit:validate-consumer 'apps/admin/{app,src}/**/*.{ts,tsx}'
  pnpm --filter web typecheck
  pnpm --filter admin typecheck
  pnpm --filter web lint
  pnpm --filter admin lint

If any fail, fix and re-run. Do not report success with unresolved
violations.
```

### /build-web-frontend Skill

```yaml
---
name: build-web-frontend
description: Translate docs/screens/webapp and docs/screens/admin into Next.js apps. Enforces the UI Kit contract via validate-consumer + typecheck + lint.
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
argument-hint: "[--app web|admin|both]"
---
```

### Prerequisites

- `/screens` completed and `/user-flows-generator` sign-off received (`docs/signoff-{timestamp}.json` exists with `approved: true`)
- `packages/ui-kit/` populated by `/stylesheet` (24); version pinned in signoff
- `docs/screens/webapp/*.html` exists; `docs/screens/admin/*.html` exists if admin is in the target platform list
- `architecture.yaml.apps.web` and/or `apps.admin` blocks filled (produced by `/architect` post-signoff per refactor-003)
- **`.env` populated by user at gate 5** — refactor-003. Runtime public vars (e.g., `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`) get baked into the Next.js client bundle at `next build` time. The builder reads `.env` to know which public keys to wire into the build config. **Never wires `*_SECRET_KEY` or `*_SECRET` keys into the client bundle** — those are backend-only. Reviewer (task 032) scans built output for leaked secret-prefixed keys per its "no secrets in code" criterion. Missing required public keys surface at `next build` as loud failures.

### Steps

1. **Pin the kit version.** Identify the most recent `docs/signoff-*.json` (max ISO-8601 timestamp in filename; if multiple share a timestamp, highest mtime wins). Verify `approved === true`. Read `packages/ui-kit/package.json.version`. Abort if they differ — sign-off is bound to a specific kit release.
2. **Read architecture.yaml** apps.web and/or apps.admin sections (routing, auth strategy, state management, API base URL, env vars)
3. **Read the UI Kit barrel** `packages/ui-kit/src/index.ts` to enumerate what's available. Build an internal map of `{ className → component variant }` by reading each primitive's `.variants.ts` file — this is the HTML-to-JSX translation key.
4. **For each screen** in `docs/screens/webapp/**/*.html` and `docs/screens/admin/**/*.html`:
   a. Parse the HTML file
   b. Identify the top-level layout; pick the matching kit layout component
   c. Walk the HTML tree; replace recognized kit-matching elements with their React component forms
   d. Preserve content verbatim; only styling/structure swaps to components
   e. Emit as `apps/{app}/src/app/{route}/page.tsx` (Next.js 15 App Router convention)
   f. If an HTML construct can't be mapped, emit `docs/screens/kit-change-requests/{screen-id}.md` (same format as 025's kit-change-request) and HALT the build for that app. Orchestrator picks up the request.
5. **Wire the data layer**: generate tRPC client calls using `@repo/api-client` hooks; wire auth / session / loading / error states per architecture.yaml
6. **Configure Next.js**: `next.config.js`, `tailwind.config.ts` extending the kit's preset, `postcss.config.js`, `tsconfig.json` extending `@repo/tsconfig/nextjs.json`
7. **Root layout** (`apps/{app}/src/app/layout.tsx`): import `@repo/ui-kit/styles/globals.css`, set up providers (tRPC, theme)
8. **Run enforcement gate**:
   - `pnpm ui-kit:validate-consumer 'apps/web/{app,src}/**/*.{ts,tsx}'` (and admin)
   - `pnpm --filter web typecheck`
   - `pnpm --filter admin typecheck`
   - `pnpm --filter web lint`
   - `pnpm --filter admin lint`
   - If any fail, emit structured violations and retry with feedback (max 3 attempts); if still failing, flag for human review
9. **Report** — return JSON matching `BuildWebFrontendOutput` (task 034b)

### Kit-change-request handling (shared with 025) — post-sign-off is catastrophic

Hitting a missing primitive / pattern / variant at THIS stage is an **escalation signal, not a routine path**. By the time the builder runs, `/screens` (025) has already enumerated every primitive used across every screen and emitted kit-change-requests as needed; the kit has already been bumped, re-run through /stylesheet, and the sign-off binds a specific kit version. A kit-change-request triggered by the builder means one of:

1. `/screens` missed a primitive during its own enumeration (bug in 025)
2. The kit was manually reverted between sign-off and build
3. A `data-kit-component` attribute in the HTML references a name that doesn't exist in the current kit's barrel

If it happens anyway:

1. Emit `docs/screens/kit-change-requests/{screen-id}.md` with:
   - Which primitive / pattern / variant is missing
   - The HTML snippet that would need it
   - Suggested API shape (prop names, variant values)
2. HALT the build for the affected app
3. The orchestrator (035) escalates: this invalidates the existing sign-off (the kit would bump to a new minor version, breaking `signoff.uiKitVersion`), so the pipeline re-enters `/screens → /visual-review → /user-flows-generator → sign-off` — a full design-pipeline restart. The human is notified with a red flag explaining the regression.

Builders never implement local workarounds.

### What NOT to do (negative scope — reinforces the contract)

- Do NOT install shadcn/ui, Radix UI, Material UI, Chakra, or any other component library. `@repo/ui-kit` is the component library.
- Do NOT author a `components/` directory inside `apps/web/` or `apps/admin/` for UI. The kit is authoritative.
- Do NOT write inline `className` with hex codes, arbitrary Tailwind values, or raw px.
- Do NOT deep-import `@repo/ui-kit/primitives/*` — the barrel `@repo/ui-kit` is the only surface.
- Do NOT generate `globals.css` inside `apps/`; the kit's `globals.css` is imported from the kit.

Any of these trigger validate-consumer errors or ESLint errors and block the build.

### Return JSON

```json
{
  "success": true,
  "appsBuilt": ["web", "admin"],
  "uiKitVersion": "1.0.0",
  "pagesGenerated": { "web": 48, "admin": 18 },
  "kitChangeRequests": [],
  "validateConsumerResult": { "web": "clean", "admin": "clean" },
  "typecheckResult": "pass",
  "lintResult": "pass",
  "retriesTriggered": 0,
  "warnings": []
}
```

### Runs in Parallel with Mobile

Web and mobile frontend builders run concurrently after `/stylesheet` + `/screens` + sign-off. They share the same kit version (pinned).

## Integration Points

- **Task 020** (Architect): produces `architecture.yaml.apps.web` + `apps.admin` — read here
- **Task 021** (PM agent): handles kit-change-requests flow when this builder halts
- **Task 022b** (UI Kit contract): CONTRACT.md embedded verbatim in system prompt; `validate-consumer.ts` runs post-generation; ESLint plugin's rules block violations at lint time
- **Task 024** (/stylesheet): produced `packages/ui-kit/` with CVA variants — this builder reads `.variants.ts` to build the HTML→JSX translation map
- **Task 025** (/screens): produced the HTML previews this builder translates; shares the kit-change-request flow
- **Task 027** (shared packages): scaffolded the workspace + `@repo/ui-kit` skeleton
- **Task 032** (Reviewer agent): asserts the builder's output passes the consumer contract at PR-review time
- **Task 034b** (schemas): `BuildWebFrontendOutput` schema covers the return JSON
- **Task 035** (orchestrator): invokes this skill in parallel with `/build-mobile-frontend`
- **Task 036** (HITL gates): sign-off verification — the builder fails if signoff.uiKitVersion ≠ kit's current version

## Acceptance Criteria

- [ ] `.claude/agents/web-frontend-builder.md` exists with STACK-AGNOSTIC frontmatter (`skills: []`) — no hardcoded Next.js / React / Tailwind skill references
- [ ] Agent reads `architecture.yaml.tooling.stack.web_framework` and loads `.claude/skills/agents/front-end/{slug}/SKILL.md` verbatim
- [ ] Aborts cleanly if the referenced stack skill is missing (no silent fallback)
- [ ] System prompt embeds the CONTRACT.md verbatim (six rules + escape hatches + enforcement)
- [ ] System prompt drops shadcn/ui from the stated stack
- [ ] Framework-specific prose (Next.js routing patterns, Svelte runes, etc.) comes from the dispatched stack skill — NOT from the agent's own system prompt
- [ ] For non-React stacks (svelte-kit, vue-nuxt): agent authors local primitives matching the kit's `data-kit-*` attribute contract per the stack skill's guidance (kit's React exports not importable from those stacks)
- [ ] Skill runs `features[].tasks[]` filtered by `agent: web-frontend-builder` AND feature's `skip[]` does NOT include `web` (refactor-004 v2 tasks.yaml)
- [ ] Skill runs inside the feature's worktree at `.claude/worktrees/{features[i].worktree}/` (CWD handled by orchestrator per refactor-004)
- [ ] **feat-004 hybrid TDD**: builder generates happy-path sibling test file alongside every component / page / hook per the stack skill's §Testing pattern (e.g. `Button.tsx` → `Button.test.tsx` for react-next; `Button.svelte` → `Button.test.ts` for svelte-kit)
- [ ] **feat-004 coverage**: builder runs test command with coverage flag; asserts ≥ 60% line coverage on authored files per `.claude/rules/testing-policy.md`
- [ ] **feat-004 scope discipline**: builder does NOT write edge-case / E2E tests; those are tester's scope (Playwright specs at `apps/web/e2e/*.spec.ts` are tester-authored)
- [ ] Agent reads `.claude/rules/testing-policy.md` at dispatch time; testing-policy cross-reference in system prompt
- [ ] `.claude/skills/build-web-frontend/SKILL.md` exists
- [ ] Skill pins kit version from sign-off and aborts on mismatch
- [ ] Skill builds HTML→JSX translation map by reading each primitive's `.variants.ts`
- [ ] Skill emits `kit-change-request.md` and halts on unmappable HTML (does not build locally)
- [ ] Skill runs `pnpm ui-kit:validate-consumer` + typecheck + lint post-generation and fails on any violation
- [ ] Retry-with-feedback on enforcement failure (max 3 attempts)
- [ ] Root layout imports `@repo/ui-kit/styles/globals.css` (not a locally-authored globals.css)
- [ ] No `components/` directory created inside `apps/web/` or `apps/admin/` for UI
- [ ] No shadcn/radix/mui/chakra packages in `apps/*/package.json`
- [ ] Return JSON matches `BuildWebFrontendOutput` in 034b
- [ ] Runs in parallel with `/build-mobile-frontend`
- [ ] HTML → JSX translation uses `data-kit-*` attributes (emitted by 025), NOT pattern-matching on Tailwind class strings; Tailwind classes stripped from JSX output since the kit component applies its own via CVA
- [ ] Depends on 028 (backend) because `@repo/api-client` hooks are typed against the tRPC router 028 produces
- [ ] Post-sign-off kit-change-request is documented as an escalation signal (not a routine path), including the design-pipeline-restart consequence
- [ ] "Latest" sign-off file is identified by max ISO-8601 timestamp in filename (mtime tiebreaker)

## Human Verification

1. Run `/build-web-frontend` after a successful sign-off. Do `apps/web/` and `apps/admin/` get generated?
2. Does every `page.tsx` import from `@repo/ui-kit`? Run `grep -r "from ['\"]@repo/ui-kit" apps/web/src/ | wc -l` — non-zero?
3. Run `grep -rE "bg-\[#|from ['\"]shadcn|Radix" apps/web/src/`. Are there zero matches?
4. Hand-inject a raw hex in a generated page. Does `pnpm ui-kit:validate-consumer` catch it?
5. Bump `packages/ui-kit/package.json.version` from 1.0.0 to 1.1.0 between sign-off and build. Does the builder refuse to run?
6. Hand-inject an HTML screen that uses a component not in the kit. Does the builder emit a kit-change-request and halt rather than building locally?
7. Does `pnpm --filter web typecheck` pass on the generated code?
