import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  eventStateOf,
  tagProblem,
  TAG_PROBLEM_CODES,
  type EventState,
} from "~/lib/disposables/events";
import { equipmentPhotoFolder } from "~/lib/equipment/photo";
import {
  holdsStockFor,
  isOverdue,
  LOAN_STATUSES,
  STOCK_HOLDING_STATUSES,
  type LoanStatus,
} from "~/lib/equipment/status";
import type { loanListInput } from "~/lib/schemas/equipment";
import { displayNames } from "~/server/api/services/proposals/names";
import { namesOf } from "~/server/api/services/disposables/read";
import {
  assertBoardReader,
  directorOrLeader,
  EQUIPMENT_NOT_FOUND,
  isEventLeader,
  loadBoardViewer,
  type EquipmentAccessDb,
} from "./access";
import { isEquipmentEnabled } from "./flag";

/** The most loans one board answers; the screen says when there are more. */
export const BOARD_MAX = 300;

/**
 * What a stored loan must look like to be shown. A row that fails it (an
 * unknown status, a window that is not a window) is COUNTED and SKIPPED, so
 * one bad row never breaks the board.
 */
const storedLoan = z.object({
  id: z.string().min(1),
  eventID: z.number().int(),
  ccaID: z.number().int().nullable(),
  requestedBy: z.string().nullable(),
  lines: z
    .array(z.object({ itemID: z.string(), quantity: z.number().int().min(1) }))
    .min(1),
  collectAt: z.number().int(),
  returnAt: z.number().int(),
  status: z.enum(LOAN_STATUSES),
  version: z.number().int(),
  decidedBy: z.string().nullable(),
  decidedAt: z.date().nullable(),
  reason: z.string().nullable(),
  collectedAt: z.date().nullable(),
  returnedAt: z.date().nullable(),
  returnedBy: z.string().nullable(),
  returnPhoto: z.string().nullable(),
  directorNote: z.string().nullable(),
  canceledBy: z.string().nullable(),
  canceledAt: z.date().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.date(),
});
export type StoredLoan = z.infer<typeof storedLoan>;

const SELECT = {
  id: true,
  eventID: true,
  ccaID: true,
  requestedBy: true,
  lines: { select: { itemID: true, quantity: true } },
  collectAt: true,
  returnAt: true,
  status: true,
  version: true,
  decidedBy: true,
  decidedAt: true,
  reason: true,
  collectedAt: true,
  returnedAt: true,
  returnedBy: true,
  returnPhoto: true,
  directorNote: true,
  canceledBy: true,
  canceledAt: true,
  cancelReason: true,
  createdAt: true,
} as const;

export type LoanLineView = {
  itemID: string;
  /** The item's name, or null when the item has been removed. */
  name: string | null;
  quantity: number;
};

export type LoanView = {
  id: string;
  eventID: number;
  /** The event's live title, or null when it is gone or untitled. */
  eventTitle: string | null;
  eventState: EventState;
  ccaID: number | null;
  ccaName: string | null;
  hallWide: boolean;
  requestedBy: string | null;
  lines: LoanLineView[];
  collectAt: number;
  returnAt: number;
  status: LoanStatus;
  version: number;
  /** Approved or collected, and past its return time. */
  overdue: boolean;
  /**
   * Holding stock now: collected (always), or approved and the event is not
   * canceled or declined.
   */
  holdsStock: boolean;
  createdAt: string;
};

/** What a viewer may do to one loan, worked out on the server. */
export type LoanActions = {
  approve: boolean;
  reject: boolean;
  cancel: boolean;
  collect: boolean;
  markReturned: boolean;
  /** Set or replace the director note on a returned loan. */
  note: boolean;
};

export type ViewerRole = "director" | "leader" | "reader";

/** The reason, the note and the photo flag go only to the director and the leaders. */
export type LoanDetail = LoanView & {
  reason: string | null;
  directorNote: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** A director cancel, kept apart from the approval it may follow. */
  canceledAt: string | null;
  canceledBy: string | null;
  cancelReason: string | null;
  collectedAt: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
  hasPhoto: boolean;
  can: LoanActions;
  viewerIs: ViewerRole;
};

