"use strict";

// @repo/eslint-plugin-ui-kit-contract — enforces the @repo/ui-kit consumption
// contract at lint time. Four rules, all apply to files under apps/** only.
// Consumers add the plugin and opt into each rule in their .eslintrc; kit
// internals under packages/ui-kit/** are exempted via an `overrides:` block
// (see CONTRACT.md §Enforcement).

module.exports = {
  rules: {
    "no-deep-imports": require("./rules/no-deep-imports"),
    "no-hex-in-className": require("./rules/no-hex-in-className"),
    "no-arbitrary-tailwind": require("./rules/no-arbitrary-tailwind"),
    "no-inline-style-tokens": require("./rules/no-inline-style-tokens"),
  },
  configs: {
    recommended: {
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
    },
  },
};
