import type { PrismaClient } from "@prisma/client";

import { eventStateOf } from "~/lib/disposables/events";
import {
  holdsStockFor,
  STOCK_HOLDING_STATUSES,
  type LoanStatus,
} from "~/lib/equipment/status";

/**
 * The equipment loans that are overdue now: approved or collected, and past
 * their return time. An approved loan that was never collected and whose event
 * is canceled or declined is NOT overdue (no kit is out); a collected one is,
 * whatever became of its event (`holdsStockFor`). A plain read for the Social
 * director daily digest (dueCheck/collectionDigest.ts): it writes nothing and
 * has no catch, so a failed read reaches the due-check runner, which writes
 * nothing.
 *
 * A loan for a hall-wide event has no CCA (`ccaID` null, or a key that was
 * never written); it is labelled "hall-wide" rather than dropped or shown as a
 * missing name. The label carries the event title and the CCA, never what was
 * borrowed.
 */

/** The most overdue loans a digest names. */
export const OVERDUE_LABELS_MAX = 5;
/** Far above a real term; `more` says the count is a floor if it is reached. */
export const OVERDUE_SCAN_MAX = 100;

export type OverdueLoans = {
  /** How many were found; when `more` is true it is "at least" this many. */
  count: number;
  labels: string[];
  /** There were more than the scan reads. */
  more: boolean;
};

export async function overdueLoans(
  db: Pick<PrismaClient, "equipmentLoan" | "event" | "cCA">,
  nowSeconds: number,
): Promise<OverdueLoans> {
  const found = await db.equipmentLoan.findMany({
    where: {
      status: { in: [...STOCK_HOLDING_STATUSES] },
      returnAt: { lt: nowSeconds },
    },
    orderBy: { returnAt: "asc" },
    take: OVERDUE_SCAN_MAX + 1,
    select: { eventID: true, ccaID: true, status: true },
  });
  const scanned = found.slice(0, OVERDUE_SCAN_MAX);
  const more = found.length > OVERDUE_SCAN_MAX;
  if (scanned.length === 0) return { count: 0, labels: [], more: false };

  const events = await db.event.findMany({
    where: { eventID: { in: [...new Set(scanned.map((r) => r.eventID))] } },
    select: { eventID: true, title: true, status: true },
  });
  const byEvent = new Map(events.map((e) => [e.eventID, e]));
  const rows = scanned.filter((r) =>
    holdsStockFor(
      r.status as LoanStatus,
      eventStateOf(byEvent.get(r.eventID) ?? null),
    ),
  );
  if (rows.length === 0) return { count: 0, labels: [], more };

  const shown = rows.slice(0, OVERDUE_LABELS_MAX);
  const ccaIDs = [
    ...new Set(shown.flatMap((r) => (r.ccaID != null ? [r.ccaID] : []))),
  ];
  const ccas = ccaIDs.length
    ? await db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true },
      })
    : [];
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  return {
    count: rows.length,
    labels: shown.map((r) => {
      const event = (byEvent.get(r.eventID)?.title?.trim() ?? "") || "an event";
      const owner =
        r.ccaID == null ? "hall-wide" : (ccaName.get(r.ccaID) ?? "a CCA");
      return `${event} (${owner})`;
    }),
    more,
  };
}
