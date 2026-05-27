#!/usr/bin/env node
/**
 * /quota-status probe — calls the Claude Agent SDK with a 1-token prompt
 * to collect SDKRateLimitEvent.rate_limit_info from the live response
 * stream. Closes the visibility gap in investigate-010 §F1: the SDK
 * exposes 8 fields per SDKRateLimitInfo; the orchestrator was reading 2.
 *
 * USAGE:
 *   probe-quota                              # plain-text Haiku probe
 *   probe-quota -- --json                    # structured QuotaStatusReport
 *   probe-quota -- --verbose                 # adds raw event dump
 *   probe-quota -- --model claude-sonnet-4-6 # probe a specific model class
 *   probe-quota -- --all                     # probe Haiku, Sonnet, Opus
 *
 * MODEL CLASS NOTE:
 *   The SDK only emits `rate_limit_event` for buckets the probed model
 *   exercises. Haiku call → reports five_hour aggregate; Sonnet call →
 *   reports five_hour AND seven_day_sonnet; Opus call → reports five_hour
 *   AND seven_day_opus. To see Sonnet/Opus pressure, probe those classes
 *   explicitly (`--model` or `--all`). Each probe burns ~$0.0001-$0.005
 *   against the bucket it measures.
 *
 * EXIT CODES:
 *   0 = all probes succeeded
 *   2 = at least one probe rejected (rate-limit hit, auth failed, …)
 *   3 = unrecoverable script error (SDK import / setup)
 *
 * AUTH:
 *   Auto-detects via the SDK. Set ANTHROPIC_API_KEY to force
 *   anthropic-api-key provider. Otherwise falls back to claude-max-
 *   subscription (the user's logged-in Claude Code CLI session).
 *
 * COST PER PROBE:
 *   Haiku  ~$0.0001
 *   Sonnet ~$0.003
 *   Opus   ~$0.015
 *   --all  ~$0.018 cumulative
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_MODEL = "claude-haiku-4-5";
const ALL_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"];

function parseArgs(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes("--json");
  const verbose = args.includes("--verbose");
  const allMode = args.includes("--all");
  const modelIdx = args.indexOf("--model");
  const explicitModel = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  if (allMode && explicitModel) {
    console.error("--all and --model are mutually exclusive");
    process.exit(3);
  }
  return { jsonMode, verbose, allMode, explicitModel };
}

async function probeOne(model, verbose) {
  const buckets = new Map();
  let isUsingOverage = false;
  let overageStatus;
  let overageResetsAt;
  let overageDisabledReason;
  let probeSucceeded = false;
  let probeError;
  const rawEvents = [];
  const probedAt = new Date().toISOString();

  try {
    const q = query({
      prompt: "OK",
      options: {
        model,
        allowedTools: [],
        maxTurns: 1,
        systemPrompt: "Reply with the single word OK and stop.",
      },
    });

    for await (const msg of q) {
      if (verbose) rawEvents.push(msg);
      if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
        const info = msg.rate_limit_info;
        if (info.rateLimitType) {
          buckets.set(info.rateLimitType, {
            rateLimitType: info.rateLimitType,
            status: info.status,
            ...(info.utilization !== undefined
              ? { utilization: info.utilization }
              : {}),
            ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
            ...(info.surpassedThreshold !== undefined
              ? { surpassedThreshold: info.surpassedThreshold }
              : {}),
          });
        }
        if (info.isUsingOverage !== undefined) {
          isUsingOverage = info.isUsingOverage;
        }
        if (info.overageStatus) overageStatus = info.overageStatus;
        if (info.overageResetsAt) overageResetsAt = info.overageResetsAt;
        if (info.overageDisabledReason) {
          overageDisabledReason = info.overageDisabledReason;
        }
      }
      if (msg.type === "result") {
        probeSucceeded = msg.subtype === "success";
        if (msg.subtype !== "success") {
          const errs =
            Array.isArray(msg.errors) && msg.errors.length
              ? msg.errors.join("; ")
              : `subtype=${msg.subtype}`;
          probeError = errs;
        }
        break;
      }
    }
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  return {
    version: "1.0",
    probedAt,
    provider: process.env.ANTHROPIC_API_KEY
      ? "anthropic-api-key"
      : "claude-max-subscription",
    model,
    buckets: Array.from(buckets.values()),
    isUsingOverage,
    ...(overageStatus ? { overageStatus } : {}),
    ...(overageResetsAt ? { overageResetsAt } : {}),
    ...(overageDisabledReason ? { overageDisabledReason } : {}),
    probeSucceeded,
    ...(probeError ? { probeError } : {}),
    ...(verbose ? { rawEvents } : {}),
  };
}

const fmtPct = (frac) =>
  frac === undefined
    ? "  ?%"
    : `${Math.round(frac * 100)
        .toString()
        .padStart(3, " ")}%`;

const fmtReset = (epoch) => {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const hoursFromNow = (d.getTime() - Date.now()) / 3_600_000;
  if (hoursFromNow > 0.1)
    return `${d.toISOString()} (~${hoursFromNow.toFixed(1)}h)`;
  if (hoursFromNow > 0)
    return `${d.toISOString()} (~${Math.round(hoursFromNow * 60)}m)`;
  return `${d.toISOString()} (passed)`;
};

const indicator = (status) => {
  if (status === "rejected") return "[REJECT]";
  if (status === "allowed_warning") return "[WARN]  ";
  return "[OK]    ";
};

function printReport(report, verbose) {
  console.log(`Provider: ${report.provider}`);
  console.log(`Model:    ${report.model}`);
  console.log(`Probed:   ${report.probedAt}`);
  console.log(
    `Probe:    ${report.probeSucceeded ? "succeeded" : "REJECTED"}${report.probeError ? ` (${report.probeError})` : ""}`,
  );
  console.log("");
  if (report.buckets.length === 0) {
    console.log(
      "(no rate-limit info returned — non-subscription provider, or call did not exercise rate-limit metering)",
    );
  } else {
    console.log("Buckets:");
    console.log(
      "  STATUS    TYPE                   USED  STATE             RESETS",
    );
    for (const b of report.buckets) {
      console.log(
        `  ${indicator(b.status)}  ${b.rateLimitType.padEnd(20)}  ${fmtPct(b.utilization)}  ${b.status.padEnd(16)}  ${fmtReset(b.resetsAt)}`,
      );
    }
  }
  if (report.isUsingOverage || report.overageStatus) {
    console.log("");
    console.log(
      `Overage:  status=${report.overageStatus ?? "?"}  using=${report.isUsingOverage}  resets=${fmtReset(report.overageResetsAt)}`,
    );
    if (report.overageDisabledReason) {
      console.log(`          disabled reason: ${report.overageDisabledReason}`);
    }
  }
  if (verbose && Array.isArray(report.rawEvents) && report.rawEvents.length) {
    console.log("");
    console.log("Raw event stream:");
    for (const evt of report.rawEvents) {
      console.log(`  ${JSON.stringify(evt)}`);
    }
  }
}

async function main() {
  const { jsonMode, verbose, allMode, explicitModel } = parseArgs(process.argv);
  const models = allMode ? ALL_MODELS : [explicitModel ?? DEFAULT_MODEL];

  const reports = [];
  for (const m of models) {
    // eslint-disable-next-line no-await-in-loop
    reports.push(await probeOne(m, verbose));
  }

  // Strip rawEvents from JSON output unless --verbose was set;
  // probeOne already conditioned on verbose, so this is a no-op here.

  if (jsonMode) {
    const payload = allMode ? reports : reports[0];
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (let i = 0; i < reports.length; i++) {
      if (i > 0) console.log("\n---\n");
      printReport(reports[i], verbose);
    }
  }

  const allSucceeded = reports.every((r) => r.probeSucceeded);
  process.exit(allSucceeded ? 0 : 2);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(3);
});
