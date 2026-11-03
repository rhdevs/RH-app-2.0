import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  holdsLiveJcrc,
  holdsStoredAdmin,
  isSocialDirector,
} from "~/server/api/services/directorGuard";

/**
 * Who may touch disposable requests, decided from the stored rows every time
 * (merge proposal 4.9, A9, A54).
 *
 * - A HEAD (a `CcaHead` row for THIS CCA) files requests for that CCA's events
 *   and proposals and reads that CCA's own. A head does not edit, delete or
 *   decide (A9, 4.9).
 * - FILING for a HALL-WIDE event (no CCA) is for the people who can create one:
 *   a live `jcrc` (the strict guard) or an admin (a strict read of the stored
 *   roles). Whoever filed such a request also reads it and nudges about it,
 *   whatever they hold now (`read.ts`, `nudge.ts`). An admin or JCRC member
 *   filing for a CCA's event is refused (A67): only that CCA's heads file.
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
export const NOT_HALL_FILER = "NOT_HALL_FILER";
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

/** What this person may file for: the CCAs they head, and hall-wide events. */
export type DisposableFiler = {
  /** The CCAs this person heads now, ascending. */
  headedCcaIDs: number[];
  /** A live `jcrc` or an admin now (strict): may file for a hall-wide event. */
  hallWide: boolean;
};

/**
 * Who this person may file for. Every read is strict; any failing refuses the
 * whole call. Does not refuse a person who may file nothing.
 */
export async function loadFiler(
  db: DisposablesAccessDb,
  userID: string,
): Promise<DisposableFiler> {
  try {
    const headedCcaIDs = await headedCcas(db, userID);
    const hallWide =
      (await holdsLiveJcrc(db, userID)) || (await holdsStoredAdmin(db, userID));
    return { headedCcaIDs, hallWide };
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/**
 * May this person file a request for something owned by `ccaID`? `null` is a
 * hall-wide event. A CCA's event or proposal: a current head of that CCA and
 * nobody else (an admin or JCRC member is refused). A hall-wide event: a live
 * `jcrc` or an admin. NOT `assertHeadsCca`, which lets an admin through for
 * any CCA. A failed read refuses.
 */
export async function mayFile(
  db: DisposablesAccessDb,
  userID: string,
  ccaID: number | null,
): Promise<boolean> {
  try {
    if (ccaID !== null) return (await headedCcas(db, userID)).includes(ccaID);
    return (
      (await holdsLiveJcrc(db, userID)) || (await holdsStoredAdmin(db, userID))
    );
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/** Refuse unless `mayFile`. */
export async function assertCanFile(
  db: DisposablesAccessDb,
  userID: string,
  ccaID: number | null,
): Promise<void> {
  if (!(await mayFile(db, userID, ccaID))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: ccaID === null ? NOT_HALL_FILER : NOT_CCA_HEAD,
    });
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
