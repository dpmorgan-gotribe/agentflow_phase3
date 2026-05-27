import {
  existsSync,
  readFileSync,
  readdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { GateResolution, GateType } from "@repo/orchestrator-contracts";

/**
 * Task-036 MVP: every gate is file-drop. HTTP server for gates 2 + 4 UI
 * (dial editor, signoff form) is deferred post-MVP. `baseUrl` stays `null`.
 *
 * File-drop paths per gate:
 *   1 requirements   → docs/gate-1-approved.txt
 *   2 mockups        → docs/selected-style.json (SelectedStyleSchema shape)
 *   3 design-system  → docs/gate-3-approved.txt
 *   4 signoff        → docs/signoff-*.json (picks newest)
 *   5 credentials    → docs/credentials-confirmed.txt
 *   6 pr-review      → docs/gate-6-approved-{featureId}.txt
 *
 * Directive grammar for text gates (1, 3, 5, 6):
 *   proceed | approved            — approved
 *   revise:<note> | rejected:<r>  — not approved, carry note
 *   abort                         — not approved
 *   defer:svcA,svcB               — credentials gate only; approved w/ payload
 */

export interface GateServerHandle {
  baseUrl: string | null;
  stop: () => Promise<void>;
  stageName: string;
}

export interface StartGateServerArgs {
  stageName: string;
  projectRoot: string;
  gateType?: GateType;
}

export async function startGateServer(
  args: StartGateServerArgs,
): Promise<GateServerHandle> {
  return {
    baseUrl: null,
    stageName: args.stageName,
    stop: async () => {
      // Watchers are per-waitForGateDecision call; nothing global to stop.
    },
  };
}

export interface WaitForGateDecisionArgs {
  gateType: GateType;
  projectRoot: string;
  stageName: string;
  /** Required for gate 6 (pr-review). */
  featureId?: string;
  /** fs.watch backstop poll interval (ms). Default 500. */
  pollIntervalMs?: number;
  /** Re-print "still waiting" cadence (ms). Default 60_000. Pass 0 to disable. */
  rePrintIntervalMs?: number;
  /** Cancel waiting. */
  abortSignal?: AbortSignal;
  /** Injectable logger for tests. */
  logger?: (msg: string) => void;
}

export async function waitForGateDecision(
  args: WaitForGateDecisionArgs,
): Promise<GateResolution> {
  const pollIntervalMs = args.pollIntervalMs ?? 500;
  const rePrintIntervalMs = args.rePrintIntervalMs ?? 60_000;
  const log =
    args.logger ??
    ((msg: string) => {
      // eslint-disable-next-line no-console
      console.log(msg);
    });

  const expectedPath = resolveGateFilePath(
    args.gateType,
    args.projectRoot,
    args.featureId,
  );
  log(instructionsFor(args.gateType, expectedPath, args.featureId));

  return new Promise<GateResolution>((resolve, reject) => {
    let watcher: FSWatcher | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let rePrintTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (rePrintTimer) clearInterval(rePrintTimer);
    };

    const check = () => {
      if (settled) return;
      let outcome: TryResolveResult;
      try {
        outcome = tryResolveGateFile(
          args.gateType,
          args.projectRoot,
          args.featureId,
        );
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (outcome === null) return;
      if (outcome.kind === "malformed") {
        log(
          `[gate-${args.gateType}] file found but directive malformed: ${outcome.reason}. ` +
            `Fix the file + re-save; watcher keeps running.`,
        );
        return;
      }
      cleanup();
      resolve(outcome.resolution);
    };

    // Watch the parent dir — fs.watch on a non-existent file throws on
    // some platforms, and the human hasn't written the file yet.
    const parent = dirname(expectedPath);
    if (existsSync(parent)) {
      try {
        watcher = watch(parent, { persistent: true }, () => {
          check();
        });
      } catch {
        // fs.watch unavailable on this platform — polling carries the load.
      }
    }

    pollTimer = setInterval(check, pollIntervalMs);
    if (rePrintIntervalMs > 0) {
      rePrintTimer = setInterval(() => {
        if (settled) return;
        log(
          `[gate-${args.gateType}] still waiting for ${basename(expectedPath)}`,
        );
      }, rePrintIntervalMs);
    }

    if (args.abortSignal) {
      if (args.abortSignal.aborted) {
        cleanup();
        reject(new Error("waitForGateDecision aborted"));
        return;
      }
      args.abortSignal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("waitForGateDecision aborted"));
      });
    }

    // File may already exist when we start (resumed run).
    check();
  });
}

