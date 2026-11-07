import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { JCRC_ROLE } from "~/lib/roleNames";
import { activeHolderWhere } from "~/server/api/services/jcrcPositions";
import { normalizeStoredRoles } from "~/server/api/services/roles";

/**
 * THE STRICT DIRECTOR GUARD. The only code outside the positions files that
 * reads `vetsProposals` or `handlesDisposables`.
 *
 * A "director" is a person who, right now, holds `jcrc` AND has a current
 * holder row on a position flagged `vetsProposals` that lists the CCA. The
 * Social director is the current holder of the one position flagged
 * `handlesDisposables`. This is a working rule that records who vetted what,
 * not a security boundary: whoever may edit a flagged position (admin, RFs,
 * Hall Office) can make someone a director, and every such edit is audited.
 *
 * FAILS CLOSED, BY DOING ITS OWN READS WITH NO CATCH AROUND ANY OF THEM.
 * getUserRoles is forgiving on purpose: if the JcrcTerm read throws it keeps
 * the stored roles, so a database fault does not log every JCRC member out.
 * That is wrong for an approval, where an ended director could still act while
 * the read fails. So this module reads the stored roles, the JcrcTerm row, the
 * person's holder rows, the flagged positions among them and those positions'
 * CCA lists itself, and a read that throws propagates:
 *  - isDirectorOf / isSocialDirector / directedCcaIDs reject, so a failure can
 *    never be mistaken for "no";
 *  - assertDirectorOf / assertSocialDirector turn that rejection into a refusal
 *    and log the error NAME only (a driver message can carry stored values).
 *    That catch sits around the whole decision, never around one read, and it
 *    only ever refuses.
 * During a database fault a director cannot act until it passes. Nothing is
 * written by anything in this file.
 *
 * WHAT IT MUST NEVER USE. Not getUserRoles, not the session's roles, and not
 * myPositionCcas, which hands every CCA to a member who holds no position and
 * to a holder of an oversees-all position: that is built for views. The
 * oversees-all switch grants nothing here; a director acts only on the CCAs a
 * flagged position LISTS. A source scan in directorIsolation.test.ts keeps
 * those imports out.
 *
 * `directors.enabled` is the master switch. Off, absent or unreadable means no
 * flag grants anything. Who may act is always worked out here, from the stored
 * rows, every time; callers pass a user id and a CCA id they derived on the
 * server, never a position named by the browser.
 */

export const DIRECTORS_FLAG_KEY = "directors.enabled";
export const NOT_DIRECTOR = "NOT_DIRECTOR";
export const NOT_SOCIAL_DIRECTOR = "NOT_SOCIAL_DIRECTOR";
export const DIRECTOR_CHECK_FAILED = "DIRECTOR_CHECK_FAILED";

type GuardDb = Pick<
  PrismaClient,
  | "systemFlag"
  | "userRole"
  | "jcrcTerm"
  | "jcrcPositionHolder"
  | "jcrcPosition"
  | "jcrcPositionCca"
>;

/** The strict read: a throw propagates. Only the exact value "on" is on. */
async function readDirectorsFlag(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  const row = await db.systemFlag.findUnique({
    where: { key: DIRECTORS_FLAG_KEY },
  });
  return row?.value === "on";
}

/**
 * The forgiving read for screens: an absent row, any other value or a failed
 * read is off. Never use it to authorize; the guard reads the flag itself.
 */
export async function isDirectorsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    return await readDirectorsFlag(db);
  } catch {
    return false;
  }
}

/**
 * Which of these people hold `jcrc` right now: stored on their role row AND
 * not past a JcrcTerm end date. The end-date rule is dropEndedJcrcRole's: a
 * term whose `endsAt` is at or before now ends the role. Unlike
 * dropEndedJcrcRole, a failed read throws.
 */
async function liveJcrcHolders(
  db: GuardDb,
  userIDs: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (userIDs.length === 0) return new Set();
  const rows = await db.userRole.findMany({
    where: { userID: { in: [...userIDs] } },
    select: { userID: true, roles: true, role: true },
  });
  const stored = rows
    .filter((r) => {
      const raw = r.roles?.length ? r.roles : r.role ? [r.role] : [];
      return normalizeStoredRoles(raw).includes(JCRC_ROLE);
    })
    .map((r) => r.userID);
  if (stored.length === 0) return new Set();
  const ended = await db.jcrcTerm.findMany({
    where: { userID: { in: stored }, endsAt: { lte: now } },
    select: { userID: true },
  });
  const endedIDs = new Set(ended.map((t) => t.userID));
  return new Set(stored.filter((id) => !endedIDs.has(id)));
}

/**
 * The positions flagged `vetsProposals` that this person holds right now, or
 * [] when the switch is off, they do not hold a live `jcrc`, or they hold none.
 */
async function directedPositionIDs(
  db: GuardDb,
  userID: string,
  now: Date,
): Promise<string[]> {
  if (!(await readDirectorsFlag(db))) return [];
  if (!(await liveJcrcHolders(db, [userID], now)).has(userID)) return [];
  const held = await db.jcrcPositionHolder.findMany({
    where: { userID, ...activeHolderWhere(now) },
    select: { positionID: true },
  });
  if (held.length === 0) return [];
  const flagged = await db.jcrcPosition.findMany({
    where: {
      id: { in: held.map((h) => h.positionID) },
      vetsProposals: true,
    },
    select: { id: true },
  });
  return flagged.map((p) => p.id);
}