type Context = {
  nowSeconds: number;
  ccaNames: Map<number, string>;
  people: Map<string, string>;
  items: Map<string, string>;
  events: Map<number, { title: string | null; state: EventState }>;
};

async function contextFor(
  db: PrismaClient,
  rows: StoredLoan[],
  nowSeconds: number,
): Promise<Context> {
  const eventIDs = [...new Set(rows.map((r) => r.eventID))];
  const events = eventIDs.length
    ? await db.event.findMany({
        where: { eventID: { in: eventIDs } },
        select: { eventID: true, title: true, status: true },
      })
    : [];
  const itemIDs = [
    ...new Set(rows.flatMap((r) => r.lines.map((l) => l.itemID))),
  ];
  const items = itemIDs.length
    ? await db.equipmentItem.findMany({
        where: { id: { in: itemIDs } },
        select: { id: true, name: true },
      })
    : [];
  const byEvent = new Map(events.map((e) => [e.eventID, e]));
  return {
    nowSeconds,
    ccaNames: await namesOf(db, [
      ...new Set(rows.flatMap((r) => (r.ccaID !== null ? [r.ccaID] : []))),
    ]),
    people: await displayNames(
      db,
      rows.flatMap((r) =>
        [r.requestedBy, r.decidedBy, r.returnedBy, r.canceledBy].filter(
          (p): p is string => p !== null,
        ),
      ),
    ),
    items: new Map(items.map((i) => [i.id, i.name])),
    events: new Map(
      eventIDs.map((id) => {
        const e = byEvent.get(id) ?? null;
        const title = (e?.title ?? "").trim();
        return [
          id,
          { title: title === "" ? null : title, state: eventStateOf(e) },
        ];
      }),
    ),
  };
}

function toView(row: StoredLoan, c: Context): LoanView {
  const event = c.events.get(row.eventID);
  const state = event?.state ?? "gone";
  return {
    id: row.id,
    eventID: row.eventID,
    eventTitle: event?.title ?? null,
    eventState: state,
    ccaID: row.ccaID,
    ccaName: row.ccaID === null ? null : (c.ccaNames.get(row.ccaID) ?? null),
    hallWide: row.ccaID === null,
    requestedBy:
      row.requestedBy === null ? null : (c.people.get(row.requestedBy) ?? null),
    lines: row.lines.map((l) => ({
      itemID: l.itemID,
      name: c.items.get(l.itemID) ?? null,
      quantity: l.quantity,
    })),
    collectAt: row.collectAt,
    returnAt: row.returnAt,
    status: row.status,
    version: row.version,
    overdue: isOverdue(row, c.nowSeconds),
    holdsStock: holdsStockFor(row.status, state),
    createdAt: row.createdAt.toISOString(),
  };
}

export function actionsFor(
  status: LoanStatus,
  viewerIs: ViewerRole,
  eventState: EventState = "ok",
): LoanActions {
  const director = viewerIs === "director";
  const acts = director || viewerIs === "leader";
  return {
    approve: director && status === "requested",
    reject: director && status === "requested",
    cancel: acts && (status === "requested" || status === "approved"),
    collect:
      acts &&
      status === "approved" &&
      eventState !== "canceled" &&
      eventState !== "declined",
    markReturned: acts && status === "collected",
    note: director && status === "returned",
  };
}

export type Board = {
  items: LoanView[];
  skipped: number;
  more: boolean;
  viewer: { isDirector: boolean };
  ccaOptions: { ccaID: number; name: string }[];
};

type ListInput = z.infer<typeof loanListInput>;

