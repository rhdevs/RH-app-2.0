import { describe, expect, it } from "vitest";
import {
  JCRC_ABOUT_TEXT,
  JCRC_ROW_DESCRIPTION,
  assembleTranscript,
  formatIssuedOn,
  yearFromParam,
  yearToParam,
} from "../assemble";
import {
  FIXTURE_ACADEMIC_YEAR,
  TRANSCRIPT_FIXTURES,
  getFixtureBySlug,
  getFixtureYears,
  resolveFixtureYear,
} from "../fixtures";
import {
  type CcaMembershipInput,
  type TranscriptInput,
  type TranscriptPage,
  type TranscriptSection,
  type TranscriptViewModel,
  type VolunteerActivityInput,
} from "../types";

const AY = FIXTURE_ACADEMIC_YEAR;
/** The year of the JCRC term in the "jcrc-sports-secretary" specimen. */
const JCRC_AY = "AY2027/28";

function fixtureInput(slug: string): TranscriptInput {
  const fixture = getFixtureBySlug(slug);
  if (!fixture) throw new Error(`missing fixture ${slug}`);
  return fixture.input;
}

function assembleFixture(slug: string, year = AY): TranscriptViewModel {
  return assembleTranscript(fixtureInput(slug), year);
}

function page<K extends TranscriptPage["kind"]>(
  vm: TranscriptViewModel,
  kind: K,
): Extract<TranscriptPage, { kind: K }> | undefined {
  return vm.pages.find(
    (p): p is Extract<TranscriptPage, { kind: K }> => p.kind === kind,
  );
}

function section<K extends TranscriptSection["kind"]>(
  vm: TranscriptViewModel,
  kind: K,
): Extract<TranscriptSection, { kind: K }> | undefined {
  return page(vm, "main")?.sections.find(
    (s): s is Extract<TranscriptSection, { kind: K }> => s.kind === kind,
  );
}

function membership(
  overrides: Partial<CcaMembershipInput> = {},
): CcaMembershipInput {
  return {
    ccaName: "A",
    category: "C",
    academicYear: AY,
    leadershipRole: null,
    description: null,
    extraContribution: null,
    ...overrides,
  };
}

function blankInput(): TranscriptInput {
  return {
    resident: { name: "Test Resident", matric: "A0000000X", isSpecimen: true },
    issues: [
      {
        academicYear: AY,
        issuedOn: "2027-05-10",
      },
    ],
    memberships: [],
    volunteering: [],
    awards: [],
    jcrc: null,
  };
}

describe("fixtures", () => {
  it("provides fourteen specimens, each flagged isSpecimen", () => {
    expect(TRANSCRIPT_FIXTURES).toHaveLength(14);
    expect(TRANSCRIPT_FIXTURES.every((f) => f.input.resident.isSpecimen)).toBe(
      true,
    );
  });

  it("carries no verification code on any issued year", () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      for (const issue of f.input.issues) {
        expect(Object.keys(issue)).not.toContain("verificationCode");
      }
    }
  });

  it("assembles every issued year of every fixture without throwing", () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      for (const year of getFixtureYears(f)) {
        expect(() => assembleTranscript(f.input, year)).not.toThrow();
      }
    }
  });

  it("returns null for an unknown slug", () => {
    expect(getFixtureBySlug("nope")).toBeNull();
  });

  it("resolves the latest year by default and a requested year by param", () => {
    const fixture = getFixtureBySlug("jcrc-sports-secretary")!;

    expect(getFixtureYears(fixture)).toEqual(["AY2026/27", "AY2027/28"]);
    expect(resolveFixtureYear(fixture, undefined)).toBe("AY2027/28");
    expect(resolveFixtureYear(fixture, "2026-27")).toBe("AY2026/27");
    expect(resolveFixtureYear(fixture, "2030-31")).toBeNull();
  });

  it("round-trips an academic year through its URL form", () => {
    expect(yearToParam("AY2026/27")).toBe("2026-27");
    expect(yearFromParam("2026-27")).toBe("AY2026/27");
    expect(yearFromParam("AY2026/27")).toBe("AY2026/27");
  });
});

