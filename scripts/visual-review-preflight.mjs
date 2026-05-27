#!/usr/bin/env node
// Pre-flight + static-server helper for /visual-review.
// Usage:
//   node scripts/visual-review-preflight.mjs check [projectDir]
//     → validates selected-style.json + screens-manifest.json + at-least-one-screen,
//       returns JSON { success, issues[], screens[] }. Exit 0 on success, 1 on fail.
//   node scripts/visual-review-preflight.mjs serve [projectDir] [port]
//     → spawns http-server on the first free port >= startPort, writes lockfile,
//       prints JSON { pid, port, lockfilePath }. Caller is responsible for SIGTERM
//       on the pid when done (or read the lockfile to recover it later).
//   node scripts/visual-review-preflight.mjs stop <lockfilePath>
//     → kills the pid from the lockfile and removes the lockfile.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const [, , cmd, ...rest] = process.argv;
const projectDir = rest[0] ? path.resolve(rest[0]) : process.cwd();

function die(reason, extra = {}) {
  console.log(JSON.stringify({ success: false, reason, ...extra }));
  process.exit(1);
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function exists(p) {
  return fs.existsSync(p);
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port++) {
    const free = await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${start}-${start + 99}`);
}

function check() {
  const issues = [];
  const selStyle = path.join(projectDir, "docs/selected-style.json");
  if (!exists(selStyle)) {
    issues.push(
      "missing docs/selected-style.json — run /mockups + HITL gate 2 (or /pick-style)",
    );
  } else {
    try {
      const json = JSON.parse(read(selStyle));
      if (!json.styleId || !/^style-\d+$/.test(json.styleId)) {
        issues.push(
          `selected-style.json has invalid styleId: ${json.styleId ?? "<missing>"}`,
        );
      }
    } catch (e) {
      issues.push(`selected-style.json is not valid JSON: ${e.message}`);
    }
  }

  const manifest = path.join(projectDir, "docs/screens-manifest.json");
  let screens = [];
  if (!exists(manifest)) {
    issues.push("missing docs/screens-manifest.json — run /screens");
  } else {
    try {
      const json = JSON.parse(read(manifest));
      if (!Array.isArray(json.files) || json.files.length === 0) {
        issues.push("screens-manifest.json has empty files[]");
      } else {
        screens = json.files.map((f) => ({
          platform: f.platform,
          screenId: f.screenId ?? path.basename(f.path, ".html"),
          path: f.path,
        }));
      }
    } catch (e) {
      issues.push(`screens-manifest.json is not valid JSON: ${e.message}`);
    }
  }

  const uiKit = path.join(projectDir, "packages/ui-kit/src/tokens/tokens.css");
  if (!exists(uiKit)) {
    issues.push(
      "missing packages/ui-kit/src/tokens/tokens.css — run /stylesheet",
    );
  }

  if (issues.length > 0) {
    die("preflight-failed", { issues });
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        projectDir,
        screens,
        screenCount: screens.length,
        selectedStyle: JSON.parse(read(selStyle)),
      },
      null,
      2,
    ),
  );
}

async function serve() {
  const startPort = Number.parseInt(rest[1] ?? "4173", 10);
  const port = await findFreePort(startPort);
  const pipelineDir = path.join(projectDir, "pipeline");
  fs.mkdirSync(pipelineDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lockfilePath = path.join(pipelineDir, `visual-review-${ts}.lockfile`);

  // Use http-server via npx — cross-platform, caches on first run.
  // Windows requires shell:true for .cmd shim resolution.
  const isWin = process.platform === "win32";
  const child = spawn(
    isWin ? "npx.cmd" : "npx",
    ["-y", "http-server", "-p", String(port), "-s", "--cors", "-c-1", "."],
    {
      cwd: projectDir,
      detached: !isWin,
      stdio: "ignore",
      windowsHide: true,
      shell: isWin,
    },
  );
  if (!isWin) child.unref();

  const lockfile = {
    pid: child.pid,
    port,
    rootDir: projectDir,
    startedAt: new Date().toISOString(),
    lockfilePath,
  };
  fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

  // Brief sleep then confirm the port is accepting connections.
  await new Promise((r) => setTimeout(r, 1500));

  console.log(JSON.stringify(lockfile, null, 2));
}

function stop() {
  const lockfilePath = rest[0];
  if (!lockfilePath || !exists(lockfilePath)) {
    die(`lockfile not found: ${lockfilePath ?? "<unspecified>"}`);
  }
  const lock = JSON.parse(read(lockfilePath));
  // On Windows, spawn with shell:true returns the pid of cmd.exe, not npx/http-server.
  // Use taskkill /T to kill the whole process tree.
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(lock.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-lock.pid); // detached + negative pid kills the whole group
    }
  } catch {
    // ignore — cleanup below
  }
  fs.unlinkSync(lockfilePath);
  console.log(JSON.stringify({ success: true, killed: lock.pid }));
}

switch (cmd) {
  case "check":
    check();
    break;
  case "serve":
    serve();
    break;
  case "stop":
    stop();
    break;
  default:
    die(`unknown command: ${cmd ?? "<none>"} — use check | serve | stop`);
}
