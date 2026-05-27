import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Provider, type ProviderConfig } from "@repo/orchestrator-contracts";
import yaml from "js-yaml";

/**
 * Resolved config for one agent invocation.
 *
 * `model` is the SDK model identifier. `effort` maps to the Agent SDK's
 * extended-thinking setting (`low | medium | high | max`). `budgetUsd` is a
 * soft per-invocation hint — the hard per-stage cap lives on
 * `PipelineStage.budgetUsd`, and the pipeline-wide ceiling is enforced by
 * `BudgetTracker` via `perPipelineMaxUsd`.
 *
 * `provider` + `providerConfig` carry the auth-backend selection (feat-017).
 * They're resolved from the same YAML files via a top-level `provider:` key;
 * see docs/agent-sdk-auth-providers.md for precedence + semantics.
 */
export interface ModelConfig {
  provider: Provider;
  providerConfig: ProviderConfig;
  model: string;
  effort: "low" | "medium" | "high" | "max";
  budgetUsd: number;
  /**
   * feat-024 Phase B — wall-clock + keepalive abort budget for one
   * `runLlmAgent` invocation. `null` means "never abort by liveness"
   * (used by git-agent which doesn't actually call the SDK). Defaults
   * documented in `.claude/models.yaml` template:
   *   - backend-builder, web-frontend-builder, mobile-frontend-builder: 25*60*1000
   *   - tester: 20*60*1000
   *   - reviewer, security: 10*60*1000
   *   - git-agent: null
   */
  stallTimeoutMs: number | null;
}

export interface BudgetCaps {
  perPipelineMaxUsd: number;
  perStageMaxUsd: Record<string, number>;
}

interface RawYaml {
  version?: string;
  extends?: string;
  /** Top-level auth provider selection (feat-017). */
  provider?: string;
  /** For `anthropic-api`: env var name holding the key. */
  apiKeyEnvVar?: string;
  /** For `bedrock`: AWS region override. */
  awsRegion?: string;
  /** For `vertex`: GCP project override. */
  gcpProject?: string;
  defaults?: Record<string, string>;
  agents?: Record<
    string,
    Partial<{
      tier: string;
      model: string;
      effort: ModelConfig["effort"];
      budgetUsd: number;
      /**
       * feat-024 Phase B — `null` (or omitted) inherits from
       * `defaults.stallTimeoutMs.<agent>` (project YAML) or the
       * built-in fallback in DEFAULT_STALL_TIMEOUT_BY_AGENT below.
       */
      stallTimeoutMs: number | null;
    }>
  >;
  /**
   * feat-024 Phase B + feat-024 Phase C: top-level liveness defaults.
   * `stallTimeoutMs` is the per-agent wall-clock + keepalive budget.
   * `stallTimeoutMode` selects "lenient" (default) → mark feature
   * failed and continue, or "strict" → trigger a pause via paused.json
   * so the operator can intervene.
   */
  stallTimeoutMs?: Record<string, number | null>;
  stallTimeoutMode?: "lenient" | "strict";
  budget?: {
    perPipelineMaxUsd?: number;
    perStageMaxUsd?: Record<string, number>;
  };
}

const DEFAULT_EFFORT: ModelConfig["effort"] = "medium";
const DEFAULT_BUDGET_USD = 5;
const DEFAULT_PIPELINE_MAX_USD = 150;

/**
 * feat-024 Phase B factory defaults for `stallTimeoutMs`. Mirrors the
 * recommendation in investigate-007 §F4-#1 — builders get more headroom
 * than testers/reviewers, git-agent is exempt entirely (deterministic
 * git ops, no SDK call). Override per-agent in the project's
 * `.claude/models.yaml` under `stallTimeoutMs:` or per-agent
 * `agents.<name>.stallTimeoutMs`.
 *
 * 2026-05-01: reviewer + security bumped 10 → 15 min after empirical
 * pattern on finance-track-01 (3/30 reviewer dispatches hit the 10-min
 * wall). Reviewer walks 7 dimensions of `docs/reviewer-playbook.md`
 * against the full feature diff; for medium/large diffs (5+ task files
 * + extensive tester edge-cases) the per-dimension reasoning blows the
 * 10-min budget. 15 min is a band-aid pending a structural fix
 * (per-dimension cap or diff-summarization pre-pass) — see bug-037 if
 * filed.
 */
