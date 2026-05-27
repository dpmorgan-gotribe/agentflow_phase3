#!/usr/bin/env node
/**
 * aggregate-components.mjs
 *
 * Reads every docs/analysis/{platform}/screens.json file in the CWD, collects
 * component usage across all screens, classifies each component into one of
 * four tiers (primitive / pattern / layout / project-specific-composition),
 * and writes docs/analysis/shared/components.md.
 *
 * Invoked by /analyze phase 5 synthesis (step 6.5 — refactor post-components-gap).
 * Also runnable standalone: `node scripts/aggregate-components.mjs`.
 *
 * The output is the authoritative component catalog that /stylesheet reads to
 * guarantee preview coverage + HITL gate 3 binding on componentsApproved[].
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// ─── Canonical mapping — analyst-name → kit-name ───
// Drawn from /stylesheet SKILL.md's required primitives/patterns/layouts tables.

const CANONICAL_PRIMITIVES = {
  // Button
  button: "Button",
  "button-primary": "Button (variant: primary)",
  "button-secondary": "Button (variant: secondary)",
  "button-ghost": "Button (variant: ghost)",
  "button-destructive": "Button (variant: destructive)",
  "icon-button": "Button (variant: icon-only)",
  // Inputs
  input: "Input",
  "form-input": "Input",
  "text-input": "Input",
  "file-input": "Input (variant: file)",
  "search-bar": "Input (variant: search)",
  textarea: "Textarea",
  select: "Select",
  checkbox: "Checkbox",
  radio: "Radio",
  "radio-group": "Radio (RadioGroup)",
  switch: "Switch",
  toggle: "Switch",
  slider: "Slider",
  // Surfaces
  card: "Card",
  dialog: "Dialog",
  modal: "Dialog",
  drawer: "Drawer",
  popover: "Popover",
  tooltip: "Tooltip",
  toast: "Toast",
  // Displays
  badge: "Badge",
  chip: "Badge (variant: chip/pill)",
  avatar: "Avatar",
  skeleton: "Skeleton",
  separator: "Separator",
  divider: "Separator",
  // Nav
  tabs: "Tabs",
  "tab-bar": "Tabs",
  "segmented-control": "Tabs (variant: segmented)",
  accordion: "Accordion",
};

const CANONICAL_PATTERNS = {
  "empty-state": "EmptyState",
  "error-state": "ErrorState",
  "data-table": "DataTable",
  table: "DataTable",
  "form-field": "FormField",
  "page-header": "PageHeader",
  breadcrumbs: "Breadcrumbs",
  "search-combobox": "SearchCombobox",
  "command-palette": "CommandPalette",
  "file-uploader": "FileUploader",
  "filter-bar": "FilterBar",
  pagination: "Pagination",
  notification: "Notification",
  // Close adjacents worth mapping (with note)
  "notification-banner": "Notification (variant: banner)",
};

const CANONICAL_LAYOUTS = {
  "app-shell": "AppShell",
  header: "AppShell (header slot)",
  "side-menu": "AppShell (sidebar slot)",
  sidebar: "AppShell (sidebar slot)",
  "split-view": "SplitView",
  "focused-task": "FocusedTask",
  marketing: "Marketing",
  auth: "Auth",
  "auth-layout": "Auth",
};

// ─── Inputs ───

function findScreensFiles() {
  const analysisDir = path.join(ROOT, "docs", "analysis");
  if (!fs.existsSync(analysisDir)) return [];
  const platforms = fs
    .readdirSync(analysisDir)
    .filter(
      (d) =>
        d !== "shared" &&
        fs.statSync(path.join(analysisDir, d)).isDirectory() &&
        fs.existsSync(path.join(analysisDir, d, "screens.json")),
    );
  return platforms.map((p) => ({
    platform: p,
    path: path.join(analysisDir, p, "screens.json"),
  }));
}

function loadScreens(file) {
  const txt = fs.readFileSync(file, "utf8");
  const json = JSON.parse(txt);
  // v3.0 schema: top-level `app.screens[]`; legacy: top-level `screens[]`
  return json.app?.screens || json.screens || [];
}

// ─── Classification ───

function classify(component) {
  const key = component.toLowerCase().trim();
  if (CANONICAL_PRIMITIVES[key]) {
    return { tier: "primitive", kitName: CANONICAL_PRIMITIVES[key] };
  }
  if (CANONICAL_PATTERNS[key]) {
    return { tier: "pattern", kitName: CANONICAL_PATTERNS[key] };
  }
  if (CANONICAL_LAYOUTS[key]) {
    return { tier: "layout", kitName: CANONICAL_LAYOUTS[key] };
  }
  return { tier: "project-specific", kitName: null };
}

// ─── Aggregate ───

function aggregate(screensFiles) {
  /** @type Map<component, { screenCount, platforms: Set, screenIds: Set }> */
  const index = new Map();

  for (const { platform, path: file } of screensFiles) {
    const screens = loadScreens(file);
    for (const screen of screens) {
      for (const c of screen.components || []) {
        const key = c.toLowerCase().trim();
        if (!index.has(key)) {
          index.set(key, {
            screenCount: 0,
            platforms: new Set(),
            screenIds: new Set(),
          });
        }
        const rec = index.get(key);
        rec.screenCount++;
        rec.platforms.add(platform);
        rec.screenIds.add(`${platform}/${screen.id}`);
      }
    }
  }
  return index;
}

