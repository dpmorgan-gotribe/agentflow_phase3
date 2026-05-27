/**
 * 5-tier retry counter table — refactor-004 spec.
 *
 * Each tier has an independent cap. A single feature could theoretically
 * consume attempts from multiple tiers (Layer 5 + visual + task + merge),
 * but exhausting one doesn't spend budget from another. Caps are:
 *
 *   layer5             — 3 per Mode A stage      (schema validation retries)
 *   visual-review      — 3 per screen            (gate-4 precursor retries)
 *   task-retry         — 3 per task              (Mode B per-task failures)
 *   merge-conflict     — 3 per feature's merge   (Mode B close-feature conflicts)
 *   kit-change-request — 2 per pipeline run      (design-system detour ceiling)
 *
 * Keys per tier:
 *   layer5             — stage name (e.g. "mockups")
 *   visual-review      — "{platform}/{screen}"     e.g. "webapp/dashboard"
 *   task-retry         — "{featureId}/{taskId}"    e.g. "feat-auth/backend-impl-login"
 *   merge-conflict     — featureId                 e.g. "feat-auth"
 *   kit-change-request — always "pipeline" (single global counter)
 */

export const RETRY_TIERS = [
  "layer5",
  "visual-review",
  "task-retry",
  "merge-conflict",
  "kit-change-request",
] as const;
export type RetryTier = (typeof RETRY_TIERS)[number];

export const RETRY_CAPS: Record<RetryTier, number> = {
  layer5: 3,
  "visual-review": 3,
  // bug-002 dropped this 3 → 1 for fast-fail debugging. bug-008 restores to 2
  // now that the orchestrator chain is robust through bugs 002-007. See the
  // matching note above TASK_RETRY_CAP in feature-graph.ts.
  "task-retry": 2,
  "merge-conflict": 3,
  "kit-change-request": 2,
};

export type RetryCountersSnapshot = Record<RetryTier, Record<string, number>>;

function emptySnapshot(): RetryCountersSnapshot {
  return {
    layer5: {},
    "visual-review": {},
    "task-retry": {},
    "merge-conflict": {},
    "kit-change-request": {},
  };
}

export class RetryCounters {
  private counters: RetryCountersSnapshot = emptySnapshot();

  /** Current attempt count for (tier, key). Returns 0 if never incremented. */
  get(tier: RetryTier, key: string): number {
    return this.counters[tier][key] ?? 0;
  }

  /** Increment the counter and return the new value. */
  increment(tier: RetryTier, key: string): number {
    const current = this.counters[tier][key] ?? 0;
    const next = current + 1;
    this.counters[tier][key] = next;
    return next;
  }

  /** True when the counter has reached (or exceeded) this tier's cap. */
  isExhausted(tier: RetryTier, key: string): boolean {
    return this.get(tier, key) >= RETRY_CAPS[tier];
  }

  /** Tier cap lookup. */
  getMax(tier: RetryTier): number {
    return RETRY_CAPS[tier];
  }

  /**
   * In-place restore from a snapshot. Overwrites all tier state.
   * Used by state-persistence.loadState() to rehydrate a pre-existing
   * instance so callers keep their reference.
   */
  restoreFromSnapshot(snapshot: RetryCountersSnapshot): void {
    this.counters = {
      layer5: { ...snapshot.layer5 },
      "visual-review": { ...snapshot["visual-review"] },
      "task-retry": { ...snapshot["task-retry"] },
      "merge-conflict": { ...snapshot["merge-conflict"] },
      "kit-change-request": { ...snapshot["kit-change-request"] },
    };
  }

  /** Clone-safe snapshot. Used by state-persistence. */
  toJSON(): RetryCountersSnapshot {
    return {
      layer5: { ...this.counters.layer5 },
      "visual-review": { ...this.counters["visual-review"] },
      "task-retry": { ...this.counters["task-retry"] },
      "merge-conflict": { ...this.counters["merge-conflict"] },
      "kit-change-request": { ...this.counters["kit-change-request"] },
    };
  }

  /**
   * Rehydrate from a serialized snapshot. Strict: unknown tiers or
   * non-integer values throw. Counter values may legitimately be above
   * their cap (state was saved after the increment that pushed the
   * counter past the line).
   */
  static fromJSON(raw: unknown): RetryCounters {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(
        `RetryCounters.fromJSON: expected object, got ${typeof raw}`,
      );
    }
    const snapshot = emptySnapshot();
    for (const tier of RETRY_TIERS) {
      const entries = (raw as Record<string, unknown>)[tier];
      if (entries === undefined) continue;
      if (typeof entries !== "object" || entries === null) {
        throw new TypeError(
          `RetryCounters.fromJSON: tier '${tier}' must be an object, got ${typeof entries}`,
        );
      }
      for (const [key, val] of Object.entries(
        entries as Record<string, unknown>,
      )) {
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
          throw new TypeError(
            `RetryCounters.fromJSON: tier '${tier}' key '${key}' must be a non-negative integer, got ${String(val)}`,
          );
        }
        snapshot[tier][key] = val;
      }
    }
    const rc = new RetryCounters();
    rc.counters = snapshot;
    return rc;
  }
}
