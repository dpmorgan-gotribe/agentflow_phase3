"use strict";

// Rule: no-deep-imports
// Blocks TS/JS deep imports from @repo/ui-kit internals. Consumers must
// import from the public barrel (@repo/ui-kit) only. CSS files under
// @repo/ui-kit/styles are explicitly ALLOWED (root layouts register
// globals.css and fonts.css this way). Deep TS/TSX/JS/JSX imports from
// @repo/ui-kit/styles/* are still blocked.

const BLOCKED_PREFIXES = [
  "@repo/ui-kit/primitives/",
  "@repo/ui-kit/patterns/",
  "@repo/ui-kit/layouts/",
  "@repo/ui-kit/lib/",
  "@repo/ui-kit/tokens/",
  "@repo/ui-kit/icons/",
  "@repo/ui-kit/illustrations/",
];

const STYLES_TS_RE = /^@repo\/ui-kit\/styles\/.+\.(ts|tsx|js|jsx)$/;
const STYLES_CSS_RE = /^@repo\/ui-kit\/styles\/.+\.css$/;

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Require @repo/ui-kit imports from the public barrel only",
      category: "ui-kit-contract",
    },
    schema: [],
    messages: {
      deepImport:
        "Import from @repo/ui-kit (public barrel) only. '{{source}}' is a deep import that violates the consumption contract. See packages/ui-kit/CONTRACT.md rule 1.",
      deepStylesTs:
        "Deep TS/JS imports from @repo/ui-kit/styles are forbidden ('{{source}}'). Only CSS imports are allowed (e.g., import '@repo/ui-kit/styles/globals.css').",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source && node.source.value;
        if (typeof source !== "string") return;
        if (!source.startsWith("@repo/ui-kit/")) return;

        // Allow CSS imports from styles/
        if (STYLES_CSS_RE.test(source)) return;

        // Block deep TS/JS imports from styles/
        if (STYLES_TS_RE.test(source)) {
          context.report({ node, messageId: "deepStylesTs", data: { source } });
          return;
        }

        // Block deep imports from other internal subpaths
        for (const prefix of BLOCKED_PREFIXES) {
          if (source.startsWith(prefix)) {
            context.report({ node, messageId: "deepImport", data: { source } });
            return;
          }
        }
      },
    };
  },
};
