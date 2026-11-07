import { TRPCError } from "@trpc/server";
import { NextResponse } from "next/server";

import { boundedStream } from "~/lib/boundedStream";
import {
  contentTypeForExtension,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
} from "~/lib/schemas/milestoneEvidence";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import {
  evidenceErrorCode,
  evidenceStorage,
} from "~/server/api/services/milestoneBlob";
import { authorizeEvidenceRead } from "~/server/api/services/milestones/read";

/**
 * Serves one evidence photo, and is the ONLY way a browser ever gets one: the
 * store is private, its addresses are never stored in a row or sent anywhere,
 * and a link to this route carries nothing but the evidence id.
 *
 * On EVERY request, in order:
 *  1. a session;
 *  2. authorizeEvidenceRead: `milestones.enabled`, the stored row, and that the
 *     person heads or directs THAT row's CCA right now (the strict guard, never
 *     the session's roles), then the per-person view budget. Admins, RF, JCRC
 *     and other position holders are refused.
 * A malformed id, a missing row, a flag that is off, a person who may not see
 * it, a signed-out visitor and a guard read that failed ALL get the same bare
 * 404, so the id cannot be used to find out what exists. Only a spent budget
 * (429) and a store that could not be read (503) differ, and both come after
 * access is proven or say nothing about the photo.
 *
 * The bytes are proxied, not redirected: no store address is exposed. The
 * Content-Type is the allowlisted one stored with the row (never the file's
 * own claim), `nosniff` and a locked-down CSP stop a mislabelled file from
 * being run, `private, no-store` keeps it out of shared caches, and the body is
 * cut off if it ever runs past the size bound.
 */
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";

function bare(status: number, extra?: Record<string, string>): NextResponse {
  return new NextResponse(status === 404 ? "Not found" : "Unavailable", {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "text/plain; charset=utf-8",
      ...extra,
    },
  });
}

const refused = () => bare(404);

const extensionFor = (contentType: string): string =>
  ["webp", "png", "jpg"].find(
    (ext) => contentTypeForExtension(ext) === contentType,
  ) ?? "bin";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const session = await auth();
  const userID = session?.user?.userID;
  if (!userID) return refused();

  let evidence: Awaited<ReturnType<typeof authorizeEvidenceRead>>;
  try {
    evidence = await authorizeEvidenceRead(db, userID, params.id);
  } catch (err) {
    if (err instanceof TRPCError) {
      if (err.code === "TOO_MANY_REQUESTS") {
        const seconds = /^RATE_LIMITED:(\d+)$/.exec(err.message)?.[1];
        return bare(429, seconds ? { "Retry-After": seconds } : undefined);
      }
      return refused();
    }
    console.error(
      JSON.stringify({
        evt: "milestone_evidence_read_failed",
        error: evidenceErrorCode(err),
      }),
    );
    return bare(503);
  }

  if (
    !(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(
      evidence.contentType,
    ) ||
    evidence.size > EVIDENCE_MAX_BYTES
  ) {
    console.error(JSON.stringify({ evt: "milestone_evidence_row_invalid" }));
    return bare(503);
  }

  let stored: Awaited<ReturnType<typeof evidenceStorage.read>>;
  try {
    stored = await evidenceStorage.read(evidence.pathname);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "milestone_evidence_store_read_failed",
        error: evidenceErrorCode(err),
      }),
    );
    return bare(503);
  }
  if (stored === null) return refused();
  if (stored.size > EVIDENCE_MAX_BYTES) {
    await stored.stream.cancel();
    console.error(JSON.stringify({ evt: "milestone_evidence_too_large" }));
    return bare(503);
  }

  return new NextResponse(boundedStream(stored.stream, EVIDENCE_MAX_BYTES), {
    status: 200,
    headers: {
      "Content-Type": evidence.contentType,
      // No Content-Length: the SDK reports a size of 0 when the store sends no
      // length header, which would cut the photo off. The body is bounded by
      // boundedStream instead, and goes out chunked.
      "Content-Disposition": `inline; filename="evidence.${extensionFor(evidence.contentType)}"`,
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
