import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveGateFilePath,
  startGateServer,
  tryResolveGateFile,
  waitForGateDecision,
} from "../src/gate-server-lifecycle.js";

let projectRoot: string;
let docsDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "gate-server-"));
  docsDir = join(projectRoot, "docs");
  mkdirSync(docsDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("startGateServer (MVP file-drop)", () => {
  it("returns a handle with null baseUrl (HTTP UI deferred)", async () => {
    const handle = await startGateServer({
      stageName: "analyze",
      projectRoot,
    });
    expect(handle.baseUrl).toBeNull();
    expect(handle.stageName).toBe("analyze");
    await handle.stop();
  });

  it("stop() is idempotent", async () => {
    const handle = await startGateServer({
      stageName: "mockups",
      projectRoot,
    });
    await handle.stop();
    await handle.stop(); // second call must not throw
  });
});

describe("resolveGateFilePath", () => {
  it("resolves each gate to the expected file-drop path", () => {
    expect(resolveGateFilePath("requirements", projectRoot)).toBe(
      join(docsDir, "gate-1-approved.txt"),
    );
    expect(resolveGateFilePath("mockups", projectRoot)).toBe(
      join(docsDir, "selected-style.json"),
    );
    expect(resolveGateFilePath("design-system", projectRoot)).toBe(
      join(docsDir, "gate-3-approved.txt"),
    );
    expect(resolveGateFilePath("credentials", projectRoot)).toBe(
      join(docsDir, "credentials-confirmed.txt"),
    );
    expect(resolveGateFilePath("pr-review", projectRoot, "feat-auth-001")).toBe(
      join(docsDir, "gate-6-approved-feat-auth-001.txt"),
    );
  });

  it("pr-review without featureId throws", () => {
    expect(() => resolveGateFilePath("pr-review", projectRoot)).toThrow(
      /featureId/,
    );
  });
});

describe("tryResolveGateFile — text directive gates", () => {
  it("returns null when file does not exist", () => {
    expect(tryResolveGateFile("requirements", projectRoot)).toBeNull();
    expect(tryResolveGateFile("design-system", projectRoot)).toBeNull();
  });

  it("parses 'proceed' → approved=true", () => {
    writeFileSync(join(docsDir, "gate-1-approved.txt"), "proceed\n");
    const out = tryResolveGateFile("requirements", projectRoot);
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(true);
    }
  });

  it("parses 'approved' as alias of proceed", () => {
    writeFileSync(join(docsDir, "gate-3-approved.txt"), "approved");
    const out = tryResolveGateFile("design-system", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") expect(out.resolution.approved).toBe(true);
  });

  it("parses 'revise:<note>' → approved=false + note carried", () => {
    writeFileSync(
      join(docsDir, "gate-1-approved.txt"),
      "revise:§7 stack needs Stripe detail",
    );
    const out = tryResolveGateFile("requirements", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(false);
      expect(out.resolution.note).toContain("Stripe");
    }
  });

  it("parses 'rejected:<reason>' → approved=false + reason carried", () => {
    writeFileSync(
      join(docsDir, "gate-3-approved.txt"),
      "rejected:accent too muted",
    );
    const out = tryResolveGateFile("design-system", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(false);
      expect(out.resolution.note).toContain("accent");
    }
  });

  it("parses 'abort' → approved=false", () => {
    writeFileSync(join(docsDir, "gate-1-approved.txt"), "abort");
    const out = tryResolveGateFile("requirements", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") expect(out.resolution.approved).toBe(false);
  });

  it("malformed directive → kind=malformed (watcher keeps waiting)", () => {
    writeFileSync(join(docsDir, "gate-1-approved.txt"), "yes please");
    const out = tryResolveGateFile("requirements", projectRoot);
    expect(out?.kind).toBe("malformed");
  });

  it("empty file → malformed", () => {
    writeFileSync(join(docsDir, "gate-1-approved.txt"), "");
    const out = tryResolveGateFile("requirements", projectRoot);
    expect(out?.kind).toBe("malformed");
  });
});

describe("tryResolveGateFile — credentials gate (5)", () => {
  const path = () => join(docsDir, "credentials-confirmed.txt");

  it("parses 'proceed' → approved=true", () => {
    writeFileSync(path(), "proceed");
    const out = tryResolveGateFile("credentials", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") expect(out.resolution.approved).toBe(true);
  });

  it("parses 'defer:sendgrid,twilio' → approved=true + payload", () => {
    writeFileSync(path(), "defer:sendgrid,twilio");
    const out = tryResolveGateFile("credentials", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(true);
      expect(out.resolution.payload).toEqual({
        deferred: ["sendgrid", "twilio"],
      });
      expect(out.resolution.note).toContain("defer:sendgrid,twilio");
    }
  });

  it("parses 'abort' → approved=false", () => {
    writeFileSync(path(), "abort");
    const out = tryResolveGateFile("credentials", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") expect(out.resolution.approved).toBe(false);
  });

  it("rejects 'revise:X' — not part of gate-5 grammar", () => {
    writeFileSync(path(), "revise:add missing .env.SES_KEY");
    const out = tryResolveGateFile("credentials", projectRoot);
    expect(out?.kind).toBe("malformed");
  });
});

describe("tryResolveGateFile — pr-review gate (6)", () => {
  const path = (id: string) => join(docsDir, `gate-6-approved-${id}.txt`);

  it("parses 'approved' → approved=true", () => {
    writeFileSync(path("feat-auth"), "approved\n");
    const out = tryResolveGateFile("pr-review", projectRoot, "feat-auth");
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") expect(out.resolution.approved).toBe(true);
  });

  it("parses 'rejected:<reason>' → approved=false + reason carried", () => {
    writeFileSync(path("feat-auth"), "rejected:missing CSRF on login POST");
    const out = tryResolveGateFile("pr-review", projectRoot, "feat-auth");
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(false);
      expect(out.resolution.note).toContain("CSRF");
    }
  });

  it("featureId-scoped paths don't collide across features", () => {
    writeFileSync(path("feat-auth"), "approved");
    writeFileSync(path("feat-billing"), "rejected:WIP");
    const a = tryResolveGateFile("pr-review", projectRoot, "feat-auth");
    const b = tryResolveGateFile("pr-review", projectRoot, "feat-billing");
    if (a?.kind === "resolved") expect(a.resolution.approved).toBe(true);
    if (b?.kind === "resolved") expect(b.resolution.approved).toBe(false);
  });
});

describe("tryResolveGateFile — mockups gate (2) via selected-style.json", () => {
  it("valid SelectedStyle JSON → approved=true + payload", () => {
    writeFileSync(
      join(docsDir, "selected-style.json"),
      JSON.stringify({
        styleId: "style-0",
        styleName: "Eco-Charcoal",
        dials: { design_variance: 2, motion_intensity: 3, visual_density: 5 },
      }),
    );
    const out = tryResolveGateFile("mockups", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(true);
      expect((out.resolution.payload as { styleId: string }).styleId).toBe(
        "style-0",
      );
    }
  });

  it("missing styleId → malformed", () => {
    writeFileSync(
      join(docsDir, "selected-style.json"),
      JSON.stringify({ styleName: "no id here" }),
    );
    const out = tryResolveGateFile("mockups", projectRoot);
    expect(out?.kind).toBe("malformed");
  });

  it("invalid JSON → malformed", () => {
    writeFileSync(join(docsDir, "selected-style.json"), "not json {");
    const out = tryResolveGateFile("mockups", projectRoot);
    expect(out?.kind).toBe("malformed");
  });
});

describe("tryResolveGateFile — signoff gate (4) via signoff-*.json", () => {
  it("picks newest signoff-*.json + reads approved flag", () => {
    writeFileSync(
      join(docsDir, "signoff-2026-04-20.json"),
      JSON.stringify({ approved: false, note: "first pass" }),
    );
    writeFileSync(
      join(docsDir, "signoff-2026-04-22.json"),
      JSON.stringify({ approved: true, note: "ship it" }),
    );
    const out = tryResolveGateFile("signoff", projectRoot);
    expect(out?.kind).toBe("resolved");
    if (out?.kind === "resolved") {
      expect(out.resolution.approved).toBe(true);
      expect(out.resolution.note).toBe("ship it");
    }
  });

  it("no signoff file → null", () => {
    const out = tryResolveGateFile("signoff", projectRoot);
    expect(out).toBeNull();
  });
});

describe("waitForGateDecision — live watcher", () => {
  it("resolves when file appears", async () => {
    const path = join(docsDir, "gate-1-approved.txt");
    const logs: string[] = [];
    const pending = waitForGateDecision({
      gateType: "requirements",
      projectRoot,
      stageName: "analyze",
      pollIntervalMs: 50,
      rePrintIntervalMs: 0,
      logger: (m) => logs.push(m),
    });
    // Write after a tick so the watcher is installed first
    setTimeout(() => writeFileSync(path, "proceed"), 80);
    const resolution = await pending;
    expect(resolution.approved).toBe(true);
    expect(logs[0]).toContain("Gate 1");
  });

  it("ignores malformed write, resolves on subsequent valid write", async () => {
    const path = join(docsDir, "gate-1-approved.txt");
    const logs: string[] = [];
    const pending = waitForGateDecision({
      gateType: "requirements",
      projectRoot,
      stageName: "analyze",
      pollIntervalMs: 50,
      rePrintIntervalMs: 0,
      logger: (m) => logs.push(m),
    });
    setTimeout(() => writeFileSync(path, "maybe"), 80);
    setTimeout(() => writeFileSync(path, "proceed"), 250);
    const resolution = await pending;
    expect(resolution.approved).toBe(true);
    expect(
      logs.some((l) => l.includes("malformed") && l.includes("maybe")),
    ).toBe(true);
  });

  it("resolves immediately if file already present (resumed run)", async () => {
    writeFileSync(join(docsDir, "credentials-confirmed.txt"), "proceed");
    const resolution = await waitForGateDecision({
      gateType: "credentials",
      projectRoot,
      stageName: "architect",
      pollIntervalMs: 50,
      rePrintIntervalMs: 0,
      logger: () => {},
    });
    expect(resolution.approved).toBe(true);
  });

  it("abort signal cancels wait (no handle leak)", async () => {
    const ac = new AbortController();
    const pending = waitForGateDecision({
      gateType: "requirements",
      projectRoot,
      stageName: "analyze",
      pollIntervalMs: 50,
      rePrintIntervalMs: 0,
      logger: () => {},
      abortSignal: ac.signal,
    });
    setTimeout(() => ac.abort(), 80);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("gate 6 file-drop: watches featureId-scoped path", async () => {
    const pending = waitForGateDecision({
      gateType: "pr-review",
      projectRoot,
      stageName: "pr-review",
      featureId: "feat-auth",
      pollIntervalMs: 50,
      rePrintIntervalMs: 0,
      logger: () => {},
    });
    setTimeout(
      () =>
        writeFileSync(
          join(docsDir, "gate-6-approved-feat-auth.txt"),
          "rejected:needs more eyes",
        ),
      80,
    );
    const resolution = await pending;
    expect(resolution.approved).toBe(false);
    expect(resolution.note).toContain("more eyes");
  });
});
