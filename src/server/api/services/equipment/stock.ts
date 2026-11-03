import type { PrismaClient } from "@prisma/client";

import { eventStateOf } from "~/lib/disposables/events";
import { STOCK_HOLDING_STATUSES } from "~/lib/equipment/status";
import {
  findShortfall,
  type HeldLoan,
  type ShortDetail,
} from "~/lib/equipment/stock";

/**
 * The stock rule (A68), read from stored rows. A loan HOLDS stock while it is
 * approved or collected, and only if its event is not canceled; that is worked
 * out here, when read, and the event router is not touched. A loan whose event
 * row is gone still holds (the event may have been deleted by mistake, and the
 * kit may be out). An overdue loan holds only inside its own window.
 *
 * Every function takes the client it should read with: callers that need the
 * answer to be safe against a concurrent approval pass the TRANSACTION client
 * and bump the items in the same transaction (see transition.ts).
 */

export type StockDb = Pick<PrismaClient, "equipmentLoan" | "event">;

export type Line = { itemID: string; quantity: number };
export type Window = { collectAt: number; returnAt: number };

type HoldingLoan = Window & { id: string; eventID: number; lines: Line[] };

/** Loans holding stock whose window meets `window`, canceled events excluded. */
export async function holdingLoans(
  db: StockDb,
  window: Window,
  excludeLoanID: string | null,
): Promise<HoldingLoan[]> {
  const rows = await db.equipmentLoan.findMany({
    where: {
      status: { in: [...STOCK_HOLDING_STATUSES] },
      collectAt: { lt: window.returnAt },
      returnAt: { gt: window.collectAt },
      ...(excludeLoanID !== null && { id: { not: excludeLoanID } }),
    },
    select: {
      id: true,
      eventID: true,
      collectAt: true,
      returnAt: true,
      lines: { select: { itemID: true, quantity: true } },
    },
  });
  return withoutCanceledEvents(db, rows);
}

async function withoutCanceledEvents<T extends { eventID: number }>(
  db: Pick<PrismaClient, "event">,
  rows: T[],
): Promise<T[]> {
  const ids = [...new Set(rows.map((r) => r.eventID))];
  if (ids.length === 0) return rows;
  const events = await db.event.findMany({
    where: { eventID: { in: ids } },
    select: { eventID: true, status: true },
  });
  const byID = new Map(events.map((e) => [e.eventID, e]));
  return rows.filter(
    (r) => eventStateOf(byID.get(r.eventID) ?? null) !== "canceled",
  );
}

async function eventTitles(
  db: Pick<PrismaClient, "event">,
  eventIDs: readonly number[],
): Promise<Map<number, string | null>> {
  const ids = [...new Set(eventIDs)];
  if (ids.length === 0) return new Map();
  const rows = await db.event.findMany({
    where: { eventID: { in: ids } },
    select: { eventID: true, title: true },
  });
  return new Map(rows.map((e) => [e.eventID, (e.title?.trim() ?? "") || null]));
}

const heldOf = (holders: HoldingLoan[], itemID: string): HeldLoan[] =>
  holders.flatMap((h) =>
    h.lines
      .filter((l) => l.itemID === itemID)
      .map((l) => ({
        id: h.id,
        collectAt: h.collectAt,
        returnAt: h.returnAt,
        quantity: l.quantity,
      })),
  );

async function detailOf(
  db: Pick<PrismaClient, "event">,
  holders: HoldingLoan[],
  item: { id: string; name: string },
  shortfall: NonNullable<ReturnType<typeof findShortfall>>,
  wanted: number,
): Promise<ShortDetail> {
  const eventOf = new Map(holders.map((h) => [h.id, h.eventID]));
  const titles = await eventTitles(
    db,
    shortfall.holders.map((h) => eventOf.get(h.id)!),
  );
  return {
    itemID: item.id,
    name: item.name,
    owned: shortfall.owned,
    wanted,
    heldAtPeak: shortfall.heldAtPeak,
    at: shortfall.at,
    loans: shortfall.holders.map((h) => ({
      id: h.id,
      eventTitle: titles.get(eventOf.get(h.id)!) ?? null,
      collectAt: h.collectAt,
      returnAt: h.returnAt,
      quantity: h.quantity,
    })),
  };
}

export type StockItem = { id: string; name: string; quantity: number };

/**
 * Every line of a loan that the hall cannot cover over its window, given the
 * loans already holding stock. `excludeLoanID` is the loan itself when it is
 * being approved. Empty means enough of everything.
 */
export async function stockProblems(
  db: StockDb,
  input: {
    excludeLoanID: string | null;
    lines: readonly Line[];
    window: Window;
    items: ReadonlyMap<string, StockItem>;
  },
): Promise<ShortDetail[]> {
  const holders = await holdingLoans(db, input.window, input.excludeLoanID);
  const problems: ShortDetail[] = [];
  for (const line of input.lines) {
    const item = input.items.get(line.itemID);
    if (!item) continue;
    const shortfall = findShortfall({
      owned: item.quantity,
      wanted: line.quantity,
      window: input.window,
      holders: heldOf(holders, line.itemID),
    });
    if (shortfall) {
      problems.push(
        await detailOf(db, holders, item, shortfall, line.quantity),
      );
    }
  }
  return problems;
}

/**
 * Would an item's quantity fall below what approved loans already hold from
 * now on? Looks at every holding loan that has not yet ended; one that ended
 * in the past no longer needs the kit. Null means the new quantity is fine.
 */
export async function overbookedBy(
  db: StockDb,
  item: { id: string; name: string },
  newQuantity: number,
  nowSeconds: number,
): Promise<ShortDetail | null> {
  const rows = await db.equipmentLoan.findMany({
    where: {
      status: { in: [...STOCK_HOLDING_STATUSES] },
      returnAt: { gt: nowSeconds },
    },
    select: {
      id: true,
      eventID: true,
      collectAt: true,
      returnAt: true,
      lines: { select: { itemID: true, quantity: true } },
    },
  });
  const holders = (await withoutCanceledEvents(db, rows)).filter((h) =>
    h.lines.some((l) => l.itemID === item.id),
  );
  if (holders.length === 0) return null;
  const window = {
    collectAt: Math.min(...holders.map((h) => h.collectAt)),
    returnAt: Math.max(...holders.map((h) => h.returnAt)),
  };
  const shortfall = findShortfall({
    owned: newQuantity,
    wanted: 0,
    window,
    holders: heldOf(holders, item.id),
  });
  return shortfall ? detailOf(db, holders, item, shortfall, 0) : null;
}
