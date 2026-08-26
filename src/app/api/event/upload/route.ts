import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { computeCapabilities } from "~/server/api/services/roles";
import { areEventsEnabled } from "~/server/api/services/events";
import {
  parseEventUploadPath,
  eventUploadConstraints,
} from "~/lib/schemas/event";

/**
 * Vercel Blob client-upload token route for event assets (banner, gallery
 * photos). READ src/app/api/cca/upload/route.ts FIRST — this is the same
 * pattern and every note there applies:
 *
 *   1. onBeforeGenerateToken is the ENTIRE authorisation boundary.
 *   2. It cannot be a tRPC procedure (handleUpload needs the raw Request).
 *   3. The browser uploads directly to Blob; this only mints a scoped token.
 *   4. onUploadCompleted is observability only and does NOT fire on localhost —
 *      the URL is persisted by the guarded event.update mutation, never here.
 *
 * The one difference from the CCA route: the scope key is an eventID, so the
 * event must be LOADED to learn its ccaID before it can be authorised. A token
 * for a non-existent event is refused.
 *
 * THE OWNERSHIP BRANCH BELOW IS THE SECOND AND LAST COPY of the one in
 * loadOwnedEvent (routers/event.ts). It is duplicated ON PURPOSE rather than
 * factored out: this is a raw Route Handler and cannot call a tRPC helper, and
 * the branch sits directly beside the `select` that produced the nullable
 * ccaID, where it can be read in one glance. The alternative — teaching
 * assertHeadsCca about null — is refused for the reason its own comment gives:
 * it is shared with cca.updateProfile, cca.removeMembers, cca.handoverHeads,
 * cca.memberDirectory and the CCA application flow, so widening it hands all of
 * that to whoever gains the new branch.
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

        // The whole feature is inert unless the kill switch is on.
        if (!(await areEventsEnabled(db))) {
          throw new Error("EVENTS_DISABLED");
        }

        // `pathname` is CLIENT-SUPPLIED. Parsing only guarantees a well-formed,
        // event-scoped path; the authorisation is assertHeadsCca below.
        const target = parseEventUploadPath(pathname);
        if (target === null) {
          throw new Error("BAD_PATHNAME");
        }

        // The event must exist so we can authorise against ITS ccaID — never a
        // client-supplied one. `ccaID` is nullable: null means a HALL-WIDE,
        // JCRC-owned event.
        const event = await db.event.findUnique({
          where: { eventID: target.eventID },
          select: { ccaID: true },
        });
        if (!event) {
          throw new Error("NO_SUCH_EVENT");
        }

        // I-5: LIVE role read, never session.user.roles.
        const roles = await getUserRoles(db, session.user.userID);
        if (event.ccaID == null) {
          if (!computeCapabilities(roles).manageHallEvents) {
            throw new Error("CAPABILITY_REQUIRED:manageHallEvents");
          }
        } else {
          await assertHeadsCca(
            db,
            { userID: session.user.userID, roles },
            event.ccaID,
          );
        }

        const { allowedContentTypes, maximumSizeInBytes } =
          eventUploadConstraints(target.kind);

        return {
          allowedContentTypes,
          maximumSizeInBytes,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            eventID: target.eventID,
            kind: target.kind,
            userID: session.user.userID,
          }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Observability only — does not fire on localhost. Never persist here.
        console.log(
          JSON.stringify({
            evt: "event_asset_uploaded",
            url: blob.url,
            payload: tokenPayload,
          }),
        );
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UPLOAD_FAILED";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