function whereFor(
  input: ListInput,
  nowSeconds: number,
): Prisma.EquipmentLoanWhereInput {
  const and: Prisma.EquipmentLoanWhereInput[] = [];
  if (input.status !== null) and.push({ status: input.status });
  if (input.cca === "hall") {
    and.push({ OR: [{ ccaID: null }, { ccaID: { isSet: false } }] });
  } else if (input.cca !== null) {
    and.push({ ccaID: input.cca });
  }
  if (input.overdueOnly) {
    and.push({
      status: { in: [...STOCK_HOLDING_STATUSES] },
      returnAt: { lt: nowSeconds },
    });
  }
  return and.length ? { AND: and } : {};
}

/**
 * The board: every loan, newest window first. Read by a current head of any
 * CCA, a live `jcrc` holder, the Social director and admins, and nobody else.
 * It carries no photo, no reason and no note.
 */
export async function listLoans(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
  input: ListInput,
  now: Date = new Date(),
): Promise<Board> {
  const viewer = await assertBoardReader(db, userID);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const found = await db.equipmentLoan.findMany({
    where: whereFor(input, nowSeconds),
    orderBy: [{ collectAt: "desc" }, { createdAt: "desc" }],
    take: BOARD_MAX + 1,
    select: SELECT,
  });
  const good: StoredLoan[] = [];
  let skipped = 0;
  for (const row of found.slice(0, BOARD_MAX)) {
    const parsed = storedLoan.safeParse(row);
    if (parsed.success && parsed.data.returnAt > parsed.data.collectAt) {
      good.push(parsed.data);
    } else {
      skipped += 1;
    }
  }
  const context = await contextFor(db, good, nowSeconds);
  const ccas = await db.cCA.findMany({
    select: { ccaID: true, ccaName: true },
    orderBy: { ccaName: "asc" },
    take: 500,
  });
  return {
    items: good.map((r) => toView(r, context)),
    skipped,
    more: found.length > BOARD_MAX,
    viewer: { isDirector: viewer.isDirector },
    ccaOptions: ccas.map((c) => ({ ccaID: c.ccaID, name: c.ccaName })),
  };
}

/** The stored loan, or NOT_FOUND. */
export async function loadLoan(
  db: Pick<PrismaClient, "equipmentLoan">,
  id: string,
): Promise<StoredLoan> {
  const row = await db.equipmentLoan.findUnique({
    where: { id },
    select: SELECT,
  });
  const parsed = row === null ? null : storedLoan.safeParse(row);
  if (!parsed?.success) {
    throw new TRPCError({ code: "NOT_FOUND", message: EQUIPMENT_NOT_FOUND });
  }
  return parsed.data;
}

/**
 * One loan, for a board reader. The reason, the director's note and whether
 * there is a photo go only to the Social director and the event's leaders.
 */
export async function getLoan(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
  id: string,
  now: Date = new Date(),
): Promise<LoanDetail> {
  const viewer = await assertBoardReader(db, userID);
  const row = await loadLoan(db, id);
  const leader = viewer.isDirector
    ? false
    : await isEventLeader(db, userID, row.ccaID);
  const viewerIs: ViewerRole = viewer.isDirector
    ? "director"
    : leader
      ? "leader"
      : "reader";
  const context = await contextFor(db, [row], Math.floor(now.getTime() / 1000));
  const sees = viewerIs !== "reader";
  return {
    ...toView(row, context),
    reason: sees ? row.reason : null,
    directorNote: sees ? row.directorNote : null,
    canceledAt: sees ? (row.canceledAt?.toISOString() ?? null) : null,
    canceledBy:
      sees && row.canceledBy !== null
        ? (context.people.get(row.canceledBy) ?? null)
        : null,
    cancelReason: sees ? row.cancelReason : null,
    decidedAt: sees ? (row.decidedAt?.toISOString() ?? null) : null,
    decidedBy:
      sees && row.decidedBy !== null
        ? (context.people.get(row.decidedBy) ?? null)
        : null,
    collectedAt: row.collectedAt?.toISOString() ?? null,
    returnedAt: row.returnedAt?.toISOString() ?? null,
    returnedBy:
      row.returnedBy === null
        ? null
        : (context.people.get(row.returnedBy) ?? null),
    hasPhoto: sees && row.returnPhoto !== null,
    can: actionsFor(
      row.status,
      viewerIs,
      context.events.get(row.eventID)?.state,
    ),
    viewerIs,
  };
}

