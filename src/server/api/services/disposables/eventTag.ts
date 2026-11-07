import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  eventStateOf,
  tagProblem,
  TAG_PROBLEM_CODES,
  type EventState,
} from "~/lib/disposables/events";
import { EVENT_TITLE_MAX } from "~/lib/schemas/event";

/**
 * How a disposable request is tagged to an event (merge proposal 4.9, A66).
 *
 * Every request names an event, or a proposal that has no event yet. This file
 * is the one place that: works out the tag and the CCA from the STORED event or
 * proposal (never from the browser); refuses a tag that is not allowed; moves a
 * proposal's request to its event when the event is made; and reads how a
 * request's event stands now. It authorizes nothing: `access.ts` decides who
 * may file, once the CCA is known.
 *
 * Nothing here writes a status, and no read has a catch.
 */

export const DISPOSABLE_BAD_EVENT = "DISPOSABLE_BAD_EVENT";
export const DISPOSABLE_BAD_PROPOSAL = "DISPOSABLE_BAD_PROPOSAL";
export const DISPOSABLE_NEEDS_TAG = "DISPOSABLE_NEEDS_TAG";
export const DISPOSABLE_EVENT_MISMATCH = "DISPOSABLE_EVENT_MISMATCH";
/** Followed by `:<eventID>`, so the screen can point at the event. */
export const DISPOSABLE_PROPOSAL_HAS_EVENT = "DISPOSABLE_PROPOSAL_HAS_EVENT";
/** A draft or canceled proposal is not something a request can be filed for. */
export const DISPOSABLE_PROPOSAL_NOT_OPEN = "DISPOSABLE_PROPOSAL_NOT_OPEN";

/**
 * Proposal statuses a request cannot be tagged to: a draft has not been
 * submitted, a canceled one is over. A proposal has no "declined" status; the
 * director returns it (`needs_action`) and the head can resubmit, so a returned
 * one is still open.
 */
const UNTAGGABLE_PROPOSAL_STATUSES: readonly string[] = ["draft", "canceled"];

type EventDb = Pick<PrismaClient, "event">;

/** The title an Event made from a proposal gets (kept in step with the copy). */
export const proposalEventTitle = (proposalTitle: string) =>
  proposalTitle.trim().slice(0, EVENT_TITLE_MAX);

/** The snapshot kept on a request filed for this event. */
const snapshotOf = (title: string | null) => {
  const t = (title ?? "").trim().slice(0, EVENT_TITLE_MAX);
  return t === "" ? null : t;
};

export type TagTarget = {
  /** The CCA the request belongs to: the event's, else the proposal's. Null is hall-wide. */
  ccaID: number | null;
  eventID: number | null;
  /** The snapshot to store with `eventID`. */
  eventTitle: string | null;
  proposalID: string | null;
  /** The event row, for the taggable check. Null when tagged to a proposal only. */
  event: {
    eventID: number;
    title: string | null;
    status: string | null;
    endTime: number | null;
  } | null;
  /**
   * Set when the tag is not allowed. Raised only AFTER the caller has been
   * authorized for `ccaID`, so a stranger learns nothing about the event or the
   * proposal beyond "no such one".
   */
  problem: string | null;
};

const bad = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

/**
 * Work out what a filing is tagged to, from stored rows. Refuses a missing
 * event or proposal at once (same answer for everyone); every other problem is
 * returned in `problem` for the caller to raise once it knows the person may
 * file for `ccaID`.
 */
export async function resolveTarget(
  db: Pick<PrismaClient, "event" | "proposal">,
  input: { eventID: number | null; proposalID: string | null },
): Promise<TagTarget> {
  if (input.eventID === null && input.proposalID === null) {
    throw bad(DISPOSABLE_NEEDS_TAG);
  }
  const proposal =
    input.proposalID === null
      ? null
      : await db.proposal.findUnique({
          where: { id: input.proposalID },
          select: { id: true, ccaID: true, eventID: true, status: true },
        });
  if (input.proposalID !== null && !proposal)
    throw bad(DISPOSABLE_BAD_PROPOSAL);

  if (input.eventID !== null) {
    const event = await db.event.findUnique({
      where: { eventID: input.eventID },
      select: {
        eventID: true,
        ccaID: true,
        title: true,
        status: true,
        endTime: true,
      },
    });
    if (!event) throw bad(DISPOSABLE_BAD_EVENT);
    // Both given: the proposal must already be the one the event was made from.
    const mismatch = proposal !== null && proposal.eventID !== event.eventID;
    return {
      ccaID: event.ccaID ?? null,
      eventID: event.eventID,
      eventTitle: snapshotOf(event.title),
      proposalID: proposal?.id ?? null,
      event,
      problem: mismatch ? DISPOSABLE_EVENT_MISMATCH : null,
    };
  }

  // A proposal only. If it already has an event that exists, the request must
  // name the event instead; an id that points at nothing (a deleted draft) is
  // the same as no event.
  const p = proposal!;
  const linked =
    p.eventID === null
      ? null
      : await db.event.findUnique({
          where: { eventID: p.eventID },
          select: { eventID: true },
        });
  return {
    ccaID: p.ccaID,
    eventID: null,
    eventTitle: null,
    proposalID: p.id,
    event: null,
    problem: linked
      ? `${DISPOSABLE_PROPOSAL_HAS_EVENT}:${linked.eventID}`
      : UNTAGGABLE_PROPOSAL_STATUSES.includes(p.status)
        ? DISPOSABLE_PROPOSAL_NOT_OPEN
        : null,
  };
}

