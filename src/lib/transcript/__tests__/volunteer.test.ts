import { describe, expect, it } from "vitest";
import {
  FALLBACK_SESSION_HOURS,
  GRID_PAGE_SIZE,
  MAX_VOLUNTEER_ACTIVITIES,
  MAX_VOLUNTEER_PEOPLE,
  MAX_VOLUNTEER_SESSIONS,
  addDaysIso,
  ayDateRange,
  clampIntoAy,
  compareVolunteerActivities,
  creditedHours,
  formatVolunteerHours,
  grandTotal,
  isValidHours,
  nextSessionDefaults,
  personTotals,
  readKind,
  volunteerCountLine,
} from "../volunteer";

const AY = "AY2026/27";

describe("volunteer limits and hours", () => {
  it("keeps only far-away hidden count caps, and counts plainly", () => {
    expect(MAX_VOLUNTEER_ACTIVITIES).toBe(1000);
    expect(MAX_VOLUNTEER_SESSIONS).toBe(1000);
    expect(MAX_VOLUNTEER_PEOPLE).toBe(2000);
    expect(GRID_PAGE_SIZE).toBe(8);
    expect(volunteerCountLine(4)).toBe("4 volunteer activities");
    expect(volunteerCountLine(1)).toBe("1 volunteer activity");
    expect(volunteerCountLine(40)).not.toMatch(/ of /);
  });

  it("accepts quarter hours from 0.25 to 24 only", () => {
    for (const h of [0.25, 0.5, 1, 7.75, 24])
      expect(isValidHours(h)).toBe(true);
    for (const h of [0, 0.1, 0.3, 24.25, 25, -1, Number.NaN, Infinity]) {
      expect(isValidHours(h), String(h)).toBe(false);
    }
  });

  it("prints hours without trailing zeros", () => {
    expect(formatVolunteerHours(1.5)).toBe("1.5");
    expect(formatVolunteerHours(42)).toBe("42");
    expect(formatVolunteerHours(0.25)).toBe("0.25");
    expect(formatVolunteerHours(0.1 + 0.2)).toBe("0.3");
  });

  it("reads an unknown kind as regular", () => {
    expect(readKind("oneoff")).toBe("oneoff");
    expect(readKind("weekly")).toBe("regular");
    expect(readKind(null)).toBe("regular");
  });

  it("credits the override, else the session's hours", () => {
    expect(creditedHours(2, null)).toBe(2);
    expect(creditedHours(2, undefined)).toBe(2);
    expect(creditedHours(2, 0.5)).toBe(0.5);
  });

  it("lists regular activities first, then one-off ones, each by title", () => {
    const rows = [
      { kind: "oneoff", title: "A" },
      { kind: "regular", title: "Z" },
      { kind: "regular", title: "B" },
    ];
    expect([...rows].sort(compareVolunteerActivities)).toEqual([
      { kind: "regular", title: "B" },
      { kind: "regular", title: "Z" },
      { kind: "oneoff", title: "A" },
    ]);
  });
});

