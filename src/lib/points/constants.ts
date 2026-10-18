/**
 * Shared constants for CCA points entry.
 *
 * MUST MATCH THE SANDBOX. DEFAULT_RANGE and TOLERANCE are the same numbers as
 * `meanSdDefault` in rh-points-sandbox/src/engine/defaults.ts and
 * `RANGE_TOLERANCE` there; the score limits and EXPORT_FORMAT_VERSION are the
 * same as BASE_POINTS_MIN/MAX and LEADER_FORMAT_VERSION. The sandbox re-checks
 * every file it imports, so a drift here shows up as import errors there — but
 * change both together.
 *
 * Nothing in this folder carries points to the server. These are pure helpers
 * used in the browser (entry, live meter, export).
 */

/** Allowed base points for one member: whole numbers from 0 to 20. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 20;

export type Range = {
  meanMin: number;
  meanMax: number;
  sdMin: number;
  sdMax: number;
};

/** Built-in default allowed ranges (the sandbox's placeholder `meanSdDefault`). */
export const DEFAULT_RANGE: Readonly<Range> = {
  meanMin: 10,
  meanMax: 14,
  sdMin: 2,
  sdMax: 5,
};

/** Inclusive tolerance for range comparisons, so 14.0000000001 still passes. */
export const TOLERANCE = 1e-9;

/**
 * The leader-export format this app writes (its `formatVersion` column).
 * Version 2 adds the `ihg` column; the sandbox reads 1 and 2.
 */
export const EXPORT_FORMAT_VERSION = 2;

/** The flat-points and settings exports stay at version 1, which the sandbox reads for them. */
export const FLAT_FORMAT_VERSION = 1;
export const SETTINGS_FORMAT_VERSION = 1;

/** The JCRC bundle's own version, stamped on every row. Never reuse EXPORT_FORMAT_VERSION. */
export const BUNDLE_FORMAT_VERSION = 1;

/**
 * A CCA's points type, set by JCRC on /admin/points. The bundle carries these
 * strings verbatim.
 * MUST MATCH rh-points-sandbox src/import/parseCommon.ts CCA_TYPES.
 */
export const CCA_TYPES = ["1x", "0.5x"] as const;
export type CcaType = (typeof CCA_TYPES)[number];
export const isCcaType = (v: unknown): v is CcaType =>
  typeof v === "string" && (CCA_TYPES as readonly string[]).includes(v);

/**
 * A sport's result at the inter-hall games. The bundle carries these strings
 * verbatim.
 * MUST MATCH rh-points-sandbox src/import/parseCommon.ts IHG_PLACEMENTS.
 */
export const IHG_RESULTS = ["1st", "2nd", "3rd", "3rd4th_no_match"] as const;
export type IhgResult = (typeof IHG_RESULTS)[number];
export const isIhgResult = (v: unknown): v is IhgResult =>
  typeof v === "string" && (IHG_RESULTS as readonly string[]).includes(v);

/**
 * JCRC's IHG config for one CCA, as getEntryContext returns it. `null` as a
 * whole means the CCA is not a sport.
 */
export type IhgContext = { result: IhgResult | null; cap: number | null };

/** The most members a head may tick for a sport's IHG points. */
export const IHG_CAP_MIN = 1;
export const IHG_CAP_MAX = 99;
export const isValidIhgCap = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isInteger(v) &&
  v >= IHG_CAP_MIN &&
  v <= IHG_CAP_MAX;

/**
 * The CCA category that counts as a sport when JCRC has not ticked or unticked
 * "Sport" for that CCA. Temporary: a later portfolio refactor will replace this.
 * Use `effectiveIsSport` (ccaPointsConfig service); nothing else decides who is
 * a sport. The sandbox reads the bundle's `sport` flag and never this string.
 */
export const SPORTS_CATEGORY = "Sports Activities";
export const isSportsCategory = (category: string | null): boolean =>
  category !== null && category.trim() === SPORTS_CATEGORY;

/** What JCRC may configure: [min, max] for the mean and for the SD. */
export const MEAN_LIMITS = [0, 20] as const;
export const SD_LIMITS = [0, 10] as const;
