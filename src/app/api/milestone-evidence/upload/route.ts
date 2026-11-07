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
import { MILESTONES_DISABLED } from "~/server/api/services/milestones/flag";
import {
  MILESTONE_ACCESS_CHECK_FAILED,
  NOT_EVIDENCE_HEAD,
} from "~/server/api/services/milestones/access";
import {
  authorizeEvidenceUpload,
  EVIDENCE_BAD_PATHNAME,
  EVIDENCE_TOO_MANY,
} from "~/server/api/services/milestones/write";

/**
 * Vercel Blob client-upload token route for milestone evidence photos, into the
 * PRIVATE store. Same pattern as the proposal poster route
 * (api/proposal/upload/route.ts), whose notes all apply: `onBeforeGenerateToken`
 * is the ENTIRE authorisation boundary, the browser uploads straight to Blob,
 * and nothing is saved here (the row is saved by the guarded
 * `milestoneEvidence.record`, which re-checks the file with the store).
 *
 * The order, each step refusing before the next runs:
 *  1. a signed-in person;
 *  2. the private store is configured (a missing token REFUSES; there is no
 *     fallback to the public store);
 *  3. the checks in authorizeEvidenceUpload: `milestones.enabled`, a pathname
 *     of exactly `milestone-evidence/<ccaID>/evidence.<ext>`, the caller heads
 *     that CCA now, stale photos cleared and the cap on unattached photos, and
 *     the per-person hourly ceiling.
 * Type (no SVG) and size are fixed here, at minting, by Blob itself, and Blob
 * adds the random suffix. Only the messages in KNOWN are sent back; anything
 * else becomes UPLOAD_FAILED.
 */
export const dynamic = "force-dynamic";

const KNOWN = new Set([
  "UNAUTHENTICATED",
  MILESTONES_DISABLED,
  MILESTONE_STORAGE_NOT_CONFIGURED,
  EVIDENCE_BAD_PATHNAME,
  NOT_EVIDENCE_HEAD,
  MILESTONE_ACCESS_CHECK_FAILED,
  EVIDENCE_TOO_MANY,
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
        const { ccaID } = await authorizeEvidenceUpload(
          db,
          evidenceStorage,
          userID,
          pathname,
        );

        return {
          allowedContentTypes: [...EVIDENCE_CONTENT_TYPES],
          maximumSizeInBytes: EVIDENCE_MAX_BYTES,
          addRandomSuffix: true,
          // About five minutes, not the SDK's hour: one token can send many
          // files, and a file with no row is invisible to the cap.
          validUntil: Date.now() + EVIDENCE_TOKEN_VALID_MS,
          tokenPayload: JSON.stringify({ ccaID }),
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
          evt: "milestone_upload_failed",
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
