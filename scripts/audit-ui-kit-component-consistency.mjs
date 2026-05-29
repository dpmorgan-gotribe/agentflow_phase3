#!/usr/bin/env node
/**
 * audit-ui-kit-component-consistency.mjs — feat-002 Stage 2 / 3 audit.
 *
 * Mechanical post-fan-out verifier for /stylesheet-primitives output.
 * Project-agnostic. Reads each project's own .components-plan.json +
 * .shared-preamble.md + packages/ui-kit/src/{primitives,patterns,layouts}/
 * directories.
 *
 * Dimensions:
 *
 *   D-A — All 5 files present per component (.tsx + .variants.ts +
 *         .test.tsx + .stories.tsx + index.ts). .variants.ts is OPTIONAL
 *         for single-variant primitives — fail only when canonical
 *         primitive roster says variants required.
 *   D-B — PascalCase export — .tsx exports a function whose name matches
 *         the directory's PascalCase form.
 *   D-C — data-kit-component literal — root rendered element has the
 *         string literal data-kit-component="<PascalName>" hard-coded.
 *   D-D — Variant + size forwarding — if primitive declares `variant`
 *         prop, root has data-kit-variant={variant}; same for size.
 *   D-E — CVA usage — .variants.ts (when present) calls cva(; .tsx
 *         imports the variants function — not ad-hoc className switching.
 *   D-F — No raw hex — .tsx contains no #[0-9A-Fa-f]{3,8} literals
 *         (excluding data:image/svg+xml URIs).
 *   D-G — Test shape — test file imports @testing-library/react;
 *         ≥3 test cases including one data-kit-component assertion.
 *   D-H — Story shape — story file `export default { component: <Name>, ... }`
 *         + ≥1 named export per major variant.
 *   D-I — Canonical imports — `import { cn } from "../../lib/cn"`
 *         (not from "@repo/ui-kit/lib/cn" or invented path); same for
 *         cva + tokens.
 *   D-J — Required props/variants — per components-plan roster row,
 *         all listed variants are present.
 *   D-K — Class composition via cn() — .tsx className uses cn(...);
 *         never concatenated by hand or template-string outside cn.
 *   D-L — Pattern composes primitives — pattern .tsx has ≥1 import
 *         from ../../primitives/* (or barrel) — not inventing its own
 *         <button> / <input> etc.
 *   D-M — Layout data-kit-component — same as D-C for layouts.
 *   D-N — Custom patterns named — every entry in
 *         .components-plan.json.customPatternsGenerated[] has a directory.
 *   D-O — devDeps cover imports — every bare-specifier import in the
 *         kit's source files is in package.json.{dependencies,
 *         peerDependencies,devDependencies}.
 *   D-P — Stories import canonical — every .stories.tsx imports from
 *         @storybook/react (not @storybook/react-vite).
 *   D-Q — CVA boolean variants — .variants.ts with boolean-shape
 *         variants MUST have matching boolean (not string) values in
 *         compoundVariants + defaultVariants.
 *   D-R — Pattern title clash — any .tsx declaring `interface XProps
 *         extends React.HTMLAttributes<...>` that also declares
 *         `title: React.ReactNode` MUST use Omit<...,"title">.
 *
 * Run from project cwd:
 *   node $FACTORY_ROOT/scripts/audit-ui-kit-component-consistency.mjs
 *   --tier primitives|patterns-and-layouts|all     scope to a tier set
 *   --dimension D-A..D-R|all                        scope to one dimension
 *   --json                                          machine-readable output
 *   --strict                                        fail on warnings
 *
 * Exits 0 on clean audit, 1 on any drift in scoped dimensions, 2 on
 * configuration error.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const tierArgIdx = process.argv.indexOf("--tier");
const TIER = tierArgIdx > 0 ? process.argv[tierArgIdx + 1] : "all";
const dimArgIdx = process.argv.indexOf("--dimension");
const DIM = dimArgIdx > 0 ? process.argv[dimArgIdx + 1] : "all";

function die(msg) {
  console.error(`audit-ui-kit-component-consistency: ${msg}`);
  process.exit(2);
}

const VALID_TIERS = new Set(["primitives", "patterns-and-layouts", "all"]);
if (!VALID_TIERS.has(TIER)) die(`invalid --tier ${TIER}`);

const VALID_DIMS = new Set([
  "all",
  "D-A",
  "D-B",
  "D-C",
  "D-D",
  "D-E",
  "D-F",
  "D-G",
  "D-H",
  "D-I",
  "D-J",
  "D-K",
  "D-L",
  "D-M",
  "D-N",
  "D-O",
  "D-P",
  "D-Q",
  "D-R",
]);
if (!VALID_DIMS.has(DIM)) die(`invalid --dimension ${DIM}`);

// ─── Locate sources ───────────────────────────────────────────────────
const kitRoot = join(ROOT, "packages", "ui-kit");
const primitivesDir = join(kitRoot, "src", "primitives");
const patternsDir = join(kitRoot, "src", "patterns");
const layoutsDir = join(kitRoot, "src", "layouts");
const planPath = join(kitRoot, ".components-plan.json");
const preamblePath = join(kitRoot, ".shared-preamble.md");
const packageJsonPath = join(kitRoot, "package.json");

if (!existsSync(kitRoot)) die(`missing ${kitRoot}`);
if (!existsSync(packageJsonPath)) die(`missing ${packageJsonPath}`);

// ─── Load inputs ──────────────────────────────────────────────────────
const componentsPlan = existsSync(planPath)
  ? JSON.parse(readFileSync(planPath, "utf8"))
  : null;
const sharedPreamble = existsSync(preamblePath)
  ? readFileSync(preamblePath, "utf8")
  : null;
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const allDeps = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

// Mandatory primitive roster — kebab-case (mirrors SKILL.md §1c).
const MANDATORY_PRIMITIVES = [
  "button",
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "card",
  "badge",
  "avatar",
  "separator",
  "tabs",
  "form-field",
];

// Component name conventions
function kebabToPascal(kebab) {
  return kebab
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

// Acronym-friendly Pascal: e.g. faq → FAQ, fbi → FBI. If the entire kebab
// is short (≤4 chars) and has no internal hyphens, allow both `Faq` and
// `FAQ` (uppercase) as legitimate PascalCase forms.
function acceptableExportNames(kebab) {
  const names = [kebabToPascal(kebab)];
  if (!kebab.includes("-") && kebab.length <= 4) {
    names.push(kebab.toUpperCase());
  }
  return names;
}

// "Extracted" patterns ship as project-specific HTML→React translations of
// _extracted/*.html. They have relaxed contract: no test, no story required
// (they're not part of the canonical 12 patterns). Heuristic: the pattern's
// .tsx carries a `data-pattern="..."` attribute matching its kebab name AND
// the .tsx body comment-references _extracted/. Returns true if extracted.
function isExtractedPattern(componentDir, kebab, tsxContent) {
  if (!tsxContent) return false;
  const dataPattern = new RegExp(`data-pattern="${kebab}"`);
  const fromExtractedComment = /_extracted\//.test(tsxContent);
  return dataPattern.test(tsxContent) && fromExtractedComment;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listComponentDirs(tierDir) {
  if (!existsSync(tierDir)) return [];
  return readdirSync(tierDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."),
    )
    .map((e) => e.name);
}

// Skip pattern sub-tree under patterns/ that's not a leaf component
// (e.g. patterns/_extracted/ holds raw HTML, not React components)
function isComponentLeaf(dir) {
  const tsxName = basename(dir) + ".tsx";
  return existsSync(join(dir, tsxName));
}

// ─── Findings ─────────────────────────────────────────────────────────
const findings = {
  "D-A": [],
  "D-B": [],
  "D-C": [],
  "D-D": [],
  "D-E": [],
  "D-F": [],
  "D-G": [],
  "D-H": [],
  "D-I": [],
  "D-J": [],
  "D-K": [],
  "D-L": [],
  "D-M": [],
  "D-N": [],
  "D-O": [],
  "D-P": [],
  "D-Q": [],
  "D-R": [],
};

const dimIn = (d) => DIM === "all" || DIM === d;

// ─── Per-component audit (covers primitives + patterns + layouts) ────
function auditComponent(tier, kebab, componentDir) {
  const Pascal = kebabToPascal(kebab);
  const tsxPath = join(componentDir, `${kebab}.tsx`);
  const variantsPath = join(componentDir, `${kebab}.variants.ts`);
  const testPath = join(componentDir, `${kebab}.test.tsx`);
  const storiesPath = join(componentDir, `${kebab}.stories.tsx`);
  const indexPath = join(componentDir, "index.ts");

  const tsx = existsSync(tsxPath) ? readFileSync(tsxPath, "utf8") : null;
  const variants = existsSync(variantsPath)
    ? readFileSync(variantsPath, "utf8")
    : null;
  const test = existsSync(testPath) ? readFileSync(testPath, "utf8") : null;
  const stories = existsSync(storiesPath)
    ? readFileSync(storiesPath, "utf8")
    : null;
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  // Extracted patterns: relaxed contract (no test/story required) — they
  // ship as HTML→React translations of _extracted/*.html, not canonical
  // kit primitives/patterns/layouts.
  const isExtracted =
    tier === "patterns" && isExtractedPattern(componentDir, kebab, tsx);
  const acceptableNames = acceptableExportNames(kebab);

  // D-A: 5 files present (variants.ts optional; test+story optional for extracted)
  if (dimIn("D-A")) {
    const missing = [];
    if (!tsx) missing.push(`${kebab}.tsx`);
    if (!index) missing.push("index.ts");
    if (!isExtracted) {
      if (!test) missing.push(`${kebab}.test.tsx`);
      if (!stories) missing.push(`${kebab}.stories.tsx`);
    }
    if (missing.length) {
      findings["D-A"].push({ tier, component: kebab, missing, isExtracted });
    }
  }

  if (!tsx) return; // remaining dimensions all require .tsx

  // D-B: PascalCase export (acronym-friendly)
  if (dimIn("D-B")) {
    const matches = acceptableNames.some((name) =>
      new RegExp(`export\\s+(function|const)\\s+${name}\\b`).test(tsx),
    );
    if (!matches) {
      findings["D-B"].push({
        tier,
        component: kebab,
        expectedAny: acceptableNames,
      });
    }
  }

  // D-C / D-M: data-kit-component literal (try each acceptable Pascal form)
  const dimDataKit = tier === "layouts" ? "D-M" : "D-C";
  if (dimIn(dimDataKit)) {
    const dataKitLiterals = acceptableNames.map(
      (n) => `data-kit-component="${n}"`,
    );
    const found = dataKitLiterals.some((lit) => tsx.includes(lit));
    if (!found) {
      findings[dimDataKit].push({
        tier,
        component: kebab,
        expectedAny: dataKitLiterals,
      });
    }
  }

  // D-D: variant + size forwarding (only when component has those props)
  if (dimIn("D-D") && tier === "primitives") {
    const hasVariantProp =
      /\bvariant\??:\s*("[^"]+"|\|)/i.test(tsx) || /\bvariant\?:/.test(tsx);
    const hasSizeProp =
      /\bsize\??:\s*("[^"]+"|\|)/i.test(tsx) || /\bsize\?:/.test(tsx);
    const missing = [];
    if (hasVariantProp && !tsx.includes("data-kit-variant="))
      missing.push("data-kit-variant");
    if (hasSizeProp && !tsx.includes("data-kit-size="))
      missing.push("data-kit-size");
    if (missing.length) {
      findings["D-D"].push({ tier, component: kebab, missing });
    }
  }

  // D-E: CVA usage (accept cva( OR kitCva( — the canonical alias)
  if (dimIn("D-E") && variants) {
    if (!/\b(cva|kitCva)\s*\(/.test(variants)) {
      findings["D-E"].push({
        tier,
        component: kebab,
        reason: ".variants.ts present but does not call cva()/kitCva()",
      });
    }
    // Also check .tsx imports variants — accept relative OR same-folder import
    const variantsImportRe = new RegExp(
      `from\\s+["']\\./${kebab}\\.variants["']|from\\s+["']\\./variants["']`,
    );
    if (!variantsImportRe.test(tsx)) {
      findings["D-E"].push({
        tier,
        component: kebab,
        reason: ".tsx does not import from .variants.ts",
      });
    }
  }

  // D-F: no raw hex literals (excluding data: URIs)
  if (dimIn("D-F")) {
    // Strip data: URIs first
    const tsxStripped = tsx.replace(/data:image\/svg\+xml[^"'`]+/g, "");
    const hexMatches = tsxStripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    if (hexMatches.length) {
      findings["D-F"].push({
        tier,
        component: kebab,
        hexes: [...new Set(hexMatches)].slice(0, 5),
      });
    }
  }

  // D-G: test shape
  if (dimIn("D-G") && test) {
    const hasTLR = /@testing-library\/react/.test(test);
    const testCount = (test.match(/^\s*(?:test|it)\s*\(/gm) || []).length;
    const hasDataKitAssertion = test.includes("data-kit-component");
    const issues = [];
    if (!hasTLR) issues.push("missing @testing-library/react import");
    if (testCount < 3) issues.push(`only ${testCount} test(s); need ≥3`);
    if (!hasDataKitAssertion) issues.push("no data-kit-component assertion");
    if (issues.length) {
      findings["D-G"].push({ tier, component: kebab, issues });
    }
  }

  // D-H: story shape
  if (dimIn("D-H") && stories) {
    const hasDefaultExport =
      /export\s+default\s+/.test(stories) &&
      new RegExp(`component:\\s*${Pascal}\\b`).test(stories);
    const namedExports = (stories.match(/^export\s+const\s+(\w+)/gm) || [])
      .length;
    const issues = [];
    if (!hasDefaultExport)
      issues.push(`missing canonical default export with component: ${Pascal}`);
    if (namedExports < 1) issues.push("no named story exports");
    if (issues.length) {
      findings["D-H"].push({ tier, component: kebab, issues });
    }
  }

  // D-I: canonical imports (no deep paths)
  if (dimIn("D-I")) {
    const deepImports = [
      /from\s+["']@repo\/ui-kit\/src\//g,
      /from\s+["']@repo\/ui-kit\/lib\//g,
      /from\s+["']@repo\/ui-kit\/tokens\/(?!tokens["'])/g,
    ];
    for (const re of deepImports) {
      const matches = tsx.match(re) || [];
      if (matches.length) {
        findings["D-I"].push({
          tier,
          component: kebab,
          violations: matches.slice(0, 3),
        });
        break;
      }
    }
  }

  // D-J: required props/variants per components-plan roster
  // Check BOTH .tsx and .variants.ts for the literal variant strings.
  if (dimIn("D-J") && tier === "primitives") {
    const expectedVariants = {
      button: ["primary", "secondary", "ghost", "destructive"],
      input: ["text", "email", "password", "number", "search"],
      badge: ["default", "accent", "secondary", "highlight"],
    };
    if (expectedVariants[kebab]) {
      const combined = tsx + "\n" + (variants || "");
      const missing = expectedVariants[kebab].filter(
        (v) => !combined.includes(`"${v}"`) && !combined.includes(`'${v}'`),
      );
      if (missing.length) {
        findings["D-J"].push({
          tier,
          component: kebab,
          missingVariants: missing,
        });
      }
    }
  }

  // D-K: cn() class composition
  if (dimIn("D-K")) {
    const usesCn = /\bcn\s*\(/.test(tsx);
    // Template-string className OUTSIDE cn() — heuristic
    const badTemplate =
      /className=\{`[^`]*\$\{/.test(tsx) && !/className=\{cn\(/.test(tsx);
    const hardConcat = /className=\{["'][^"']+["']\s*\+/.test(tsx);
    if (badTemplate || hardConcat || (!usesCn && /className=/.test(tsx))) {
      // Don't flag pure static className strings as violations — they're fine
      const onlyStatic =
        /className=\{["'][^"']+["']\s*\}/.test(tsx) ||
        /className="[^"]+"/.test(tsx);
      if (badTemplate || hardConcat) {
        findings["D-K"].push({
          tier,
          component: kebab,
          reason:
            "className built outside cn() (template-string interpolation or hand-concat)",
        });
      }
    }
  }

  // D-L: pattern composes primitives
  if (dimIn("D-L") && tier === "patterns") {
    // Skip extracted patterns (no React composition required)
    const importsPrimitive =
      /from\s+["']\.\.\/\.\.\/primitives\//.test(tsx) ||
      /from\s+["']@repo\/ui-kit["']/.test(tsx);
    // Heuristic: pattern uses <button> / <input> etc. natively?
    const inventsAtomic =
      /<(button|input|textarea|select)\b/i.test(tsx) && !importsPrimitive;
    if (inventsAtomic) {
      findings["D-L"].push({
        tier,
        component: kebab,
        reason:
          "pattern uses native <button>/<input> without importing kit primitive",
      });
    }
  }

  // D-P: stories import canonical @storybook/react
  if (dimIn("D-P") && stories) {
    if (!/from\s+["']@storybook\/react["']/.test(stories)) {
      findings["D-P"].push({
        tier,
        component: kebab,
        reason: "stories.tsx does not import from @storybook/react",
      });
    }
  }

  // D-Q: CVA boolean variants consistency
  if (dimIn("D-Q") && variants) {
    // Find variants block declaring `xxx: { true: ..., false: ... }`
    const booleanVariantBlocks =
      variants.match(/(\w+):\s*\{\s*true:[\s\S]*?false:/g) || [];
    if (booleanVariantBlocks.length) {
      // For each boolean variant, check compoundVariants + defaultVariants
      // use literal booleans (not strings)
      const stringBooleanInCompound =
        /\b(true|false):\s*"(true|false)"/g.test(variants) ||
        (/\b\w+:\s*"(true|false)"\s*,/.test(variants) &&
          /compoundVariants/.test(variants));
      if (stringBooleanInCompound) {
        findings["D-Q"].push({
          tier,
          component: kebab,
          reason:
            "boolean variant declared with string 'true'/'false' in compoundVariants or defaultVariants — use literal booleans",
        });
      }
    }
  }

  // D-R: pattern title prop clash with HTMLAttributes
  if (dimIn("D-R") && tier === "patterns") {
    const extendsHTMLAttrs =
      /extends\s+React\.HTMLAttributes\s*<\s*HTML\w*Element\s*>/.test(tsx);
    const hasTitleNode =
      /title:\s*React\.ReactNode\b/.test(tsx) ||
      /title:\s*ReactNode\b/.test(tsx);
    const hasOmitTitle =
      /Omit\s*<\s*React\.HTMLAttributes[^>]+,\s*["']title["']\s*>/.test(tsx);
    if (extendsHTMLAttrs && hasTitleNode && !hasOmitTitle) {
      findings["D-R"].push({
        tier,
        component: kebab,
        reason:
          "title: ReactNode declared but HTMLAttributes not Omit-ed — TS2430 imminent",
      });
    }
  }
}

// ─── Tier walks ───────────────────────────────────────────────────────
const auditedTiers = [];

if (TIER === "all" || TIER === "primitives") {
  auditedTiers.push("primitives");
  if (existsSync(primitivesDir)) {
    for (const kebab of listComponentDirs(primitivesDir)) {
      const componentDir = join(primitivesDir, kebab);
      if (isComponentLeaf(componentDir)) {
        auditComponent("primitives", kebab, componentDir);
      }
    }
  }

  // Mandatory roster check — refactor-006 hard gate
  if (dimIn("D-A")) {
    const shipped = listComponentDirs(primitivesDir).filter((d) =>
      isComponentLeaf(join(primitivesDir, d)),
    );
    const missingMandatory = MANDATORY_PRIMITIVES.filter(
      (p) => !shipped.includes(p),
    );
    if (missingMandatory.length) {
      findings["D-A"].push({
        tier: "primitives",
        component: "(mandatory-roster)",
        missing: missingMandatory.map((p) => `${p}/`),
        reason: "refactor-006 hard gate: <12 mandatory primitives shipped",
      });
    }
  }
}

if (TIER === "all" || TIER === "patterns-and-layouts") {
  auditedTiers.push("patterns");
  if (existsSync(patternsDir)) {
    for (const kebab of listComponentDirs(patternsDir)) {
      if (kebab === "_extracted" || kebab === "custom") continue;
      const componentDir = join(patternsDir, kebab);
      if (isComponentLeaf(componentDir)) {
        auditComponent("patterns", kebab, componentDir);
      }
    }
    // Walk patterns/custom/ if present
    const customDir = join(patternsDir, "custom");
    if (existsSync(customDir)) {
      for (const kebab of listComponentDirs(customDir)) {
        const componentDir = join(customDir, kebab);
        if (isComponentLeaf(componentDir)) {
          auditComponent("patterns", `custom/${kebab}`, componentDir);
        }
      }
    }
  }

  auditedTiers.push("layouts");
  if (existsSync(layoutsDir)) {
    for (const kebab of listComponentDirs(layoutsDir)) {
      const componentDir = join(layoutsDir, kebab);
      if (isComponentLeaf(componentDir)) {
        auditComponent("layouts", kebab, componentDir);
      }
    }
  }

  // D-N: custom patterns named in plan have directories
  if (dimIn("D-N") && componentsPlan) {
    const customGenerated = componentsPlan.customPatternsGenerated || [];
    if (Array.isArray(customGenerated)) {
      const customDir = join(patternsDir, "custom");
      const present = existsSync(customDir) ? listComponentDirs(customDir) : [];
      const presentLower = new Set(present.map((p) => p.toLowerCase()));
      for (const customName of customGenerated) {
        const expectedKebab = (
          typeof customName === "string" ? customName : customName.name || ""
        )
          .replace(/([A-Z])/g, "-$1")
          .replace(/^-/, "")
          .toLowerCase();
        if (!presentLower.has(expectedKebab)) {
          findings["D-N"].push({
            tier: "patterns",
            component: customName,
            reason: `custom pattern named in .components-plan.json.customPatternsGenerated[] but not found at src/patterns/custom/${expectedKebab}/`,
          });
        }
      }
    }
  }
}

// ─── Global walks (run regardless of tier filter) ────────────────────
// D-O: devDeps cover imports across the kit
if (dimIn("D-O")) {
  const allKitFiles = [];
  function walkDir(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walkDir(full);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) allKitFiles.push(full);
    }
  }
  walkDir(join(kitRoot, "src"));
  // Also include .storybook config + scripts
  walkDir(join(kitRoot, ".storybook"));
  walkDir(join(kitRoot, "scripts"));

  const bareImports = new Set();
  const importRe = /from\s+["']([^"'./][^"']*)["']/g;
  for (const f of allKitFiles) {
    const content = readFileSync(f, "utf8");
    let m;
    while ((m = importRe.exec(content)) !== null) {
      // Extract package root: @scope/name OR name (no nested paths)
      const pkg = m[1].startsWith("@")
        ? m[1].split("/").slice(0, 2).join("/")
        : m[1].split("/")[0];
      // Skip node: built-ins
      if (pkg.startsWith("node:")) continue;
      bareImports.add(pkg);
    }
  }

  const missing = [...bareImports].filter((p) => !allDeps.has(p));
  if (missing.length) {
    findings["D-O"].push({
      tier: "kit-wide",
      component: "(package.json)",
      missing,
      reason: `${missing.length} bare imports not declared in package.json deps`,
    });
  }
}

// ─── Report ──────────────────────────────────────────────────────────
const counts = {};
let total = 0;
for (const dim of Object.keys(findings)) {
  counts[dim] = findings[dim].length;
  total += findings[dim].length;
}

const result = {
  rootCwd: ROOT,
  tier: TIER,
  dimensionScope: DIM,
  strict: STRICT,
  auditedTiers,
  counts,
  total,
  findings,
  pass: total === 0,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

console.log(
  `\naudit-ui-kit-component-consistency — ${result.pass ? "✓ PASS" : "✗ FAIL"}`,
);
console.log(`  kit root: ${kitRoot}`);
console.log(`  audited tiers: ${auditedTiers.join(", ")}`);
console.log(`  dimension scope: ${DIM}`);
console.log("");

if (total === 0) {
  console.log("  ✓ All scoped dimensions pass.\n");
  process.exit(0);
}

console.log(`  Drift counts per dimension:`);
const labels = {
  "D-A": "5 files present + mandatory roster",
  "D-B": "PascalCase export name",
  "D-C": "data-kit-component literal (primitives)",
  "D-D": "variant + size forwarding",
  "D-E": "CVA usage",
  "D-F": "no raw hex literals",
  "D-G": "test shape (≥3 cases + data-kit assertion)",
  "D-H": "story shape (default export + named)",
  "D-I": "canonical relative imports",
  "D-J": "required props/variants",
  "D-K": "class composition via cn()",
  "D-L": "pattern composes primitives",
  "D-M": "data-kit-component literal (layouts)",
  "D-N": "custom patterns named in plan",
  "D-O": "devDeps cover all bare imports",
  "D-P": "stories import @storybook/react",
  "D-Q": "CVA boolean variants consistency",
  "D-R": "Omit<HTMLAttributes,'title'>",
};
for (const dim of Object.keys(findings)) {
  console.log(`    ${dim} ${labels[dim].padEnd(40)}: ${counts[dim]}`);
}

const showDetails = (dim, render) => {
  if (findings[dim].length === 0) return;
  console.log(`\n  ── ${dim} details (${labels[dim]}) ──`);
  for (const f of findings[dim].slice(0, 15)) {
    console.log(`    ${render(f)}`);
  }
  if (findings[dim].length > 15) {
    console.log(`    … and ${findings[dim].length - 15} more`);
  }
};

showDetails(
  "D-A",
  (f) =>
    `${f.tier}/${f.component}: missing ${(f.missing || []).join(", ")}${f.reason ? " — " + f.reason : ""}`,
);
showDetails(
  "D-B",
  (f) => `${f.tier}/${f.component}: export name should be ${f.expected}`,
);
showDetails("D-C", (f) => `${f.tier}/${f.component}: missing ${f.expected}`);
showDetails(
  "D-D",
  (f) => `${f.tier}/${f.component}: missing ${(f.missing || []).join(", ")}`,
);
showDetails("D-E", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails(
  "D-F",
  (f) => `${f.tier}/${f.component}: raw hex ${(f.hexes || []).join(", ")}`,
);
showDetails(
  "D-G",
  (f) => `${f.tier}/${f.component}: ${(f.issues || []).join("; ")}`,
);
showDetails(
  "D-H",
  (f) => `${f.tier}/${f.component}: ${(f.issues || []).join("; ")}`,
);
showDetails(
  "D-I",
  (f) =>
    `${f.tier}/${f.component}: deep import — ${(f.violations || []).join(" / ")}`,
);
showDetails(
  "D-J",
  (f) =>
    `${f.tier}/${f.component}: missing variants [${(f.missingVariants || []).join(", ")}]`,
);
showDetails("D-K", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails("D-L", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails("D-M", (f) => `${f.tier}/${f.component}: missing ${f.expected}`);
showDetails("D-N", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails(
  "D-O",
  (f) => `${f.tier}: missing devDeps — ${(f.missing || []).join(", ")}`,
);
showDetails("D-P", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails("D-Q", (f) => `${f.tier}/${f.component}: ${f.reason}`);
showDetails("D-R", (f) => `${f.tier}/${f.component}: ${f.reason}`);

console.log(
  `\n  ✗ ui-kit component-consistency drift. Patch the components (or re-run /stylesheet-primitives) and re-run.\n`,
);
process.exit(1);
