import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { EDITABLE_STATUSES, isProposalStatus } from "~/lib/proposals/status";
import {
  PROPOSAL_POSTER_CONTENT_TYPES,
  PROPOSAL_POSTER_MAX_BYTES,
  parseProposalUploadPath,
} from "~/lib/schemas/proposalFiles";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import {
  assertCcaHead,
  PROPOSAL_NOT_FOUND,
} from "~/server/api/services/proposals/access";
import { isProposalsEnabled } from "~/server/api/services/proposals/flag";
import { assertWithinLimit } from "~/server/api/services/proposals/limits";

/**
 * Vercel Blob client-upload token route for proposal posters. Same pattern as
 * the Event image route (api/event/upload/route.ts), whose notes all apply:
 * `onBeforeGenerateToken` is the ENTIRE authorisation boundary, the browser
 * uploads straight to Blob, and `onUploadCompleted` is observability only (it
 * does not fire on localhost, and the address is saved by the guarded
 * `proposal.update`, never here).
 *
 * The order, each step refusing before the next runs:
 *  1. a signed-in person;
 *  2. `proposals.enabled` (fails CLOSED: a failed read is off);
 *  3. the pathname is `proposal/<id>/poster`, nothing else;
 *  4. the proposal exists and the caller heads ITS CCA (the strict
 *     assertCcaHead, never the session's roles; a missing proposal and another
 *     CCA's proposal answer the same);
 *  5. the proposal is still editable (draft or returned);
 *  6. the per-person hourly upload ceiling.
 * Size and type are fixed here, at minting, by Blob itself; the file is never
 * read by this server.
 *
 * Only the messages in KNOWN are sent back; anything else becomes UPLOAD_FAILED.
 */
const PROPOSAL_NOT_EDITABLE = "PROPOSAL_NOT_EDITABLE";
const PROPOSAL_BAD_PATHNAME = "BAD_PATHNAME";
const KNOWN = new Set([
  "UNAUTHENTICATED",
  "PROPOSALS_DISABLED",
  PROPOSAL_BAD_PATHNAME,
  PROPOSAL_NOT_FOUND,
  PROPOSAL_NOT_EDITABLE,
]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const session = await auth();
        const userID = session?.user?.userID;
        if (!userID) throw new Error("UNAUTHENTICATED");

        if (!(await isProposalsEnabled(db))) {
          throw new Error("PROPOSALS_DISABLED");
        }

        // CLIENT-SUPPLIED: this only guarantees a well-formed path.
        const target = parseProposalUploadPath(pathname);
        if (target === null) throw new Error(PROPOSAL_BAD_PATHNAME);

        const proposal = await db.proposal.findUnique({
          where: { id: target.proposalID },
          select: { ccaID: true, status: true },
        });
        if (!proposal) throw new Error(PROPOSAL_NOT_FOUND);
        await assertCcaHead(db, userID, proposal.ccaID, {
          hideExistence: true,
        });

        if (
          !isProposalStatus(proposal.status) ||
          !EDITABLE_STATUSES.includes(proposal.status)
        ) {
          throw new Error(PROPOSAL_NOT_EDITABLE);
        }
        await assertWithinLimit("upload", userID);

        return {
          allowedContentTypes: [...PROPOSAL_POSTER_CONTENT_TYPES],
          maximumSizeInBytes: PROPOSAL_POSTER_MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ proposalID: target.proposalID }),
        };
      },

      onUploadCompleted: ({ blob, tokenPayload }) => {
        // Observability only. Never persist here.
        console.log(
          JSON.stringify({
            evt: "proposal_poster_uploaded",
            url: blob.url,
            payload: tokenPayload,
          }),
        );
        return Promise.resolve();
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("RATE_LIMITED")) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    if (!KNOWN.has(message)) {
      console.error(
        JSON.stringify({
          evt: "proposal_upload_failed",
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    return NextResponse.json(
      { error: KNOWN.has(message) ? message : "UPLOAD_FAILED" },
      { status: 400 },
    );
  }
}
