import type { PrismaClient } from "@prisma/client";

/**
 * Role lookups (#23). Roles live in the `UserRole` collection and facility
 * requirements in `FacilityAccess`, keeping them out of the validator-guarded
 * `User` / `Facilities` collections. A facility with no `FacilityAccess` row is
 * open to everyone; `admin` can book anything.
 */

export const ADMIN_ROLE = "admin";
export const DEFAULT_ROLE = "user";

export async function getUserRole(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<string> {
  if (!userID) return DEFAULT_ROLE;
  const row = await db.userRole.findUnique({ where: { userID } });
  return row?.role ?? DEFAULT_ROLE;
}

export async function getFacilityRequiredRole(
  db: PrismaClient,
  facilityID: number,
): Promise<string | null> {
  const row = await db.facilityAccess.findUnique({ where: { facilityID } });
  return row?.requiredRole ?? null;
}

/** Whether `userID` may book `facilityID`, considering role requirements. */
export async function canBookFacility(
  db: PrismaClient,
  userID: string | undefined | null,
  facilityID: number,
): Promise<boolean> {
  const required = await getFacilityRequiredRole(db, facilityID);
  if (!required) return true;
  const role = await getUserRole(db, userID);
  return role === required || role === ADMIN_ROLE;
}
