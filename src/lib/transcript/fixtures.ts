import { normaliseVerificationCode, yearFromParam } from "./assemble";
import {
  type CcaMembershipInput,
  type JcrcServiceInput,
  type ResidentInput,
  type TranscriptInput,
  type YearIssueInput,
} from "./types";

/**
 * TRANSCRIPT SPECIMENS — NOTHING HERE IS REAL.
 *
 * Twelve made-up residents, each shaped to exercise one edge case of the
 * layout. Every name, matric number and verification code is invented, and
 * every resident is flagged `isSpecimen`, which is what puts the SPECIMEN
 * watermark and banner on the pages (not the route). This is the ONLY fixture
 * source: the pages only ever go through the lookups at the bottom, so real
 * data later means replacing this module with a loader, not rewriting the
 * pages.
 *
 * Transcripts start at AY2026/27; there is no backfill. A fixture may list
 * later years too, to show the per-year switch.
 */

export const FIXTURE_ACADEMIC_YEAR = "AY2026/27";
const NEXT_ACADEMIC_YEAR = "AY2027/28";

export interface TranscriptFixture {
  /** URL segment for /transcript/preview/[fixture]. */
  slug: string;
  /** What the fixture is there to exercise. */
  label: string;
  input: TranscriptInput;
}

const AY = FIXTURE_ACADEMIC_YEAR;

function person(name: string, n: number): ResidentInput {
  return {
    name,
    matric: `A${String(n).padStart(4, "0")}000X`,
    isSpecimen: true,
  };
}

function issue(
  n: number,
  overrides: Partial<YearIssueInput> = {},
): YearIssueInput {
  return {
    academicYear: AY,
    verificationCode: `RH-CCT-DEMO-${String(n).padStart(4, "0")}`,
    issuedOn: "2027-05-10",
    block: "Block 3",
    yearOfResidence: 2,
    ...overrides,
  };
}

function cca(
  ccaName: string,
  category: string,
  extra: Partial<CcaMembershipInput> = {},
): CcaMembershipInput {
  return {
    ccaName,
    category,
    academicYear: AY,
    leadershipRole: null,
    description: `${ccaName} is a hall CCA in the ${category} category.`,
    extraContribution: null,
    ...extra,
  };
}

function input(
  resident: ResidentInput,
  issues: YearIssueInput[],
  parts: Partial<Omit<TranscriptInput, "resident" | "issues">> = {},
): TranscriptInput {
  return {
    resident,
    issues,
    memberships: [],
    regularVolunteering: [],
    oneOffVolunteering: [],
    awards: [],
    jcrc: null,
    ...parts,
  };
}

const SPORTS_SECRETARY: JcrcServiceInput = {
  portfolio: "Sports",
  position: "Secretary",
  term: AY,
  description:
    "Responsible for the inter-hall sports programme and for supporting the hall's sports CCAs, including their captains, fixtures and resources.",
  contributions: [
    "Ran the inter-hall sports calendar across 11 sports and 40 matches.",
    "Introduced a shared fixtures calendar adopted by all sports CCAs.",
    "Coordinated transport and refereeing for the hall's home matches.",
    "Led the review of sports CCA budgets with the JCRC Treasurer.",
  ],
  testimonial: {
    text: "This member approached the sports portfolio with care and consistency. They built a calendar that residents could rely on, and kept every CCA captain informed throughout the year. I am glad to recommend them.",
    author: "Hall Master",
  },
  isPlaceholder: true,
};

const MANY_CCAS: CcaMembershipInput[] = [
  cca("Badminton (MALE)", "Sports Activities", {
    leadershipRole: "Vice-Captain",
  }),
  cca("Basketball (MALE)", "Sports Activities"),
  cca("Chess Club", "Interest Groups"),
  cca("Dance Crew", "Performing Arts"),
  cca("Debate Society", "Interest Groups", { description: null }),
  cca("Floorball (MALE)", "Sports Activities"),
  cca("Hall Choir", "Performing Arts", {
    extraContribution: "Arranged two pieces for the annual hall concert.",
  }),
  cca("Orientation Welfare", "Committees"),
  cca("Photography Club", "Media Committees", { description: null }),
  cca("Phoenix Press", "Media Committees"),
  cca("RHMP Sets", "RHMP", {
    extraContribution:
      "Designed and led construction of the revolving stage for the annual hall musical.",
  }),
  cca("Swimming (MIXED)", "Sports Activities"),
  cca("Table Tennis (MALE)", "Sports Activities"),
  cca("Volleyball (MALE)", "Sports Activities"),
];

