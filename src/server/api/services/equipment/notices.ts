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
 * never fails or undoes the change. This is the one catch in the notice code,
 * and EVERY read a notice needs after the commit (the flag, the recipients, the
 * event title) happens inside it, so a failed read after commit can never turn
 * a change that was saved into an error.
 *
 * Recipients come from records only: the strict guard list of Social
 * directors, and the loan requestedBy. The person who acted is never told what
 * they just did. A notice links to the page of the loan; it never carries a
 * photo storage address, a pathname or a file name.
 */

// The tables the strict guard list reads come from the guard's own signature,
// so no position collection is named here.
type Db = Pick<PrismaClient, "systemFlag" | "notification" | "event"> &
  Parameters<typeof currentSocialDirectorIDs>[0];

type NoticeLoan = {
  id: string;
  requestedBy: string | null;
  eventID: number;
};

type Notice = {
  kind: string;
  recipients: () => Promise<string[]>;
  /** The event title is read inside the best-effort path, never before it. */
  eventTitle: () => Promise<string | null>;
  compose: (eventTitle: string | null) => { title: string; body: string };
  loanID: string;
};

const clip = (s: string, max: number) => s.slice(0, max);
const nameOf = (eventTitle: string | null) =>
  eventTitle && eventTitle.trim() !== "" ? eventTitle.trim() : "an event";

const titleOf = (db: Db, eventID: number) => async () => {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { title: true },
  });
  return (event?.title?.trim() ?? "") || null;
};

async function send(db: Db, n: Notice): Promise<void> {
  let stage = "flag";
  try {
    if (!(await areNotificationsEnabled(db))) return;
    stage = "recipients";
    const recipients = await n.recipients();
    if (recipients.length === 0) return;
    stage = "title";
    const { title, body } = n.compose(await n.eventTitle());
    stage = "write";
    await notify(db, {
      recipients,
      kind: n.kind,
      title: clip(title, 200),
      body: clip(body, 1000),
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
  itemCount: number,
  actorID: string,
) {
  return send(db, {
    kind: "equipment.requested",
    recipients: directorsExcept(db, actorID),
    eventTitle: titleOf(db, loan.eventID),
    compose: (eventTitle) => ({
      title: "New equipment request",
      body: `${nameOf(eventTitle)}: ${itemCount} ${itemCount === 1 ? "item" : "items"}`,
    }),
    loanID: loan.id,
  });
}

/** The Social director approved, rejected or canceled: tell the requester. */
export function noticeDecision(
  db: Db,
  decision: "approved" | "rejected" | "canceled",
  loan: NoticeLoan,
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
    eventTitle: titleOf(db, loan.eventID),
    compose: (eventTitle) => ({
      title,
      body: note ? `${nameOf(eventTitle)}: ${note}` : nameOf(eventTitle),
    }),
    loanID: loan.id,
  });
}

/** The kit came back: tell the Social director(s), with a link to the loan. */
export function noticeReturned(
  db: Db,
  loan: NoticeLoan,
  actorID: string,
  hasPhoto: boolean,
) {
  return send(db, {
    kind: "equipment.returned",
    recipients: directorsExcept(db, actorID),
    eventTitle: titleOf(db, loan.eventID),
    compose: (eventTitle) => ({
      title: "Equipment returned",
      body: hasPhoto
        ? `${nameOf(eventTitle)}: returned, with a photo.`
        : `${nameOf(eventTitle)}: returned.`,
    }),
    loanID: loan.id,
  });
}

/** The Social director left a note on a returned loan: tell the requester. */
export function noticeNoted(
  db: Db,
  loan: NoticeLoan,
  actorID: string,
  note: string,
) {
  return send(db, {
    kind: "equipment.noted",
    recipients: requesterUnless(loan, actorID),
    eventTitle: titleOf(db, loan.eventID),
    compose: (eventTitle) => ({
      title: "A note on your equipment loan",
      body: `${nameOf(eventTitle)}: ${note}`,
    }),
    loanID: loan.id,
  });
}
