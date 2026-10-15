import { describe, expect, it } from "vitest";

import {
  ONLY_UNLOCKED_RESIDENTS,
  correctionSummary,
  decideWrite,
  fieldChange,
  joinChanges,
  participantSummaries,
  residentStateOf,
  SUMMARY_MAX,
} from "../corrections";
import { editRefusal, type YearStatus } from "../lifecycle";

/** The decision, with the ordinary edit rule worked out the way the service does. */
const decide = (input: {
  status: YearStatus;
  role: "manager" | "head" | "stranger";
  affected: string[];
  unlocked?: string[];
}) =>
  decideWrite({
    ordinary: editRefusal({
      isManager: input.role === "manager",
      isHead: input.role === "head",
      status: input.status,
      freezeReason: null,
    }),
    isManager: input.role === "manager",
    status: input.status,
    affected: input.affected,
    unlocked: new Set(input.unlocked ?? []),
  });

describe("decideWrite: who may write, by year state, role and unlock", () => {
  it("lets the ordinary guard's yes through, and it is not a correction", () => {
    expect(
      decide({ status: "collecting", role: "manager", affected: ["A"] }),
    ).toEqual({ allow: true, correction: false });
    expect(
      decide({ status: "closed", role: "manager", affected: ["A"] }),
    ).toEqual({ allow: true, correction: false });
    expect(
      decide({ status: "collecting", role: "head", affected: ["A"] }),
    ).toEqual({ allow: true, correction: false });
  });

  it("passes a manager in a published year only when every affected resident is unlocked", () => {
    expect(
      decide({
        status: "published",
        role: "manager",
        affected: ["A", "B"],
        unlocked: ["A", "B", "C"],
      }),
    ).toEqual({ allow: true, correction: true });
    expect(
      decide({
        status: "published",
        role: "manager",
        affected: ["A"],
        unlocked: ["A"],
      }),
    ).toEqual({ allow: true, correction: true });
  });

  it("refuses the WHOLE write when one affected resident is still locked", () => {
    expect(
      decide({
        status: "published",
        role: "manager",
        affected: ["A", "B"],
        unlocked: ["A"],
      }),
    ).toEqual({ allow: false, refusal: ONLY_UNLOCKED_RESIDENTS });
    expect(
      decide({ status: "published", role: "manager", affected: ["A"] }),
    ).toEqual({ allow: false, refusal: ONLY_UNLOCKED_RESIDENTS });
  });

  it("never gives a head, or a stranger, correction powers, even with unlocks", () => {
    for (const role of ["head", "stranger"] as const) {
      expect(
        decide({
          status: "published",
          role,
          affected: ["A"],
          unlocked: ["A"],
        }),
      ).toEqual({ allow: false, refusal: "PERIOD_PUBLISHED" });
    }
  });

  it("keeps the ordinary refusal when the write names no resident", () => {
    expect(
      decide({ status: "published", role: "manager", affected: [] }),
    ).toEqual({ allow: false, refusal: "PERIOD_PUBLISHED" });
  });

  it("ignores repeated names when counting who is affected", () => {
    expect(
      decide({
        status: "published",
        role: "manager",
        affected: ["A", "A"],
        unlocked: ["A"],
      }),
    ).toEqual({ allow: true, correction: true });
  });

  it("an unlock does not widen what a head or manager may do outside a published year", () => {
    expect(
      decide({
        status: "closed",
        role: "head",
        affected: ["A"],
        unlocked: ["A"],
      }),
    ).toEqual({ allow: false, refusal: "YEAR_CLOSED" });
    expect(
      decide({
        status: "collecting",
        role: "stranger",
        affected: ["A"],
        unlocked: ["A"],
      }),
    ).toEqual({ allow: false, refusal: "NOT_A_HEAD_OF_THIS_CCA" });
  });

  it("covers every status, role and unlock combination consistently", () => {
    const statuses: YearStatus[] = ["collecting", "closed", "published"];
    const roles = ["manager", "head", "stranger"] as const;
    for (const status of statuses) {
      for (const role of roles) {
        for (const unlocked of [[], ["A"]]) {
          const d = decide({ status, role, affected: ["A"], unlocked });
          const correction =
            status === "published" && role === "manager" && unlocked.length > 0;
          if (d.allow)
            expect(d.correction, `${status}/${role}`).toBe(correction);
          else expect(correction, `${status}/${role}`).toBe(false);
        }
      }
    }
  });
});

describe("what a resident's year looks like", () => {
  it("names the state from the year status", () => {
    expect(residentStateOf("collecting")).toBe("collecting");
    expect(residentStateOf("closed")).toBe("draft");
    expect(residentStateOf("published")).toBe("published");
  });
});

describe("event summary wording", () => {
  it("writes a short line", () => {
    expect(
      correctionSummary(
        "Roster",
        "Soccer (MALE)",
        joinChanges([fieldChange("role", "Captain")]),
      ),
    ).toBe("Roster: Soccer (MALE) role set to Captain");
  });

  it("says cleared for a blank value and joins several changes", () => {
    expect(fieldChange("role", null)).toBe("role cleared");
    expect(fieldChange("role", "")).toBe("role cleared");
    expect(
      joinChanges([fieldChange("role", "Head"), "contribution cleared"]),
    ).toBe("role set to Head, contribution cleared");
    expect(joinChanges([])).toBe("saved");
  });

  it("collapses whitespace and cuts a long line", () => {
    expect(correctionSummary("A", "B   C", "d\n e")).toBe("A: B C d e");
    const long = correctionSummary("Roster", "x".repeat(400), "saved");
    expect(long.length).toBe(SUMMARY_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("gives one line per resident a participant change touches", () => {
    const lines = participantSummaries("Activities", "Open House", {
      add: [
        { userID: "A", role: "Emcee" },
        { userID: "B", role: "" },
      ],
      restore: [{ userID: "C" }],
      update: [{ userID: "D" }],
      remove: [{ userID: "E" }],
    });
    expect(lines).toEqual([
      { userID: "A", summary: "Activities: Open House added as Emcee" },
      { userID: "B", summary: "Activities: Open House added" },
      {
        userID: "C",
        summary: "Activities: Open House participation restored",
      },
      {
        userID: "D",
        summary: "Activities: Open House role or description changed",
      },
      {
        userID: "E",
        summary: "Activities: Open House participation removed",
      },
    ]);
  });
});
