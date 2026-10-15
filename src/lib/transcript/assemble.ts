import {
  type AwardRow,
  type CcaMembershipInput,
  type InvolvementRow,
  type JcrcPageModel,
  type JcrcServiceInput,
  type NoteRow,
  type OneOffVolunteerInput,
  type RegularVolunteerInput,
  type TranscriptInput,
  type TranscriptPage,
  type TranscriptSection,
  type TranscriptViewModel,
  type VolunteerHoursModel,
} from "./types";
import { durationLabel } from "./duration";

/** Shown in the Explanatory notes when a CCA has no description yet. */
export const MISSING_DESCRIPTION_TEXT = "Description not yet available.";

/** Static text on the JCRC page. */
export const JCRC_ABOUT_TEXT =
  "The JCRC is the elected student committee that leads Raffles Hall and represents its residents. Its members run hall-wide programmes, oversee CCAs within their portfolios, and work with hall management.";

const JCRC_NOTE_TITLE = "JCRC (Junior Common Room Committee)";
const JCRC_NOTE_TEXT =
  "the elected student committee that leads the hall. See the Junior Common Room Committee page for a full account of this role.";

/**
 * Builds the view model for one resident and one academic year.
 *
 * PURE: no Prisma, no I/O, and the input is never mutated (every array is
 * copied before it is filtered or sorted). Output order is deterministic:
 * leaders first, then alphabetical by CCA name, with the JCRC appointment
 * above them all.
 *
 * Throws a RangeError when no transcript was issued for `academicYear`: the
 * pages only ever ask for years listed in `input.issues`.
 */
export function assembleTranscript(
  input: TranscriptInput,
  academicYear: string,
): TranscriptViewModel {
  const issue = input.issues.find((i) => i.academicYear === academicYear);
  if (!issue) {
    throw new RangeError(`No transcript was issued for ${academicYear}`);
  }

  const memberships = dedupeMemberships(
    sortMemberships(
      input.memberships.filter((m) => m.academicYear === academicYear),
    ),
  );
  const regular = input.regularVolunteering.filter(
    (v) => v.academicYear === academicYear,
  );
  const oneOff = input.oneOffVolunteering.filter(
    (v) => v.academicYear === academicYear,
  );
  const awards = input.awards.filter((a) => a.academicYear === academicYear);
  const jcrc = input.jcrc?.term === academicYear ? input.jcrc : null;

  const involvements = buildInvolvements(memberships, jcrc, academicYear);
  const volunteer = buildVolunteerHours(regular, oneOff);
  const awardRows = buildAwards(awards);

  const sections: TranscriptSection[] = [];
  if (involvements.length > 0) {
    sections.push({ kind: "involvements", rows: involvements });
  }
  if (volunteer) sections.push({ kind: "volunteerHours", volunteer });
  if (awardRows.length > 0) sections.push({ kind: "awards", rows: awardRows });

  const pages: TranscriptPage[] = [{ kind: "main", sections }];
  if (jcrc) pages.push({ kind: "jcrc", jcrc: toJcrcPage(jcrc) });
  pages.push({ kind: "notes", notes: buildNotes(involvements, memberships) });

  return {
    academicYear,
    resident: { ...input.resident },
    issue: { ...issue },
    isEmpty: sections.length === 0,
    hasVolunteerHours: volunteer !== null,
    hasAwards: awardRows.length > 0,
    hasJcrc: jcrc !== null,
    pages,
  };
}

/** "2026-10-06" -> "06/10/2026". */
export function formatIssuedOn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "AY2025/26" -> "2025-26", for a query string that needs no escaping. */
export function yearToParam(academicYear: string): string {
  return academicYear.replace(/^AY/, "").replace("/", "-");
}

