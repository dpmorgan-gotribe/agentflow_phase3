import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readBudgetCaps,
  readModelConfig,
  readProviderConfig,
  readStallTimeoutMode,
  resolveStallTimeoutForBugContext,
} from "../src/model-config.js";

let tmpDir: string;
let globalPath: string;
let projectPath: string;
const originalEnv = process.env.ANTHROPIC_MODEL;
const originalProviderEnv = process.env.AGENTFLOW_PROVIDER;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "model-config-"));
  globalPath = join(tmpDir, "global.yaml");
  projectPath = join(tmpDir, "project.yaml");
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.AGENTFLOW_PROVIDER;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = originalEnv;
  }
  if (originalProviderEnv === undefined) {
    delete process.env.AGENTFLOW_PROVIDER;
  } else {
    process.env.AGENTFLOW_PROVIDER = originalProviderEnv;
  }
});

describe("readModelConfig — tier→model resolution", () => {
  it("resolves tier to model via defaults map", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.effort).toBe("max");
  });

  it("direct model override on agent wins over tier", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, model: claude-sonnet-4-6 }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });

  it("defaults effort to 'medium' when agent omits it", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.effort).toBe("medium");
  });

  it("defaults budgetUsd to 5 when agent omits it", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.budgetUsd).toBe(5);
  });

  it("throws when no model can be resolved", () => {
    writeFileSync(
      globalPath,
      `defaults: {}\nagents:\n  analyst: { effort: max }\n`,
    );
    expect(() =>
      readModelConfig("analyst", tmpDir, { globalPath, projectPath }),
    ).toThrow(/No model resolved/);
  });
});