// ─── pure helpers (exported for tests) ─────────────────────────────────

export function resolveGateFilePath(
  gateType: GateType,
  projectRoot: string,
  featureId?: string,
): string {
  const docs = join(projectRoot, "docs");
  switch (gateType) {
    case "requirements":
      return join(docs, "gate-1-approved.txt");
    case "mockups":
      return join(docs, "selected-style.json");
    case "design-system":
      return join(docs, "gate-3-approved.txt");
    case "signoff":
      return join(docs, "signoff-*.json");
    case "credentials":
      return join(docs, "credentials-confirmed.txt");
    case "pr-review":
      if (!featureId) {
        throw new Error(
          "pr-review gate requires featureId to compute the file-drop path",
        );
      }
      return join(docs, `gate-6-approved-${featureId}.txt`);
  }
}

type TryResolveResult =
  | { kind: "resolved"; resolution: GateResolution }
  | { kind: "malformed"; reason: string }
  | null;

export function tryResolveGateFile(
  gateType: GateType,
  projectRoot: string,
  featureId?: string,
): TryResolveResult {
  const docs = join(projectRoot, "docs");
  switch (gateType) {
    case "requirements":
      return readTextDirective(join(docs, "gate-1-approved.txt"));
    case "design-system":
      return readTextDirective(join(docs, "gate-3-approved.txt"));
    case "credentials":
      return readCredentialsDirective(join(docs, "credentials-confirmed.txt"));
    case "pr-review":
      if (!featureId) return { kind: "malformed", reason: "featureId missing" };
      return readPrReviewDirective(
        join(docs, `gate-6-approved-${featureId}.txt`),
      );
    case "mockups":
      return readSelectedStyle(join(docs, "selected-style.json"));
    case "signoff":
      return readSignoffFile(docs);
  }
}

function readTextDirective(path: string): TryResolveResult {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { kind: "malformed", reason: "empty file" };
  const { verb, note } = parseVerbNote(raw);
  switch (verb) {
    case "proceed":
    case "approved":
      return { kind: "resolved", resolution: buildResolution(true, note) };
    case "revise":
      return {
        kind: "resolved",
        resolution: buildResolution(false, note ?? "revise"),
      };
    case "rejected":
      return {
        kind: "resolved",
        resolution: buildResolution(false, note ?? "rejected"),
      };
    case "abort":
      return {
        kind: "resolved",
        resolution: buildResolution(false, note ?? "aborted"),
      };
    default:
      return {
        kind: "malformed",
        reason: `unknown directive '${verb}' — expected proceed|approved|revise:<s>|rejected:<r>|abort`,
      };
  }
}

function readCredentialsDirective(path: string): TryResolveResult {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { kind: "malformed", reason: "empty file" };
  const { verb, note } = parseVerbNote(raw);
  switch (verb) {
    case "proceed":
      return { kind: "resolved", resolution: { approved: true } };
    case "defer": {
      const services = (note ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        kind: "resolved",
        resolution: {
          approved: true,
          note: `defer:${services.join(",")}`,
          payload: { deferred: services },
        },
      };
    }
    case "abort":
      return {
        kind: "resolved",
        resolution: { approved: false, note: "aborted" },
      };
    default:
      return {
        kind: "malformed",
        reason: `unknown credentials directive '${verb}' — expected proceed|defer:a,b|abort`,
      };
  }
}

function readPrReviewDirective(path: string): TryResolveResult {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { kind: "malformed", reason: "empty file" };
  const { verb, note } = parseVerbNote(raw);
  switch (verb) {
    case "approved":
    case "proceed":
      return { kind: "resolved", resolution: buildResolution(true, note) };
    case "rejected":
      return {
        kind: "resolved",
        resolution: buildResolution(
          false,
          note ?? "rejected (no reason given)",
        ),
      };
    default:
      return {
        kind: "malformed",
        reason: `unknown gate-6 directive '${verb}' — expected approved|rejected:<reason>`,
      };
  }
}

