import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // feat-038 Phase 5 — exclude fixture spec files from vitest discovery.
    // tests/fixtures/synthesize-flow-e2e/**/*.spec.ts are Playwright specs
    // (the synthesizer's emitted output + committed expected/ snapshots),
    // NOT vitest test files. Without this exclude, vitest picks them up
    // and tries to execute them in the Node test runner where the
    // @playwright/test imports fail.
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/fixtures/**"],
  },
});
