---
task-id: "022b"
title: "UI Kit Consumption Contract"
status: pending
priority: P2
tier: 6 — Design Pipeline
depends-on: ["022"]
estimated-scope: small
---

# 022b: UI Kit Consumption Contract

## What This Task Produces

The **consumption contract** that locks downstream builder agents (029 web-frontend-builder, 030 mobile-frontend-builder, and any future screen generator) into importing from `@repo/ui-kit` only. Four concrete artifacts:

1. `packages/ui-kit/CONTRACT.md` — paste-ready rules that every consumer agent embeds in its system prompt. The canonical copy is shipped at `.claude/templates/ui-kit-contract.md` (factory-level); task 027 copies it into every new project's kit at scaffold time so downstream agents can read it from day zero.
2. `packages/ui-kit/eslint-plugin/` — a small ESLint plugin shipped with the kit that enforces the contract at lint time
3. `packages/ui-kit/tsconfig.consumer.json` — path-aliases that expose only the public barrel, not internal subpaths
4. `packages/ui-kit/scripts/validate-consumer.ts` — a standalone grep-based validator that CI can run without needing ESLint

## Why This Exists

Without a hard contract, downstream agents silently restyle kit primitives or write raw HTML with ad-hoc tokens. Refactor-001's core thesis is that the kit **is** the visual source of truth — that thesis only holds if consumers physically cannot bypass it. Prompt-only rules are insufficient; the contract needs to be enforced mechanically in three independent places:

- **Prompt layer** (CONTRACT.md → agent system prompts)
- **Lint layer** (ESLint plugin errors at edit time)
- **CI layer** (validate-consumer.ts fails the build)

## Scope

### 1. `packages/ui-kit/CONTRACT.md` (paste-ready for consumer agent prompts)

Content (verbatim target):

