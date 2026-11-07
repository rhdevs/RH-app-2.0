import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

import { tagProblem, TAG_PROBLEM_CODES } from "~/lib/disposables/events";
import { LOAN_WINDOW_MAX_SECONDS } from "~/lib/equipment/status";
import type { ShortDetail } from "~/lib/equipment/stock";
import type { loanCreateInput } from "~/lib/schemas/equipment";
import { assertEventLeader, type EquipmentAccessDb } from "./access";
import { assertWithinLimit } from "./limits";
import { noticeRequested } from "./notices";
import { stockProblems, type StockItem } from "./stock";

/**
 * Filing a loan. The event is read from the store and the CCA comes from it,
 * never from the form. Order, each step refusing before the next runs:
 *  1. the event exists (the same answer for everyone);
 *  2. the person leads that event's CCA now (disposables' `mayFile`, strict);
 *  3. the event can still be borrowed for (not canceled, declined or ended);
 *  4. the loan runs for no more than 60 days (the same cap approval enforces);
 *  5. the hourly budget (only for a real filing, not the form's preview);
 *  6. every item exists and none is retired.
 * Filing holds no stock. It answers with "looks short" warnings: the lines the
 * hall could not cover if everything already approved stays approved.
 */

export const EQUIPMENT_BAD_EVENT = "EQUIPMENT_BAD_EVENT";
export const EQUIPMENT_BAD_ITEM = "EQUIPMENT_BAD_ITEM";
export const EQUIPMENT_ITEM_RETIRED = "EQUIPMENT_ITEM_RETIRED";
export const EQUIPMENT_WINDOW_TOO_LONG = "EQUIPMENT_WINDOW_TOO_LONG";

type FilingDb = EquipmentAccessDb & PrismaClient;
type CreateInput = z.infer<typeof loanCreateInput>;

export type FilingEvent = {
  eventID: number;
  ccaID: number | null;
  title: string | null;
  startTime: number | null;
  endTime: number | null;
};

const bad = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

/** Steps 1 to 3. */
export async function resolveFiling(
  db: FilingDb,
  userID: string,
  eventID: number,
  now: Date,
): Promise<FilingEvent> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: {
      eventID: true,
      ccaID: true,
      title: true,
      status: true,
      startTime: true,
      endTime: true,
    },
  });
  if (!event) throw bad(EQUIPMENT_BAD_EVENT);
  const ccaID = event.ccaID ?? null;
  await assertEventLeader(db, userID, ccaID);
  const problem = tagProblem(event, Math.floor(now.getTime() / 1000));
  if (problem !== null) throw bad(TAG_PROBLEM_CODES[problem]);
  return {
    eventID: event.eventID,
    ccaID,
    title: event.title,
    startTime: event.startTime ?? null,
    endTime: event.endTime ?? null,
  };
}

/** Step 4. */
function assertWindowLength(input: CreateInput): void {
  if (input.returnAt - input.collectAt > LOAN_WINDOW_MAX_SECONDS) {
    throw bad(EQUIPMENT_WINDOW_TOO_LONG);
  }
}

/** Step 6, and the warnings. */
async function checkLines(
  db: FilingDb,
  input: CreateInput,
  now: Date,
): Promise<{ items: Map<string, StockItem>; warnings: ShortDetail[] }> {
  const rows = await db.equipmentItem.findMany({
    where: { id: { in: input.lines.map((l) => l.itemID) } },
    select: { id: true, name: true, quantity: true, retired: true },
  });
  const items = new Map(rows.map((r) => [r.id, r]));
  for (const line of input.lines) {
    const item = items.get(line.itemID);
    if (!item) throw bad(EQUIPMENT_BAD_ITEM);
    if (item.retired) throw bad(EQUIPMENT_ITEM_RETIRED);
  }
  const warnings = await stockProblems(db, {
    excludeLoanID: null,
    lines: input.lines,
    window: { collectAt: input.collectAt, returnAt: input.returnAt },
    items,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  return { items, warnings };
}

/**
 * The form's live "looks short" preview. Writes no loan. It spends its own
 * hourly budget (`check`), after the access check, so a script cannot use it
 * to hammer the stock reads.
 */
export async function previewLoan(
  db: FilingDb,
  userID: string,
  input: CreateInput,
  now: Date = new Date(),
): Promise<{ warnings: ShortDetail[] }> {
  await resolveFiling(db, userID, input.eventID, now);
  assertWindowLength(input);
  await assertWithinLimit("check", userID);
  const { warnings } = await checkLines(db, input, now);
  return { warnings };
}

export type FiledLoan = {
  id: string;
  eventID: number;
  eventTitle: string | null;
  warnings: ShortDetail[];
};

export async function fileLoan(
  db: FilingDb,
  userID: string,
  input: CreateInput,
  now: Date = new Date(),
): Promise<FiledLoan> {
  const event = await resolveFiling(db, userID, input.eventID, now);
  assertWindowLength(input);
  await assertWithinLimit("file", userID);
  const { warnings } = await checkLines(db, input, now);
  // Every optional field is written explicitly: a missing key never matches a
  // null or false filter on MongoDB. `status` takes the schema default.
  const created = await db.equipmentLoan.create({
    data: {
      eventID: event.eventID,
      ccaID: event.ccaID,
      requestedBy: userID,
      lines: input.lines.map((l) => ({
        itemID: l.itemID.toLowerCase(),
        quantity: l.quantity,
      })),
      collectAt: input.collectAt,
      returnAt: input.returnAt,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      collectedAt: null,
      returnedAt: null,
      returnedBy: null,
      returnPhoto: null,
      returnPhotoType: null,
      returnPhotoSize: null,
      directorNote: null,
      canceledBy: null,
      canceledAt: null,
      cancelReason: null,
      version: 0,
    },
    select: { id: true },
  });
  await noticeRequested(
    db,
    { id: created.id, requestedBy: userID, eventID: event.eventID },
    input.lines.length,
    userID,
  );
  return {
    id: created.id,
    eventID: event.eventID,
    eventTitle: event.title,
    warnings,
  };
}
