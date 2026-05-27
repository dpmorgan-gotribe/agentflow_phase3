/**
 * Pixel-diff audit (feat-067 / feat-066 v2 Phase 2).
 *
 * Pure-function module that compares a mockup PNG against a built-page PNG
 * (both produced by Playwright's page.screenshot()), reports the diff
 * ratio + classifies into `pixel-minor-divergence` or `pixel-systemic-
 * divergence` ParityDivergence rows.
 *
 * No Playwright import here. The orchestrator wrapper (parity-verify.ts)
 * captures the PNG bytes; this module just diffs + classifies. That seam
 * keeps the module unit-testable with inline PNG fixtures and keeps the
 * chromium boot cost in one place.
 *
 * Bug classes emitted (both already in ParityPatternSchema per feat-070):
 *   - pixel-minor-divergence (diffRatio in (MINOR, SYSTEMIC]) → bug-fixer
 *   - pixel-systemic-divergence (diffRatio > SYSTEMIC) → systemic-fixer
 *
 * Threshold env overrides:
 *   - PIXEL_DIFF_THRESHOLD_MINOR=0.02 (2% — anti-aliasing + font hint noise floor)
 *   - PIXEL_DIFF_THRESHOLD_SYSTEMIC=0.15 (15% — entire-page-broken signal)
 *   - PIXELMATCH_THRESHOLD=0.1 (per-pixel match aggressiveness; 0-1 scale)
 */

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface DiffStats {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  width: number;
  height: number;
  /** PNG bytes for the overlay diff image (null on error). */
  diffPng: Buffer | null;
  /** Short reason when the diff couldn't run (e.g. dimensional mismatch). */
  error: string | null;
}

export interface PixelParityDivergence {
  screen: string;
  pattern: "pixel-minor-divergence" | "pixel-systemic-divergence";
  detail: {
    missing: string[];
    extra: string[];
    variantDrift: unknown[];
    styleDrift: unknown[];
    /** Free-form diagnostic — bug-author body renders this for humans + agents. */
    pixelStats: {
      diffPixels: number;
      totalPixels: number;
      diffRatio: number;
      width: number;
      height: number;
    };
  };
  severity: "P0" | "P1";
}

/**
 * Diff two PNG buffers and return stats + an overlay diff image.
 *
 * Both inputs must decode to the same dimensions. When they don't, we
 * return a stats object with `error: "dimensional-mismatch-…"` and a null
 * diffPng — the caller surfaces this as a warning rather than a bug.
 */
export function diffScreenshots(
  mockupPng: Buffer,
  builtPng: Buffer,
  opts: { pixelmatchThreshold?: number } = {},
): DiffStats {
  const pixelmatchThreshold =
    opts.pixelmatchThreshold ??
    Number.parseFloat(process.env.PIXELMATCH_THRESHOLD ?? "0.1");

  let mockupDecoded: PNG;
  let builtDecoded: PNG;
  try {
    mockupDecoded = PNG.sync.read(mockupPng);
  } catch (err) {
    return {
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      width: 0,
      height: 0,
      diffPng: null,
      error: `mockup PNG decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    builtDecoded = PNG.sync.read(builtPng);
  } catch (err) {
    return {
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      width: 0,
      height: 0,
      diffPng: null,
      error: `built PNG decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    mockupDecoded.width !== builtDecoded.width ||
    mockupDecoded.height !== builtDecoded.height
  ) {
    return {
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      width: mockupDecoded.width,
      height: mockupDecoded.height,
      diffPng: null,
      error:
        `dimensional-mismatch: mockup=${mockupDecoded.width}x${mockupDecoded.height} ` +
        `built=${builtDecoded.width}x${builtDecoded.height}`,
    };
  }

  const { width, height } = mockupDecoded;
  const totalPixels = width * height;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    mockupDecoded.data,
    builtDecoded.data,
    diff.data,
    width,
    height,
    { threshold: pixelmatchThreshold },
  );
  const diffPng = PNG.sync.write(diff);

  return {
    diffPixels,
    totalPixels,
    diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    width,
    height,
    diffPng,
    error: null,
  };
}

/**
 * Classify diff stats into 0 or 1 ParityDivergence rows. Threshold-based:
 *   - diffRatio ≤ MINOR_THRESHOLD             → no divergence (noise floor)
 *   - MINOR_THRESHOLD < diffRatio ≤ SYSTEMIC  → pixel-minor-divergence (P1)
 *   - diffRatio > SYSTEMIC_THRESHOLD          → pixel-systemic-divergence (P0)
 */
export function classifyPixelDiff(
  screenId: string,
  stats: DiffStats,
): PixelParityDivergence[] {
  if (stats.error) return []; // upstream couldn't measure — caller surfaces warning
  if (stats.totalPixels === 0) return [];

  const minorThreshold = Number.parseFloat(
    process.env.PIXEL_DIFF_THRESHOLD_MINOR ?? "0.02",
  );
  const systemicThreshold = Number.parseFloat(
    process.env.PIXEL_DIFF_THRESHOLD_SYSTEMIC ?? "0.15",
  );

  if (stats.diffRatio <= minorThreshold) return [];

  const pattern: PixelParityDivergence["pattern"] =
    stats.diffRatio > systemicThreshold
      ? "pixel-systemic-divergence"
      : "pixel-minor-divergence";
  const severity: PixelParityDivergence["severity"] =
    pattern === "pixel-systemic-divergence" ? "P0" : "P1";

  return [
    {
      screen: screenId,
      pattern,
      detail: {
        missing: [],
        extra: [],
        variantDrift: [],
        styleDrift: [],
        pixelStats: {
          diffPixels: stats.diffPixels,
          totalPixels: stats.totalPixels,
          diffRatio: stats.diffRatio,
          width: stats.width,
          height: stats.height,
        },
      },
      severity,
    },
  ];
}

/**
 * Convenience: diff + classify in one call. Mirrors `auditAndClassify`
 * in scripts/audit-computed-styles.mjs so the parity-verify integration
 * site can call both audits symmetrically.
 */
export function auditAndClassifyPixels(args: {
  screenId: string;
  mockupPng: Buffer;
  builtPng: Buffer;
  opts?: { pixelmatchThreshold?: number };
}): { stats: DiffStats; divergences: PixelParityDivergence[] } {
  const stats = diffScreenshots(args.mockupPng, args.builtPng, args.opts);
  const divergences = classifyPixelDiff(args.screenId, stats);
  return { stats, divergences };
}
