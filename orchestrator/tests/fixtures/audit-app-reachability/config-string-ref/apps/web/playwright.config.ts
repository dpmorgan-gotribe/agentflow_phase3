// bug-049 fixture: config-string property reference.
// Pre-fix: IMPORT_RE only matched `import`/`export from`/dynamic-import shapes.
// The `globalSetup: "./playwright/global-setup.ts"` property string was invisible,
// so `global-setup.ts` was flagged orphan.
export default {
  globalSetup: "./playwright/global-setup.ts",
  testDir: "./e2e",
};
