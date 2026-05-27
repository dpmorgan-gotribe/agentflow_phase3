#!/usr/bin/env node
/**
 * Snapshot a project under projects/<name>/ into projects/<name>-<suffix>/.
 * Preserves git history. Excludes transient runtime state.
 *
 * Usage: node scripts/snapshot-project.mjs <source-name> <target-name>
 */
import fs from "node:fs";
import path from "node:path";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error("Usage: snapshot-project.mjs <source-name> <target-name>");
  process.exit(1);
}

const root = path.resolve("projects");
const srcDir = path.join(root, src);
const dstDir = path.join(root, dst);

if (!fs.existsSync(srcDir)) {
  console.error(`Source ${srcDir} does not exist.`);
  process.exit(1);
}
if (fs.existsSync(dstDir)) {
  console.error(`Target ${dstDir} already exists; refusing to overwrite.`);
  process.exit(1);
}

// Names of directories to skip at any depth
const SKIP_DIRS = new Set([
  "node_modules",
  "pipeline",
  ".turbo",
  "dist",
  "build",
  ".next",
  "out",
  "storybook-static",
  ".vercel",
]);

// Specific paths (relative to project root) to skip
const SKIP_PATHS = new Set([".claude/state", ".claude/worktrees"]);

let filesCopied = 0;
let bytesCopied = 0;
let dirsCreated = 0;
const skipped = [];

function copy(srcPath, dstPath, relPath = "") {
  const stat = fs.lstatSync(srcPath);
  if (stat.isDirectory()) {
    const dirName = path.basename(srcPath);
    if (SKIP_DIRS.has(dirName)) {
      skipped.push(relPath);
      return;
    }
    if (SKIP_PATHS.has(relPath.replace(/\\/g, "/"))) {
      skipped.push(relPath);
      return;
    }
    fs.mkdirSync(dstPath, { recursive: true });
    dirsCreated++;
    for (const entry of fs.readdirSync(srcPath)) {
      copy(
        path.join(srcPath, entry),
        path.join(dstPath, entry),
        path.join(relPath, entry),
      );
    }
  } else if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(srcPath);
    fs.symlinkSync(link, dstPath);
    filesCopied++;
  } else if (stat.isFile()) {
    fs.copyFileSync(srcPath, dstPath);
    filesCopied++;
    bytesCopied += stat.size;
  }
}

const t0 = Date.now();
copy(srcDir, dstDir);
const elapsed = Date.now() - t0;

console.log(
  JSON.stringify(
    {
      success: true,
      source: srcDir,
      target: dstDir,
      filesCopied,
      dirsCreated,
      bytesCopied,
      megabytesCopied: (bytesCopied / 1024 / 1024).toFixed(2),
      skippedDirs: skipped,
      elapsedMs: elapsed,
    },
    null,
    2,
  ),
);
