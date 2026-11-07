/**
 * Proposal statuses and THE transition table. Under `src/lib/` and
 * server-import-free so the screens and the server read the same rules.
 *
 * `cleared` is the stored name of "approved": the director approved it. It is
 * not "the RFs replied" and not `published`; a proposal never publishes an
 * Event (merge proposal 4.1). The only code allowed to write
 * `Proposal.status` is `transitionProposal` (services/proposals/transition.ts).
 */

export const PROPOSAL_STATUSES = [
  "draft",
  "in_review",
  "needs_action",
  "cleared",
  "finished",
  "canceled",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  needs_action: "Returned",
  cleared: "Approved",
  finished: "Finished",
  canceled: "Canceled",
};

/**
 * Where each status may go next. EVERY status has an entry, so a new status
 * cannot be added without deciding its exits (the test checks the keys).
 *
 * - Approve (`in_review` to `cleared`) and return (`in_review` to
 *   `needs_action`) are available ONLY from `in_review`: no other status lists
 *   either as an exit.
 * - A head submits from `draft`, and resubmits from `needs_action`.
 * - `finished` and `canceled` are final.
 *
 * Who may make each move is the caller's business: a head submits, a director
 * of the CCA approves, returns and finishes (services/proposals/review.ts).
 * This table says only which moves exist.
 */
export const PROPOSAL_TRANSITIONS: Record<
  ProposalStatus,
  readonly ProposalStatus[]
> = {
  draft: ["in_review", "canceled"],
  in_review: ["needs_action", "cleared", "canceled"],
  needs_action: ["in_review", "canceled"],
  cleared: ["finished", "canceled"],
  finished: [],
  canceled: [],
};

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    typeof value === "string" &&
    (PROPOSAL_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransition(
  from: ProposalStatus,
  to: ProposalStatus,
): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** Statuses in which the head may still edit the content. */
export const EDITABLE_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "needs_action",
];

/** Statuses from which the head may submit (send it to the director). */
export const SUBMITTABLE_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "needs_action",
];

/**
 * The three moves a director makes, each from ONE status. The review service
 * and the screens both read this, and a test checks every entry is a move the
 * table above has, so the buttons, the server and the table cannot disagree.
 */
export const REVIEW_MOVES = {
  approve: { from: "in_review", to: "cleared" },
  return: { from: "in_review", to: "needs_action" },
  finish: { from: "cleared", to: "finished" },
} as const satisfies Record<
  string,
  { from: ProposalStatus; to: ProposalStatus }
>;
export type ReviewAction = keyof typeof REVIEW_MOVES;

/** The review actions a director could take on a proposal in this status. */
export function reviewActionsFor(status: string): ReviewAction[] {
  return (Object.keys(REVIEW_MOVES) as ReviewAction[]).filter(
    (action) => REVIEW_MOVES[action].from === status,
  );
}
