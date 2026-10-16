import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  editRefusal,
  normaliseYearStatus,
  type EditRefusal,
  type FreezeReason,
} from "~/lib/transcript/lifecycle";
import { accessFor } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import { activeFreeze, termYearOf } from "./freeze";
import { getPeriod } from "./periods";

/**
 * WHO MAY CHANGE A CCA'S TRANSCRIPT RECORDS FOR A YEAR. One guard, decided from
 * LIVE role and headship reads, so every edit screen applies the same rule:
 *  - nobody once the year is published;
 *  - managers (admin or jcrc) for any CCA, collecting or closed;
 *  - the head of THIS CCA only while the year is collecting, for the CCA's term
 *    year while its list is not frozen, or a year frozen by the head's own lock;
 *  - everyone else: no.
 * The pure rule is `editRefusal` (src/lib/transcript/lifecycle.ts).
 */

const CODE: Record<EditRefusal, "PRECONDITION_FAILED" | "FORBIDDEN"> = {
  PERIOD_PUBLISHED: "PRECONDITION_FAILED",
  YEAR_CLOSED: "FORBIDDEN",
  CCA_YEAR_FROZEN: "FORBIDDEN",
  NOT_THE_TERM_YEAR: "FORBIDDEN",
  NOT_A_HEAD_OF_THIS_CCA: "FORBIDDEN",
};

/** Why this person may not edit (null if they may), without throwing. */
export async function editRefusalFor(
  db: PrismaClient,
  userID: string,
  ccaID: number,
  academicYear: string,
  now: Date = new Date(),
): Promise<EditRefusal | null> {
  const roles = await getUserRoles(db, userID);
  const isManager = accessFor("manager", roles);
  const [period, freeze, headRow, term] = await Promise.all([
    getPeriod(db, academicYear),
    activeFreeze(db, ccaID, academicYear),
    isManager
      ? Promise.resolve(null)
      : db.ccaHead.findUnique({
          where: { userID_ccaID: { userID, ccaID } },
          select: { id: true },
        }),
    // Only a head is limited to the term year; a manager is not.
    isManager ? Promise.resolve(academicYear) : termYearOf(db, ccaID, now),
  ]);
  return editRefusal({
    isManager,
    isHead: headRow !== null,
    status: normaliseYearStatus(period?.status),
    freezeReason: (freeze?.reason as FreezeReason | undefined) ?? null,
    isTermYear: term === academicYear,
  });
}

/** Throws the refusal, as a message the screens turn into a plain sentence. */
export async function assertCanEditCcaYear(
  db: PrismaClient,
  actor: { userID: string },
  ccaID: number,
  academicYear: string,
): Promise<void> {
  const refusal = await editRefusalFor(db, actor.userID, ccaID, academicYear);
  if (refusal) {
    throw new TRPCError({ code: CODE[refusal], message: refusal });
  }
}
