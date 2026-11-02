/**
 * Disposable request statuses (merge proposal 4.9). `draft` is written only by
 * the phase 8 form and is not built here, so it is not in this list.
 */
export const DISPOSABLE_STATUSES = ["pending", "approved", "rejected"] as const;
export type DisposableStatus = (typeof DISPOSABLE_STATUSES)[number];

export const DISPOSABLE_STATUS_LABELS: Record<DisposableStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

export const isDisposableStatus = (s: string): s is DisposableStatus =>
  (DISPOSABLE_STATUSES as readonly string[]).includes(s);

/**
 * The moves that exist. A decision starts from `pending`. The only way back is
 * an edit of an APPROVED request, which sends it to `pending` again (Q22): a
 * changed order needs a fresh decision. A rejected request stays rejected.
 */
const MOVES: Record<DisposableStatus, readonly DisposableStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["pending"],
  rejected: [],
};

export const canMove = (from: DisposableStatus, to: DisposableStatus) =>
  MOVES[from].includes(to);