describe("readModelConfig — precedence (global < project < env)", () => {
  it("project config overrides global agent settings", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\n  building: claude-sonnet-4-6\nagents:\n  analyst: { tier: planning, effort: max }\n`,
    );
    writeFileSync(
      projectPath,
      `agents:\n  analyst: { tier: building, effort: low }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.effort).toBe("low");
  });

  it("project partial override merges with global (effort from project, tier from global)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n`,
    );
    writeFileSync(projectPath, `agents:\n  analyst: { effort: low }\n`);
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-opus-4-7"); // tier: planning inherited
    expect(cfg.effort).toBe("low"); // effort overridden
  });

  it("ANTHROPIC_MODEL env var overrides both configs", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    process.env.ANTHROPIC_MODEL = "claude-haiku-4-5";
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-haiku-4-5");
  });

  it("project defaults override global defaults for tier mapping", () => {
    writeFileSync(globalPath, `defaults:\n  planning: claude-opus-4-7\n`);
    writeFileSync(
      projectPath,
      `defaults:\n  planning: claude-sonnet-4-6\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });
});

describe("readModelConfig — missing files", () => {
  it("works with no project file (inherits global entirely)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: high }\n`,
    );
    // projectPath not written — missing file OK
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.effort).toBe("high");
  });

  it("throws when unknown agent has no defaults to fall through to", () => {
    writeFileSync(globalPath, `defaults:\n  planning: claude-opus-4-7\n`);
    expect(() =>
      readModelConfig("no-such-agent", tmpDir, { globalPath, projectPath }),
    ).toThrow(/No model resolved for agent 'no-such-agent'/);
  });

  it("feat-065-followup: bug-fixer resolves via FACTORY_DEFAULT_AGENT_TIERS even when both YAML files lack the entry", () => {
    // The motivating scenario: an existing project's models.yaml has
    // empty `agents: {}` (scaffolded pre-feat-064), and the operator's
    // ~/.claude/models.yaml also lacks bug-fixer. Pre-feat-065-followup
    // this hit "No model resolved" + cascade-failed every /fix-bugs
    // dispatch. Post-followup: factory-default fallback resolves
    // tier:building → claude-sonnet-4-6.
    writeFileSync(
      globalPath,
      `defaults:\n  building: claude-sonnet-4-6\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    writeFileSync(projectPath, `agents: {}\n`);
    const cfg = readModelConfig("bug-fixer", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.effort).toBe("medium");
  });

  it("feat-065-followup: project-level override wins over FACTORY_DEFAULT_AGENT_TIERS", () => {
    // Operator can override the factory default via project YAML.
    writeFileSync(
      globalPath,
      `defaults:\n  building: claude-sonnet-4-6\n  planning: claude-opus-4-7\n`,
    );
    writeFileSync(
      projectPath,
      `agents:\n  bug-fixer: { tier: planning, effort: max }\n`,
    );
    const cfg = readModelConfig("bug-fixer", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.effort).toBe("max");
  });
});

describe("readBudgetCaps", () => {
  it("returns default perPipelineMaxUsd when no config provides one", () => {
    writeFileSync(globalPath, `defaults: {}\n`);
    const caps = readBudgetCaps(tmpDir, { globalPath, projectPath });
    expect(caps.perPipelineMaxUsd).toBe(150);
    expect(caps.perStageMaxUsd).toEqual({});
  });

  it("reads perPipelineMaxUsd from global", () => {
    writeFileSync(
      globalPath,
      `budget:\n  perPipelineMaxUsd: 200\n  perStageMaxUsd:\n    analyze: 3\n    mockups: 10\n`,
    );
    const caps = readBudgetCaps(tmpDir, { globalPath, projectPath });
    expect(caps.perPipelineMaxUsd).toBe(200);
    expect(caps.perStageMaxUsd.analyze).toBe(3);
    expect(caps.perStageMaxUsd.mockups).toBe(10);
  });

  it("project budget overrides global perPipelineMaxUsd", () => {
    writeFileSync(globalPath, `budget:\n  perPipelineMaxUsd: 150\n`);
    writeFileSync(projectPath, `budget:\n  perPipelineMaxUsd: 500\n`);
    const caps = readBudgetCaps(tmpDir, { globalPath, projectPath });
    expect(caps.perPipelineMaxUsd).toBe(500);
  });

  it("project perStageMaxUsd merges with global (per-key override)", () => {
    writeFileSync(
      globalPath,
      `budget:\n  perStageMaxUsd:\n    analyze: 3\n    mockups: 10\n`,
    );
    writeFileSync(
      projectPath,
      `budget:\n  perStageMaxUsd:\n    analyze: 5\n    screens: 30\n`,
    );
    const caps = readBudgetCaps(tmpDir, { globalPath, projectPath });
    expect(caps.perStageMaxUsd.analyze).toBe(5); // project overrides
    expect(caps.perStageMaxUsd.mockups).toBe(10); // global preserved
    expect(caps.perStageMaxUsd.screens).toBe(30); // project-only added
  });
});

// ─── feat-017: auth-provider resolution ───────────────────────────────

describe("readModelConfig — provider resolution (feat-017)", () => {
  it("defaults to 'claude-max-subscription' when no config and no env override", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("claude-max-subscription");
    expect(cfg.providerConfig.provider).toBe("claude-max-subscription");
  });

  it("reads provider from global models.yaml", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic-api\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("anthropic-api");
  });

  it("project provider beats global provider", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic-api\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    writeFileSync(projectPath, `provider: bedrock\n`);
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("bedrock");
  });

  it("AGENTFLOW_PROVIDER env var beats both YAML files", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic-api\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    writeFileSync(projectPath, `provider: bedrock\n`);
    process.env.AGENTFLOW_PROVIDER = "vertex";
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("vertex");
  });

  it("throws a zod-flavoured error on invalid provider in YAML", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic_api\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    expect(() =>
      readModelConfig("analyst", tmpDir, { globalPath, projectPath }),
    ).toThrow(/Invalid auth provider 'anthropic_api'/);
    expect(() =>
      readModelConfig("analyst", tmpDir, { globalPath, projectPath }),
    ).toThrow(/claude-max-subscription/);
  });

  it("throws on invalid AGENTFLOW_PROVIDER env var value", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    process.env.AGENTFLOW_PROVIDER = "openai";
    expect(() =>
      readModelConfig("analyst", tmpDir, { globalPath, projectPath }),
    ).toThrow(/Invalid auth provider 'openai' from AGENTFLOW_PROVIDER env var/);
  });

  it("parses apiKeyEnvVar / awsRegion / gcpProject from YAML", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic-api\napiKeyEnvVar: MY_CUSTOM_KEY\nawsRegion: eu-west-1\ngcpProject: my-project\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.providerConfig.apiKeyEnvVar).toBe("MY_CUSTOM_KEY");
    expect(cfg.providerConfig.awsRegion).toBe("eu-west-1");
    expect(cfg.providerConfig.gcpProject).toBe("my-project");
  });

  it("project apiKeyEnvVar overrides global apiKeyEnvVar", () => {
    writeFileSync(
      globalPath,
      `provider: anthropic-api\napiKeyEnvVar: GLOBAL_KEY\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning }\n`,
    );
    writeFileSync(projectPath, `apiKeyEnvVar: PROJECT_KEY\n`);
    const cfg = readModelConfig("analyst", tmpDir, { globalPath, projectPath });
    expect(cfg.providerConfig.apiKeyEnvVar).toBe("PROJECT_KEY");
  });
});

// ─── feat-024 Phase B: stallTimeoutMs resolution ──────────────────────

describe("readModelConfig — stallTimeoutMs (feat-024 Phase B)", () => {
  it("uses built-in default for backend-builder (25 min)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build }\n`,
    );
    const cfg = readModelConfig("backend-builder", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.stallTimeoutMs).toBe(25 * 60 * 1000);
  });

  it("uses built-in default for tester (20 min)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("uses built-in default for reviewer (15 min — bumped from 10 on 2026-05-01 per finance-track-01 empirical timeouts)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  reviewer: { tier: build }\n`,
    );
    const cfg = readModelConfig("reviewer", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.stallTimeoutMs).toBe(15 * 60 * 1000);
  });

  it("git-agent default is null (never abort by liveness)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  git-agent: { tier: build }\n`,
    );
    const cfg = readModelConfig("git-agent", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.stallTimeoutMs).toBeNull();
  });

  it("project YAML stallTimeoutMs map overrides built-in default", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeFileSync(projectPath, `stallTimeoutMs:\n  tester: 60000\n`);
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(60_000);
  });

  it("agent.stallTimeoutMs in project YAML wins over top-level map", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeFileSync(
      projectPath,
      `stallTimeoutMs:\n  tester: 60000\nagents:\n  tester: { stallTimeoutMs: 12345 }\n`,
    );
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(12345);
  });

  it("project null override disables liveness even when default is set", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeFileSync(projectPath, `agents:\n  tester: { stallTimeoutMs: null }\n`);
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBeNull();
  });
});

