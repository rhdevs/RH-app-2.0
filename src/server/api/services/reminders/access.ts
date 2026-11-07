import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  DIRECTOR_CHECK_FAILED,
  directedCcaIDs,
  NOT_DIRECTOR,
} from "~/server/api/services/directorGuard";

/**
 * Who may touch a broadcast, decided from the stored rows every time (merge
 * proposal A9, A30).
 *
 * - SEND or CANCEL: a director of EVERY CCA the broadcast addresses, by the
 *   strict guard (`directedCcaIDs`: a live `jcrc`, a current holder row on a
 *   position flagged `vetsProposals` that lists the CCA). One CCA that is not
 *   theirs refuses the whole thing. An admin, a JCRC member and the holder of
 *   any other position are refused. The sender is the caller, never an input.
 * - MARK DONE, and the head's list: a head of that CCA now (a `CcaHead` row).
 *
 * NOT used, on purpose: `getUserRoles` (forgiving), the session's roles,
 * `myPositionCcas` and the oversees-all switch. The reads have no catch around
 * any single one; the catch wraps the WHOLE decision, only ever refuses and
 * logs the error name alone. A source scan keeps this file the only one in
 * this folder with a catch.
 */

export const REMINDER_ACCESS_CHECK_FAILED = DIRECTOR_CHECK_FAILED;
export const REMINDER_NOT_FOUND = "REMINDER_NOT_FOUND";
export const NOT_CCA_HEAD = "NOT_CCA_HEAD";

type DirectedDb = Parameters<typeof directedCcaIDs>[0];
export type RemindersAccessDb = DirectedDb & Pick<PrismaClient, "ccaHead">;

function refuseOnFailure(err: unknown): never {
  console.error(
    JSON.stringify({
      evt: "reminder_access_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: REMINDER_ACCESS_CHECK_FAILED,
  });
}

/** The CCAs this person directs now, ascending. A failed read refuses. */
export async function directedOrRefuse(
  db: DirectedDb,
  userID: string,
): Promise<number[]> {
  try {
    return await directedCcaIDs(db, userID);
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/** The CCAs this person heads now, ascending. A failed read refuses. */
export async function headedOrRefuse(
  db: Pick<PrismaClient, "ccaHead">,
  userID: string,
): Promise<number[]> {
  try {
    const rows = await db.ccaHead.findMany({
      where: { userID },
      select: { ccaID: true },
    });
    return [...new Set(rows.map((r) => r.ccaID))].sort((a, b) => a - b);
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/** Refuse unless this person directs every one of these CCAs now. */
export async function assertDirectsAll(
  db: DirectedDb,
  userID: string,
  ccaIDs: readonly number[],
): Promise<void> {
  const directed = new Set(await directedOrRefuse(db, userID));
  if (ccaIDs.length === 0 || !ccaIDs.every((id) => directed.has(id))) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_DIRECTOR });
  }
}

/**
 * The current heads of these CCAs, one id each, for addressing notices. A
 * failed read refuses (inside a transaction that rolls the send back).
 */
export async function headsOfOrRefuse(
  db: Pick<PrismaClient, "ccaHead">,
  ccaIDs: readonly number[],
): Promise<string[]> {
  try {
    const rows = await db.ccaHead.findMany({
      where: { ccaID: { in: [...ccaIDs] } },
      select: { userID: true },
    });
    return [...new Set(rows.map((r) => r.userID))].sort();
  } catch (err) {
    return refuseOnFailure(err);
  }
}
