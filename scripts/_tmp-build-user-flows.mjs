import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root =
  "C:/Development/ps/claude/claude_/agentflow_phase2/projects/reading-log-01";

const brief = JSON.parse(
  readFileSync(join(root, "docs/brief-summary.json"), "utf8"),
);
const screensManifest = JSON.parse(
  readFileSync(join(root, "docs/screens-manifest.json"), "utf8"),
);
const vrReport = JSON.parse(
  readFileSync(join(root, "docs/visual-review/report.json"), "utf8"),
);
const uiKitPkg = JSON.parse(
  readFileSync(join(root, "packages/ui-kit/package.json"), "utf8"),
);
const template = readFileSync(
  "C:/Development/ps/claude/claude_/agentflow_phase2/.claude/templates/user-flows-template.html",
  "utf8",
);

const canonicalHash = (obj) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const screensManifestHash = canonicalHash(screensManifest.files);
const visualReviewReportHash = canonicalHash(vrReport);

const statusByScreen = {};
for (const s of vrReport.screens)
  statusByScreen[`${s.platform}/${s.screenId}`] = s.status;

const screenTitle = {
  "books-list": "Library",
  "books-list-empty": "Library (Empty State)",
  "book-detail": "Book Detail",
  "book-create": "Add Book (Modal)",
  "tags-manage": "Tags",
  settings: "Settings",
};

const makeStep = (screenId) => ({
  screenId,
  platform: "webapp",
  file: `docs/screens/webapp/${screenId}.html`,
  status: statusByScreen[`webapp/${screenId}`] || "not-reviewed",
  title: screenTitle[screenId] || screenId,
});

const flows = [
  {
    id: "flow-1",
    platform: "webapp",
    name: "First-time setup",
    description:
      "Convert an empty library into a populated one. User opens / for the first time, hits the empty state, adds their first book via the modal, and reloads to confirm persistence.",
    primaryPersona: "solo-reader",
    steps: [
      makeStep("books-list-empty"),
      makeStep("book-create"),
      makeStep("books-list"),
    ],
    interactions: [
      { kind: "navigate", to: "/" },
      { kind: "click", selector: 'role=button[name="Add your first book"]' },
      {
        kind: "fill",
        selector: 'input[placeholder="e.g. The Overstory"]',
        value: "The Overstory",
      },
      {
        kind: "fill",
        selector: 'input[placeholder="e.g. Richard Powers"]',
        value: "Richard Powers",
      },
      { kind: "click", selector: 'role=button[name="Save book"]' },
      { kind: "waitForResponse", urlPattern: "/api/books", status: 200 },
      { kind: "assertVisible", selector: '[data-screen-id="books-list"]' },
    ],
    seedingTier: "mutation",
  },
  {
    id: "flow-2",
    platform: "webapp",
    name: "Rate and tag",
    description:
      "Apply a rating and a tag to an existing book. Rating updates inline; new tag is created and linked.",
    primaryPersona: "solo-reader",
    steps: [makeStep("books-list"), makeStep("book-detail")],
    interactions: [
      { kind: "navigate", to: "/" },
      { kind: "click", selector: "role=link[name=/The Overstory/i]" },
      { kind: "click", selector: '[aria-label="Edit rating"] >> nth=4' },
      { kind: "waitForResponse", urlPattern: "/api/books/", status: 200 },
      { kind: "assertVisible", selector: '[data-screen-id="book-detail"]' },
    ],
    seedingTier: "mutation",
  },
  {
    id: "flow-3",
    platform: "webapp",
    name: "Edit notes",
    description:
      "Add markdown notes to a book; auto-save on blur; confirm rendering on reload.",
    primaryPersona: "solo-reader",
    steps: [makeStep("books-list"), makeStep("book-detail")],
    interactions: [
      { kind: "navigate", to: "/" },
      { kind: "click", selector: "role=link[name=/Project Hail Mary/i]" },
      { kind: "click", selector: '[data-kit-component="Textarea"]' },
      {
        kind: "fill",
        selector: '[data-kit-component="Textarea"]',
        value: "Loved this book — propulsive sci-fi.",
      },
      { kind: "click", selector: 'role=heading[name="Notes"]' },
      { kind: "waitForResponse", urlPattern: "/api/books/", status: 200 },
      { kind: "assertVisible", selector: '[data-kit-component="Textarea"]' },
    ],
    seedingTier: "mutation",
  },
  {
    id: "flow-4",
    platform: "webapp",
    name: "Search and filter",
    description:
      "Narrow the library list with a search query, tag chip filter, and segmented status control.",
    primaryPersona: "solo-reader",
    steps: [makeStep("books-list")],
    interactions: [
      { kind: "navigate", to: "/" },
      { kind: "fill", selector: 'input[type="search"]', value: "overstory" },
      { kind: "waitForResponse", urlPattern: "/api/books", status: 200 },
      { kind: "assertVisible", selector: '[data-screen-id="books-list"]' },
    ],
    seedingTier: "read-only",
  },
  {
    id: "flow-5",
    platform: "webapp",
    name: "Delete book",
    description:
      "Remove a book from the library with a confirm dialog gate; redirect to library; confirm removal across reload.",
    primaryPersona: "solo-reader",
    steps: [
      makeStep("books-list"),
      makeStep("book-detail"),
      makeStep("books-list"),
    ],
    interactions: [
      { kind: "navigate", to: "/" },
      { kind: "click", selector: "role=link[name=/Project Hail Mary/i]" },
      { kind: "click", selector: 'role=button[name="Delete book"]' },
      { kind: "click", selector: "role=button[name=/Confirm|Delete/i]" },
      { kind: "waitForResponse", urlPattern: "/api/books/", status: 200 },
      { kind: "assertUrlMatches", pattern: "^/$" },
    ],
    seedingTier: "mutation",
  },
  {
    id: "flow-6",
    platform: "webapp",
    name: "Settings and tag management",
    description:
      "Rename a tag, configure default sort and theme. Catch-all flow covering tags-manage + settings — auxiliary screens not in the brief's 5 deterministic E2E flows.",
    primaryPersona: "solo-reader",
    steps: [
      makeStep("books-list"),
      makeStep("tags-manage"),
      makeStep("settings"),
    ],
    interactions: [
      { kind: "navigate", to: "/tags" },
      { kind: "click", selector: 'role=button[name="Rename tag"] >> nth=0' },
      { kind: "fill", selector: 'input[value="fiction"]', value: "novels" },
      { kind: "click", selector: 'role=button[name="Save"]' },
      { kind: "waitForResponse", urlPattern: "/api/tags/", status: 200 },
      { kind: "navigate", to: "/settings" },
      { kind: "click", selector: 'role=button[name="Title (A-Z)"]' },
      { kind: "waitForResponse", urlPattern: "/api/settings", status: 200 },
      { kind: "assertVisible", selector: '[data-screen-id="settings"]' },
    ],
    seedingTier: "mutation",
  },
];

