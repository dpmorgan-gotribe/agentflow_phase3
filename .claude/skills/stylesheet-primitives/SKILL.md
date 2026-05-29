---
name: stylesheet-primitives
description: Generate React primitives + patterns + layouts + barrel + Storybook for the project's `architecture.yaml.tooling.stack.web_framework`. Auto-fires post-/architect; runs in parallel with gate-5 (credentials drop). Bound to the kit version produced by /stylesheet.
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: ""
---

# /stylesheet-primitives — React surface of the UI kit (stack-aware)

Post-architect sibling of `/stylesheet`. Picks up the kit where the agnostic-core skill left off (tokens, CSS, Tailwind config, preview-bootstrap, illustrations, `.components-plan.json`, stub `package.json`) and authors the React-specific surface: primitives, patterns, layouts, public barrel, full `package.json` with React peerDeps + Storybook devDeps, real 022b ESLint rules + `validate-consumer.ts`, and the Storybook build.

Per feat-074, this skill is **auto-fired by the orchestrator** when `/architect` completes. It runs in **parallel** with gate-5 (credentials drop). `/pm` waits for BOTH gate-5 resolved AND `/stylesheet-primitives` complete before generating `tasks.yaml`. This parallelization is the whole reason for splitting the original `/stylesheet`: each project saves ~30-60 min of wall-clock at the design→build transition.

## Auto-fire trigger (orchestrator-driven)

The orchestrator (feat-074 Phase E) dispatches this skill the moment `/architect` resolves. Concretely:

1. `/architect` completes → emits `.claude/architecture.yaml` + the rest of its outputs.
2. Orchestrator forks two parallel tasks:
   - **Task A:** Run this skill (`/stylesheet-primitives`) — produces React primitives + Storybook.
   - **Task B:** Open gate-5 (operator drops `.env` files + writes `docs/credentials-confirmed.txt`).
3. `/pm --mode=tasks` is gated on `BOTH(Task A succeeded, Task B resolved)`.

This skill MAY be invoked manually (operator runs `/stylesheet-primitives` directly) when re-authoring after a stack swap or after the operator hand-edits `architecture.yaml.tooling.stack.web_framework`. Manual invocation behaves identically to orchestrator-driven.

## Prerequisites

- `/architect` completed and `.claude/architecture.yaml` exists with a populated `tooling.stack.web_framework` slot.
- `/stylesheet` completed; the following agnostic-surface files exist:
  - `packages/ui-kit/src/tokens/tokens.json`
  - `packages/ui-kit/src/tokens/tokens.css`
  - `packages/ui-kit/src/tokens/tokens.ts`
  - `packages/ui-kit/src/styles/globals.css` (with `@tailwind base/components/utilities` directives)
  - `packages/ui-kit/src/styles/fonts.css`
  - `packages/ui-kit/src/styles/tailwind.config.ts`
  - `packages/ui-kit/src/styles/preview-bootstrap.html`
  - `packages/ui-kit/src/lib/cn.ts`, `cva.ts`, `motion.ts`
  - `packages/ui-kit/.components-plan.json`
  - `packages/ui-kit/package.json` (stub form — version `0.1.0-tokens-only`)
- Gate-3 signoff `docs/signoff-stylesheet-{timestamp}.json` MAY exist (if it does, its `componentsApproved[]` array gates which extended primitives are authored — see step 1.4 below). If absent, fall back to the canonical 12-primitive roster only.
- `pnpm` workspace healthy (`node_modules/` resolved at the monorepo root).

## Inputs (in order of authority)

1. `.claude/architecture.yaml` → `tooling.stack.web_framework`. Resolution: default `react-next` is the only v1-supported stack. See "Single-stack v1 caveat" in step 1.
2. `packages/ui-kit/src/tokens/tokens.json` → the source-of-truth token values used in `cva()` variant definitions + dial-derived styling.
3. `packages/ui-kit/src/styles/preview-bootstrap.html` → echoes the Tailwind theme; primitives' className strings must resolve against the same theme.
4. `packages/ui-kit/.components-plan.json` → the full generation plan (canonical primitives, patterns, layouts, custom patterns, plus `canonicalUnused[]`). Authoring is driven entirely by this plan.
5. `docs/signoff-stylesheet-{timestamp}.json` (latest by mtime) → `componentsApproved[]` gates extended primitives + custom patterns. If absent, default to canonical-only.
6. `docs/selected-style.json` → still authoritative for style-specific binding (radius, shadow, dark-mode hex).

## Single-stack v1 caveat

v1 supports `web_framework=react-next` ONLY. For other values, this skill returns early with:

```json
{
  "success": false,
  "error": "web_framework={slug} not yet supported — file /plan-feature for stack support",
  "kitVersion": "0.1.0-tokens-only",
  "primitivesShipped": []
}
```

This is documented at the very top of step 1 below. Future per-stack §primitive-authoring sections (feat-074 Phase C — deferred) will route to stack-specific authoring guides under `.claude/skills/agents/front-end/{stack-slug}/primitive-authoring.md`.

Stack-supported matrix today:

| `web_framework` slug | Status | Authoring guide             |
| -------------------- | ------ | --------------------------- |
| `react-next`         | ✓ v1   | This file's step 1 onward   |
| `solid-start`        | ✗      | feat-074 Phase C (deferred) |
| `svelte-kit`         | ✗      | feat-074 Phase C (deferred) |
| `vue-nuxt`           | ✗      | feat-074 Phase C (deferred) |

## Output contract

This skill adds the following to `packages/ui-kit/`:

```
packages/ui-kit/
├── package.json                # REWRITTEN — full form with React peerDeps + Storybook devDeps + validate-consumer script
├── CHANGELOG.md                # APPENDED — adds 0.2.0-primitives entry on success
├── UI-KIT.md                   # APPENDED — adds primitive-import examples
├── .input-fingerprint-primitives.json  # this skill's own fingerprint (complementary to /stylesheet's)
├── src/
│   ├── index.ts                # NEW — the PUBLIC BARREL (the only consumer import surface)
│   ├── primitives/             # NEW — ≥12 mandatory + on-demand extended
│   │   └── {kebab-name}/
│   │       ├── {kebab-name}.tsx
│   │       ├── {kebab-name}.variants.ts
│   │       ├── {kebab-name}.test.tsx
│   │       ├── {kebab-name}.stories.tsx
│   │       └── index.ts
│   ├── patterns/               # NEW — ≥12 canonical + N custom
│   │   ├── {kebab-name}/
│   │   │   └── ...same shape as primitives
│   │   └── custom/{PascalName}/
│   │       └── ...same shape
│   └── layouts/                # NEW — ≥5 canonical
│       └── {kebab-name}/
│           └── ...same shape
├── eslint-plugin/              # FILLED IN — real rules replacing the 022b stubs
│   └── rules/
│       ├── no-deep-imports.js
│       ├── no-hex-in-className.js
│       ├── no-arbitrary-tailwind.js
│       └── no-inline-style-tokens.js
├── scripts/
│   └── validate-consumer.ts    # FILLED IN — real grep-validator
├── .storybook/
│   ├── main.ts
│   └── preview.ts
└── storybook-static/           # BUILT — static Storybook output
```