/** Refuse an event that is canceled, declined, ended or has no title. */
export function assertTaggable(target: TagTarget, now: Date): void {
  if (target.event === null) return;
  const problem = tagProblem(target.event, Math.floor(now.getTime() / 1000));
  if (problem !== null) throw bad(TAG_PROBLEM_CODES[problem]);
}

/**
 * Filing against a proposal while its Event is being made. The pre-check saw no
 * Event, and the Event's claim and request move can both land before this
 * request exists, so the move finds nothing. After the filing commits, read the
 * proposal again and tag the request only if the Event ROW its `eventID` names
 * exists. A claim with no Event row is in flight or dangling (backed out or
 * crashed): leave the request on the proposal for the final move, which runs
 * after the row is created. So either that move sees this request, or this
 * request was inserted after it and finds the row here. A compare-and-set on
 * `eventID: null`, so it cannot overwrite a tag the move already wrote.
 */
export async function tagIfProposalGotAnEvent(
  db: Pick<PrismaClient, "event" | "proposal" | "disposableRequest">,
  requestID: string,
  target: Pick<TagTarget, "proposalID">,
): Promise<boolean> {
  if (target.proposalID === null) return false;
  const proposal = await db.proposal.findUnique({
    where: { id: target.proposalID },
    select: { ccaID: true, title: true, eventID: true },
  });
  // Event ids start at 1, so a falsy id is no event.
  if (!proposal?.eventID) return false;
  const event = await db.event.findUnique({
    where: { eventID: proposal.eventID },
    select: { title: true },
  });
  if (event === null) return false;
  const moved = await db.disposableRequest.updateMany({
    where: { id: requestID, proposalID: target.proposalID, eventID: null },
    data: {
      eventID: proposal.eventID,
      eventTitle: snapshotOf(event.title) ?? proposalEventTitle(proposal.title),
      ccaID: proposal.ccaID,
    },
  });
  return moved.count === 1;
}

/**
 * An Event was made from this proposal: move its request (at most one: the
 * partial unique index) to the Event. Sets `eventID`, `eventTitle` and `ccaID`
 * and KEEPS `proposalID`. Runs on the transaction client, in the same
 * transaction as the proposal's claim of the Event id.
 */
export function moveProposalRequestToEvent(
  tx: Prisma.TransactionClient,
  move: {
    proposalID: string;
    eventID: number;
    proposalTitle: string;
    ccaID: number;
  },
) {
  return tx.disposableRequest.updateMany({
    where: { proposalID: move.proposalID },
    data: {
      eventID: move.eventID,
      eventTitle: proposalEventTitle(move.proposalTitle),
      ccaID: move.ccaID,
    },
  });
}

/** Put the request back as it was when the claim is backed out. */
export function moveProposalRequestBack(
  tx: Prisma.TransactionClient,
  back: { proposalID: string; eventID: number; to: number | null },
) {
  return tx.disposableRequest.updateMany({
    where: { proposalID: back.proposalID, eventID: back.eventID },
    data: {
      eventID: back.to,
      ...(back.to === null && { eventTitle: null }),
    },
  });
}

export type RequestEvent = {
  eventID: number;
  /** The live title while the event exists, else the snapshot (may be null). */
  title: string | null;
  state: EventState;
};

/** The Event rows as they stand now, by id: live title (or null) and state. */
export type LiveEvents = Map<
  number,
  { liveTitle: string | null; state: EventState }
>;

/**
 * How each event named in `rows` stands NOW, derived from the Event row at read
 * time with no write: its live title, and whether it is canceled, declined or
 * gone. One query for all the rows.
 */
export async function liveEventsOf(
  db: EventDb,
  rows: ReadonlyArray<{ eventID: number | null }>,
): Promise<LiveEvents> {
  const ids = [
    ...new Set(rows.flatMap((r) => (r.eventID !== null ? [r.eventID] : []))),
  ];
  const out: LiveEvents = new Map();
  if (ids.length === 0) return out;
  const found = await db.event.findMany({
    where: { eventID: { in: ids } },
    select: { eventID: true, title: true, status: true },
  });
  const byID = new Map(found.map((e) => [e.eventID, e]));
  for (const id of ids) {
    const event = byID.get(id) ?? null;
    const live = (event?.title ?? "").trim();
    out.set(id, {
      liveTitle: event !== null && live !== "" ? live : null,
      state: eventStateOf(event),
    });
  }
  return out;
}

/** The request's event as it should be shown: the live title, else the snapshot. */
export function requestEventOf(
  row: { eventID: number | null; eventTitle: string | null },
  live: LiveEvents,
): RequestEvent | null {
  if (row.eventID === null) return null;
  const now = live.get(row.eventID);
  return {
    eventID: row.eventID,
    title: now?.liveTitle ?? row.eventTitle,
    state: now?.state ?? "gone",
  };
}
