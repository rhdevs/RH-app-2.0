import type { PrismaClient } from "@prisma/client";
import { listPublishedYears } from "./periods";
import { NOT_RELEASED } from "./residentRecords";

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
 * The newest published year the resident has not opened and that is not on
 * hold, if any. Small reads: the published years, then this resident's access
 * rows and holds for them.
 */
export async function readiness(
  db: PrismaClient,
  userID: string,
): Promise<{ ready: boolean; academicYear: string | null }> {
  const published = await listPublishedYears(db);
  if (published.length === 0) return { ready: false, academicYear: null };
  const [opened, held] = await Promise.all([
    db.transcriptAccess.findMany({
      where: { userID, academicYear: { in: published } },
      select: { academicYear: true },
    }),
    db.residentWithhold.findMany({
      where: { userID, academicYear: { in: published }, ...NOT_RELEASED },
      select: { academicYear: true },
    }),
  ]);
  // A year on hold is not ready, and is not "opened" either.
  const seen = new Set([
    ...opened.map((o) => o.academicYear),
    ...held.map((h) => h.academicYear),
  ]);
  const unseen = published.filter((y) => !seen.has(y));
  const latest = unseen[unseen.length - 1] ?? null;
  return { ready: latest !== null, academicYear: latest };
}
