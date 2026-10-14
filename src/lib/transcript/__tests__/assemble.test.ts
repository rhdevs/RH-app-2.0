import { describe, expect, it } from "vitest";
import {
  MISSING_DESCRIPTION_TEXT,
  assembleTranscript,
  formatIssuedOn,
  normaliseVerificationCode,
} from "../assemble";
import {
  FIXTURE_ACADEMIC_YEAR,
  TRANSCRIPT_FIXTURES,
  getFixtureByCode,
  getFixtureBySlug,
} from "../fixtures";
import {
  type CcaMembershipInput,
  type TranscriptInput,
  type TranscriptSection,
  type TranscriptViewModel,
} from "../types";

const AY = FIXTURE_ACADEMIC_YEAR;

function fixtureInput(slug: string): TranscriptInput {
  const fixture = getFixtureBySlug(slug);
  if (!fixture) throw new Error(`missing fixture ${slug}`);
  return fixture.input;
}

function assembleFixture(slug: string): TranscriptViewModel {
  return assembleTranscript(fixtureInput(slug), AY);
}

function section<K extends TranscriptSection["kind"]>(
  vm: TranscriptViewModel,
  kind: K,
): Extract<TranscriptSection, { kind: K }> | undefined {
  return vm.sections.find(
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
    resident: {
      name: "Test Resident",
      matric: "A0000000X",
      faculty: null,
      verificationCode: "RH-CCT-DEMO-9999",
      issuedOn: "2027-05-10",
      isSpecimen: true,
    },
    memberships: [],
    regularVolunteering: [],
    oneOffVolunteering: [],
    awards: [],
  };
}

describe("fixtures", () => {
  it("provides ten specimens, each flagged isSpecimen with a unique code", () => {
    const codes = TRANSCRIPT_FIXTURES.map(
      (f) => f.input.resident.verificationCode,
    );

    expect(TRANSCRIPT_FIXTURES).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(TRANSCRIPT_FIXTURES.every((f) => f.input.resident.isSpecimen)).toBe(
      true,
    );
  });

  it("assembles every fixture without throwing", () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      expect(() => assembleTranscript(f.input, f.academicYear)).not.toThrow();
    }
  });

  it("finds a fixture by code, ignoring case and spaces", () => {
    expect(getFixtureByCode("  rh-cct-demo-0001 ")?.slug).toBe("plain-member");
  });

  it("returns null for unknown or malformed codes", () => {
    expect(getFixtureByCode("RH-CCT-DEMO-4040")).toBeNull();
    expect(getFixtureByCode("<script>")).toBeNull();
    expect(getFixtureByCode("")).toBeNull();
  });

  it("returns null for an unknown slug", () => {
    expect(getFixtureBySlug("nope")).toBeNull();
  });
});

