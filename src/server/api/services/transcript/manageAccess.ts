import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { accessFor } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { assertCollecting } from "./periods";

/**
 * Who may do what, decided from a LIVE role read (I-5), never from the session
 * copy, which can be 30 days stale. `accessFor` (src/lib/transcript/permissions)
 * is the pure matrix; these functions feed it the facts and turn a "no" into a
 * FORBIDDEN.
 */

const forbidden = (message: string) =>
  new TRPCError({ code: "FORBIDDEN", message });

/** admin or jcrc. */
export async function requireManager(db: PrismaClient, userID: string) {
  const roles = await getUserRoles(db, userID);
  if (!accessFor("manager", roles)) throw forbidden("INSUFFICIENT_ROLE");
  return roles;
}

/** The live `jcrc` role: for a member's own JCRC record. Admin alone is not enough. */
export async function requireJcrcSelf(db: PrismaClient, userID: string) {
  const roles = await getUserRoles(db, userID);
  if (!accessFor("jcrcSelf", roles)) throw forbidden("JCRC_MEMBER_REQUIRED");
  return roles;
}

/**
 * The caller heads THIS CCA (a live CcaHead row, via assertHeadsCca) or is a
 * manager. The scope-free `cca_head` role string is never consulted. A plain
 * resident, and the head of a DIFFERENT CCA, both get FORBIDDEN.
 */
export async function requireCcaAccess(
  db: PrismaClient,
  userID: string,
  ccaID: number,
) {
  const roles = await getUserRoles(db, userID);
  const scope = await assertHeadsCca(db, { userID, roles }, ccaID);
  if (!accessFor("cca", roles, scope.via === "headship")) {
    throw forbidden("NOT_A_HEAD_OF_THIS_CCA");
  }
  return { roles, via: scope.via };
}

/**
 * A manager, or the head of at least one VOLUNTEERING CCA (a live CcaHead row
 * joined to CcaProfile.isVolunteering). For finding a resident to log hours for.
 */
export async function requireManagerOrVolunteeringHead(
  db: PrismaClient,
  userID: string,
) {
  const roles = await getUserRoles(db, userID);
  if (accessFor("manager", roles)) return;
  const headed = await db.ccaHead.findMany({
    where: { userID },
    select: { ccaID: true },
  });
  const volunteering =
    headed.length === 0
      ? 0
      : await db.ccaProfile.count({
          where: {
            ccaID: { in: headed.map((h) => h.ccaID) },
            isVolunteering: true,
          },
        });
  if (volunteering === 0) throw forbidden("NOT_A_VOLUNTEERING_HEAD");
}

/** The CCA must exist. */
export async function requireCca(db: PrismaClient, ccaID: number) {
  const cca = await db.cCA.findUnique({
    where: { ccaID },
    select: { ccaID: true, ccaName: true, category: true },
  });
  if (!cca)
    throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
  return cca;
}

/**
 * Every write to a year's data needs the year to be COLLECTING. Wraps
 * assertCollecting (whose FORBIDDEN is the right answer for period edits) so
 * these writes fail with the clearer PRECONDITION_FAILED.
 */
export async function assertWritable(
  db: PrismaClient,
  academicYear: string,
): Promise<void> {
  try {
    await assertCollecting(db, academicYear);
  } catch (error) {
    if (error instanceof TRPCError && error.message === "PERIOD_PUBLISHED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "PERIOD_PUBLISHED",
      });
    }
    throw error;
  }
}