The agnostic surface authored by `/stylesheet` (tokens, styles, lib, illustrations, icons) is consumed as-is — this skill does NOT regenerate it. If a re-run is needed after token changes, the operator re-runs `/stylesheet` first, then this skill picks up the new tokens.

## Orchestration: 4-Stage DAG (feat-002 — parallel fan-out)

Pre-feat-002, this skill dispatched ONE sequential ui-designer subagent to author the entire React surface (12 primitives + 12 patterns + 5 layouts + 022b artifacts + barrel + Storybook). Empirical wall-clock on test-app was ~3h 30m. Per feat-002, the work fans out across a 4-stage DAG that respects real dependencies + applies the bug-003 drift-mitigation playbook (shared preamble + verbatim-inline contract + post-batch audit + per-component retry) at each fan-out boundary.

The DAG (with target wall-clock at `concurrency=8`):

```
Stage 0 — Lib + agnostic verify + shared preamble assembly         (sequential, ~1 min)
   ↓
Stage 1 — Primitives fan-out (12 mandatory + N extended)           (parallel 8-wide, ~5-10 min)
   ↓
Stage 2 — Post-Stage-1 audit + per-component retry loop            (sequential, ~1-3 min)
   ↓ (gate: <12 mandatory = stage fails)
Stage 3 — Patterns + Layouts fan-out (12 canonical + N custom + 5) (parallel 8-wide, ~10-15 min)
   ↓
Stage 4 — Sequential tail (022b artifacts + barrel + package.json) (sequential, ~10-20 min)
   ↓
Stage 5 — Compile + test verification gate (Step 9)                (sequential, ~3-5 min)
```

**Total target wall-clock: ~30-45 min** at default `concurrency=8` (vs ~3h 30m sequential baseline).

### Concurrency knob (`.claude/models.yaml`)

```yaml
stages:
  stylesheet-primitives:
    concurrency: 8 # default — primitives + patterns fan-out width
    maxConcurrency: 16 # absolute cap
    burstDelay: 0 # ms between waves on rate-limit warnings
```

Operator may tune per-project. The orchestrator reads from `.claude/models.yaml` first, then `~/.claude/models.yaml` as fallback.

### Stage 0 — Lib + agnostic verify + shared preamble assembly

Sequential pre-flight. The invoker:

1. Verifies `packages/ui-kit/src/lib/cn.ts` + `cva.ts` + `motion.ts` exist (authored by `/stylesheet`).
2. Verifies `tokens.json` + `selected-style.json` + `.components-plan.json` exist.
3. **Pre-writes** `vitest.config.ts` + `vitest.setup.ts` + `tsconfig.json` BEFORE the fan-out (so every subagent sees the test harness ready).
4. **Pre-writes** the devDeps + peerDeps into `package.json` (full devDep list per §1a step 3) BEFORE the fan-out. Stage 4 will rewrite `package.json` with the full exports map; this step just lands the deps so subagent self-verify finds the harness installed.
5. Runs `pnpm install` to make the pre-written devDeps available to subagent test runs.
6. **Assembles `packages/ui-kit/.shared-preamble.md`** — the canonical "starting ink" every subagent receives identically. Sections:

   a. Authoring rules verbatim (copy of §1e — cn + cva, no raw hex, a11y, server/client defaults, test shape, `data-kit-*` contract)
   b. `data-kit-*` attribute contract verbatim (copy of §1b.1 — the feat-028 visual-parity contract)
   c. `tokens.json` content verbatim
   d. `selected-style.json` content verbatim
   e. `cn.ts` + `cva.ts` + `motion.ts` source verbatim (so subagents see canonical import patterns)
   f. Per-target 5-file shape contract + canonical naming + barrel format
   g. Canonical primitive marker table verbatim (copy of §1c roster)
   h. Canonical pattern marker table verbatim (copy of §2a roster)
   i. Canonical layout marker table verbatim (copy of §3 roster)
   j. **Cross-component consistency contract** — canonical relative imports (`from "../../lib/cn"` not `from "@repo/ui-kit/lib/cn"`); canonical test imports (`from "@testing-library/react"` + `import "@testing-library/jest-dom/vitest"`); canonical story imports (`from "@storybook/react"` per feat-002 fix-pattern 1); canonical PascalCase mapping; canonical `data-kit-component` hardcoded as string literal

   The preamble is the bug-003-style drift-mitigation primitive: agents see the bytes, agents reuse the bytes. Without it, n=12 parallel agents drift at the empirically-measured 75-86% rate.

### Stage 1 — Primitives fan-out

For each primitive in the mandatory 12 + extended N (gated by signoff `componentsApproved[]`):

1. Build the dispatch envelope: shared preamble (read at dispatch) + §1c row for THIS primitive (props/variants/style binding inlined) + target directory path + 5-file contract restated.
2. Dispatch via the Agent tool with `subagent_type=ui-designer`. **Concurrency: 8 (default)**. Wave-based — spawn 8, wait for all returns, spawn next 8.
3. Per-subagent self-verify (mirrors `/screens` anti-slop): all 5 files exist + .tsx exports the PascalCase function + root has `data-kit-component="<PascalName>"` literal + test asserts the attribute + no raw hex + `.variants.ts` calls `cva(`/`kitCva(`. Subagent retries internally once before returning `success: false`.
4. **Observability**: emit `primitive wave {N}: {W} completed · {T}/{TOTAL} total` after each wave.

### Stage 2 — Post-Stage-1 audit + retry loop

After Stage 1's final wave returns, invoke from project cwd:

```bash
node $FACTORY_ROOT/scripts/audit-ui-kit-component-consistency.mjs --tier primitives
```

The audit script (shipped by feat-002 alongside this SKILL.md) verifies 18 dimensions D-A through D-R per primitive (see `scripts/audit-ui-kit-component-consistency.mjs` header comment for the full table).

**Retry contract:**

1. For each primitive in `failedComponents[]`, re-dispatch a ui-designer subagent with `--component primitives/{kebab-name}` plus the audit's per-dimension findings as retry context. The retry prompt explicitly names the missing markers ("your `Button.tsx` root is missing `data-kit-component="Button"` — add the literal string, do not derive from a prop").
2. Max 2 retries per primitive. After 2 failures, mark `needsHumanReview`.
3. Once all primitives pass OR have hit max retries, advance to Stage 3.

**Hard abort** if <12 mandatory primitives pass (refactor-006 gate, owned by Stage 2). The existing Step 8 hard-gate count moves earlier — fires at end of Stage 2, blocks Stage 3.

### Stage 3 — Patterns + Layouts fan-out

Gated on Stage 2 passing. Identical mechanics to Stage 1, with:

- Roster = 12 canonical patterns (§2a) + N custom patterns (from `.components-plan.json.customPatternsGenerated[]`) + 5 canonical layouts (§3) + N extracted patterns (from `_extracted/*.html` translations).
- Per-component dispatch envelope adds a **"compose, don't atomize" reminder**: patterns import canonical primitives via `from "../../primitives/{primitive-name}"`; never inline an atomic.
- Post-fan-out audit runs `--tier patterns-and-layouts` with the additional dimensions D-L (pattern composes primitives), D-M (layout `data-kit-component`), D-N (custom patterns named in plan), D-R (HTMLAttributes title clash).

Same retry loop as Stage 2, max 2 retries per component.

### Stage 4 — Sequential tail (single agent)

