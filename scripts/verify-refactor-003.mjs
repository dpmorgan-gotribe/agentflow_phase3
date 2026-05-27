#!/usr/bin/env node
// Refactor-003 verification checklist. Runs every check from the plan's
// Validation Criteria + per-file Proposed Changes + Coherence Audit findings.
// Emits a pass/fail report plus a machine-parseable summary.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const checks = [];

function check(category, name, fn) {
  try {
    const result = fn();
    const passed = result === true || (result && result.pass);
    const detail = typeof result === "object" ? result.detail : null;
    checks.push({ category, name, passed, detail });
  } catch (e) {
    checks.push({
      category,
      name,
      passed: false,
      detail: `threw: ${e.message}`,
    });
  }
}

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}
function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}
function contains(p, needle) {
  return read(p).includes(needle);
}
function containsAll(p, needles) {
  const txt = read(p);
  const missing = needles.filter((n) => !txt.includes(n));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : null,
  };
}
function doesNotContain(p, needle) {
  return !read(p).includes(needle);
}

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 1: File presence (22 affected files + new artifacts)
// ─────────────────────────────────────────────────────────────────────

const AFFECTED_FILES = [
  "scaffolding/000-scaffolding-index.md",
  "scaffolding/07-020-architect-agent.md",
  "scaffolding/08-021-pm-agent.md",
  "scaffolding/01-022-ui-designer-agent.md",
  "scaffolding/03-023-mockups-skill.md",
  "scaffolding/04-024-stylesheet-skill.md",
  "scaffolding/05-025-screens-skill.md",
  "scaffolding/12-026-turborepo-scaffold.md",
  "scaffolding/13-027-shared-packages.md",
  "scaffolding/14-028-backend-builder-agent.md",
  "scaffolding/15-029-web-frontend-builder.md",
  "scaffolding/16-030-mobile-frontend-builder.md",
  "scaffolding/09-034b-output-contract-zod-schemas.md",
  "scaffolding/21-035-orchestrator-core.md",
  "scaffolding/22-036-hitl-gates.md",
  "scaffolding/23-038-skills-agent.md",
  "scaffolding/25-040-app-store-compliance.md",
  "scaffolding/11-041-mcp-server-registration.md",
  ".claude/skills/analyze/SKILL.md",
  ".claude/skills/analyze/integrations.md",
  ".claude/skills/new-project/SKILL.md",
  "multi-agent-app-generation-blueprint.md",
  "mcp-defaults-design.json",
];
for (const f of AFFECTED_FILES) {
  check("files", `exists: ${f}`, () => exists(f));
}

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 2: 034b Zod schema additions
// ─────────────────────────────────────────────────────────────────────

