#!/usr/bin/env node
// Audit: external CDN URLs MUST NOT appear in screens HTML or shared-preamble (bug-008).
//
// Empirical motivator: test-app Mode B Run 2 (2026-05-30) had 5 features
// cascade-fail E2E tester at wall-clock-1800000ms because apps/web/app/page.tsx
// loaded external CDN images (picsum.photos + unsplash.com) that blocked
// window.load. Tester correctly diagnosed but the underlying source — the
// screens preamble explicitly prescribing external URLs with "NO substitutions"
// directives — propagated the pattern silently to every builder.
//
// Exit 0 = clean; exit 1 = at least one violation. Output is structured JSON
// + a human summary on stderr so /screens can route per-screen retries.
//
// Invocation (from project cwd):
//   node $FACTORY_ROOT/scripts/audit-screens-external-cdn-urls.mjs
//
// Cross-project agnostic: reads docs/screens/.shared-preamble.md +
// docs/screens/**/*.html from the cwd. No project-specific config.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FORBIDDEN_HOSTS = [
  { pattern: /picsum\.photos/g, name: "picsum.photos" },
  { pattern: /images\.unsplash\.com/g, name: "images.unsplash.com" },
  { pattern: /(?<!images\.)unsplash\.com/g, name: "unsplash.com" },
  { pattern: /googleusercontent\.com/g, name: "googleusercontent.com" },
  { pattern: /gravatar\.com/g, name: "gravatar.com" },
  { pattern: /(?:via\.)?placeholder\.com/g, name: "placeholder.com" },
  { pattern: /placekitten\.com/g, name: "placekitten.com" },
  { pattern: /placebear\.com/g, name: "placebear.com" },
  { pattern: /placedog\.net/g, name: "placedog.net" },
  { pattern: /loremflickr\.com/g, name: "loremflickr.com" },
  { pattern: /dummyimage\.com/g, name: "dummyimage.com" },
];

function walk(dir, exts = [".html", ".md"]) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...walk(p, exts));
    } else if (exts.some((e) => p.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

function scanFile(path) {
  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, name } of FORBIDDEN_HOSTS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        hits.push({ line: i + 1, host: name, text: line.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

function main() {
  const cwd = process.cwd();
  const screensDir = join(cwd, "docs", "screens");
  const preamble = join(screensDir, ".shared-preamble.md");

  if (!existsSync(screensDir)) {
    console.error(
      `[audit-screens-external-cdn-urls] docs/screens/ not found in ${cwd} — nothing to audit.`,
    );
    process.exit(0);
  }

  const files = [];
  if (existsSync(preamble)) files.push(preamble);
  files.push(...walk(screensDir, [".html"]));

  const findings = {};
  let violationCount = 0;
  for (const f of files) {
    const hits = scanFile(f);
    if (hits.length > 0) {
      const rel = relative(cwd, f).replace(/\\/g, "/");
      findings[rel] = hits;
      violationCount += hits.length;
    }
  }

  const result = {
    success: violationCount === 0,
    filesScanned: files.length,
    violationCount,
    failedFiles: Object.keys(findings),
    findings,
  };

  if (violationCount === 0) {
    console.error(
      `[audit-screens-external-cdn-urls] clean — ${files.length} files scanned; 0 forbidden CDN URLs.`,
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.error(
    `[audit-screens-external-cdn-urls] FAILED — ${violationCount} forbidden CDN URL hit(s) across ${result.failedFiles.length} file(s):`,
  );
  for (const [file, hits] of Object.entries(findings)) {
    console.error(`  ${file}:`);
    for (const h of hits.slice(0, 5)) {
      console.error(`    line ${h.line} [${h.host}]: ${h.text}`);
    }
    if (hits.length > 5) {
      console.error(`    ... +${hits.length - 5} more in this file`);
    }
  }
  console.error(
    `Fix: replace external CDN URLs with local /placeholders/*.jpg paths ` +
      `per /screens §Imagery convention (bug-008).`,
  );
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

main();
