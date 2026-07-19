import type { PrismaClient } from "@prisma/client";

/**
 * Referential cleanup for the Int-keyed domain models (#17).
 *
 * These models reference each other by scalar business keys (facilityID, ccaID,
 * userID, supperGroupId) rather than ObjectId relations, so Prisma can't cascade
 * for them. Route every parent delete through these helpers so dependents are
 * removed in the same transaction instead of being orphaned.
 *
 * NOTE: interactive transactions require a MongoDB replica set (MongoDB Atlas
 * provides one). For the ObjectId-keyed Food domain, prefer native Prisma
 * relations with `onDelete: Cascade` — see scripts/remediation/README.md.
 */

export async function deleteFacilityCascade(
  db: PrismaClient,
  facilityID: number,
) {
  return db.$transaction(async (tx) => {
    await tx.bookings.deleteMany({ where: { facilityID } });
    await tx.crowd.deleteMany({ where: { facilityID } });
    return tx.facilities.delete({ where: { facilityID } });
  });
}

/**
 * NO UI REACHES THIS. CCA deletion is deliberately not exposed by any surface —
 * not /cca, not /admin/ccas, not /admin/manage-ccas. It remains here for scripts
 * only, and the two guards below exist because "there is no button" is not a
 * safety property: a script, a REPL, or a future contributor can still call it.
 *
 * GUARD 1 — ccaID 0 IS RESERVED (07-cca-future.md §5).
 * BookingModal.tsx hardcodes `ccaID: 0` on every booking the current UI creates.
 * The bookings.deleteMany below matches on ccaID, so deleting a CCA row that
 * happens to hold ccaID 0 would delete EVERY BOOKING IN THE SYSTEM. There is no
 * reserved-value constraint on the column, so this is enforced here.
 *
 * GUARD 2 — CcaHead must be cleaned up (07-cca-future.md §5.1).
 * Orphaned CcaHead rows keep an ex-head's `cca_head` string alive permanently:
 * revokeCcaHead drops the string only when `remaining === 0`, and that count
 * never reaches zero because the row survives — while the CCA no longer exists
 * to revoke against. That is CH-1 drift the string↔row detector cannot see,
 * because it checks string↔row, not row↔CCA.
 */
export async function deleteCcaCascade(db: PrismaClient, ccaID: number) {
  if (ccaID === 0) throw new Error("RESERVED_CCAID");
  return db.$transaction(async (tx) => {
    await tx.posts.deleteMany({ where: { ccaID } });
    await tx.userCCA.deleteMany({ where: { ccaID } });
    await tx.bookings.deleteMany({ where: { ccaID } });
    await tx.ccaHead.deleteMany({ where: { ccaID } });
    return tx.cCA.delete({ where: { ccaID } });
  });
}

export async function deleteUserCascade(db: PrismaClient, userID: string) {
  return db.$transaction(async (tx) => {
    await tx.bookings.deleteMany({ where: { userID } });
    await tx.posts.deleteMany({ where: { userID } });
    await tx.order.deleteMany({ where: { userID } });
    await tx.userCCA.deleteMany({ where: { userID } });
    await tx.gym.deleteMany({ where: { userID } });
    // Session / Account already cascade via native relations on User.
    // userID isn't unique on User, so delete by the matched rows.
    return tx.user.deleteMany({ where: { userID } });
  });
}

export async function deleteSupperGroupCascade(
  db: PrismaClient,
  supperGroupId: number,
) {
  return db.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { supperGroupId } });
    return tx.supperGroup.delete({ where: { supperGroupId } });
  });
}