describe("personTotals", () => {
  const sessions = [
    { id: "s1", hours: 2 },
    { id: "s2", hours: 1.5 },
    { id: "s3", hours: 1 },
  ];

  it("adds the hours of every session a person is ticked in", () => {
    const totals = personTotals({
      sessions,
      people: ["a", "b"],
      attendance: [
        { sessionID: "s1", userID: "a" },
        { sessionID: "s2", userID: "a" },
        { sessionID: "s1", userID: "b" },
      ],
    });
    expect(totals.get("a")).toBe(3.5);
    expect(totals.get("b")).toBe(2);
  });

  it("uses an override instead of the session's hours", () => {
    const totals = personTotals({
      sessions,
      people: ["a"],
      attendance: [
        { sessionID: "s1", userID: "a", hoursOverride: 0.5 },
        { sessionID: "s2", userID: "a", hoursOverride: null },
      ],
    });
    expect(totals.get("a")).toBe(2);
  });

  it("gives someone with no ticks 0", () => {
    expect(
      personTotals({ sessions, people: ["a"], attendance: [] }).get("a"),
    ).toBe(0);
  });

  it("ignores ticks on a session that is not active (removed sessions do not count)", () => {
    const totals = personTotals({
      sessions: [{ id: "s1", hours: 2 }],
      people: ["a"],
      attendance: [
        { sessionID: "s1", userID: "a" },
        { sessionID: "removed", userID: "a" },
      ],
    });
    expect(totals.get("a")).toBe(2);
  });

  it("ignores ticks of someone who is not an active person", () => {
    const totals = personTotals({
      sessions,
      people: ["a"],
      attendance: [
        { sessionID: "s1", userID: "gone" },
        { sessionID: "s1", userID: "a" },
      ],
    });
    expect([...totals.keys()]).toEqual(["a"]);
    expect(totals.get("a")).toBe(2);
  });

  it("rounds away floating-point noise and adds up a grand total", () => {
    const totals = personTotals({
      sessions: [
        { id: "s1", hours: 0.1 },
        { id: "s2", hours: 0.2 },
      ],
      people: ["a", "b"],
      attendance: [
        { sessionID: "s1", userID: "a" },
        { sessionID: "s2", userID: "a" },
        { sessionID: "s2", userID: "b" },
      ],
    });
    expect(totals.get("a")).toBe(0.3);
    expect(grandTotal(totals)).toBe(0.5);
  });
});

describe("session defaults", () => {
  it("adds a week to the calendar date without any time zone", () => {
    expect(addDaysIso("2026-10-08", 7)).toBe("2026-10-15");
    expect(addDaysIso("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDaysIso("2027-02-25", 7)).toBe("2027-03-04");
  });

  it("knows the academic year's first and last day", () => {
    expect(ayDateRange(AY)).toEqual({
      first: "2026-08-01",
      last: "2027-07-31",
    });
    expect(ayDateRange("2026")).toBeNull();
  });

  it("pulls a date back into the year", () => {
    expect(clampIntoAy("2026-07-15", AY)).toBe("2026-08-01");
    expect(clampIntoAy("2027-08-20", AY)).toBe("2027-07-31");
    expect(clampIntoAy("2026-10-01", AY)).toBe("2026-10-01");
  });

  it("starts the first session today with the default hours", () => {
    expect(
      nextSessionDefaults({
        sessions: [],
        defaultHours: 1.5,
        today: "2026-10-16",
        academicYear: AY,
      }),
    ).toEqual({ date: "2026-10-16", hours: 1.5 });
  });

  it("falls back to one hour when the activity has no default", () => {
    expect(
      nextSessionDefaults({
        sessions: [],
        defaultHours: null,
        today: "2026-10-16",
        academicYear: AY,
      }).hours,
    ).toBe(FALLBACK_SESSION_HOURS);
  });

  it("clamps the first session into the year", () => {
    expect(
      nextSessionDefaults({
        sessions: [],
        defaultHours: 1,
        today: "2026-06-01",
        academicYear: AY,
      }).date,
    ).toBe("2026-08-01");
    expect(
      nextSessionDefaults({
        sessions: [],
        defaultHours: 1,
        today: "2027-09-01",
        academicYear: AY,
      }).date,
    ).toBe("2027-07-31");
  });

  it("puts the next session a week after the LATEST one, with its hours", () => {
    expect(
      nextSessionDefaults({
        sessions: [
          { date: "2026-10-15", hours: 2 },
          { date: "2026-10-08", hours: 1 },
          { date: "2026-10-22", hours: 2.5 },
        ],
        defaultHours: 1,
        today: "2026-11-30",
        academicYear: AY,
      }),
    ).toEqual({ date: "2026-10-29", hours: 2.5 });
  });

  it("stops at the end of the year", () => {
    expect(
      nextSessionDefaults({
        sessions: [{ date: "2027-07-28", hours: 1 }],
        defaultHours: 1,
        today: "2027-07-28",
        academicYear: AY,
      }).date,
    ).toBe("2027-07-31");
  });
});
