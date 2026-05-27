import { readFileSync, writeFileSync } from "node:fs";

const PROJECT = "finance-track-pre-build";
const ROOT = `./projects/${PROJECT}`;
const TEMPLATE = `${ROOT}/.claude/templates/user-flows-template.html`;
const MANIFEST = `${ROOT}/docs/user-flows-manifest.json`;
const OUT = `${ROOT}/docs/user-flows.html`;

const tpl = readFileSync(TEMPLATE, "utf8");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

const replacements = {
  "{{PROJECT_NAME}}": manifest.projectName,
  "{{UI_KIT_VERSION}}": manifest.uiKitVersion,
  "{{SCREENS_MANIFEST_HASH}}": manifest.screensManifestHash,
  "{{VISUAL_REVIEW_REPORT_HASH}}": manifest.visualReviewReportHash,
  "{{SCREENS_COUNT}}": String(manifest.screensCounts.total),
  "{{MANIFEST_JSON}}": JSON.stringify(manifest, null, 2),
  "{{GATE_API_BASE}}": "",
};

let html = tpl;
for (const [k, v] of Object.entries(replacements)) {
  html = html.split(k).join(v);
}

const remaining = html.match(/\{\{[A-Z_]+\}\}/g);
if (remaining) {
  console.error("Unresolved placeholders:", remaining);
  process.exit(1);
}

writeFileSync(OUT, html, "utf8");
const sizeKb = (html.length / 1024).toFixed(1);
console.log(`OK: wrote ${OUT} (${sizeKb} KB)`);
