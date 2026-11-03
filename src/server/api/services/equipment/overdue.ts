import type { PrismaClient } from "@prisma/client";

import { STOCK_HOLDING_STATUSES } from "~/lib/equipment/status";

/**
 * The equipment loans that are overdue now: approved or collected, and past
 * their return time. A plain read for the Social director daily digest
 * (dueCheck/collectionDigest.ts): it writes nothing and has no catch, so a
 * failed read reaches the due-check runner, which writes nothing.
 *
 * A loan for a hall-wide event has no CCA (`ccaID` null, or a key that was
 * never written); it is labelled "hall-wide" rather than dropped or shown as a
 * missing name. The label carries the event title and the CCA, never what was
 * borrowed.
 */

/** The most overdue loans a digest names; the count is always the whole number. */
export const OVERDUE_LABELS_MAX = 5;
/** Far above a real term; the count says "at least" if it is ever reached. */
const OVERDUE_SCAN_MAX = 100;

export type OverdueLoans = {
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
    select: { eventID: true, ccaID: true },
  });
  const rows = found.slice(0, OVERDUE_SCAN_MAX);
  if (rows.length === 0) return { count: 0, labels: [], more: false };

  const shown = rows.slice(0, OVERDUE_LABELS_MAX);
  const events = await db.event.findMany({
    where: { eventID: { in: [...new Set(shown.map((r) => r.eventID))] } },
    select: { eventID: true, title: true },
  });
  const ccaIDs = [
    ...new Set(shown.flatMap((r) => (r.ccaID != null ? [r.ccaID] : []))),
  ];
  const ccas = ccaIDs.length
    ? await db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true },
      })
    : [];
  const title = new Map(events.map((e) => [e.eventID, e.title?.trim() ?? ""]));
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  return {
    count: rows.length,
    labels: shown.map((r) => {
      const event = title.get(r.eventID) ?? "an event";
      const owner =
        r.ccaID == null ? "hall-wide" : (ccaName.get(r.ccaID) ?? "a CCA");
      return `${event} (${owner})`;
    }),
    more: found.length > OVERDUE_SCAN_MAX,
  };
}
