import { isProposalStatus, PROPOSAL_STATUS_LABELS } from "./status";

/**
 * The words for one history row, shared by the head's screen and the
 * director's. Plain text only (React escapes it). The self-approved label names
 * the approver, so a reader can see WHO approved their own CCA's proposal; an
 * approver who has no name on file (or whose account is gone) is "a former
 * member", never an id.
 */

export const SELF_APPROVED_LABEL = "self-approved";

export type HistoryRow = {
  fromStatus: string;
  toStatus: string;
  at: Date | string;
  selfApproved: boolean;
  approverName: string | null;
  note: string | null;
};

const label = (value: string) =>
  isProposalStatus(value) ? PROPOSAL_STATUS_LABELS[value] : "Unknown";

export function historyLine(
  row: HistoryRow,
  formatAt: (at: Date | string) => string,
): string {
  const approver = row.approverName ?? "a former member";
  const approvedBy =
    row.toStatus === "cleared" &&
    (row.approverName !== null || row.selfApproved)
      ? ` by ${approver}`
      : "";
  const flag = row.selfApproved ? ` (${SELF_APPROVED_LABEL})` : "";
  const note = row.note ? `: ${row.note}` : "";
  return `${label(row.fromStatus)} to ${label(row.toStatus)}, ${formatAt(row.at)}${approvedBy}${flag}${note}`;
}
