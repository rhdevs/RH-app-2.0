import { describe, expect, it } from "vitest";
import { isDateInAcademicYear } from "../academicYear";
import {
  awardCreateInput,
  idInput,
  jcrcSaveForInput,
  jcrcSaveMineInput,
  rosterUpsertInput,
  searchQueryInput,
  volunteerActivityCreateInput,
  volunteerActivityUpdateInput,
  volunteerAttendanceSaveInput,
  volunteerPeopleSetInput,
  volunteerSessionAddInput,
} from "../manageInput";
import { accessFor, type AccessFamily } from "../permissions";

const AY = "AY2026/27";

describe("text rules", () => {
  const base = { ccaID: 1, academicYear: AY, userID: "SEED-R12" };

  it("trims single-line text and enforces its bounds", () => {
    const ok = awardCreateInput.parse({
      academicYear: AY,
      userID: "SEED-R12",
      title: "  Service Excellence  ",
    });
    expect(ok.title).toBe("Service Excellence");

    expect(
      awardCreateInput.safeParse({
        academicYear: AY,
        userID: "x",
        title: "   ",
      }).success,
    ).toBe(false);
    expect(
      awardCreateInput.safeParse({
        academicYear: AY,
        userID: "x",
        title: "a".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      awardCreateInput.safeParse({
        academicYear: AY,
        userID: "x",
        title: "a".repeat(120),
      }).success,
    ).toBe(true);
  });

  it("bounds the award citation at 300 and treats blank as none", () => {
    const make = (citation: unknown) =>
      awardCreateInput.safeParse({
        academicYear: AY,
        userID: "x",
        title: "T",
        citation,
      });

    expect(make("c".repeat(301)).success).toBe(false);
    expect(make("c".repeat(300)).success).toBe(true);
    expect(make("   ")).toMatchObject({
      success: true,
      data: { citation: null },
    });
    expect(make(undefined)).toMatchObject({
      success: true,
      data: { citation: null },
    });
    expect(make(null)).toMatchObject({
      success: true,
      data: { citation: null },
    });
  });

  it.each([
    "a\u0000b",
    "a\u0007b",
    "tab\there",
    "line\nbreak",
    "\u007F",
    "x\u0085y",
  ])("rejects control characters in a single-line field: %j", (title) => {
    expect(
      awardCreateInput.safeParse({ academicYear: AY, userID: "x", title })
        .success,
    ).toBe(false);
  });

  it("allows newlines, but no other control characters, in multi-line fields", () => {
    const make = (testimonial: string) =>
      jcrcSaveMineInput.safeParse({
        academicYear: AY,
        portfolio: "Sports",
        position: "Secretary",
        description: "d",
        contributions: [],
        testimonial,
      });

    expect(make("first line\nsecond line").success).toBe(true);
    expect(make("windows\r\nline").success).toBe(true);
    expect(make("a\u0000b").success).toBe(false);
    expect(make("a\tb").success).toBe(false);
    expect(make("x".repeat(1501)).success).toBe(false);
    expect(make("x".repeat(1500)).success).toBe(true);
  });

  it("stores HTML as plain text, untouched", () => {
    const parsed = awardCreateInput.parse({
      academicYear: AY,
      userID: "x",
      title: '<b>Bold</b> & "quoted"',
    });

    expect(parsed.title).toBe('<b>Bold</b> & "quoted"');
  });

  it("enforces the JCRC field limits", () => {
    const make = (over: object) =>
      jcrcSaveForInput.safeParse({
        academicYear: AY,
        userID: "SEED-R02",
        portfolio: "Sports",
        position: "Secretary",
        description: "d",
        contributions: [{ activity: "one", role: "", description: "" }],
        testimonial: "t",
        ...over,
      });

    expect(make({}).success).toBe(true);
    expect(make({ portfolio: "p".repeat(81) }).success).toBe(false);
    expect(make({ position: "p".repeat(81) }).success).toBe(false);
    expect(make({ description: "d".repeat(801) }).success).toBe(false);
    const row = (over: object = {}) => ({
      activity: "Orientation",
      role: "Lead",
      description: "Ran the programme.",
      ...over,
    });
    expect(make({ contributions: Array(11).fill(row()) }).success).toBe(false);
    expect(make({ contributions: Array(10).fill(row()) }).success).toBe(true);
    // activity: required, 1 to 80
    expect(
      make({ contributions: [row({ activity: "a".repeat(81) })] }).success,
    ).toBe(false);
    expect(
      make({ contributions: [row({ activity: "a".repeat(80) })] }).success,
    ).toBe(true);
    expect(make({ contributions: [row({ activity: "   " })] }).success).toBe(
      false,
    );
    // role: optional, up to 60
    expect(
      make({ contributions: [row({ role: "r".repeat(61) })] }).success,
    ).toBe(false);
    expect(
      make({ contributions: [row({ role: "r".repeat(60) })] }).success,
    ).toBe(true);
    expect(make({ contributions: [row({ role: "" })] }).success).toBe(true);
    // description: optional, up to 300
    expect(
      make({ contributions: [row({ description: "d".repeat(301) })] }).success,
    ).toBe(false);
    expect(
      make({ contributions: [row({ description: "d".repeat(300) })] }).success,
    ).toBe(true);
    expect(make({ contributions: [row({ description: "" })] }).success).toBe(
      true,
    );
    // a bare string is no longer a contribution
    expect(make({ contributions: ["one"] }).success).toBe(false);
    expect(
      make({ contributions: [row({ activity: " trimmed " })] }),
    ).toMatchObject({
      data: { contributions: [{ activity: "trimmed" }] },
    });
    expect(make({ portfolio: "  " })).toMatchObject({
      data: { portfolio: "" },
    });
  });

  it("requires a real academic year and a user", () => {
    expect(
      jcrcSaveMineInput.safeParse({
        academicYear: "2026",
        portfolio: "",
        position: "",
        description: "",
        contributions: [],
        testimonial: "",
      }).success,
    ).toBe(false);
    expect(rosterUpsertInput.safeParse({ ...base, userID: "" }).success).toBe(
      false,
    );
    expect(rosterUpsertInput.safeParse({ ...base, ccaID: 0 }).success).toBe(
      false,
    );
    expect(rosterUpsertInput.safeParse({ ...base, ccaID: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("rosterUpsertInput: overrides", () => {
  const base = { ccaID: 9005, academicYear: AY, userID: "SEED-R12" };

  it("leaves omitted fields alone, clears null or blank ones, and sets the rest", () => {
    const parsed = rosterUpsertInput.parse({
      ...base,
      duration: "sem2",
      roleLabel: null,
      roleDuration: "",
      extraContribution: "  helped  ",
    });

    expect(parsed.duration).toBe("sem2");
    expect(parsed.roleLabel).toBeNull();
    expect(parsed.roleDuration).toBeNull();
    expect(parsed.extraContribution).toBe("helped");
    expect(
      "duration" in rosterUpsertInput.parse(base) &&
        rosterUpsertInput.parse(base).duration,
    ).toBeFalsy();
    expect(rosterUpsertInput.parse(base).duration).toBeUndefined();
  });

  it("rejects unknown durations and over-long values", () => {
    expect(
      rosterUpsertInput.safeParse({ ...base, duration: "sem3" }).success,
    ).toBe(false);
    expect(
      rosterUpsertInput.safeParse({ ...base, roleDuration: "half" }).success,
    ).toBe(false);
    expect(
      rosterUpsertInput.safeParse({ ...base, roleLabel: "r".repeat(61) })
        .success,
    ).toBe(false);
    expect(
      rosterUpsertInput.safeParse({ ...base, roleLabel: "r".repeat(60) })
        .success,
    ).toBe(true);
    expect(
      rosterUpsertInput.safeParse({
        ...base,
        extraContribution: "e".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      rosterUpsertInput.safeParse({
        ...base,
        extraContribution: "e".repeat(500),
      }).success,
    ).toBe(true);
  });

  it("rejects control characters in a role label", () => {
    expect(
      rosterUpsertInput.safeParse({ ...base, roleLabel: "Head\u0000" }).success,
    ).toBe(false);
  });
});

describe("volunteerActivityCreateInput", () => {
  const base = {
    ccaID: 9001,
    academicYear: AY,
    title: "Weekly tuition",
    description: "",
    kind: "regular" as const,
  };
  const ID = "0123456789abcdef01234567";

  it("accepts a regular activity with no session fields", () => {
    expect(volunteerActivityCreateInput.safeParse(base).success).toBe(true);
    expect(
      volunteerActivityCreateInput.safeParse({ ...base, defaultHours: 1.5 })
        .success,
    ).toBe(true);
  });

  it("needs a date and hours for a one-off, the date inside the year", () => {
    const oneoff = { ...base, kind: "oneoff" as const };
    expect(volunteerActivityCreateInput.safeParse(oneoff).success).toBe(false);
    expect(
      volunteerActivityCreateInput.safeParse({ ...oneoff, date: "2026-11-02" })
        .success,
    ).toBe(false);
    expect(
      volunteerActivityCreateInput.safeParse({ ...oneoff, hours: 3 }).success,
    ).toBe(false);
    expect(
      volunteerActivityCreateInput.safeParse({
        ...oneoff,
        date: "2026-11-02",
        hours: 3,
      }).success,
    ).toBe(true);
    expect(
      volunteerActivityCreateInput.safeParse({
        ...oneoff,
        date: "2027-08-01",
        hours: 3,
      }).success,
    ).toBe(false);
  });

  it("refuses a date or hours on a regular activity", () => {
    expect(
      volunteerActivityCreateInput.safeParse({ ...base, date: "2026-11-02" })
        .success,
    ).toBe(false);
    expect(
      volunteerActivityCreateInput.safeParse({ ...base, hours: 2 }).success,
    ).toBe(false);
  });

  it("limits the title to 80 and the description to 300", () => {
    const parse = (extra: object) =>
      volunteerActivityCreateInput.safeParse({ ...base, ...extra }).success;
    expect(parse({ title: "x".repeat(80) })).toBe(true);
    expect(parse({ title: "x".repeat(81) })).toBe(false);
    expect(parse({ title: "   " })).toBe(false);
    expect(parse({ description: "x".repeat(300) })).toBe(true);
    expect(parse({ description: "x".repeat(301) })).toBe(false);
  });

  it("takes only a real kind", () => {
    expect(
      volunteerActivityCreateInput.safeParse({ ...base, kind: "weekly" })
        .success,
    ).toBe(false);
  });

  it.each([0.25, 0.5, 1, 7.75, 24])("accepts %s hours", (h) => {
    expect(
      volunteerActivityCreateInput.safeParse({ ...base, defaultHours: h })
        .success,
    ).toBe(true);
  });

  it.each([0, 0.1, 0.3, 1.1, 24.25, 25, 200, -1, Number.NaN])(
    "rejects %s hours",
    (h) => {
      expect(
        volunteerActivityCreateInput.safeParse({ ...base, defaultHours: h })
          .success,
      ).toBe(false);
    },
  );

  it("updates by id with the same text rules", () => {
    const body = { ccaID: 9001, title: "T", description: "" };
    expect(
      volunteerActivityUpdateInput.safeParse({ ...body, id: ID }).success,
    ).toBe(true);
    expect(
      volunteerActivityUpdateInput.safeParse({ ...body, id: "nope" }).success,
    ).toBe(false);
    expect(
      volunteerActivityUpdateInput.safeParse({
        ...body,
        id: ID,
        hours: 0.3,
      }).success,
    ).toBe(false);
  });

  it("adds a session with optional date and hours, 0.25 to 24", () => {
    const add = (extra: object) =>
      volunteerSessionAddInput.safeParse({
        activityID: ID,
        ccaID: 9001,
        ...extra,
      }).success;
    expect(add({})).toBe(true);
    expect(add({ date: "2026-10-08", hours: 1.5 })).toBe(true);
    expect(add({ hours: 25 })).toBe(false);
    expect(add({ date: "2026-02-30" })).toBe(false);
  });

  it("sets people by key, at most 300", () => {
    const people = (n: number) =>
      volunteerPeopleSetInput.safeParse({
        activityID: ID,
        ccaID: 9001,
        userIDs: Array.from({ length: n }, (_, i) => `e${i}`),
      }).success;
    expect(people(300)).toBe(true);
    expect(people(301)).toBe(false);
    expect(people(0)).toBe(true);
  });

  it("saves attendance as ticks with an optional override", () => {
    const save = (changes: object[]) =>
      volunteerAttendanceSaveInput.safeParse({
        activityID: ID,
        ccaID: 9001,
        changes,
      }).success;
    expect(save([{ sessionID: ID, userID: "a", attended: true }])).toBe(true);
    expect(
      save([
        { sessionID: ID, userID: "a", attended: true, hoursOverride: 2.5 },
        { sessionID: ID, userID: "b", attended: true, hoursOverride: null },
        { sessionID: ID, userID: "c", attended: false },
      ]),
    ).toBe(true);
    expect(
      save([
        { sessionID: ID, userID: "a", attended: true, hoursOverride: 0.1 },
      ]),
    ).toBe(false);
    expect(save([{ sessionID: "x", userID: "a", attended: true }])).toBe(false);
  });
});

describe("isDateInAcademicYear", () => {
  it("covers 1 August to 31 July inclusive", () => {
    expect(isDateInAcademicYear("2026-08-01", AY)).toBe(true);
    expect(isDateInAcademicYear("2027-01-11", AY)).toBe(true);
    expect(isDateInAcademicYear("2027-07-31", AY)).toBe(true);
    expect(isDateInAcademicYear("2026-07-31", AY)).toBe(false);
    expect(isDateInAcademicYear("2027-08-01", AY)).toBe(false);
  });

  it("is false for a malformed year or date", () => {
    expect(isDateInAcademicYear("2026-09-12", "AY2026/28")).toBe(false);
    expect(isDateInAcademicYear("12/09/2026", AY)).toBe(false);
  });
});

describe("search and id inputs", () => {
  it("needs at least 3 characters once trimmed", () => {
    expect(searchQueryInput.safeParse("ab").success).toBe(false);
    expect(searchQueryInput.safeParse("  ab  ").success).toBe(false);
    expect(searchQueryInput.safeParse("abc").success).toBe(true);
    expect(searchQueryInput.safeParse("a".repeat(61)).success).toBe(false);
  });

  it("takes only a 24-character hex id", () => {
    expect(idInput.safeParse({ id: "0123456789abcdef01234567" }).success).toBe(
      true,
    );
    for (const id of [
      "",
      "123",
      "zzzzzzzzzzzzzzzzzzzzzzzz",
      "0123456789abcdef0123456789",
    ]) {
      expect(idInput.safeParse({ id }).success).toBe(false);
    }
  });
});

describe("accessFor: the management matrix", () => {
  const ROLES = {
    resident: ["resident"],
    headRole: ["resident", "cca_head"],
    jcrc: ["resident", "jcrc"],
    jcrcAndHead: ["resident", "jcrc", "cca_head"],
    admin: ["admin", "resident"],
    scrc: ["scrc"],
    none: [],
  } as const;

  // family -> role -> [headsThisCca=false, headsThisCca=true]
  const EXPECTED: Record<
    AccessFamily,
    Record<keyof typeof ROLES, [boolean, boolean]>
  > = {
    manager: {
      resident: [false, false],
      headRole: [false, false],
      jcrc: [true, true],
      jcrcAndHead: [true, true],
      admin: [true, true],
      scrc: [false, false],
      none: [false, false],
    },
    cca: {
      resident: [false, true],
      headRole: [false, true], // the role string alone grants nothing: only a live head of THIS CCA does
      jcrc: [true, true],
      jcrcAndHead: [true, true],
      admin: [true, true],
      scrc: [false, true],
      none: [false, true],
    },
    jcrcSelf: {
      resident: [false, false],
      headRole: [false, false],
      jcrc: [true, true],
      jcrcAndHead: [true, true],
      admin: [false, false], // admin is not a JCRC member
      scrc: [false, false],
      none: [false, false],
    },
  };

  for (const family of Object.keys(EXPECTED) as AccessFamily[]) {
    describe(family, () => {
      for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
        it(`${role}: not head of this CCA / head of this CCA`, () => {
          const [notHead, head] = EXPECTED[family][role];

          expect(accessFor(family, ROLES[role], false)).toBe(notHead);
          expect(accessFor(family, ROLES[role], true)).toBe(head);
        });
      }
    });
  }

  it("never lets the cca_head role string stand in for heading a CCA", () => {
    expect(accessFor("cca", ["cca_head"])).toBe(false);
    expect(accessFor("cca", ["cca_head"], true)).toBe(true);
  });
});
