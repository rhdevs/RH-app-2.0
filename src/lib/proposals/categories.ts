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
 * Requirements the Proposal row cannot hold yet. The poster and the document
 * link arrive with the files PR; until then the table names them (so the rule
 * is written once, now) but nothing checks them. That PR empties this list.
 */
export const NOT_YET_STORED: readonly RequirementKey[] = ["poster", "docLink"];

export function isProposalCategory(value: unknown): value is ProposalCategory {
  return (
    typeof value === "string" &&
    (PROPOSAL_CATEGORIES as readonly string[]).includes(value)
  );
}

export type SubmitContent = {
  category: ProposalCategory;
  title: string;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
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
