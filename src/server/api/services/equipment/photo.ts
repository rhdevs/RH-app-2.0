import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import {
  EQUIPMENT_PHOTO_NAME,
  equipmentPhotoFolder,
  equipmentPhotoPathFromUrl,
  parseEquipmentPhotoPath,
} from "~/lib/equipment/photo";
import {
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_ORPHAN_SCAN_MAX,
  EVIDENCE_UNATTACHED_TTL_MS,
} from "~/lib/schemas/milestoneEvidence";
import type { EvidenceStorage } from "~/server/api/services/milestoneBlob";
import {
  directorOrLeader,
  NOT_EVENT_LEADER,
  type EquipmentAccessDb,
} from "./access";
import { assertEquipmentEnabled } from "./flag";
import { assertWithinLimit } from "./limits";
import { EQUIPMENT_BAD_MOVE } from "./transition";

/**
 * The optional return photo: the milestone evidence pattern, with its own
 * folder (`equipment-return/<loan id>/`), its own access rule (the Social
 * director and the event leaders) and the same type, size and rate limits.
 * Every storage call goes through the one replaceable module (milestoneBlob.ts),
 * passed in as `storage`. The photo is attached to the loan only by the
 * "mark returned" transition (decide.ts), so a photo that is uploaded and never
 * used has no row at all and is swept from the loan folder by the next upload.
 */

export const EQUIPMENT_BAD_PATHNAME = "BAD_PATHNAME";
export const EQUIPMENT_BAD_FILE = "EQUIPMENT_BAD_FILE";
export const EQUIPMENT_NOT_UPLOADED = "EQUIPMENT_NOT_UPLOADED";
export const EQUIPMENT_PHOTO_TOO_MANY = "EQUIPMENT_PHOTO_TOO_MANY";

/** A loan has one photo; a few spare uploads are allowed for a retry. */
export const PHOTO_FILES_PER_LOAN_MAX = 3;

type PhotoDb = EquipmentAccessDb &
  Pick<PrismaClient, "equipmentLoan" | "systemFlag">;

/**
 * Remove files in a loan folder that were uploaded more than the window ago
 * and are not the loan recorded photo. A listing that fails comes back empty
 * (the storage module logs it), so the upload that triggered this is not
 * blocked. Returns how many files remain in the folder.
 */
export async function sweepLoanFolder(
  db: Pick<PhotoDb, "equipmentLoan">,
  storage: Pick<EvidenceStorage, "listBlobs" | "remove">,
  loanID: string,
  now: Date,
): Promise<number> {
  const listed = (
    await storage.listBlobs(
      equipmentPhotoFolder(loanID),
      EVIDENCE_ORPHAN_SCAN_MAX,
    )
  ).filter((b) => parseEquipmentPhotoPath(b.pathname)?.loanID === loanID);
  const row = await db.equipmentLoan.findUnique({
    where: { id: loanID },
    select: { returnPhoto: true },
  });
  const cutoff = now.getTime() - EVIDENCE_UNATTACHED_TTL_MS;
  let left = listed.length;
  for (const blob of listed) {
    if (blob.pathname === row?.returnPhoto) continue;
    if (blob.uploadedAt.getTime() >= cutoff) continue;
    if (await storage.remove(blob.pathname)) left -= 1;
  }
  return left;
}

/**
 * The whole check behind the upload-token route, in order, each step refusing
 * before the next runs:
 *  1. `equipment.enabled` (fails CLOSED);
 *  2. the requested pathname is exactly `equipment-return/<loan id>/photo.<ext>`;
 *  3. the loan exists and the caller is the Social director or leads its
 *     event CCA now (strict). A missing loan answers like a stranger;
 *  4. the loan is collected (the photo is for the return);
 *  5. old stray files are cleared and the per-loan cap is checked;
 *  6. the per-person hourly ceiling.
 */
export async function authorizeReturnPhotoUpload(
  db: PhotoDb,
  storage: Pick<EvidenceStorage, "listBlobs" | "remove">,
  userID: string,
  pathname: string,
  now: Date = new Date(),
): Promise<{ loanID: string }> {
  await assertEquipmentEnabled(db);
  const target = parseEquipmentPhotoPath(pathname);
  if (target === null || target.name !== EQUIPMENT_PHOTO_NAME) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: EQUIPMENT_BAD_PATHNAME,
    });
  }
  const loan = await db.equipmentLoan.findUnique({
    where: { id: target.loanID },
    select: { ccaID: true, status: true },
  });
  const who = loan
    ? await directorOrLeader(db, userID, loan.ccaID ?? null)
    : { director: false, leader: false };
  if (!loan || (!who.director && !who.leader)) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_EVENT_LEADER });
  }
  if (loan.status !== "collected") {
    throw new TRPCError({ code: "CONFLICT", message: EQUIPMENT_BAD_MOVE });
  }
  const left = await sweepLoanFolder(db, storage, target.loanID, now);
  if (left >= PHOTO_FILES_PER_LOAN_MAX) {
    throw new TRPCError({
      code: "CONFLICT",
      message: EQUIPMENT_PHOTO_TOO_MANY,
    });
  }
  await assertWithinLimit("upload", userID);
  return { loanID: target.loanID };
}

/**
 * After a loan has been returned: remove every OTHER file in its photo folder
 * (spare uploads from retries), keeping only the photo the loan now holds, or
 * nothing when it was returned without one. Best effort after the commit: a
 * failure is logged by error name only and never fails the return.
 */
export async function removeOtherPhotos(
  storage: Pick<EvidenceStorage, "listBlobs" | "remove">,
  loanID: string,
  keep: string | null,
): Promise<void> {
  try {
    const listed = await storage.listBlobs(
      equipmentPhotoFolder(loanID),
      EVIDENCE_ORPHAN_SCAN_MAX,
    );
    for (const blob of listed) {
      if (blob.pathname === keep) continue;
      if (parseEquipmentPhotoPath(blob.pathname)?.loanID !== loanID) continue;
      await storage.remove(blob.pathname);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "equipment_photo_cleanup_failed",
        err: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
}

export type CheckedPhoto = {
  pathname: string;
  contentType: string;
  size: number;
};

/**
 * Check the photo a person says they uploaded for THIS loan. The address is
 * worked out to a pathname (our private store, our folder, nothing else) and
 * must name this loan folder; then the store itself says what the file is.
 * Size and type come from the store, not the browser, and a file that is not
 * an allowed image within the bound is deleted and refused.
 */
export async function checkReturnPhoto(
  storage: Pick<EvidenceStorage, "host" | "head" | "remove">,
  loanID: string,
  url: string,
): Promise<CheckedPhoto> {
  const pathname = equipmentPhotoPathFromUrl(url, storage.host());
  const target = pathname === null ? null : parseEquipmentPhotoPath(pathname);
  if (pathname === null || target === null || target.loanID !== loanID) {
    throw new TRPCError({ code: "BAD_REQUEST", message: EQUIPMENT_BAD_FILE });
  }
  const stored = await storage.head(pathname);
  if (stored === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: EQUIPMENT_NOT_UPLOADED,
    });
  }
  const contentType = stored.contentType.toLowerCase();
  const allowed =
    (EVIDENCE_CONTENT_TYPES as readonly string[]).includes(contentType) &&
    contentType === target.contentType &&
    stored.size > 0 &&
    stored.size <= EVIDENCE_MAX_BYTES;
  if (!allowed) {
    await storage.remove(pathname);
    throw new TRPCError({ code: "BAD_REQUEST", message: EQUIPMENT_BAD_FILE });
  }
  return { pathname, contentType, size: stored.size };
}
