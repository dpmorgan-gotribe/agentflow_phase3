import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentMcpServersOption,
  loadAgentMcpServers,
} from "../src/agent-mcp-config.js";

/**
 * Tests for `agent-mcp-config` — investigate-019 M-F (per-agent MCP scoping).
 * Builds a fake factory root in a tmp dir + asserts the resolver returns the
 * right shape for each per-agent configuration:
 *
 *   - frontmatter absent          → null / undefined  (back-compat)
 *   - mcp_servers: []             → []   / {}         (no MCP servers)
 *   - mcp_servers: [<known>]      → [..] / {<filtered>}  (subset of .mcp.json)
 *   - mcp_servers: [<unknown>]    → [..] / {}         (silently dropped)
 *   - YAML parse error            → null / undefined  (back-compat;
 *                                                       only warns when text
 *                                                       declares mcp_servers)
 */

let factoryRoot: string;

const FAKE_MCP_JSON = {
  mcpServers: {
    playwright: {
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.74"],
    },
    chromeDevtools: {
      command: "npx",
      args: ["-y", "@some/chrome-devtools-mcp@1.0.0"],
    },
  },
};

function writeAgent(name: string, frontmatter: string, body = "# Body") {
  const dir = join(factoryRoot, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatter}\n---\n\n${body}\n`;
  writeFileSync(join(dir, `${name}.md`), content, "utf8");
}

beforeEach(() => {
  factoryRoot = mkdtempSync(join(tmpdir(), "agent-mcp-config-test-"));
  mkdirSync(join(factoryRoot, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(factoryRoot, ".mcp.json"),
    JSON.stringify(FAKE_MCP_JSON, null, 2),
    "utf8",
  );
});

afterEach(() => {
  rmSync(factoryRoot, { recursive: true, force: true });
});

describe("loadAgentMcpServers", () => {
  it("returns null when the agent file is missing (back-compat preserved)", () => {
    expect(loadAgentMcpServers(factoryRoot, "ghost-agent")).toBeNull();
  });

  it("returns null when frontmatter omits mcp_servers (back-compat)", () => {
    writeAgent("plain", "name: plain\nmodel: inherit\ntools: Read");
    expect(loadAgentMcpServers(factoryRoot, "plain")).toBeNull();
  });

  it("returns [] when frontmatter declares mcp_servers: [] (one-line form)", () => {
    writeAgent(
      "no-mcp",
      "name: no-mcp\nmodel: inherit\ntools: Read\nmcp_servers: []",
    );
    expect(loadAgentMcpServers(factoryRoot, "no-mcp")).toEqual([]);
  });

  it("returns the declared list when frontmatter uses YAML list form", () => {
    writeAgent(
      "tester-like",
      [
        "name: tester-like",
        "model: inherit",
        "tools: Read, Write",
        "mcp_servers:",
        "  - playwright",
        "  - chromeDevtools",
      ].join("\n"),
    );
    expect(loadAgentMcpServers(factoryRoot, "tester-like")).toEqual([
      "playwright",
      "chromeDevtools",
    ]);
  });

  it("returns null when the file has no frontmatter delimiters", () => {
    const dir = join(factoryRoot, ".claude", "agents");
    writeFileSync(join(dir, "raw.md"), "# Body only\nNo frontmatter\n", "utf8");
    expect(loadAgentMcpServers(factoryRoot, "raw")).toBeNull();
  });

  it("returns null when frontmatter is malformed AND does NOT mention mcp_servers (silent)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // description with embedded colon = invalid YAML mapping (mirrors the
    // pre-existing project-manager / skills-agent agents).
    writeAgent(
      "broken-no-mcp",
      "name: broken-no-mcp\ndescription: Has colon: in description",
    );
    expect(loadAgentMcpServers(factoryRoot, "broken-no-mcp")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null AND warns when frontmatter is malformed but DOES try to declare mcp_servers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAgent(
      "broken-mcp",
      [
        "name: broken-mcp",
        "description: Has colon: in description",
        "mcp_servers:",
        "  - playwright",
      ].join("\n"),
    );
    expect(loadAgentMcpServers(factoryRoot, "broken-mcp")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0] ?? "").toMatch(
      /broken-mcp.*declared mcp_servers/,
    );
    warn.mockRestore();
  });

  it("returns null when mcp_servers is present but not an array", () => {
    writeAgent(
      "string-value",
      "name: string-value\nmodel: inherit\nmcp_servers: playwright",
    );
    expect(loadAgentMcpServers(factoryRoot, "string-value")).toBeNull();
  });

  it("filters non-string entries when mcp_servers contains mixed types", () => {
    writeAgent(
      "mixed",
      [
        "name: mixed",
        "model: inherit",
        "mcp_servers:",
        "  - playwright",
        "  - 42",
        "  - true",
      ].join("\n"),
    );
    expect(loadAgentMcpServers(factoryRoot, "mixed")).toEqual(["playwright"]);
  });
});

describe("buildAgentMcpServersOption", () => {
  it("returns undefined when the agent doesn't declare mcp_servers (Options field omitted)", () => {
    writeAgent("plain", "name: plain\nmodel: inherit");
    expect(buildAgentMcpServersOption(factoryRoot, "plain")).toBeUndefined();
  });

  it("returns {} when the agent declares mcp_servers: [] (no servers should spawn)", () => {
    writeAgent("no-mcp", "name: no-mcp\nmodel: inherit\nmcp_servers: []");
    expect(buildAgentMcpServersOption(factoryRoot, "no-mcp")).toEqual({});
  });

  it("returns the filtered subset when the agent declares known servers", () => {
    writeAgent(
      "needs-pw",
      [
        "name: needs-pw",
        "model: inherit",
        "mcp_servers:",
        "  - playwright",
      ].join("\n"),
    );
    expect(buildAgentMcpServersOption(factoryRoot, "needs-pw")).toEqual({
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.74"],
      },
    });
  });

  it("silently drops servers declared by the agent but missing from .mcp.json", () => {
    writeAgent(
      "phantom",
      [
        "name: phantom",
        "model: inherit",
        "mcp_servers:",
        "  - playwright",
        "  - icons8", // not in .mcp.json — will be dropped
        "  - made-up",
      ].join("\n"),
    );
    expect(buildAgentMcpServersOption(factoryRoot, "phantom")).toEqual({
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.74"],
      },
    });
  });

  it("returns {} when factory .mcp.json is missing AND agent declares servers", () => {
    rmSync(join(factoryRoot, ".mcp.json"));
    writeAgent(
      "needs-pw",
      [
        "name: needs-pw",
        "model: inherit",
        "mcp_servers:",
        "  - playwright",
      ].join("\n"),
    );
    expect(buildAgentMcpServersOption(factoryRoot, "needs-pw")).toEqual({});
  });
});
