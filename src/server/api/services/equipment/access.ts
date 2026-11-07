import { TRPCError } from "@trpc/server";

import {
  assertSocialDirector,
  holdsLiveJcrc,
  holdsStoredAdmin,
  isSocialDirector,
} from "~/server/api/services/directorGuard";
import {
  mayFile,
  type DisposablesAccessDb,
} from "~/server/api/services/disposables/access";

/**
 * Who may touch equipment loans, decided from the stored rows every time.
 *
 * - The SOCIAL DIRECTOR (`assertSocialDirector`: the holder of the exactly-one
 *   `handlesDisposables` position, with a live `jcrc`; admins are NOT enough)
 *   edits the list and approves, rejects or cancels any loan.
 * - An event's LEADERS are whoever disposables lets file for that event
 *   (`mayFile` with the loan's CCA: a current head of that CCA; for a hall-wide
 *   event a live `jcrc` or an admin). They file, mark collected and returned,
 *   and cancel before collection, and read the return photo.
 * - The BOARD is read by every current head of any CCA, every live `jcrc`
 *   holder, the Social director and admins. Everyone else is refused.
 *
 * Every read here is strict: no getUserRoles, no session role list, no
 * myPositionCcas or oversees-all switch, no forgiving catch. A catch wraps a
 * WHOLE decision, only ever refuses, and logs the error name alone (a driver
 * message can carry stored values). A source scan keeps those imports out.
 */

export const NOT_EQUIPMENT_READER = "NOT_EQUIPMENT_READER";
export const NOT_EVENT_LEADER = "NOT_EVENT_LEADER";
export const EQUIPMENT_ACCESS_CHECK_FAILED = "EQUIPMENT_ACCESS_CHECK_FAILED";
export const EQUIPMENT_NOT_FOUND = "EQUIPMENT_NOT_FOUND";

export type EquipmentAccessDb = DisposablesAccessDb;

function refuseOnFailure(err: unknown): never {
  console.error(
    JSON.stringify({
      evt: "equipment_access_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: EQUIPMENT_ACCESS_CHECK_FAILED,
  });
}

export type BoardViewer = {
  /** Is the Social director now (strict). */
  isDirector: boolean;
  /** May read the board at all. */
  canRead: boolean;
};

/**
 * Who this person is to the board. Every read is strict; any failing refuses
 * the whole call. Does NOT refuse a person who may read nothing.
 */
export async function loadBoardViewer(
  db: EquipmentAccessDb,
  userID: string,
): Promise<BoardViewer> {
  try {
    const isDirector = await isSocialDirector(db, userID);
    const headsAny =
      (await db.ccaHead.findFirst({
        where: { userID },
        select: { ccaID: true },
      })) !== null;
    const canRead =
      isDirector ||
      headsAny ||
      (await holdsLiveJcrc(db, userID)) ||
      (await holdsStoredAdmin(db, userID));
    return { isDirector, canRead };
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/** Refuse unless this person may read the board; returns who they are. */
export async function assertBoardReader(
  db: EquipmentAccessDb,
  userID: string,
): Promise<BoardViewer> {
  const viewer = await loadBoardViewer(db, userID);
  if (!viewer.canRead) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_EQUIPMENT_READER });
  }
  return viewer;
}

/** Refuse unless this person is the Social director now. */
export const assertDirector = (db: EquipmentAccessDb, userID: string) =>
  assertSocialDirector(db, userID);

/**
 * Is this person one of the leaders of an event owned by `ccaID` (null is
 * hall-wide)? The disposables filing rule, so the two cannot drift apart.
 */
export const isEventLeader = (
  db: EquipmentAccessDb,
  userID: string,
  ccaID: number | null,
) => mayFile(db, userID, ccaID);

/** Refuse unless the person is a leader of the event's CCA now. */
export async function assertEventLeader(
  db: EquipmentAccessDb,
  userID: string,
  ccaID: number | null,
): Promise<void> {
  if (!(await isEventLeader(db, userID, ccaID))) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_EVENT_LEADER });
  }
}

/**
 * Is this person the Social director or a leader of the loan's CCA? The
 * check behind collecting, returning, cancelling and reading the photo.
 * Returns which of the two they are, so the caller can word things. The
 * director is checked first, with its own strict reads; a failed read refuses.
 */
export async function directorOrLeader(
  db: EquipmentAccessDb,
  userID: string,
  ccaID: number | null,
): Promise<{ director: boolean; leader: boolean }> {
  let director: boolean;
  try {
    director = await isSocialDirector(db, userID);
  } catch (err) {
    return refuseOnFailure(err);
  }
  const leader = await isEventLeader(db, userID, ccaID);
  return { director, leader };
}