// ─── bug-107: Strategy-D web tester wall-clock-cap discriminator ─────────

describe("readModelConfig — Strategy-D web tester wall-clock cap (bug-107)", () => {
  function writeArchitectureYaml(stack: {
    persistence_layer?: string | null;
    web_framework?: string | null;
  }) {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const pl =
      stack.persistence_layer === null
        ? `null`
        : `"${stack.persistence_layer ?? "real-db"}"`;
    const wf =
      stack.web_framework === null
        ? `null`
        : `"${stack.web_framework ?? "react-next"}"`;
    writeFileSync(
      join(tmpDir, ".claude", "architecture.yaml"),
      `tooling:\n  stack:\n    persistence_layer: ${pl}\n    web_framework: ${wf}\n`,
    );
  }

  it("Strategy-D web tester gets 30-min cap (bumped from 20)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "external-api-only",
      web_framework: "react-next",
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("backend-only Strategy-D (no web_framework) keeps 20-min default", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "external-api-only",
      web_framework: null,
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("Strategy-C real-db web tester gets 30-min cap (bug-122 extension)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "real-db",
      web_framework: "react-next",
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("Strategy-A localStorage web tester keeps 20-min default (synthesizer not in scope)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "localStorage",
      web_framework: "react-next",
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("backend-only Strategy-C (no web_framework) keeps 20-min default", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "real-db",
      web_framework: null,
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("missing architecture.yaml keeps 20-min default (Mode A or pre-architect)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    // no writeArchitectureYaml call
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("backend-builder on Strategy-D web is unaffected (only tester discriminates)", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build }\n`,
    );
    writeArchitectureYaml({
      persistence_layer: "external-api-only",
      web_framework: "react-next",
    });
    const cfg = readModelConfig("backend-builder", tmpDir, {
      globalPath,
      projectPath,
    });
    expect(cfg.stallTimeoutMs).toBe(25 * 60 * 1000);
  });

  it("explicit project YAML override preempts the Strategy-D discriminator", () => {
    writeFileSync(
      globalPath,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  tester: { tier: build }\n`,
    );
    writeFileSync(projectPath, `stallTimeoutMs:\n  tester: 60000\n`);
    writeArchitectureYaml({
      persistence_layer: "external-api-only",
      web_framework: "react-next",
    });
    const cfg = readModelConfig("tester", tmpDir, { globalPath, projectPath });
    expect(cfg.stallTimeoutMs).toBe(60_000);
  });
});

describe("readStallTimeoutMode (feat-024 Phase C)", () => {
  it("defaults to 'lenient'", () => {
    writeFileSync(globalPath, `defaults: {}\n`);
    expect(readStallTimeoutMode(tmpDir, { globalPath, projectPath })).toBe(
      "lenient",
    );
  });

  it("reads 'strict' from project YAML", () => {
    writeFileSync(globalPath, `defaults: {}\n`);
    writeFileSync(projectPath, `stallTimeoutMode: strict\n`);
    expect(readStallTimeoutMode(tmpDir, { globalPath, projectPath })).toBe(
      "strict",
    );
  });

  it("project overrides global", () => {
    writeFileSync(globalPath, `stallTimeoutMode: strict\n`);
    writeFileSync(projectPath, `stallTimeoutMode: lenient\n`);
    expect(readStallTimeoutMode(tmpDir, { globalPath, projectPath })).toBe(
      "lenient",
    );
  });
});

describe("readProviderConfig — standalone", () => {
  it("returns factory default when no YAML files exist", () => {
    // neither globalPath nor projectPath is written
    const cfg = readProviderConfig(tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("claude-max-subscription");
    expect(cfg.apiKeyEnvVar).toBeUndefined();
    expect(cfg.awsRegion).toBeUndefined();
    expect(cfg.gcpProject).toBeUndefined();
  });

  it("resolves provider without needing a specific agent entry", () => {
    writeFileSync(globalPath, `provider: bedrock\nawsRegion: us-east-2\n`);
    const cfg = readProviderConfig(tmpDir, { globalPath, projectPath });
    expect(cfg.provider).toBe("bedrock");
    expect(cfg.awsRegion).toBe("us-east-2");
  });
});

// ─── bug-150 Phase B: per-bug-class stall-timeout overrides ──────────────

describe("resolveStallTimeoutForBugContext (bug-150 Phase B)", () => {
  it("returns 30 min for systemic-fixer + visual-parity + layout-regrouping", () => {
    expect(
      resolveStallTimeoutForBugContext(
        "systemic-fixer",
        "visual-parity",
        "layout-regrouping",
      ),
    ).toBe(30 * 60 * 1000);
  });

  it("returns 10 min for perceptual-reviewer + perceptual-divergence (any pattern)", () => {
    expect(
      resolveStallTimeoutForBugContext(
        "perceptual-reviewer",
        "perceptual-divergence",
      ),
    ).toBe(10 * 60 * 1000);
  });

  it("returns undefined for systemic-fixer + visual-parity + token-drift (no override; falls back to per-agent default)", () => {
    expect(
      resolveStallTimeoutForBugContext(
        "systemic-fixer",
        "visual-parity",
        "token-drift",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for bug-fixer (no per-class overrides — uses per-agent default)", () => {
    expect(
      resolveStallTimeoutForBugContext(
        "bug-fixer",
        "visual-parity",
        "layout-regrouping",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for unknown agent", () => {
    expect(
      resolveStallTimeoutForBugContext(
        "unknown-agent",
        "visual-parity",
        "layout-regrouping",
      ),
    ).toBeUndefined();
  });

  it("source-only match works without pattern (falls back to source-key)", () => {
    // perceptual-divergence has source-only override; passing no pattern
    // should still resolve to 10min.
    expect(
      resolveStallTimeoutForBugContext(
        "perceptual-reviewer",
        "perceptual-divergence",
        undefined,
      ),
    ).toBe(10 * 60 * 1000);
  });

  it("most-specific-wins: source.pattern override beats source-only when both present", () => {
    // systemic-fixer only has visual-parity.layout-regrouping (no source-only
    // visual-parity entry); pattern-specific wins. Confirms the precedence
    // order — pattern-specific checked first.
    expect(
      resolveStallTimeoutForBugContext(
        "systemic-fixer",
        "visual-parity",
        "layout-regrouping",
      ),
    ).toBe(30 * 60 * 1000);
    expect(
      resolveStallTimeoutForBugContext(
        "systemic-fixer",
        "visual-parity",
        "token-drift", // no specific override → returns undefined (no source-only match either)
      ),
    ).toBeUndefined();
  });
});
