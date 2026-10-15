/**
 * TRANSCRIPT TYPES — input records and the rendered view model.
 *
 * PURE: no Prisma, no I/O. The input types are shaped like the FUTURE
 * collections described in docs/transcript/SPEC.md §5 (membership record,
 * extra contribution, volunteer record, award, JCRC service) so that, when
 * those exist, a loader only has to map rows onto these and the assembler and
 * pages stay as they are. Nothing here is persisted yet.
 *
 * ONE TRANSCRIPT PER ACADEMIC YEAR. It is a recognition document, assembled
 * from the hall's data each time it is opened; there is no verification.
 * Academic years are strings of the form "AY2026/27". Transcripts start at
 * AY2026/27; there is no backfill.
 */

/** Who the transcript is about. */
export interface ResidentInput {
  name: string;
  matric: string;
  /** Every page keys its SPECIMEN treatment off this flag, not off the route. */
  isSpecimen: boolean;
}

/**
 * The facts that belong to a single academic year's document. The list of
 * years a resident can download is the list of published years.
 */
export interface YearIssueInput {
  academicYear: string;
  /** ISO date, "2027-05-10": the day the year was published (Singapore).
   *  Null in an admin preview of a year that is not published yet. */
  issuedOn: string | null;
  /** "Block 3" — the hall owns this, unlike faculty. Null when not on file. */
  block: string | null;
  /** 1 for a resident's first year in hall, 2 for their second, ... Null when
   *  the app does not know (it keeps no residence history). */
  yearOfResidence: number | null;
}

/** One CCA membership in one academic year. */
export interface CcaMembershipInput {
  ccaName: string;
  category: string;
  academicYear: string;
  /** "Head", "President", "Captain"... Null (or blank) for a plain member. */
  leadershipRole: string | null;
  /** From the CCA list. Many CCAs have none yet. */
  description: string | null;
  /** Free text on what this person did, entered by the head or exco. */
  extraContribution: string | null;
  /** How long they were in the CCA this year. Shown only when not "full". */
  duration?: "full" | "sem1" | "sem2" | null;
  /** How long they held the role. Shown only when not "full". */
  roleDuration?: "full" | "sem1" | "sem2" | null;
}

/**
 * One CCA activity the resident took part in. `isMember` is decided by the
 * loader with the same rule as the CCA rows (frozen entries, else the live
 * roster of the CCA's term year): a member's activities nest under that CCA's
 * row, anyone else's go under "Other involvement".
 */
export interface ActivityInput {
  academicYear: string;
  /** The CCA that organised it. */
  ccaName: string;
  title: string;
  /** What the activity was, in general. Null when none was written. */
  description: string | null;
  period: "full" | "sem1" | "sem2";
  /** This person's role in it; null or blank when they had none. */
  role: string | null;
  /** What this person did; null or blank falls back to `description`. */
  personDescription: string | null;
  isMember: boolean;
}

/** Hours attested through a CCA the resident is in. */
export interface RegularVolunteerInput {
  academicYear: string;
  ccaName: string;
  /** What the volunteering was, e.g. "Weekly tuition for neighbourhood children". */
  activity: string;
  hours: number;
}

/** Hours for a single event; open to any resident. */
export interface OneOffVolunteerInput {
  academicYear: string;
  eventName: string;
  /** Who ran it, e.g. "RH Welfare" or "Hall committee". */
  organiser: string;
  /** ISO date, "2026-09-12". */
  date: string;
  hours: number;
}

/** An award from the end-of-year Colours Awards. */
export interface AwardInput {
  title: string;
  academicYear: string;
  citation: string | null;
}

/**
 * A resident's Junior Common Room Committee service for one term. Present only
 * for JCRC members. The testimonial is the member's own text for now; the
 * Master and President signatures are NOT data (the document always prints
 * empty placeholder boxes).
 */
/** One row of the JCRC contributions table. Role and description may be blank. */
export interface ContributionInput {
  activity: string;
  role: string;
  description: string;
}

export interface JcrcServiceInput {
  /** "Sports" */
  portfolio: string;
  /** "Secretary" */
  position: string;
  /** The academic year this appointment covers. */
  term: string;
  /** What the role covers. */
  description: string;
  contributions: ContributionInput[];
  testimonial: { text: string; author: "Hall Master" };
  /** True while the content is stand-in text (shown on screen only). */
  isPlaceholder: boolean;
}

