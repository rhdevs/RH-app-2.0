/**
 * CCA TRANSCRIPT — SPECIMEN DATA. NOTHING HERE IS REAL.
 *
 * ONE TRANSCRIPT PER ACADEMIC YEAR. Hall life is recorded and judged a year at
 * a time (readmission, CCA points, JCRC terms all turn over each AY), so each
 * year is its own document with its own verification code — a resident hands
 * over the year that is asked for, not their whole history.
 *
 * Every name below is invented. The pages carry a SPECIMEN watermark because
 * the audience is people OUTSIDE the hall, and a made-up record that looks
 * official must never be mistakable for one.
 *
 * DELIBERATELY ABSENT, after review:
 *  - Faculty. The app does not hold it, and joint programmes (Computer
 *    Engineering is CDE *and* SoC) have no single honest answer. The degree is
 *    the NUS transcript's job; this one shows Block, which the hall owns.
 *  - Commitment level / hours. Not something a head can attest consistently
 *    across CCAs, so it would read as a grade without being one.
 *  - Signatures. The record is issued electronically and proven by its
 *    verification code, like the NUS e-transcript. The real version records
 *    each head's sign-off as an approval by an identified account — it is
 *    evidence held by the hall, not ink printed on the page.
 *
 * THE TYPES ARE SHAPED LIKE THE FUTURE COLLECTION, and the pages only go
 * through `getTranscriptByCode` / `getYearsForResident` /
 * `getTranscriptForYear`. Making it real means replacing this module's data
 * source, not the pages.
 */

export type Semester = 1 | 2;

export interface CcaRow {
  cca: string;
  /** The CCA's category as the app already stores it (Cca.category). */
  category: string;
  position: string;
  semesters: Semester[];
}

/**
 * A JCRC appointment — the only thing this record calls leadership. A CCA's
 * own exco roles (Captain, Head, …) are a `position` under CCA Participation,
 * and every hall committee is a CCA, so nothing is listed twice.
 */
export interface LeadershipRow {
  appointment: string;
  semesters: Semester[];
}

/** The special-subsection: only printed when there is something to put in it. */
export interface AchievementRow {
  title: string;
  detail: string;
  month: string;
}

export interface YearTranscript {
  /** Printed on the document and encoded in its QR code. A real one must be
   *  random and unguessable — these are fixed demo values. */
  verificationCode: string;
  /** "AY2025/26" */
  academicYear: string;
  /** 1 for a resident's first year in hall, 2 for their second, … */
  yearOfResidence: number;
  resident: {
    name: string;
    matric: string;
    block: string;
  };
  issuedOn: string; // ISO date
  leadership: LeadershipRow[];
  ccas: CcaRow[];
  achievements: AchievementRow[];
  /** Always true here. Real records carry false, and every page keys its
   *  SPECIMEN treatment off this flag rather than off the route. */
  isSpecimen: boolean;
}

const RESIDENT = {
  name: "Alex Tan Jun Hao",
  matric: "A0000000X",
  block: "Block 3",
};

const SPECIMENS: YearTranscript[] = [
  {
    verificationCode: "RH-CCT-DEMO-2324",
    academicYear: "AY2023/24",
    yearOfResidence: 1,
    resident: { ...RESIDENT, block: "Block 5" },
    issuedOn: "2024-05-10",
    isSpecimen: true,
    leadership: [],
    ccas: [
      {
        cca: "Soccer (MALE)",
        category: "Sports Activities",
        position: "Member",
        semesters: [1, 2],
      },
      {
        cca: "Phoenix Press",
        category: "Media Committees",
        position: "Writer",
        semesters: [1, 2],
      },
      { cca: "RHMP Sets", category: "RHMP", position: "Crew", semesters: [2] },
    ],
    achievements: [],
  },
  {
    verificationCode: "RH-CCT-DEMO-2425",
    academicYear: "AY2024/25",
    yearOfResidence: 2,
    resident: RESIDENT,
    issuedOn: "2025-05-09",
    isSpecimen: true,
    leadership: [],
    ccas: [
      {
        cca: "Soccer (MALE)",
        category: "Sports Activities",
        position: "Vice-Captain",
        semesters: [1, 2],
      },
      {
        cca: "Welfare Committee",
        category: "Committees",
        position: "Member",
        semesters: [1, 2],
      },
      {
        cca: "Phoenix Press",
        category: "Media Committees",
        position: "Writer",
        semesters: [1],
      },
    ],
    achievements: [
      {
        title: "Inter-Hall Games 2025",
        detail: "Soccer (Men) — 2nd Runner-Up",
        month: "Feb 2025",
      },
    ],
  },
  {
    verificationCode: "RH-CCT-DEMO-2526",
    academicYear: "AY2025/26",
    yearOfResidence: 3,
    resident: RESIDENT,
    issuedOn: "2026-05-08",
    isSpecimen: true,
    leadership: [{ appointment: "Sports Secretary", semesters: [1, 2] }],
    ccas: [
      {
        cca: "Soccer (MALE)",
        category: "Sports Activities",
        position: "Captain",
        semesters: [1, 2],
      },
      {
        cca: "RH Developers",
        category: "Media Committees",
        position: "Developer",
        semesters: [1, 2],
      },
    ],
    achievements: [
      {
        title: "Inter-Hall Games 2026",
        detail: "Soccer (Men) — Champions",
        month: "Feb 2026",
      },
      {
        title: "Raffles Hall Colours Award",
        detail: "Awarded for sustained contribution to hall sports",
        month: "Apr 2026",
      },
    ],
  },
];

/** The year shown when none is asked for: the latest one issued. */
export const DEFAULT_SPECIMEN = SPECIMENS[SPECIMENS.length - 1]!;

/** Codes are printed in upper case; a verifier typing one by hand may not. */
export function normaliseVerificationCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * The verifier's lookup. Returns null for anything that is not an issued code
 * — including malformed input, which never reaches the lookup.
 */
export function getTranscriptByCode(raw: string): YearTranscript | null {
  const code = normaliseVerificationCode(raw);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return null;
  return SPECIMENS.find((t) => t.verificationCode === code) ?? null;
}

/** Academic years a transcript exists for, oldest first. */
export function getYearsForResident(): string[] {
  return SPECIMENS.map((t) => t.academicYear);
}

/** "AY2025/26" or the URL form "2025-26". Unknown years → null. */
export function getTranscriptForYear(
  year: string | undefined,
): YearTranscript | null {
  if (!year) return DEFAULT_SPECIMEN;
  const ay = yearFromParam(year);
  return SPECIMENS.find((t) => t.academicYear === ay) ?? null;
}

/** "AY2025/26" → "2025-26", for a query string that needs no escaping. */
export function yearToParam(academicYear: string): string {
  return academicYear.replace(/^AY/, "").replace("/", "-");
}

function yearFromParam(param: string): string {
  return param.startsWith("AY") ? param : `AY${param.replace("-", "/")}`;
}

/** "AY2025/26" → "Academic Year 2025/2026", as an official heading reads. */
export function formatAcademicYear(academicYear: string): string {
  const m = /^AY(\d{4})\/(\d{2})$/.exec(academicYear);
  if (!m) return academicYear;
  return `Academic Year ${m[1]}/${m[1]!.slice(0, 2)}${m[2]}`;
}

export function formatSemesters(semesters: Semester[]): string {
  if (semesters.length === 2) return "Sem 1 & 2";
  return `Sem ${semesters[0]}`;
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
export function formatYearOfResidence(n: number): string {
  return `${ORDINALS[n - 1] ?? `${n}th`} year`;
}

export function formatIssuedOn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-SG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
