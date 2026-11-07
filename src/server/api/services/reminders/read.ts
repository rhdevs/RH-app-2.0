import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { daysBetween } from "~/lib/reminders/days";
import { isRealDayKey } from "~/lib/schemas/disposable";
import { sgtDayKey } from "~/lib/time/sgt";
import { isDisposablesEnabled } from "~/server/api/services/disposables/flag";
import {
  isSocialDirector,
  NOT_DIRECTOR,
} from "~/server/api/services/directorGuard";
import { displayNames } from "~/server/api/services/proposals/names";
import { directedOrRefuse, headedOrRefuse, REMINDER_NOT_FOUND } from "./access";
import { isRemindersEnabled } from "./flag";

/** The most rows one list answers; the screen says when there are more. */
export const LIST_MAX = 200;

/**
 * What a stored broadcast must look like to be shown. A row that fails it (an
 * unknown status, a deadline that is not a real date) is COUNTED and SKIPPED,
 * so one bad row never breaks a list (A2).
 */
export const storedBroadcast = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i),
  createdBy: z.string().nullable(),
  title: z.string().min(1),
  message: z.string(),
  deadline: z.string().refine(isRealDayKey),
  status: z.enum(["active", "cancelled"]),
  createdAt: z.date(),
});
export type StoredBroadcast = z.infer<typeof storedBroadcast>;

export const BROADCAST_SELECT = {
  id: true,
  createdBy: true,
  title: true,
  message: true,
  deadline: true,
  status: true,
  createdAt: true,
} as const;

const HEX_ID = /^[a-f\d]{24}$/i;
const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: REMINDER_NOT_FOUND });
const notDirector = () =>
  new TRPCError({ code: "FORBIDDEN", message: NOT_DIRECTOR });