export const TRANSCRIPT_FIXTURES: readonly TranscriptFixture[] = [
  {
    slug: "plain-member",
    label: "Plain member of one CCA",
    input: input(person("Lim Wei Xiang", 1), [issue(1)], {
      memberships: [cca("Phoenix Press", "Media Committees")],
    }),
  },
  {
    slug: "cca-head",
    label: "CCA head",
    input: input(person("Priya Nair", 2), [issue(2)], {
      memberships: [
        cca("Soccer (MALE)", "Sports Activities", {
          leadershipRole: "Captain",
        }),
      ],
    }),
  },
  {
    slug: "additional-contribution",
    label: "Member with an additional contribution",
    input: input(person("Chloe Ong Mei Ling", 3), [issue(3)], {
      memberships: [
        cca("RHMP Sets", "RHMP", {
          extraContribution:
            "Built the main set piece for the annual hall musical and trained five new crew members.",
        }),
      ],
    }),
  },
  {
    slug: "missing-description",
    label: "CCA with no description",
    input: input(person("Daniel Teo Jia Hao", 4), [issue(4)], {
      memberships: [
        cca("Hall Orchestra", "Performing Arts", { description: null }),
        cca("Welfare Committee", "Committees"),
      ],
    }),
  },
  {
    slug: "no-volunteering",
    label: "No volunteering recorded",
    input: input(person("Aisha Binte Rahman", 5), [issue(5)], {
      memberships: [cca("Dance Crew", "Performing Arts")],
      awards: [
        { title: "Outstanding Newcomer", academicYear: AY, citation: null },
      ],
    }),
  },
  {
    slug: "volunteering",
    label: "Regular and one-off volunteering",
    input: input(person("Marcus Goh Yi Xuan", 6), [issue(6)], {
      memberships: [
        cca("Welfare Committee", "Committees"),
        cca("Hall Choir", "Performing Arts"),
      ],
      regularVolunteering: [
        {
          academicYear: AY,
          ccaName: "Welfare Committee",
          activity: "Weekly tuition for neighbourhood children",
          hours: 32.5,
        },
        {
          academicYear: AY,
          ccaName: "Hall Choir",
          activity: "Monthly performances at a nursing home",
          hours: 12,
        },
      ],
      oneOffVolunteering: [
        {
          academicYear: AY,
          eventName: "Freshmen Orientation helper",
          organiser: "Hall committee",
          date: "2026-08-12",
          hours: 6,
        },
        {
          academicYear: AY,
          eventName: "Hall Open House",
          organiser: "Hall committee",
          date: "2027-01-23",
          hours: 4.5,
        },
      ],
    }),
  },
  {
    slug: "awards",
    label: "With Colours Awards",
    input: input(person("Sarah Chua Hui Min", 7), [issue(7)], {
      memberships: [
        cca("Swimming (MIXED)", "Sports Activities", {
          leadershipRole: "Head",
        }),
      ],
      awards: [
        {
          title: "Colours Award for Sports",
          academicYear: AY,
          citation:
            "For leading the hall swimming team to a podium finish at Inter-Hall Games.",
        },
        { title: "Service Excellence Award", academicYear: AY, citation: null },
      ],
    }),
  },
  {
    slug: "many-ccas",
    label: "Member of 14 CCAs (multi-page)",
    input: input(person("Ethan Koh Zhi Wei", 8), [issue(8)], {
      memberships: MANY_CCAS,
      regularVolunteering: [
        {
          academicYear: AY,
          ccaName: "Orientation Welfare",
          activity: "Freshman buddy programme",
          hours: 40,
        },
        {
          academicYear: AY,
          ccaName: "Hall Choir",
          activity: "Monthly performances at a nursing home",
          hours: 15,
        },
        {
          academicYear: AY,
          ccaName: "Phoenix Press",
          activity: "Weekly reading sessions at a children's library",
          hours: 10,
        },
      ],
      oneOffVolunteering: [
        {
          academicYear: AY,
          eventName: "Freshmen Orientation helper",
          organiser: "Hall committee",
          date: "2026-08-12",
          hours: 6,
        },
        {
          academicYear: AY,
          eventName: "Blood Donation Drive",
          organiser: "Orientation Welfare",
          date: "2026-10-03",
          hours: 3,
        },
        {
          academicYear: AY,
          eventName: "Hall Open House",
          organiser: "Hall committee",
          date: "2027-01-23",
          hours: 4.5,
        },
      ],
      awards: [
        { title: "Service Excellence Award", academicYear: AY, citation: null },
      ],
    }),
  },
  {
    slug: "empty-year",
    label: "Nothing recorded for the year",
    input: input(person("Natalie Tan Shu Min", 9), [issue(9)]),
  },
  {
    slug: "leader-and-member",
    label: "Leader of one CCA, member of another",
    input: input(person("Rahul Menon", 10), [issue(10)], {
      memberships: [
        cca("Badminton (MALE)", "Sports Activities"),
        cca("RH Developers", "Media Committees", { leadershipRole: "Head" }),
      ],
    }),
  },
  {
    slug: "jcrc-sports-secretary",
    label: "JCRC Sports Secretary, CCA head and 4 other CCAs (two years)",
    input: input(
      person("Tan Wei Ming", 11),
      [
        issue(11, { yearOfResidence: 1 }),
        issue(11, {
          academicYear: NEXT_ACADEMIC_YEAR,
          verificationCode: "RH-CCT-DEMO-0011-2728",
          issuedOn: "2028-05-09",
        }),
      ],
      {
        // The JCRC term is the later year, so that is the one shown by default.
        jcrc: { ...SPORTS_SECRETARY, term: NEXT_ACADEMIC_YEAR },
        memberships: [
          cca("Soccer (MALE)", "Sports Activities"),
          cca("RH Welfare", "Committees", { description: null }),
          cca("Raffles Hall Dance", "Performing Arts", {
            academicYear: NEXT_ACADEMIC_YEAR,
            leadershipRole: "Head",
            extraContribution:
              "Choreographed and directed the Hall Night finale.",
          }),
          cca("Hall Orientation Committee", "Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
          }),
          cca("Soccer (MALE)", "Sports Activities", {
            academicYear: NEXT_ACADEMIC_YEAR,
          }),
          cca("RH Welfare", "Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
            description: null,
          }),
          cca("Raffles Hall Photography", "Media Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
            description: null,
          }),
        ],
        regularVolunteering: [
          {
            academicYear: NEXT_ACADEMIC_YEAR,
            ccaName: "RH Welfare",
            activity: "Weekly tuition for neighbourhood children",
            hours: 42,
          },
        ],
        oneOffVolunteering: [
          {
            academicYear: NEXT_ACADEMIC_YEAR,
            eventName: "Beach clean-up, East Coast Park",
            organiser: "RH Welfare",
            date: "2027-09-12",
            hours: 4,
          },
          {
            academicYear: NEXT_ACADEMIC_YEAR,
            eventName: "Blood drive support crew",
            organiser: "Hall committee",
            date: "2027-10-03",
            hours: 6,
          },
        ],
        awards: [
          {
            title: "Colours Award, Dance",
            academicYear: NEXT_ACADEMIC_YEAR,
            citation: null,
          },
          {
            title: "Outstanding Service Award",
            academicYear: NEXT_ACADEMIC_YEAR,
            citation: null,
          },
        ],
      },
    ),
  },
  {
    slug: "jcrc-only",
    label: "JCRC member with no other CCAs or volunteering",
    input: input(person("Grace Lee Min Hui", 12), [issue(12)], {
      jcrc: {
        ...SPORTS_SECRETARY,
        portfolio: "Welfare",
        position: "Member",
        description:
          "Supports the JCRC Welfare Secretary in running residents' welfare programmes.",
        contributions: [
          "Helped plan and run the exam-period welfare drives.",
          "Served as the point of contact for residents' feedback to the JCRC.",
        ],
      },
    }),
  },
];

