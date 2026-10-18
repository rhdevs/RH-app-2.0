import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "~/lib/points/constants";
import type { PointsEntry } from "~/lib/points/entries";
import {
  checkAfterOpenChange,
  downloadVerdict,
  type ExportCheck,
} from "../_components/exportDecision";

const entry = (n: number, basePoints: number): PointsEntry => ({
  rowKey: `u:${n}`,
  matric: `A99${String(n).padStart(5, "0")}Z`,
  name: `Test Member ${n}`,
  resolved: true,
  basePoints,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg: false,
});

// Mean 13, SD 3.42: inside the default range.
const entries = [8, 10, 12, 14, 16, 18].map((s, i) => entry(i + 1, s));
const open = { entryOpen: true, range: DEFAULT_RANGE, ihg: null };
const DONE: ExportCheck = { status: "done" };

describe("checkAfterOpenChange", () => {
  it("resets a finished check to checking when the dialog closes, so a reopen never starts as done", () => {
    expect(checkAfterOpenChange(DONE, false)).toEqual({ status: "checking" });
    expect(checkAfterOpenChange({ status: "failed" }, false)).toEqual({
      status: "checking",
    });
  });

  it("restarts at checking when the dialog opens", () => {
    expect(checkAfterOpenChange(DONE, true)).toEqual({ status: "checking" });
  });
});

describe("downloadVerdict", () => {
  it("allows a download once the check is done and the live context passes", () => {
    expect(downloadVerdict(DONE, entries, open)).toEqual({ allowed: true });
  });

  it("refuses while the check is still running or failed", () => {
    expect(
      downloadVerdict({ status: "checking" }, entries, open),
    ).toMatchObject({ allowed: false, reason: "checking" });
    expect(downloadVerdict({ status: "failed" }, entries, open)).toMatchObject({
      allowed: false,
      reason: "failed",
    });
  });

  it("refuses when the context closes entry after the check finished", () => {
    const verdict = downloadVerdict(DONE, entries, {
      entryOpen: false,
      range: DEFAULT_RANGE,
      ihg: null,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed || verdict.reason !== "blocked")
      throw new Error("expected a blocked verdict");
    expect(verdict.blockers.map((b) => b.code)).toEqual(["NOT_OPEN"]);
  });

  it("refuses when the range changes after the check and the scores no longer pass", () => {
    const verdict = downloadVerdict(DONE, entries, {
      entryOpen: true,
      range: { ...DEFAULT_RANGE, meanMin: 14, meanMax: 15 },
      ihg: null,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: "blocked" });
  });

  it("a cap lowered between opening and downloading blocks the download", () => {
    const ticked = entries.map((e, i) => ({ ...e, ihg: i < 5 }));
    const atOpen = { entryOpen: true, range: DEFAULT_RANGE };
    expect(
      downloadVerdict(DONE, ticked, {
        ...atOpen,
        ihg: { result: "1st", cap: 5 },
      }),
    ).toEqual({ allowed: true });
    const verdict = downloadVerdict(DONE, ticked, {
      ...atOpen,
      ihg: { result: "1st", cap: 3 },
    });
    if (verdict.allowed || verdict.reason !== "blocked")
      throw new Error("expected a blocked verdict");
    expect(verdict.blockers.map((b) => b.code)).toEqual(["IHG_OVER_CAP"]);
  });
});