function renderMarkdown(index, projectName, screensFiles) {
  const lines = [];
  const tiers = {
    primitive: [],
    pattern: [],
    layout: [],
    "project-specific": [],
  };

  for (const [name, rec] of index) {
    const cls = classify(name);
    tiers[cls.tier].push({
      name,
      kitName: cls.kitName,
      screenCount: rec.screenCount,
      platforms: [...rec.platforms].sort(),
    });
  }
  for (const arr of Object.values(tiers)) {
    arr.sort((a, b) => b.screenCount - a.screenCount);
  }

  const totalScreens = screensFiles.reduce(
    (n, f) => n + loadScreens(f.path).length,
    0,
  );
  const totalComponents = index.size;

  lines.push(`# Components Catalog — ${projectName || "project"}`);
  lines.push("");
  lines.push(
    `<!-- generated by scripts/aggregate-components.mjs from docs/analysis/{platform}/screens.json -->`,
  );
  lines.push(
    `<!-- read by /stylesheet to guarantee full component coverage in the design-system-preview + gate 3 componentsApproved binding -->`,
  );
  lines.push("");
  lines.push(
    `**Stats**: ${totalComponents} unique components across ${totalScreens} screens on ${screensFiles.length} platforms (${screensFiles.map((f) => f.platform).join(", ")}).`,
  );
  lines.push("");

  // Tier 1 — Primitives
  lines.push("## Primitives (map to canonical kit primitives)");
  lines.push("");
  if (tiers.primitive.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push("| Analyst name | Kit component | Screens | Platforms |");
    lines.push("| --- | --- | ---: | --- |");
    for (const c of tiers.primitive) {
      lines.push(
        `| \`${c.name}\` | **${c.kitName}** | ${c.screenCount} | ${c.platforms.join(", ")} |`,
      );
    }
  }
  lines.push("");

  // Tier 2 — Patterns
  lines.push("## Patterns (composed from primitives)");
  lines.push("");
  if (tiers.pattern.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push("| Analyst name | Kit component | Screens | Platforms |");
    lines.push("| --- | --- | ---: | --- |");
    for (const c of tiers.pattern) {
      lines.push(
        `| \`${c.name}\` | **${c.kitName}** | ${c.screenCount} | ${c.platforms.join(", ")} |`,
      );
    }
  }
  lines.push("");

  // Tier 3 — Layouts
  lines.push("## Layouts (page shells + nav slots)");
  lines.push("");
  if (tiers.layout.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push("| Analyst name | Kit component | Screens | Platforms |");
    lines.push("| --- | --- | ---: | --- |");
    for (const c of tiers.layout) {
      lines.push(
        `| \`${c.name}\` | **${c.kitName}** | ${c.screenCount} | ${c.platforms.join(", ")} |`,
      );
    }
  }
  lines.push("");

  // Tier 4 — Project-specific
  lines.push(
    "## Project-specific compositions (custom — no canonical kit mapping)",
  );
  lines.push("");
  lines.push(
    "> These components don't map to the kit's canonical 20 primitives / 12 patterns / 5 layouts.",
    "> `/stylesheet` MUST generate a custom pattern file + story for each so the HITL gate 3 reviewer can approve look-and-feel BEFORE `/screens` composes them across hundreds of screens.",
  );
  lines.push("");
  if (tiers["project-specific"].length === 0) {
    lines.push(
      "_None — every component used maps to a canonical kit position._",
    );
  } else {
    lines.push("| Component | Screens | Platforms | Notes for /stylesheet |");
    lines.push("| --- | ---: | --- | --- |");
    for (const c of tiers["project-specific"]) {
      const screenCap =
        c.screenCount >= 20
          ? " (high-traffic — prioritise)"
          : c.screenCount >= 5
            ? ""
            : " (low-traffic — minimum coverage ok)";
      lines.push(
        `| \`${c.name}\` | ${c.screenCount} | ${c.platforms.join(", ")} | generate custom pattern${screenCap} |`,
      );
    }
  }
  lines.push("");

  // Coverage summary for /stylesheet
  const primitivesUsed = new Set(
    tiers.primitive.map((c) => c.kitName.split(" ")[0]),
  );
  const patternsUsed = new Set(
    tiers.pattern.map((c) => c.kitName.split(" ")[0]),
  );

  const CANON_PRIM_NAMES = [
    "Button",
    "Input",
    "Textarea",
    "Select",
    "Checkbox",
    "Radio",
    "Switch",
    "Slider",
    "Card",
    "Dialog",
    "Drawer",
    "Popover",
    "Tooltip",
    "Toast",
    "Badge",
    "Avatar",
    "Skeleton",
    "Separator",
    "Tabs",
    "Accordion",
  ];
  const CANON_PAT_NAMES = [
    "EmptyState",
    "ErrorState",
    "DataTable",
    "FormField",
    "PageHeader",
    "Breadcrumbs",
    "SearchCombobox",
    "CommandPalette",
    "FileUploader",
    "FilterBar",
    "Pagination",
    "Notification",
  ];
  const unusedPrimitives = CANON_PRIM_NAMES.filter(
    (p) => !primitivesUsed.has(p),
  );
  const unusedPatterns = CANON_PAT_NAMES.filter((p) => !patternsUsed.has(p));

  lines.push("## Coverage summary for /stylesheet");
  lines.push("");
  lines.push(
    `- **Primitives used by analyst**: ${primitivesUsed.size} / ${CANON_PRIM_NAMES.length} canonical (${[...primitivesUsed].sort().join(", ")})`,
  );
  if (unusedPrimitives.length) {
    lines.push(
      `- **Canonical primitives NOT used**: ${unusedPrimitives.join(", ")} — still generate (available for future screens) but low priority in preview ordering`,
    );
  }
  lines.push(
    `- **Patterns used by analyst**: ${patternsUsed.size} / ${CANON_PAT_NAMES.length} canonical`,
  );
  if (unusedPatterns.length) {
    lines.push(
      `- **Canonical patterns NOT used**: ${unusedPatterns.join(", ")}`,
    );
  }
  lines.push(
    `- **Project-specific compositions to generate**: ${tiers["project-specific"].length}`,
  );
  lines.push("");

  // Machine-readable JSON trailer
  lines.push("## Machine-readable catalog (parsed by /stylesheet)");
  lines.push("");
  lines.push("```json");
  const catalog = {
    primitives: tiers.primitive.map((c) => ({
      name: c.name,
      kitName: c.kitName,
      screenCount: c.screenCount,
    })),
    patterns: tiers.pattern.map((c) => ({
      name: c.name,
      kitName: c.kitName,
      screenCount: c.screenCount,
    })),
    layouts: tiers.layout.map((c) => ({
      name: c.name,
      kitName: c.kitName,
      screenCount: c.screenCount,
    })),
    projectSpecific: tiers["project-specific"].map((c) => ({
      name: c.name,
      screenCount: c.screenCount,
      platforms: c.platforms,
    })),
    canonicalCoverage: {
      primitivesUsed: [...primitivesUsed].sort(),
      primitivesUnused: unusedPrimitives,
      patternsUsed: [...patternsUsed].sort(),
      patternsUnused: unusedPatterns,
    },
    totals: {
      uniqueComponents: totalComponents,
      totalScreens,
      platforms: screensFiles.map((f) => f.platform),
    },
  };
  lines.push(JSON.stringify(catalog, null, 2));
  lines.push("```");

  return lines.join("\n") + "\n";
}

// ─── Main ───

function main() {
  const screensFiles = findScreensFiles();
  if (screensFiles.length === 0) {
    console.error(
      "No docs/analysis/{platform}/screens.json files found. Run /analyze first.",
    );
    process.exit(1);
  }

  // Try to read project name from docs/brief-summary.json
  let projectName = null;
  const summaryPath = path.join(ROOT, "docs", "brief-summary.json");
  if (fs.existsSync(summaryPath)) {
    try {
      projectName = JSON.parse(
        fs.readFileSync(summaryPath, "utf8"),
      ).projectName;
    } catch {
      /* ignore */
    }
  }

  const index = aggregate(screensFiles);
  const md = renderMarkdown(index, projectName, screensFiles);
  const outDir = path.join(ROOT, "docs", "analysis", "shared");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "components.md");
  fs.writeFileSync(outPath, md, "utf8");

  console.log(
    JSON.stringify(
      {
        success: true,
        uniqueComponents: index.size,
        platforms: screensFiles.map((f) => f.platform),
        outputPath: path.relative(ROOT, outPath).replace(/\\/g, "/"),
      },
      null,
      2,
    ),
  );
}

main();