```markdown
# @repo/ui-kit consumption contract

This file is the handshake between the UI Designer and the Build Agents (web, mobile,
admin). Consumer agents must paste this block into their system prompt AND respect it
at runtime. CI enforces it via ESLint + `validate-consumer.ts`.

## Rules

1. **Import from the public barrel only.**
   Good: `import { Button, Card, EmptyState } from '@repo/ui-kit'`
   Bad: `import { Button } from '@repo/ui-kit/primitives/button'`

2. **Never write raw HTML with `className` for styling.**
   Good: `<Button variant="primary" size="md">Save</Button>`
   Bad: `<button className="bg-blue-600 text-white px-4 py-2 rounded">Save</button>`

3. **Never reference design tokens by literal value.**
   Use kit components or (rarely) the exported `tokens` object — never inline hex,
   rgb(), hsl(), or magic px values in `className` or `style`.
   Good: `<Card elevation="raised" />`
   Bad: `<div style={{ background: '#18181b', boxShadow: '0 4px 6px rgb(0 0 0 / 0.08)' }} />`

4. **Never use arbitrary-value Tailwind utilities for styling.**
   Arbitrary values (e.g., `bg-[#18181b]`, `p-[13px]`) bypass the token system and
   signal a missing primitive variant.
   Good: `<Badge tone="info" />`
   Bad: `<span className="bg-[#dbeafe] text-[#2563eb] px-[10px]">Info</span>`

5. **If a needed primitive, pattern, or layout is missing, STOP and request it
   from the UI Designer.** Do not build it locally. The correct flow:
   - Open a "kit-change ticket" (see /pm)
   - Wait for the kit to bump to a new minor version
   - Then resume the screen that needed the new component

6. **Layout utilities are allowed** — as long as they use the kit's spacing scale.
   `flex`, `grid`, `gap-1..16`, `w-*`, `h-*`, `p-1..16`, `m-1..16` are fine when
   the numeric suffix matches the kit's scale. Layout ≠ styling. The kit owns
   typography, color, shadow, radius, and motion; your screen owns layout.
   Good: `<div className="flex gap-4 p-6">`
   Bad: `<div className="flex gap-[13px] p-[17px]">` (arbitrary values — use the scale)

## Allowed escape hatches

- Importing the `tokens` object from `@repo/ui-kit` for runtime theming
  (e.g., passing a token value to a charting library that doesn't accept components)
- Using the `cn` utility from `@repo/ui-kit` for conditional className composition
- Using the `cva` utility from `@repo/ui-kit` for component-local variant definitions
  when extending the kit internally (kit authors only; not consumers)

## Enforcement

- **Lint:** `eslint-plugin-ui-kit-contract` errors on any violation. `pnpm lint` fails.
- **CI:** `pnpm ui-kit:validate-consumer` scans `apps/*/src/**/*.{ts,tsx,js,jsx}`
  and fails the build on any violation.
- **Review:** the Reviewer agent (task 032) refuses to approve a PR where either
  check fails.

## When rules conflict with reality

If you find a legitimate case where the kit cannot express what a screen needs,
escalate to the UI Designer via `/plan-feature` with `feature-area: ui-kit`. Do
not work around the contract; fix the kit.
```

### 2. `packages/ui-kit/eslint-plugin/`

A minimal ESLint plugin with four rules. Ships in the monorepo (not published); consumers extend the kit's shared ESLint config.

**Important scope note:** all four rules apply to files under `apps/**` only. Files under `packages/ui-kit/**` are exempt by override (the kit's own internals must deep-import from its own primitives/patterns/layouts). Storybook stories under `packages/ui-kit/**/*.stories.tsx` are also exempt. This scoping lives in the consumer's `.eslintrc` via an `overrides:` block and in `validate-consumer.ts` via the glob argument.

**File layout:**

```
packages/ui-kit/eslint-plugin/
├── package.json
├── index.js                  # plugin entry — exports the four rules
├── rules/
│   ├── no-deep-imports.js    # rule 1 (restrict @repo/ui-kit/*/ subpaths)
│   ├── no-hex-in-className.js  # rule 2 (hex in className strings)
│   ├── no-arbitrary-tailwind.js  # rule 3 (Tailwind arbitrary values)
│   └── no-inline-style-tokens.js  # rule 4 (hex/rgb in style prop)
└── README.md
```

**Rules:**

1. **`no-deep-imports`** — `no-restricted-imports` under the hood. Blocks JS/TS deep imports of the kit's internal TS modules. CSS imports (e.g. `import '@repo/ui-kit/styles/globals.css'` for root-layout registration) are explicitly allowed via a file-extension guard in the rule:
   ```js
   patterns: [
     {
       group: [
         "@repo/ui-kit/primitives/*",
         "@repo/ui-kit/patterns/*",
         "@repo/ui-kit/layouts/*",
         "@repo/ui-kit/lib/*",
         "@repo/ui-kit/tokens/*",
         "@repo/ui-kit/icons/*",
         "@repo/ui-kit/illustrations/*",
         // @repo/ui-kit/styles/* is NOT blocked — consumers need the globals.css
         // and fonts.css imports in their root layout. If the consumer tries to
         // import a .ts/.tsx from styles/, the guard below catches it via AST.
       ],
       message:
         "Import from @repo/ui-kit (public barrel) only. Deep imports violate the consumption contract.",
     },
   ];
   // Rule implementation additionally flags imports matching
   //   /^@repo\/ui-kit\/styles\/.+\.(ts|tsx|js|jsx)$/
   // while allowing  /^@repo\/ui-kit\/styles\/.+\.css$/.
   ```
2. **`no-hex-in-className`** — AST rule that flags `className` (JSX attribute or string literal passed to `cn()`) containing `/#[0-9a-fA-F]{3,8}\b/`.
3. **`no-arbitrary-tailwind`** — AST rule that flags any Tailwind utility containing `[...]` (e.g., `bg-[#f00]`, `p-[13px]`, `text-[red]`) inside `className`. Exception: arbitrary grid/flex values (`grid-cols-[1fr,auto]`) are allowed via a configurable allow-list.
4. **`no-inline-style-tokens`** — AST rule that flags `style={{ ... }}` objects with values matching hex/rgb/hsl/named colors or px values for spacing/typography properties.

**Plugin naming convention.** The plugin package is `@repo/eslint-plugin-ui-kit-contract` (scoped under the monorepo's `@repo` namespace). In ESLint config, scoped plugins are referenced by `@repo/ui-kit-contract` (the scope + the portion after `eslint-plugin-`). Rule keys follow the same form: `@repo/ui-kit-contract/no-deep-imports`.

**Consumer wiring** (example for `apps/web/.eslintrc.js`):

```js
module.exports = {
  extends: ["@repo/eslint-config"],
  plugins: ["@repo/ui-kit-contract"],
  rules: {
    "@repo/ui-kit-contract/no-deep-imports": "error",
    "@repo/ui-kit-contract/no-hex-in-className": "error",
    "@repo/ui-kit-contract/no-arbitrary-tailwind": [
      "error",
      { allowGridFlex: true },
    ],
    "@repo/ui-kit-contract/no-inline-style-tokens": "error",
  },
  overrides: [
    {
      // kit internals may deep-import from their own subpaths
      files: ["packages/ui-kit/**/*"],
      rules: {
        "@repo/ui-kit-contract/no-deep-imports": "off",
        "@repo/ui-kit-contract/no-hex-in-className": "off",
        "@repo/ui-kit-contract/no-arbitrary-tailwind": "off",
        "@repo/ui-kit-contract/no-inline-style-tokens": "off",
      },
    },
  ],
};
```

### 3. `packages/ui-kit/tsconfig.consumer.json`

Path aliases that expose only the public barrel. Any consumer's tsconfig extends this.

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@repo/ui-kit": ["./packages/ui-kit/src/index.ts"]
    }
  }
}
```

Note: deliberately omitting `"@repo/ui-kit/*"` — consumers literally cannot resolve deep paths at TypeScript's module-resolution layer.

### 4. `packages/ui-kit/scripts/validate-consumer.ts`

Standalone Node/tsx script any app can run. Does not require ESLint to be configured — useful in CI where lint may not be in scope, and as a pre-commit Layer 4 hook.

```ts
// packages/ui-kit/scripts/validate-consumer.ts
import { globSync } from "glob";
import fs from "node:fs";
import path from "node:path";

