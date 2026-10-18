import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

/**
 * Who may open a CCA's points page: ONLY the CCA's own heads.
 *
 * This is deliberately NOT assertHeadsCca. That guard also admits anyone with
 * the manageCcaHeads capability (admin, jcrc), which is right for rosters and
 * event tools but wrong here: the points page is the leader's own allocation
 * surface, so JCRC and admin are admitted only if they hold a CcaHead row for
 * THIS ccaID — the same as anyone else. It reads CcaHead and never a role.
 *
 * Same refusal message as assertHeadsCca, so the client's existing handling of
 * a FORBIDDEN here is unchanged.
 */
export async function assertIsHeadOfCca(
  db: PrismaClient,
  userID: string,
  ccaID: number,
): Promise<void> {
  const row = await db.ccaHead.findUnique({
    where: { userID_ccaID: { userID, ccaID } },
    select: { id: true },
  });
  if (!row) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "NOT_A_HEAD_OF_THIS_CCA",
    });
  }
}
