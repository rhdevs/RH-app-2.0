import type { HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import {
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TOKEN_VALID_MS,
} from "~/lib/schemas/milestoneEvidence";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import {
  evidenceErrorCode,
  evidenceStorage,
  handleEvidenceUpload,
  MILESTONE_STORAGE_NOT_CONFIGURED,
} from "~/server/api/services/milestoneBlob";
import {
  EQUIPMENT_ACCESS_CHECK_FAILED,
  NOT_EVENT_LEADER,
} from "~/server/api/services/equipment/access";
import { EQUIPMENT_DISABLED } from "~/server/api/services/equipment/flag";
import {
  authorizeReturnPhotoUpload,
  EQUIPMENT_BAD_PATHNAME,
  EQUIPMENT_PHOTO_TOO_MANY,
} from "~/server/api/services/equipment/photo";
import { EQUIPMENT_BAD_MOVE } from "~/server/api/services/equipment/transition";

/**
 * Vercel Blob client-upload token route for equipment RETURN photos, into the
 * PRIVATE store (the same store and the same pattern as the milestone evidence
 * route, api/milestone-evidence/upload/route.ts, whose notes all apply):
 * `onBeforeGenerateToken` is the ENTIRE authorisation boundary, the browser
 * uploads straight to Blob, and nothing is saved here. The photo is attached
 * to its loan only by `equipment.markReturned`, which re-checks the file.
 *
 * The order, each step refusing before the next runs:
 *  1. a signed-in person;
 *  2. the checks in authorizeReturnPhotoUpload: `equipment.enabled`, a pathname
 *     of exactly `equipment-return/<loan id>/photo.<ext>`, the caller is the
 *     Social director or leads the event CCA now, the loan is collected, stray
 *     files are cleared, and the per-person hourly ceiling;
 *  3. the private store token, checked by handleEvidenceUpload (a missing
 *     token REFUSES; there is no fallback to the public store).
 * Type (no SVG) and size are fixed here, at minting, by Blob itself. Only the
 * messages in KNOWN are sent back; anything else becomes UPLOAD_FAILED.
 */
export const dynamic = "force-dynamic";

const KNOWN = new Set([
  "UNAUTHENTICATED",
  EQUIPMENT_DISABLED,
  MILESTONE_STORAGE_NOT_CONFIGURED,
  EQUIPMENT_BAD_PATHNAME,
  NOT_EVENT_LEADER,
  EQUIPMENT_ACCESS_CHECK_FAILED,
  EQUIPMENT_BAD_MOVE,
  EQUIPMENT_PHOTO_TOO_MANY,
]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // First, before the store is even looked at: a stranger learns nothing.
    const session = await auth();
    const userID = session?.user?.userID;
    if (!userID) throw new Error("UNAUTHENTICATED");

    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleEvidenceUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const { loanID } = await authorizeReturnPhotoUpload(
          db,
          evidenceStorage,
          userID,
          pathname,
        );

        return {
          allowedContentTypes: [...EVIDENCE_CONTENT_TYPES],
          maximumSizeInBytes: EVIDENCE_MAX_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + EVIDENCE_TOKEN_VALID_MS,
          tokenPayload: JSON.stringify({ loanID }),
        };
      },
    });

    return NextResponse.json(jsonResponse, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("RATE_LIMITED")) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    if (!KNOWN.has(message)) {
      console.error(
        JSON.stringify({
          evt: "equipment_upload_failed",
          error: evidenceErrorCode(error),
        }),
      );
    }
    return NextResponse.json(
      { error: KNOWN.has(message) ? message : "UPLOAD_FAILED" },
      { status: 400 },
    );
  }
}