describe("assembleTranscript: roles", () => {
  it("leaves the role blank for a plain member", () => {
    const vm = assembleFixture("plain-member");

    expect(section(vm, "involvements")?.rows).toEqual([
      {
        number: 1,
        ccaName: "Phoenix Press",
        role: null,
        year: "2026/27",
        extraContribution: null,
        description:
          "Phoenix Press is a hall CCA in the Media Committees category.",
        activities: [],
      },
    ]);
  });

  it("states the role for a CCA head", () => {
    const vm = assembleFixture("cca-head");

    expect(section(vm, "involvements")?.rows[0]?.role).toBe("Captain");
  });

  it("treats a blank or whitespace role as no role", () => {
    const input = blankInput();
    input.memberships = [membership({ leadershipRole: "   " })];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows[0]?.role).toBeNull();
  });

  it("lists the leadership CCA before the plain-member CCA", () => {
    const vm = assembleFixture("leader-and-member");

    const rows = section(vm, "involvements")?.rows ?? [];
    expect(rows.map((r) => [r.ccaName, r.role])).toEqual([
      ["RH Developers", "Head"],
      ["Badminton (MALE)", null],
    ]);
  });

  it("puts the JCRC appointment first with its portfolio and position", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const rows = section(vm, "involvements")?.rows ?? [];
    expect(rows[0]).toMatchObject({
      ccaName: "Junior Common Room Committee (JCRC), Sports",
      role: "Secretary",
      number: 1,
      description: JCRC_ROW_DESCRIPTION,
    });
    expect(rows.map((r) => r.number)).toEqual(rows.map((_, i) => i + 1));
    expect(
      rows.slice(1).every((r) => r.description !== JCRC_ROW_DESCRIPTION),
    ).toBe(true);
    expect(rows[1]?.ccaName).toBe("Raffles Hall Dance");
  });
});

describe("assembleTranscript: durations", () => {
  it("prints nothing extra for a full year", () => {
    const row = section(assembleFixture("cca-head"), "involvements")?.rows[0];

    expect(row?.year).toBe("2026/27");
    expect(row?.role).toBe("Captain");
  });

  it("shows the semester next to the year when the membership is not a full year", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const rows = section(vm, "involvements")?.rows ?? [];
    const years = Object.fromEntries(rows.map((r) => [r.ccaName, r.year]));
    expect(years["Hall Orientation Committee"]).toBe("2027/28 Sem 1");
    expect(years["RH Welfare"]).toBe("2027/28 Sem 2");
    expect(years["Soccer (MALE)"]).toBe("2027/28");
  });

  it("shows the semester next to the role when the role was held for part of the year", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const dance = section(vm, "involvements")?.rows.find(
      (r) => r.ccaName === "Raffles Hall Dance",
    );
    expect(dance?.role).toBe("Head (Sem 2)");
    expect(dance?.year).toBe("2027/28");
  });

  it("flags part-year involvement so the closing key can explain it", () => {
    expect(assembleFixture("jcrc-sports-secretary", JCRC_AY).hasPartYear).toBe(
      true,
    );
    expect(assembleFixture("cca-head").hasPartYear).toBe(false);
    const input = blankInput();
    input.memberships = [membership({ ccaName: "A", roleDuration: "sem2" })];
    expect(assembleTranscript(input, AY).hasPartYear).toBe(false);
    input.memberships = [
      membership({
        ccaName: "A",
        leadershipRole: "Head",
        roleDuration: "sem2",
      }),
    ];
    expect(assembleTranscript(input, AY).hasPartYear).toBe(true);
  });

  it("never prints a duration for a blank role", () => {
    const input = blankInput();
    input.memberships = [membership({ roleDuration: "sem2" })];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows[0]?.role).toBeNull();
  });

  it("treats a full or missing duration as nothing to print", () => {
    const input = blankInput();
    input.memberships = [
      membership({
        ccaName: "A",
        duration: "full",
        leadershipRole: "Head",
        roleDuration: "full",
      }),
      membership({ ccaName: "B", duration: null, roleDuration: null }),
    ];

    const rows =
      section(assembleTranscript(input, AY), "involvements")?.rows ?? [];

    expect(rows.map((r) => [r.year, r.role])).toEqual([
      ["2026/27", "Head"],
      ["2026/27", null],
    ]);
  });

  it("omits the portfolio from the JCRC row when it is blank", () => {
    const input = blankInput();
    input.jcrc = {
      portfolio: "  ",
      position: "Member",
      term: AY,
      description: "",
      contributions: [],
      testimonial: { text: "" },
      isPlaceholder: true,
    };

    const rows =
      section(assembleTranscript(input, AY), "involvements")?.rows ?? [];

    expect(rows[0]?.ccaName).toBe("Junior Common Room Committee (JCRC)");
  });
});

