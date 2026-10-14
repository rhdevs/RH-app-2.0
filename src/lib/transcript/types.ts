/**
 * TRANSCRIPT TYPES — input records and the rendered view model.
 *
 * PURE: no Prisma, no I/O. The input types are shaped like the FUTURE
 * collections described in docs/transcript/SPEC.md §5 (membership record,
 * extra contribution, volunteer record, award) so that, when those exist, a
 * loader only has to map rows onto these and the assembler and pages stay as
 * they are. Nothing here is persisted yet.
 *
 * Academic years are strings of the form "AY2026/27". Transcripts start at
 * AY2026/27; there is no backfill.
 */

/** Who the transcript is about, and the facts printed on its header. */
export interface ResidentInput {
  name: string;
  matric: string;
  /** The User model has no faculty field today; null omits the line. */
  faculty: string | null;
  /** Printed on the document and encoded in its QR code. A real one must be
   *  random and unguessable; fixtures use fixed, obviously fake values. */
  verificationCode: string;
  /** ISO date, "2026-10-06". */
  issuedOn: string;
  /** Every page keys its SPECIMEN treatment off this flag, not off the route. */
  isSpecimen: boolean;
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
}

/** Hours attested through a CCA the resident is in. */
export interface RegularVolunteerInput {
  academicYear: string;
  ccaName: string;
  hours: number;
}

/** Hours for a single event; open to any resident. */
export interface OneOffVolunteerInput {
  academicYear: string;
  eventName: string;
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

export interface TranscriptInput {
  resident: ResidentInput;
  memberships: CcaMembershipInput[];
  regularVolunteering: RegularVolunteerInput[];
  oneOffVolunteering: OneOffVolunteerInput[];
  awards: AwardInput[];
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface InvolvementRow {
  ccaName: string;
  category: string;
  /** Null for plain members: the Role column is left blank. */
  role: string | null;
  /** Null when there is none: no "Additional contributions" subsection. */
  extraContribution: string | null;
}

export interface CcaDescriptionRow {
  ccaName: string;
  /** The CCA's description, or the placeholder when it has none. */
  description: string;
  /** True when `description` is the placeholder (rendered muted). */
  isMissing: boolean;
}

export interface RegularVolunteerRow {
  ccaName: string;
  hours: number;
}

export interface OneOffVolunteerRow {
  eventName: string;
  date: string;
  hours: number;
}

export interface VolunteerHoursModel {
  regular: { rows: RegularVolunteerRow[]; subtotal: number };
  oneOff: { rows: OneOffVolunteerRow[]; subtotal: number };
  total: number;
}

export interface AwardRow {
  title: string;
  academicYear: string;
  citation: string | null;
}

/**
 * The document body is an ORDERED LIST of sections, and the renderer maps
 * `kind` to a component. Adding a section later (a JCRC service section, a
 * testimonial block) means adding a member here, one entry in the assembler
 * and one renderer: the document and the pages do not change shape.
 */
export type TranscriptSection =
  | { kind: "involvements"; rows: InvolvementRow[] }
  | { kind: "ccaDescriptions"; rows: CcaDescriptionRow[] }
  | { kind: "volunteerHours"; volunteer: VolunteerHoursModel }
  | { kind: "awards"; rows: AwardRow[] };

export interface TranscriptViewModel {
  academicYear: string;
  resident: ResidentInput;
  /** True when nothing was recorded for this AY; the page shows a message. */
  isEmpty: boolean;
  hasVolunteerHours: boolean;
  hasAwards: boolean;
  /** Ordered, present sections only. Empty when `isEmpty`. */
  sections: TranscriptSection[];
}
