"use strict";

// Rule: no-inline-style-tokens
// Flags inline style={{ ... }} with literal token values:
//   - hex / rgb / rgba / hsl / hsla colors on any CSS property
//   - magic px values (not 0) for spacing / typography properties
//   - named CSS colors on color-taking properties (best-effort list)

const COLOR_PROP_RE =
  /^(color|background|backgroundColor|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|outlineColor|fill|stroke|textDecorationColor|boxShadow|caretColor)$/;
const SPACING_OR_TYPO_PROP_RE =
  /^(padding|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginTop|marginRight|marginBottom|marginLeft|gap|columnGap|rowGap|fontSize|lineHeight|letterSpacing|width|height|minWidth|minHeight|maxWidth|maxHeight|top|right|bottom|left|borderRadius|borderWidth)$/;

const COLOR_VALUE_RE =
  /#[0-9a-fA-F]{3,8}\b|\brgb\s*\(|\brgba\s*\(|\bhsl\s*\(|\bhsla\s*\(/;
const PX_VALUE_RE = /(?<!0)[1-9]\d*\s*px\b/;

// Small set of named colors that would clearly indicate a bypass. Not
// exhaustive — lint catches the common cases; CSS-in-JS has too many synonyms
// to perfectly classify. validate-consumer.ts provides a second layer.
const NAMED_COLORS = new Set([
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
  "black",
  "white",
  "gray",
  "grey",
  "cyan",
  "magenta",
]);

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No hex/rgb/hsl colors or magic px values in style={{...}} — use kit components",
      category: "ui-kit-contract",
    },
    schema: [],
    messages: {
      colorToken:
        "No color tokens in inline style ('{{prop}}: {{value}}'). Use a kit component instead. See packages/ui-kit/CONTRACT.md rule 3.",
      spacingToken:
        "No magic px values in inline style ('{{prop}}: {{value}}'). Use a kit component or the kit's spacing scale. See CONTRACT.md rule 3.",
    },
  },
  create(context) {
    function checkLiteral(prop, literalNode) {
      if (!literalNode || literalNode.type !== "Literal") return;
      const v = literalNode.value;
      if (v === null || v === undefined) return;
      const s = String(v);

      if (COLOR_PROP_RE.test(prop)) {
        if (
          COLOR_VALUE_RE.test(s) ||
          NAMED_COLORS.has(s.trim().toLowerCase())
        ) {
          context.report({
            node: literalNode,
            messageId: "colorToken",
            data: { prop, value: s.slice(0, 40) },
          });
          return;
        }
      }
      if (SPACING_OR_TYPO_PROP_RE.test(prop)) {
        if (PX_VALUE_RE.test(s)) {
          context.report({
            node: literalNode,
            messageId: "spacingToken",
            data: { prop, value: s.slice(0, 40) },
          });
        }
      }
    }

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "style") return;
        const v = node.value;
        if (!v || v.type !== "JSXExpressionContainer") return;
        const expr = v.expression;
        if (!expr || expr.type !== "ObjectExpression") return;
        for (const prop of expr.properties) {
          if (prop.type !== "Property" && prop.type !== "ObjectProperty")
            continue;
          const key = prop.key;
          let propName;
          if (key.type === "Identifier") propName = key.name;
          else if (key.type === "Literal") propName = String(key.value);
          else continue;
          checkLiteral(propName, prop.value);
        }
      },
    };
  },
};
