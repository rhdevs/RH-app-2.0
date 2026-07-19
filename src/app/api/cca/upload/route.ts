import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import {
  parseCcaUploadPath,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_MAX_BYTES,
} from "~/lib/schemas/cca";

/**
 * Vercel Blob client-upload token route for CCA logos and banners.
 *
 * READ THIS BEFORE TOUCHING IT.
 *
 * 1. THIS IS THE APP'S FIRST PUBLIC API ROUTE THAT GRANTS A WRITE.
 *    It is NOT covered by any tRPC guard — those live in the tRPC middleware
 *    chain and this is a raw route handler. `onBeforeGenerateToken` is the
 *    entire authorisation boundary. Vercel's own docs put it plainly: without
 *    a check there, the route is open to the public and anyone can upload to
 *    the store.
 *
 * 2. IT CANNOT BE A tRPC PROCEDURE. `handleUpload` needs the raw `Request` to
 *    verify Blob's signature on the callback leg, which tRPC does not expose.
 *    That is the only reason this lives outside the router.
 *
 * 3. WHY THE BROWSER UPLOADS DIRECTLY. The file goes browser → Blob, and this
 *    route only mints a scoped token. That sidesteps the 4.5 MB serverless
 *    body limit and, per Vercel's pricing docs, avoids the Fast Data Transfer
 *    charge a server-side upload would incur.
 *
 * 4. `onUploadCompleted` IS NOT THE SOURCE OF TRUTH, and must never become it.
 *    It is a webhook Vercel calls back into the deployment, and it CANNOT
 *    reach localhost — so anything that depends on it works in production and
 *    silently does nothing on every developer's machine. The blob URL is
 *    persisted by the client calling `cca.updateProfile`, which is guarded,
 *    audited, and works identically everywhere. This handler only logs.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const session = await auth();
        if (!session?.user?.userID) {
          throw new Error("UNAUTHENTICATED");
        }

        // `pathname` is CLIENT-SUPPLIED. Parsing it is not the security check
        // — it only guarantees a well-formed, CCA-scoped path so a token can
        // never be minted for an arbitrary location in the store. The ccaID it
        // yields is then authorised below, which IS the check.
        const target = parseCcaUploadPath(pathname);
        if (target === null) {
          throw new Error("BAD_PATHNAME");
        }

        // I-5: LIVE role read, never session.user.roles. A head revoked this
        // morning must not be able to mint an upload token this afternoon.
        const roles = await getUserRoles(db, session.user.userID);
        await assertHeadsCca(
          db,
          { userID: session.user.userID, roles },
          target.ccaID,
        );

        return {
          // Content type is enforced by Vercel against the actual upload, not
          // the filename — a .pdf renamed to .png does not get through.
          allowedContentTypes: [...UPLOAD_CONTENT_TYPES],
          // THE cap that holds. The browser downscales before uploading, but
          // that runs on the client and is therefore advice, not enforcement.
          maximumSizeInBytes: UPLOAD_MAX_BYTES,
          // Immutable, unguessable URLs — which is what makes them safe to
          // cache forever and stops one CCA overwriting another's blob.
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            ccaID: target.ccaID,
            kind: target.kind,
            userID: session.user.userID,
          }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Observability only — see note 4 above. Never write to CcaProfile
        // from here: it does not fire in local development.
        console.log(
          JSON.stringify({
            evt: "cca_image_uploaded",
            url: blob.url,
            payload: tokenPayload,
          }),
        );
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UPLOAD_FAILED";
    // 400, not 500: every failure here is a rejected request (unauthenticated,
    // not a head, bad path, oversized), not a server fault.
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