export interface TranscriptInput {
  resident: ResidentInput;
  issues: YearIssueInput[];
  memberships: CcaMembershipInput[];
  regularVolunteering: RegularVolunteerInput[];
  oneOffVolunteering: OneOffVolunteerInput[];
  awards: AwardInput[];
  jcrc: JcrcServiceInput | null;
  /** Activities the resident took part in; absent means none. */
  activities?: ActivityInput[];
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface InvolvementRow {
  /** For the JCRC row: "Junior Common Room Committee (JCRC), <portfolio>". */
  ccaName: string;
  /** Null for plain members: the Role column is left blank. */
  role: string | null;
  /** "2026/27", or "2026/27 Sem 2" for one semester; always on one line. */
  year: string;
  /** Null when there is none: no "Additional contribution" sub-row. */
  extraContribution: string | null;
  /** Matches the number in the Explanatory notes page. */
  footnote: number;
  /** True for the JCRC row, which points to the dedicated JCRC page. */
  isJcrc: boolean;
  /** The CCA's activities this person took part in; empty when there are none. */
  activities: ActivityRow[];
}

/** One line of the nested Activity | Role | Description table under a CCA. */
export interface ActivityRow {
  /** The title, with " (Sem 1)" / " (Sem 2)" for a part-year activity. */
  title: string;
  /** Blank when the person had no role. */
  role: string;
  /** The person's own description, else the activity's, else blank. */
  description: string;
}

/** A row of "Other involvement": an activity of a CCA the person is not in. */
export interface OtherInvolvementRow extends ActivityRow {
  /** The CCA that organised it. */
  organiser: string;
}

/** The general description of an activity, for the notes page. */
export interface ActivityNote {
  title: string;
  text: string;
}

export interface VolunteerRow {
  /** "Beach clean-up (one-off)" / "Weekly tuition (regular)". */
  activity: string;
  kind: "regular" | "one-off";
  organiser: string;
  /** ISO date for one-off rows, null for regular ones. */
  date: string | null;
  hours: number;
}

export interface VolunteerHoursModel {
  /** Regular rows first, then one-off rows. */
  rows: VolunteerRow[];
  regularSubtotal: number;
  oneOffSubtotal: number;
  total: number;
}

export interface AwardRow {
  title: string;
  academicYear: string;
  citation: string | null;
}

/** A section on page 1. Empty sections are not present. */
export type TranscriptSection =
  | { kind: "involvements"; rows: InvolvementRow[] }
  | { kind: "otherInvolvement"; rows: OtherInvolvementRow[] }
  | { kind: "volunteerHours"; volunteer: VolunteerHoursModel }
  | { kind: "awards"; rows: AwardRow[] };

export interface JcrcPageModel {
  portfolio: string;
  position: string;
  term: string;
  /** Static explanatory text about the committee. */
  about: string;
  /** What the role covers. */
  responsibilities: string;
  contributions: ContributionInput[];
  testimonial: { text: string; author: "Hall Master" };
  isPlaceholder: boolean;
}

export interface NoteRow {
  number: number;
  /** The CCA, or "JCRC (Junior Common Room Committee)". */
  title: string;
  text: string;
  /** True when `text` is the missing-description placeholder (rendered muted). */
  isMissing: boolean;
  /** "Activity: general description" for this CCA's activities that have one. */
  activities: ActivityNote[];
}

/**
 * The document is an ORDERED LIST OF PAGES, each starting on a new printed
 * page: the main page, the JCRC page (JCRC members only), and the notes page.
 * Adding a page or a section later means adding a member here, one entry in
 * the assembler and one renderer; the pages that show a transcript do not
 * change shape.
 */
export type TranscriptPage =
  | { kind: "main"; sections: TranscriptSection[] }
  | { kind: "jcrc"; jcrc: JcrcPageModel }
  | { kind: "notes"; notes: NoteRow[]; otherNotes: ActivityNote[] };

export interface TranscriptViewModel {
  academicYear: string;
  resident: ResidentInput;
  issue: YearIssueInput;
  /** True when nothing was recorded for this AY; the page shows a message. */
  isEmpty: boolean;
  hasVolunteerHours: boolean;
  hasAwards: boolean;
  hasJcrc: boolean;
  /** True when any CCA row is for one semester only (the notes explain Sem 1 / Sem 2). */
  hasPartYear: boolean;
  /** True while the year is closed for review: shown as a DRAFT, not a record. */
  isDraft: boolean;
  /** Always main first and notes last; the JCRC page sits between them. */
  pages: TranscriptPage[];
}
