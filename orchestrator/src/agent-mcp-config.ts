// investigate-019 M-F (per-agent MCP scoping) — read each agent's
// frontmatter `mcp_servers` field + filter the factory's .mcp.json
// to that subset before passing it to the SDK as `Options.mcpServers`.
//
// Why: pre-M-F every Mode B dispatch spawned every server in
// `<factoryRoot>/.mcp.json` (currently just Playwright, but the
// architecture lets architecture.yaml.tooling.mcp_servers add more).
// Most Mode B agents (web-frontend-builder, backend-builder,
// reviewer, security, ...) never invoke playwright tools — they
// just paid the 60-300s npx cold-start tax per dispatch.
//
// With M-F:
//   - agent's `mcp_servers` frontmatter explicitly declares which
//     servers the agent needs (empty list = none)
//   - orchestrator passes `mcpServers: <filtered map>` to the SDK
//     so only declared servers spawn for that dispatch
//   - frontmatter absent → preserve back-compat (don't pass the
//     option; SDK does its normal discovery)
//
// Cross-references:
//   - plans/active/investigate-019-sdk-keepalive-stalls-during-parallel-dispatch.md §H6 + Mitigation M-F
//   - .claude/agents/git-agent.md — first agent shipped with `mcp_servers: []`
//   - .claude/agents/ui-designer.md — design-stage agent with multi-server list
//   - .mcp.json — factory's source-of-truth MCP server registry

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/** Frontmatter parse result. `null` = field absent (preserve back-compat). */
export type AgentMcpServersField = string[] | null;

/**
 * Parse `mcp_servers` frontmatter from `<factoryRoot>/.claude/agents/<agent>.md`.
 *
 * Returns:
 *   - `string[]` (possibly empty) when the field is present
 *   - `null` when the field is absent (caller should preserve back-compat)
 *
 * Tolerates:
 *   - missing agent file (returns `null`)
 *   - malformed frontmatter (returns `null`; logs a one-line warning)
 *   - non-array value (returns `null`; coercion to array would be ambiguous)
 *   - comments interleaved in the YAML block
 */
export function loadAgentMcpServers(
  factoryRoot: string,
  agentName: string,
): AgentMcpServersField {
  const agentPath = join(factoryRoot, ".claude", "agents", `${agentName}.md`);
  if (!existsSync(agentPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(agentPath, "utf8");
  } catch {
    return null;
  }

  // Frontmatter is the YAML block between the FIRST `---` and the SECOND `---`.
  // We split on lines so a `---` that appears inside markdown body doesn't
  // accidentally close the block.
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const frontmatterText = lines.slice(1, endIdx).join("\n");
  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatterText);
  } catch (err) {
    // Several factory agents (project-manager, skills-agent) have
    // descriptions with embedded colons that don't parse as strict YAML.
    // That's been silently tolerated upstream and our contract is "return
    // null when we can't determine → caller preserves back-compat". Only
    // surface a warning when the agent is actually trying to declare
    // `mcp_servers:` (genuine misconfiguration, not pre-existing noise).
    if (/^\s*mcp_servers\s*:/m.test(frontmatterText)) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-mcp-config] frontmatter YAML parse failed for ${agentName} (declared mcp_servers): ${msg}`,
      );
    }
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!("mcp_servers" in obj)) return null;
  const value = obj.mcp_servers;
  if (!Array.isArray(value)) return null;

  const result: string[] = [];
  for (const v of value) {
    if (typeof v === "string") result.push(v);
  }
  return result;
}

/** Shape of `<factoryRoot>/.mcp.json` as the SDK consumes it. */
type McpJsonShape = {
  mcpServers?: Record<string, unknown>;
};

/**
 * Read the factory's `.mcp.json` and return the `mcpServers` map verbatim.
 * Returns `{}` if the file is absent or malformed (the SDK's own discovery
 * would also have returned no servers in that case).
 */
export function loadFactoryMcpJson(
  factoryRoot: string,
): Record<string, unknown> {
  const mcpPath = join(factoryRoot, ".mcp.json");
  if (!existsSync(mcpPath)) return {};
  try {
    const raw = readFileSync(mcpPath, "utf8");
    const parsed = JSON.parse(raw) as McpJsonShape;
    return parsed.mcpServers ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[agent-mcp-config] failed to read ${mcpPath}: ${msg}`);
    return {};
  }
}

/**
 * Compose `Options.mcpServers` for a given agent dispatch.
 *
 * Logic:
 *   1. Read agent's `mcp_servers` frontmatter.
 *   2. If absent → return `undefined` (caller preserves back-compat by
 *      omitting `mcpServers` from Options; SDK does normal discovery).
 *   3. If present + empty → return `{}` (explicit "no servers"; SDK
 *      should not spawn anything).
 *   4. If present + non-empty → look up each declared server in the
 *      factory's `.mcp.json` and emit a filtered subset map. Servers
 *      declared by the agent but NOT defined in `.mcp.json` are silently
 *      dropped (the agent will fail on first tool call instead of at
 *      spawn — same blast-radius as today, just routed through the SDK).
 *
 * Empirically: the Claude Agent SDK treats `mcpServers` as an OVERRIDE
 * of `.mcp.json` discovery (sdk.d.ts:1386). Setting it to `{}` therefore
 * suppresses Playwright cold-start for agents that don't need it.
 */
export function buildAgentMcpServersOption(
  factoryRoot: string,
  agentName: string,
): Record<string, unknown> | undefined {
  const declared = loadAgentMcpServers(factoryRoot, agentName);
  if (declared === null) return undefined;
  if (declared.length === 0) return {};

  const registry = loadFactoryMcpJson(factoryRoot);
  const filtered: Record<string, unknown> = {};
  for (const name of declared) {
    if (name in registry) {
      filtered[name] = registry[name];
    }
  }
  return filtered;
}
