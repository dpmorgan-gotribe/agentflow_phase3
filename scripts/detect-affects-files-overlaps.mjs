#!/usr/bin/env node
/**
 * Detect affects_files overlaps in a tasks.yaml via the bug-124 three-tier
 * algorithm (literal-equal, glob⇄glob, glob⇄literal). Read-only — does not
 * modify tasks.yaml.
 *
 * Output: a list of (featureA, featureB, sharedPath, tier) tuples, one per
 * pair that overlaps AND isn't already linked via depends_on. Useful as a
 * reference implementation for PM agents authoring §4b warnings.
 *
 * Usage: node scripts/detect-affects-files-overlaps.mjs <path/to/tasks.yaml>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/detect-affects-files-overlaps.mjs <path>");
  process.exit(1);
}

const parsed = yaml.load(readFileSync(resolve(input), "utf8"));
const features = parsed.features ?? [];

const isGlob = (p) => p.includes("*");

function globToRegex(glob) {
  // Escape regex metachars EXCEPT * (which we handle next), then convert
  // ** → .* and remaining single * → [^/]*
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withGlobs = escaped
    .replace(/\*\*/g, "§§DOUBLESTAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLESTAR§§/g, ".*");
  return new RegExp("^" + withGlobs + "$");
}

function overlap(a, b) {
  if (a === b) return { tier: "literal-equal", path: a };
  const aIsGlob = isGlob(a);
  const bIsGlob = isGlob(b);
  if (aIsGlob && !bIsGlob && globToRegex(a).test(b))
    return { tier: "glob-literal", path: a };
  if (bIsGlob && !aIsGlob && globToRegex(b).test(a))
    return { tier: "glob-literal", path: b };
  if (aIsGlob && bIsGlob) {
    // Crude approximation: if either glob's regex matches the other's literal-leftmost-prefix,
    // call it an overlap. Conservative.
    if (globToRegex(a).test(b) || globToRegex(b).test(a))
      return { tier: "glob-glob", path: a };
  }
  return null;
}

const overlaps = [];
for (let i = 0; i < features.length; i++) {
  for (let j = i + 1; j < features.length; j++) {
    const A = features[i];
    const B = features[j];
    if (
      (A.depends_on ?? []).includes(B.id) ||
      (B.depends_on ?? []).includes(A.id)
    ) {
      continue;
    }
    let found = null;
    outer: for (const a of A.affects_files ?? []) {
      for (const b of B.affects_files ?? []) {
        const ov = overlap(a, b);
        if (ov) {
          found = { A: A.id, B: B.id, ...ov };
          break outer;
        }
      }
    }
    if (found) overlaps.push(found);
  }
}

if (overlaps.length === 0) {
  console.log(
    `No overlaps detected. Suggested PM warning entry:\n  file-affinity-no-overlaps: ran 3-tier overlap check across ${features.length} features × ${(features.length * (features.length - 1)) / 2} pairs; no shared files detected`,
  );
} else {
  console.log(`${overlaps.length} overlap(s) detected:`);
  for (const o of overlaps) {
    console.log(
      `  ${o.A} <> ${o.B} : ${o.path} [${o.tier}]\n    suggested PM warning: file-affinity-serialization: ${o.A} and ${o.B} both touch ${o.path} — auto-added ${o.B} depends_on ${o.A}`,
    );
  }
}