/**
 * feat-065-followup (2026-05-08) — Factory-shipped agents that may not
 * yet be present in operator-managed `~/.claude/models.yaml`. When the
 * resolver can't find an agent in either project or global YAML, it
 * checks here first before throwing "No model resolved".
 *
 * Precedence (lowest first):
 *   1. FACTORY_DEFAULT_AGENT_TIERS (this map)
 *   2. global ~/.claude/models.yaml agents.<name>
 *   3. project .claude/models.yaml agents.<name>
 *   4. ANTHROPIC_MODEL env var (highest)
 *
 * Add an entry here whenever the factory ships a new agent that isn't
 * already documented in the canonical `~/.claude/models.yaml` template.
 * The operator can override the tier/effort here by adding the agent
 * to their home YAML.
 *
 * Empirical motivator: reading-log-02 validation 2026-05-08 — bug-fixer
 * (feat-064) was added to the factory + project models.yaml but the
 * operator's home file lacked it. Existing projects with empty
 * `agents: {}` in their project YAML hit "No model resolved" cascade-
 * fail.
 */
const FACTORY_DEFAULT_AGENT_TIERS: Record<
  string,
  { tier?: string; effort?: ModelConfig["effort"] }
> = {
  // bug-fixer — narrow-scope patch agent for /fix-bugs loop dispatches
  // (feat-064). tier:building + effort:medium reflects "narrow-scope
  // with pre-loaded context" — bug-fixer doesn't need full exploration
  // depth (the orchestrator's buildBugContextEnvelope supplies it).
  "bug-fixer": { tier: "building", effort: "medium" },
  // systemic-fixer — cross-file root-cause variant (feat-070, feat-066 v2
  // Phase 5). Same building tier as bug-fixer; effort stays medium per
  // investigate-024 evidence that Sonnet handles these tasks without
  // Opus's 5× cost premium. The agent's frontmatter (maxTurns: 12) plus
  // the 18-min stall cap below provide the budget for cross-file
  // exploration; the tier itself doesn't need to differ.
  "systemic-fixer": { tier: "building", effort: "medium" },
  // perceptual-reviewer — Tier 4 vision-LLM agent (feat-068). Per-screen
  // mockup-vs-live image comparison + structured-output findings.
  // tier:building resolves to Sonnet (vision-capable, ~5× cheaper than
  // Opus); the task is pattern-recognition over images, not deep
  // reasoning. effort:medium gives enough budget for image inputs +
  // parity-context preload without wasting it on reasoning depth.
  "perceptual-reviewer": { tier: "building", effort: "medium" },
  // walkthrough-reviewer — Tier 5 AI walkthrough behavioral agent (feat-069).
  // ONE invocation per fix-loop iteration; reads N screenshots + network
  // log + console log as a coherent journey + emits behavioral findings.
  // tier:building (Sonnet) — same rationale as perceptual: image-pattern
  // recognition + cross-step reasoning, NOT deep multi-step logic. The
  // cross-step reasoning needs slightly more headroom than perceptual's
  // per-screen pattern-matching, so effort:medium with the maxTurns:4 cap
  // in the frontmatter is the right shape.
  "walkthrough-reviewer": { tier: "building", effort: "medium" },
};

