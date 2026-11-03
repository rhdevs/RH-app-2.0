/**
 * The life of an equipment loan (merge proposal 14b). Pure and server-import
 * free: the server runs it to refuse, the screens run it to draw.
 *
 *   requested -> approved | rejected | canceled
 *   approved  -> collected | canceled
 *   collected -> returned
 *
 * Rejected, returned and canceled are final. A loan HOLDS STOCK while it is
 * approved or collected; an approved one lets go if its event is canceled or
 * declined before collection (holdsStockFor below).
 */

export const LOAN_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "collected",
  "returned",
  "canceled",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

const MOVES: Record<LoanStatus, readonly LoanStatus[]> = {
  requested: ["approved", "rejected", "canceled"],
  approved: ["collected", "canceled"],
  collected: ["returned"],
  rejected: [],
  returned: [],
  canceled: [],
};

export function canMove(from: LoanStatus, to: LoanStatus): boolean {
  return MOVES[from].includes(to);
}

export function isLoanStatus(s: string): s is LoanStatus {
  return (LOAN_STATUSES as readonly string[]).includes(s);
}

/** Approved and collected loans hold stock. */
export const holdsStock = (status: LoanStatus): boolean =>
  status === "approved" || status === "collected";

/**
 * Whether a loan holds stock given how its event stands. A collected loan
 * ALWAYS holds (the kit is physically out, whatever happened to the event). An
 * approved loan that has not been collected stops holding when its event is
 * canceled or declined; a gone event still holds (it may be a mistaken delete).
 */
export const holdsStockFor = (
  status: LoanStatus,
  eventState: "ok" | "canceled" | "declined" | "gone",
): boolean =>
  status === "collected" ||
  (status === "approved" &&
    eventState !== "canceled" &&
    eventState !== "declined");

/** The longest a loan may run from collection to return: 60 days. */
export const LOAN_WINDOW_MAX_SECONDS = 60 * 24 * 60 * 60;

/** The statuses that hold stock, for a database filter. */
export const STOCK_HOLDING_STATUSES: readonly LoanStatus[] = [
  "approved",
  "collected",
];

/** Approved or collected, and the return time has passed. */
export function isOverdue(
  loan: { status: LoanStatus; returnAt: number },
  nowSeconds: number,
): boolean {
  return holdsStock(loan.status) && loan.returnAt < nowSeconds;
}

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  collected: "Collected",
  returned: "Returned",
  canceled: "Canceled",
};
