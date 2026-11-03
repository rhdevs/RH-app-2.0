import type { PrismaClient } from "@prisma/client";

import { equipmentLoanHref } from "~/lib/equipment/links";
import { currentSocialDirectorIDs } from "~/server/api/services/directorGuard";
import {
  areNotificationsEnabled,
  notify,
} from "~/server/api/services/notifications";

/**
 * Inbox notices for the equipment moves. Each is BEST EFFORT, sent after the
 * change has committed and outside its transaction: a notice that cannot be
 * written is logged by kind and error name and dropped, never retried, and
 * never fails or undoes the change. This is the one catch in the notice code.
 *
 * Recipients come from records only: the strict guard list of Social
 * directors, and the loan requestedBy. The person who acted is never told what
 * they just did. A notice links to the page of the loan; it never carries a
 * photo storage address, a pathname or a file name.
 */

// The tables the strict guard list reads come from the guard's own signature,
// so no position collection is named here.
type Db = Pick<PrismaClient, "systemFlag" | "notification"> &
  Parameters<typeof currentSocialDirectorIDs>[0];

type NoticeLoan = {
  id: string;
  requestedBy: string | null;
};

type Notice = {
  kind: string;
  recipients: () => Promise<string[]>;
  title: string;
  body: string;
  loanID: string;
};

const clip = (s: string, max: number) => s.slice(0, max);
const nameOf = (eventTitle: string | null) =>
  eventTitle && eventTitle.trim() !== "" ? eventTitle.trim() : "an event";

async function send(db: Db, n: Notice): Promise<void> {
  let stage = "flag";
  try {
    if (!(await areNotificationsEnabled(db))) return;
    stage = "recipients";
    const recipients = await n.recipients();
    if (recipients.length === 0) return;
    stage = "write";
    await notify(db, {
      recipients,
      kind: n.kind,
      title: clip(n.title, 200),
      body: clip(n.body, 1000),
      href: equipmentLoanHref(n.loanID),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "equipment_notice_failed",
        kind: n.kind,
        stage,
        err: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
}

const directorsExcept = (db: Db, actorID: string) => async () =>
  (await currentSocialDirectorIDs(db)).filter((id) => id !== actorID);

const requesterUnless = (loan: NoticeLoan, actorID: string) => () =>
  Promise.resolve(
    loan.requestedBy !== null && loan.requestedBy !== actorID
      ? [loan.requestedBy]
      : [],
  );

/** A new request: tell the Social director(s). */
export function noticeRequested(
  db: Db,
  loan: NoticeLoan,
  eventTitle: string | null,
  itemCount: number,
  actorID: string,
) {
  return send(db, {
    kind: "equipment.requested",
    recipients: directorsExcept(db, actorID),
    title: "New equipment request",
    body: `${nameOf(eventTitle)}: ${itemCount} ${itemCount === 1 ? "item" : "items"}`,
    loanID: loan.id,
  });
}

/** The Social director approved, rejected or canceled: tell the requester. */
export function noticeDecision(
  db: Db,
  decision: "approved" | "rejected" | "canceled",
  loan: NoticeLoan,
  eventTitle: string | null,
  actorID: string,
  note: string | null,
) {
  const title =
    decision === "approved"
      ? "Your equipment request was approved"
      : decision === "rejected"
        ? "Your equipment request was rejected"
        : "Your equipment request was canceled";
  return send(db, {
    kind: `equipment.${decision}`,
    recipients: requesterUnless(loan, actorID),
    title,
    body: note ? `${nameOf(eventTitle)}: ${note}` : nameOf(eventTitle),
    loanID: loan.id,
  });
}

/** The kit came back: tell the Social director(s), with a link to the loan. */
export function noticeReturned(
  db: Db,
  loan: NoticeLoan,
  eventTitle: string | null,
  actorID: string,
  hasPhoto: boolean,
) {
  return send(db, {
    kind: "equipment.returned",
    recipients: directorsExcept(db, actorID),
    title: "Equipment returned",
    body: hasPhoto
      ? `${nameOf(eventTitle)}: returned, with a photo.`
      : `${nameOf(eventTitle)}: returned.`,
    loanID: loan.id,
  });
}