/** Whether this person is a director of this CCA now. Rejects if a read fails. */
export async function isDirectorOf(
  db: GuardDb,
  userID: string,
  ccaID: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (!Number.isInteger(ccaID)) return false;
  const positionIDs = await directedPositionIDs(db, userID, now);
  if (positionIDs.length === 0) return false;
  const link = await db.jcrcPositionCca.findFirst({
    where: { positionID: { in: positionIDs }, ccaID },
    select: { id: true },
  });
  return link !== null;
}

/**
 * The CCAs this person directs now, ascending. The list is filtered in the
 * query: only rows of their own flagged positions are read, so a caller never
 * has a list of other CCAs to trim in the browser or in code. Rejects if a
 * read fails.
 */
export async function directedCcaIDs(
  db: GuardDb,
  userID: string,
  now: Date = new Date(),
): Promise<number[]> {
  const positionIDs = await directedPositionIDs(db, userID, now);
  if (positionIDs.length === 0) return [];
  const links = await db.jcrcPositionCca.findMany({
    where: { positionID: { in: positionIDs } },
    select: { ccaID: true },
  });
  return [...new Set(links.map((l) => l.ccaID))].sort((a, b) => a - b);
}

/**
 * Whether this person is the Social director now: a live `jcrc`, and a
 * current holder row on the position flagged `handlesDisposables`, when
 * EXACTLY ONE position carries that flag. With none, or with two (a second
 * flag set by mistake), nobody has the power. Rejects if a read fails.
 */
export async function isSocialDirector(
  db: GuardDb,
  userID: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!(await readDirectorsFlag(db))) return false;
  if (!(await liveJcrcHolders(db, [userID], now)).has(userID)) return false;
  const held = await db.jcrcPositionHolder.findMany({
    where: { userID, ...activeHolderWhere(now) },
    select: { positionID: true },
  });
  if (held.length === 0) return false;
  // take: 2 is enough to tell "exactly one" from "more than one".
  const flagged = await db.jcrcPosition.findMany({
    where: { handlesDisposables: true },
    select: { id: true },
    take: 2,
  });
  const only = flagged.length === 1 ? flagged[0] : undefined;
  return only !== undefined && held.some((h) => h.positionID === only.id);
}

/**
 * Run a decision, refusing if any read inside it throws. The catch is around
 * the whole decision and only ever refuses; it logs the error name alone.
 */
async function refuseUnless(
  decide: () => Promise<boolean>,
  deniedMessage: string,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await decide();
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "director_guard_read_failed",
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    throw new TRPCError({ code: "FORBIDDEN", message: DIRECTOR_CHECK_FAILED });
  }
  if (!allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: deniedMessage });
  }
}

/** Refuse unless this person is a director of this CCA now. */
export function assertDirectorOf(
  db: GuardDb,
  userID: string,
  ccaID: number,
  now: Date = new Date(),
): Promise<void> {
  return refuseUnless(() => isDirectorOf(db, userID, ccaID, now), NOT_DIRECTOR);
}

/** Refuse unless this person is the Social director now. */
export function assertSocialDirector(
  db: GuardDb,
  userID: string,
  now: Date = new Date(),
): Promise<void> {
  return refuseUnless(
    () => isSocialDirector(db, userID, now),
    NOT_SOCIAL_DIRECTOR,
  );
}

/**
 * Whether a flagged position has no current qualifying holder: no holder row,
 * every row ended, or holders without a live `jcrc`. Computed on read; the
 * vacancy mark and notices are a later PR's. Rejects if a read fails.
 */
export async function isPositionVacant(
  db: GuardDb,
  positionID: string,
  now: Date = new Date(),
): Promise<boolean> {
  const holders = await db.jcrcPositionHolder.findMany({
    where: { positionID, ...activeHolderWhere(now) },
    select: { userID: true },
  });
  const live = await liveJcrcHolders(
    db,
    holders.map((h) => h.userID),
    now,
  );
  return live.size === 0;
}

/**
 * Whether no position flagged `vetsProposals` that lists this CCA has a
 * current qualifying holder. A CCA no flagged position lists is vacant too:
 * nobody can act for it. Rejects if a read fails.
 */
export async function isCcaVacant(
  db: GuardDb,
  ccaID: number,
  now: Date = new Date(),
): Promise<boolean> {
  const links = await db.jcrcPositionCca.findMany({
    where: { ccaID },
    select: { positionID: true },
  });
  if (links.length === 0) return true;
  const flagged = await db.jcrcPosition.findMany({
    where: { id: { in: links.map((l) => l.positionID) }, vetsProposals: true },
    select: { id: true },
  });
  if (flagged.length === 0) return true;
  const holders = await db.jcrcPositionHolder.findMany({
    where: {
      positionID: { in: flagged.map((p) => p.id) },
      ...activeHolderWhere(now),
    },
    select: { userID: true },
  });
  const live = await liveJcrcHolders(
    db,
    holders.map((h) => h.userID),
    now,
  );
  return live.size === 0;
}
