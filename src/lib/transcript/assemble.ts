import {
  type ActivityInput,
  type ActivityRow,
  type AwardRow,
  type CcaMembershipInput,
  type InvolvementRow,
  type JcrcPageModel,
  type JcrcServiceInput,
  type OtherInvolvementRow,
  type TranscriptInput,
  type TranscriptPage,
  type TranscriptSection,
  type TranscriptViewModel,
  type VolunteerActivityInput,
  type VolunteerHoursModel,
} from "./types";
import { ccaDescriptionText } from "./ccaDescription";
import { compareVolunteerActivities } from "./volunteer";
import {
  compareActivities,
  participantText,
  periodSuffix,
  readPeriod,
} from "./activities";

/** Static text on the JCRC page. */
export const JCRC_ABOUT_TEXT =
  "The JCRC is the elected student committee that leads Raffles Hall and represents its residents. Its members run hall-wide programmes, oversee CCAs within their portfolios, and work with hall management.";

/** The JCRC row's description in the CCA table. */
export const JCRC_ROW_DESCRIPTION =
  "The elected student committee that leads the hall. See the JCRC page.";

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
  const volunteering = input.volunteering.filter(
    (v) => v.academicYear === academicYear && v.hours > 0,
  );
  const awards = input.awards.filter((a) => a.academicYear === academicYear);
  const jcrc = input.jcrc?.term === academicYear ? input.jcrc : null;

  const { byCca, other } = splitActivities(
    (input.activities ?? []).filter((a) => a.academicYear === academicYear),
    new Set(memberships.map((m) => m.ccaName)),
  );
  const involvements = buildInvolvements(
    memberships,
    jcrc,
    academicYear,
    byCca,
  );
  const otherRows = other.map(toOtherRow);
  const volunteer = buildVolunteerHours(volunteering);
  const awardRows = buildAwards(awards);

  const sections: TranscriptSection[] = [];
  if (involvements.length > 0) {
    sections.push({ kind: "involvements", rows: involvements });
  }
  if (otherRows.length > 0) {
    sections.push({ kind: "otherInvolvement", rows: otherRows });
  }
  if (volunteer) sections.push({ kind: "volunteerHours", volunteer });
  if (awardRows.length > 0) sections.push({ kind: "awards", rows: awardRows });

  const pages: TranscriptPage[] = [{ kind: "main", sections }];
  if (jcrc) pages.push({ kind: "jcrc", jcrc: toJcrcPage(jcrc) });

  return {
    academicYear,
    resident: { ...input.resident },
    issue: { ...issue },
    isEmpty: sections.length === 0,
    hasVolunteerHours: volunteer !== null,
    hasAwards: awardRows.length > 0,
    hasJcrc: jcrc !== null,
    hasPartYear:
      memberships.some(
        (m) =>
          semLabel(m.duration) !== null ||
          (cleaned(m.leadershipRole) !== null &&
            semLabel(m.roleDuration) !== null),
      ) ||
      [...byCca.values(), other].some((list) =>
        list.some((a) => readPeriod(a.period) !== "full"),
      ),
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

/** "Sem 1" / "Sem 2" for a part-year period; null for a full year or unknown. */
function semLabel(duration: string | null | undefined): string | null {
  if (duration === "sem1") return "Sem 1";
  if (duration === "sem2") return "Sem 2";
  return null;
}

/** "Head" + sem2 -> "Head (Sem 2)". A full year or a missing period adds nothing. */
function roleWithPeriod(
  role: string | null,
  duration: string | null | undefined,
): string | null {
  const label = semLabel(duration);
  return role && label ? `${role} (${label})` : role;
}

/** "2026/27" + sem2 -> "2026/27 Sem 2", kept on one line by the table cell. */
function yearWithPeriod(
  year: string,
  duration: string | null | undefined,
): string {
  const label = semLabel(duration);
  return label ? `${year} ${label}` : year;
}

function shortYear(academicYear: string): string {
  return academicYear.replace(/^AY/, "");
}

/**
 * Members' activities go under their CCA row; everything else (a person who is
 * not in the CCA, or an activity whose CCA has no row) is "other involvement".
 * Both lists are in transcript order.
 */
function splitActivities(
  activities: readonly ActivityInput[],
  memberCcas: ReadonlySet<string>,
): { byCca: Map<string, ActivityInput[]>; other: ActivityInput[] } {
  const sorted = [...activities].sort(
    (a, b) =>
      compareActivities(
        { period: readPeriod(a.period), title: a.title },
        { period: readPeriod(b.period), title: b.title },
      ) || compareText(a.ccaName, b.ccaName),
  );
  const byCca = new Map<string, ActivityInput[]>();
  const other: ActivityInput[] = [];
  for (const a of sorted) {
    if (a.isMember && memberCcas.has(a.ccaName)) {
      byCca.set(a.ccaName, [...(byCca.get(a.ccaName) ?? []), a]);
    } else {
      other.push(a);
    }
  }
  return { byCca, other };
}

const activityTitle = (a: ActivityInput) =>
  `${a.title.trim()}${periodSuffix(readPeriod(a.period))}`;

function toActivityRow(a: ActivityInput): ActivityRow {
  const text = participantText(a.description, {
    role: a.role,
    description: a.personDescription,
  });
  return { title: activityTitle(a), ...text };
}

function toOtherRow(a: ActivityInput): OtherInvolvementRow {
  return { ...toActivityRow(a), organiser: a.ccaName };
}

function buildInvolvements(
  memberships: readonly CcaMembershipInput[],
  jcrc: JcrcServiceInput | null,
  academicYear: string,
  activities: ReadonlyMap<string, readonly ActivityInput[]>,
): InvolvementRow[] {
  const year = shortYear(academicYear);
  const rows: InvolvementRow[] = [];
  if (jcrc) {
    rows.push({
      number: 0,
      ccaName: cleaned(jcrc.portfolio)
        ? `Junior Common Room Committee (JCRC), ${jcrc.portfolio.trim()}`
        : "Junior Common Room Committee (JCRC)",
      role: cleaned(jcrc.position),
      year,
      extraContribution: null,
      description: JCRC_ROW_DESCRIPTION,
      activities: [],
    });
  }
  for (const m of memberships) {
    rows.push({
      number: 0,
      ccaName: m.ccaName,
      role: roleWithPeriod(cleaned(m.leadershipRole), m.roleDuration),
      year: yearWithPeriod(year, m.duration),
      extraContribution: cleaned(m.extraContribution),
      description: ccaDescriptionText(m.description),
      activities: [],
    });
  }
  return rows.map((row, index) => {
    const number = index + 1;
    // The JCRC row never has activities: it is not a CCA of this year.
    const mine =
      row === rows[0] && jcrc ? [] : (activities.get(row.ccaName) ?? []);
    return {
      ...row,
      number,
      activities: mine.map((a, i) => ({
        ...toActivityRow(a),
        number: `${number}.${i + 1}`,
      })),
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
    contributions: jcrc.contributions.map((c) => ({ ...c })),
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
  activities: readonly VolunteerActivityInput[],
): VolunteerHoursModel | null {
  if (activities.length === 0) return null;
  const rows = [...activities]
    .sort(
      (a, b) =>
        compareVolunteerActivities(a, b) || compareText(a.ccaName, b.ccaName),
    )
    .map((v) => ({
      activity: v.title,
      type: v.kind === "oneoff" ? ("One-off" as const) : ("Regular" as const),
      organiser: v.ccaName,
      hours: sumHours([v.hours]),
    }));
  return { rows, total: sumHours(rows.map((r) => r.hours)) };
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