async function ccaNames(
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

/** Stored broadcasts by id; a malformed id or row is counted, never thrown. */
async function loadBroadcasts(
  db: Pick<PrismaClient, "reminderBroadcast">,
  ids: readonly string[],
): Promise<{ good: Map<string, StoredBroadcast>; skipped: number }> {
  const wanted = [...new Set(ids)];
  const valid = wanted.filter((id) => HEX_ID.test(id));
  let skipped = wanted.length - valid.length;
  const good = new Map<string, StoredBroadcast>();
  if (valid.length === 0) return { good, skipped };
  const rows = await db.reminderBroadcast.findMany({
    where: { id: { in: valid } },
    select: BROADCAST_SELECT,
  });
  for (const row of rows) {
    const parsed = storedBroadcast.safeParse(row);
    if (parsed.success) good.set(parsed.data.id, parsed.data);
    else skipped += 1;
  }
  skipped += valid.length - rows.length;
  return { good, skipped };
}

/* ---- the director's side --------------------------------------------------- */

export type OutboxItem = {
  id: string;
  title: string;
  deadline: string;
  status: "active" | "cancelled";
  /** Of the CCAs this viewer directs. */
  total: number;
  done: number;
  createdAt: string;
};

/** The CCAs this director may address, for the send form. */
export async function ccaChoices(
  db: PrismaClient,
  userID: string,
): Promise<{ ccaID: number; name: string }[]> {
  const directed = await directedOrRefuse(db, userID);
  if (directed.length === 0) throw notDirector();
  const names = await ccaNames(db, directed);
  return directed.map((ccaID) => ({
    ccaID,
    name: names.get(ccaID) ?? `CCA ${ccaID}`,
  }));
}

/**
 * Broadcasts that address a CCA this person directs, with progress counted over
 * those CCAs only. Nothing about a CCA they do not direct leaves.
 */
export async function outbox(
  db: PrismaClient,
  userID: string,
): Promise<{ items: OutboxItem[]; skipped: number; more: boolean }> {
  const directed = await directedOrRefuse(db, userID);
  if (directed.length === 0) throw notDirector();
  const targets = await db.reminderTarget.findMany({
    where: { ccaID: { in: directed } },
    orderBy: { createdAt: "desc" },
    take: LIST_MAX * 20,
    select: { broadcastID: true, doneAt: true },
  });
  const counts = new Map<string, { total: number; done: number }>();
  for (const t of targets) {
    const c = counts.get(t.broadcastID) ?? { total: 0, done: 0 };
    counts.set(t.broadcastID, {
      total: c.total + 1,
      done: c.done + (t.doneAt ? 1 : 0),
    });
  }
  const ids = [...counts.keys()].slice(0, LIST_MAX);
  const { good, skipped } = await loadBroadcasts(db, ids);
  const items = ids
    .flatMap((id) => {
      const b = good.get(id);
      const c = counts.get(id);
      return b && c
        ? [
            {
              id,
              title: b.title,
              deadline: b.deadline,
              status: b.status,
              total: c.total,
              done: c.done,
              createdAt: b.createdAt.toISOString(),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(a.status === "cancelled") - Number(b.status === "cancelled") ||
        a.deadline.localeCompare(b.deadline),
    );
  return { items, skipped, more: counts.size > LIST_MAX };
}

export type BroadcastDetail = {
  id: string;
  title: string;
  message: string;
  deadline: string;
  status: "active" | "cancelled";
  /** Whether this viewer may cancel it: active, and they direct every CCA on it. */
  canCancel: boolean;
  progress: Array<{
    ccaID: number;
    ccaName: string | null;
    heads: number;
    doneAt: string | null;
    doneBy: string | null;
  }>;
};

/**
 * One broadcast with progress by CCA, for the CCAs this person directs. A
 * missing id and one that addresses none of their CCAs are the same NOT_FOUND.
 */
export async function broadcastDetail(
  db: PrismaClient,
  userID: string,
  id: string,
): Promise<BroadcastDetail> {
  const directed = await directedOrRefuse(db, userID);
  const [mine, all] = await Promise.all([
    directed.length === 0
      ? Promise.resolve([])
      : db.reminderTarget.findMany({
          where: { broadcastID: id, ccaID: { in: directed } },
          select: { ccaID: true, doneAt: true, doneBy: true },
        }),
    db.reminderTarget.count({ where: { broadcastID: id } }),
  ]);
  const broadcast =
    mine.length > 0 ? (await loadBroadcasts(db, [id])).good.get(id) : undefined;
  if (!broadcast) throw notFound();
  const ccaIDs = mine.map((t) => t.ccaID);
  const [names, heads] = await Promise.all([
    ccaNames(db, ccaIDs),
    db.ccaHead.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true },
    }),
  ]);
  const people = await displayNames(
    db,
    mine.flatMap((t) => (t.doneBy !== null ? [t.doneBy] : [])),
  );
  return {
    id,
    title: broadcast.title,
    message: broadcast.message,
    deadline: broadcast.deadline,
    status: broadcast.status,
    canCancel: broadcast.status === "active" && mine.length === all,
    progress: [...mine]
      .sort((a, b) => a.ccaID - b.ccaID)
      .map((t) => ({
        ccaID: t.ccaID,
        ccaName: names.get(t.ccaID) ?? null,
        heads: heads.filter((h) => h.ccaID === t.ccaID).length,
        doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        doneBy: t.doneBy !== null ? (people.get(t.doneBy) ?? null) : null,
      })),
  };
}

/* ---- the head's side ------------------------------------------------------- */

export type HeadItem = {
  broadcastID: string;
  ccaID: number;
  ccaName: string | null;
  title: string;
  message: string;
  deadline: string;
  /** Days from today (Singapore) to the deadline; negative once past. */
  daysLeft: number;
  done: boolean;
  doneAt: string | null;
};

/** Active broadcasts addressed to the CCAs this person heads. A plain query. */
export async function loadHeadItems(
  db: PrismaClient,
  userID: string,
  now: Date = new Date(),
): Promise<{ items: HeadItem[]; skipped: number; isHead: boolean }> {
  const headed = await headedOrRefuse(db, userID);
  if (headed.length === 0) return { items: [], skipped: 0, isHead: false };
  const targets = await db.reminderTarget.findMany({
    where: { ccaID: { in: headed } },
    orderBy: { createdAt: "desc" },
    take: LIST_MAX * 5,
    select: { broadcastID: true, ccaID: true, doneAt: true },
  });
  const { good, skipped } = await loadBroadcasts(
    db,
    targets.map((t) => t.broadcastID),
  );
  const names = await ccaNames(db, headed);
  const today = sgtDayKey(now);
  const items = targets
    .flatMap((t) => {
      const b = good.get(t.broadcastID);
      if (!b || b.status !== "active") return [];
      return [
        {
          broadcastID: b.id,
          ccaID: t.ccaID,
          ccaName: names.get(t.ccaID) ?? null,
          title: b.title,
          message: b.message,
          deadline: b.deadline,
          daysLeft: daysBetween(today, b.deadline),
          done: t.doneAt !== null,
          doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) || a.deadline.localeCompare(b.deadline),
    )
    .slice(0, LIST_MAX);
  return { items, skipped, isHead: true };
}

/**
 * What the navigation shows: the Director entry for a director of a CCA
 * (reminders on) or the Social director (disposables on, for the digest), the
 * Reminders entry for a head, and how many broadcasts wait on this person as a
 * head. Off is a plain all-false; a failed guard read is an error, which the
 * header treats as "hide it".
 */
export async function getEntry(
  db: PrismaClient,
  userID: string,
): Promise<{
  director: boolean;
  social: boolean;
  head: boolean;
  open: number;
}> {
  const social =
    (await isDisposablesEnabled(db)) && (await isSocialDirector(db, userID));
  if (!(await isRemindersEnabled(db))) {
    return { director: false, social, head: false, open: 0 };
  }
  const directed = await directedOrRefuse(db, userID);
  const { items, isHead } = await loadHeadItems(db, userID);
  return {
    director: directed.length > 0,
    social,
    head: isHead,
    open: items.filter((i) => !i.done).length,
  };
}