/**
 * May this person see the return photo of this loan? The Social director and
 * the event's leaders, nobody else (not the board's other readers, not admins
 * who are neither). "No loan", "no photo" and "not yours" all refuse with the
 * same NOT_FOUND, so the route answers the same bare 404 for each.
 */
export async function authorizePhotoRead(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
  id: string,
): Promise<{ pathname: string; contentType: string; size: number }> {
  const row = await db.equipmentLoan.findUnique({
    where: { id },
    select: {
      ccaID: true,
      returnPhoto: true,
      returnPhotoType: true,
      returnPhotoSize: true,
    },
  });
  const hidden = () =>
    new TRPCError({ code: "NOT_FOUND", message: EQUIPMENT_NOT_FOUND });
  if (row === null) throw hidden();
  if (
    row.returnPhoto === null ||
    row.returnPhotoType === null ||
    row.returnPhotoSize === null
  ) {
    throw hidden();
  }
  const who = await directorOrLeader(db, userID, row.ccaID ?? null);
  if (!who.director && !who.leader) throw hidden();
  // Defence in depth: the stored name must sit in THIS loan folder, so a row
  // written wrongly can never serve another loan's file.
  if (!row.returnPhoto.startsWith(equipmentPhotoFolder(id))) throw hidden();
  return {
    pathname: row.returnPhoto,
    contentType: row.returnPhotoType,
    size: row.returnPhotoSize,
  };
}

/**
 * Whether the navigation shows an Equipment entry: the switch is on and this
 * person may read the board. Off is a plain `{ show: false }`; a failed guard
 * read is an error, which the header treats as "hide it".
 */
export async function getEntry(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
): Promise<{ show: boolean }> {
  if (!(await isEquipmentEnabled(db))) return { show: false };
  return { show: (await loadBoardViewer(db, userID)).canRead };
}

/** Whether this person may file a loan for this event now (the event page link). */
export async function canFileForEvent(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
  eventID: number,
  now: Date = new Date(),
): Promise<{ canFile: boolean }> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { ccaID: true, title: true, status: true, endTime: true },
  });
  if (!event) return { canFile: false };
  if (!(await isEventLeader(db, userID, event.ccaID ?? null))) {
    return { canFile: false };
  }
  return {
    canFile: tagProblem(event, Math.floor(now.getTime() / 1000)) === null,
  };
}

export type LoanDraft = {
  eventID: number;
  title: string | null;
  /** Epoch seconds, or null when the event has none yet. */
  startTime: number | null;
  endTime: number | null;
  ccaName: string | null;
  hallWide: boolean;
  /** Why the event cannot be borrowed for, or null. */
  problem: string | null;
};

/**
 * What the new-loan form starts with: the event, its times and its CCA. Only
 * for someone who may file for it; anyone else is refused with the same answer
 * as a missing event, so the id tells a stranger nothing.
 */
export async function draftFor(
  db: PrismaClient & EquipmentAccessDb,
  userID: string,
  eventID: number,
  now: Date = new Date(),
): Promise<LoanDraft> {
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
  const hidden = () =>
    new TRPCError({ code: "NOT_FOUND", message: EQUIPMENT_NOT_FOUND });
  if (!event) throw hidden();
  const ccaID = event.ccaID ?? null;
  if (!(await isEventLeader(db, userID, ccaID))) throw hidden();
  const problem = tagProblem(event, Math.floor(now.getTime() / 1000));
  const names =
    ccaID === null ? new Map<number, string>() : await namesOf(db, [ccaID]);
  return {
    eventID: event.eventID,
    title: (event.title?.trim() ?? "") || null,
    startTime: event.startTime ?? null,
    endTime: event.endTime ?? null,
    ccaName: ccaID === null ? null : (names.get(ccaID) ?? null),
    hallWide: ccaID === null,
    problem: problem === null ? null : TAG_PROBLEM_CODES[problem],
  };
}