describe("assembleTranscript: additional contributions", () => {
  it("attaches the contribution text to its CCA row", () => {
    const vm = assembleFixture("additional-contribution");

    expect(section(vm, "involvements")?.rows[0]?.extraContribution).toMatch(
      /main set piece/,
    );
  });

  it("drops a whitespace-only contribution", () => {
    const input = blankInput();
    input.memberships = [membership({ extraContribution: "  " })];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows[0]?.extraContribution).toBeNull();
  });
});

describe("assembleTranscript: CCA descriptions in the table", () => {
  const rowsOf = (vm: TranscriptViewModel) =>
    section(vm, "involvements")?.rows ?? [];

  it("leaves the description blank for a CCA with a null description", () => {
    const vm = assembleFixture("missing-description");

    expect(
      rowsOf(vm).find((r) => r.ccaName === "Hall Orchestra")?.description,
    ).toBe("");
    expect(JSON.stringify(vm)).not.toContain("not yet available");
  });

  it("keeps the real description for a CCA that has one", () => {
    const vm = assembleFixture("missing-description");

    expect(
      rowsOf(vm).find((r) => r.ccaName === "Welfare Committee")?.description,
    ).toBe("Welfare Committee is a hall CCA in the Committees category.");
  });

  it("treats a whitespace-only description as blank", () => {
    const input = blankInput();
    input.memberships = [membership({ description: "   " })];

    expect(rowsOf(assembleTranscript(input, AY))[0]?.description).toBe("");
  });

  it("shortens a long description to 180 characters at a word boundary", () => {
    const input = blankInput();
    input.memberships = [membership({ description: "word ".repeat(80) })];

    const text = rowsOf(assembleTranscript(input, AY))[0]!.description;
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(181);
  });

  it("numbers the CCAs 1, 2, 3 and their activities 1.1, 1.2", () => {
    const vm = assembleFixture("member-with-activities");

    const rows = rowsOf(vm);
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(rows[0]!.activities.map((a) => a.number)).toEqual([
      "1.1",
      "1.2",
      "1.3",
    ]);
    expect(rows[1]!.activities).toEqual([]);
  });

  it("describes the JCRC in its own row, with the fixed sentence", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    expect(rowsOf(vm)[0]?.description).toBe(
      "The elected student committee that leads the hall. See the JCRC page.",
    );
    expect(rowsOf(vm)[0]?.activities).toEqual([]);
  });

  it("lists a CCA once even if it is recorded twice, keeping any description", () => {
    const input = blankInput();
    input.memberships = [
      membership({ description: null }),
      membership({ description: "Real text." }),
    ];

    const rows = rowsOf(assembleTranscript(input, AY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Real text.");
  });
});

describe("assembleTranscript: volunteer hours", () => {
  const volunteering = (
    over: Partial<VolunteerActivityInput> = {},
  ): VolunteerActivityInput => ({
    academicYear: AY,
    title: "X",
    kind: "regular",
    ccaName: "RVC A",
    hours: 5,
    ...over,
  });

  it("omits the section when the resident has none", () => {
    const vm = assembleFixture("no-volunteering");

    expect(vm.hasVolunteerHours).toBe(false);
    expect(section(vm, "volunteerHours")).toBeUndefined();
  });

  it("totals the hours of every activity", () => {
    const vm = assembleFixture("volunteering");

    const volunteer = section(vm, "volunteerHours")?.volunteer;
    expect(vm.hasVolunteerHours).toBe(true);
    expect(volunteer?.total).toBe(55);
  });

  it("makes one row per activity: title, type, organiser and total hours", () => {
    const vm = assembleFixture("volunteering");

    const rows = section(vm, "volunteerHours")?.volunteer.rows ?? [];
    expect(rows.map((r) => [r.activity, r.type, r.organiser, r.hours])).toEqual(
      [
        ["Monthly performances at a nursing home", "Regular", "Hall Choir", 12],
        [
          "Weekly tuition for neighbourhood children",
          "Regular",
          "Welfare Committee",
          32.5,
        ],
        ["Freshmen Orientation helper", "One-off", "Hall committee", 6],
        ["Hall Open House", "One-off", "Hall committee", 4.5],
      ],
    );
  });

  it("lists regular activities first, then one-off ones, each by title", () => {
    const input = blankInput();
    input.volunteering = [
      volunteering({ title: "Zebra", kind: "oneoff" }),
      volunteering({ title: "Beta" }),
      volunteering({ title: "Alpha", kind: "oneoff" }),
      volunteering({ title: "Gamma" }),
    ];

    const rows =
      section(assembleTranscript(input, AY), "volunteerHours")?.volunteer
        .rows ?? [];
    expect(rows.map((r) => `${r.type}:${r.activity}`)).toEqual([
      "Regular:Beta",
      "Regular:Gamma",
      "One-off:Alpha",
      "One-off:Zebra",
    ]);
  });

  it("leaves out an activity with no hours", () => {
    const input = blankInput();
    input.volunteering = [volunteering({ hours: 0 })];

    expect(
      section(assembleTranscript(input, AY), "volunteerHours"),
    ).toBeUndefined();
  });

  it("rounds away floating-point noise in totals", () => {
    const input = blankInput();
    input.volunteering = [
      volunteering({ title: "A", hours: 0.1 }),
      volunteering({ title: "B", hours: 0.2 }),
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "volunteerHours")?.volunteer.total).toBe(0.3);
  });

  it("never carries a session count or a date", () => {
    const vm = assembleFixture("volunteering");

    const rows = section(vm, "volunteerHours")?.volunteer.rows ?? [];
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "activity",
        "hours",
        "organiser",
        "type",
      ]);
    }
  });
});

