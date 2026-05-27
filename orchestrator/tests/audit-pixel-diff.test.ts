import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditAndClassifyPixels,
  classifyPixelDiff,
  diffScreenshots,
} from "../src/audit-pixel-diff.js";

/**
 * Tests for orchestrator/src/audit-pixel-diff.ts (feat-067 / feat-066 v2
 * Phase 2). Pure-function tests using small inline PNG fixtures generated
 * via `pngjs` PNG.sync.write. No Playwright dependency — the module under
 * test takes pre-captured PNG buffers, never spawns a browser.
 *
 * Implementation history: this was originally a .mjs script with
 * `createRequire("pngjs")` CJS interop, but co-running with the rest of
 * the orchestrator's vitest suite produced "Invalid or unexpected token"
 * SyntaxErrors (vite's module transformer choking on the createRequire
 * pattern). Moving the module under orchestrator/src/ + using vitest's
 * standard TS transformer sidesteps the issue entirely.
 */

// ─── PNG fixture builders ─────────────────────────────────────────────────

/**
 * Generate a solid-color PNG buffer.
 * @param width  pixels wide
 * @param height pixels tall
 * @param rgba   4-element array, 0-255 each
 */
function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

/**
 * Generate a PNG that's mostly `baseRgba` but with the first `diffPixelCount`
 * pixels set to `diffRgba`. Lets us calibrate exact diffRatio for tests.
 */
function pngWithDiff(
  width: number,
  height: number,
  baseRgba: [number, number, number, number],
  diffRgba: [number, number, number, number],
  diffPixelCount: number,
): Buffer {
  const png = new PNG({ width, height });
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const idx = i << 2;
    const c = i < diffPixelCount ? diffRgba : baseRgba;
    png.data[idx] = c[0];
    png.data[idx + 1] = c[1];
    png.data[idx + 2] = c[2];
    png.data[idx + 3] = c[3];
  }
  return PNG.sync.write(png);
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

// ─── env-flag isolation ───────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    PIXEL_DIFF_THRESHOLD_MINOR: process.env.PIXEL_DIFF_THRESHOLD_MINOR,
    PIXEL_DIFF_THRESHOLD_SYSTEMIC: process.env.PIXEL_DIFF_THRESHOLD_SYSTEMIC,
    PIXELMATCH_THRESHOLD: process.env.PIXELMATCH_THRESHOLD,
  };
  delete process.env.PIXEL_DIFF_THRESHOLD_MINOR;
  delete process.env.PIXEL_DIFF_THRESHOLD_SYSTEMIC;
  delete process.env.PIXELMATCH_THRESHOLD;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── diffScreenshots ──────────────────────────────────────────────────────

describe("diffScreenshots", () => {
  it("returns 0 diffPixels for identical PNGs", async () => {
    const a = solidPng(10, 10, WHITE);
    const b = solidPng(10, 10, WHITE);
    const stats = diffScreenshots(a, b);
    expect(stats.diffPixels).toBe(0);
    expect(stats.diffRatio).toBe(0);
    expect(stats.totalPixels).toBe(100);
    expect(stats.error).toBeNull();
    expect(stats.diffPng).toBeInstanceOf(Buffer);
  });

  it("reports diffPixels + diffRatio for partial mismatch", async () => {
    const a = solidPng(10, 10, WHITE);
    // 25 pixels of 100 different → diffRatio 0.25
    const b = pngWithDiff(10, 10, WHITE, BLACK, 25);
    const stats = diffScreenshots(a, b);
    expect(stats.diffPixels).toBe(25);
    expect(stats.totalPixels).toBe(100);
    expect(stats.diffRatio).toBe(0.25);
    expect(stats.error).toBeNull();
  });

  it("returns error stats on dimensional mismatch (no throw)", async () => {
    const a = solidPng(10, 10, WHITE);
    const b = solidPng(20, 10, WHITE);
    const stats = diffScreenshots(a, b);
    expect(stats.error).toMatch(/dimensional-mismatch/);
    expect(stats.diffPng).toBeNull();
    // Don't blow up; just report unmeasurable.
    expect(stats.diffPixels).toBe(0);
  });

  it("returns error stats on malformed PNG input (no throw)", async () => {
    const ok = solidPng(10, 10, WHITE);
    const garbage = Buffer.from("not actually a png");
    const stats = diffScreenshots(garbage, ok);
    expect(stats.error).toMatch(/mockup PNG decode failed/);
    expect(stats.diffPng).toBeNull();
  });

  it("PIXELMATCH_THRESHOLD env override changes sensitivity", async () => {
    // Two PNGs that differ by a near-imperceptible amount: 1-unit alpha drift.
    // Default threshold 0.1 considers these matching; threshold 0.0 catches them.
    const png1 = solidPng(20, 20, [128, 128, 128, 255]);
    const png2 = solidPng(20, 20, [128, 128, 128, 254]);
    const lenient = diffScreenshots(png1, png2, { pixelmatchThreshold: 0.5 });
    expect(lenient.diffPixels).toBe(0);
    process.env.PIXELMATCH_THRESHOLD = "0.0";
    const strict = diffScreenshots(png1, png2);
    expect(strict.diffPixels).toBeGreaterThan(0);
  });
});

