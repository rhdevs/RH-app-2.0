/**
 * CCA TRANSCRIPT — SPECIMEN DATA. NOTHING HERE IS REAL.
 *
 * This is the showcase version of the CCA transcript: one fixed, made-up
 * resident, rendered by /transcript and verifiable at /verify/<code>. Every
 * name below is invented and every signature is a script font, not an image of
 * anyone's hand. The pages carry a SPECIMEN watermark for the same reason —
 * the audience is people OUTSIDE the hall, and a fake record that looks
 * official must never be mistakable for one.
 *
 * WHY THE APP CANNOT PRODUCE A REAL ONE YET: `UserCCA` is only {ccaID, userID}
 * — no academic year, no position, no history (leaving deletes the row), and
 * `CcaHead` only says who heads a CCA NOW. A real transcript needs a new
 * collection of past memberships plus a sign-off flow (head → JCRC President →
 * Master), where a "signature" is a recorded approval by an identified account
 * rather than a picture.
 *
 * THE TYPES BELOW ARE SHAPED LIKE THAT FUTURE COLLECTION on purpose, and the
 * pages only ever go through `getTranscriptByCode` / `DEMO_TRANSCRIPT`. Swapping
 * in real data later means replacing this module, not the pages.
 */

export type CommitmentLevel = "High" | "Moderate" | "Light";

export interface Signatory {
  name: string;
  /** e.g. "Captain, Soccer (MALE)" or "JCRC President, AY2025/26". */
  title: string;
}

export interface TranscriptEntry {
  ccaName: string;
  category: string;
  /** "AY2023/24" — the unit a membership is recorded in. */
  academicYear: string;
  position: string;
  commitment: {
    level: CommitmentLevel;
    /** Average over the academic year, as attested by the CCA leader. */
    hoursPerWeek: number;
    /** One line on what the commitment actually consisted of. */
    summary: string;
  };
  /** The CCA leader who signed this entry off — for that year, not today's. */
  certifiedBy: Signatory;
}

export interface Transcript {
  /** Printed on the document and encoded in its QR code. A real one must be
   *  random and unguessable — this is a fixed demo value. */
  verificationCode: string;
  resident: {
    name: string;
    matric: string;
    faculty: string;
  };
  residencyPeriod: string;
  issuedOn: string; // ISO date
  entries: TranscriptEntry[];
  jcrcPresident: Signatory;
  master: Signatory;
  /** Always true here. Real records will carry false, and every page keys its
   *  SPECIMEN treatment off this flag rather than off the route. */
  isSpecimen: boolean;
}

export const DEMO_TRANSCRIPT: Transcript = {
  verificationCode: "RH-CCT-DEMO-7F3K",
  resident: {
    name: "Alex Tan Jun Hao",
    matric: "A0000000X",
    faculty: "College of Design and Engineering",
  },
  residencyPeriod: "AY2023/24 – AY2025/26",
  issuedOn: "2026-10-06",
  isSpecimen: true,
  entries: [
    {
      ccaName: "Soccer (MALE)",
      category: "Sports Activities",
      academicYear: "AY2023/24",
      position: "Member",
      commitment: {
        level: "High",
        hoursPerWeek: 6,
        summary: "Trained twice weekly; represented the hall at Inter-Hall Games.",
      },
      certifiedBy: { name: "Marcus Lim Wei Jie", title: "Captain, Soccer (MALE)" },
    },
    {
      ccaName: "Phoenix Press",
      category: "Media Committees",
      academicYear: "AY2023/24",
      position: "Writer",
      commitment: {
        level: "Light",
        hoursPerWeek: 2,
        summary: "Contributed four features to the hall newsletter.",
      },
      certifiedBy: { name: "Priya Raman", title: "Chief Editor, Phoenix Press" },
    },
    {
      ccaName: "RHMP Sets",
      category: "RHMP",
      academicYear: "AY2023/24",
      position: "Crew",
      commitment: {
        level: "Moderate",
        hoursPerWeek: 4,
        summary: "Built and struck sets for the annual hall musical production.",
      },
      certifiedBy: { name: "Chloe Ng Shu Wen", title: "Head, RHMP Sets" },
    },
    {
      ccaName: "Soccer (MALE)",
      category: "Sports Activities",
      academicYear: "AY2024/25",
      position: "Vice-Captain",
      commitment: {
        level: "High",
        hoursPerWeek: 8,
        summary: "Co-ran training sessions and team selection for IHG.",
      },
      certifiedBy: { name: "Daniel Koh Zhi Wei", title: "Captain, Soccer (MALE)" },
    },
    {
      ccaName: "Welfare Committee",
      category: "Committees",
      academicYear: "AY2024/25",
      position: "Member",
      commitment: {
        level: "Moderate",
        hoursPerWeek: 3,
        summary: "Organised exam-period welfare drives for 600 residents.",
      },
      certifiedBy: { name: "Sarah Chua Hui Min", title: "Chairperson, Welfare Committee" },
    },
    {
      ccaName: "Soccer (MALE)",
      category: "Sports Activities",
      academicYear: "AY2025/26",
      position: "Captain",
      commitment: {
        level: "High",
        hoursPerWeek: 10,
        summary: "Led a 24-player squad; managed training, fixtures and budget.",
      },
      certifiedBy: { name: "Ethan Goh Jia Le", title: "Sports Secretary, JCRC" },
    },
    {
      ccaName: "RH Developers",
      category: "Media Committees",
      academicYear: "AY2025/26",
      position: "Developer",
      commitment: {
        level: "Moderate",
        hoursPerWeek: 5,
        summary: "Built features for the hall's resident web app.",
      },
      certifiedBy: { name: "Rachel Teo Xin Yi", title: "Head, RH Developers" },
    },
  ],
  jcrcPresident: {
    name: "Benjamin Ong Kai Wen",
    title: "President, Junior Common Room Committee",
  },
  master: {
    name: "Prof. Helen Wong",
    title: "Master, Raffles Hall",
  },
};

const SPECIMENS: Transcript[] = [DEMO_TRANSCRIPT];

/** Codes are printed in upper case; a verifier typing one by hand may not. */
export function normaliseVerificationCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * The only lookup the pages use. Returns null for anything that is not an
 * issued code — including malformed input, which never reaches the lookup.
 */
export function getTranscriptByCode(raw: string): Transcript | null {
  const code = normaliseVerificationCode(raw);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return null;
  return SPECIMENS.find((t) => t.verificationCode === code) ?? null;
}

/** Entries grouped by academic year, oldest first, preserving input order. */
export function groupByYear(
  entries: TranscriptEntry[],
): Array<{ academicYear: string; entries: TranscriptEntry[] }> {
  const groups = new Map<string, TranscriptEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.academicYear) ?? [];
    list.push(e);
    groups.set(e.academicYear, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([academicYear, entries]) => ({ academicYear, entries }));
}

export function formatIssuedOn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-SG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
