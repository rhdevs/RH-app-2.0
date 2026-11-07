import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * JCRC POSITIONS — VIEWS, EXCEPT FOR A FLAGGED POSITION.
 *
 * A position (President, VP Internal, Sports Director (Internal), ...) lists
 * the CCAs its holders look after. What it does for everyone is set the default
 * "My positions" filter on JCRC lists; an "All CCAs" switch sits beside it.
 * Every JCRC member keeps every power over every CCA, exactly as before, and
 * the existing event, points and CCA guards never read positions.
 *
 * A position an admin has flagged `vetsProposals` or `handlesDisposables` is
 * ALSO a permission, but only for the director features, and only through
 * services/directorGuard.ts, which does its own strict reads. Editing a
 * flagged position is locked (services/jcrcPositionLock.ts).
 *
 * THE RULE FOR THIS FILE: nothing in it may be used to REFUSE or GRANT an
 * action. myPositionCcas returns every CCA for a member with no position and
 * for an oversees-all holder, so a guard built on it would hand every
 * unplaced member every CCA. Filter lists with it; never authorize with it.
 */

/** A list's view: the caller's positions, or every CCA. */
export type PositionView = "mine" | "all";

/** Every CCA, or exactly these ccaIDs. */
export type PositionScope = "all" | readonly number[];

/**
 * A holder row counts until its `endsAt` (set by a handover). Rows without the
 * field and rows with an explicit null both mean "no end date".
 */
export function activeHolderWhere(
  now: Date,
): Prisma.JcrcPositionHolderWhereInput {
  return {
    OR: [
      { endsAt: { isSet: false } },
      { endsAt: null },
      { endsAt: { gt: now } },
    ],
  };
}

/**
 * Ends this person's current holder rows on FLAGGED positions (director
 * positions) as of now. Called by applyRoleChange, inside its transaction, when
 * `jcrc` is taken away: the director guard already ignores a holder without a
 * live `jcrc`, but the row would wake up the day `jcrc` is granted again.
 * Rows on unflagged positions are views only and stay. It changes rows and
 * decides nothing about who may act.
 */
export async function endFlaggedHolderRows(
  db: Pick<PrismaClient, "jcrcPositionHolder" | "jcrcPosition">,
  userID: string,
  now: Date = new Date(),
): Promise<void> {
  const held = await db.jcrcPositionHolder.findMany({
    where: { userID, ...activeHolderWhere(now) },
    select: { positionID: true },
  });
  if (held.length === 0) return;
  const flagged = await db.jcrcPosition.findMany({
    where: {
      id: { in: held.map((h) => h.positionID) },
      OR: [{ vetsProposals: true }, { handlesDisposables: true }],
    },
    select: { id: true },
  });
  if (flagged.length === 0) return;
  await db.jcrcPositionHolder.updateMany({
    where: { userID, positionID: { in: flagged.map((p) => p.id) } },
    data: { endsAt: now },
  });
}

/**
 * Pure core of myPositionCcas. A member who holds no position, or any
 * oversees-all position, sees every CCA: the ship-day default is that nothing
 * changes for anyone until positions are set up.
 */
export function scopeFromPositions(
  positions: readonly { overseesAll: boolean; ccaIDs: readonly number[] }[],
): PositionScope {
  if (positions.length === 0) return "all";
  if (positions.some((p) => p.overseesAll)) return "all";
  return [...new Set(positions.flatMap((p) => p.ccaIDs))].sort((a, b) => a - b);
}

/** The CCAs the "My positions" view shows for this user. */
export async function myPositionCcas(
  db: PrismaClient,
  userID: string,
  now: Date = new Date(),
): Promise<PositionScope> {
  const held = await db.jcrcPositionHolder.findMany({
    where: { userID, ...activeHolderWhere(now) },
    select: { positionID: true },
  });
  if (held.length === 0) return "all";
  const positionIDs = held.map((h) => h.positionID);
  const [positions, links] = await Promise.all([
    db.jcrcPosition.findMany({
      where: { id: { in: positionIDs } },
      select: { id: true, overseesAll: true },
    }),
    db.jcrcPositionCca.findMany({
      where: { positionID: { in: positionIDs } },
      select: { positionID: true, ccaID: true },
    }),
  ]);
  return scopeFromPositions(
    positions.map((p) => ({
      overseesAll: p.overseesAll,
      ccaIDs: links.filter((l) => l.positionID === p.id).map((l) => l.ccaID),
    })),
  );
}

/**
 * The scope a list should filter by: everything for the "all" view, otherwise
 * the caller's positions.
 */
export async function scopeForView(
  db: PrismaClient,
  userID: string,
  view: PositionView,
): Promise<PositionScope> {
  return view === "all" ? "all" : myPositionCcas(db, userID);
}

/** Whether a CCA is inside a scope. */
export function inScope(scope: PositionScope, ccaID: number): boolean {
  return scope === "all" || scope.includes(ccaID);
}

/**
 * A Prisma `ccaID` filter for a scope, or undefined for "all" so the caller
 * can spread it into a where clause unchanged.
 */
export function ccaIDFilter(
  scope: PositionScope,
): { ccaID: { in: number[] } } | undefined {
  return scope === "all" ? undefined : { ccaID: { in: [...scope] } };
}
