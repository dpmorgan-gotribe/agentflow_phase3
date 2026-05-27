#!/usr/bin/env node
// Build docs/screens-manifest.json for a project — SHA-256 per file, canonical hash over sorted entries.
// Usage: node scripts/build-screens-manifest.mjs projects/<name>

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { globSync } from "node:fs";

const [, , projectArg] = process.argv;
if (!projectArg) {
  console.error("usage: node build-screens-manifest.mjs projects/<name>");
  process.exit(1);
}
const projectDir = projectArg.replace(/\\/g, "/");
const kitPkg = JSON.parse(
  fs.readFileSync(`${projectDir}/packages/ui-kit/package.json`, "utf8"),
);
const style = JSON.parse(
  fs.readFileSync(`${projectDir}/docs/selected-style.json`, "utf8"),
);

function walkHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const screensDir = `${projectDir}/docs/screens`;
const files = walkHtml(screensDir)
  .map((p) => p.replace(/\\/g, "/"))
  .sort();

const entries = files.map((p) => {
  const rel = p.replace(`${projectDir}/`, "");
  const bytes = fs.readFileSync(p);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const parts = rel.split("/");
  return {
    path: rel,
    platform: parts[2],
    screenId: parts[3].replace(".html", ""),
    sha256: sha,
    bytes: bytes.length,
  };
});

const totalBytes = entries.reduce((a, e) => a + e.bytes, 0);
const byPlatform = entries.reduce((a, e) => {
  a[e.platform] = (a[e.platform] || 0) + 1;
  return a;
}, {});

const canonical = JSON.stringify(
  entries.map((e) => ({ path: e.path, sha256: e.sha256 })),
);
const manifestHash =
  "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex");

const manifest = {
  version: "1.0",
  project: projectDir.split("/").pop(),
  generated: new Date().toISOString(),
  uiKitVersion: kitPkg.version,
  styleId: style.styleId,
  totalScreens: entries.length,
  platforms: byPlatform,
  totalBytes,
  screensManifestHash: manifestHash,
  files: entries,
};

fs.writeFileSync(
  `${projectDir}/docs/screens-manifest.json`,
  JSON.stringify(manifest, null, 2),
);

console.log(
  JSON.stringify(
    {
      path: `${projectDir}/docs/screens-manifest.json`,
      totalScreens: entries.length,
      byPlatform,
      manifestHash,
      totalBytes,
    },
    null,
    2,
  ),
);
