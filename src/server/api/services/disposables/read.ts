import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requestActions, type RequestActions } from "~/lib/disposables/actions";
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
  assertCcaHead,
  canReadAny,
  canReadCca,
  DISPOSABLE_NOT_FOUND,
  loadViewer,
  NOT_DISPOSABLE_READER,
  type DisposableViewer,
} from "./access";
import { isDisposablesEnabled } from "./flag";

/** The most requests one list answers; the screen says when there are more. */
export const LIST_MAX = 300;
const PROPOSAL_CHOICES_MAX = 100;

const quantity = z.number().int().min(0).max(DISPOSABLE_ITEM_CAP);

/**
 * What a stored row must look like to be shown. A row that fails it (an
 * unknown status, a quantity out of range, a collection day that is not a real
 * date) is COUNTED and SKIPPED, so one bad row never breaks the list (A2, A3).
 */
export const storedRow = z.object({
  id: z.string().min(1),
  ccaID: z.number().int(),
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

export type DisposableRequestView = {
  id: string;
  ccaID: number;
  ccaName: string | null;
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

function toView(
  row: StoredRow,
  viewer: DisposableViewer,
  ccaNames: Map<number, string>,
  people: Map<string, string>,
): DisposableRequestView {
  return {
    id: row.id,
    ccaID: row.ccaID,
    ccaName: ccaNames.get(row.ccaID) ?? null,
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
      row.createdBy !== null ? (people.get(row.createdBy) ?? null) : null,
    can: requestActions({
      isSocialDirector: viewer.isSocialDirector,
      status: row.status,
      isHeadOfCca: viewer.headedCcaIDs.includes(row.ccaID),
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

export type DisposableList = {
  items: DisposableRequestView[];
  /** Stored rows that could not be shown, counted and skipped. */
  skipped: number;
  /** There were more than `LIST_MAX`; narrow the filters. */
  more: boolean;
  viewer: { isSocialDirector: boolean; canCreate: boolean };
  /**
   * Whether anyone can decide requests right now. False means the screen says
   * requests wait because nobody holds the Social director position.
   */
  hasSocialDirector: boolean;
  /** The CCAs the CCA filter offers: all for JCRC, the viewer's own for a head. */
  ccaOptions: { ccaID: number; name: string }[];
};

/**
 * The requests this person may see, filtered by status, CCA and collection
 * day. A head sees their own CCAs'; every JCRC member sees all; anyone else,
 * and a head asking for another CCA, is refused the read (A54).
 */
export async function listRequests(
  db: PrismaClient,
  userID: string,
  input: DisposableListInput,
): Promise<DisposableList> {
  const viewer = await loadViewer(db, userID);
  if (!canReadAny(viewer)) throw notReader();
  if (input.ccaID !== undefined && !canReadCca(viewer, input.ccaID)) {
    throw notReader();
  }
  const days = {
    ...(input.from !== undefined && { gte: input.from }),
    ...(input.to !== undefined && { lte: input.to }),
  };
  const rows = await db.disposableRequest.findMany({
    where: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.ccaID !== undefined
        ? { ccaID: input.ccaID }
        : !viewer.isJcrc && { ccaID: { in: viewer.headedCcaIDs } }),
      ...(Object.keys(days).length > 0 && { collectionDay: days }),
    },
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
  const ccaNames = await namesOf(db, [...new Set(good.map((r) => r.ccaID))]);
  const people = await displayNames(
    db,
    good.flatMap((r) => (r.createdBy !== null ? [r.createdBy] : [])),
  );
  const options = viewer.isJcrc
    ? await db.cCA.findMany({
        select: { ccaID: true, ccaName: true },
        orderBy: { ccaName: "asc" },
      })
    : [...(await namesOf(db, viewer.headedCcaIDs))].map(([ccaID, ccaName]) => ({
        ccaID,
        ccaName,
      }));
  return {
    items: good.map((r) => toView(r, viewer, ccaNames, people)),
    skipped,
    more,
    viewer: {
      isSocialDirector: viewer.isSocialDirector,
      canCreate: viewer.headedCcaIDs.length > 0,
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
  const row = canReadAny(viewer)
    ? await db.disposableRequest.findUnique({ where: { id }, select: SELECT })
    : null;
  const parsed = row ? storedRow.safeParse(row) : null;
  if (!parsed?.success || !canReadCca(viewer, parsed.data.ccaID)) {
    throw new TRPCError({ code: "NOT_FOUND", message: DISPOSABLE_NOT_FOUND });
  }
  const ccaNames = await namesOf(db, [parsed.data.ccaID]);
  const people = await displayNames(
    db,
    parsed.data.createdBy !== null ? [parsed.data.createdBy] : [],
  );
  return toView(parsed.data, viewer, ccaNames, people);
}

/** The CCAs this person heads, for the form's CCA choice. */
export async function headCcaChoices(
  db: PrismaClient,
  userID: string,
): Promise<{ ccaID: number; name: string }[]> {
  const viewer = await loadViewer(db, userID);
  const names = await namesOf(db, viewer.headedCcaIDs);
  return viewer.headedCcaIDs.map((ccaID) => ({
    ccaID,
    name: names.get(ccaID) ?? `CCA ${ccaID}`,
  }));
}

/**
 * The CCA's proposals a request can link to, for a head of that CCA. `taken`
 * marks one that already has a request (one request per proposal).
 */
export async function proposalChoices(
  db: PrismaClient,
  userID: string,
  ccaID: number,
): Promise<{ id: string; title: string; taken: boolean }[]> {
  await assertCcaHead(db, userID, ccaID);
  const proposals = await db.proposal.findMany({
    where: { ccaID },
    orderBy: { updatedAt: "desc" },
    take: PROPOSAL_CHOICES_MAX,
    select: { id: true, title: true },
  });
  if (proposals.length === 0) return [];
  const linked = await db.disposableRequest.findMany({
    where: { proposalID: { in: proposals.map((p) => p.id) } },
    select: { proposalID: true },
  });
  const taken = new Set(linked.map((l) => l.proposalID));
  return proposals.map((p) => ({
    id: p.id,
    title: p.title,
    taken: taken.has(p.id),
  }));
}

/**
 * Whether the navigation shows a Disposables entry: the switch is on and this
 * person can read something. Off is a plain `{ show: false }`; a failed guard
 * read is an error, which the header treats as "hide it".
 */
export async function getEntry(
  db: PrismaClient,
  userID: string,
): Promise<{ show: boolean }> {
  if (!(await isDisposablesEnabled(db))) return { show: false };
  return { show: canReadAny(await loadViewer(db, userID)) };
}
