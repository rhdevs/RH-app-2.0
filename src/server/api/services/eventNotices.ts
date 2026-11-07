import type { Event, PrismaClient } from "@prisma/client";

import {
  MAX_RECIPIENTS,
  areNotificationsEnabled,
  notify,
} from "~/server/api/services/notifications";
import { EVENT_TITLE_MAX } from "~/lib/schemas/event";

/**
 * Inbox notices for changes to a published Event: who gets told, and what it
 * says. The Event router calls these AFTER its own write has committed and
 * outside any transaction, so a notice that cannot be written is logged and
 * dropped, never retried, and never fails or undoes the Event change. This is
 * the one exception to "a failed notification rolls back the change".
 *
 * Recipients come only from records: `EventSignup`, `CcaHead` and the event's
 * `createdBy`. Text is stored as given (the notification list renders it as
 * plain text), clipped to fit.
 */

type NoticeEvent = Pick<Event, "eventID" | "title" | "ccaID" | "createdBy">;

export type EventDecision = "approve" | "request_changes" | "decline";

const DECISION_TITLE: Record<EventDecision, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  decline: "Declined",
};

const nameOf = (event: NoticeEvent) => {
  const title = event.title?.slice(0, EVENT_TITLE_MAX);
  return title ? title : `Event #${event.eventID}`;
};

async function signedUpUsers(db: PrismaClient, eventID: number) {
  const rows = await db.eventSignup.findMany({
    where: { eventID },
    select: { userID: true },
    take: MAX_RECIPIENTS,
  });
  return rows.map((r) => r.userID).filter(Boolean);
}

/** Heads of the event's CCA; a hall-wide event has none, so its author. */
async function headsOf(db: PrismaClient, event: NoticeEvent) {
  if (event.ccaID == null) return [event.createdBy].filter(Boolean);
  const rows = await db.ccaHead.findMany({
    where: { ccaID: event.ccaID },
    select: { userID: true },
    take: MAX_RECIPIENTS,
  });
  return rows.map((r) => r.userID).filter(Boolean);
}

type Notice = {
  kind: string;
  event: NoticeEvent;
  recipients: () => Promise<string[]>;
  title: string;
  body?: string;
  href: string;
};

/**
 * Never throws. The flag is read first so that, with notifications off, no
 * recipient lookup runs and nothing is written. A failure is logged with the
 * kind, event id, the stage that failed and the error name: no names, ids of
 * people, titles or reasons.
 */
async function send(db: PrismaClient, n: Notice): Promise<void> {
  let stage = "flag";
  let recipientCount: number | undefined;
  try {
    if (!(await areNotificationsEnabled(db))) return;
    stage = "recipients";
    const recipients = await n.recipients();
    recipientCount = recipients.length;
    if (recipientCount === 0) return;
    stage = "write";
    await notify(db, {
      recipients,
      kind: n.kind,
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      href: n.href,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "event_notice_failed",
        kind: n.kind,
        eventID: n.event.eventID,
        stage,
        recipientCount,
        err: err instanceof Error ? err.name : "unknown",
        code: (err as { code?: unknown } | null)?.code,
      }),
    );
  }
}

/** A published event was canceled: tell the residents who signed up. */
export function noticeEventCanceled(
  db: PrismaClient,
  event: NoticeEvent,
  reason: string | null,
): Promise<void> {
  return send(db, {
    kind: "event.canceled",
    event,
    recipients: () => signedUpUsers(db, event.eventID),
    title: `Canceled: ${nameOf(event)}`,
    ...(reason ? { body: reason } : {}),
    href: `/events/${event.eventID}`,
  });
}

/**
 * A live edit was written. `changed` is planLiveEdit's list; only a change to
 * the time or the place is news, so a capacity-only or no-op edit sends nothing.
 */
export function noticeEventEdited(
  db: PrismaClient,
  event: NoticeEvent,
  changed: readonly string[],
): Promise<void> {
  const news = changed.filter((c) => c === "time" || c === "location");
  if (news.length === 0) return Promise.resolve();
  return send(db, {
    kind: "event.changed",
    event,
    recipients: () => signedUpUsers(db, event.eventID),
    title: `Changed: ${nameOf(event)}`,
    body: `The ${news.join(" and ").replace("location", "place")} changed. Check the event for the new details.`,
    href: `/events/${event.eventID}`,
  });
}

/** The JCRC decided a submitted event: tell the heads of its CCA. */
export function noticeEventDecided(
  db: PrismaClient,
  event: NoticeEvent,
  decision: EventDecision,
  reason: string | null | undefined,
): Promise<void> {
  return send(db, {
    kind: "event.decided",
    event,
    recipients: () => headsOf(db, event),
    title: `${DECISION_TITLE[decision]}: ${nameOf(event)}`,
    ...(reason ? { body: reason } : {}),
    href:
      event.ccaID == null
        ? "/events"
        : `/cca/${event.ccaID}/events/${event.eventID}`,
  });
}
