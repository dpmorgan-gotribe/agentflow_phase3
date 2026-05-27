# @repo/eslint-plugin-ui-kit-contract

ESLint plugin shipped with `@repo/ui-kit` that enforces the kit's consumption contract at lint time. See `packages/ui-kit/CONTRACT.md` for the human-readable rules.

## Rules

| Rule                     | Severity | Purpose                                                                                                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-deep-imports`        | error    | Require `@repo/ui-kit` barrel imports (blocks `@repo/ui-kit/primitives/*`, etc.). CSS imports from `@repo/ui-kit/styles/*.css` are explicitly allowed. |
| `no-hex-in-className`    | error    | No hex colors embedded in `className` strings                                                                                                          |
| `no-arbitrary-tailwind`  | error    | No arbitrary-value Tailwind utilities (e.g. `bg-[#f00]`, `p-[13px]`). Grid/flex arbitrary values allowed when `allowGridFlex: true` (default).         |
| `no-inline-style-tokens` | error    | No hex/rgb/hsl or magic px values in `style={{ ... }}`                                                                                                 |

## Usage

Consumer `.eslintrc.js` (example — `apps/web/.eslintrc.js`):

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

Alternatively extend the plugin's `recommended` config:

```js
module.exports = {
  extends: ["@repo/eslint-config", "plugin:@repo/ui-kit-contract/recommended"],
  overrides: [
    /* kit-internals override as above */
  ],
};
```

## Scope

Rules apply to **consumer code only** (`apps/**`). Kit internals under `packages/ui-kit/**` are exempted via an `overrides:` block — the kit authors legitimately deep-import primitives from their own siblings to compose patterns and layouts.

## CI enforcement layer

Running ESLint alone is not sufficient — some CI steps skip lint for speed. A standalone grep validator at `packages/ui-kit/scripts/validate-consumer.ts` provides a second enforcement layer that runs without ESLint config (and as a Layer-4 PostToolUse hook on `Write` events into `apps/**`). Wire via:

```json
{
  "scripts": {
    "ui-kit:validate-consumer": "tsx packages/ui-kit/scripts/validate-consumer.ts 'apps/*/src/**/*.{ts,tsx,js,jsx}'"
  }
}
```
