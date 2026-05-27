"use strict";

// Rule: no-arbitrary-tailwind
// Flags Tailwind arbitrary-value utilities in className (e.g. bg-[#f00],
// p-[13px], text-[red]). Arbitrary values bypass the token system and signal
// a missing primitive variant. Grid/flex arbitrary values (1fr, auto,
// min-content, max-content) are allowed when the rule is configured with
// { allowGridFlex: true } (default).

const UTILITY_PREFIXES =
  "bg|text|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|gap|rounded|shadow|border|ring|from|to|via|fill|stroke|leading|tracking|font";

// Matches any utility-class with an arbitrary value, e.g. bg-[#fff], p-[13px].
function buildMatcher(allowedGridFlex) {
  const allowList = allowedGridFlex
    ? "(?!1fr|auto|min-content|max-content)"
    : "";
  return new RegExp(`\\b(${UTILITY_PREFIXES})-\\[${allowList}[^\\]]+\\]`, "g");
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No arbitrary-value Tailwind utilities in className — use kit variants or the spacing scale",
      category: "ui-kit-contract",
    },
    schema: [
      {
        type: "object",
        properties: { allowGridFlex: { type: "boolean", default: true } },
        additionalProperties: false,
      },
    ],
    messages: {
      arbitrary:
        "No arbitrary-value Tailwind utilities in className ('{{match}}'). Use a kit variant or the kit's spacing scale. See packages/ui-kit/CONTRACT.md rule 4.",
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const allowGridFlex = options.allowGridFlex !== false;
    const matcher = buildMatcher(allowGridFlex);

    function checkValue(node, str) {
      if (typeof str !== "string") return;
      const m = str.match(matcher);
      if (m) {
        context.report({ node, messageId: "arbitrary", data: { match: m[0] } });
      }
    }

    function walkExpression(node, exprNode) {
      if (!exprNode) return;
      switch (exprNode.type) {
        case "Literal":
          checkValue(node, exprNode.value);
          break;
        case "TemplateLiteral":
          for (const q of exprNode.quasis) checkValue(node, q.value.cooked);
          break;
        case "ConditionalExpression":
          walkExpression(node, exprNode.consequent);
          walkExpression(node, exprNode.alternate);
          break;
        case "LogicalExpression":
        case "BinaryExpression":
          walkExpression(node, exprNode.left);
          walkExpression(node, exprNode.right);
          break;
        case "CallExpression":
          for (const arg of exprNode.arguments) walkExpression(node, arg);
          break;
      }
    }

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "className") return;
        const v = node.value;
        if (!v) return;
        if (v.type === "Literal") checkValue(node, v.value);
        else if (v.type === "JSXExpressionContainer")
          walkExpression(node, v.expression);
      },
    };
  },
};
