import { yearFromParam } from "./assemble";
import {
  type ActivityInput,
  type CcaMembershipInput,
  type JcrcServiceInput,
  type ResidentInput,
  type TranscriptInput,
  type VolunteerActivityInput,
  type YearIssueInput,
} from "./types";

/**
 * TRANSCRIPT SPECIMENS — NOTHING HERE IS REAL.
 *
 * Fourteen made-up residents, each shaped to exercise one edge case of the
 * layout. Every name and matric number is invented, and
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
    issuedOn: "2027-05-10",
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

function activity(
  ccaName: string,
  title: string,
  extra: Partial<ActivityInput> = {},
): ActivityInput {
  return {
    academicYear: AY,
    ccaName,
    title,
    description: null,
    period: "full",
    role: null,
    personDescription: null,
    isMember: true,
    ...extra,
  };
}

function volunteer(
  ccaName: string,
  title: string,
  kind: "regular" | "oneoff",
  hours: number,
  academicYear: string = AY,
): VolunteerActivityInput {
  return { academicYear, title, kind, ccaName, hours };
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
    volunteering: [],
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
    {
      activity: "Inter-hall sports calendar",
      role: "Organiser",
      description: "Ran the calendar across 11 sports and 40 matches.",
    },
    {
      activity: "Shared fixtures calendar",
      role: "Lead",
      description: "Introduced a calendar adopted by all sports CCAs.",
    },
    {
      activity: "Home match logistics",
      role: "Coordinator",
      description:
        "Coordinated transport and refereeing for the hall's home matches.",
    },
    {
      activity: "Sports CCA budget review",
      role: "",
      description:
        "Led the review of sports CCA budgets with the JCRC Treasurer.",
    },
  ],
  testimonial: {
    text: "This member approached the sports portfolio with care and consistency. They built a calendar that residents could rely on, and kept every CCA captain informed throughout the year. I am glad to recommend them.",
  },
  isPlaceholder: true,
};

const MANY_CCAS_BASE: CcaMembershipInput[] = [
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

/**
 * Every CCA carries an additional contribution, so page 1 is long enough to
 * run onto a second printed page and exercise the page breaks.
 */
const MANY_CCAS: CcaMembershipInput[] = MANY_CCAS_BASE.map((m) =>
  m.extraContribution
    ? m
    : {
        ...m,
        extraContribution: `Took on extra duties for ${m.ccaName} through the year, supporting its events, welcoming new members and keeping its records up to date.`,
      },
);

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
      volunteering: [
        volunteer(
          "Welfare Committee",
          "Weekly tuition for neighbourhood children",
          "regular",
          32.5,
        ),
        volunteer(
          "Hall Choir",
          "Monthly performances at a nursing home",
          "regular",
          12,
        ),
        volunteer("Hall committee", "Freshmen Orientation helper", "oneoff", 6),
        volunteer("Hall committee", "Hall Open House", "oneoff", 4.5),
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
      volunteering: [
        volunteer(
          "Orientation Welfare",
          "Freshman buddy programme",
          "regular",
          40,
        ),
        volunteer(
          "Hall Choir",
          "Monthly performances at a nursing home",
          "regular",
          15,
        ),
        volunteer(
          "Phoenix Press",
          "Weekly reading sessions at a children's library",
          "regular",
          10,
        ),
        volunteer("Hall committee", "Freshmen Orientation helper", "oneoff", 6),
        volunteer("Orientation Welfare", "Blood Donation Drive", "oneoff", 3),
        volunteer("Hall committee", "Hall Open House", "oneoff", 4.5),
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
        issue(11),
        issue(11, {
          academicYear: NEXT_ACADEMIC_YEAR,
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
            roleDuration: "sem2", // took over the committee in semester 2
            extraContribution:
              "Choreographed and directed the Hall Night finale.",
          }),
          cca("Hall Orientation Committee", "Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
            duration: "sem1", // orientation runs in semester 1 only
          }),
          cca("Soccer (MALE)", "Sports Activities", {
            academicYear: NEXT_ACADEMIC_YEAR,
          }),
          cca("RH Welfare", "Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
            description: null,
            duration: "sem2", // joined in semester 2
          }),
          cca("Raffles Hall Photography", "Media Committees", {
            academicYear: NEXT_ACADEMIC_YEAR,
            description: null,
          }),
        ],
        volunteering: [
          volunteer(
            "RH Welfare",
            "Weekly tuition for neighbourhood children",
            "regular",
            42,
            NEXT_ACADEMIC_YEAR,
          ),
          volunteer(
            "RH Welfare",
            "Beach clean-up, East Coast Park",
            "oneoff",
            4,
            NEXT_ACADEMIC_YEAR,
          ),
          volunteer(
            "Hall committee",
            "Blood drive support crew",
            "oneoff",
            6,
            NEXT_ACADEMIC_YEAR,
          ),
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
          {
            activity: "Exam-period welfare drives",
            role: "Helper",
            description: "Helped plan and run the drives.",
          },
          {
            activity: "Residents' feedback",
            role: "",
            description:
              "Served as the point of contact for feedback to the JCRC.",
          },
        ],
      },
    }),
  },
  {
    slug: "member-with-activities",
    label:
      "Member with CCA activities, an additional contribution and one other involvement",
    input: input(person("Nur Aisyah Binte Salleh", 13), [issue(13)], {
      memberships: [
        cca("Hall Choir", "Performing Arts", {
          extraContribution: "Arranged two pieces for the annual hall concert.",
        }),
        cca("Phoenix Press", "Media Committees"),
      ],
      activities: [
        activity("Hall Choir", "Annual hall concert", {
          description:
            "The hall's annual evening of choral music, performed for residents and guests.",
          role: "Soloist",
          personDescription:
            "Sang the opening solo and rehearsed the altos each week.",
        }),
        activity("Hall Choir", "Carolling at a nursing home", {
          description:
            "A December visit to sing carols for the home's residents.",
        }),
        activity("Hall Choir", "Choir retreat", {
          description: "A weekend of rehearsal and bonding for new members.",
          period: "sem2",
          role: "Logistics",
        }),
        activity("RH Welfare", "Exam-period care packs", {
          description:
            "Assembled and handed out snack packs to residents during exams.",
          role: "Packer",
          isMember: false,
        }),
      ],
    }),
  },
  {
    slug: "other-involvement-only",
    label: "Only other involvement: no CCA membership recorded",
    input: input(person("Jonathan Pereira", 14), [issue(14)], {
      activities: [
        activity("RH Welfare", "Exam-period care packs", {
          description:
            "Assembled and handed out snack packs to residents during exams.",
          role: "Packer",
          isMember: false,
        }),
        activity("Hall Orchestra", "Hall Night pit band", {
          description: "The live band for the hall's annual variety show.",
          period: "sem1",
          personDescription: "Covered a vacant violin part at short notice.",
          isMember: false,
        }),
      ],
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
