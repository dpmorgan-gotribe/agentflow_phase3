"use strict";

// Rule: no-hex-in-className
// Flags hex colors embedded in className strings (JSX attribute, template
// literal, or passed to cn()). Hex in className bypasses the token system
// and breaks the @repo/ui-kit consumption contract.

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No hex colors in className — use a kit component or variant",
      category: "ui-kit-contract",
    },
    schema: [],
    messages: {
      hexInClassName:
        "No hex colors in className ('{{match}}'). Use a kit component or variant instead. See packages/ui-kit/CONTRACT.md rule 3.",
    },
  },
  create(context) {
    function reportIfHex(node, str) {
      if (typeof str !== "string") return;
      const m = str.match(HEX_RE);
      if (m) {
        context.report({
          node,
          messageId: "hexInClassName",
          data: { match: m[0] },
        });
      }
    }

    function walkExpression(node, exprNode) {
      if (!exprNode) return;
      switch (exprNode.type) {
        case "Literal":
          reportIfHex(node, exprNode.value);
          break;
        case "TemplateLiteral":
          for (const q of exprNode.quasis) reportIfHex(node, q.value.cooked);
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
          // e.g., cn(...), clsx(...) — walk all arguments
          for (const arg of exprNode.arguments) walkExpression(node, arg);
          break;
      }
    }

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "className") return;
        const v = node.value;
        if (!v) return;
        if (v.type === "Literal") reportIfHex(node, v.value);
        else if (v.type === "JSXExpressionContainer")
          walkExpression(node, v.expression);
      },
    };
  },
};
