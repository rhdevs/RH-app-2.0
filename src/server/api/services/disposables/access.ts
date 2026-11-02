import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  holdsLiveJcrc,
  isSocialDirector,
} from "~/server/api/services/directorGuard";

/**
 * Who may touch disposable requests, decided from the stored rows every time
 * (merge proposal 4.9, A9, A54).
 *
 * - A HEAD (a `CcaHead` row for THIS CCA) files requests and reads that CCA's
 *   own. A head does not edit, delete or decide (A9, 4.9).
 * - The SOCIAL DIRECTOR (the strict guard's `isSocialDirector`: the holder of
 *   the exactly-one `handlesDisposables` position, with a live `jcrc`)
 *   approves, rejects, edits and deletes any request.
 * - Every JCRC member (a live `jcrc`, by the strict guard) READS all requests
 *   and may act on none. Seeing grants no power.
 * - Everyone else is refused even the read, admins who are none of these
 *   included.
 *
 * NOT used, on purpose: `getUserRoles` (forgiving: a failed read keeps stored
 * roles), the session's roles (a 30-day JWT), `assertHeadsCca` (lets an admin
 * through for any CCA), `myPositionCcas` and the oversees-all switch (built for
 * views). The reads have no catch around any single one; a catch wraps the
 * WHOLE decision, only ever refuses, and logs the error name alone (a driver
 * message can carry stored values). During a database fault nobody can act
 * until it passes. A source scan in proposalSourceScans.test.ts keeps those
 * imports out and keeps this file the only one with a catch.
 */

export const NOT_DISPOSABLE_READER = "NOT_DISPOSABLE_READER";
export const NOT_CCA_HEAD = "NOT_CCA_HEAD";
export const DISPOSABLE_ACCESS_CHECK_FAILED = "DISPOSABLE_ACCESS_CHECK_FAILED";
export const DISPOSABLE_NOT_FOUND = "DISPOSABLE_NOT_FOUND";

export type DisposablesAccessDb = Parameters<typeof isSocialDirector>[0] &
  Pick<PrismaClient, "ccaHead">;

export type DisposableViewer = {
  /** The CCAs this person heads now, ascending. */
  headedCcaIDs: number[];
  /** Holds `jcrc` now (strict). */
  isJcrc: boolean;
  /** Is the Social director now (strict). */
  isSocialDirector: boolean;
};

function refuseOnFailure(err: unknown): never {
  console.error(
    JSON.stringify({
      evt: "disposable_access_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: DISPOSABLE_ACCESS_CHECK_FAILED,
  });
}

async function headedCcas(
  db: Pick<DisposablesAccessDb, "ccaHead">,
  userID: string,
): Promise<number[]> {
  const rows = await db.ccaHead.findMany({
    where: { userID },
    select: { ccaID: true },
  });
  return [...new Set(rows.map((r) => r.ccaID))].sort((a, b) => a - b);
}

/**
 * Who this person is to the disposables screen. Every read is strict; any
 * failing refuses the whole call. Does NOT refuse a person who is nothing:
 * `canRead` says whether they may see anything.
 */
export async function loadViewer(
  db: DisposablesAccessDb,
  userID: string,
): Promise<DisposableViewer> {
  try {
    const headedCcaIDs = await headedCcas(db, userID);
    const isJcrc = await holdsLiveJcrc(db, userID);
    const social = isJcrc ? await isSocialDirector(db, userID) : false;
    return { headedCcaIDs, isJcrc, isSocialDirector: social };
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/** May this viewer read this CCA's requests? JCRC reads all, a head their own. */
export const canReadCca = (viewer: DisposableViewer, ccaID: number) =>
  viewer.isJcrc || viewer.headedCcaIDs.includes(ccaID);

/** Does this viewer read anything at all? */
export const canReadAny = (viewer: DisposableViewer) =>
  viewer.isJcrc || viewer.headedCcaIDs.length > 0;

/** Refuse unless this person heads this CCA now. */
export async function assertCcaHead(
  db: Pick<DisposablesAccessDb, "ccaHead">,
  userID: string,
  ccaID: number,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = (await headedCcas(db, userID)).includes(ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
  if (!allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_CCA_HEAD });
  }
}

/** The CCA's current heads, for the outcome notices; same refusal rule. */
export async function headsOrRefuse(
  db: Pick<DisposablesAccessDb, "ccaHead">,
  ccaID: number,
): Promise<string[]> {
  try {
    const rows = await db.ccaHead.findMany({
      where: { ccaID },
      select: { userID: true },
    });
    return [...new Set(rows.map((r) => r.userID))].sort();
  } catch (err) {
    return refuseOnFailure(err);
  }
}
