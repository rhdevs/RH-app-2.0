import { describe, expect, it } from "vitest";
import { downloadByBanner } from "../pageState";

const base = { academicYear: "AY2026/27", downloadBy: "2027-12-31" };

describe("the download-by banner", () => {
  it("asks residents to download before the date, in the required words", () => {
    expect(downloadByBanner({ ...base, todaySg: "2027-05-10" })).toBe(
      "Download your AY2026/27 transcript before 31 Dec 2027.",
    );
  });

  it("is still shown on the day itself, in Singapore", () => {
    expect(downloadByBanner({ ...base, todaySg: "2027-12-31" })).toBe(
      "Download your AY2026/27 transcript before 31 Dec 2027.",
    );
  });

  it("goes away the day after", () => {
    expect(downloadByBanner({ ...base, todaySg: "2028-01-01" })).toBeNull();
  });

  it("is not shown when no date is set", () => {
    expect(
      downloadByBanner({ ...base, downloadBy: null, todaySg: "2027-05-10" }),
    ).toBeNull();
  });

  it("ignores a malformed date instead of showing nonsense", () => {
    expect(
      downloadByBanner({
        ...base,
        downloadBy: "2027-02-30",
        todaySg: "2027-01-01",
      }),
    ).toBeNull();
  });

  it("has no exclamation mark and never says 'successfully'", () => {
    const text = downloadByBanner({ ...base, todaySg: "2027-05-10" })!;
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/successfully/i);
  });
});