/** "2025-26" or "AY2025/26" -> "AY2025/26". */
export function yearFromParam(param: string): string {
  return param.startsWith("AY") ? param : `AY${param.replace("-", "/")}`;
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

/**
 * One row per CCA. A CCA recorded twice keeps its first (leadership-first)
 * entry, but borrows a description or contribution the first one lacks.
 */
function dedupeMemberships(
  sorted: readonly CcaMembershipInput[],
): CcaMembershipInput[] {
  const byName = new Map<string, CcaMembershipInput>();
  for (const m of sorted) {
    const seen = byName.get(m.ccaName);
    if (!seen) {
      byName.set(m.ccaName, m);
      continue;
    }
    byName.set(m.ccaName, {
      ...seen,
      description: cleaned(seen.description) ?? m.description,
      extraContribution: cleaned(seen.extraContribution) ?? m.extraContribution,
    });
  }
  return [...byName.values()];
}

/**
 * Appends the duration only when it is not a full year: "2026/27 (Semester 2)",
 * "Head (Semester 2)". A missing value or "full" prints nothing extra.
 */
function withDuration(
  text: string | null,
  duration: string | null | undefined,
): string | null {
  const label = durationLabel(duration);
  return text && label ? `${text} (${label})` : text;
}

function shortYear(academicYear: string): string {
  return academicYear.replace(/^AY/, "");
}

function buildInvolvements(
  memberships: readonly CcaMembershipInput[],
  jcrc: JcrcServiceInput | null,
  academicYear: string,
): InvolvementRow[] {
  const year = shortYear(academicYear);
  const rows: InvolvementRow[] = [];
  if (jcrc) {
    rows.push({
      ccaName: cleaned(jcrc.portfolio)
        ? `Junior Common Room Committee (JCRC), ${jcrc.portfolio.trim()}`
        : "Junior Common Room Committee (JCRC)",
      role: cleaned(jcrc.position),
      year,
      extraContribution: null,
      footnote: 0,
      isJcrc: true,
    });
  }
  for (const m of memberships) {
    rows.push({
      ccaName: m.ccaName,
      role: withDuration(cleaned(m.leadershipRole), m.roleDuration),
      year: withDuration(year, m.duration) ?? year,
      extraContribution: cleaned(m.extraContribution),
      footnote: 0,
      isJcrc: false,
    });
  }
  return rows.map((row, index) => ({ ...row, footnote: index + 1 }));
}

/** Footnotes follow the order of the table: the JCRC row, then each CCA. */
function buildNotes(
  involvements: readonly InvolvementRow[],
  memberships: readonly CcaMembershipInput[],
): NoteRow[] {
  const descriptions = new Map(
    memberships.map((m) => [m.ccaName, cleaned(m.description)] as const),
  );
  return involvements.map((row) => {
    if (row.isJcrc) {
      return {
        number: row.footnote,
        title: JCRC_NOTE_TITLE,
        text: JCRC_NOTE_TEXT,
        isMissing: false,
      };
    }
    const description = descriptions.get(row.ccaName) ?? null;
    return {
      number: row.footnote,
      title: row.ccaName,
      text: description ?? MISSING_DESCRIPTION_TEXT,
      isMissing: description === null,
    };
  });
}

function toJcrcPage(jcrc: JcrcServiceInput): JcrcPageModel {
  return {
    portfolio: jcrc.portfolio,
    position: jcrc.position,
    term: jcrc.term,
    about: JCRC_ABOUT_TEXT,
    responsibilities: jcrc.description,
    contributions: [...jcrc.contributions],
    testimonial: { ...jcrc.testimonial },
    isPlaceholder: jcrc.isPlaceholder,
  };
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
    .sort(
      (a, b) =>
        compareText(a.ccaName, b.ccaName) ||
        compareText(a.activity, b.activity),
    )
    .map((v) => ({
      activity: `${v.activity} (regular)`,
      kind: "regular" as const,
      organiser: v.ccaName,
      date: null,
      hours: v.hours,
    }));
  const oneOffRows = [...oneOff]
    .sort(
      (a, b) =>
        compareText(a.date, b.date) || compareText(a.eventName, b.eventName),
    )
    .map((v) => ({
      activity: `${v.eventName} (one-off)`,
      kind: "one-off" as const,
      organiser: v.organiser,
      date: v.date,
      hours: v.hours,
    }));

  const regularSubtotal = sumHours(regularRows.map((r) => r.hours));
  const oneOffSubtotal = sumHours(oneOffRows.map((r) => r.hours));

  return {
    rows: [...regularRows, ...oneOffRows],
    regularSubtotal,
    oneOffSubtotal,
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
