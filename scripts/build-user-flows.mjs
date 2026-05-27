#!/usr/bin/env node
// Assemble docs/user-flows.html + docs/user-flows-manifest.json for a project.
// Usage: node scripts/build-user-flows.mjs projects/<name> [--gate-api-base URL]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [, , projectArg, ...rest] = process.argv;
if (!projectArg) {
  console.error("usage: node build-user-flows.mjs projects/<name>");
  process.exit(1);
}
const gateApiBase =
  rest.find((a, i) => rest[i - 1] === "--gate-api-base") ||
  "http://localhost:4400";

const projectDir = path.resolve(projectArg);
const docsDir = `${projectDir}/docs`;

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function readJSON(p) {
  return JSON.parse(read(p));
}
function exists(p) {
  return fs.existsSync(p);
}

// --- Step 1: Archive prior ---
const priorViewer = `${docsDir}/user-flows.html`;
let archivedFrom = null;
if (exists(priorViewer)) {
  const archiveDir = `${docsDir}/user-flows-archive`;
  fs.mkdirSync(archiveDir, { recursive: true });
  const mtime = fs
    .statSync(priorViewer)
    .mtime.toISOString()
    .replace(/[:.]/g, "-");
  archivedFrom = `${archiveDir}/${mtime}.html`;
  fs.copyFileSync(priorViewer, archivedFrom);
}

// --- Step 2: Read inputs ---
const briefSummary = readJSON(`${docsDir}/brief-summary.json`);
const selectedStyle = readJSON(`${docsDir}/selected-style.json`);
const screensManifest = readJSON(`${docsDir}/screens-manifest.json`);
const vrReport = readJSON(`${docsDir}/visual-review/report.json`);
const kitPkg = readJSON(`${projectDir}/packages/ui-kit/package.json`);
const templatePath = path.resolve(".claude/templates/user-flows-template.html");
const template = read(templatePath);