export function getFixtureBySlug(slug: string): TranscriptFixture | null {
  return TRANSCRIPT_FIXTURES.find((f) => f.slug === slug) ?? null;
}

/** Academic years a transcript was issued for, oldest first. */
export function getFixtureYears(fixture: TranscriptFixture): string[] {
  return fixture.input.issues.map((i) => i.academicYear).sort();
}

/**
 * The academic year a page should show: the latest when none is asked for,
 * else the requested one (`2026-27` or `AY2026/27`). Null for a year with no
 * issued transcript.
 */
export function resolveFixtureYear(
  fixture: TranscriptFixture,
  param: string | undefined,
): string | null {
  const years = getFixtureYears(fixture);
  if (!param) return years[years.length - 1] ?? null;
  const wanted = yearFromParam(param);
  return years.includes(wanted) ? wanted : null;
}

/**
 * The only code lookup the /verify pages use: every transcript has its own
 * code, so a code names one resident AND one academic year. Returns null for
 * anything that is not a specimen code, including malformed input, which never
 * reaches the lookup.
 */
export function getFixtureByCode(
  raw: string,
): { fixture: TranscriptFixture; academicYear: string } | null {
  const code = normaliseVerificationCode(raw);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return null;
  for (const fixture of TRANSCRIPT_FIXTURES) {
    const found = fixture.input.issues.find((i) => i.verificationCode === code);
    if (found) return { fixture, academicYear: found.academicYear };
  }
  return null;
}
