import { TRPCError } from "@trpc/server";
import { NextResponse } from "next/server";

import { boundedStream } from "~/lib/boundedStream";
import { LOAN_ID } from "~/lib/equipment/photo";
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
import { assertEquipmentEnabled } from "~/server/api/services/equipment/flag";
import { assertWithinLimit } from "~/server/api/services/equipment/limits";
import { authorizePhotoRead } from "~/server/api/services/equipment/read";

/**
 * Serves one equipment return photo, and is the ONLY way a browser ever gets
 * one: the store is private, its addresses are never stored in a row or sent
 * anywhere, and a link to this route carries nothing but the LOAN id.
 *
 * On EVERY request, in order:
 *  1. a session;
 *  2. a well-formed loan id;
 *  3. `equipment.enabled`;
 *  4. authorizePhotoRead: the loan has a photo and the person is the Social
 *     director or leads the loan CCA right now (the strict guards, never the
 *     session roles). The board's other readers and admins are refused;
 *  5. the per-person view budget.
 * A malformed id, a missing loan, a loan with no photo, a flag that is off, a
 * person who may not see it, a signed-out visitor and a guard read that failed
 * ALL get the same bare 404, so the id cannot be used to find out what exists.
 * Only a spent budget (429) and a store that could not be read (503) differ,
 * and both come after access is proven or say nothing about the photo.
 *
 * The bytes are proxied, not redirected: no store address is exposed. The
 * Content-Type is the allowlisted one stored with the loan (never the file's
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
  if (!LOAN_ID.test(params.id)) return refused();

  let photo: Awaited<ReturnType<typeof authorizePhotoRead>>;
  try {
    await assertEquipmentEnabled(db);
    photo = await authorizePhotoRead(db, userID, params.id.toLowerCase());
    await assertWithinLimit("view", userID);
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
        evt: "equipment_photo_read_failed",
        error: evidenceErrorCode(err),
      }),
    );
    return bare(503);
  }

  if (
    !(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(
      photo.contentType,
    ) ||
    photo.size > EVIDENCE_MAX_BYTES
  ) {
    console.error(JSON.stringify({ evt: "equipment_photo_row_invalid" }));
    return bare(503);
  }

  let stored: Awaited<ReturnType<typeof evidenceStorage.read>>;
  try {
    stored = await evidenceStorage.read(photo.pathname);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "equipment_photo_store_read_failed",
        error: evidenceErrorCode(err),
      }),
    );
    return bare(503);
  }
  if (stored === null) return refused();
  if (stored.size > EVIDENCE_MAX_BYTES) {
    await stored.stream.cancel();
    console.error(JSON.stringify({ evt: "equipment_photo_too_large" }));
    return bare(503);
  }

  return new NextResponse(boundedStream(stored.stream, EVIDENCE_MAX_BYTES), {
    status: 200,
    headers: {
      "Content-Type": photo.contentType,
      // No Content-Length: the SDK reports a size of 0 when the store sends no
      // length header, which would cut the photo off. The body is bounded by
      // boundedStream instead, and goes out chunked.
      "Content-Disposition": `inline; filename="return.${extensionFor(photo.contentType)}"`,
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