Existing Steps 4 (022b artifacts) + 5 (barrel) + 6 (`package.json` full rewrite) + 7 (Storybook build) + 8 (finalize + bug-029 retrofit codemod + ≥12 primitives count gate). Runs as ONE agent since:

- The barrel `src/index.ts` needs the final list of all directories
- `package.json` rewrite is one file with the full exports map
- Storybook build is a single invocation
- The hard count gate has already fired at end of Stage 2

### Stage 5 — Compile + test verification gate

Step 9 (existing). Deterministic exit-0-required chain run after Stage 4. No LLM in the loop. See §"### 9. Compile + test verification gate" below for the full spec.

### Empirical contract

`/stylesheet-primitives` is COMPLETE iff:

1. All 4 fan-out + sequential stages have returned `success: true`
2. The Stage 2 + Stage 3 audits exit 0 (or the orchestrator marked `needsHumanReview` on max-retries-exhausted components — the return JSON's `failedComponents[]` array surfaces these)
3. The Stage 5 verify gate exits 0 across all 4 sub-gates (install + typecheck + test + build-storybook)

Reporting `success: true` without ALL THREE conditions is a contract violation (the empirical motivator for feat-002 in the first place).

## Steps

### 1. Generate primitives (12 core mandatory + 8 extended on-demand)

> **v1 supports `web_framework=react-next` only.** For other values, this skill emits `success: false` with the error message above. Future per-stack §primitive-authoring sections (feat-074 Phase C, deferred) will route to stack-specific authoring guides.

Primitives are the kit's non-negotiable React surface. **Historical gap (refactor-006):** before refactor-006 + the feat-074 split, this step said "generate ≥20" in the aspirational voice and six projects (hatch, gotribe-v1, mindapp, mindapp-v2, runclub, test-app) shipped tokens-only without a single primitive. Step 8's self-verify is a hard gate: <12 primitives = stage fails.

**Reference implementation:** hatch-2's `packages/ui-kit/src/primitives/` (shipped by feat-013, commit `b9e0d21`). Use its file layout + `cn`/`cva` utility pattern + variant shapes as the template. ~2100 LOC across 16 primitives + tests is the shipped benchmark.

#### 1a. Prerequisite files (author once, re-use across primitives)

The agnostic surface already wrote `src/lib/cn.ts` + `src/lib/cva.ts` + `src/lib/motion.ts`. This step verifies their presence and adds the React-test plumbing:

1. **`src/lib/cn.ts`** — verify exists with the canonical shape:

   ```ts
   import { clsx, type ClassValue } from "clsx";
   import { twMerge } from "tailwind-merge";
   export function cn(...inputs: ClassValue[]) {
     return twMerge(clsx(inputs));
   }
   ```

2. **`src/lib/cva.ts`** — verify exists with the CANONICAL passthrough shape (feat-002 fix-pattern 3 — DO NOT wrap cva with strict generics):

   ```ts
   import { cva, cx, type VariantProps } from "class-variance-authority";
   import type { ClassValue } from "clsx";
   export { cva, cx, type VariantProps };
   export type { ClassValue };
   // kitCva is a passthrough alias kept for future-swap convenience.
   // NEVER replace with a wrapper that adds generic constraints —
   // CVA's native `compoundVariants` typing rejects wrapped generics
   // (empirical case 2026-05-29 — see feat-002 fix-pattern 3).
   export const kitCva = cva;
   ```

3. **`package.json` runtime + dev deps** — step 6 below rewrites the stub form. Required dev/peer matrix (feat-002 fix-patterns 1 + 2):
   - **dependencies**: `class-variance-authority ^0.7.1`, `clsx ^2.1.1`, `tailwind-merge ^2.5.5` (already in the stub)
   - **peerDependencies**: `react >=18`, `react-dom >=18`
   - **devDependencies (mandatory — Stage 5 typecheck blocks without these)**:
     - `@testing-library/react ^16.1.0`, `@testing-library/jest-dom ^6.6.3`
     - `vitest ^2.1.8`, `jsdom ^25.0.1`
     - `@types/react ^19.0.2`, `@types/react-dom ^19.0.2`
     - `@storybook/react ^8.4.7` (types + runtime — REQUIRED, distinct from the framework adapter)
     - `@storybook/react-vite ^8.4.7` (framework adapter)
     - `@storybook/addon-essentials ^8.4.7`, `storybook ^8.4.7`
     - `tailwindcss ^3.4.0` (REQUIRED for the kit's own `tailwind.config.ts` typecheck; not just a consumer-side peer)
     - `tsx ^4.19.2`, `typescript ^5.6.0`

   Omitting `@storybook/react` causes every `.stories.tsx` to fail typecheck with `Cannot find module '@storybook/react'`. Omitting `tailwindcss` causes `styles/tailwind.config.ts` to fail with same shape.

4. **`vitest.config.ts` + `vitest.setup.ts`** — write jsdom environment + import `@testing-library/jest-dom/vitest` in setup. Set `esbuild.jsx: "automatic"` so React 19 + vitest JSX transforms work without `import React`.

5. **`tsconfig.json`** — extends the monorepo root with `"jsx": "react-jsx"`, `"moduleResolution": "bundler"`, `"resolveJsonModule": true`, and `"types": ["vitest/globals", "@testing-library/jest-dom"]`.

#### 1b. Per-primitive file layout (identical for every primitive)

```
packages/ui-kit/src/primitives/{kebab-name}/
├── {kebab-name}.tsx         # React component — uses cn() + cva-derived variants
├── {kebab-name}.variants.ts # cva() call — variant prop definitions (OPTIONAL for single-variant primitives like FormField)
├── {kebab-name}.test.tsx    # happy-path: 3-5 tests — renders, variants apply, a11y
├── {kebab-name}.stories.tsx # Storybook stories — one per primary variant
└── index.ts                 # export * from "./{kebab-name}"
```

Then `packages/ui-kit/src/primitives/index.ts` barrel re-exports every primitive directory's index.

#### 1b.1 Mandatory `data-kit-*` attribute forwarding (bug-029 — Phase 0 retrofit, automatic)

**Every primitive's root rendered element MUST forward these attributes**, with no exceptions:

```tsx
data-kit-component="{ComponentName}"   // PascalCase, matches the export name
data-kit-variant={variant}             // when the primitive has a `variant` prop
data-kit-size={size}                   // when the primitive has a `size` prop
data-kit-props={...}                   // serialized non-styling props (optional, advanced)
```

Pattern every primitive must follow:

```tsx
export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  // ...
}

export function Button({ variant, size, className, ...rest }: ButtonProps) {
  return (
    <button
      data-kit-component="Button"
      data-kit-variant={variant}
      data-kit-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
}
```

**Why mandatory**: feat-028 visual-parity-verifier extracts component identity by `data-kit-component` attribute. Without forwarding, the verifier reports the primitive as "missing" even when it renders fine — the diff is blind to attribute-less DOM nodes. Six projects pre-bug-029 shipped without retrofit; parity-verify Phase B (feat-035) reported 39+ false-positive "missing primitive" rows on the first run that hit them.

**Same rule applies to layouts** (`packages/ui-kit/src/layouts/{name}/{name}.tsx`) — `AppShell`, `AuthShell`, `MarketingShell`, etc. Layouts are kit-component too.

**Tests must assert presence**:

```tsx
test("forwards data-kit-component", () => {
  render(<Button>click</Button>);
  expect(screen.getByRole("button")).toHaveAttribute(
    "data-kit-component",
    "Button",
  );
});
```

This is also added to step 8's self-verify gate — primitives missing the attribute fail the stage.

#### 1c. Core mandatory roster (12 primitives — hard-gate by step 8)

The subagent MUST author a `.tsx` + `.test.tsx` for each of these 12. Skipping any fails the stage.

| Primitive     | Props / variants (minimum)                                                                                                                                                                                  | Style-specific binding from selected-style                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Button**    | `variant: primary \| secondary \| ghost \| destructive` × `size: sm \| md \| lg` + `iconOnly?: boolean` + `loading?: boolean` (sets `aria-busy`). Forwards ref; native `<button>` semantics.                | Radius from `tokens.radius.button` (style-4 → `rounded-full` pill; style-0 → `rounded-md`). Primary hover: if style declares `shadow.offsetHover` (style-4 riso overprint), emit `box-shadow: 4px 4px 0 var(--color-secondary-500)`. |
| **Input**     | `type: text \| email \| password \| number \| search \| tel \| url` + `hasError?: boolean` (sets `aria-invalid`). Forwards ref.                                                                             | Border `var(--color-border-default)`; focus ring `var(--color-accent-500)`. Radius from `tokens.radius.input` (usually matches Card — sharp for style-4).                                                                            |
| **Textarea**  | Same as Input + `rows?: number` + auto-resize option.                                                                                                                                                       | Same styling as Input.                                                                                                                                                                                                               |
| **Select**    | Native `<select>` with `appearance-none` + custom chevron SVG data-URI. Same `hasError` as Input.                                                                                                           | Chevron color = `var(--color-text-primary)`.                                                                                                                                                                                         |
| **Checkbox**  | `<input type="checkbox">` + custom box. Supports `indeterminate` ref-set.                                                                                                                                   | Checked fill = `var(--color-secondary-500)` (style-4) OR `var(--color-accent-500)` per style characteristic.                                                                                                                         |
| **Radio**     | `<input type="radio">` + custom circle. Same fill logic as Checkbox.                                                                                                                                        | Circular.                                                                                                                                                                                                                            |
| **Card**      | `interactive?: boolean` (hover elevates + translates), optional `CardHeader` / `CardBody` / `CardFooter` subcomponents.                                                                                     | Radius from `tokens.radius.card` (style-4 → `rounded-none` sharp corners — the characteristic).                                                                                                                                      |
| **Badge**     | `variant: default \| accent \| secondary \| highlight` × `size: sm \| md`.                                                                                                                                  | Pill (rounded-full) regardless of style. Text-xs uppercase tracking-wide.                                                                                                                                                            |
| **Avatar**    | `src?: string` + `alt?: string` + `initials?: string` (auto-computes from alt if absent) + `size: sm \| md \| lg`.                                                                                          | Square (no radius) — matches brutalist/riso aesthetics. Round only if style characteristic declares `avatar.round: true`.                                                                                                            |
| **Separator** | `orientation: horizontal \| vertical` + `emphasis: subtle \| default \| strong` → maps to `--color-border-{subtle,default,strong}`.                                                                         | —                                                                                                                                                                                                                                    |
| **Tabs**      | `<Tabs>` root + `<TabsList>` + `<TabsTrigger>` + `<TabsContent>`. `variant: underline \| pills`. Keyboard: ArrowLeft/Right/Up/Down/Home/End. `aria-selected` + `role="tab"`.                                | —                                                                                                                                                                                                                                    |
| **FormField** | Composite: `<label>` + child (Input/Textarea/Select) + optional `error?: string` + optional `hint?: string`. Uses React.cloneElement to inject `id`, `aria-describedby`, `aria-invalid` on the child input. | —                                                                                                                                                                                                                                    |

#### 1d. Extended roster (8 primitives — ship on-demand per signoff)

Author these ONLY IF the gate-3 signoff's `componentsApproved[]` names them (i.e., the analyst/previous stage flagged them as used). If not referenced, skip — don't silently author. Skipping an unreferenced extended primitive does NOT fail the stage.

| Primitive        | When to ship                                                          |
| ---------------- | --------------------------------------------------------------------- |
| **Breadcrumbs**  | when analyst observed breadcrumb navigation on any screen             |
| **EmptyState**   | when any screen has `empty-state` variant metadata                    |
| **PageHeader**   | when multi-section pages use a shared page-title + description block  |
| **Notification** | when the project has contact-form or transactional flows              |
| **Dialog**       | when any flow includes a modal confirmation                           |
| **Drawer**       | when mobile-first design implies slide-in nav                         |
| **Popover**      | when tooltip-rich or dropdown-menu UI is signed off                   |
| **Skeleton**     | when loading states are explicitly designed (most projects skip this) |

Primitives outside both rosters (Toast, Accordion, Slider, Switch, Tooltip) are authored only on explicit project demand and documented as "extended" in the kit's CHANGELOG.

#### 1e. Shared authoring rules (apply to every primitive)

- **Class composition via `cn()`** — never concatenate className strings by hand; never ad-hoc-switch variants via inline conditionals. Variants go through `cva()` in the companion `.variants.ts` file.
- **CVA boolean variants (feat-002 fix-pattern 4)** — when a primitive has a boolean-shaped variant (`iconOnly`, `interactive`, `loading`, etc.), use JS object keys `true` and `false` in the variants definition (which TS infers as string literals `"true"` / `"false"`), AND literal boolean values `true` / `false` (NOT strings) in `compoundVariants` array entries AND `defaultVariants`. This pairing works against the canonical `lib/cva.ts` passthrough (per §1a step 2). Example:
  ```ts
  variants: { iconOnly: { true: "aspect-square px-0", false: "" } },
  compoundVariants: [{ iconOnly: true, size: "sm", class: "w-9" }],
  defaultVariants: { iconOnly: false }
  ```
  Mixing strings with booleans causes 4-error type clusters that toggle between two shapes depending on the cva.ts wrapper — empirical case 2026-05-29 (Button + Card).
- **No raw hex or inline styles** — all colors via `var(--color-*)` through Tailwind token classes. Exception: inline `style={{ backgroundImage: "url(data:image/svg+xml;...)" }}` is acceptable for data-URI icons (custom Select chevron, Checkbox mark). Record these as `inline-style-tokens-exempt` in the returned warnings so 022b's ESLint exempts the specific file.
- **Accessibility minimums per primitive**: focus-visible ring (2px offset), ARIA role where semantic HTML doesn't provide it, keyboard navigation on composites (Tabs arrow keys; RadioGroup arrow keys), `aria-describedby` linkage between FormField and its error/hint, `aria-invalid` on error state, `aria-busy` on Button loading, `aria-current="page"` on Breadcrumbs terminal item.
- **Default to server components** — only add `"use client"` when the primitive NEEDS interactivity. Button/Input/Card/Badge/Avatar are server-safe. Tabs, Checkbox with ref-set-indeterminate, and FormField with dynamic error linkage need client. Flag in the primitive's JSDoc header so consumers know.
- **Tests per primitive**: at minimum 3 cases — renders with canonical props, applies variant-class changes, carries expected a11y attribute. Use `@testing-library/react` + `@testing-library/jest-dom` matchers. Mock `next/navigation` + external modules only at the app boundary, not in the kit.
- **Dark-mode support**: the kit's `tokens.css` defines a `.dark` selector block with the inverted palette. Primitives read CSS vars, so dark-mode works automatically — test does NOT need to exercise both modes; the visual-review stage handles that.
- **Version bump** — first successful primitive-shipping run bumps `package.json.version` from `0.1.0-tokens-only` to `0.2.0-primitives` (semver minor per "new primitive surface" per the versioning policy below).
- **`data-kit-*` attribute pass-through (feat-028 visual-parity contract — LOAD-BEARING)** — every primitive's root element MUST emit:
  - `data-kit-component="<Name>"` — hard-coded inside the primitive (e.g. `<button data-kit-component="Button" {...props}>`); never derived from a prop
  - `data-kit-variant={variant}` — forwarded from the primitive's `variant` prop (when present)
  - `data-kit-size={size}` — forwarded from the primitive's `size` prop (when present)
  - `data-kit-props={JSON.stringify(otherKitProps)}` — optional; emit only when the primitive accepts a non-trivial structural prop (`AppShell`'s `sidebar` slot, `Tabs`'s `orientation`) that the verifier should compare. Keep payloads small (under 200 chars).

  The visual-parity verifier (`/build-to-spec-verify`'s feat-028 stage) extracts these attributes from BOTH the mockup HTML and the rendered built page, then diffs the resulting kit-skeleton trees. Without the attributes, the differ has no structural signal and the verifier degrades to a no-op — every shipped project after feat-028 must preserve them.

  Per-primitive test should assert presence:

  ```tsx
  test("forwards data-kit-* attributes", () => {
    render(
      <Button variant="primary" size="md">
        Save
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("data-kit-component", "Button");
    expect(btn).toHaveAttribute("data-kit-variant", "primary");
    expect(btn).toHaveAttribute("data-kit-size", "md");
  });
  ```

  When extending the kit (kit-bump or follow-on primitive), preserve this contract — `/skills-audit --scope=build` will warn if a new primitive ships without the three core attributes.

#### 1f. Public barrel (`src/index.ts`) — see step 5 for the full shape

```ts
// Primitives (12 mandatory + any shipped extended)
export * from "./primitives/button";
export * from "./primitives/input";
// ... one line per primitive directory

// Utilities
export { cn } from "./lib/cn";
export { cva, cx, type VariantProps } from "./lib/cva";

// Runtime token access (the 022b-sanctioned escape hatch)
export { default as tokens } from "./tokens/tokens.json";
```

If the TS/Node version rejects direct JSON import, create `src/tokens/index.ts` that reads tokens.json via `import` with `resolveJsonModule: true` in tsconfig, then re-export. Feat-013's hatch-2 kit uses this workaround.

#### 1g. JSDOM gotchas (learned from feat-013)

- **Avatar with `src`** — outer `<span role="img">` + inner `<img>` both match `getByRole("img")`. Tests must disambiguate via `getByAltText()` for the inner img.
- **Select chevron data-URI** — JSDOM silently drops complex `style={{ backgroundImage: "url(data:image/svg+xml;...)" }}` values, which ALSO clears the entire inline style attribute. Don't test the URL directly; assert the companion `appearance-none` Tailwind class OR skip the test with a comment.
- **React 19 + vitest** — ensure `esbuild.jsx: "automatic"` in `vitest.config.ts` or JSX transforms to the classic runtime and tests fail with `ReferenceError: React is not defined`.

### 2. Generate patterns (minimum 12 canonical + N custom)

**Props-interface contract (feat-002 fix-pattern 5 — applies to every pattern AND every layout in §3):** when a pattern/layout declares a prop whose name collides with one of `React.HTMLAttributes<T>`'s native attributes — `title`, `color`, `placeholder`, `cite`, `data`, `defaultChecked`, `defaultValue`, `suppressContentEditableWarning`, `suppressHydrationWarning`, `dangerouslySetInnerHTML`, `key` — the props interface MUST `Omit` the colliding key from the extended `HTMLAttributes` type:

```ts
// ✓ correct — Hero accepts ReactNode for title
export interface HeroProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
  title: React.ReactNode;
  // ...other props
}

// ✗ wrong — clashes with HTMLAttributes's title?: string
export interface HeroProps extends React.HTMLAttributes<HTMLElement> {
  title: React.ReactNode; // TS2430: Types of property 'title' are incompatible
}
```

Empirical case 2026-05-29: `patterns/hero/hero.tsx` shipped without the `Omit`; Stage 5.2 typecheck blocked the kit. The fix is mechanical once the rule is named.

**2a. Canonical patterns.** Each pattern composes primitives (never reinvents atomics). Required:

| Pattern          | Composes                                                            |
| ---------------- | ------------------------------------------------------------------- |
| `EmptyState`     | Illustration slot + title + description + action Button             |
| `ErrorState`     | inline + full-page variants; recovery action required               |
| `DataTable`      | Table primitive + sort + selection + row skeleton states            |
| `FormField`      | Label + Input/Textarea/Select + helper + error; Zod schema optional |
| `PageHeader`     | Title + description + actions slot; breadcrumb slot                 |
| `Breadcrumbs`    | Separator-driven; accessible                                        |
| `SearchCombobox` | Input + Popover + keyboard nav                                      |
| `CommandPalette` | Keyboard-first overlay; inline actions; Cmd/Ctrl+K                  |
| `FileUploader`   | Drag-drop + file list + progress                                    |
| `FilterBar`      | Chip row + "Add filter" + active-filter summary                     |
| `Pagination`     | numbered + prev/next; responsive                                    |
| `Notification`   | Banner variant; actionable; dismissible                             |

**2b. Custom patterns (project-specific, per `.components-plan.json.customPatternsGenerated[]`).**

For each entry in the components plan's `customPatternsGenerated[]`, generate a custom pattern file tree at `src/patterns/custom/{name}/`:

```
src/patterns/custom/WalletBalance/
├── WalletBalance.tsx           # composes primitives (Card, Badge, Skeleton) to render the custom composition
├── WalletBalance.variants.ts   # CVA variants if the composition has multiple states
├── WalletBalance.stories.tsx   # Storybook story — MUST include: default / empty / loading / error states
└── index.ts
```

**Generation rules for custom patterns:**

1. **Compose — don't atomize.** A custom pattern composes canonical primitives. `WalletBalance` might use `Card` + `Badge` + `Skeleton`. `VoteButton` extends `Button` with a count indicator. Never redefine atomics inside a custom pattern.
2. **Infer from the analyst's component name + usage context.** `wallet-balance` implies a balance display — render with a monetary figure + token symbol + optional trend indicator. `chat-bubble` implies left/right message alignment with avatar. The generator uses the component name + brief context (§1 / §6 / §12) to choose the sensible composition. When ambiguous, produce a minimal working version and flag in `warnings[]` for human review at gate 3.
3. **Screen-count drives priority + polish.** High-traffic (≥20 screens) patterns get full variants + all 5 interaction states + dark-mode verified. Low-traffic (<5 screens) patterns get minimum-viable implementations (default state + one-line story).
4. **Match the selected style's characteristics.** If the style has a dark-mode-default (Style 3 Midnight Press pattern), custom patterns render correctly on that surface. If the dials say `visual_density: 8` (cockpit-dense), custom patterns use tight spacing defaults.

### 3. Generate layouts (minimum 5)

| Layout        | Shape                                                           |
| ------------- | --------------------------------------------------------------- |
| `AppShell`    | Sidebar + top bar + main; responsive (mobile: sidebar → drawer) |
| `SplitView`   | Master-detail; resizable; mobile stacks                         |
| `FocusedTask` | Single column, `max-w-prose`; centered reading surface          |
| `Marketing`   | Hero + sections + footer; no chrome                             |
| `Auth`        | Split-screen or centered card                                   |

Same `data-kit-*` attribute contract as primitives (per §1b.1) — layouts are kit-component too.

### 4. Fill in 022b artifacts

Skeletons were already placed inside `packages/ui-kit/` at `/new-project` step 5b. This step replaces the stubs with real implementations:

- **`packages/ui-kit/eslint-plugin/rules/*.js`** — real rule implementations for the four rules (`no-deep-imports`, `no-hex-in-className`, `no-arbitrary-tailwind`, `no-inline-style-tokens`)
- **`packages/ui-kit/scripts/validate-consumer.ts`** — real grep-validator replacing 027's exit-0 stub. Targets `apps/*/src/**/*.{ts,tsx,js,jsx}` (not the kit itself)
- **`packages/ui-kit/tsconfig.consumer.json`** — path aliases exposing only the public barrel (`@repo/ui-kit` → `./packages/ui-kit/src/index.ts`). No subpath wildcards
- **Do NOT touch** `packages/ui-kit/CONTRACT.md` — `/new-project` step 5b wrote it from the factory template; it's project-invariant and safe to leave alone across re-runs

### 5. Generate `src/index.ts` — the public barrel

The ONLY import surface for consumers. Exports:

- Every primitive (named export — `Button`, `Input`, `Textarea`, ...)
- Every pattern (named export — `EmptyState`, `ErrorState`, `DataTable`, ...)
- Every layout (named export — `AppShell`, `SplitView`, ...)
- The `tokens` object (escape-hatch runtime read; from `tokens.ts`)
- `cn`, `cva` utilities (from `lib/`)
- Icon named exports from `icons/index.ts`
- Nothing else — no internal paths re-exported, no wildcards beyond the icon barrel

### 6. Rewrite `package.json` (full form — replaces /stylesheet's stub)

```json
{
  "name": "@repo/ui-kit",
  "version": "0.2.0-primitives",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./styles/globals.css": "./src/styles/globals.css",
    "./styles/fonts.css": "./src/styles/fonts.css",
    "./styles/preview-bootstrap.html": "./src/styles/preview-bootstrap.html",
    "./tokens/tokens.json": "./src/tokens/tokens.json",
    "./tokens/tokens.css": "./src/tokens/tokens.css",
    "./eslint-plugin": "./eslint-plugin/index.js"
  },
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build -o storybook-static",
    "validate-consumer": "tsx scripts/validate-consumer.ts 'apps/*/src/**/*.{ts,tsx,js,jsx}'"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.5",
    "class-variance-authority": "^0.7.1"
  },
  "peerDependencies": { "react": ">=18", "react-dom": ">=18" },
  "devDependencies": { "@storybook/react-vite": "...", "...": "..." }
}
```

The `exports` field restricts subpath access to `./styles/*` + `./tokens/*` + `./eslint-plugin`. No other subpaths resolvable. Deep imports will fail at the module-resolution layer — enforced BEFORE the ESLint plugin fires, double-layered defense per 022b.

The version bump from `0.1.0-tokens-only` → `0.2.0-primitives` signals to consumers that the React surface has shipped. Subsequent re-runs of THIS skill follow normal semver:

- New primitive / new pattern / new layout / new variant → **minor** (`0.2.0` → `0.3.0`)
- Bug fix / illustration swap / story addition → **patch** (`0.2.0` → `0.2.1`)
- Token value change forced by an upstream `/stylesheet` re-run that also re-fires this skill → **major** (`0.2.0` → `1.0.0`)

### 7. Build Storybook

Run `pnpm build-storybook` via Bash. Static output lives at `packages/ui-kit/storybook-static/`. This is the **React surface visual contract** for builders + reviewers; it is NO LONGER reviewed at HITL gate 3 (per feat-074 — gate 3 was moved to HTML-preview-only in `/stylesheet` step 17).

If Storybook build fails, capture the error, write `docs/design-system-gaps.md` with the failure details, and emit return JSON with `success: false` + the error.

### 8. Finalize + verify (includes the ≥12-primitives hard gate)

- Append to `packages/ui-kit/CHANGELOG.md` — `0.2.0-primitives` release lists every primitive, pattern, layout shipped this run.
- Append to `packages/ui-kit/UI-KIT.md` — primitive-import examples (`import { Button } from "@repo/ui-kit";`), dark-mode toggle, dial-change impact summary.
- Write `packages/ui-kit/.input-fingerprint-primitives.json` — hash of `architecture.yaml.tooling.stack.web_framework` + `tokens.json` + `.components-plan.json` + `componentsApproved[]` from signoff (when present) + metadata (regeneration date, resolved-inputs summary).
- **Retrofit `data-kit-component` safety net (bug-029 — Phase B, automatic):**

  ```bash
  node scripts/retrofit-ui-kit-data-attrs.mjs .
  ```

  Run from the project root. The codemod walks `packages/ui-kit/src/{primitives,layouts}/**/*.tsx`, finds every exported component, and inserts `data-kit-component="<Name>"` on its first DOM-rendering JSX root if absent. It is **idempotent** — running on a kit that already conforms is a no-op. Capture the script's summary line in the return JSON's `warnings[]` if any rows report `applied=` (it means the LLM authoring step in §1b.1 missed at least one primitive — log it so the contract drift is observable, not silent). Edge case the script cannot auto-fix: components that render via `React.createElement(...)` instead of JSX — those are flagged as `no-jsx` and need manual attribute injection (rare; ~1% of generated primitives).

- Run `pnpm typecheck` in the monorepo
- Run `pnpm lint` against the kit (the ESLint plugin is disabled on kit internals via `overrides` per 022b — it applies to `apps/*` only)
- `validate-consumer` is NOT run against the kit itself — its purpose is to scan `apps/**`, which don't exist yet at this stage
- **Primitives-shipped HARD GATE (refactor-006)** — count non-test `.tsx` files under `packages/ui-kit/src/primitives/`:

  ```bash
  node scripts/verify-024.mjs --primitives-count
  # OR inline:
  find packages/ui-kit/src/primitives -maxdepth 3 -name '*.tsx' -not -name '*.test.tsx' 2>/dev/null | wc -l
  ```

  **Threshold: ≥12 core primitives** (the mandatory roster from step 1c). If below threshold, the stage **fails** — return `success: false` with abort-reason:

  ```
  primitives-shipped-gate-failed: authored N of 12 mandatory core primitives.
  Missing: [list-from-roster-minus-shipped].
  gate-3 componentsApproved[] cannot be approved until the core roster ships —
  downstream builders have no import surface. Re-author missing primitives then
  re-run /stylesheet-primitives.
  ```

  Orchestrator (035) retries via Layer 5 stage-level retry (up to 3 attempts). After exhaustion, human review via normal failed-stage escalation.

  **History (what this gate prevents):** before refactor-006, this was a soft warning. Six projects (hatch, gotribe-v1, mindapp, mindapp-v2, runclub, test-app) shipped tokens-only — hatch-2 surfaced the gap at build time when builders fell back to plain HTML + Tailwind. Bug-001 Layer B (feat-013) retro-shipped hatch-2's kit; refactor-006 closes the systemic hole. Feat-074 keeps the gate in this skill (the React-authoring lane) — it is the only place authoring can fail to ship the roster.

- Emit return JSON (include `primitivesShipped: string[]` — the kebab-names of every primitive directory under `src/primitives/`)

### 9. Compile + test verification gate (feat-002 Stage 5 — LOAD-BEARING)

Step 8 finalizes authoring + the primitives-count hard-gate. Step 9 is the **honest-complete gate**: a deterministic exit-0-required chain that catches the bug classes the audit cannot predict. Empirical motivator: the 2026-05-29 sequential run reported `success: true` and operator-manual `pnpm typecheck` immediately surfaced 5 compile-time bugs (see feat-002 `## Empirical fix patterns observed` for the catalogue). Without Step 9, the skill's "success" signal is a lie.

Run from the project root (the kit's package directory is targeted via pnpm filter):

```bash
# Step 9.1 — install workspace dependencies
# Required because Step 6 rewrote package.json with the full devDeps list
# (including @storybook/react + tailwindcss per §1a step 3). The pre-Step-6
# install pass did NOT see those entries.
pnpm install
# Exit 0 required. Non-zero → abort with structured error.

# Step 9.2 — TypeScript compile gate
pnpm --filter @repo/ui-kit typecheck
# Exit 0 required. Non-zero:
#   - Capture each `tsc` error line into the return JSON's errors[] field
#   - Mark `success: false`
#   - DO NOT retry the skill — TS errors are deterministic; retry would loop
#     unless the upstream authoring-rule (§1a/§1c/§2/§3) is fixed in SKILL.md.
#   - The most-common error classes are already named in §1a + §1c + §2:
#     missing devDep (§1a step 3), cva wrapper shape (§1a step 2),
#     CVA boolean variants (§1e), HTMLAttributes title clash (§2).
#     Reviewer at PR time should grep failure transcripts for these patterns.

# Step 9.3 — unit test gate
pnpm --filter @repo/ui-kit test
# Exit 0 required. Non-zero:
#   - Capture failing test names + counts into errors[]
#   - Mark `success: false`
#   - Per-test retry is the tester's job inside the kit (vitest's own retry).
#     Step 9.3 just enforces the all-pass gate.

# Step 9.4 — Storybook build gate (moved from Step 7 — also exit-0-required)
pnpm --filter @repo/ui-kit build-storybook
# Exit 0 required. Non-zero:
#   - Write docs/design-system-gaps.md with the build error
#   - Mark `success: false` (per existing §Error handling)
```

**Why Step 9 is separate from Step 8 finalize.** Step 8 is the LLM-authored "did we finish the React surface" check (count files, codemod retrofit, append CHANGELOG). Step 9 is a deterministic verify chain with no LLM in the loop. Conflating them masks the signal — a Step-8-passes / Step-9-fails return is unambiguously a compile-time bug class the audit didn't predict, which triggers an authoring-rule extension (the meta-lesson loop from bug-005). The two failure modes need distinct return shapes.

**Why no retry on TS errors.** The CVA boolean variant mismatch + the HTMLAttributes title clash + the missing devDep classes are all 100% deterministic — a retry without an upstream rule fix produces identical output. Per the retry policy (CLAUDE.md "Attempt 1-2: try different approaches"), `/stylesheet-primitives` returning `success: false` from Step 9 is an attempt-1 signal; the operator OR `/plan-investigation` decides whether the SKILL.md authoring rule needs extending OR whether the audit dimensions need a new D-X to catch the class at lower cost.

**Skip 9.1 on noChange short-circuit.** If `.input-fingerprint-primitives.json` matches at the top of Step 1 (idempotent re-run), Step 9 also short-circuits — install + typecheck + test + storybook are all assumed to have passed on the prior successful run since outputs are byte-identical.

**Cross-references for Step 9:**

- feat-002 plan §"Stage 5 — Compile + test verification gate"
- feat-002 plan §"Empirical fix patterns observed (2026-05-29 sequential run)" — the 5-bug catalogue Step 9 catches
- bug-005 sibling lesson — _"Derivation-based audits must fail-closed on empty contracts AND pair with hardcoded independent fallback assertions"_. Step 9 is the hardcoded fallback to the audit's vocabulary-derived checks.
- LESSONS.md candidate on close: _"`/stylesheet-primitives` reporting `success: true` is only as honest as its compile gate. `pnpm install + typecheck + test + build-storybook` as exit-0-required gates closes the 'authored but unverified' failure mode."_

## Re-run idempotency

Running `/stylesheet-primitives` twice with the same `architecture.yaml`, `tokens.json`, `.components-plan.json`, and `componentsApproved[]` must produce byte-identical primitives/patterns/layouts/barrel/Storybook output. Step 8's `.input-fingerprint-primitives.json` enables a no-op short-circuit at the very top of step 1 (read fingerprint, compare to current resolved inputs; if match AND `src/primitives/` exists AND `storybook-static/index.html` exists, return `{ noChange: true, success: true }`).

## Return JSON

```json
{
  "success": true,
  "kitVersion": "0.2.0-primitives",
  "webFramework": "react-next",
  "primitiveCount": 14,
  "patternCount": 13,
  "layoutCount": 5,
  "primitivesShipped": [
    "button",
    "input",
    "textarea",
    "select",
    "checkbox",
    "radio",
    "card",
    "badge",
    "avatar",
    "separator",
    "tabs",
    "form-field",
    "empty-state",
    "dialog"
  ],
  "patternsShipped": [
    "empty-state",
    "data-table",
    "form-field",
    "page-header",
    "breadcrumbs",
    "search-combobox",
    "command-palette",
    "file-uploader",
    "filter-bar",
    "pagination",
    "notification",
    "error-state",
    "wallet-balance"
  ],
  "layoutsShipped": [
    "app-shell",
    "split-view",
    "focused-task",
    "marketing",
    "auth"
  ],
  "storybookBuildPath": "packages/ui-kit/storybook-static/index.html",
  "barrelPath": "packages/ui-kit/src/index.ts",
  "packageJsonPath": "packages/ui-kit/package.json",
  "warnings": [],
  "errors": [],
  "cost": 0,
  "durationMs": 0,
  "noChange": false
}
```

The `cost` + `durationMs` fields are populated by the orchestrator-side wrapper (telemetry); leave 0 in the skill's emitted JSON. Matches the React-surface subset of `StylesheetOutput` in task 034b — merged with `/stylesheet`'s return JSON on the orchestrator side for downstream consumers.

## Error handling

- `architecture.yaml` missing → abort: "`/stylesheet-primitives` requires `.claude/architecture.yaml`. Run `/architect` first."
- `tooling.stack.web_framework` slot absent or unsupported → abort with `web_framework={slug} not yet supported`; emit `success: false`.
- `/stylesheet` outputs missing (tokens.json / globals.css / .components-plan.json absent) → abort: "`/stylesheet-primitives` requires `/stylesheet` to have completed. Re-run `/stylesheet` first."
- `pnpm build-storybook` fails → write `docs/design-system-gaps.md`, emit `{ success: false, ...errors }`; do NOT mark the kit version bumped.
- `pnpm typecheck` fails → abort; surface TypeScript errors in return JSON's `warnings[]` and set `success: false`.
- `package.json.exports` rewrite would allow deep imports → abort; the restricted exports are a load-bearing 022b invariant.
- Primitives-shipped hard gate fails (<12 mandatory) → abort per step 8; orchestrator retries up to 3 times.

## Integration Points

- **Task 022b** (UI Kit contract): real `eslint-plugin/rules/*.js` + `validate-consumer.ts` implementations land here (replacing /new-project step 5b's stubs).
- **Task 025** (`/screens`): does NOT depend on this skill — `/screens` writes HTML using only the agnostic surface from `/stylesheet`. This skill's outputs are consumed by builders + the Storybook build.
- **Task 028 / 029 / 030** (builders): consume the React surface authored here (`@repo/ui-kit` barrel imports).
- **Task 034b** (schemas): `StylesheetOutput` covers the union of `/stylesheet`'s + this skill's return JSONs.
- **Task 035** (orchestrator): auto-fires this skill post-architect (feat-074 Phase E) in parallel with gate-5.
- **Task 036** (HITL gates): gate-3 already closed (HTML-preview-only at `/stylesheet`); this skill runs AFTER gate-3 signoff is in place and reads `componentsApproved[]` from it.
- **feat-028** (visual-parity verifier): consumes `data-kit-*` attributes authored here (per §1b.1) to match built DOM against mockup DOM.
- **feat-074** (factory): the split that introduced this skill. See `plans/active/feat-074-stylesheet-split-and-parallelize.md`.
- **refactor-006** (≥12 primitive hard gate): this skill owns the gate (moved here from `/stylesheet`).
- **bug-029** (data-kit-component retrofit): codemod runs here at step 8.
- **bug-077** (PostCSS pipeline): unchanged — that contract lives in `/stylesheet`'s agnostic surface (globals.css `@tailwind` directives).
- **bug-091** (protected-files policy): this skill's outputs (`postcss.config.mjs` if any, the full `package.json`, etc.) are subject to the protected-files invariants. Bug-fixer and systemic-fixer dispatches MUST NOT delete them.

## Related skills / files

- `.claude/skills/stylesheet-primitives/SKILL.md` — this file
- `.claude/skills/stylesheet/SKILL.md` — sibling skill (agnostic core, pre-architect)
- `.claude/skills/screens/SKILL.md` — consumer of `/stylesheet`'s agnostic outputs (not this skill's React outputs)
- `.claude/skills/architect/SKILL.md` — upstream gate that decides `web_framework`
- `.claude/skills/pm/SKILL.md` — downstream gate that consumes both this skill's primitives + gate-5 credentials before generating tasks.yaml
- `.claude/agents/ui-designer.md` — the agent whose identity this skill embodies
- `.claude/templates/ui-kit-contract.md` — 022b factory template for `CONTRACT.md`
- `.claude/templates/ui-kit-tsconfig-consumer.json` — 022b factory template for path aliases
- `.claude/templates/ui-kit-validate-consumer.ts` — 022b factory template for the grep validator
- `.claude/templates/ui-kit-eslint-plugin/` — 022b factory templates for the four ESLint rules (filled in by step 4)
- `scaffolding/09-034b-output-contract-zod-schemas.md` — defines `StylesheetOutput` (covers this skill's return JSON)
- `scaffolding/21-035-orchestrator-core.md` — invokes this skill post-architect (feat-074 Phase E)
- `plans/active/feat-074-stylesheet-split-and-parallelize.md` — the plan that introduced this skill
- `plans/active/investigate-028-stylesheet-split.md` — the parent investigation that motivated feat-074

## Acceptance criteria

- [ ] `.claude/skills/stylesheet-primitives/SKILL.md` exists with the frontmatter above
- [ ] Reads `architecture.yaml.tooling.stack.web_framework`; aborts with documented error if `≠ react-next`
- [ ] Reads `/stylesheet`'s agnostic-surface outputs (tokens, styles, .components-plan.json, signoff) before authoring
- [ ] ≥12 mandatory primitives present, each with `.tsx` + `.variants.ts` + `.stories.tsx` + `.test.tsx` + `index.ts`
- [ ] Every primitive has the required variants from §1c table
- [ ] Every primitive forwards `data-kit-component` / `data-kit-variant` / `data-kit-size` (feat-028 contract)
- [ ] Per-primitive test asserts `data-kit-*` attribute presence
- [ ] Bug-029 retrofit codemod runs at step 8 (idempotent safety net)
- [ ] ≥12 canonical patterns present, composed from primitives (never reinvented); custom patterns per `.components-plan.json.customPatternsGenerated[]`
- [ ] ≥5 canonical layouts present
- [ ] CVA used for every variant definition (not ad-hoc `className` switching)
- [ ] 022b artifacts (`eslint-plugin/rules/*.js`, `scripts/validate-consumer.ts`) replace /new-project step 5b's stubs with real implementations
- [ ] `src/index.ts` is the ONLY public surface; no internal paths re-exported beyond the icon barrel
- [ ] `package.json` `exports` field restricts subpath access to `./styles/*` + `./tokens/*` + `./eslint-plugin`
- [ ] `package.json` version bumps `0.1.0-tokens-only` → `0.2.0-primitives` on first successful run
- [ ] Storybook build succeeds; `storybook-static/` populated
- [ ] `pnpm typecheck` passes on the kit
- [ ] Re-run with unchanged inputs is a no-op (`noChange: true` in return JSON; byte-identical React surface)
- [ ] `packages/ui-kit/CHANGELOG.md` 0.2.0-primitives entry appended
- [ ] Return JSON matches the React-surface subset of `StylesheetOutput` in task 034b
- [ ] Auto-fires post-/architect when orchestrator (feat-074 Phase E) is in place; manual invocation works the same
- [ ] `/pm` waits for BOTH this skill's success AND gate-5 resolved (orchestrator-side gate)
- [ ] Primitives-shipped hard gate fires (≥12 or fail) per refactor-006 — owned by THIS skill (moved from `/stylesheet`)

## Cross-references

- **feat-074** — the factory plan that split the original `/stylesheet` skill into pre-architect (agnostic) + post-architect (this). See `plans/active/feat-074-stylesheet-split-and-parallelize.md`.
- **investigate-028** — the parent investigation. See `plans/active/investigate-028-stylesheet-split.md`.
- **`/stylesheet`** — the sibling skill that ran first. Consumes its outputs verbatim.
- **refactor-006** — moved the ≥12-primitives hard gate to this skill (step 8) — historically it lived in `/stylesheet` step 18.
- **bug-029** — `data-kit-component` retrofit codemod; runs at step 8.
- **feat-028** — visual-parity verifier; depends on `data-kit-*` attribute forwarding in primitives + layouts (§1b.1 + §3).
- **feat-013** — the original primitives-shipping kit (hatch-2); reference implementation for the React surface.
