import {
  type AwardRow,
  type CcaDescriptionRow,
  type CcaMembershipInput,
  type InvolvementRow,
  type OneOffVolunteerInput,
  type RegularVolunteerInput,
  type TranscriptInput,
  type TranscriptSection,
  type TranscriptViewModel,
  type VolunteerHoursModel,
} from "./types";

/** Shown in the CCA descriptions section when a CCA has no description yet. */
export const MISSING_DESCRIPTION_TEXT = "Description not yet available.";

/**
 * Builds the view model for one resident and one academic year.
 *
 * PURE: no Prisma, no I/O, and the input is never mutated (every array is
 * copied before it is filtered or sorted). Output order is deterministic:
 * leaders first, then alphabetical by CCA name.
 */
export function assembleTranscript(
  input: TranscriptInput,
  academicYear: string,
): TranscriptViewModel {
  const memberships = input.memberships.filter(
    (m) => m.academicYear === academicYear,
  );
  const regular = input.regularVolunteering.filter(
    (v) => v.academicYear === academicYear,
  );
  const oneOff = input.oneOffVolunteering.filter(
    (v) => v.academicYear === academicYear,
  );
  const awards = input.awards.filter((a) => a.academicYear === academicYear);

  const sortedMemberships = sortMemberships(memberships);
  const volunteer = buildVolunteerHours(regular, oneOff);

  const sections: TranscriptSection[] = [];
  if (sortedMemberships.length > 0) {
    sections.push({
      kind: "involvements",
      rows: sortedMemberships.map(toInvolvementRow),
    });
    sections.push({
      kind: "ccaDescriptions",
      rows: buildDescriptions(sortedMemberships),
    });
  }
  if (volunteer) sections.push({ kind: "volunteerHours", volunteer });
  if (awards.length > 0) {
    sections.push({ kind: "awards", rows: buildAwards(awards) });
  }

  return {
    academicYear,
    resident: { ...input.resident },
    isEmpty: sections.length === 0,
    hasVolunteerHours: volunteer !== null,
    hasAwards: awards.length > 0,
    sections,
  };
}

/** Codes are printed in upper case; a verifier typing one by hand may not. */
export function normaliseVerificationCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** "2026-10-06" -> "6 October 2026". */
export function formatIssuedOn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-SG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------

function cleaned(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compareText(a: string, b: string): number {
  return (
    a.localeCompare(b, "en", { sensitivity: "base" }) ||
    (a < b ? -1 : a > b ? 1 : 0)
  );
}

function sortMemberships(
  memberships: readonly CcaMembershipInput[],
): CcaMembershipInput[] {
  return [...memberships].sort((a, b) => {
    const aLeads = cleaned(a.leadershipRole) !== null;
    const bLeads = cleaned(b.leadershipRole) !== null;
    if (aLeads !== bLeads) return aLeads ? -1 : 1;
    return compareText(a.ccaName, b.ccaName);
  });
}

function toInvolvementRow(m: CcaMembershipInput): InvolvementRow {
  return {
    ccaName: m.ccaName,
    category: m.category,
    role: cleaned(m.leadershipRole),
    extraContribution: cleaned(m.extraContribution),
  };
}

/** Only the resident's own CCAs, alphabetical, each once. */
function buildDescriptions(
  memberships: readonly CcaMembershipInput[],
): CcaDescriptionRow[] {
  const byName = new Map<string, string | null>();
  for (const m of memberships) {
    const description = cleaned(m.description);
    if (
      !byName.has(m.ccaName) ||
      (byName.get(m.ccaName) === null && description)
    ) {
      byName.set(m.ccaName, description);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([ccaName, description]) => ({
      ccaName,
      description: description ?? MISSING_DESCRIPTION_TEXT,
      isMissing: description === null,
    }));
}

/** Rounds away floating-point noise such as 0.1 + 0.2. */
function sumHours(values: readonly number[]): number {
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round(total * 100) / 100;
}

/** Null when the resident has no volunteering at all: the section is omitted. */
function buildVolunteerHours(
  regular: readonly RegularVolunteerInput[],
  oneOff: readonly OneOffVolunteerInput[],
): VolunteerHoursModel | null {
  if (regular.length === 0 && oneOff.length === 0) return null;

  const regularRows = [...regular]
    .sort((a, b) => compareText(a.ccaName, b.ccaName))
    .map((v) => ({ ccaName: v.ccaName, hours: v.hours }));
  const oneOffRows = [...oneOff]
    .sort(
      (a, b) =>
        compareText(a.date, b.date) || compareText(a.eventName, b.eventName),
    )
    .map((v) => ({ eventName: v.eventName, date: v.date, hours: v.hours }));

  const regularSubtotal = sumHours(regularRows.map((r) => r.hours));
  const oneOffSubtotal = sumHours(oneOffRows.map((r) => r.hours));

  return {
    regular: { rows: regularRows, subtotal: regularSubtotal },
    oneOff: { rows: oneOffRows, subtotal: oneOffSubtotal },
    total: sumHours([regularSubtotal, oneOffSubtotal]),
  };
}

function buildAwards(
  awards: readonly TranscriptInput["awards"][number][],
): AwardRow[] {
  return [...awards]
    .sort((a, b) => compareText(a.title, b.title))
    .map((a) => ({
      title: a.title,
      academicYear: a.academicYear,
      citation: cleaned(a.citation),
    }));
}