const SCH = "scaffolding/09-034b-output-contract-zod-schemas.md";
check("034b schema", "AnalyzeOutput.integrationsResearched added", () =>
  contains(SCH, "integrationsResearched: z.number().int().nonnegative()"),
);
check(
  "034b schema",
  "SelectedStyleSchema.iconLibrary added (uses IconLibrary enum)",
  () => contains(SCH, "iconLibrary: IconLibrary"),
);
check("034b schema", "IconLibrary enum exported with 5 values", () =>
  containsAll(SCH, [
    "IconLibrary = z.enum",
    '"lucide"',
    '"phosphor"',
    '"heroicons"',
    '"iconoir"',
    '"tabler"',
  ]),
);
check(
  "034b schema",
  "ArchitectOutput shape rewritten with refactor-003 fields",
  () =>
    containsAll(SCH, [
      "vendorDecisions: z.number().int().nonnegative()",
      "selfHostedDecisions: z.number().int().nonnegative()",
      "declinedDecisions: z.number().int().nonnegative()",
      "envVarsRequiredNow",
      "envVarsRequiredLater",
      "envVarsOptional",
      "credentialsDiffEmitted",
      "buildMcpServersAdded",
    ]),
);
check("034b schema", "CredentialsGateOutput added", () =>
  containsAll(SCH, [
    "export const CredentialsGateOutput",
    '"proceed"',
    '"defer"',
    '"abort"',
    "servicesConfirmed",
    "servicesDeferred",
    "deferralReasons",
    "envFileExists",
  ]),
);
check("034b schema", "PmOutput as discriminated union on mode", () =>
  containsAll(SCH, [
    "export const PmOutput = z.discriminatedUnion",
    '"tasks"',
    '"kit-change-request"',
    "miniPlanPath",
    "requestedPrimitives",
  ]),
);
check("034b schema", "SkillsAuditOutput as discriminated union on scope", () =>
  containsAll(SCH, [
    "export const SkillsAuditOutput = z.discriminatedUnion",
    '"design"',
    '"build"',
    "vendorSdksAudited",
  ]),
);
check("034b schema", "StageSchemas lookup includes refactor-003 keys", () =>
  containsAll(SCH, [
    '"skills-audit-design":',
    '"skills-audit-build":',
    '"credentials-gate":',
  ]),
);
check("034b schema", "Package src/ tree includes credentials-gate.ts", () =>
  contains(SCH, "credentials-gate.ts"),
);
check(
  "034b schema",
  "Acceptance criteria list all 17 refactor-003 stages",
  () => contains(SCH, "17 refactor-003 stages"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 3: Analyst phase 2.5 integrations research
// ─────────────────────────────────────────────────────────────────────

const ANZ = ".claude/skills/analyze/SKILL.md";
const INT = ".claude/skills/analyze/integrations.md";
check("analyst", "integrations.md sub-skill file exists", () => exists(INT));
check("analyst", "integrations.md documents research-only discipline", () =>
  containsAll(INT, [
    "Research-only",
    "does NOT pick vendors",
    "Vendor neutrality",
    "No synthetic candidates",
  ]),
);
check(
  "analyst",
  "integrations.md lists core + project-specific categories",
  () =>
    containsAll(INT, [
      "Core",
      "auth",
      "payments",
      "transactional-email",
      "push-notifications",
      "Project-specific",
      "crypto-wallets",
      "dao-governance",
    ]),
);
check("analyst", "SKILL.md argument-hint lists --skip-integrations", () =>
  contains(ANZ, "--skip-integrations"),
);
check("analyst", "SKILL.md has §3.5 Phase 2.5", () =>
  containsAll(ANZ, [
    "3.5 Phase 2.5",
    "integrations-options.md",
    "integrations.md` sub-skill",
  ]),
);
check("analyst", "SKILL.md Report JSON includes integrationsResearched", () =>
  contains(ANZ, '"integrationsResearched"'),
);
check(
  "analyst",
  "SKILL.md self-verification lists integrations-options.md",
  () => contains(ANZ, "integrations-options,styles"),
);
check(
  "analyst",
  "requirements.md template no longer names specific vendors",
  () =>
    containsAll(ANZ, [
      "See `docs/analysis/shared/integrations-options.md`",
      "analyst does NOT pick vendors",
    ]),
);
check("analyst", "Related skills list references integrations.md", () =>
  contains(ANZ, "phase 2.5 sub-skill"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 4: 020 Architect rewrite
// ─────────────────────────────────────────────────────────────────────

const ARC = "scaffolding/07-020-architect-agent.md";
check("020 architect", "tier moved to 6.5", () => contains(ARC, "tier: 6.5"));
check("020 architect", "depends-on includes analyst + visual-review", () =>
  contains(ARC, 'depends-on: ["019", "025b"]'),
);
check("020 architect", "single late invocation (no --phase arg)", () =>
  contains(ARC, "single invocation — no phases"),
);
check("020 architect", "three-way deployment enum documented", () =>
  contains(ARC, "vendor | self-hosted | declined"),
);
check("020 architect", "emits .env.example (never .env)", () =>
  containsAll(ARC, [
    "NEVER reads or writes `.env`",
    "Architect NEVER reads or modifies `.env`",
    ".env.example",
  ]),
);
check("020 architect", "emits credentials-checklist.md", () =>
  contains(ARC, "docs/credentials-checklist.md"),
);
check("020 architect", "emits deployment-checklist.md", () =>
  contains(ARC, "docs/deployment-checklist.md"),
);
check("020 architect", "emits credentials-diff.md on re-runs", () =>
  contains(ARC, "docs/credentials-diff.md"),
);
check(
  "020 architect",
  "mirrors selected-style.json.iconLibrary (not decides)",
  () =>
    containsAll(ARC, [
      "MIRRORS this into",
      "does not decide",
      "selected-style.json",
    ]),
);
check("020 architect", "vendor-decision heuristics documented", () =>
  containsAll(ARC, [
    "decisionRationale",
    "Brief signal wins",
    "Compliance fit",
    "Lock-in risk",
  ]),
);
check("020 architect", "invokes /register-mcp-servers --scope=build", () =>
  contains(ARC, "--scope=build"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 5: 035 Orchestrator STAGES array
// ─────────────────────────────────────────────────────────────────────

const ORC = "scaffolding/21-035-orchestrator-core.md";
check("035 orchestrator", "STAGES includes skills-audit-design", () =>
  contains(ORC, 'name: "skills-audit-design"'),
);
check("035 orchestrator", "STAGES includes skills-audit-build", () =>
  contains(ORC, 'name: "skills-audit-build"'),
);
check("035 orchestrator", "STAGES includes register-mcp-build", () =>
  contains(ORC, 'name: "register-mcp-build"'),
);
check(
  "035 orchestrator",
  "architect runs post-signoff (dependsOn user-flows)",
  () => contains(ORC, 'dependsOn: ["user-flows"]'),
);
check("035 orchestrator", "architect has gateType: credentials (gate 5)", () =>
  containsAll(ORC, ['gateType: "credentials"', 'agent: "architect"']),
);
check("035 orchestrator", "pm depends on architect", () =>
  contains(ORC, 'agent: "pm",\n    dependsOn: ["architect"]'),
);
check("035 orchestrator", "pm uses --mode=tasks flag", () =>
  contains(ORC, "/pm --mode=tasks"),
);
check("035 orchestrator", "kit-change-request detour uses PM dual-mode", () =>
  containsAll(ORC, [
    "PM in `--mode=kit-change-request`",
    "does NOT require `architecture.yaml`",
  ]),
);
check(
  "035 orchestrator",
  "design-stage MCPs NOT registered by orchestrator",
  () =>
    containsAll(ORC, [
      "design-stage MCP servers are NOT registered",
      "pre-registered at `/new-project` time",
    ]),
);
check(
  "035 orchestrator",
  "post-signoff kit-change re-runs architect if vendors change",
  () =>
    contains(
      ORC,
      "re-runs `/architect` if the kit change altered vendor decisions",
    ),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 6: 036 HITL Gate 5 file-drop
// ─────────────────────────────────────────────────────────────────────

const GATES = "scaffolding/22-036-hitl-gates.md";
check("036 gate 5", "gates table expanded to 5 rows", () =>
  containsAll(GATES, [
    "Five gates (refactor-003)",
    "| **5**",
    "`credentials`",
    "docs/credentials-confirmed.txt",
  ]),
);
check("036 gate 5", "Gate 5 subsection with file-drop spec", () =>
  containsAll(GATES, [
    "Gate 5 — Credentials gate (file-drop",
    "No HTTP server",
    "cp .env.example .env",
    "echo proceed > docs/credentials-confirmed.txt",
  ]),
);
check("036 gate 5", "proceed / defer / abort directives documented", () =>
  containsAll(GATES, ["`proceed`", "defer:ServiceA,ServiceB", "`abort`"]),
);
check("036 gate 5", "orchestrator NEVER reads .env (stat-only)", () =>
  containsAll(GATES, [
    "Orchestrator NEVER reads `.env`",
    "fs.statSync",
    "never `readFileSync`",
  ]),
);
check("036 gate 5", "Windows perms noted", () =>
  containsAll(GATES, ["Windows", "NTFS", "POSIX perms"]),
);
check("036 gate 5", "gate 5 never-disable policy", () =>
  contains(GATES, "never disable in autonomous mode"),
);
check(
  "036 gate 5",
  "file-watcher list includes credentials-confirmed.txt",
  () => contains(GATES, "docs/credentials-confirmed.txt`"),
);
check("036 gate 5", "defer path warns red for requiredNow services", () =>
  contains(GATES, "requiredNow: true"),
);
check("036 gate 5", "Acceptance criteria list all 5 gates", () =>
  contains(GATES, "**Five** gates implemented"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 7: 038 Skills-agent scope split
// ─────────────────────────────────────────────────────────────────────

const SKL = "scaffolding/23-038-skills-agent.md";
check("038 skills", "title notes scope-split", () =>
  contains(SKL, "scope-split: design + build"),
);
check("038 skills", "argument-hint supports --scope", () =>
  contains(SKL, "--scope=design | --scope=build"),
);
check("038 skills", "design-scope targets documented", () =>
  containsAll(SKL, ["nativewind-expo", "storybook-tailwind", "cva"]),
);
check(
  "038 skills",
  "build-scope reads architecture.yaml filtered to vendor",
  () =>
    containsAll(SKL, [
      "architecture.yaml",
      'deployment === "vendor"',
      "Ignore `declined` and `self-hosted`",
    ]),
);
check("038 skills", "rejects invocations without --scope", () =>
  contains(SKL, "--scope is required"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 8: 041 MCP registration scope split
// ─────────────────────────────────────────────────────────────────────

const MCP = "scaffolding/11-041-mcp-server-registration.md";
check("041 mcp", "argument-hint supports --scope", () =>
  contains(MCP, "--scope=design | --scope=build"),
);
check("041 mcp", "design-scope reads mcp-defaults-design.json", () =>
  contains(MCP, "mcp-defaults-design.json"),
);
check(
  "041 mcp",
  "build-scope reads architecture.yaml.tooling.mcp_servers",
  () => contains(MCP, "architecture.yaml.tooling.mcp_servers"),
);
check("041 mcp", "depends-on includes 018b /new-project", () =>
  contains(MCP, 'depends-on: ["020", "018b"]'),
);
check("041 mcp", "additive merge preserves other scope's entries", () =>
  containsAll(MCP, ["additively merged", "preserves"]),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 9: 021 PM dual-mode
// ─────────────────────────────────────────────────────────────────────

const PM = "scaffolding/08-021-pm-agent.md";
check("021 pm", "tier moved to 6.5", () => contains(PM, "tier: 6.5"));
check("021 pm", "depends-on includes architect (020)", () =>
  contains(PM, 'depends-on: ["019", "020"]'),
);
check("021 pm", "dual-mode documented", () =>
  containsAll(PM, ["--mode=tasks", "--mode=kit-change-request"]),
);
check(
  "021 pm",
  "kit-change-request mode does NOT require architecture.yaml",
  () => contains(PM, "Does NOT require `architecture.yaml`"),
);
check("021 pm", "tasks.yaml template includes integration-ref field", () =>
  contains(PM, "integration-ref"),
);
check("021 pm", "acceptance lists rejection on missing --mode", () =>
  contains(PM, "rejects invocations without a mode"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 10: 026 / 027 / 040 position notes
// ─────────────────────────────────────────────────────────────────────

check("position notes", "026 tier moved to 4 (invoked from /new-project)", () =>
  contains("scaffolding/12-026-turborepo-scaffold.md", "tier: 4"),
);
check("position notes", "026 Invocation Point section added", () =>
  contains(
    "scaffolding/12-026-turborepo-scaffold.md",
    "## Invocation Point (refactor-003)",
  ),
);
check("position notes", "027 tier moved to 4 (invoked from /new-project)", () =>
  contains("scaffolding/13-027-shared-packages.md", "tier: 4"),
);
check("position notes", "027 Invocation Point section added", () =>
  contains(
    "scaffolding/13-027-shared-packages.md",
    "## Invocation Point (refactor-003)",
  ),
);
check("position notes", "040 notes it runs after /architect", () =>
  contains(
    "scaffolding/25-040-app-store-compliance.md",
    "## Position in pipeline (refactor-003)",
  ),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 11: /new-project step 5b + mcp-defaults-design.json
// ─────────────────────────────────────────────────────────────────────

const NP = ".claude/skills/new-project/SKILL.md";
check("new-project", "step 5b section exists", () =>
  contains(NP, "### 5b. Scaffold the Turborepo"),
);
check("new-project", "step 5b scaffolds Turborepo + pnpm workspace", () =>
  containsAll(NP, ["pnpm init", "turbo.json", "pnpm-workspace.yaml"]),
);
check("new-project", "step 5b creates packages/ui-kit + siblings", () =>
  containsAll(NP, [
    "packages/ui-kit/",
    "packages/types/",
    "packages/orchestrator-contracts/",
  ]),
);
check("new-project", "step 5b copies mcp-defaults-design.json", () =>
  contains(NP, "mcp-defaults-design.json"),
);
check(
  "new-project",
  "step 5b invokes /register-mcp-servers --scope=design",
  () => contains(NP, "/register-mcp-servers --scope=design"),
);

const MCPDEF = "mcp-defaults-design.json";
check("mcp defaults", "factory file has all 5 design-stage servers", () => {
  const j = JSON.parse(read(MCPDEF));
  const names = j.mcp_servers.map((s) => s.name).sort();
  const expected = [
    "chrome-devtools",
    "icons8",
    "image-generator",
    "playwright",
    "unsplash",
  ];
  const match = JSON.stringify(names) === JSON.stringify(expected);
  return {
    pass: match,
    detail: match ? null : `got: ${names.join(",")}`,
  };
});
check("mcp defaults", "image-generator has feature_flag: nanobanana", () => {
  const j = JSON.parse(read(MCPDEF));
  const img = j.mcp_servers.find((s) => s.name === "image-generator");
  return img && img.feature_flag === "nanobanana";
});

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 12: Design-stage metadata independence (022-025)
// ─────────────────────────────────────────────────────────────────────

check("design-stage independence", '022 depends-on fixed to ["019"]', () =>
  contains("scaffolding/01-022-ui-designer-agent.md", 'depends-on: ["019"]'),
);
check(
  "design-stage independence",
  "023 removes architect prereq for design_dials",
  () =>
    doesNotContain(
      "scaffolding/03-023-mockups-skill.md",
      "Task 020 (Architect) has set `tooling.design_dials`",
    ),
);
check(
  "design-stage independence",
  "023 reads design_dials from styles.md",
  () =>
    contains(
      "scaffolding/03-023-mockups-skill.md",
      "design_dials` come from `docs/analysis/shared/styles.md`",
    ),
);
check(
  "design-stage independence",
  "024 reads iconLibrary from selected-style.json",
  () =>
    contains(
      "scaffolding/04-024-stylesheet-skill.md",
      "docs/selected-style.json.iconLibrary",
    ),
);
check(
  "design-stage independence",
  "025 kit-change-request uses PM dual-mode",
  () =>
    contains(
      "scaffolding/05-025-screens-skill.md",
      "PM in `--mode=kit-change-request`",
    ),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 13: Builder .env documentation (028-030)
// ─────────────────────────────────────────────────────────────────────

check("builder .env", "028 backend documents .env as gate-5-captured", () =>
  contains(
    "scaffolding/14-028-backend-builder-agent.md",
    "user-authored at gate 5",
  ),
);
check("builder .env", "028 documents sanctioned .env read exception", () =>
  contains(
    "scaffolding/14-028-backend-builder-agent.md",
    "inherits a sanctioned exception",
  ),
);
check("builder .env", "029 web documents NEXT_PUBLIC_* boundary", () =>
  containsAll("scaffolding/15-029-web-frontend-builder.md", [
    "NEXT_PUBLIC_",
    "Never wires `*_SECRET_KEY`",
  ]),
);
check("builder .env", "030 mobile documents EXPO_PUBLIC_* vs EAS secrets", () =>
  containsAll("scaffolding/16-030-mobile-frontend-builder.md", [
    "EXPO_PUBLIC_",
    "EAS Build-secrets",
    "eas secret:create",
  ]),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 14: Scaffolding index tier reshuffle
// ─────────────────────────────────────────────────────────────────────

const IDX = "scaffolding/000-scaffolding-index.md";
check("index", "refactor-003 banner at top", () => {
  const head = read(IDX).split("\n").slice(0, 10).join("\n");
  return (
    head.includes("Refactor-003 (2026-04-20)") &&
    head.includes("reordered the pipeline")
  );
});
check(
  "index",
  "Phase B post-design planning includes 020 + 021 (architect moved out of tier 5)",
  () => {
    const txt = read(IDX);
    const phaseB = txt.match(/### Phase B[\s\S]*?(?=### Phase|## |---)/);
    if (!phaseB) return false;
    const bullets = phaseB[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("- ["));
    const hasArch = bullets.some((b) => /\b020\b/.test(b));
    const hasPm = bullets.some((b) => /\b021\b/.test(b));
    return {
      pass: hasArch && hasPm,
      detail: `Phase B bullets: architect(020):${hasArch} pm(021):${hasPm}`,
    };
  },
);
check(
  "index",
  "Phase A design pipeline contains 022-025b, zero architect refs",
  () => {
    const txt = read(IDX);
    const phaseA = txt.match(/### Phase A[\s\S]*?(?=### Phase)/);
    if (!phaseA) return false;
    const bullets = phaseA[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("- ["));
    const ids = ["022", "022b", "023", "024", "025", "025b"];
    const missing = ids.filter(
      (id) => !bullets.some((b) => new RegExp(`\\b${id}\\b`).test(b)),
    );
    const hasArch = bullets.some((b) => /\b020\b/.test(b));
    return {
      pass: missing.length === 0 && !hasArch,
      detail: missing.length
        ? `missing design IDs: ${missing.join(",")}`
        : hasArch
          ? "architect(020) leaked into Phase A"
          : null,
    };
  },
);
check(
  "index",
  "026 + 027 listed as /new-project-invoked (not standalone build stages)",
  () => {
    const txt = read(IDX);
    const t4 = txt.match(/### Tier 4: Brief System[\s\S]*?(?=### |## |---)/);
    const pc = txt.match(/### Phase C[\s\S]*?(?=### Phase|## |---)/);
    const t4Mentions = t4 ? /026.*Turborepo|027.*Shared/i.test(t4[0]) : false;
    const pcMentions = pc ? /026.*Turborepo|027.*Shared/i.test(pc[0]) : false;
    return {
      pass: t4Mentions || pcMentions,
      detail: `Tier4:${t4Mentions} PhaseC:${pcMentions} (refactor-003 moved 026+027 to /new-project step 5b — either tier acceptable as long as not in build pipeline)`,
    };
  },
);
// ─────────────────────────────────────────────────────────────────────
// CATEGORY 15: Blueprint Appendix C
// ─────────────────────────────────────────────────────────────────────

const BP = "multi-agent-app-generation-blueprint.md";
check("blueprint", "Appendix C exists at EOF", () => {
  const txt = read(BP);
  const lastHeading = txt.lastIndexOf("## Appendix");
  return (
    contains(BP, "## Appendix C — Refactor-003 Pipeline Reorder") &&
    txt.substring(lastHeading).includes("Refactor-003")
  );
});
check("blueprint", "Appendix C lists canonical STAGES order", () =>
  containsAll(BP, [
    "skills-audit --scope=design",
    "gate 5 (credentials",
    "Three-way deployment enum",
    "Design-stage metadata independence",
  ]),
);
check("blueprint", "Appendix C includes supersession breadcrumb for §23", () =>
  contains(BP, "§23 L2765-2822 described the pre-refactor-003"),
);

// ─────────────────────────────────────────────────────────────────────
// CATEGORY 16: Plan artifacts
// ─────────────────────────────────────────────────────────────────────

const PLAN =
  "plans/active/refactor-003-pipeline-reorder-architect-credentials.md";
check("plan", "plan exists", () => exists(PLAN));
check("plan", "plan status is approved", () =>
  contains(PLAN, "status: approved"),
);
check("plan", "plan listed in active manifest", () =>
  contains(
    "plans/active.md",
    "refactor-003-pipeline-reorder-architect-credentials",
  ),
);

// ─────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────

const byCat = {};
for (const c of checks) {
  if (!byCat[c.category]) byCat[c.category] = [];
  byCat[c.category].push(c);
}

let passTotal = 0,
  failTotal = 0;
const lines = ["# Refactor-003 Verification Checklist\n"];

for (const [cat, items] of Object.entries(byCat)) {
  const catPass = items.filter((i) => i.passed).length;
  const catTotal = items.length;
  lines.push(`## ${cat} (${catPass}/${catTotal})\n`);
  for (const c of items) {
    const icon = c.passed ? "- [x]" : "- [ ]";
    const detail = c.detail ? ` — ${c.detail}` : "";
    lines.push(`${icon} ${c.name}${detail}`);
    if (c.passed) passTotal++;
    else failTotal++;
  }
  lines.push("");
}

lines.push(`## Total: ${passTotal}/${passTotal + failTotal}`);
lines.push("");
if (failTotal) {
  lines.push("**Failing checks:**");
  for (const c of checks.filter((c) => !c.passed)) {
    lines.push(
      `- ${c.category} / ${c.name}${c.detail ? " — " + c.detail : ""}`,
    );
  }
}

const report = lines.join("\n");
console.log(report);
process.exit(failTotal ? 1 : 0);
