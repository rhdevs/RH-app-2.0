import { describe, expect, it } from "vitest";
import {
  JCRC_ABOUT_TEXT,
  MISSING_DESCRIPTION_TEXT,
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
        block: "Block 1",
        yearOfResidence: 1,
      },
    ],
    memberships: [],
    regularVolunteering: [],
    oneOffVolunteering: [],
    awards: [],
    jcrc: null,
  };
}

describe("fixtures", () => {
  it("provides twelve specimens, each flagged isSpecimen", () => {
    expect(TRANSCRIPT_FIXTURES).toHaveLength(12);
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
        ccaName: "Phoenix Press",
        role: null,
        year: "2026/27",
        extraContribution: null,
        footnote: 1,
        isJcrc: false,
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
      isJcrc: true,
      footnote: 1,
    });
    expect(rows.slice(1).every((r) => !r.isJcrc)).toBe(true);
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
    expect(years["Hall Orientation Committee"]).toBe("2027/28 (Semester 1)");
    expect(years["RH Welfare"]).toBe("2027/28 (Semester 2)");
    expect(years["Soccer (MALE)"]).toBe("2027/28");
  });

  it("shows the semester next to the role when the role was held for part of the year", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const dance = section(vm, "involvements")?.rows.find(
      (r) => r.ccaName === "Raffles Hall Dance",
    );
    expect(dance?.role).toBe("Head (Semester 2)");
    expect(dance?.year).toBe("2027/28");
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
      testimonial: { text: "", author: "Hall Master" },
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

describe("assembleTranscript: explanatory notes", () => {
  it("uses the placeholder for a CCA with a null description", () => {
    const vm = assembleFixture("missing-description");

    const notes = page(vm, "notes")?.notes ?? [];
    expect(notes.find((n) => n.title === "Hall Orchestra")).toMatchObject({
      text: MISSING_DESCRIPTION_TEXT,
      isMissing: true,
    });
    expect(MISSING_DESCRIPTION_TEXT).toBe("Description not yet available.");
  });

  it("keeps the real description for a CCA that has one", () => {
    const vm = assembleFixture("missing-description");

    const notes = page(vm, "notes")?.notes ?? [];
    expect(notes.find((n) => n.title === "Welfare Committee")?.isMissing).toBe(
      false,
    );
  });

  it("treats a whitespace-only description as missing", () => {
    const input = blankInput();
    input.memberships = [membership({ description: "   " })];

    const vm = assembleTranscript(input, AY);

    expect(page(vm, "notes")?.notes[0]?.isMissing).toBe(true);
  });

  it("numbers each note to match the footnote on its table row", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const rows = section(vm, "involvements")?.rows ?? [];
    const notes = page(vm, "notes")?.notes ?? [];
    expect(notes.map((n) => n.number)).toEqual(rows.map((r) => r.footnote));
    expect(notes.map((n) => n.title)).toEqual([
      "JCRC (Junior Common Room Committee)",
      "Raffles Hall Dance",
      "Hall Orientation Committee",
      "Raffles Hall Photography",
      "RH Welfare",
      "Soccer (MALE)",
    ]);
  });

  it("describes the JCRC in its note and never calls it missing", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    const note = page(vm, "notes")?.notes[0];
    expect(note?.isMissing).toBe(false);
    expect(note?.text).toMatch(/elected student committee/);
  });

  it("lists a CCA once even if it is recorded twice, keeping any description", () => {
    const input = blankInput();
    input.memberships = [
      membership({ description: null }),
      membership({ description: "Real text." }),
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows).toHaveLength(1);
    expect(page(vm, "notes")?.notes).toEqual([
      { number: 1, title: "A", text: "Real text.", isMissing: false },
    ]);
  });
});

