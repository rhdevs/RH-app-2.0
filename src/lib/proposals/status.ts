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
 * Who may make each move is the caller's business (in this PR only submit has
 * a caller). This table says only which moves exist.
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