/**
 * bug-107 (2026-05-15) — Strategy-D web tester needs a longer wall-clock cap
 * than the global default. Per investigate-031 H1+H2: the synthesize-flow-e2e
 * step + Playwright child processes + page.route mock authoring + edge-case
 * unit tests + coverage run is 4-5× a backend tester's workload and routinely
 * exceeds the 20-min default, especially at elevated rate-limit utilization.
 * Empirical anchor: gotribe-tribe-directory feat-tribe-directory-web 2026-05-15
 * (2 × 20-min stall-timeouts, $3.25 wasted; web tester needed >20 min,
 * backend testers in the same run finished in <5 min).
 *
 * Resolves to 30 min instead of 20 when the conditions match:
 *   - agentName === "tester"
 *   - architecture.yaml.tooling.stack.persistence_layer === "external-api-only"
 *   - architecture.yaml.tooling.stack.web_framework is set (non-null)
 *
 * Other tester contexts (backend-only Strategy-D, Strategy-A localStorage,
 * Strategy-C real-db) keep the 20-min default. Explicit overrides in
 * .claude/models.yaml at higher precedence steps still win.
 */
const STRATEGY_D_WEB_TESTER_STALL_TIMEOUT = 30 * 60 * 1000;

/**
 * Lightweight regex parse of architecture.yaml to extract the two slots
 * relevant to per-agent wall-clock cap discrimination. Returns null when
 * the file is absent (Mode A stages, pre-architect) or parse fails.
 *
 * Mirrors `readPersistenceLayerSlug` in dev-server.ts; kept private here to
 * avoid a cross-module dependency for one helper. Both helpers must stay in
 * sync if `architecture.yaml.tooling.stack.*` shape evolves.
 */
