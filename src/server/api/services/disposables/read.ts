import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requestActions, type RequestActions } from "~/lib/disposables/actions";
import { tagProblem } from "~/lib/disposables/events";
import {
  DISPOSABLE_STATUSES,
  type DisposableStatus,
} from "~/lib/disposables/status";
import {
  DISPOSABLE_ITEM_CAP,
  isRealDayKey,
  type DisposableListInput,
} from "~/lib/schemas/disposable";
import { currentSocialDirectorIDs } from "~/server/api/services/directorGuard";
import { displayNames } from "~/server/api/services/proposals/names";
import {
  canReadAny,
  canReadCca,
  DISPOSABLE_NOT_FOUND,
  loadFiler,
  loadViewer,
  mayFile,
  NOT_DISPOSABLE_READER,
  type DisposableViewer,
} from "./access";
import {
  liveEventsOf,
  requestEventOf,
  type LiveEvents,
  type RequestEvent,
} from "./eventTag";
import { isDisposablesEnabled } from "./flag";

/** The most requests one list answers; the screen says when there are more. */
export const LIST_MAX = 300;
const PROPOSAL_CHOICES_MAX = 100;
/** The most events the form's picker offers; far above a real term. */
export const EVENT_CHOICES_MAX = 100;
/** Events read before the taggable check; the picker keeps the first 100. */
const EVENT_SCAN_MAX = 300;
/** The most other requests read for the events on one list. */
const SAME_EVENT_MAX = 300;

const quantity = z.number().int().min(0).max(DISPOSABLE_ITEM_CAP);

/**
 * What a stored row must look like to be shown. A row that fails it (an
 * unknown status, a quantity out of range, a collection day that is not a real
 * date) is COUNTED and SKIPPED, so one bad row never breaks the list (A2, A3).
 */
