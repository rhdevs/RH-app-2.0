import type { Prisma, PrismaClient } from "@prisma/client";

import { DISPOSABLES_HREF, disposableHref } from "~/lib/disposables/links";
import { currentSocialDirectorIDs } from "~/server/api/services/directorGuard";
import { notify } from "~/server/api/services/notifications";
import { headsOrRefuse } from "./access";
import type { ChangedRequest, RemovedRequest } from "./transition";

/**
 * The inbox notices for the disposable moves (merge proposal 4.3, 4.9). Every
 * function runs on the TRANSACTION client of the change, so the notice commits
 * or rolls back with it, and recipients come from CcaHead rows and the strict
 * guard, never from the request. The body is the request's title, plus the
 * decision note for a decision; nothing else leaves the row. The person who
 * acted is never told what they just did.
 *
 * When a request is FILED the Social director gets one notice too, but that
 * one is best effort (`noticeFiled`): it is sent after the request is saved,
 * on the plain client, and a failure is logged and never fails the filing.
 */

type Tx = Prisma.TransactionClient;
type Notified = Pick<ChangedRequest, "ccaID" | "title">;

const bodyOf = (title: string, note: string | null) =>
  (note ? `${title}: ${note}` : title).slice(0, 1000);

async function toHeads(
  tx: Tx,
  row: Notified,
  actorID: string,
  spec: { kind: string; title: string; body: string },
) {
  const heads = (await headsOrRefuse(tx, row.ccaID)).filter(
    (id) => id !== actorID,
  );
  await notify(tx, {
    recipients: heads,
    kind: spec.kind,
    title: spec.title,
    body: spec.body,
    href: DISPOSABLES_HREF,
  });
}

/**
 * A request was filed: tell the Social director, with a link to it. Best
 * effort: it runs after the request is saved and NEVER throws, so a failed
 * lookup or write is logged by error name and the filing still succeeds. Like
 * every notice it writes nothing while `notifications.enabled` is off, and
 * with no Social director (none, two flagged positions, `directors.enabled`
 * off) there is nobody to tell. Blank ids are dropped and the person who filed
 * is not told what they just did.
 */
export async function noticeFiled(
  db: PrismaClient,
  request: { id: string; title: string },
  actorID: string,
): Promise<void> {
  try {
    const recipients = (await currentSocialDirectorIDs(db)).filter(
      (id) => id.trim() !== "" && id !== actorID,
    );
    await notify(db, {
      recipients,
      kind: "disposable.filed",
      title: "A disposable request was filed",
      body: bodyOf(request.title, null),
      href: disposableHref(request.id),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "disposable_filed_notice_failed",
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

/** The Social director decided: tell the CCA's heads. */
export function noticeDecision(
  tx: Tx,
  decision: "approved" | "rejected",
  row: ChangedRequest,
  actorID: string,
  note: string | null,
) {
  return toHeads(tx, row, actorID, {
    kind:
      decision === "approved" ? "disposable.approved" : "disposable.rejected",
    title:
      decision === "approved"
        ? "Your disposable request was approved"
        : "Your disposable request was rejected",
    body: bodyOf(row.title, note),
  });
}

/**
 * The Social director edited a request: tell the CCA's heads. `backToPending`
 * says the edit sent an approved request back for a new decision.
 */
export function noticeEditedBySocialDirector(
  tx: Tx,
  row: ChangedRequest,
  actorID: string,
  backToPending: boolean,
) {
  return toHeads(tx, row, actorID, {
    kind: "disposable.edited",
    title: "Your disposable request was edited",
    body: backToPending
      ? bodyOf(row.title, "it was approved and is pending again")
      : row.title,
  });
}

/** The Social director deleted a request: tell the CCA's heads. */
export function noticeDeleted(tx: Tx, row: RemovedRequest, actorID: string) {
  return toHeads(tx, row, actorID, {
    kind: "disposable.deleted",
    title: "Your disposable request was deleted",
    body: row.title,
  });
}
