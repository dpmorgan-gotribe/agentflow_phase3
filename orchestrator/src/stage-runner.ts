import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { PipelineStage } from "@repo/orchestrator-contracts";
import { resolveAuthOptions } from "./auth-provider.js";
import type { BudgetTracker } from "./budget-tracker.js";
import { BudgetExceededError } from "./budget-tracker.js";
import { readModelConfig, type ModelConfig } from "./model-config.js";
import type { RetryCounters } from "./retry-counters.js";

export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => Query;

export interface RunContext {
  projectRoot: string;
  pipelineRunId: string;
  budget: BudgetTracker;
  retryCounters: RetryCounters;
  flags: readonly string[];
  gateApiBase?: string;
  /** Test hook — defaults to the real SDK's `query`. */
  queryFn?: QueryFn;
  /** Test hook — overrides paths for `readModelConfig`. */
  modelConfigOverride?: { globalPath?: string; projectPath?: string };
}

export interface StageResult {
  success: boolean;
  output: unknown;
  costUsd: number;
  attempts: number;
  warnings: string[];
  error?: string;
}

/**
 * Maximum attempts per stage for Layer 5 (output-schema validation) retry.
 * Matches `RETRY_CAPS.layer5 = 3` in retry-counters.ts.
 */
const LAYER5_MAX_ATTEMPTS = 3;

/**
 * Mode A stage primitive. Runs one slash command through the Claude Agent
 * SDK, validates the terminal result against `stage.outputSchema`, and
 * retries on validation failure (up to Layer-5 cap) with the error
 * appended as feedback.
 *
 * Budget:
 *   - `budget.assertUnderBudget(stage.budgetUsd)` fires BEFORE each query
 *     invocation — if pipeline-wide spend would exceed cap, abort.
 *   - After the query returns, `budget.record(total_cost_usd)` runs
 *     unconditionally (we spent the money whether or not the output
 *     validated).
 *
 * Retries:
 *   - Output-schema failure → increments `retryCounters.layer5[stage.name]`
 *   - Exhausted counter → StageResult { success: false, error: "layer5 exhausted" }
 */
export async function runStage(
  stage: PipelineStage,
  ctx: RunContext,
): Promise<StageResult> {
  const queryFn: QueryFn = ctx.queryFn ?? (realQuery as unknown as QueryFn);
  const warnings: string[] = [];
  let totalCostUsd = 0;
  let attempts = 0;
  let lastError: string | undefined;
  let lastValidationErrors: string | undefined;

  const modelConfig = readModelConfig(
    stage.agent,
    ctx.projectRoot,
    ctx.modelConfigOverride,
  );

  while (attempts < LAYER5_MAX_ATTEMPTS) {
    attempts += 1;

    try {
      ctx.budget.assertUnderBudget(stage.budgetUsd);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return {
          success: false,
          output: null,
          costUsd: totalCostUsd,
          attempts,
          warnings,
          error: `budget-exceeded: ${err.message}`,
        };
      }
      throw err;
    }

    const prompt = buildPrompt(stage, lastValidationErrors);
    const options = buildOptions(stage, ctx, modelConfig);

    let result: SDKResultMessage | undefined;
    try {
      const q = queryFn({ prompt, options });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "result") {
          result = msg;
          break;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      warnings.push(`attempt ${attempts}: query threw — ${lastError}`);
      continue;
    }

    if (!result) {
      lastError = "SDK stream ended without a 'result' message";
      warnings.push(`attempt ${attempts}: ${lastError}`);
      continue;
    }

    ctx.budget.record(result.total_cost_usd);
    totalCostUsd += result.total_cost_usd;

    if (result.subtype !== "success") {
      lastError = `SDK result error: ${result.subtype}`;
      warnings.push(`attempt ${attempts}: ${lastError}`);
      if (result.subtype === "error_max_budget_usd") {
        return {
          success: false,
          output: null,
          costUsd: totalCostUsd,
          attempts,
          warnings,
          error: lastError,
        };
      }
      continue;
    }

    const parsed = extractStructuredOutput(result);
    const validation = stage.outputSchema.safeParse(parsed);

    if (validation.success) {
      return {
        success: true,
        output: validation.data,
        costUsd: totalCostUsd,
        attempts,
        warnings,
      };
    }

    lastValidationErrors = formatZodError(validation.error);
    warnings.push(
      `attempt ${attempts}: output failed ${stage.outputSchema.constructor.name} validation`,
    );
    const counterValue = ctx.retryCounters.increment("layer5", stage.name);
    if (counterValue >= LAYER5_MAX_ATTEMPTS) {
      return {
        success: false,
        output: parsed,
        costUsd: totalCostUsd,
        attempts,
        warnings,
        error: `layer5-exhausted: ${lastValidationErrors}`,
      };
    }
  }

  return {
    success: false,
    output: null,
    costUsd: totalCostUsd,
    attempts,
    warnings,
    error: lastError ?? "attempts exhausted without validation success",
  };
}

function buildPrompt(stage: PipelineStage, priorErrors?: string): string {
  const args = (stage.args ?? []).join(" ");
  const base = args ? `${stage.slashCommand} ${args}` : stage.slashCommand;
  if (!priorErrors) return base;
  return (
    `${base}\n\n` +
    `Prior attempt failed output-schema validation with these errors:\n` +
    `${priorErrors}\n\n` +
    `Correct them and re-emit the full return JSON.`
  );
}

function buildOptions(
  stage: PipelineStage,
  ctx: RunContext,
  modelConfig: ModelConfig,
): Options {
  // Resolve auth backend FIRST: `env` may be mutated (ANTHROPIC_API_KEY
  // stripped for subscription mode; CLAUDE_CODE_USE_BEDROCK injected for
  // bedrock; etc.). Our pipeline-specific env vars layer on top.
  const auth = resolveAuthOptions(modelConfig.providerConfig, {
    ...process.env,
  });
  const env: Record<string, string | undefined> = {
    ...auth.env,
    CLAUDE_PIPELINE_FLAGS: ctx.flags.join(","),
  };
  if (stage.gateEnabled && ctx.gateApiBase) {
    env.CLAUDE_GATE_API_BASE = ctx.gateApiBase;
  }

  return {
    model: modelConfig.model,
    effort: modelConfig.effort as NonNullable<Options["effort"]>,
    cwd: ctx.projectRoot,
    env,
    maxBudgetUsd: stage.budgetUsd,
    ...(auth.forceLoginMethod
      ? { forceLoginMethod: auth.forceLoginMethod }
      : {}),
  };
}

function extractStructuredOutput(result: SDKResultMessage): unknown {
  if (result.subtype !== "success") return null;
  if (result.structured_output !== undefined) return result.structured_output;
  const text = result.result.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}\s*$/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function formatZodError(err: {
  issues?: Array<{ path: unknown[]; message: string }>;
}): string {
  if (!err.issues || err.issues.length === 0) return "unknown validation error";
  return err.issues
    .slice(0, 10)
    .map((i) => `- ${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
}
