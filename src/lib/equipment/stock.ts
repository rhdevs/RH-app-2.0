/**
 * The stock rule (A68), pure. A loan holds stock for the half-open window
 * [collectAt, returnAt). An approval is refused when, at ANY instant in its
 * window, what the other holding loans have out plus what this one wants is
 * more than the hall owns. The load only rises at a start, so it is enough to
 * look at the instant this window opens and at each other loan's start inside it.
 */

export type HeldLoan = {
  id: string;
  collectAt: number;
  returnAt: number;
  /** How many of this item the loan holds. */
  quantity: number;
};

export type StockShortfall = {
  /** The first instant (epoch seconds) at which there is not enough. */
  at: number;
  /** How many the hall owns. */
  owned: number;
  /** How many are already out at `at`. */
  heldAtPeak: number;
  /** How many this loan wants. */
  wanted: number;
  /** Every holding loan whose window meets this one. */
  holders: HeldLoan[];
};

const overlaps = (
  a: { collectAt: number; returnAt: number },
  b: { collectAt: number; returnAt: number },
) => a.collectAt < b.returnAt && b.collectAt < a.returnAt;

export function findShortfall(input: {
  owned: number;
  wanted: number;
  window: { collectAt: number; returnAt: number };
  holders: readonly HeldLoan[];
}): StockShortfall | null {
  const { owned, wanted, window } = input;
  const near = input.holders.filter((h) => overlaps(h, window));
  const instants = [
    window.collectAt,
    ...near
      .map((h) => h.collectAt)
      .filter((t) => t > window.collectAt && t < window.returnAt),
  ].sort((a, b) => a - b);
  for (const at of instants) {
    const heldAtPeak = near
      .filter((h) => h.collectAt <= at && at < h.returnAt)
      .reduce((sum, h) => sum + h.quantity, 0);
    if (heldAtPeak + wanted > owned) {
      return { at, owned, heldAtPeak, wanted, holders: near };
    }
  }
  return null;
}

/** The message prefix of a refused approval; the rest is JSON (`ShortDetail`). */
export const EQUIPMENT_SHORT_PREFIX = "EQUIPMENT_SHORT:";

export type ShortDetail = {
  itemID: string;
  name: string;
  owned: number;
  wanted: number;
  heldAtPeak: number;
  at: number;
  /** The loans holding the item in the window: id, event title, window, how many. */
  loans: {
    id: string;
    eventTitle: string | null;
    collectAt: number;
    returnAt: number;
    quantity: number;
  }[];
};

/** Most holders named in a message, so it stays small. */
export const SHORT_DETAIL_LOANS_MAX = 20;

export function shortMessage(detail: ShortDetail): string {
  return `${EQUIPMENT_SHORT_PREFIX}${JSON.stringify({
    ...detail,
    loans: detail.loans.slice(0, SHORT_DETAIL_LOANS_MAX),
  })}`;
}

/** The detail inside a refusal message, or null when it is not one. */
export function parseShortMessage(message: string): ShortDetail | null {
  if (!message.startsWith(EQUIPMENT_SHORT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      message.slice(EQUIPMENT_SHORT_PREFIX.length),
    ) as ShortDetail;
    return typeof parsed.itemID === "string" && Array.isArray(parsed.loans)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
