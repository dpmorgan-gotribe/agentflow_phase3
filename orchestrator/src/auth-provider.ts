import type { ProviderConfig } from "@repo/orchestrator-contracts";

/**
 * Result of resolving a `ProviderConfig` into the concrete SDK/env knobs
 * that `buildOptions()` threads into the Claude Agent SDK.
 *
 * - `forceLoginMethod` — when set, plugged into `Options.forceLoginMethod`
 *   verbatim. Unset for `bedrock` / `vertex` (the SDK picks up the cloud
 *   backend from env toggles, not from `forceLoginMethod`).
 * - `env` — a NEW env object derived from the base env the caller passed
 *   in. The resolver never mutates `process.env` or the input argument.
 *   May inject provider-specific toggles (CLAUDE_CODE_USE_BEDROCK=1, etc.)
 *   or strip conflicting keys (ANTHROPIC_API_KEY in subscription mode).
 */
export interface ResolvedAuth {
  forceLoginMethod?: "claudeai" | "console";
  env: NodeJS.ProcessEnv;
}

/**
 * Pure resolver: turn a `ProviderConfig` into concrete SDK options + env
 * mutations. Call at the edge (buildOptions / createInvokeAgent), then merge
 * the result into the SDK `Options` object.
 *
 * Pure — no side effects. `baseEnv` is copied; the returned `env` is a new
 * object. `process.env` is never touched.
 *
 * Throws a descriptive `Error` when `provider: "anthropic-api"` is selected
 * but the configured env var holds no value. All other providers succeed
 * unconditionally (cloud creds are validated by the cloud SDK at call time,
 * not here).
 *
 * See docs/agent-sdk-auth-providers.md for the full semantic table + the
 * public-product release path.
 */
export function resolveAuthOptions(
  cfg: ProviderConfig,
  baseEnv: NodeJS.ProcessEnv,
): ResolvedAuth {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  switch (cfg.provider) {
    case "claude-max-subscription": {
      // Explicitly unset ANTHROPIC_API_KEY so the SDK's default auth chain
      // can't accidentally fall through to API-billing even if the host env
      // has a stray key lying around.
      delete env.ANTHROPIC_API_KEY;
      return { forceLoginMethod: "claudeai", env };
    }

    case "anthropic-api": {
      const keyName = cfg.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
      const key = env[keyName];
      if (!key) {
        throw new Error(
          `Provider 'anthropic-api' requires env var '${keyName}' to be set ` +
            `with a non-empty Anthropic API key. Either set it, or change ` +
            `the top-level \`provider:\` key in ~/.claude/models.yaml (or the ` +
            `project's .claude/models.yaml) to 'claude-max-subscription'. ` +
            `See docs/agent-sdk-auth-providers.md.`,
        );
      }
      // If the user set a custom var name, mirror its value onto the
      // canonical ANTHROPIC_API_KEY name so the SDK picks it up regardless.
      if (keyName !== "ANTHROPIC_API_KEY") {
        env.ANTHROPIC_API_KEY = key;
      }
      return { forceLoginMethod: "console", env };
    }

    case "bedrock": {
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      if (cfg.awsRegion) {
        env.AWS_REGION = cfg.awsRegion;
      }
      // AWS creds picked up via standard AWS SDK credential chain
      // (env vars / ~/.aws/credentials / instance profile). No
      // forceLoginMethod — bedrock is an orthogonal backend switch.
      return { env };
    }

    case "vertex": {
      env.CLAUDE_CODE_USE_VERTEX = "1";
      if (cfg.gcpProject) {
        env.GOOGLE_CLOUD_PROJECT = cfg.gcpProject;
      }
      // GCP creds via Application Default Credentials. Same reasoning as
      // bedrock — no forceLoginMethod.
      return { env };
    }

    default: {
      // Exhaustiveness guard — if a new `Provider` variant is added without
      // updating this switch, TS will complain here.
      const _never: never = cfg.provider;
      void _never;
      throw new Error(
        `resolveAuthOptions: unknown provider '${String(cfg.provider)}'`,
      );
    }
  }
}