function readArchStackContext(
  projectRoot: string,
): { persistenceLayer: string | null; webFramework: string | null } | null {
  const archPath = join(projectRoot, ".claude", "architecture.yaml");
  if (!existsSync(archPath)) return null;
  try {
    const text = readFileSync(archPath, "utf8");
    const pl = text.match(/^\s*persistence_layer:\s*"?([\w-]+)"?\s*(?:#.*)?$/m);
    const wf = text.match(/^\s*web_framework:\s*"?([\w-]+)"?\s*(?:#.*)?$/m);
    return {
      persistenceLayer: pl?.[1] ?? null,
      webFramework: wf?.[1] && wf[1] !== "null" ? wf[1] : null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the default stall-timeout for an agent, applying class-discrimination
 * where the workload of a given (agent, project stack) pair structurally needs
 * a different cap. Called from `readModelConfig` at the lowest-precedence step
 * (after all YAML overrides have been considered); explicit project/global
 * overrides preempt this discrimination.
 *
 * Today's only discriminator: bug-107 Strategy-D web tester → 30 min.
 * Future discriminators (e.g. Strategy-C real-db tester needing 25 min) plug
 * in here with their own conditions.
 */
function resolveDefaultStallTimeout(
  agentName: string,
  projectRoot: string,
): number | null {
  if (agentName === "tester") {
    const arch = readArchStackContext(projectRoot);
    // bug-122 (2026-05-18): Strategy-C (real-db) web testers run the same
    // synthesize-flow-e2e + Playwright + coverage workload as Strategy-D
    // (external-api-only) web testers. The 20-min default is structurally
    // too tight for both. Empirical anchor: gotribe-member-profile
    // feat-scaffold tester 2026-05-17 — Strategy-C web, hit wall-clock cap
    // at $3.01 burn. bug-107 originally scoped to Strategy-D only because
    // its empirical case (gotribe-tribe-directory) was Strategy-D; the
    // structural diagnosis applies to both layers that involve the
    // synthesizer. Strategy-A (localStorage) is excluded — kanban-class
    // web testers don't dispatch the synthesizer + Playwright chain and
    // do fit in 20min.
    const isSynthesizerWorkloadLayer =
      arch &&
      (arch.persistenceLayer === "external-api-only" ||
        arch.persistenceLayer === "real-db");
    if (isSynthesizerWorkloadLayer && arch.webFramework !== null) {
      return STRATEGY_D_WEB_TESTER_STALL_TIMEOUT;
    }
  }
  return DEFAULT_STALL_TIMEOUT_BY_AGENT[agentName] ?? null;
}

const DEFAULT_STALL_TIMEOUT_BY_AGENT: Record<string, number | null> = {
  "backend-builder": 25 * 60 * 1000,
  "web-frontend-builder": 25 * 60 * 1000,
  "mobile-frontend-builder": 25 * 60 * 1000,
  tester: 20 * 60 * 1000,
  reviewer: 15 * 60 * 1000,
  security: 15 * 60 * 1000,
  "git-agent": null,
  // feat-065 (2026-05-08) — narrow-scope patch agent for /fix-bugs loop.
  // Tighter cap than tier-specific builders because bug-fixer's
  // maxTurns:8 frontmatter forces convergence; combining the two
  // eliminates the "agent wandered 25 min" failure mode observed in
  // reading-log-02 /fix-bugs run b0e1281c. Per investigate-024 §F8.
  // feat-065-followup-2 (2026-05-08): bumped 10 → 15 min after
  // empirical evidence that 10 was too tight for parity bugs that
  // require structural JSX restructuring. flow-5 hit the 10min cap
  // mid-fix-attempt; 15 gives cushion without losing the fail-fast
  // discipline (vs the 25min full-builder cap).
  "bug-fixer": 15 * 60 * 1000,
  // feat-070 (2026-05-11) — systemic-fixer needs more wall-clock than
  // bug-fixer because cross-file root-cause work involves more Reads +
  // multiple Edits in one dispatch. 18 min pairs with maxTurns: 12 (vs
  // bug-fixer's 8) — investigate-025 §H1 estimated 8-12 min median for
  // bug-077-class work; 18 gives ~50% headroom for the long tail without
  // letting the agent wander past the bug-fixer's failure-mode budget.
  "systemic-fixer": 18 * 60 * 1000,
  // feat-068 (2026-05-12) — perceptual-reviewer is a 3-turn read+write
  // agent: read mockup + live PNGs, write findings JSON, return outcome.
  // 5-minute cap is generous — typical wall-clock per screen is ~30-60s.
  "perceptual-reviewer": 5 * 60 * 1000,
  // feat-069 (2026-05-13) — walkthrough-reviewer reads N screenshots +
  // network/console NDJSON logs in one pass and emits behavioral findings.
  // More turns (4 vs 3) + larger evidence bundle → 8-minute cap. Empirically
  // a 24-step walkthrough with 24 PNGs + ~200 network events + ~10 console
  // events should resolve in 2-4 min; 8 gives 2× headroom.
  "walkthrough-reviewer": 8 * 60 * 1000,
};

/**
 * bug-150 Phase B (2026-05-26) — per-bug-class wall-clock overrides.
 *
 * The default stall caps above assume a "typical" dispatch surface for each
 * agent. Some (agent, bug-source[, bug-pattern]) combinations have an
 * empirically-observed larger surface that exceeds the default cap. Listing
 * them here lifts the cap for the specific combo WITHOUT affecting the
 * defaults for other dispatches.
 *
 * Empirical motivator: `gotribe-event-calendar` 2026-05-22 `/fix-bugs` run
 *   - 3 of 4 `visual-parity` + `layout-regrouping` bugs dispatched to
 *     `systemic-fixer` hit `error_stall_timeout: wall-clock-1080000ms`
 *     (18min default) × 2 attempts each ≈ 72min wall-clock with no progress.
 *     Calendar-week's smaller fix surface succeeded; the 3 failures all had
 *     30+ missing kit-component instances.
 *   - 2 `perceptual-divergence` bugs hit `wall-clock-timeout` on calendar-day
 *     + calendar-week (large vision-LLM surfaces).
 *
 * Schema: outer key is the agent name; inner is `bug.source` (optionally
 * `.${bug.parity?.pattern}` for further specificity). `resolveStallTimeoutForBugContext`
 * checks pattern-specific first, then source-only, then falls through to the
 * per-agent default in FACTORY_DEFAULT_STALL_TIMEOUTS.
 *
 * Adding a row here is the right knob when (a) the failure shape is
 * empirically wall-clock-bound (not turn-budget or token-cost), AND (b)
 * the class is identifiable from `bug.source` (+ optional pattern). For
 * deeper structural fixes (e.g. surface-splitting upstream), see
 * `plans/active/bug-150-*.md` §Phase C.
 */
const FACTORY_PER_BUG_CLASS_STALL_OVERRIDES: Record<
  string,
  Record<string, number>
> = {
  "systemic-fixer": {
    // bug-150 — layout-regrouping has 20-33 missing kit-component
    // instances + 7-14 extras per screen. 12-turn × cross-file Read +
    // Edit budget needs ~25-30min wall-clock; 30 covers the long tail.
    "visual-parity.layout-regrouping": 30 * 60 * 1000,
  },
  "perceptual-reviewer": {
    // bug-150 — large-surface vision-LLM screens (calendar week + day
    // views with 12+ high-detail elements) exceed the 5-min default.
    // 10min covers the empirical wall-clock-timeout cases without
    // changing the default for typical screens (~30-60s per).
    "perceptual-divergence": 10 * 60 * 1000,
  },
};

/**
 * bug-150 Phase B — resolve the stall timeout for a per-bug dispatch.
 * Checks the per-bug-class override table first (most-specific to
 * least-specific: `<source>.<pattern>` then `<source>`) and falls back
 * to the per-agent default. Returns `undefined` when no override
 * applies — caller should fall back to its existing per-agent resolution.
 *
 * Exported for use by `fix-bugs-loop.ts::dispatchAgentsForBug`.
 */
export function resolveStallTimeoutForBugContext(
  agent: string,
  bugSource: string,
  bugPattern?: string,
): number | undefined {
  const agentOverrides = FACTORY_PER_BUG_CLASS_STALL_OVERRIDES[agent];
  if (!agentOverrides) return undefined;
  // Most-specific first: source.pattern
  if (bugPattern) {
    const specific = agentOverrides[`${bugSource}.${bugPattern}`];
    if (specific !== undefined) return specific;
  }
  // Fall back to source-only
  const sourceOnly = agentOverrides[bugSource];
  return sourceOnly;
}

/**
 * Factory default auth provider. Subscription mode is chosen so the factory
 * operator's Claude Max quota covers SDK calls (zero incremental cost). A
 * public-product distribution can override this build-time constant in
 * `orchestrator/src/defaults.ts` — see docs/agent-sdk-auth-providers.md
 * §"Public product release path".
 */
const FACTORY_DEFAULT_PROVIDER: Provider = "claude-max-subscription";

function loadYaml(path: string): RawYaml {
  if (!existsSync(path)) return {};
  const parsed = yaml.load(readFileSync(path, "utf8"));
  return (parsed ?? {}) as RawYaml;
}

/**
 * Resolve the auth-provider config from merged YAML + env.
 *
 * Precedence (highest → lowest):
 *   1. `process.env.AGENTFLOW_PROVIDER` — session-level override
 *   2. `<projectRoot>/.claude/models.yaml` top-level `provider:`
 *   3. `~/.claude/models.yaml` top-level `provider:`
 *   4. Factory fallback: `claude-max-subscription`
 *
 * Provider-specific fields (`apiKeyEnvVar`, `awsRegion`, `gcpProject`) are
 * resolved project-wins from the same files. An invalid provider value
 * (typo, unknown enum) throws a clear zod validation error.
 */
function resolveProviderConfig(
  globalCfg: RawYaml,
  projectCfg: RawYaml,
): ProviderConfig {
  const envOverride = process.env.AGENTFLOW_PROVIDER;
  const rawProvider =
    envOverride ??
    projectCfg.provider ??
    globalCfg.provider ??
    FACTORY_DEFAULT_PROVIDER;

  const parseResult = Provider.safeParse(rawProvider);
  if (!parseResult.success) {
    const validValues = Provider.options.join(", ");
    const source = envOverride
      ? "AGENTFLOW_PROVIDER env var"
      : projectCfg.provider
        ? "project .claude/models.yaml `provider:`"
        : "global ~/.claude/models.yaml `provider:`";
    throw new Error(
      `Invalid auth provider '${rawProvider}' from ${source}. ` +
        `Valid values: ${validValues}. ` +
        `See docs/agent-sdk-auth-providers.md.`,
    );
  }

  const apiKeyEnvVar = projectCfg.apiKeyEnvVar ?? globalCfg.apiKeyEnvVar;
  const awsRegion = projectCfg.awsRegion ?? globalCfg.awsRegion;
  const gcpProject = projectCfg.gcpProject ?? globalCfg.gcpProject;

  return {
    provider: parseResult.data,
    ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
    ...(awsRegion ? { awsRegion } : {}),
    ...(gcpProject ? { gcpProject } : {}),
  };
}

/**
 * Read + merge `~/.claude/models.yaml` (global) with
 * `<projectRoot>/.claude/models.yaml` (project). Project wins.
 *
 * `agentName` selects the agent entry; tier→model lookup uses the merged
 * `defaults` map. `ANTHROPIC_MODEL` env var overrides the resolved model
 * as the final escape hatch (CLAUDE.md rule).
 *
 * Returns `{ provider, providerConfig, model, effort, budgetUsd }`; auth
 * backend selection is per-run (not per-agent) — see
 * docs/agent-sdk-auth-providers.md.
 */
export function readModelConfig(
  agentName: string,
  projectRoot: string,
  opts?: { globalPath?: string; projectPath?: string },
): ModelConfig {
  const globalPath =
    opts?.globalPath ?? join(homedir(), ".claude", "models.yaml");
  const projectPath =
    opts?.projectPath ?? join(projectRoot, ".claude", "models.yaml");

  const globalCfg = loadYaml(globalPath);
  const projectCfg = loadYaml(projectPath);

  const mergedDefaults: Record<string, string> = {
    ...(globalCfg.defaults ?? {}),
    ...(projectCfg.defaults ?? {}),
  };

  const globalAgent = globalCfg.agents?.[agentName] ?? {};
  const projectAgent = projectCfg.agents?.[agentName] ?? {};
  // feat-065-followup (2026-05-08) — `FACTORY_DEFAULT_AGENT_TIERS` is a
  // hardcoded fallback for agents that ship in the factory but may not be
  // present in operator-managed `~/.claude/models.yaml` yet (typical for
  // freshly-introduced agents like bug-fixer). Without this fallback, a
  // /fix-bugs run on an existing project crashes with "No model resolved"
  // until the operator manually edits their home file. The fallback is
  // applied with LOWEST precedence — both project + global YAML override
  // it. Empirical: reading-log-02 validation 2026-05-08.
  const factoryDefault = FACTORY_DEFAULT_AGENT_TIERS[agentName] ?? {};
  const agent = { ...factoryDefault, ...globalAgent, ...projectAgent };

  let model: string | undefined;
  if (process.env.ANTHROPIC_MODEL) {
    model = process.env.ANTHROPIC_MODEL;
  } else if (agent.model) {
    model = agent.model;
  } else if (agent.tier && mergedDefaults[agent.tier]) {
    model = mergedDefaults[agent.tier];
  }

  if (!model) {
    throw new Error(
      `No model resolved for agent '${agentName}'. ` +
        `Set ~/.claude/models.yaml agents.${agentName}.tier (with a matching defaults entry) ` +
        `or a direct model override, or ANTHROPIC_MODEL env var.`,
    );
  }

  const effort = agent.effort ?? DEFAULT_EFFORT;
  const budgetUsd = agent.budgetUsd ?? DEFAULT_BUDGET_USD;

  // feat-024 Phase B: resolve stallTimeoutMs per agent. Precedence
  //   1. agent.stallTimeoutMs in project YAML
  //   2. agent.stallTimeoutMs in global YAML
  //   3. project YAML's top-level `stallTimeoutMs.<agent>` map
  //   4. global YAML's top-level `stallTimeoutMs.<agent>` map
  //   5. built-in `DEFAULT_STALL_TIMEOUT_BY_AGENT[agent]`
  //   6. `null` (never abort by liveness) for unmapped agents
  // `null` explicitly disables; missing means "fall through".
  let stallTimeoutMs: number | null = null;
  if (agent.stallTimeoutMs !== undefined) {
    stallTimeoutMs = agent.stallTimeoutMs;
  } else if (projectCfg.stallTimeoutMs?.[agentName] !== undefined) {
    stallTimeoutMs = projectCfg.stallTimeoutMs[agentName] ?? null;
  } else if (globalCfg.stallTimeoutMs?.[agentName] !== undefined) {
    stallTimeoutMs = globalCfg.stallTimeoutMs[agentName] ?? null;
  } else if (agentName in DEFAULT_STALL_TIMEOUT_BY_AGENT) {
    // bug-107: Class-discriminator. Strategy-D web tester gets 30 min instead
    // of the global 20-min default. Explicit overrides at steps 1-4 win.
    stallTimeoutMs = resolveDefaultStallTimeout(agentName, projectRoot);
  }

  const providerConfig = resolveProviderConfig(globalCfg, projectCfg);

  return {
    provider: providerConfig.provider,
    providerConfig,
    model,
    effort,
    budgetUsd,
    stallTimeoutMs,
  };
}

/** feat-024 Phase C — read the `stallTimeoutMode` setting (default lenient). */
export function readStallTimeoutMode(
  projectRoot: string,
  opts?: { globalPath?: string; projectPath?: string },
): "lenient" | "strict" {
  const globalPath =
    opts?.globalPath ?? join(homedir(), ".claude", "models.yaml");
  const projectPath =
    opts?.projectPath ?? join(projectRoot, ".claude", "models.yaml");
  const globalCfg = loadYaml(globalPath);
  const projectCfg = loadYaml(projectPath);
  return projectCfg.stallTimeoutMode ?? globalCfg.stallTimeoutMode ?? "lenient";
}

/**
 * Read the resolved auth-provider config without resolving a specific
 * agent's model/effort/budget. Used by `cli-runner.ts` to log the active
 * provider at startup; also useful for other run-level wiring that wants
 * just the provider selection.
 *
 * Same precedence as `readModelConfig`'s provider branch:
 *   AGENTFLOW_PROVIDER > project `provider:` > global `provider:` > factory default.
 */
export function readProviderConfig(
  projectRoot: string,
  opts?: { globalPath?: string; projectPath?: string },
): ProviderConfig {
  const globalPath =
    opts?.globalPath ?? join(homedir(), ".claude", "models.yaml");
  const projectPath =
    opts?.projectPath ?? join(projectRoot, ".claude", "models.yaml");

  const globalCfg = loadYaml(globalPath);
  const projectCfg = loadYaml(projectPath);

  return resolveProviderConfig(globalCfg, projectCfg);
}

/**
 * Read the merged budget caps. Used by `BudgetTracker` at pipeline startup.
 * Project values override global; missing keys fall back to defaults.
 */
export function readBudgetCaps(
  projectRoot: string,
  opts?: { globalPath?: string; projectPath?: string },
): BudgetCaps {
  const globalPath =
    opts?.globalPath ?? join(homedir(), ".claude", "models.yaml");
  const projectPath =
    opts?.projectPath ?? join(projectRoot, ".claude", "models.yaml");

  const globalCfg = loadYaml(globalPath);
  const projectCfg = loadYaml(projectPath);

  const perPipelineMaxUsd =
    projectCfg.budget?.perPipelineMaxUsd ??
    globalCfg.budget?.perPipelineMaxUsd ??
    DEFAULT_PIPELINE_MAX_USD;

  const perStageMaxUsd: Record<string, number> = {
    ...(globalCfg.budget?.perStageMaxUsd ?? {}),
    ...(projectCfg.budget?.perStageMaxUsd ?? {}),
  };

  return { perPipelineMaxUsd, perStageMaxUsd };
}
