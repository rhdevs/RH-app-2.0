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

/** The only leader-export format the sandbox reads (its `formatVersion` column). */
export const EXPORT_FORMAT_VERSION = 1;

/** What JCRC may configure: [min, max] for the mean and for the SD. */
export const MEAN_LIMITS = [0, 20] as const;
export const SD_LIMITS = [0, 10] as const;