export const storedRow = z.object({
  id: z.string().min(1),
  /** Null is a request for a hall-wide event: it belongs to no CCA. */
  ccaID: z.number().int().nullable(),
  eventID: z.number().int().nullable(),
  eventTitle: z.string().nullable(),
  createdBy: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  proposalID: z.string().nullable(),
  plates: quantity,
  cups: quantity,
  bowls: quantity,
  forks: quantity,
  spoons: quantity,
  collectionDay: z.string().refine(isRealDayKey),
  collectionTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  status: z.enum(DISPOSABLE_STATUSES),
  version: z.number().int(),
  decisionNote: z.string().nullable(),
  decidedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type StoredRow = z.infer<typeof storedRow>;

export const SELECT = {
  id: true,
  ccaID: true,
  eventID: true,
  eventTitle: true,
  createdBy: true,
  title: true,
  description: true,
  proposalID: true,
  plates: true,
  cups: true,
  bowls: true,
  forks: true,
  spoons: true,
  collectionDay: true,
  collectionTime: true,
  status: true,
  version: true,
  decisionNote: true,
  decidedAt: true,
  createdAt: true,
} as const;

/** Another request for the same event, shown together with this one. */
export type SameEventRequest = {
  id: string;
  title: string;
  status: DisposableStatus;
  collectionDay: string;
  collectionTime: string;
  plates: number;
  cups: number;
  bowls: number;
  forks: number;
  spoons: number;
};

export type DisposableRequestView = {
  id: string;
  /** Null for a request for a hall-wide event. */
  ccaID: number | null;
  ccaName: string | null;
  /** True for a request for a hall-wide event (no CCA). */
  hallWide: boolean;
  /**
   * The event it is for: its live title while the event exists, else the title
   * kept when it was filed, and whether the event is canceled, declined or
   * gone. Null for a request tagged only to a proposal with no event yet.
   */
  event: RequestEvent | null;
  /** The other requests for the same event that this viewer may see. */
  sameEvent: SameEventRequest[];
  title: string;
  description: string;
  proposalID: string | null;
  plates: number;
  cups: number;
  bowls: number;
  forks: number;
  spoons: number;
  collectionDay: string;
  collectionTime: string;
  status: DisposableStatus;
  version: number;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** The requester's display name, or null (no name on file, or deleted). */
  requestedBy: string | null;
  /** What THIS viewer may do, worked out on the server. */
  can: RequestActions;
};

/**
 * Who may read a request. A JCRC member reads all. A head reads their own CCAs'.
 * Whoever FILED a hall-wide request reads it, whatever they hold now; once that
 * account is deleted (`createdBy` null) only the JCRC reads it.
 */
export function canReadRow(
  viewer: DisposableViewer,
  userID: string,
  row: { ccaID: number | null; createdBy: string | null },
): boolean {
  if (viewer.isJcrc) return true;
  if (row.ccaID === null) return row.createdBy === userID;
  return viewer.headedCcaIDs.includes(row.ccaID);
}

/** The same rule as `canReadRow`, as a query filter. */
function readScope(
  viewer: DisposableViewer,
  userID: string,
): Prisma.DisposableRequestWhereInput {
  if (viewer.isJcrc) return {};
  return {
    OR: [
      ...(viewer.headedCcaIDs.length > 0
        ? [{ ccaID: { in: viewer.headedCcaIDs } }]
        : []),
      { ccaID: null, createdBy: userID },
    ],
  };
}

/** Has this person filed a request for a hall-wide event (so may read it)? */
async function filedHallWide(
  db: Pick<PrismaClient, "disposableRequest">,
  userID: string,
): Promise<boolean> {
  const n = await db.disposableRequest.count({
    where: { ccaID: null, createdBy: userID },
  });
  return n > 0;
}

type Context = {
  viewer: DisposableViewer;
  userID: string;
  ccaNames: Map<number, string>;
  people: Map<string, string>;
  live: LiveEvents;
  siblings: Map<number, StoredRow[]>;
};

function toView(row: StoredRow, c: Context): DisposableRequestView {
  const hallWide = row.ccaID === null;
  return {
    id: row.id,
    ccaID: row.ccaID,
    ccaName: row.ccaID !== null ? (c.ccaNames.get(row.ccaID) ?? null) : null,
    hallWide,
    event: requestEventOf(row, c.live),
    sameEvent:
      row.eventID === null
        ? []
        : (c.siblings.get(row.eventID) ?? [])
            .filter((o) => o.id !== row.id)
            .map((o) => ({
              id: o.id,
              title: o.title,
              status: o.status,
              collectionDay: o.collectionDay,
              collectionTime: o.collectionTime,
              plates: o.plates,
              cups: o.cups,
              bowls: o.bowls,
              forks: o.forks,
              spoons: o.spoons,
            })),
    title: row.title,
    description: row.description,
    proposalID: row.proposalID,
    plates: row.plates,
    cups: row.cups,
    bowls: row.bowls,
    forks: row.forks,
    spoons: row.spoons,
    collectionDay: row.collectionDay,
    collectionTime: row.collectionTime,
    status: row.status,
    version: row.version,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    requestedBy:
      row.createdBy !== null ? (c.people.get(row.createdBy) ?? null) : null,
    can: requestActions({
      isSocialDirector: c.viewer.isSocialDirector,
      status: row.status,
      isHeadOfCca:
        row.ccaID !== null && c.viewer.headedCcaIDs.includes(row.ccaID),
      isHallWideFiler: hallWide && row.createdBy === c.userID,
    }),
  };
}

const notReader = () =>
  new TRPCError({ code: "FORBIDDEN", message: NOT_DISPOSABLE_READER });

export async function namesOf(
  db: Pick<PrismaClient, "cCA">,
  ccaIDs: readonly number[],
): Promise<Map<number, string>> {
  if (ccaIDs.length === 0) return new Map();
  const rows = await db.cCA.findMany({
    where: { ccaID: { in: [...ccaIDs] } },
    select: { ccaID: true, ccaName: true },
  });
  return new Map(rows.map((r) => [r.ccaID, r.ccaName]));
}

/**
 * Names, event states and the other requests for the same events, for the rows
 * to show. The other requests are read under the SAME read scope as the list,
 * so a viewer never sees a request they could not open themselves.
 */
async function contextFor(
  db: PrismaClient,
  viewer: DisposableViewer,
  userID: string,
  rows: StoredRow[],
): Promise<Context> {
  const ccaIDs = [
    ...new Set(rows.flatMap((r) => (r.ccaID !== null ? [r.ccaID] : []))),
  ];
  const eventIDs = [
    ...new Set(rows.flatMap((r) => (r.eventID !== null ? [r.eventID] : []))),
  ];
  const others =
    eventIDs.length === 0
      ? []
      : await db.disposableRequest.findMany({
          where: {
            AND: [readScope(viewer, userID), { eventID: { in: eventIDs } }],
          },
          orderBy: [{ collectionDay: "asc" }, { createdAt: "asc" }],
          take: SAME_EVENT_MAX,
          select: SELECT,
        });
  const siblings = new Map<number, StoredRow[]>();
  for (const o of others) {
    const parsed = storedRow.safeParse(o);
    if (!parsed.success || parsed.data.eventID === null) continue;
    const list = siblings.get(parsed.data.eventID) ?? [];
    list.push(parsed.data);
    siblings.set(parsed.data.eventID, list);
  }
  return {
    viewer,
    userID,
    ccaNames: await namesOf(db, ccaIDs),
    people: await displayNames(
      db,
      rows.flatMap((r) => (r.createdBy !== null ? [r.createdBy] : [])),
    ),
    live: await liveEventsOf(db, rows),
    siblings,
  };
}

export type DisposableList = {
  items: DisposableRequestView[];
  /** Stored rows that could not be shown, counted and skipped. */
  skipped: number;
  /** There were more than `LIST_MAX`; narrow the filters. */
  more: boolean;
  viewer: {
    isSocialDirector: boolean;
    /** May file for something: heads, and the JCRC and admins (hall-wide). */
    canCreate: boolean;
    /** The CCA filter offers "Hall-wide" (the JCRC, and whoever filed one). */
    showHallWide: boolean;
  };
  /**
   * Whether anyone can decide requests right now. False means the screen says
   * requests wait because nobody holds the Social director position.
   */
  hasSocialDirector: boolean;
  /** The CCAs the CCA filter offers: all for JCRC, the viewer's own for a head. */
  ccaOptions: { ccaID: number; name: string }[];
};

/**
 * The requests this person may see, filtered by status, CCA (or hall-wide),
 * event and collection day. A head sees their own CCAs'; every JCRC member sees
 * all; whoever filed a hall-wide request sees that one; anyone else, and a head
 * asking for another CCA, is refused the read (A54).
 */
export async function listRequests(
  db: PrismaClient,
  userID: string,
  input: DisposableListInput,
): Promise<DisposableList> {
  const viewer = await loadViewer(db, userID);
  const ownHallWide = viewer.isJcrc ? false : await filedHallWide(db, userID);
  if (!canReadAny(viewer) && !ownHallWide) throw notReader();
  if (input.ccaID !== undefined && !canReadCca(viewer, input.ccaID)) {
    throw notReader();
  }
  const days = {
    ...(input.from !== undefined && { gte: input.from }),
    ...(input.to !== undefined && { lte: input.to }),
  };
  const and: Prisma.DisposableRequestWhereInput[] = [readScope(viewer, userID)];
  if (input.status !== undefined) and.push({ status: input.status });
  if (input.ccaID !== undefined) and.push({ ccaID: input.ccaID });
  if (input.hallWide === true) and.push({ ccaID: null });
  if (input.eventID !== undefined) and.push({ eventID: input.eventID });
  if (Object.keys(days).length > 0) and.push({ collectionDay: days });

  const rows = await db.disposableRequest.findMany({
    where: { AND: and },
    orderBy: [{ collectionDay: "asc" }, { createdAt: "asc" }],
    take: LIST_MAX + 1,
    select: SELECT,
  });
  const more = rows.length > LIST_MAX;
  const good: StoredRow[] = [];
  let skipped = 0;
  for (const row of rows.slice(0, LIST_MAX)) {
    const parsed = storedRow.safeParse(row);
    if (parsed.success) good.push(parsed.data);
    else skipped += 1;
  }
  const context = await contextFor(db, viewer, userID, good);
  const options = viewer.isJcrc
    ? await db.cCA.findMany({
        select: { ccaID: true, ccaName: true },
        orderBy: { ccaName: "asc" },
      })
    : [...(await namesOf(db, viewer.headedCcaIDs))].map(([ccaID, ccaName]) => ({
        ccaID,
        ccaName,
      }));
  const filer = await loadFiler(db, userID);
  return {
    items: good.map((r) => toView(r, context)),
    skipped,
    more,
    viewer: {
      isSocialDirector: viewer.isSocialDirector,
      canCreate: filer.headedCcaIDs.length > 0 || filer.hallWide,
      showHallWide: viewer.isJcrc || ownHallWide,
    },
    hasSocialDirector:
      viewer.isSocialDirector ||
      (await currentSocialDirectorIDs(db, new Date())).length > 0,
    ccaOptions: options.map((o) => ({ ccaID: o.ccaID, name: o.ccaName })),
  };
}

/** One request, for the edit form. A missing id and one you may not read are the same NOT_FOUND. */
export async function getRequest(
  db: PrismaClient,
  userID: string,
  id: string,
): Promise<DisposableRequestView> {
  const viewer = await loadViewer(db, userID);
  const row = await db.disposableRequest.findUnique({
    where: { id },
    select: SELECT,
  });
  const parsed = row ? storedRow.safeParse(row) : null;
  if (!parsed?.success || !canReadRow(viewer, userID, parsed.data)) {
    throw new TRPCError({ code: "NOT_FOUND", message: DISPOSABLE_NOT_FOUND });
  }
  const context = await contextFor(db, viewer, userID, [parsed.data]);
  return toView(parsed.data, context);
}

export type EventChoice = {
  eventID: number;
  title: string;
  ccaID: number | null;
  ccaName: string | null;
  /** Epoch seconds, for the form's collection-day default. */
  startTime: number | null;
  endTime: number | null;
};

/**
 * The events this person may tag a request to, for the form's picker: events of
 * the CCAs they head, plus hall-wide events when they may file for those, that
 * are not canceled, declined or ended. The same rule the server applies when
 * filing (`tagProblem`), so the picker cannot offer what filing would refuse.
 * Bounded: the database narrows by owner and end time and returns the most
 * recent by start time, then the rule is applied again here (a status the query
 * cannot express).
 */
export async function eventChoices(
  db: PrismaClient,
  userID: string,
  now: Date = new Date(),
): Promise<EventChoice[]> {
  const filer = await loadFiler(db, userID);
  const owners: Prisma.EventWhereInput[] = [
    ...(filer.headedCcaIDs.length > 0
      ? [{ ccaID: { in: filer.headedCcaIDs } }]
      : []),
    ...(filer.hallWide ? [{ ccaID: null }, { ccaID: { isSet: false } }] : []),
  ];
  if (owners.length === 0) return [];
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const events = await db.event.findMany({
    where: {
      AND: [
        { OR: owners },
        {
          OR: [
            { endTime: null },
            { endTime: { isSet: false } },
            { endTime: { gt: nowSeconds } },
          ],
        },
      ],
    },
    orderBy: [{ startTime: "desc" }, { eventID: "desc" }],
    take: EVENT_SCAN_MAX,
    select: {
      eventID: true,
      ccaID: true,
      title: true,
      status: true,
      startTime: true,
      endTime: true,
    },
  });
  // Newest first so old events with no end time cannot crowd out upcoming
  // ones; shown oldest first.
  const taggable = events
    .filter((e) => tagProblem(e, nowSeconds) === null)
    .slice(0, EVENT_CHOICES_MAX)
    .reverse();
  const names = await namesOf(db, [
    ...new Set(taggable.flatMap((e) => (e.ccaID !== null ? [e.ccaID] : []))),
  ]);
  return taggable.map((e) => ({
    eventID: e.eventID,
    title: (e.title ?? "").trim(),
    ccaID: e.ccaID ?? null,
    ccaName:
      e.ccaID !== null && e.ccaID !== undefined
        ? (names.get(e.ccaID) ?? null)
        : null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
  }));
}

/**
 * Whether this person may file a request for this event right now: the filing
 * rule and the taggable rule together. For the link on the event page, which is
 * shown only to people who can use it.
 */
export async function canFileForEvent(
  db: PrismaClient,
  userID: string,
  eventID: number,
  now: Date = new Date(),
): Promise<{ canFile: boolean }> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { ccaID: true, title: true, status: true, endTime: true },
  });
  if (!event) return { canFile: false };
  if (!(await mayFile(db, userID, event.ccaID ?? null))) {
    return { canFile: false };
  }
  return {
    canFile: tagProblem(event, Math.floor(now.getTime() / 1000)) === null,
  };
}