describe("assembleTranscript: awards", () => {
  it("includes awards with their citation", () => {
    const vm = assembleFixture("awards");

    const rows = section(vm, "awards")?.rows ?? [];
    expect(vm.hasAwards).toBe(true);
    expect(rows.map((r) => r.title)).toEqual([
      "Colours Award for Sports",
      "Service Excellence Award",
    ]);
    expect(rows[0]?.citation).toMatch(/Inter-Hall Games/);
    expect(rows[1]?.citation).toBeNull();
  });

  it("omits the section when there are no awards", () => {
    const vm = assembleFixture("plain-member");

    expect(vm.hasAwards).toBe(false);
    expect(section(vm, "awards")).toBeUndefined();
  });
});

describe("assembleTranscript: pages and sections", () => {
  it("orders page 1 sections involvements, volunteer hours, awards", () => {
    const vm = assembleFixture("many-ccas");

    const main = page(vm, "main");
    expect(main?.sections.map((s) => s.kind)).toEqual([
      "involvements",
      "volunteerHours",
      "awards",
    ]);
  });

  it("gives a non-JCRC resident the main page only", () => {
    const vm = assembleFixture("plain-member");

    expect(vm.hasJcrc).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main"]);
  });

  it("puts the JCRC page after the main page", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    expect(vm.hasJcrc).toBe(true);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "jcrc"]);
  });

  it("builds the JCRC page from the resident's own service record", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    expect(page(vm, "jcrc")?.jcrc).toMatchObject({
      portfolio: "Sports",
      position: "Secretary",
      term: JCRC_AY,
      about: JCRC_ABOUT_TEXT,
      isPlaceholder: true,
      testimonial: {},
    });
    expect(page(vm, "jcrc")?.jcrc.contributions).toHaveLength(4);
  });

  it("works for a JCRC member with no other CCAs and no volunteering", () => {
    const vm = assembleFixture("jcrc-only");

    expect(vm.isEmpty).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "jcrc"]);
    expect(section(vm, "involvements")?.rows).toHaveLength(1);
    expect(section(vm, "involvements")?.rows[0]?.description).toBe(
      JCRC_ROW_DESCRIPTION,
    );
    expect(vm.hasVolunteerHours).toBe(false);
  });

  it("omits the JCRC page for a year the JCRC term does not cover", () => {
    const vm = assembleFixture("jcrc-sports-secretary", AY);

    expect(vm.hasJcrc).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main"]);
    expect(
      section(vm, "involvements")?.rows.some(
        (r) => r.description === JCRC_ROW_DESCRIPTION,
      ),
    ).toBe(false);
  });

  it("handles a resident in 14 CCAs, leaders first then alphabetical", () => {
    const vm = assembleFixture("many-ccas");

    const rows = section(vm, "involvements")?.rows ?? [];
    expect(rows).toHaveLength(14);
    expect(rows[0]?.ccaName).toBe("Badminton (MALE)");
    expect(rows[0]?.role).toBe("Vice-Captain");
    const rest = rows.slice(1).map((r) => r.ccaName);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("returns the same output regardless of input order", () => {
    const input = fixtureInput("many-ccas");
    const reversed: TranscriptInput = {
      ...input,
      memberships: [...input.memberships].reverse(),
    };

    expect(assembleTranscript(reversed, AY)).toEqual(
      assembleTranscript(input, AY),
    );
  });
});

