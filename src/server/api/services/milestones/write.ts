import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  EVIDENCE_CLEANUP_BATCH,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_UNATTACHED,
  EVIDENCE_ORPHAN_SCAN_MAX,
  EVIDENCE_UNATTACHED_TTL_MS,
  evidenceFolder,
  evidencePathFromUrl,
  parseEvidencePath,
} from "~/lib/schemas/milestoneEvidence";
import type { EvidenceStorage } from "~/server/api/services/milestoneBlob";
import {
  assertEvidenceHead,
  EVIDENCE_NOT_FOUND,
  type EvidenceAccessDb,
} from "./access";
import { assertMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";

/**
 * The evidence writes: the upload-token check, recording an uploaded photo,
 * removing an unattached one, and the lazy cleanup of stale ones. Who may act
 * comes from access.ts (a current head of the owning CCA), never from the
 * session's roles and never from a body field: the CCA is read from the
 * server-checked pathname, and every storage call goes through the one
 * replaceable module (milestoneBlob.ts), passed in as `storage`.
 *
 * This file catches nothing (a source scan keeps it so): a refusal is thrown, a
 * failed read fails the call, and the storage module's own delete is the one
 * place that swallows a failure, logging it by error name.
 */

export type EvidenceDb = EvidenceAccessDb &
  Pick<PrismaClient, "milestoneEvidence" | "systemFlag">;

export const EVIDENCE_BAD_PATHNAME = "BAD_PATHNAME";
export const EVIDENCE_BAD_FILE = "EVIDENCE_BAD_FILE";
export const EVIDENCE_NOT_UPLOADED = "EVIDENCE_NOT_UPLOADED";
export const EVIDENCE_DUPLICATE = "EVIDENCE_DUPLICATE";
export const EVIDENCE_TOO_MANY = "EVIDENCE_TOO_MANY";
export const EVIDENCE_ATTACHED = "EVIDENCE_ATTACHED";
export const EVIDENCE_STORAGE_UNAVAILABLE = "EVIDENCE_STORAGE_UNAVAILABLE";

/** The one name an upload may ask for; Vercel adds `-<random>` before the extension. */
export const EVIDENCE_UPLOAD_NAME = "evidence";

export type EvidenceView = {
  id: string;
  contentType: string;
  size: number;
  createdAt: Date;
};

const VIEW_SELECT = {
  id: true,
  contentType: true,
  size: true,
  createdAt: true,
} as const;

/**
 * Remove up to EVIDENCE_CLEANUP_BATCH of this CCA's unattached photos that are
 * older than the window: the ROW first, and only while it is still unattached
 * (a conditional delete), then the file. A photo attached between the read and
 * the delete matches nothing, so its row and its file are both kept. If the
 * file then cannot be deleted, the file is left without a row; that is an
 * orphan the next upload's `cleanupOrphanEvidence` removes once it is old
 * enough, so nothing is lost for good. A delete that fails is logged by the
 * storage module and never blocks the upload that triggered this. Returns how
 * many rows were cleared.
 */
export async function cleanupStaleEvidence(
  db: Pick<EvidenceDb, "milestoneEvidence">,
  storage: Pick<EvidenceStorage, "remove">,
  ccaID: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EVIDENCE_UNATTACHED_TTL_MS);
  const stale = await db.milestoneEvidence.findMany({
    where: { ccaID, submissionID: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: EVIDENCE_CLEANUP_BATCH,
    select: { id: true, pathname: true },
  });
  let cleared = 0;
  for (const row of stale) {
    const deleted = await db.milestoneEvidence.deleteMany({
      where: { id: row.id, submissionID: null },
    });
    // Attached (or gone) since the read: keep its file.
    if (deleted.count !== 1) continue;
    cleared += 1;
    await storage.remove(row.pathname);
  }
  return cleared;
}

/**
 * Remove up to EVIDENCE_CLEANUP_BATCH files in this CCA's folder that were
 * uploaded more than the window ago and have NO row at all: an upload whose
 * photo was never recorded (the browser closed, the record refused, or a token
 * used to send files the app never heard about). They are invisible to the cap
 * and to cleanupStaleEvidence, so this lists the folder, bounded to
 * EVIDENCE_ORPHAN_SCAN_MAX, and checks the candidates against the rows. A file
 * that has a row, attached or not, is never touched here. Only names that are
 * exactly one of our evidence pathnames in THIS CCA's folder are considered.
 * A listing that fails comes back empty (the storage module logs it), so the
 * upload that triggered this is not blocked. Returns how many were removed.
 */
export async function cleanupOrphanEvidence(
  db: Pick<EvidenceDb, "milestoneEvidence">,
  storage: Pick<EvidenceStorage, "listBlobs" | "remove">,
  ccaID: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = now.getTime() - EVIDENCE_UNATTACHED_TTL_MS;
  const listed = await storage.listBlobs(
    evidenceFolder(ccaID),
    EVIDENCE_ORPHAN_SCAN_MAX,
  );
  const old = listed
    .slice(0, EVIDENCE_ORPHAN_SCAN_MAX)
    .filter((b) => b.uploadedAt.getTime() < cutoff)
    .filter((b) => parseEvidencePath(b.pathname)?.ccaID === ccaID)
    .map((b) => b.pathname);
  if (old.length === 0) return 0;

  const known = await db.milestoneEvidence.findMany({
    where: { pathname: { in: old } },
    select: { pathname: true },
  });
  const hasRow = new Set(known.map((r) => r.pathname));
  let removed = 0;
  for (const pathname of old.filter((p) => !hasRow.has(p))) {
    if (removed >= EVIDENCE_CLEANUP_BATCH) break;
    if (await storage.remove(pathname)) removed += 1;
  }
  return removed;
}

async function assertRoomForOne(
  db: Pick<EvidenceDb, "milestoneEvidence">,
  ccaID: number,
): Promise<void> {
  const held = await db.milestoneEvidence.count({
    where: { ccaID, submissionID: null },
  });
  if (held >= EVIDENCE_MAX_UNATTACHED) {
    throw new TRPCError({ code: "CONFLICT", message: EVIDENCE_TOO_MANY });
  }
}

/**
 * The whole check behind the upload-token route, in order, each step refusing
 * before the next runs:
 *  1. `milestones.enabled` (fails CLOSED);
 *  2. the requested pathname is exactly `milestone-evidence/<ccaID>/evidence.<ext>`
 *     (the client only names the CCA and the extension; the folder and file
 *     name are the server's, and Blob adds the random suffix);
 *  3. the caller heads THAT CCA now (the strict guard, never the session);
 *  4. this CCA's stale unattached photos are cleared (lazy cleanup), then the
 *     cap on unattached photos is checked;
 *  5. the per-person hourly upload ceiling.
 * Returns the CCA the token is for. Size and type are fixed by the route at
 * minting, by Blob itself; the file is never read by this server.
 */
export async function authorizeEvidenceUpload(
  db: EvidenceDb,
  storage: Pick<EvidenceStorage, "remove" | "listBlobs">,
  userID: string,
  pathname: string,
  now: Date = new Date(),
): Promise<{ ccaID: number }> {
  await assertMilestonesEnabled(db);
  const target = parseEvidencePath(pathname);
  if (target === null || target.name !== EVIDENCE_UPLOAD_NAME) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: EVIDENCE_BAD_PATHNAME,
    });
  }
  await assertEvidenceHead(db, userID, target.ccaID);
  await cleanupStaleEvidence(db, storage, target.ccaID, now);
  await cleanupOrphanEvidence(db, storage, target.ccaID, now);
  await assertRoomForOne(db, target.ccaID);
  await assertWithinLimit("upload", userID);
  return { ccaID: target.ccaID };
}

