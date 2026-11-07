import type { PrismaClient } from "@prisma/client";

import { sgtDayKey } from "~/lib/time/sgt";
import { assertSocialDirector } from "~/server/api/services/directorGuard";
import { liveEventsOf, requestEventOf } from "./eventTag";
import { namesOf, SELECT, storedRow, type StoredRow } from "./read";

/** The most collections one day's digest reads; far above a real day. */
export const DIGEST_MAX = 100;

/**
 * The approved requests whose collection day is `day`, earliest first. A row
 * that cannot be shown (a quantity out of range, a day or time that is not
 * real) is COUNTED and SKIPPED, so one bad row never breaks the digest (A2).
 * A plain query: it writes nothing.
 */
export async function approvedOn(
  db: Pick<PrismaClient, "disposableRequest">,
  day: string,
): Promise<{ rows: StoredRow[]; skipped: number; more: boolean }> {
  const found = await db.disposableRequest.findMany({
    where: { status: "approved", collectionDay: day },
    orderBy: [{ collectionTime: "asc" }, { createdAt: "asc" }],
    take: DIGEST_MAX + 1,
    select: SELECT,
  });
  const rows: StoredRow[] = [];
  let skipped = 0;
  for (const row of found.slice(0, DIGEST_MAX)) {
    const parsed = storedRow.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
    else skipped += 1;
  }
  return { rows, skipped, more: found.length > DIGEST_MAX };
}

export type CollectionDigest = {
  /** The Singapore day this is for. */
  day: string;
  items: Array<{
    id: string;
    /** Null for a request for a hall-wide event (see `hallWide`). */
    ccaName: string | null;
    hallWide: boolean;
    /** The event it is for: live title, else the one kept when it was filed. */
    eventTitle: string | null;
    eventState: "ok" | "canceled" | "declined" | "gone" | null;
    title: string;
    collectionTime: string;
    plates: number;
    cups: number;
    bowls: number;
    forks: number;
    spoons: number;
  }>;
  skipped: number;
  more: boolean;
};

/**
 * The Social director's list of today's approved collections (F19). Shown to
 * that one person, by the strict guard: anyone else, a JCRC member and an admin
 * included, is refused with NOT_SOCIAL_DIRECTOR, and so is everyone while no
 * single position handles disposables.
 */
export async function collectionDigest(
  db: PrismaClient,
  userID: string,
  now: Date = new Date(),
): Promise<CollectionDigest> {
  await assertSocialDirector(db, userID, now);
  const day = sgtDayKey(now);
  const { rows, skipped, more } = await approvedOn(db, day);
  const names = await namesOf(db, [
    ...new Set(rows.flatMap((r) => (r.ccaID !== null ? [r.ccaID] : []))),
  ]);
  const live = await liveEventsOf(db, rows);
  return {
    day,
    items: rows.map((r) => {
      const event = requestEventOf(r, live);
      return {
        id: r.id,
        ccaName: r.ccaID !== null ? (names.get(r.ccaID) ?? null) : null,
        hallWide: r.ccaID === null,
        eventTitle: event?.title ?? null,
        eventState: event?.state ?? null,
        title: r.title,
        collectionTime: r.collectionTime,
        plates: r.plates,
        cups: r.cups,
        bowls: r.bowls,
        forks: r.forks,
        spoons: r.spoons,
      };
    }),
    skipped,
    more,
  };
}
