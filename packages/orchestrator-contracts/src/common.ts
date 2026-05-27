import { z } from "zod";

/**
 * Two enums, intentionally NOT the same. They model two different concepts:
 *
 *  - `PlatformId` — the logical user-facing platform name. Used in
 *    design-pipeline artifacts (`docs/analysis/{platform}/screens.json`,
 *    `docs/mockups/style-K/{platform}/...`, `docs/screens/{platform}/...`,
 *    `SelectedStyle.appsCovered`). Values: `webapp | mobile | admin`.
 *
 *  - `Target` — the build-pipeline app directory name. Used in
 *    `architecture.yaml.apps.*`, build-output schemas, and `apps/{target}/`
 *    directories. Values: `web | mobile | admin | api`.
 *
 * The one-letter slip between `webapp` (platform) and `web` (target / dir)
 * is deliberate — design-time we care about what the user sees, build-time
 * we care about the Next.js app directory name. Consumers of both should
 * treat them as parallel but distinct enums. A helper `platformIdToTarget()`
 * maps one to the other when wiring (e.g., when builders read the signoff
 * manifest and find screens at `docs/screens/webapp/*`, they emit JSX into
 * `apps/web/src/app/...`).
 */
export const Target = z.enum(["admin", "web", "mobile", "api"]);
export type Target = z.infer<typeof Target>;

export const PlatformId = z.enum(["webapp", "mobile", "admin"]);
export type PlatformId = z.infer<typeof PlatformId>;

/** Map a design-time platform name to its build-time target directory. */
export const platformIdToTarget = (p: PlatformId): Exclude<Target, "api"> =>
  p === "webapp" ? "web" : p;

export const ScreenId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export type ScreenId = z.infer<typeof ScreenId>;

export const AssetRef = z.object({
  path: z.string(),
  kind: z.enum([
    "logo",
    "icon",
    "font",
    "image",
    "wireframe",
    "brand-guide",
    "color",
    "illustration",
  ]),
  provenance: z.enum([
    "user",
    "researched",
    "generated",
    "hybrid",
    "stock",
    "vector",
  ]),
});
export type AssetRef = z.infer<typeof AssetRef>;

export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256>;

/** Design dials — 1–10 integer range per spec */
export const Dials = z.object({
  design_variance: z.number().int().min(1).max(10),
  motion_intensity: z.number().int().min(1).max(10),
  visual_density: z.number().int().min(1).max(10),
});
export type Dials = z.infer<typeof Dials>;

/** Feature flags recognized by the orchestrator + 041 */
export const FeatureFlag = z.enum(["nanobanana"]);
export type FeatureFlag = z.infer<typeof FeatureFlag>;

/** Semver string for the @repo/ui-kit version pin */
export const SemverString = z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
export type SemverString = z.infer<typeof SemverString>;
