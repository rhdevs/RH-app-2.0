import type { PrismaClient } from "@prisma/client";

/**
 * Shared by the database tests: put the freezes back as the seed left them.
 * The seed freezes two CCAs for the year (one at handover, one locked by its
 * head) and every other CCA is not frozen; a test that closes the year, freezes
 * a CCA or unfreezes one must not leak into the next.
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
