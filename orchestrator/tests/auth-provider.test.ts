import type { ProviderConfig } from "@repo/orchestrator-contracts";
import { describe, expect, it } from "vitest";
import { resolveAuthOptions } from "../src/auth-provider.js";

/**
 * Tests for `resolveAuthOptions` — the pure resolver that turns a
 * `ProviderConfig` into `{ forceLoginMethod, env }`. Every assertion here
 * operates on the returned object; nothing mutates `process.env` or the
 * input `baseEnv`.
 */

describe("resolveAuthOptions — claude-max-subscription", () => {
  it("sets forceLoginMethod: 'claudeai' and strips ANTHROPIC_API_KEY from env", () => {
    const cfg: ProviderConfig = { provider: "claude-max-subscription" };
    const baseEnv = {
      ANTHROPIC_API_KEY: "sk-ant-stale-value",
      OTHER_VAR: "keep-me",
    };
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.forceLoginMethod).toBe("claudeai");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.OTHER_VAR).toBe("keep-me");
  });

  it("does not mutate the caller's baseEnv object", () => {
    const cfg: ProviderConfig = { provider: "claude-max-subscription" };
    const baseEnv = { ANTHROPIC_API_KEY: "sk-ant-stale-value" };
    resolveAuthOptions(cfg, baseEnv);
    expect(baseEnv.ANTHROPIC_API_KEY).toBe("sk-ant-stale-value");
  });
});

describe("resolveAuthOptions — anthropic-api", () => {
  it("sets forceLoginMethod: 'console' when ANTHROPIC_API_KEY is present", () => {
    const cfg: ProviderConfig = { provider: "anthropic-api" };
    const baseEnv = { ANTHROPIC_API_KEY: "sk-ant-real-key" };
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.forceLoginMethod).toBe("console");
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-ant-real-key");
  });

  it("throws a helpful error when ANTHROPIC_API_KEY is unset", () => {
    const cfg: ProviderConfig = { provider: "anthropic-api" };
    const baseEnv: NodeJS.ProcessEnv = {};
    expect(() => resolveAuthOptions(cfg, baseEnv)).toThrow(
      /Provider 'anthropic-api' requires env var 'ANTHROPIC_API_KEY'/,
    );
    expect(() => resolveAuthOptions(cfg, baseEnv)).toThrow(/models\.yaml/);
  });

  it("copies a custom apiKeyEnvVar's value into ANTHROPIC_API_KEY", () => {
    const cfg: ProviderConfig = {
      provider: "anthropic-api",
      apiKeyEnvVar: "MY_CUSTOM_KEY",
    };
    const baseEnv = { MY_CUSTOM_KEY: "sk-ant-via-custom" };
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.forceLoginMethod).toBe("console");
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-ant-via-custom");
    expect(result.env.MY_CUSTOM_KEY).toBe("sk-ant-via-custom");
  });

  it("throws citing the custom var name when custom apiKeyEnvVar is unset", () => {
    const cfg: ProviderConfig = {
      provider: "anthropic-api",
      apiKeyEnvVar: "MY_CUSTOM_KEY",
    };
    const baseEnv: NodeJS.ProcessEnv = {};
    expect(() => resolveAuthOptions(cfg, baseEnv)).toThrow(
      /Provider 'anthropic-api' requires env var 'MY_CUSTOM_KEY'/,
    );
  });
});

describe("resolveAuthOptions — bedrock", () => {
  it("sets CLAUDE_CODE_USE_BEDROCK=1 and omits forceLoginMethod", () => {
    const cfg: ProviderConfig = { provider: "bedrock" };
    const baseEnv = { AWS_PROFILE: "factory" };
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(result.env.AWS_PROFILE).toBe("factory");
    expect(result.forceLoginMethod).toBeUndefined();
  });

  it("honors explicit awsRegion override", () => {
    const cfg: ProviderConfig = {
      provider: "bedrock",
      awsRegion: "eu-west-1",
    };
    const baseEnv: NodeJS.ProcessEnv = {};
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.env.AWS_REGION).toBe("eu-west-1");
    expect(result.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("leaves AWS_REGION unset when no override and no base env value", () => {
    const cfg: ProviderConfig = { provider: "bedrock" };
    const result = resolveAuthOptions(cfg, {});
    expect(result.env.AWS_REGION).toBeUndefined();
  });
});

describe("resolveAuthOptions — vertex", () => {
  it("sets CLAUDE_CODE_USE_VERTEX=1 and omits forceLoginMethod", () => {
    const cfg: ProviderConfig = { provider: "vertex" };
    const baseEnv = { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" };
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(result.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/adc.json");
    expect(result.forceLoginMethod).toBeUndefined();
  });

  it("honors explicit gcpProject override", () => {
    const cfg: ProviderConfig = {
      provider: "vertex",
      gcpProject: "my-project",
    };
    const baseEnv: NodeJS.ProcessEnv = {};
    const result = resolveAuthOptions(cfg, baseEnv);
    expect(result.env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
    expect(result.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
  });
});
