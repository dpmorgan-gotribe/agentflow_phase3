import { z } from "zod";

/**
 * Auth provider abstraction for the orchestrator's SDK calls.
 *
 * Each value corresponds to a distinct Anthropic/cloud auth backend that the
 * Claude Agent SDK supports. The orchestrator's `resolveAuthOptions()` (in
 * orchestrator/src/auth-provider.ts) turns one of these values into the right
 * combination of `Options.forceLoginMethod` + env-var toggles at dispatch time.
 *
 * Order of enum values is load-bearing for TS exhaustiveness checks — do not
 * reorder without updating the switch in auth-provider.ts.
 *
 * See docs/agent-sdk-auth-providers.md for provider semantics + precedence
 * rules + troubleshooting.
 */
export const Provider = z.enum([
  /** Options.forceLoginMethod: "claudeai" — uses logged-in Claude Code session + Max/Pro quota. */
  "claude-max-subscription",
  /** Options.forceLoginMethod: "console" — bills per token via ANTHROPIC_API_KEY. */
  "anthropic-api",
  /** CLAUDE_CODE_USE_BEDROCK=1 — routes through AWS Bedrock (standard AWS creds chain). */
  "bedrock",
  /** CLAUDE_CODE_USE_VERTEX=1 — routes through Google Vertex AI (standard ADC chain). */
  "vertex",
]);
export type Provider = z.infer<typeof Provider>;

/**
 * Per-run auth config. `provider` picks the backend; the remaining fields
 * are provider-specific overrides, all optional.
 *
 * See docs/agent-sdk-auth-providers.md for provider semantics.
 */
export const ProviderConfigSchema = z.object({
  provider: Provider,
  /**
   * For `anthropic-api`: the env var name to read the key from. Default:
   * `ANTHROPIC_API_KEY`. Override if the factory runs in an env that already
   * uses ANTHROPIC_API_KEY for a different purpose.
   */
  apiKeyEnvVar: z.string().min(1).optional(),
  /**
   * For `bedrock`: AWS region override (bedrock uses AWS_REGION by default).
   */
  awsRegion: z.string().min(1).optional(),
  /**
   * For `vertex`: GCP project override (vertex uses GOOGLE_CLOUD_PROJECT by default).
   */
  gcpProject: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
