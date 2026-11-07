/**
 * Category rules (F08): what each kind of proposal must contain, written ONCE.
 * The form and the server both call `missingForSubmit`; the server enforces it
 * at submit (services/proposals/drafts.ts) and the form uses it to say what is
 * still missing. Server-import-free.
 *
 * The table is socporthub's, with one deliberate difference: its old SERVER did
 * not ask a welfare proposal for an event date while its old FORM did, so the
 * two disagreed. Here there is one table, and it follows what the server
 * enforced (welfare needs no date).
 */

import { normalizeDocLink } from "~/lib/schemas/proposalFiles";

export const PROPOSAL_CATEGORIES = [
  "event",
  "initiative",
  "welfare",
  "decor",
  "pantry_cleaning",
  "merch",
  "pubs",
] as const;
export type ProposalCategory = (typeof PROPOSAL_CATEGORIES)[number];

export const PROPOSAL_CATEGORY_LABELS: Record<ProposalCategory, string> = {
  event: "Event",
  initiative: "Initiative",
  welfare: "Welfare",
  decor: "Decor",
  pantry_cleaning: "Pantry cleaning",
  merch: "Merch",
  pubs: "Pubs",
};

/** The things a category can require. */
export const REQUIREMENT_KEYS = [
  "plannedStart",
  "blastMessage",
  "poster",
  "docLink",
] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export const REQUIREMENT_LABELS: Record<RequirementKey, string> = {
  plannedStart: "A planned start date and time",
  blastMessage: "A blast message",
  poster: "A poster",
  docLink: "A document link",
};

export const CATEGORY_REQUIREMENTS: Record<
  ProposalCategory,
  readonly RequirementKey[]
> = {
  event: ["plannedStart", "blastMessage", "poster", "docLink"],
  initiative: ["plannedStart", "blastMessage", "poster"],
  welfare: ["blastMessage", "poster"],
  decor: [],
  pantry_cleaning: ["plannedStart"],
  merch: ["poster", "docLink"],
  pubs: [],
};

/**
 * Requirements the Proposal row cannot hold yet. Empty since the files PR
 * stored the poster and the document link, so every requirement in the table
 * above is checked at submit. To switch the poster and link rules off again,
 * list "poster" and "docLink" here.
 */
export const NOT_YET_STORED: readonly RequirementKey[] = [];

export function isProposalCategory(value: unknown): value is ProposalCategory {
  return (
    typeof value === "string" &&
    (PROPOSAL_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * The starting value of "This will be an event" (Q24: optional). Only the
 * Event type starts on; the head can switch it either way while the proposal
 * is a draft or returned, and an approved proposal can still make its draft
 * by hand.
 */
export function defaultWillBeEvent(category: ProposalCategory): boolean {
  return category === "event";
}

export type SubmitContent = {
  category: ProposalCategory;
  title: string;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
  posterUrl: string | null;
  docLink: string | null;
};

/**
 * What a proposal still lacks before it can be submitted, as readable
 * messages. Empty means ready. Every category needs a title and a
 * description; the rest comes from CATEGORY_REQUIREMENTS.
 */
export function missingForSubmit(content: SubmitContent): string[] {
  const missing: string[] = [];
  if (content.title.trim() === "") missing.push("A title");
  if (content.description.trim() === "") missing.push("A description");
  for (const key of CATEGORY_REQUIREMENTS[content.category]) {
    if (NOT_YET_STORED.includes(key)) continue;
    if (key === "plannedStart" && content.plannedStart === null) {
      missing.push(REQUIREMENT_LABELS[key]);
    }
    if (key === "blastMessage" && (content.blastMessage ?? "").trim() === "") {
      missing.push(REQUIREMENT_LABELS[key]);
    }
    if (key === "poster" && (content.posterUrl ?? "").trim() === "") {
      missing.push(REQUIREMENT_LABELS[key]);
    }
    if (key === "docLink" && normalizeDocLink(content.docLink ?? "") === null) {
      missing.push(REQUIREMENT_LABELS[key]);
    }
  }
  if (
    content.plannedStart !== null &&
    content.plannedEnd !== null &&
    content.plannedEnd <= content.plannedStart
  ) {
    missing.push("An end that is after the start");
  }
  return missing;
}
