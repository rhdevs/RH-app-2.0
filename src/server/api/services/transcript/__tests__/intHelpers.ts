import type { PrismaClient } from "@prisma/client";

/**
 * Shared by the database tests: put the saved member lists back as the seed
 * left them. The seed saves none for the collecting year; a test that opens
 * transcripts or saves a CCA's list must not leak into the next.
 */
const SEED_CCAS = { gte: 9001, lte: 9014 };

export type FreezeBaseline = Array<Record<string, unknown>>;

export async function captureFreezes(
  db: PrismaClient,
): Promise<FreezeBaseline> {
  const rows = await db.ccaYearFreeze.findMany({
    where: { ccaID: SEED_CCAS, academicYear: "AY2026/27" },
  });
  return rows.map(({ id: _id, ...rest }) => rest);
}

export async function restoreFreezes(
  db: PrismaClient,
  baseline: FreezeBaseline,
): Promise<void> {
  await db.ccaYearFreeze.deleteMany({ where: { ccaID: SEED_CCAS } });
  if (baseline.length > 0) {
    await db.ccaYearFreeze.createMany({ data: baseline as never });
  }
}
