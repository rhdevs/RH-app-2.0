/**
 * Pure rules for allow-late-open.mjs: which year may get a late-open allowance,
 * and how long it lasts. No database, no clock (every function takes `now`),
 * so a test can import this file without running the script.
 *
 * The allowance lets JCRC press Open transcripts ONCE for a past year they
 * forgot to open (the app refuses a past year with YEAR_ENDED otherwise). See
 * src/lib/transcript/lifecycle.ts openBlocker.
 */

/** Transcripts start at AY2026/27; there is no earlier year. */
export const FIRST_START_YEAR = 2026;

/** How long one allowance lasts. */
export const ALLOWANCE_DAYS = 7;
export const ALLOWANCE_MS = ALLOWANCE_DAYS * 24 * 60 * 60 * 1000;

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The start year of the academic year `now` falls in (1 Aug, Singapore). */
export function currentStartYear(now) {
  const sg = new Date(now.getTime() + SGT_OFFSET_MS);
  return sg.getUTCMonth() >= 7 ? sg.getUTCFullYear() : sg.getUTCFullYear() - 1;
}

/**
 * Check the command-line year ("2026-27", the form people type) and name it
 * the way the app does ("AY2026/27"). Returns { ok: true, academicYear } or
 * { ok: false, reason }. Refuses a malformed year, one before AY2026/27, the
 * current year and any future year: only a PAST year needs an allowance.
 */
export function validateLateOpenYear(arg, now) {
  const m = typeof arg === "string" ? /^(\d{4})-(\d{2})$/.exec(arg) : null;
  if (!m) {
    return {
      ok: false,
      reason: `"${String(arg ?? "")}" is not an academic year like 2026-27`,
    };
  }
  const startYear = Number(m[1]);
  if (Number(m[2]) !== (startYear + 1) % 100) {
    return {
      ok: false,
      reason: `"${arg}" is not a real academic year (the second part must be the next year, as in 2026-27)`,
    };
  }
  if (startYear < FIRST_START_YEAR) {
    return {
      ok: false,
      reason: `transcripts start at AY${FIRST_START_YEAR}/${String((FIRST_START_YEAR + 1) % 100).padStart(2, "0")}; ${arg} is earlier`,
    };
  }
  const current = currentStartYear(now);
  if (startYear === current) {
    return {
      ok: false,
      reason: `${arg} is the current year; JCRC can open it from the app without an allowance`,
    };
  }
  if (startYear > current) {
    return { ok: false, reason: `${arg} has not started yet` };
  }
  return {
    ok: true,
    academicYear: `AY${startYear}/${String(m[2])}`,
  };
}

/** When an allowance granted at `now` ends. */
export function allowanceExpiry(now) {
  return new Date(now.getTime() + ALLOWANCE_MS);
}

/** "27 Aug 2027, 14:05 Singapore time" for an instant. */
export function formatSingaporeTime(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} Singapore time`;
}
