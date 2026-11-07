import type { PrismaClient } from "@prisma/client";

import { icsUid, writeIcs, type IcsEntry } from "~/lib/calendar/ics";
import {
  isProposalStatus,
  PROPOSAL_STATUS_LABELS,
} from "~/lib/proposals/status";
import { areEventsEnabled } from "~/server/api/services/events";
import { isCalendarFeedEnabled } from "./flag";
import { ownerOfFeedToken } from "./token";
import {
  readProposalLayer,
  readPublishedEvents,
  type CalendarEventItem,
  type ProposalLayerItem,
} from "./read";

/**
 * The personal feed: everything about one `.ics` response except the HTTP.
 *
 * The answer is worked out from the stored rows at request time, for the
 * person the token belongs to, and nothing is remembered between fetches:
 *  - the flag first. Off, absent or unreadable is 503 and nothing else is
 *    read, so a switched-off feed says nothing about tokens;
 *  - the token next. A token that opens nothing (unknown, revoked, malformed,
 *    too long, or its owner's account gone or credentials changed since) is
 *    one answer, 401. The first read is the same hash and the same single
 *    indexed read for every input;
 *  - then the two layers. Published Events (while `events.enabled` is on),
 *    and the proposal layer only if THIS person may read proposals now, by
 *    the strict reads the proposal screens use. A person who lost the head or
 *    director role loses those entries on the next fetch.
 * A layer that fails to read fails the whole feed with 503. A partial
 * calendar would make the subscriber's app delete entries it still should
 * show; a 503 leaves its last copy alone.
 *
 * The feed holds no private note, no person's name or id, no comment, no
 * document link and no description of a proposal: for a proposal, the title,
 * the CCA, the status and the planned times, which the reader can already see.
 */

export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 365;
const DAY_SEC = 86_400;

export type FeedResult =
  | { status: 200; body: string }
  | { status: 401 | 429 | 503; body: string };

const BODIES = {
  401: "Unauthorized\n",
  429: "Too many requests\n",
  503: "Service unavailable\n",
} as const;
const refusal = (status: 401 | 429 | 503): FeedResult => ({
  status,
  body: BODIES[status],
});

/** Logs the kind of failure only: a driver message can carry stored values. */
function logFailure(stage: string, err: unknown): void {
  console.error(
    JSON.stringify({
      evt: "calendar_feed_read_failed",
      stage,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
}

/** Calendar apps are shown `<token>.ics`; the suffix is not part of the token. */
export const tokenFromSegment = (segment: string): string =>
  segment.endsWith(".ics") ? segment.slice(0, -4) : segment;

export function eventEntry(e: CalendarEventItem): IcsEntry {
  return {
    uid: icsUid("event", e.eventID),
    start: e.startTime,
    end: e.endTime,
    stamp: e.updatedAt ? Math.floor(e.updatedAt.getTime() / 1000) : e.startTime,
    summary: `[${e.owner}] ${e.title}`,
    description: e.description,
    location: e.location,
    status: "CONFIRMED",
  };
}

export function proposalEntry(p: ProposalLayerItem): IcsEntry {
  const label = isProposalStatus(p.status)
    ? PROPOSAL_STATUS_LABELS[p.status]
    : p.status;
  return {
    uid: icsUid("proposal", p.id),
    start: p.plannedStart,
    end: p.plannedEnd,
    stamp: Math.floor(p.updatedAt.getTime() / 1000),
    summary: `Proposal: [${p.owner}] ${p.title}`,
    description: `Proposal, ${label}. Planned dates; not yet a published event.`,
    status: "TENTATIVE",
    categories: "Proposal",
  };
}

/**
 * `spend` is called once the token has named its owner, before any calendar
 * read: it returns whether this owner may fetch now, and a throw is a 503
 * (a limiter that cannot count refuses, as in lib/rateLimit.ts).
 */
export async function buildFeed(
  db: PrismaClient,
  token: string,
  now: Date = new Date(),
  spend?: (userID: string) => Promise<boolean>,
): Promise<FeedResult> {
  if (!(await isCalendarFeedEnabled(db))) return refusal(503);

  let userID: string | null;
  try {
    userID = await ownerOfFeedToken(db, token);
  } catch (err) {
    logFailure("token", err);
    return refusal(503);
  }
  if (userID === null) return refusal(401);
  if (spend) {
    try {
      if (!(await spend(userID))) return refusal(429);
    } catch (err) {
      logFailure("limit", err);
      return refusal(503);
    }
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const from = nowSec - FEED_PAST_DAYS * DAY_SEC;
  const to = nowSec + FEED_FUTURE_DAYS * DAY_SEC;

  const entries: IcsEntry[] = [];
  try {
    if (await areEventsEnabled(db)) {
      entries.push(
        ...(await readPublishedEvents(db, from, to)).map(eventEntry),
      );
    }
  } catch (err) {
    logFailure("events", err);
    return refusal(503);
  }
  try {
    const layer = await readProposalLayer(db, userID, from, to);
    if (layer) entries.push(...layer.map(proposalEntry));
  } catch (err) {
    logFailure("proposals", err);
    return refusal(503);
  }

  entries.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  return { status: 200, body: writeIcs({ name: "RHApp", entries }) };
}