/**
 * Save the row for a photo the browser has just uploaded. The browser sends the
 * CCA and the address it was given; this works out the pathname from the
 * address (evidencePathFromUrl: our private store, our evidence folder, nothing
 * else) and requires it to be THIS CCA's folder, then asks the store itself
 * what the file is. Size and type come from the store, not the browser, and a
 * file that is not an allowed image within the size bound is deleted and
 * refused. A valid file refused only because the CCA is full is LEFT in the
 * store (see the cap check). The caller must head the CCA now.
 */
export async function recordEvidence(
  db: EvidenceDb,
  storage: Pick<EvidenceStorage, "host" | "head" | "remove">,
  userID: string,
  input: { ccaID: number; url: string },
): Promise<EvidenceView> {
  await assertMilestonesEnabled(db);
  await assertEvidenceHead(db, userID, input.ccaID);

  const pathname = evidencePathFromUrl(input.url, storage.host());
  const target = pathname === null ? null : parseEvidencePath(pathname);
  // Another CCA's folder is refused without touching the file: it is not ours.
  if (pathname === null || target === null || target.ccaID !== input.ccaID) {
    throw new TRPCError({ code: "BAD_REQUEST", message: EVIDENCE_BAD_FILE });
  }
  await assertWithinLimit("record", userID);

  const existing = await db.milestoneEvidence.findFirst({
    where: { pathname },
    select: { id: true },
  });
  if (existing !== null) {
    throw new TRPCError({ code: "CONFLICT", message: EVIDENCE_DUPLICATE });
  }

  const stored = await storage.head(pathname);
  if (stored === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: EVIDENCE_NOT_UPLOADED,
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
    throw new TRPCError({ code: "BAD_REQUEST", message: EVIDENCE_BAD_FILE });
  }

  const held = await db.milestoneEvidence.count({
    where: { ccaID: input.ccaID, submissionID: null },
  });
  if (held >= EVIDENCE_MAX_UNATTACHED) {
    // The file is NOT deleted here. Another record of the same address may have
    // just saved a row that points at it, and deleting would leave that row
    // with no file. A file that ends up with no row is cleared by
    // cleanupOrphanEvidence on a later upload.
    throw new TRPCError({ code: "CONFLICT", message: EVIDENCE_TOO_MANY });
  }

  // Always written explicitly: a missing key never matches a null filter.
  return db.milestoneEvidence.create({
    data: {
      ccaID: input.ccaID,
      pathname,
      contentType,
      size: stored.size,
      uploadedBy: userID,
      submissionID: null,
    },
    select: VIEW_SELECT,
  });
}