export type ProposalChoice = {
  id: string;
  title: string;
  ccaID: number;
  ccaName: string | null;
  /** The proposal already has a request (one request per proposal). */
  taken: boolean;
  /** The proposal already has an event: tag the request to that event instead. */
  eventID: number | null;
};

/**
 * The proposals of the CCAs this person heads, for a request tagged to a
 * proposal that has no event yet. Only a head files for a proposal.
 */
export async function proposalChoices(
  db: PrismaClient,
  userID: string,
): Promise<ProposalChoice[]> {
  const filer = await loadFiler(db, userID);
  if (filer.headedCcaIDs.length === 0) return [];
  const proposals = await db.proposal.findMany({
    where: { ccaID: { in: filer.headedCcaIDs } },
    orderBy: { updatedAt: "desc" },
    take: PROPOSAL_CHOICES_MAX,
    select: { id: true, title: true, ccaID: true, eventID: true },
  });
  if (proposals.length === 0) return [];
  const linked = await db.disposableRequest.findMany({
    where: { proposalID: { in: proposals.map((p) => p.id) } },
    select: { proposalID: true },
  });
  const taken = new Set(linked.map((l) => l.proposalID));
  const eventIDs = proposals.flatMap((p) =>
    p.eventID !== null ? [p.eventID] : [],
  );
  const existing =
    eventIDs.length === 0
      ? []
      : await db.event.findMany({
          where: { eventID: { in: eventIDs } },
          select: { eventID: true },
        });
  const live = new Set(existing.map((e) => e.eventID));
  const names = await namesOf(db, filer.headedCcaIDs);
  return proposals.map((p) => ({
    id: p.id,
    title: p.title,
    ccaID: p.ccaID,
    ccaName: names.get(p.ccaID) ?? null,
    taken: taken.has(p.id),
    eventID: p.eventID !== null && live.has(p.eventID) ? p.eventID : null,
  }));
}

/**
 * Whether the navigation shows a Disposables entry: the switch is on and this
 * person can read something (including a hall-wide request they filed). Off is
 * a plain `{ show: false }`; a failed guard read is an error, which the header
 * treats as "hide it".
 */
export async function getEntry(
  db: PrismaClient,
  userID: string,
): Promise<{ show: boolean }> {
  if (!(await isDisposablesEnabled(db))) return { show: false };
  const viewer = await loadViewer(db, userID);
  return {
    show: canReadAny(viewer) || (await filedHallWide(db, userID)),
  };
}
