// validate-consumer.ts — standalone grep-based enforcement for the @repo/ui-kit
// consumption contract (see packages/ui-kit/CONTRACT.md).
//
// Runs in CI and as a Layer-4 PostToolUse hook on Write events into apps/**.
// Does not require ESLint to be configured. Scans apps/ only; kit internals
// under packages/ui-kit/** are exempt by glob.
//
// Usage:
//   tsx packages/ui-kit/scripts/validate-consumer.ts 'apps/*/src/**/*.{ts,tsx,js,jsx}'
//   (exit 0 = clean; exit 1 = violations; exit 2 = bad usage)

import { globSync } from "glob";
import fs from "node:fs";
import path from "node:path";

type Violation = { file: string; line: number; rule: string; snippet: string };

const PATTERNS: Array<{ rule: string; re: RegExp; hint: string }> = [
  {
    rule: "deep-import",
    // Block TS/JS deep imports from the kit's internal module tree.
    // `styles/` is carved out because consumers legitimately import
    // globals.css / fonts.css at root-layout registration time — see
    // `deep-import-styles-ts` below for the narrower check that still
    // blocks .ts/.tsx imports from styles/.
    re: /from\s+["']@repo\/ui-kit\/(primitives|patterns|layouts|lib|tokens|icons|illustrations)\/[^"']+["']/,
    hint: "Import from @repo/ui-kit barrel only",
  },
  {
    rule: "deep-import-styles-ts",
    // Allow  import '@repo/ui-kit/styles/globals.css'
    // Block  import foo from '@repo/ui-kit/styles/something.ts'
    re: /from\s+["']@repo\/ui-kit\/styles\/[^"']+\.(ts|tsx|js|jsx)["']/,
    hint: "Deep TS/JS imports from @repo/ui-kit/styles are forbidden; .css is allowed",
  },
  {
    rule: "hex-in-className",
    re: /className\s*=\s*[{"'`][^{}"'`]*#[0-9a-fA-F]{3,8}/,
    hint: "No hex colors in className — use a kit component/variant",
  },
  {
    rule: "arbitrary-tailwind",
    // Allow grid/flex arbitrary values (1fr, auto, min-content, max-content)
    // Block everything else.
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
    // Skip kit internals (defense-in-depth; the glob should already exclude them).
    if (file.includes("packages/ui-kit/")) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { rule, re } of PATTERNS) {
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