/**
 * Remove an unattached photo: a head of its CCA, now. A missing id and another
 * CCA's id answer the same NOT_FOUND. The row is deleted first, conditional on
 * `submissionID: null`, so it cannot race an attach (an attach that won leaves
 * zero rows deleted and the call is refused); the file is removed after,
 * best effort, and the orphan sweep (B128) collects one the store missed. This
 * reverses the earlier file-first order (B144) for this path. A photo already
 * attached to a submission is refused: it is part of a record.
 */
export async function removeEvidence(
  db: EvidenceDb,
  storage: Pick<EvidenceStorage, "remove">,
  userID: string,
  id: string,
): Promise<{ removed: true }> {
  await assertMilestonesEnabled(db);
  const row = await db.milestoneEvidence.findUnique({
    where: { id },
    select: { ccaID: true, pathname: true, submissionID: true },
  });
  if (row === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: EVIDENCE_NOT_FOUND });
  }
  await assertEvidenceHead(db, userID, row.ccaID, { hideExistence: true });
  if (row.submissionID !== null) {
    throw new TRPCError({ code: "CONFLICT", message: EVIDENCE_ATTACHED });
  }
  await assertWithinLimit("remove", userID);

  const gone = await db.milestoneEvidence.deleteMany({
    where: { id, submissionID: null },
  });
  if (gone.count !== 1) {
    // Attached (or already removed) between the read and the delete.
    throw new TRPCError({ code: "CONFLICT", message: EVIDENCE_ATTACHED });
  }
  if (!(await storage.remove(row.pathname))) {
    console.error(JSON.stringify({ evt: "milestone_blob_remove_failed" }));
  }
  return { removed: true };
}
