import { normaliseVerificationCode } from "./assemble";
import {
  type CcaMembershipInput,
  type ResidentInput,
  type TranscriptInput,
} from "./types";

/**
 * TRANSCRIPT SPECIMENS — NOTHING HERE IS REAL.
 *
 * Ten made-up residents, each shaped to exercise one edge case of the layout.
 * Every name, matric number and verification code is invented, and every
 * resident is flagged `isSpecimen`, which is what puts the SPECIMEN watermark
 * and banner on the pages (not the route). The pages only ever go through
 * `getFixtureBySlug` / `getFixtureByCode`, so swapping in real data later
 * means replacing this module with a loader, not rewriting the pages.
 *
 * Transcripts start at AY2026/27; there is no backfill.
 */

export const FIXTURE_ACADEMIC_YEAR = "AY2026/27";

export interface TranscriptFixture {
  /** URL segment for /transcript/preview/[fixture]. */
  slug: string;
  /** What the fixture is there to exercise. */
  label: string;
  academicYear: string;
  input: TranscriptInput;
}

const AY = FIXTURE_ACADEMIC_YEAR;

function resident(
  n: number,
  name: string,
  faculty: string | null,
): ResidentInput {
  const id = String(n).padStart(4, "0");
  return {
    name,
    matric: `A${id}000X`,
    faculty,
    verificationCode: `RH-CCT-DEMO-${id}`,
    issuedOn: "2027-05-10",
    isSpecimen: true,
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
  who: ResidentInput,
  parts: Partial<Omit<TranscriptInput, "resident">> = {},
): TranscriptInput {
  return {
    resident: who,
    memberships: [],
    regularVolunteering: [],
    oneOffVolunteering: [],
    awards: [],
    ...parts,
  };
}

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
    academicYear: AY,
    input: input(resident(1, "Lim Wei Xiang", "Faculty of Science"), {
      memberships: [cca("Phoenix Press", "Media Committees")],
    }),
  },
  {
    slug: "cca-head",
    label: "CCA head",
    academicYear: AY,
    input: input(resident(2, "Priya Nair", "School of Computing"), {
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
    academicYear: AY,
    input: input(
      resident(3, "Chloe Ong Mei Ling", "Faculty of Arts and Social Sciences"),
      {
        memberships: [
          cca("RHMP Sets", "RHMP", {
            extraContribution:
              "Built the main set piece for the annual hall musical and trained five new crew members.",
          }),
        ],
      },
    ),
  },
  {
    slug: "missing-description",
    label: "CCA with no description",
    academicYear: AY,
    input: input(
      resident(4, "Daniel Teo Jia Hao", "College of Design and Engineering"),
      {
        memberships: [
          cca("Hall Orchestra", "Performing Arts", { description: null }),
          cca("Welfare Committee", "Committees"),
        ],
      },
    ),
  },
  {
    slug: "no-volunteering",
    label: "No volunteering recorded",
    academicYear: AY,
    input: input(resident(5, "Aisha Binte Rahman", "NUS Business School"), {
      memberships: [cca("Dance Crew", "Performing Arts")],
      awards: [
        {
          title: "Outstanding Newcomer",
          academicYear: AY,
          citation: null,
        },
      ],
    }),
  },
  {
    slug: "volunteering",
    label: "Regular and one-off volunteering",
    academicYear: AY,
    input: input(resident(6, "Marcus Goh Yi Xuan", "Faculty of Law"), {
      memberships: [
        cca("Welfare Committee", "Committees"),
        cca("Hall Choir", "Performing Arts"),
      ],
      regularVolunteering: [
        { academicYear: AY, ccaName: "Welfare Committee", hours: 32.5 },
        { academicYear: AY, ccaName: "Hall Choir", hours: 12 },
      ],
      oneOffVolunteering: [
        {
          academicYear: AY,
          eventName: "Freshmen Orientation helper",
          date: "2026-08-12",
          hours: 6,
        },
        {
          academicYear: AY,
          eventName: "Hall Open House",
          date: "2027-01-23",
          hours: 4.5,
        },
      ],
    }),
  },
  {
    slug: "awards",
    label: "With Colours Awards",
    academicYear: AY,
    input: input(
      resident(7, "Sarah Chua Hui Min", "Yong Loo Lin School of Medicine"),
      {
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
          {
            title: "Service Excellence Award",
            academicYear: AY,
            citation: null,
          },
        ],
      },
    ),
  },
  {
    slug: "many-ccas",
    label: "Member of 14 CCAs (multi-page)",
    academicYear: AY,
    input: input(
      resident(8, "Ethan Koh Zhi Wei", "College of Humanities and Sciences"),
      {
        memberships: MANY_CCAS,
        regularVolunteering: [
          { academicYear: AY, ccaName: "Orientation Welfare", hours: 40 },
          { academicYear: AY, ccaName: "Hall Choir", hours: 15 },
          { academicYear: AY, ccaName: "Phoenix Press", hours: 10 },
        ],
        oneOffVolunteering: [
          {
            academicYear: AY,
            eventName: "Freshmen Orientation helper",
            date: "2026-08-12",
            hours: 6,
          },
          {
            academicYear: AY,
            eventName: "Blood Donation Drive",
            date: "2026-10-03",
            hours: 3,
          },
          {
            academicYear: AY,
            eventName: "Hall Open House",
            date: "2027-01-23",
            hours: 4.5,
          },
        ],
        awards: [
          {
            title: "Service Excellence Award",
            academicYear: AY,
            citation: null,
          },
        ],
      },
    ),
  },
  {
    slug: "empty-year",
    label: "Nothing recorded for the year",
    academicYear: AY,
    input: input(resident(9, "Natalie Tan Shu Min", null)),
  },
  {
    slug: "leader-and-member",
    label: "Leader of one CCA, member of another",
    academicYear: AY,
    input: input(resident(10, "Rahul Menon", "School of Computing"), {
      memberships: [
        cca("Badminton (MALE)", "Sports Activities"),
        cca("RH Developers", "Media Committees", { leadershipRole: "Head" }),
      ],
    }),
  },
];

export function getFixtureBySlug(slug: string): TranscriptFixture | null {
  return TRANSCRIPT_FIXTURES.find((f) => f.slug === slug) ?? null;
}

/**
 * The only code lookup the /verify pages use. Returns null for anything that
 * is not a specimen code, including malformed input, which never reaches the
 * lookup.
 */
export function getFixtureByCode(raw: string): TranscriptFixture | null {
  const code = normaliseVerificationCode(raw);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return null;
  return (
    TRANSCRIPT_FIXTURES.find(
      (f) => f.input.resident.verificationCode === code,
    ) ?? null
  );
}
