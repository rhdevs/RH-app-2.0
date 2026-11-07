import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * JCRC POSITIONS — VIEWS ONLY, NEVER PERMISSIONS.
 *
 * A position (President, VP Internal, Sports Director (Internal), ...) lists
 * the CCAs its holders look after. The ONLY thing it does is set the default
 * "My positions" filter on JCRC lists; an "All CCAs" switch sits beside it.
 * Every JCRC member keeps every power over every CCA, exactly as before.
 *
 * THE RULE: nothing in this file may be used to REFUSE an action. If a guard
 * ever calls myPositionCcas, positions have silently become permissions, and
 * a JCRC member covering for a colleague gets locked out of the very CCA they
 * were asked to help with. Filter lists with it; never authorize with it.
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