function readSelectedStyle(path: string): TryResolveResult {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "malformed",
      reason: `selected-style.json parse error: ${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "malformed",
      reason: "selected-style.json is not an object",
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.styleId !== "string" || obj.styleId.length === 0) {
    return {
      kind: "malformed",
      reason: "selected-style.json missing styleId",
    };
  }
  return {
    kind: "resolved",
    resolution: { approved: true, payload: obj },
  };
}

function readSignoffFile(docs: string): TryResolveResult {
  if (!existsSync(docs)) return null;
  let entries: string[];
  try {
    entries = readdirSync(docs);
  } catch {
    return null;
  }
  const hits = entries.filter(
    (e) => e.startsWith("signoff-") && e.endsWith(".json"),
  );
  if (hits.length === 0) return null;
  hits.sort();
  const latest = hits[hits.length - 1]!;
  const fullPath = join(docs, latest);
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "malformed",
      reason: `${latest} parse error: ${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", reason: `${latest} is not an object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.approved !== "boolean") {
    return {
      kind: "malformed",
      reason: `${latest} missing 'approved' boolean`,
    };
  }
  const resolution: GateResolution = {
    approved: obj.approved,
    payload: obj,
  };
  if (typeof obj.note === "string") resolution.note = obj.note;
  return { kind: "resolved", resolution };
}

function parseVerbNote(raw: string): { verb: string; note?: string } {
  const idx = raw.indexOf(":");
  if (idx === -1) return { verb: raw.toLowerCase() };
  const verb = raw.slice(0, idx).toLowerCase();
  const note = raw.slice(idx + 1).trim();
  return note.length > 0 ? { verb, note } : { verb };
}

function buildResolution(approved: boolean, note?: string): GateResolution {
  const out: GateResolution = { approved };
  if (note) out.note = note;
  return out;
}

function instructionsFor(
  gateType: GateType,
  path: string,
  featureId?: string,
): string {
  const rel = basename(path);
  switch (gateType) {
    case "requirements":
      return (
        `Gate 1 (requirements) open.\n` +
        `  Review docs/requirements.md + docs/brief-summary.json.\n` +
        `  Write docs/${rel} with one of:\n` +
        `    proceed              — advance to /mockups\n` +
        `    revise:<section>     — retry /analyze with feedback\n` +
        `    abort                — stop the pipeline`
      );
    case "mockups":
      return (
        `Gate 2 (mockups) open.\n` +
        `  Review docs/mockups/index.html + pick a style.\n` +
        `  Run \`/pick-style --styleId=<id>\` OR drop docs/${rel}\n` +
        `  (SelectedStyleSchema shape). HTTP dial-editor UI is deferred.`
      );
    case "design-system":
      return (
        `Gate 3 (design-system) open.\n` +
        `  Review docs/design-system-preview.html + @repo/ui-kit.\n` +
        `  Write docs/${rel} with one of:\n` +
        `    proceed | revise:<note> | abort`
      );
    case "signoff":
      return (
        `Gate 4 (signoff) open.\n` +
        `  Review screens + flows. Drop docs/signoff-<timestamp>.json with\n` +
        `    { "approved": true|false, "note"?: string, ... }\n` +
        `  per the Signoff schema. HTTP signoff-form UI is deferred.`
      );
    case "credentials":
      return (
        `Gate 5 (credentials) open.\n` +
        `  Review docs/credentials-checklist.md; fill in .env per architecture.yaml.\n` +
        `  Write docs/${rel} with one of:\n` +
        `    proceed              — all required services ready\n` +
        `    defer:svcA,svcB      — skip listed services + continue with warnings\n` +
        `    abort                — stop pipeline (state is resumable)`
      );
    case "pr-review":
      return (
        `Gate 6 (pr-review) open for ${featureId ?? "UNKNOWN"}.\n` +
        `  Reviewer approved this feature. Before merge to main:\n` +
        `    - Inspect the PR (if git-agent created one) or the branch\n` +
        `    - Write docs/${rel} with one of:\n` +
        `        approved               — git-agent merges to main\n` +
        `        rejected:<reason>      — branch stays; manual intervention`
      );
  }
}