describe("assembleTranscript: roles", () => {
  it("leaves the role blank for a plain member", () => {
    const vm = assembleFixture("plain-member");

    expect(section(vm, "involvements")?.rows).toEqual([
      {
        ccaName: "Phoenix Press",
        category: "Media Committees",
        role: null,
        extraContribution: null,
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

describe("assembleTranscript: CCA descriptions", () => {
  it("uses the placeholder for a CCA with a null description", () => {
    const vm = assembleFixture("missing-description");

    const rows = section(vm, "ccaDescriptions")?.rows ?? [];
    expect(rows.find((r) => r.ccaName === "Hall Orchestra")).toEqual({
      ccaName: "Hall Orchestra",
      description: MISSING_DESCRIPTION_TEXT,
      isMissing: true,
    });
    expect(MISSING_DESCRIPTION_TEXT).toBe("Description not yet available.");
  });

  it("keeps the real description for a CCA that has one", () => {
    const vm = assembleFixture("missing-description");

    const rows = section(vm, "ccaDescriptions")?.rows ?? [];
    expect(rows.find((r) => r.ccaName === "Welfare Committee")?.isMissing).toBe(
      false,
    );
  });

  it("treats a whitespace-only description as missing", () => {
    const input = blankInput();
    input.memberships = [membership({ description: "   " })];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "ccaDescriptions")?.rows[0]?.isMissing).toBe(true);
  });

  it("lists only the resident's own CCAs, alphabetically", () => {
    const vm = assembleFixture("leader-and-member");

    const names = section(vm, "ccaDescriptions")?.rows.map((r) => r.ccaName);
    expect(names).toEqual(["Badminton (MALE)", "RH Developers"]);
  });

  it("lists a CCA once even if it appears twice", () => {
    const input = blankInput();
    input.memberships = [
      membership({ description: null }),
      membership({ description: "Real text." }),
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "ccaDescriptions")?.rows).toEqual([
      { ccaName: "A", description: "Real text.", isMissing: false },
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
    expect(volunteer?.regular.subtotal).toBe(44.5);
    expect(volunteer?.oneOff.subtotal).toBe(10.5);
    expect(volunteer?.total).toBe(55);
  });

  it("sorts regular rows by CCA and one-off rows by date", () => {
    const vm = assembleFixture("volunteering");

    const volunteer = section(vm, "volunteerHours")?.volunteer;
    expect(volunteer?.regular.rows.map((r) => r.ccaName)).toEqual([
      "Hall Choir",
      "Welfare Committee",
    ]);
    expect(volunteer?.oneOff.rows.map((r) => r.date)).toEqual([
      "2026-08-12",
      "2027-01-23",
    ]);
  });

  it("shows a zero subtotal for the group that is empty", () => {
    const input = blankInput();
    input.regularVolunteering = [{ academicYear: AY, ccaName: "A", hours: 5 }];

    const vm = assembleTranscript(input, AY);

    const volunteer = section(vm, "volunteerHours")?.volunteer;
    expect(volunteer?.oneOff).toEqual({ rows: [], subtotal: 0 });
    expect(volunteer?.total).toBe(5);
  });

  it("rounds away floating-point noise in totals", () => {
    const input = blankInput();
    input.oneOffVolunteering = [
      { academicYear: AY, eventName: "A", date: "2026-09-01", hours: 0.1 },
      { academicYear: AY, eventName: "B", date: "2026-09-02", hours: 0.2 },
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

describe("assembleTranscript: sections and ordering", () => {
  it("orders sections involvements, descriptions, volunteer hours, awards", () => {
    const vm = assembleFixture("many-ccas");

    expect(vm.sections.map((s) => s.kind)).toEqual([
      "involvements",
      "ccaDescriptions",
      "volunteerHours",
      "awards",
    ]);
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
    input.memberships = [
      membership({ ccaName: "Old", academicYear: "AY2025/26" }),
      membership({ ccaName: "New" }),
    ];
    input.regularVolunteering = [
      { academicYear: "AY2025/26", ccaName: "Old", hours: 9 },
    ];
    input.awards = [
      { title: "Old award", academicYear: "AY2025/26", citation: null },
    ];

    const vm = assembleTranscript(input, AY);

    expect(section(vm, "involvements")?.rows.map((r) => r.ccaName)).toEqual([
      "New",
    ]);
    expect(vm.hasVolunteerHours).toBe(false);
    expect(vm.hasAwards).toBe(false);
  });

  it("is empty when nothing was recorded for the year", () => {
    const vm = assembleFixture("empty-year");

    expect(vm.isEmpty).toBe(true);
    expect(vm.sections).toEqual([]);
    expect(vm.academicYear).toBe(AY);
  });

  it("is empty when the only records belong to another year", () => {
    const vm = assembleTranscript(fixtureInput("plain-member"), "AY2027/28");

    expect(vm.isEmpty).toBe(true);
  });

  it("is not empty when there are only awards", () => {
    const input = blankInput();
    input.awards = [{ title: "T", academicYear: AY, citation: null }];

    expect(assembleTranscript(input, AY).isEmpty).toBe(false);
  });
});

describe("assembleTranscript: purity", () => {
  it("does not mutate its input", () => {
    const input = fixtureInput("many-ccas");
    const before = structuredClone(input);

    assembleTranscript(input, AY);

    expect(input).toEqual(before);
  });

  it("returns a copy of the resident, not the input object", () => {
    const input = fixtureInput("plain-member");

    const vm = assembleTranscript(input, AY);

    expect(vm.resident).toEqual(input.resident);
    expect(vm.resident).not.toBe(input.resident);
  });
});

describe("formatting helpers", () => {
  it("normalises a verification code to upper case without padding", () => {
    expect(normaliseVerificationCode("  rh-cct-0001 ")).toBe("RH-CCT-0001");
  });

  it("formats an ISO issue date as day, month name, year", () => {
    expect(formatIssuedOn("2027-05-10")).toBe("10 May 2027");
  });
});
