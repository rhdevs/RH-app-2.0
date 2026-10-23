import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The remediation script's pure rules, imported without running the script.
const lib = pathToFileURL(
  join(process.cwd(), "scripts", "remediation", "lib", "lateOpen.mjs"),
).href;
const { validateLateOpenYear, allowanceExpiry, formatSingaporeTime } =
  (await import(/* @vite-ignore */ lib)) as {
    validateLateOpenYear: (
      arg: unknown,
      now: Date,
    ) => { ok: true; academicYear: string } | { ok: false; reason: string };
    allowanceExpiry: (now: Date) => Date;
    formatSingaporeTime: (d: Date) => string;
  };

const SEP_2028 = new Date("2028-09-10T04:00:00Z"); // current: AY2028/29

describe("allow-late-open year validation", () => {
  it("accepts a past year from AY2026/27 on and names it as the app does", () => {
    expect(validateLateOpenYear("2026-27", SEP_2028)).toEqual({
      ok: true,
      academicYear: "AY2026/27",
    });
    expect(validateLateOpenYear("2027-28", SEP_2028)).toEqual({
      ok: true,
      academicYear: "AY2027/28",
    });
  });

  it("refuses malformed years", () => {
    for (const bad of [
      undefined,
      "",
      "2026",
      "2026/27",
      "AY2026/27",
      "2026-2027",
      "2026-28",
      "26-27",
      " 2026-27",
    ]) {
      expect(validateLateOpenYear(bad, SEP_2028).ok).toBe(false);
    }
  });

  it("refuses a year before AY2026/27", () => {
    const r = validateLateOpenYear("2025-26", SEP_2028);
    expect(r.ok).toBe(false);
  });

  it("refuses the current year and future years", () => {
    expect(validateLateOpenYear("2028-29", SEP_2028).ok).toBe(false);
    expect(validateLateOpenYear("2029-30", SEP_2028).ok).toBe(false);
  });

  it("reads the current year in Singapore time (1 August, 00:00 there)", () => {
    // 31 Jul 2027 23:59 SGT is still AY2026/27 -> AY2026/27 is current.
    expect(
      validateLateOpenYear("2026-27", new Date("2027-07-31T15:59:59Z")).ok,
    ).toBe(false);
    // One second later it is 1 August in Singapore: AY2026/27 is past.
    expect(
      validateLateOpenYear("2026-27", new Date("2027-07-31T16:00:00Z")).ok,
    ).toBe(true);
  });

  it("lasts 7 days and prints Singapore time", () => {
    const until = allowanceExpiry(new Date("2028-09-10T04:00:00Z"));
    expect(until.toISOString()).toBe("2028-09-17T04:00:00.000Z");
    expect(formatSingaporeTime(until)).toBe(
      "17 Sept 2028, 12:00 Singapore time",
    );
  });
});