describe("assembleTranscript: academic year", () => {
  it("only includes records for the requested year", () => {
    const input = blankInput();
    input.issues = [
      ...input.issues,
      {
        ...input.issues[0]!,
        academicYear: "AY2027/28",
      },
    ];
    input.memberships = [
      membership({ ccaName: "Later", academicYear: "AY2027/28" }),
      membership({ ccaName: "Now" }),
    ];
    input.volunteering = [
      {
        academicYear: "AY2027/28",
        ccaName: "Later",
        title: "X",
        kind: "regular",
        hours: 9,
      },
    ];
    input.awards = [
      { title: "Later award", academicYear: "AY2027/28", citation: null },
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows.map((r) => r.ccaName)).toEqual([
      "Now",
    ]);
    expect(vm.hasVolunteerHours).toBe(false);
    expect(vm.hasAwards).toBe(false);
  });

  it("carries the issue for that year: its academic year and issue date", () => {
    const vm = assembleFixture("jcrc-sports-secretary", "AY2027/28");

    expect(vm.issue).toEqual({
      academicYear: "AY2027/28",
      issuedOn: "2028-05-09",
    });
  });

  it("is empty when nothing was recorded for the year", () => {
    const vm = assembleFixture("empty-year");

    expect(vm.isEmpty).toBe(true);
    expect(page(vm, "main")?.sections).toEqual([]);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main"]);
    expect(vm.academicYear).toBe(AY);
  });

  it("is not empty when there are only awards", () => {
    const input = blankInput();
    input.awards = [{ title: "T", academicYear: AY, citation: null }];

    expect(assembleTranscript(input, AY).isEmpty).toBe(false);
  });

  it("throws when no transcript was issued for the year", () => {
    expect(() =>
      assembleTranscript(fixtureInput("plain-member"), "AY2030/31"),
    ).toThrow(RangeError);
  });
});

describe("assembleTranscript: purity", () => {
  it("does not mutate its input", () => {
    const input = fixtureInput("jcrc-sports-secretary");
    const before = structuredClone(input);

    assembleTranscript(input, JCRC_AY);

    expect(input).toEqual(before);
  });

  it("returns copies of the resident and the issue, not the input objects", () => {
    const input = fixtureInput("plain-member");

    const vm = assembleTranscript(input, AY);

    expect(vm.resident).toEqual(input.resident);
    expect(vm.resident).not.toBe(input.resident);
    expect(vm.issue).not.toBe(input.issues[0]);
  });

  it("does not share the contributions array with the input", () => {
    const input = fixtureInput("jcrc-sports-secretary");

    const vm = assembleTranscript(input, JCRC_AY);

    expect(page(vm, "jcrc")?.jcrc.contributions).not.toBe(
      input.jcrc?.contributions,
    );
  });
});

describe("formatting helpers", () => {
  it("formats an ISO issue date as dd/mm/yyyy", () => {
    expect(formatIssuedOn("2027-05-10")).toBe("10/05/2027");
  });
});
