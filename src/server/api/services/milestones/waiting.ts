import type { PrismaClient } from "@prisma/client";

import {
  MILESTONE_WAITING_WINDOW_DAYS,
  toEpochSec,
} from "~/lib/milestones/open";
import { MILESTONE_MAX_EVIDENCE } from "~/lib/schemas/milestone";
import { neededFrom } from "~/lib/milestones/visibility";
import { milestoneSeats } from "./access";
import { findEndedMilestones } from "./candidates";
import { assertWithinLimit } from "./limits";

/**
 * What is waiting for a person, counted per CCA (merge proposal 4.10): for
 * each CCA they head, the open milestones with no head rating yet; for each CCA
 * they direct, the open milestones with photos and no director rating yet.
 * Shared by the home entries and the reminder, so the number a person is told
 * is the number the screen shows.
 *
 * BOUNDED. Only milestones that ended inside the window below are looked at,
 * newest first, through the capped candidate query; the filings and photo
 * counts are then read for exactly those keys. A person's bell never scans
 * every event ever. An older unfiled milestone drops out of the count (it is
 * still on the CCA's yearly view). A canceled event is not a candidate, and a
 * rated filing is frozen, so both stop counting.
 *
 * No catch: a failed read fails the caller (the due check logs it and writes
 * nothing; the screen shows an error, never "nothing waiting").
 */

export { MILESTONE_WAITING_WINDOW_DAYS };

export type WaitingCounts = {
  toFile: number;
  toRate: number;
  /** Distinct milestones needing this person: a head and director counts once. */
  waiting: number;
};

export type WaitingResult = {
  perCca: Map<number, WaitingCounts>;
  /** A scan cap was hit: the counts may be low. */
  capped: boolean;
  skipped: number;
};

type Db = Pick<
  PrismaClient,
  "event" | "proposal" | "milestoneSubmission" | "milestoneEvidence"
>;

export async function waitingFor(
  db: Db,
  seats: { headed: readonly number[]; directed: readonly number[] },
  now: Date,
): Promise<WaitingResult> {
  const headed = new Set(seats.headed);
  const directed = new Set(seats.directed);
  const ccaIDs = [...new Set([...headed, ...directed])];
  const perCca = new Map<number, WaitingCounts>();
  const result: WaitingResult = { perCca, capped: false, skipped: 0 };
  if (ccaIDs.length === 0) return result;

  const nowSec = toEpochSec(now);
  const list = await findEndedMilestones(
    db,
    ccaIDs,
    {
      fromSec: nowSec - MILESTONE_WAITING_WINDOW_DAYS * 86_400,
      toSec: nowSec,
    },
    now,
  );
  result.capped = list.capped;
  result.skipped = list.skipped;
  if (list.items.length === 0) return result;

  const subs = await db.milestoneSubmission.findMany({
    where: { milestoneKey: { in: list.items.map((i) => i.key) } },
    select: {
      id: true,
      milestoneKey: true,
      headScore: true,
      frozenAt: true,
    },
  });
  const byKey = new Map(subs.map((s) => [s.milestoneKey, s]));

  // Photo counts only for filings a director could still rate.
  const rateable = subs.filter(
    (s) =>
      s.frozenAt === null && directed.has(ccaOf(list.items, s.milestoneKey)),
  );
  const photos = new Map<string, number>();
  if (rateable.length > 0) {
    const rows = await db.milestoneEvidence.findMany({
      where: { submissionID: { in: rateable.map((s) => s.id) } },
      select: { submissionID: true },
      take: rateable.length * MILESTONE_MAX_EVIDENCE,
    });
    for (const r of rows) {
      if (r.submissionID !== null) {
        photos.set(r.submissionID, (photos.get(r.submissionID) ?? 0) + 1);
      }
    }
  }

  for (const item of list.items) {
    const sub = byKey.get(item.key) ?? null;
    const needs = neededFrom(
      { head: headed.has(item.ccaID), director: directed.has(item.ccaID) },
      sub
        ? {
            headScore: sub.headScore ?? null,
            headText: null,
            headRatedAt: null,
            frozen: sub.frozenAt !== null && sub.frozenAt !== undefined,
          }
        : null,
      sub ? (photos.get(sub.id) ?? 0) : 0,
      null,
    );
    if (needs.length === 0) continue;
    const counts = perCca.get(item.ccaID) ?? {
      toFile: 0,
      toRate: 0,
      waiting: 0,
    };
    counts.waiting += 1;
    if (needs.includes("file")) counts.toFile += 1;
    if (needs.includes("rate")) counts.toRate += 1;
    perCca.set(item.ccaID, counts);
  }
  return result;
}

function ccaOf(
  items: readonly { key: string; ccaID: number }[],
  key: string,
): number {
  return items.find((i) => i.key === key)?.ccaID ?? -1;
}

export type MyMilestoneRow = {
  ccaID: number;
  ccaName: string;
  head: boolean;
  director: boolean;
  toFile: number;
  toRate: number;
};

/**
 * The home entries: every CCA the person heads or directs with what is
 * waiting there. Strict reads (access.ts); a failure fails the call, never
 * "nothing waiting".
 */
export async function myMilestones(
  db: Db & Pick<PrismaClient, "cCA"> & Parameters<typeof milestoneSeats>[0],
  userID: string,
  now: Date,
): Promise<{ rows: MyMilestoneRow[]; capped: boolean }> {
  await assertWithinLimit("browse", userID);
  const seats = await milestoneSeats(db, userID);
  const ids = [...new Set([...seats.headed, ...seats.directed])];
  if (ids.length === 0) return { rows: [], capped: false };
  const waiting = await waitingFor(db, seats, now);
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: ids } },
    select: { ccaID: true, ccaName: true },
  });
  const names = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  const rows = ids.map((ccaID) => ({
    ccaID,
    ccaName: names.get(ccaID) ?? "CCA",
    head: seats.headed.includes(ccaID),
    director: seats.directed.includes(ccaID),
    toFile: waiting.perCca.get(ccaID)?.toFile ?? 0,
    toRate: waiting.perCca.get(ccaID)?.toRate ?? 0,
  }));
  return { rows, capped: waiting.capped };
}