// ─── classifyPixelDiff ────────────────────────────────────────────────────

describe("classifyPixelDiff", () => {
  it("returns [] for identical PNGs (diffRatio=0)", async () => {
    const out = classifyPixelDiff("home", {
      diffPixels: 0,
      totalPixels: 100,
      diffRatio: 0,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toEqual([]);
  });

  it("returns [] for diffRatio below MINOR threshold (noise floor)", async () => {
    // diffRatio 0.01 < default MINOR 0.02
    const out = classifyPixelDiff("home", {
      diffPixels: 1,
      totalPixels: 100,
      diffRatio: 0.01,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toEqual([]);
  });

  it("emits pixel-minor-divergence for MINOR < diffRatio <= SYSTEMIC", async () => {
    // diffRatio 0.05 ∈ (0.02, 0.15]
    const out = classifyPixelDiff("home", {
      diffPixels: 5,
      totalPixels: 100,
      diffRatio: 0.05,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("pixel-minor-divergence");
    expect(out[0].severity).toBe("P1");
    expect(out[0].screen).toBe("home");
    // Stats embedded for diagnostic
    expect(out[0].detail.pixelStats.diffRatio).toBe(0.05);
  });

  it("emits pixel-systemic-divergence for diffRatio > SYSTEMIC", async () => {
    // diffRatio 0.40 > default SYSTEMIC 0.15
    const out = classifyPixelDiff("home", {
      diffPixels: 40,
      totalPixels: 100,
      diffRatio: 0.4,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("pixel-systemic-divergence");
    expect(out[0].severity).toBe("P0");
  });

  it("returns [] when stats carries an error (caller surfaces warning instead)", async () => {
    const out = classifyPixelDiff("home", {
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      width: 0,
      height: 0,
      diffPng: null,
      error: "dimensional-mismatch: 10x10 vs 20x10",
    });
    expect(out).toEqual([]);
  });

  it("PIXEL_DIFF_THRESHOLD_MINOR override raises the noise floor", async () => {
    process.env.PIXEL_DIFF_THRESHOLD_MINOR = "0.10";
    // diffRatio 0.05 was minor with default 0.02; now below custom 0.10
    const out = classifyPixelDiff("home", {
      diffPixels: 5,
      totalPixels: 100,
      diffRatio: 0.05,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toEqual([]);
  });

  it("PIXEL_DIFF_THRESHOLD_SYSTEMIC override changes the systemic cutover", async () => {
    process.env.PIXEL_DIFF_THRESHOLD_SYSTEMIC = "0.05";
    // diffRatio 0.10 was minor with default 0.15; now systemic with custom 0.05
    const out = classifyPixelDiff("home", {
      diffPixels: 10,
      totalPixels: 100,
      diffRatio: 0.1,
      width: 10,
      height: 10,
      diffPng: Buffer.from(""),
      error: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("pixel-systemic-divergence");
  });
});

// ─── auditAndClassifyPixels (convenience wrapper) ─────────────────────────

describe("auditAndClassifyPixels", () => {
  it("diffs + classifies in one call, returning stats + divergences", async () => {
    const a = solidPng(10, 10, WHITE);
    const b = pngWithDiff(10, 10, WHITE, BLACK, 40); // 40% diff → systemic
    const { stats, divergences } = auditAndClassifyPixels({
      screenId: "home",
      mockupPng: a,
      builtPng: b,
    });
    expect(stats.diffRatio).toBe(0.4);
    expect(stats.diffPng).toBeInstanceOf(Buffer);
    expect(divergences).toHaveLength(1);
    expect(divergences[0].pattern).toBe("pixel-systemic-divergence");
  });

  it("returns empty divergences on identical PNGs without throwing", async () => {
    const a = solidPng(10, 10, WHITE);
    const b = solidPng(10, 10, WHITE);
    const { stats, divergences } = auditAndClassifyPixels({
      screenId: "home",
      mockupPng: a,
      builtPng: b,
    });
    expect(stats.diffPixels).toBe(0);
    expect(divergences).toEqual([]);
  });
});
