import type { PrismaClient } from "@prisma/client";
import { listPublishedYears } from "./periods";

/**
 * When a resident first and last opened their published transcript. It exists
 * only to drive the "Ready" badge: a published year with no row here is one the
 * resident has not seen yet.
 */

const isDuplicateKey = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

/**
 * Record that the resident opened the year. Race-safe: two first opens at once
 * both end up with one row (the unique key turns the loser into an update), and
 * `firstOpenedAt` is never moved by a later open.
 */
export async function recordAccess(
  db: PrismaClient,
  academicYear: string,
  userID: string,
  now: Date = new Date(),
): Promise<void> {
  const where = { academicYear_userID: { academicYear, userID } };
  try {
    await db.transcriptAccess.upsert({
      where,
      create: { academicYear, userID, firstOpenedAt: now, lastOpenedAt: now },
      update: { lastOpenedAt: now },
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    await db.transcriptAccess.update({ where, data: { lastOpenedAt: now } });
  }
}

/**
 * The newest published year the resident has not opened, if any. Two small
 * reads: the published years, then this resident's access rows for them.
 */
export async function readiness(
  db: PrismaClient,
  userID: string,
): Promise<{ ready: boolean; academicYear: string | null }> {
  const published = await listPublishedYears(db);
  if (published.length === 0) return { ready: false, academicYear: null };
  const opened = await db.transcriptAccess.findMany({
    where: { userID, academicYear: { in: published } },
    select: { academicYear: true },
  });
  const seen = new Set(opened.map((o) => o.academicYear));
  const unseen = published.filter((y) => !seen.has(y));
  const latest = unseen[unseen.length - 1] ?? null;
  return { ready: latest !== null, academicYear: latest };
}
