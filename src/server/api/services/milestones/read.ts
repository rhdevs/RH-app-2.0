import { TRPCError } from "@trpc/server";

import { EVIDENCE_ID } from "~/lib/schemas/milestoneEvidence";
import {
  assertEvidenceHead,
  assertEvidenceReader,
  EVIDENCE_NOT_FOUND,
} from "./access";
import { assertMilestonesEnabled, isMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";
import type { EvidenceDb, EvidenceView } from "./write";

/**
 * The evidence reads: the heads' list, and the check behind the serving route.
 * No catch anywhere (a source scan keeps it so): a failed read fails the call,
 * and access.ts refuses on a failed guard read.
 */

/** Most photos the list returns; the unattached cap is lower, so this is never the limit. */
const LIST_LIMIT = 50;

/**
 * This CCA's photos not yet attached to a submission, newest first. A head of
 * the CCA only (directors see attached evidence through a submission, PR 16).
 * Never returns a pathname or an address: the browser gets ids.
 */
export async function listEvidence(
  db: EvidenceDb,
  userID: string,
  ccaID: number,
): Promise<EvidenceView[]> {
  await assertMilestonesEnabled(db);
  await assertEvidenceHead(db, userID, ccaID);
  return db.milestoneEvidence.findMany({
    where: { ccaID, submissionID: null },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: { id: true, contentType: true, size: true, createdAt: true },
  });
}

export type ServableEvidence = {
  pathname: string;
  contentType: string;
  size: number;
};

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: EVIDENCE_NOT_FOUND });

/**
 * The stored file a person may be shown, or a refusal. The request names only
 * the evidence id; the CCA comes from the stored row, and the person must head
 * or direct THAT CCA now (strict guard, on every request). A malformed id, a
 * missing row, a flag that is off and a person who may not see it are ONE
 * answer, NOT_FOUND `EVIDENCE_NOT_FOUND`, so the id cannot be used to probe.
 * A guard read that fails refuses (FORBIDDEN, logged by error name). The
 * per-person budget is spent only after access is proven.
 */
export async function authorizeEvidenceRead(
  db: EvidenceDb,
  userID: string,
  id: string,
): Promise<ServableEvidence> {
  if (!EVIDENCE_ID.test(id)) throw notFound();
  if (!(await isMilestonesEnabled(db))) throw notFound();
  const row = await db.milestoneEvidence.findUnique({
    where: { id },
    select: { ccaID: true, pathname: true, contentType: true, size: true },
  });
  if (row === null) throw notFound();
  await assertEvidenceReader(db, userID, row.ccaID, { hideExistence: true });
  await assertWithinLimit("view", userID);
  return {
    pathname: row.pathname,
    contentType: row.contentType,
    size: row.size,
  };
}