const personasWithFlows = brief.personas.map((p) => ({
  id: p.id,
  name: p.name,
  primaryGoal: p.primaryGoal,
  flowIds: flows.filter((f) => f.primaryPersona === p.id).map((f) => f.id),
}));

const statusCounts = {
  pass: 0,
  fail: 0,
  "needs-human-review": 0,
  "not-reviewed": 0,
};
for (const s of vrReport.screens)
  statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;

const manifest = {
  version: "1.0",
  schemaVersion: "2.0",
  generatedAt: new Date().toISOString(),
  projectName: brief.projectName,
  platforms: brief.detectedPlatforms,
  uiKitVersion: uiKitPkg.version,
  screensManifestHash,
  visualReviewReportHash,
  flows,
  personas: personasWithFlows,
  screensCounts: {
    total: screensManifest.totalScreens,
    pass: statusCounts.pass || 0,
    fail: statusCounts.fail || 0,
    "needs-human-review": statusCounts["needs-human-review"] || 0,
  },
};

writeFileSync(
  join(root, "docs/user-flows-manifest.json"),
  JSON.stringify(manifest, null, 2),
);

let viewer = template
  .replaceAll("{{PROJECT_NAME}}", brief.projectName)
  .replaceAll("{{UI_KIT_VERSION}}", uiKitPkg.version)
  .replaceAll("{{SCREENS_MANIFEST_HASH}}", screensManifestHash)
  .replaceAll("{{VISUAL_REVIEW_REPORT_HASH}}", visualReviewReportHash)
  .replaceAll("{{SCREENS_COUNT}}", String(screensManifest.totalScreens))
  .replaceAll("{{GATE_API_BASE}}", "")
  .replace("{{MANIFEST_JSON}}", JSON.stringify(manifest));

const viewerPath = join(root, "docs/user-flows.html");
writeFileSync(viewerPath, viewer);

const remaining = viewer.match(/\{\{[A-Z_]+\}\}/g) || [];
const sizeKB = (statSync(viewerPath).size / 1024).toFixed(1);

console.log(
  JSON.stringify(
    {
      success: true,
      viewerPath: "docs/user-flows.html",
      manifestPath: "docs/user-flows-manifest.json",
      viewerSizeKB: sizeKB,
      unresolvedPlaceholders: remaining,
      flowsCovered: flows.length,
      flowsWithInteractions: flows.filter(
        (f) => f.interactions && f.interactions.length > 0,
      ).length,
      seedingTierCounts: {
        "read-only": flows.filter((f) => f.seedingTier === "read-only").length,
        mutation: flows.filter((f) => f.seedingTier === "mutation").length,
      },
      schemaVersion: manifest.schemaVersion,
      screensLinked: screensManifest.totalScreens,
      screensByStatus: statusCounts,
      screensManifestHash,
      visualReviewReportHash,
      personasCovered: personasWithFlows.length,
    },
    null,
    2,
  ),
);
