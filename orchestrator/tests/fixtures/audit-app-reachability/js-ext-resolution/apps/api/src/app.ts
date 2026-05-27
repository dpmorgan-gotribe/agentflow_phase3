// bug-048 fixture: TS-as-ESM `.js` import suffix.
// Pre-fix: analyzer's resolveCandidate() couldn't resolve "./plugins/env.js"
// back to the source `env.ts`, so `env.ts` was flagged orphan.
import { buildAppConfig } from "./plugins/env.js";

export function startApp() {
  const cfg = buildAppConfig();
  return cfg.port;
}
