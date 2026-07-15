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

export async function deleteFacilityCascade(db: PrismaClient, facilityID: number) {
  return db.$transaction(async (tx) => {
    await tx.bookings.deleteMany({ where: { facilityID } });
    await tx.crowd.deleteMany({ where: { facilityID } });
    return tx.facilities.delete({ where: { facilityID } });
  });
}

export async function deleteCcaCascade(db: PrismaClient, ccaID: number) {
  return db.$transaction(async (tx) => {
    await tx.posts.deleteMany({ where: { ccaID } });
    await tx.userCCA.deleteMany({ where: { ccaID } });
    await tx.bookings.deleteMany({ where: { ccaID } });
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

export async function deleteSupperGroupCascade(db: PrismaClient, supperGroupId: number) {
  return db.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { supperGroupId } });
    return tx.supperGroup.delete({ where: { supperGroupId } });
  });
}
