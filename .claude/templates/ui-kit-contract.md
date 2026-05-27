# @repo/ui-kit consumption contract

This file is the handshake between the UI Designer and the Build Agents (web, mobile, admin). Consumer agents must paste this block into their system prompt AND respect it at runtime. CI enforces it via ESLint + `validate-consumer.ts`.

## Rules

1. **Import from the public barrel only.**
   Good: `import { Button, Card, EmptyState } from '@repo/ui-kit'`
   Bad: `import { Button } from '@repo/ui-kit/primitives/button'`

2. **Never write raw HTML with `className` for styling.**
   Good: `<Button variant="primary" size="md">Save</Button>`
   Bad: `<button className="bg-blue-600 text-white px-4 py-2 rounded">Save</button>`

3. **Never reference design tokens by literal value.**
   Use kit components or (rarely) the exported `tokens` object — never inline hex, rgb(), hsl(), or magic px values in `className` or `style`.
   Good: `<Card elevation="raised" />`
   Bad: `<div style={{ background: '#18181b', boxShadow: '0 4px 6px rgb(0 0 0 / 0.08)' }} />`

4. **Never use arbitrary-value Tailwind utilities for styling.**
   Arbitrary values (e.g., `bg-[#18181b]`, `p-[13px]`) bypass the token system and signal a missing primitive variant.
   Good: `<Badge tone="info" />`
   Bad: `<span className="bg-[#dbeafe] text-[#2563eb] px-[10px]">Info</span>`

5. **If a needed primitive, pattern, or layout is missing, STOP and request it from the UI Designer.** Do not build it locally. The correct flow:
   - Emit `docs/screens/kit-change-requests/{screen-id}.md` describing the missing primitive
   - The orchestrator (task 035) invokes PM in `--mode=kit-change-request` to author a mini-plan
   - `/stylesheet` re-runs and bumps the kit to a new minor version (e.g., `1.0.0 → 1.1.0`)
   - Then resume the screen that needed the new component

6. **Layout utilities are allowed** — as long as they use the kit's spacing scale. `flex`, `grid`, `gap-1..16`, `w-*`, `h-*`, `p-1..16`, `m-1..16` are fine when the numeric suffix matches the kit's scale. Layout ≠ styling. The kit owns typography, color, shadow, radius, and motion; your screen owns layout.
   Good: `<div className="flex gap-4 p-6">`
   Bad: `<div className="flex gap-[13px] p-[17px]">` (arbitrary values — use the scale)

## Allowed escape hatches

- Importing the `tokens` object from `@repo/ui-kit` for runtime theming (e.g., passing a token value to a charting library that doesn't accept components)
- Using the `cn` utility from `@repo/ui-kit` for conditional className composition
- Using the `cva` utility from `@repo/ui-kit` for component-local variant definitions when extending the kit internally (kit authors only; not consumers)

## Enforcement

- **Lint:** `@repo/eslint-plugin-ui-kit-contract` errors on any violation. `pnpm lint` fails.
- **CI:** `pnpm ui-kit:validate-consumer` scans `apps/*/src/**/*.{ts,tsx,js,jsx}` and fails the build on any violation.
- **Review:** the Reviewer agent (task 032) refuses to approve a PR where either check fails.

## When rules conflict with reality

If you find a legitimate case where the kit cannot express what a screen needs, escalate to the UI Designer via `/plan-feature` with `feature-area: ui-kit`. Do not work around the contract; fix the kit.