type Violation = { file: string; line: number; rule: string; snippet: string };

const PATTERNS: Array<{ rule: string; re: RegExp; hint: string }> = [
  {
    rule: "deep-import",
    // Blocks TS/JS deep imports from the kit's internals. `styles/` is carved
    // out because consumers legitimately import globals.css / fonts.css at the
    // root layout — see the `deep-import-styles-ts` rule below for the narrower
    // check that still blocks .ts/.tsx imports from styles/.
    re: /from\s+["']@repo\/ui-kit\/(primitives|patterns|layouts|lib|tokens|icons|illustrations)\/[^"']+["']/,
    hint: "Import from @repo/ui-kit barrel only",
  },
  {
    rule: "deep-import-styles-ts",
    // Allow   import '@repo/ui-kit/styles/globals.css'
    // Block   import foo from '@repo/ui-kit/styles/something.ts'
    re: /from\s+["']@repo\/ui-kit\/styles\/[^"']+\.(ts|tsx|js|jsx)["']/,
    hint: "Deep .ts/.tsx imports from @repo/ui-kit/styles are forbidden; CSS files are allowed",
  },
  {
    rule: "hex-in-className",
    re: /className\s*=\s*[{"'`][^{}"'`]*#[0-9a-fA-F]{3,8}/,
    hint: "No hex colors in className — use a kit component/variant",
  },
  {
    rule: "arbitrary-tailwind",
    re: /className\s*=\s*[{"'`][^{}"'`]*\b(bg|text|p|px|py|m|mx|my|w|h|gap|rounded|shadow|border)-\[(?!1fr|auto|min-content|max-content)[^\]]+\]/,
    hint: "No arbitrary-value Tailwind utilities — use kit variants or the spacing scale",
  },
  {
    rule: "inline-style-hex",
    re: /style\s*=\s*\{[^}]*#[0-9a-fA-F]{3,8}/,
    hint: "No hex colors in style prop — use a kit component",
  },
];

const TARGETS = process.argv.slice(2);
if (TARGETS.length === 0) {
  console.error("usage: validate-consumer <glob> [<glob>...]");
  process.exit(2);
}

const violations: Violation[] = [];

for (const target of TARGETS) {
  const files = globSync(target, { nodir: true });
  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { rule, re, hint } of PATTERNS) {
        if (re.test(line)) {
          violations.push({
            file: path.relative(process.cwd(), file),
            line: i + 1,
            rule,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log("✓ ui-kit consumer contract: clean");
  process.exit(0);
}

console.error(`✗ ui-kit consumer contract: ${violations.length} violation(s)`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.snippet}`);
}
process.exit(1);
```

Wire in `package.json`. Note the glob targets `apps/*` only — files under `packages/ui-kit/**` are kit internals and are exempt by virtue of not being scanned:

```json
{
  "scripts": {
    "ui-kit:validate-consumer": "tsx packages/ui-kit/scripts/validate-consumer.ts 'apps/*/src/**/*.{ts,tsx,js,jsx}'"
  }
}
```

## Integration Points

- **Task 022** (ui-designer agent): already references this contract in its "Kit-first rule" section; no change needed here
- **Task 024** (/stylesheet): must produce `packages/ui-kit/eslint-plugin/` and `packages/ui-kit/scripts/validate-consumer.ts` as part of the kit output
- **Task 027** (shared packages): scaffold the empty `eslint-plugin/` and `scripts/` folders in `@repo/ui-kit` skeleton
- **Task 029** (web-frontend-builder): system prompt embeds CONTRACT.md; post-generation runs `pnpm ui-kit:validate-consumer 'apps/web/src/**/*.{ts,tsx}'`
- **Task 030** (mobile-frontend-builder): same for `apps/mobile/`
- **Task 032** (reviewer agent): assert `pnpm ui-kit:validate-consumer` passes as part of code review before approval
- **Task 034** (output contracts): Layer 4 hook can optionally run `validate-consumer` on each Write to app source files for early failure

## Acceptance Criteria

- [ ] `.claude/templates/ui-kit-contract.md` (factory-level) exists with the six numbered rules and allowed escape hatches verbatim
- [ ] Task 027 copies `.claude/templates/ui-kit-contract.md` → `packages/ui-kit/CONTRACT.md` at scaffold time (no stub; real content)
- [ ] `packages/ui-kit/eslint-plugin/` ships four rules: no-deep-imports, no-hex-in-className, no-arbitrary-tailwind, no-inline-style-tokens
- [ ] ESLint plugin has its own `package.json` naming it `@repo/eslint-plugin-ui-kit-contract` (or equivalent)
- [ ] `packages/ui-kit/tsconfig.consumer.json` exposes only `@repo/ui-kit` path alias (no subpath wildcards)
- [ ] `packages/ui-kit/scripts/validate-consumer.ts` runs against a glob and exits non-zero on violations
- [ ] Root `package.json` has `ui-kit:validate-consumer` script wired to run against `apps/*/src/**/*`
- [ ] Running the script against a file with `import { Button } from '@repo/ui-kit/primitives/button'` reports a `deep-import` violation
- [ ] Running the script against a file with `className="bg-[#f00]"` reports an `arbitrary-tailwind` violation
- [ ] Running the script against a file with `style={{ color: '#18181b' }}` reports an `inline-style-hex` violation
- [ ] Running the script against a clean consumer exits 0 with "✓ ui-kit consumer contract: clean"
- [ ] CONTRACT.md is referenced (and pasted) by 029 and 030 agent system prompts
- [ ] Reviewer agent (032) has a contract-check step in its review checklist

## Human Verification

1. Hand-author a screen that deep-imports `@repo/ui-kit/primitives/button`. Does ESLint flag it? Does `validate-consumer.ts` flag it?
2. Hand-author a screen with `className="bg-[#ff0000] p-[13px]"`. Does the script report 2 violations on 1 line?
3. Remove a violation, re-run. Does it drop from the report?
4. Run the script against a perfectly kit-compliant screen. Does it exit 0 silently?
5. Does the CONTRACT.md read clearly enough that a human builder — not just an agent — could follow it?