describe("assembleTranscript: volunteer hours", () => {
  it("omits the section when the resident has none", () => {
    const vm = assembleFixture("no-volunteering");

    expect(vm.hasVolunteerHours).toBe(false);
    expect(section(vm, "volunteerHours")).toBeUndefined();
  });

  it("computes group subtotals and a grand total", () => {
    const vm = assembleFixture("volunteering");

    const volunteer = section(vm, "volunteerHours")?.volunteer;
    expect(vm.hasVolunteerHours).toBe(true);
    expect(volunteer?.regularSubtotal).toBe(44.5);
    expect(volunteer?.oneOffSubtotal).toBe(10.5);
    expect(volunteer?.total).toBe(55);
  });

  it("labels each row regular or one-off and names the organiser", () => {
    const vm = assembleFixture("volunteering");

    const rows = section(vm, "volunteerHours")?.volunteer.rows ?? [];
    expect(rows.map((r) => [r.activity, r.organiser])).toEqual([
      ["Monthly performances at a nursing home (regular)", "Hall Choir"],
      [
        "Weekly tuition for neighbourhood children (regular)",
        "Welfare Committee",
      ],
      ["Freshmen Orientation helper (one-off)", "Hall committee"],
      ["Hall Open House (one-off)", "Hall committee"],
    ]);
  });

  it("lists regular rows by CCA, then one-off rows by date", () => {
    const vm = assembleFixture("volunteering");

    const rows = section(vm, "volunteerHours")?.volunteer.rows ?? [];
    expect(rows.map((r) => r.kind)).toEqual([
      "regular",
      "regular",
      "one-off",
      "one-off",
    ]);
    expect(rows.filter((r) => r.kind === "one-off").map((r) => r.date)).toEqual(
      ["2026-08-12", "2027-01-23"],
    );
  });

  it("shows a zero subtotal for the group that is empty", () => {
    const input = blankInput();
    input.regularVolunteering = [
      { academicYear: AY, ccaName: "A", activity: "X", hours: 5 },
    ];

    const vm = assembleTranscript(input, AY);

    const volunteer = section(vm, "volunteerHours")?.volunteer;
    expect(volunteer?.oneOffSubtotal).toBe(0);
    expect(volunteer?.total).toBe(5);
  });

  it("rounds away floating-point noise in totals", () => {
    const input = blankInput();
    input.oneOffVolunteering = [
      {
        academicYear: AY,
        eventName: "A",
        organiser: "O",
        date: "2026-09-01",
        hours: 0.1,
      },
      {
        academicYear: AY,
        eventName: "B",
        organiser: "O",
        date: "2026-09-02",
        hours: 0.2,
      },
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "volunteerHours")?.volunteer.total).toBe(0.3);
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

  it("gives a non-JCRC resident the main page and the notes page only", () => {
    const vm = assembleFixture("plain-member");

    expect(vm.hasJcrc).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "notes"]);
  });

  it("puts the JCRC page between the main page and the notes page", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    expect(vm.hasJcrc).toBe(true);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "jcrc", "notes"]);
  });

  it("builds the JCRC page from the resident's own service record", () => {
    const vm = assembleFixture("jcrc-sports-secretary", JCRC_AY);

    expect(page(vm, "jcrc")?.jcrc).toMatchObject({
      portfolio: "Sports",
      position: "Secretary",
      term: JCRC_AY,
      about: JCRC_ABOUT_TEXT,
      isPlaceholder: true,
      testimonial: { author: "Hall Master" },
    });
    expect(page(vm, "jcrc")?.jcrc.contributions).toHaveLength(4);
  });

  it("works for a JCRC member with no other CCAs and no volunteering", () => {
    const vm = assembleFixture("jcrc-only");

    expect(vm.isEmpty).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "jcrc", "notes"]);
    expect(section(vm, "involvements")?.rows).toHaveLength(1);
    expect(section(vm, "involvements")?.rows[0]?.isJcrc).toBe(true);
    expect(vm.hasVolunteerHours).toBe(false);
    expect(page(vm, "notes")?.notes).toHaveLength(1);
  });

  it("omits the JCRC page for a year the JCRC term does not cover", () => {
    const vm = assembleFixture("jcrc-sports-secretary", AY);

    expect(vm.hasJcrc).toBe(false);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "notes"]);
    expect(section(vm, "involvements")?.rows.some((r) => r.isJcrc)).toBe(false);
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
    input.regularVolunteering = [
      { academicYear: "AY2027/28", ccaName: "Later", activity: "X", hours: 9 },
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

  it("carries the issue for that year: its block and year of residence", () => {
    const vm = assembleFixture("jcrc-sports-secretary", "AY2027/28");

    expect(vm.issue).toMatchObject({
      academicYear: "AY2027/28",
      yearOfResidence: 2,
      block: "Block 3",
    });
  });

  it("is empty when nothing was recorded for the year, but still has notes", () => {
    const vm = assembleFixture("empty-year");

    expect(vm.isEmpty).toBe(true);
    expect(page(vm, "main")?.sections).toEqual([]);
    expect(vm.pages.map((p) => p.kind)).toEqual(["main", "notes"]);
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
