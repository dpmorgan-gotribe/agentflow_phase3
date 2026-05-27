import { z } from "zod";

/**
 * feat-030 — schemas for the `/quota-status` skill probe output.
 *
 * Mirrors the shape the Claude Agent SDK exposes via
 * `SDKRateLimitEvent.rate_limit_info` (sdk.d.ts:2923). Fields are
 * intentionally `.optional()` because the SDK omits some on
 * non-subscription providers (e.g. `anthropic-api-key` users get no
 * rate-limit metadata at all — `buckets: []`).
 *
 * Per investigate-010 §F1: the SDK exposes 8 fields on
 * SDKRateLimitInfo; this schema captures all of them so future
 * additions don't silently drop data.
 */

export const RateLimitBucketStatus = z.enum([
  "allowed",
  "allowed_warning",
  "rejected",
]);
export type RateLimitBucketStatus = z.infer<typeof RateLimitBucketStatus>;

/**
 * Hard-limit + overage rate-limit types as enumerated in
 * `SDKRateLimitInfo.rateLimitType` (sdk.d.ts:2926). The 4 hard-limit
 * variants block dispatches; `overage` is the per-token billing tier on
 * Claude Max subscriptions.
 */
export const RateLimitType = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
]);
export type RateLimitType = z.infer<typeof RateLimitType>;

export const QuotaBucket = z.object({
  rateLimitType: RateLimitType,
  status: RateLimitBucketStatus,
  /** 0..1 fraction of bucket consumed. */
  utilization: z.number().min(0).max(1).optional(),
  /** Epoch-seconds when the bucket resets. */
  resetsAt: z.number().int().positive().optional(),
  /** Last warning threshold crossed (e.g. 0.75, 0.9). */
  surpassedThreshold: z.number().min(0).max(1).optional(),
});
export type QuotaBucket = z.infer<typeof QuotaBucket>;

export const QuotaStatusReportSchema = z.object({
  version: z.literal("1.0"),
  /** ISO-8601 UTC timestamp when the probe ran. */
  probedAt: z.string(),
  /** Auth backend used for the probe (claude-max-subscription | anthropic-api-key | bedrock | vertex). */
  provider: z.string(),
  /** Model id used for the probe call. */
  model: z.string(),
  /** One entry per `rateLimitType` the SDK reported. */
  buckets: z.array(QuotaBucket),
  /** True if a request is currently being billed against the overage tier. */
  isUsingOverage: z.boolean().optional(),
  overageStatus: RateLimitBucketStatus.optional(),
  overageResetsAt: z.number().int().positive().optional(),
  /** When overage is unavailable, the SDK explains why here. */
  overageDisabledReason: z.string().optional(),
  /** True iff the probe call returned `result.subtype === "success"`. */
  probeSucceeded: z.boolean(),
  /** Surfaced when `probeSucceeded` is false (auth, network, rejection, …). */
  probeError: z.string().optional(),
});
export type QuotaStatusReport = z.infer<typeof QuotaStatusReportSchema>;

export const QuotaStatusReportJsonSchema = z.toJSONSchema(
  QuotaStatusReportSchema,
);