// --- Step 2b: Parse flows from each platform's flows.md ---
// Flows are TASK-ORIENTED (Onboarding, Purchase, etc.), not persona narratives.
// Preferred format: `## Flow N: Name` sections with a `**Screens**:` line
// containing the sequence (e.g. `1. [home] → 2. [about] → 3. [contact]`).
// Each flow may name a `**Primary persona**:` for badging; personas don't
// define flows — tasks do.
function extractFlowsForPlatform(platform) {
  const flowsPath = `${docsDir}/analysis/${platform}/flows.md`;
  if (!exists(flowsPath)) return [];
  const text = read(flowsPath);

  // Structured: `## Flow N: Name` sections. This is the canonical shape.
  const flowSections = text.split(/^## Flow \d+:\s*/m).slice(1);
  const result = [];
  for (const section of flowSections) {
    const firstLine = section.split("\n")[0].trim();
    if (!firstLine) continue;
    const name = firstLine;

    // Screens line — accept:
    //   [screen-id]           (bracketed — clari/hatch format)
    //   `screen-id`           (backticked — markdown inline code)
    //   `screen-id.html`      (backticked with extension — Analyst spec format)
    // inside the arrow-separated sequence.
    const screensMatch = section.match(
      /\*\*Screens\*\*:?([\s\S]*?)(?=\n\n|\n\*\*|$)/,
    );
    if (!screensMatch) continue;
    const screensBlock = screensMatch[1];
    // Try brackets first, then backticks
    let screenIds = [...screensBlock.matchAll(/\[([a-z0-9][a-z0-9-]*)\]/g)].map(
      (m) => m[1],
    );
    if (screenIds.length === 0) {
      screenIds = [
        ...screensBlock.matchAll(/`([a-z0-9][a-z0-9-]*?)(?:\.html)?`/g),
      ].map((m) => m[1]);
    }
    if (screenIds.length === 0) continue;

    // Purpose — one-liner describing the task
    const purposeMatch = section.match(
      /\*\*Purpose\*\*:?([\s\S]*?)(?=\n\*\*|\n\n|$)/,
    );
    const purpose = purposeMatch
      ? purposeMatch[1].trim().replace(/\s+/g, " ").slice(0, 240)
      : "";

    // Primary persona — optional badge metadata
    const personaMatch = section.match(
      /\*\*Primary persona\*\*:?\s*([^\n;]+?)(?:;|\n|$)/,
    );
    const primaryPersona = personaMatch
      ? personaMatch[1].trim().split(/[\s(]/)[0].toLowerCase()
      : null;

    result.push({
      platform,
      name,
      description: purpose,
      primaryPersona,
      screenIds,
    });
  }
  return result;
}

const allFlows = [];
for (const platform of briefSummary.detectedPlatforms) {
  allFlows.push(...extractFlowsForPlatform(platform));
}

// --- Step 3: Walk docs/screens/**/*.html → screenId → path map ---
function walkHtml(dir) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const screenFiles = walkHtml(`${docsDir}/screens`).map((p) =>
  p.replace(/\\/g, "/").replace(`${projectDir.replace(/\\/g, "/")}/`, ""),
);
const screenMap = new Map(); // key "platform/screenId" → rel path
for (const rel of screenFiles) {
  const parts = rel.split("/");
  const platform = parts[2];
  const screenId = parts[3].replace(".html", "");
  screenMap.set(`${platform}/${screenId}`, rel);
}

// --- Step 4: Attach VR status per screen ---
const vrStatus = new Map(); // key → {status, issues}
for (const s of vrReport.screens || []) {
  vrStatus.set(`${s.platform}/${s.screenId}`, {
    status: s.status,
    issues: s.issues || [],
  });
}

// --- Step 5: Build manifest ---
// Flows are the primary organizational unit. Personas are metadata —
// `primaryPersona` tags a flow for filtering but doesn't define the flow.
const warnings = [];
const flows = allFlows.map((f, idx) => {
  const steps = f.screenIds.map((sid) => {
    const key = `${f.platform}/${sid}`;
    const file = screenMap.get(key) || null;
    const vr = vrStatus.get(key);
    if (!file) {
      warnings.push(`Flow '${f.name}' references missing screen: ${key}`);
    }
    return {
      screenId: sid,
      platform: f.platform,
      file: file || `docs/screens/${f.platform}/${sid}.html`,
      status: vr ? vr.status : "not-reviewed",
      title: sid.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    };
  });
  return {
    id: `flow-${idx + 1}`,
    platform: f.platform,
    name: f.name,
    description: f.description,
    primaryPersona: f.primaryPersona,
    steps,
  };
});

// Personas are surfaced as metadata for filtering — each persona lists the
// flows tagged to them, but the flows array above is the source of truth.
const personas = briefSummary.personas.map((p) => ({
  id: p.id,
  name: p.name,
  primaryGoal: p.primaryGoal,
  flowIds: flows.filter((f) => f.primaryPersona === p.id).map((f) => f.id),
}));

// Status counts across all linked steps (deduped by unique screen)
const seenScreens = new Set();
const statusCounts = {
  pass: 0,
  fail: 0,
  "needs-human-review": 0,
  "not-reviewed": 0,
};
for (const f of flows) {
  for (const s of f.steps) {
    const key = `${s.platform}/${s.screenId}`;
    if (seenScreens.has(key)) continue;
    seenScreens.add(key);
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }
}

// --- Step 6: Compute hashes (canonical over sorted {path, sha256}) ---
function hashFileCanonical(jsonPath) {
  const j = JSON.parse(read(jsonPath));
  if (Array.isArray(j.files)) {
    const canonical = JSON.stringify(
      j.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    );
    return (
      "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex")
    );
  }
  // Fallback: hash the whole file bytes
  return (
    "sha256:" +
    crypto.createHash("sha256").update(fs.readFileSync(jsonPath)).digest("hex")
  );
}

const screensManifestHash = hashFileCanonical(
  `${docsDir}/screens-manifest.json`,
);
const visualReviewReportHash =
  "sha256:" +
  crypto.createHash("sha256").update(JSON.stringify(vrReport)).digest("hex");

const generatedAt = new Date().toISOString();

const manifest = {
  version: "1.0",
  generatedAt,
  projectName: briefSummary.projectName,
  platforms: briefSummary.detectedPlatforms,
  styleId: selectedStyle.styleId,
  uiKitVersion: kitPkg.version,
  screensManifestHash,
  visualReviewReportHash,
  flows, // primary organizational unit — task-oriented journeys
  personas, // metadata: which flows each persona is tagged to
  screensCounts: {
    total: screenFiles.length,
    ...statusCounts,
  },
};

fs.writeFileSync(
  `${docsDir}/user-flows-manifest.json`,
  JSON.stringify(manifest, null, 2),
);

// --- Step 7: Render viewer ---
const manifestJsonInline = JSON.stringify(manifest);

let viewer = template
  .replace(/\{\{PROJECT_NAME\}\}/g, briefSummary.projectName)
  .replace(/\{\{MANIFEST_JSON\}\}/g, manifestJsonInline)
  .replace(/\{\{UI_KIT_VERSION\}\}/g, kitPkg.version)
  .replace(/\{\{SCREENS_MANIFEST_HASH\}\}/g, screensManifestHash)
  .replace(/\{\{VISUAL_REVIEW_REPORT_HASH\}\}/g, visualReviewReportHash)
  .replace(/\{\{GATE_API_BASE\}\}/g, gateApiBase)
  .replace(/\{\{SCREENS_COUNT\}\}/g, String(screenFiles.length));

fs.writeFileSync(`${docsDir}/user-flows.html`, viewer);

// --- Step 8: Self-verify ---
const viewerBytes = fs.statSync(`${docsDir}/user-flows.html`).size;
const unresolvedMatch = viewer.match(/\{\{[A-Z_]+\}\}/);
const manifestValid = (() => {
  try {
    JSON.parse(read(`${docsDir}/user-flows-manifest.json`));
    return true;
  } catch {
    return false;
  }
})();

const selfCheck = {
  viewerBytes,
  viewerLargerThan4KB: viewerBytes > 4096,
  noUnresolvedPlaceholders: !unresolvedMatch,
  manifestValid,
};

if (
  !selfCheck.viewerLargerThan4KB ||
  !selfCheck.noUnresolvedPlaceholders ||
  !selfCheck.manifestValid
) {
  console.error("SELF-CHECK FAILED:", JSON.stringify(selfCheck, null, 2));
  if (unresolvedMatch) console.error("Unresolved:", unresolvedMatch[0]);
  process.exit(1);
}

// --- Step 9: Return JSON ---
console.log(
  JSON.stringify(
    {
      success: true,
      projectName: briefSummary.projectName,
      uiKitVersion: kitPkg.version,
      viewerPath: `${docsDir}/user-flows.html`.replace(`${projectDir}/`, ""),
      manifestPath: `${docsDir}/user-flows-manifest.json`.replace(
        `${projectDir}/`,
        "",
      ),
      archivedFrom,
      personasCovered: personas.length,
      flowsCovered: flows.length,
      flowsByName: flows.map((f) => ({
        name: f.name,
        steps: f.steps.length,
        primaryPersona: f.primaryPersona,
      })),
      screensLinked: [...seenScreens].length,
      screensByStatus: statusCounts,
      screensManifestHash,
      visualReviewReportHash,
      warnings,
      selfCheck,
    },
    null,
    2,
  ),
);
