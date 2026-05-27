#!/usr/bin/env node
/**
 * bug-029 Phase B — bulk retrofit `data-kit-component` onto ui-kit primitives + layouts.
 *
 * Walks `packages/ui-kit/src/{primitives,layouts}/**\/*.tsx`, finds every
 * exported React component (`export const Foo = ...` or `export function Foo(...)`),
 * locates that component's JSX root (the first `<tag` after `return ...` or
 * an implicit-return arrow `=> ...`), and inserts
 * `data-kit-component="<ComponentName>"` if it is not already present.
 *
 * Variant / size attributes are deliberately NOT retrofitted here — they depend
 * on per-primitive prop names and are easier for builders to author at write
 * time than to bulk-rewrite. The visual-parity diff (feat-035) keys primarily
 * off `data-kit-component`; variant/size are nice-to-have.
 *
 * Idempotent: running twice is a no-op (every export reports `already-present`).
 *
 * Usage:
 *   node scripts/retrofit-ui-kit-data-attrs.mjs <projectDir> [--dry-run]
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!name.endsWith(".tsx")) continue;
    if (name.endsWith(".test.tsx")) continue;
    if (name.endsWith(".stories.tsx")) continue;
    if (name === "index.tsx") continue;
    out.push(full);
  }
  return out;
}

function findExportedComponents(src) {
  // `export const Foo = ...` OR `export function Foo(...)` where Foo starts with uppercase.
  const re = /export\s+(?:const|function)\s+([A-Z]\w*)\b/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ name: m[1], pos: m.index });
  }
  return out;
}

/**
 * Find the first DOM-rendering JSX root after `fromPos`. We prefer lowercase
 * HTML tags (div, span, button, ...) since Context Providers / Fragments /
 * custom React wrappers (`<XContext.Provider>`, `<MyWrapper>`) don't render
 * their own DOM node — `data-kit-component` would be dropped if attached
 * there.
 *
 * If no lowercase HTML tag is found in the component body, fall back to the
 * first JSX tag of any kind (rare — e.g. a primitive that just re-exports
 * another primitive).
 */
function findFirstJsxRoot(src, fromPos) {
  const tail = src.slice(fromPos);
  // Anchor on a return / implicit-return arrow boundary so we don't match
  // JSX that lives in unrelated comments or earlier code.
  const anchor = /(?:\breturn\s*\(?\s*|=>\s*\(?\s*)/g;
  const a = anchor.exec(tail);
  if (!a) return null;
  const bodyStart = fromPos + a.index + a[0].length;

  // First pass: prefer lowercase HTML tags inside the component body.
  const lowerRe = /<([a-z][\w-]*)/g;
  lowerRe.lastIndex = bodyStart - fromPos;
  const lm = lowerRe.exec(tail);

  // Second pass: any JSX tag (capitalized component, dotted Provider, etc).
  const anyRe = /<([a-zA-Z][\w.-]*)/g;
  anyRe.lastIndex = bodyStart - fromPos;
  const am = anyRe.exec(tail);

  const m = lm ?? am;
  if (!m) return null;
  const tagName = m[1];
  const lt = m.index;
  const absoluteLt = fromPos + lt;
  const nameEnd = absoluteLt + 1 + tagName.length;
  return { tagName, absoluteLt, nameEnd };
}

/**
 * Walk forward from nameEnd past attributes (handling string + brace nesting)
 * until the matching `>`. Return that segment so we can check whether
 * `data-kit-component=` is already present.
 */
function readOpeningTagAttrs(src, nameEnd) {
  let i = nameEnd;
  let depth = 0;
  let inString = null;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === ">") {
      return src.slice(nameEnd, i);
    }
    i++;
  }
  return null;
}

function processFile(filePath, dryRun) {
  const original = readFileSync(filePath, "utf8");
  let src = original;
  const exports = findExportedComponents(src);
  if (exports.length === 0)
    return { file: filePath, status: "no-exports", exports: [] };

  // Process from LAST export back to FIRST so injecting earlier text doesn't
  // shift positions of later exports we already located.
  exports.sort((a, b) => b.pos - a.pos);

  const results = [];
  for (const exp of exports) {
    const root = findFirstJsxRoot(src, exp.pos);
    if (!root) {
      results.push({ name: exp.name, status: "no-jsx-found" });
      continue;
    }
    const attrs = readOpeningTagAttrs(src, root.nameEnd);
    if (attrs === null) {
      results.push({ name: exp.name, status: "tag-unclosed" });
      continue;
    }
    if (attrs.includes("data-kit-component=")) {
      results.push({
        name: exp.name,
        status: "already-present",
        tag: root.tagName,
      });
      continue;
    }
    const injection = ` data-kit-component="${exp.name}"`;
    src = src.slice(0, root.nameEnd) + injection + src.slice(root.nameEnd);
    results.push({ name: exp.name, status: "applied", tag: root.tagName });
  }

  // Restore source order in the report (we processed reverse-sorted).
  results.reverse();

  if (src !== original && !dryRun) {
    writeFileSync(filePath, src, "utf8");
  }
  return {
    file: filePath,
    status: src === original ? "noop" : dryRun ? "would-modify" : "modified",
    exports: results,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    console.error(
      "Usage: retrofit-ui-kit-data-attrs.mjs <projectDir> [--dry-run]",
    );
    process.exit(2);
  }
  const projectDir = positional[0];
  const uiKitRoot = join(projectDir, "packages", "ui-kit", "src");
  const primitivesDir = join(uiKitRoot, "primitives");
  const layoutsDir = join(uiKitRoot, "layouts");

  if (!existsSync(uiKitRoot)) {
    console.error(`Not found: ${uiKitRoot}`);
    process.exit(2);
  }

  const files = [...walk(primitivesDir), ...walk(layoutsDir)];
  console.log(`Project: ${projectDir}`);
  console.log(`Scanning ${files.length} .tsx files`);
  console.log("");

  const summary = {
    files: 0,
    modifiedFiles: 0,
    applied: 0,
    alreadyPresent: 0,
    noJsx: 0,
    tagUnclosed: 0,
  };

  for (const f of files) {
    const r = processFile(f, dryRun);
    if (r.status === "no-exports") continue;
    summary.files++;
    if (r.status === "modified" || r.status === "would-modify")
      summary.modifiedFiles++;

    const rel = relative(projectDir, f).replace(/\\/g, "/");
    const exportSummary = r.exports
      .map((e) => {
        if (e.status === "applied") {
          summary.applied++;
          return `${e.name}:${e.tag}`;
        }
        if (e.status === "already-present") {
          summary.alreadyPresent++;
          return `${e.name}:already`;
        }
        if (e.status === "no-jsx-found") {
          summary.noJsx++;
          return `${e.name}:no-jsx`;
        }
        if (e.status === "tag-unclosed") {
          summary.tagUnclosed++;
          return `${e.name}:tag-unclosed`;
        }
        return `${e.name}:${e.status}`;
      })
      .join(" ");
    const tag =
      r.status === "modified"
        ? "[MOD]"
        : r.status === "would-modify"
          ? "[DRY]"
          : "[NOOP]";
    console.log(`  ${tag} ${rel}  ${exportSummary}`);
  }

  console.log("");
  console.log(
    `Summary: ${summary.modifiedFiles}/${summary.files} files ${dryRun ? "would be modified" : "modified"}`,
  );
  console.log(
    `  applied=${summary.applied}  already-present=${summary.alreadyPresent}  no-jsx=${summary.noJsx}  tag-unclosed=${summary.tagUnclosed}`,
  );
}

main();
