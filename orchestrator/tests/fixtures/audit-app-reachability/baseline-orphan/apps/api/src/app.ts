// Negative-case fixture: env.ts IS imported (validates the bug-048 fix
// preserves real reachability), orphan.ts is NOT (validates the analyzer
// still detects genuine orphans after both fixes).
import { buildAppConfig } from "./plugins/env.js";

export function startApp() {
  return buildAppConfig().port;
}
