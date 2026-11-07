import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { headEventHref, headProposalHref } from "~/lib/proposals/links";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_PUBLIC_DESCRIPTION_MAX,
  EVENT_TITLE_MAX,
  normalizeStatus,
} from "~/lib/schemas/event";
import { createEventRow } from "~/server/api/services/eventDraft";
import {
  areEventsEnabled,
  assertEventsEnabled,
  nextEventId,
} from "~/server/api/services/events";
import { notify } from "~/server/api/services/notifications";
import { assertCcaHead, PROPOSAL_NOT_FOUND } from "./access";
import { assertWithinLimit } from "./limits";

/**
 * From an approved proposal to ONE linked Event draft (merge proposal 4.7).
 *
 * The draft cannot join the approval's transaction (`nextEventId` takes the
 * plain client and `event.create` has no transaction), so it is made right
 * AFTER the approval commits, in this order:
 *  1. read the proposal;
 *  2. if it already points at an Event that exists, stop;
 *  3. allocate an id with `nextEventId`;
 *  4. compare-and-set `Proposal.eventID` from the value read in 1 to the new id;
 *  5. ONLY if that changed one row, create the Event row.
 * Only one of any number of racing callers wins step 4, so at most one draft
 * is ever created. A failure after 4 leaves `eventID` pointing at no Event: a
 * reader sees "the draft is missing" and the Create event button repeats 3 to
 * 5 with that dangling value expected. A skipped counter value is harmless.
 *
 * The automatic step runs only while `events.enabled` is on, and a failure in
 * it never undoes or fails the approval (it logs the error name and returns).
 * Nothing here publishes: publishing stays `event.publish`, a head's action.
 *
 * Nothing in `event.*` reads any of this (A32); the dependency runs one way.
 */

export const EVENT_NOT_APPROVED = "PROPOSAL_NOT_APPROVED";
export const EVENT_BEING_MADE = "EVENT_BEING_MADE";
/** A finished proposal with a milestone filed keeps it: no Event is made (B149). */
export const EVENT_MILESTONE_FILED = "EVENT_MILESTONE_FILED";

/**
 * How long a claimed `eventID` counts as "being made". It outlasts the
 * function's time limit, so a claim older than this is a failed create, not a
 * slow one. This adds to 4.7's written order: without it a second caller could
 * read the first caller's claim as dangling, replace it, and leave the first
 * caller's late create as an unlinked orphan draft (A33).
 */
export const EVENT_CLAIM_WINDOW_MS = 2 * 60 * 1000;

/** What the automatic step did, returned to the approval's caller. */
export type EventDraftOutcome =
  | "created"
  | "already_linked"
  | "not_requested"
  | "events_off"
  | "in_progress"
  | "no_owner"
  | "skipped"
  | "failed";

const isFresh = (claimedAt: Date | null, now: number) =>
  claimedAt !== null && now - claimedAt.getTime() < EVENT_CLAIM_WINDOW_MS;

type LinkDb = PrismaClient;

type Source = {
  id: string;
  ccaID: number;
  createdBy: string | null;
  title: string;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
  willBeEvent: boolean | null;
  status: string;
  eventID: number | null;
  eventClaimedAt: Date | null;
};

const SOURCE_SELECT = {
  id: true,
  ccaID: true,
  createdBy: true,
  title: true,
  description: true,
  blastMessage: true,
  plannedStart: true,
  plannedEnd: true,
  willBeEvent: true,
  status: true,
  eventID: true,
  eventClaimedAt: true,
} as const;

const loadSource = (db: LinkDb, id: string): Promise<Source | null> =>
  db.proposal.findUnique({ where: { id }, select: SOURCE_SELECT });

/** What a reader of a proposal may learn of its Event: id, status and title. */
export type LinkedEvent = {
  eventID: number;
  status: string;
  title: string | null;
};

/**
 * The linked Event, or null if there is none or it no longer exists
 * (`deleteDraft`). Every read of the link goes through here.
 */
export async function readLinkedEvent(
  db: Pick<PrismaClient, "event">,
  eventID: number | null,
): Promise<LinkedEvent | null> {
  if (eventID === null) return null;
  const event = await db.event.findUnique({
    where: { eventID },
    select: { eventID: true, status: true, title: true },
  });
  if (!event) return null;
  return {
    eventID: event.eventID,
    status: normalizeStatus(event.status),
    title: event.title ?? null,
  };
}

/** The button works on an approved proposal, including one since finished (A34). */
const BUTTON_STATUSES = ["cleared", "finished"];

export type EventLinkView = {
  willBeEvent: boolean;
  /** The Event, if it exists: its id, status and title and nothing else. */
  event: LinkedEvent | null;
  /** The proposal points at an Event that is gone. */
  eventMissing: boolean;
  /** The proposal's Event is being made right now (a fresh claim). */
  eventBeingMade: boolean;
  eventsEnabled: boolean;
  canCreateEvent: boolean;
};

export async function readEventLinkView(
  db: LinkDb,
  row: Pick<Source, "willBeEvent" | "status" | "eventID" | "eventClaimedAt">,
  isHead: boolean,
): Promise<EventLinkView> {
  const [event, eventsEnabled] = await Promise.all([
    readLinkedEvent(db, row.eventID),
    areEventsEnabled(db),
  ]);
  const dangling = row.eventID !== null && event === null;
  const eventBeingMade = dangling && isFresh(row.eventClaimedAt, Date.now());
  return {
    willBeEvent: row.willBeEvent === true,
    event,
    eventMissing: dangling && !eventBeingMade,
    eventBeingMade,
    eventsEnabled,
    canCreateEvent:
      isHead &&
      eventsEnabled &&
      BUTTON_STATUSES.includes(row.status) &&
      event === null &&
      !eventBeingMade,
  };
}

type Outcome =
  | { outcome: "created"; eventID: number }
  | { outcome: "already_linked"; eventID: number }
  | { outcome: "in_progress" }
  | { outcome: "lost_race" }
  | { outcome: "milestone_filed" };

/** A missing key and a stored null do not match the same query on MongoDB. */
const eventIDIs = (expected: number | null) =>
  expected === null
    ? { OR: [{ eventID: null }, { eventID: { isSet: false } }] }
    : { eventID: expected };

function eventRowFrom(source: Source, eventID: number, ownerID: string) {
  const start = source.plannedStart;
  const end = source.plannedEnd;
  const timed = start !== null && end !== null && end > start;
  const blast = (source.blastMessage ?? "").trim();
  const description = source.description.trim();
  // Only these fields copy. The poster, location, facility, capacity,
  // category, document link, budget lines and status stay on the proposal.
  return {
    eventID,
    ccaID: source.ccaID,
    createdBy: ownerID,
    title: source.title.trim().slice(0, EVENT_TITLE_MAX),
    description:
      description === "" ? null : description.slice(0, EVENT_DESCRIPTION_MAX),
    startTime: timed ? start : null,
    endTime: timed ? end : null,
    location: null,
    facilityID: null,
    capacity: null,
    publicDescription:
      blast === "" ? null : blast.slice(0, EVENT_PUBLIC_DESCRIPTION_MAX),
  };
}

async function hasMilestoneFiling(db: LinkDb, id: string): Promise<boolean> {
  const row = await db.milestoneSubmission.findUnique({
    where: { milestoneKey: `proposal:${id.toLowerCase()}` },
    select: { id: true },
  });
  return row !== null;
}

async function linkAndCreate(
  db: LinkDb,
  source: Source,
  ownerID: string,
  statuses: string[],
): Promise<Outcome> {
  const expected = source.eventID;
  // A filed milestone belongs to the proposal while it has no Event: an Event
  // would open a second milestone and hide the filing (B149).
  if (await hasMilestoneFiling(db, source.id)) {
    return { outcome: "milestone_filed" };
  }
  if (expected !== null) {
    const there = await readLinkedEvent(db, expected);
    if (there) return { outcome: "already_linked", eventID: expected };
    // A claim made moments ago is a create still running, not a dangling id.
    if (isFresh(source.eventClaimedAt, Date.now())) {
      return { outcome: "in_progress" };
    }
  }
  const eventID = await nextEventId(db);
  const claimed = await db.proposal.updateMany({
    where: {
      id: source.id,
      ccaID: source.ccaID,
      status: { in: statuses },
      ...eventIDIs(expected),
    },
    data: { eventID, eventClaimedAt: new Date() },
  });
  if (claimed.count !== 1) return { outcome: "lost_race" };
  // Write-then-check: the filing side re-reads the claim after it commits, so
  // whichever of the two writes lands second sees the other and backs out.
  if (await hasMilestoneFiling(db, source.id)) {
    await db.proposal.updateMany({
      where: { id: source.id, eventID },
      data: { eventID: expected, eventClaimedAt: source.eventClaimedAt },
    });
    return { outcome: "milestone_filed" };
  }
  await createEventRow(db, eventRowFrom(source, eventID, ownerID));
  return { outcome: "created", eventID };
}

const logName = (evt: string, err: unknown) =>
  console.error(
    JSON.stringify({
      evt,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );

/** Tell the CCA's heads their draft exists. Best effort, never throws. */
async function noticeDraftMade(
  db: LinkDb,
  source: Source,
  eventID: number,
): Promise<void> {
  try {
    const heads = await db.ccaHead.findMany({
      where: { ccaID: source.ccaID },
      select: { userID: true },
    });
    await notify(db, {
      recipients: heads.map((h) => h.userID),
      kind: "proposal.event_drafted",
      title: "An event draft was made from your approved proposal",
      body: source.title,
      href: headEventHref(source.ccaID, eventID),
    });
  } catch (err) {
    logName("proposal_event_notice_failed", err);
  }
}

/** Tell a CCA's heads the draft was not made and what to do. Best effort. */
async function noticeDraftNotMade(db: LinkDb, source: Source): Promise<void> {
  try {
    const heads = await db.ccaHead.findMany({
      where: { ccaID: source.ccaID },
      select: { userID: true },
    });
    await notify(db, {
      recipients: heads.map((h) => h.userID),
      kind: "proposal.event_draft_failed",
      title:
        "The event draft was not made. Press Create event on the proposal.",
      body: source.title,
      href: headProposalHref(source.ccaID, source.id),
    });
  } catch (err) {
    logName("proposal_event_notice_failed", err);
  }
}

/** The proposal's author, if they still head its CCA; otherwise null. */
async function authorIfStillHead(
  db: LinkDb,
  source: Source,
): Promise<string | null> {
  if (source.createdBy === null) return null;
  const head = await db.ccaHead.findFirst({
    where: { ccaID: source.ccaID, userID: source.createdBy },
    select: { userID: true },
  });
  return head ? source.createdBy : null;
}

/**
 * Run right after an approval commits. Makes the draft when the head asked for
 * one and `events.enabled` is on. NEVER throws: whatever goes wrong is logged
 * by error name and the approval stands; the Create event button recovers.
 * It reports what happened, so the director's page can say when no draft was
 * made. Only a `cleared` proposal is drafted here; the button also accepts one
 * that has since finished.
 *
 * The draft's owner is the proposal's creator, but only while they still head
 * the CCA: the owner counts for door scanning and the JCRC "New" marker, so it
 * must be someone who can open and publish the draft. If their id was cleared
 * by account deletion (B16), or they no longer head the CCA, no draft is made
 * here, since the director who approved must not own it; the heads are told,
 * and a head can press the button, which then makes them the owner.
 */
export async function draftEventAfterApproval(
  db: LinkDb,
  proposalID: string,
): Promise<EventDraftOutcome> {
  let source: Source | null = null;
  try {
    source = await loadSource(db, proposalID);
    if (!source) return "skipped";
    if (source.status !== "cleared") {
      console.error(
        JSON.stringify({ evt: "proposal_event_draft_skipped", proposalID }),
      );
      return "skipped";
    }
    if (source.willBeEvent !== true) return "not_requested";
    if (!(await areEventsEnabled(db))) return "events_off";
    const ownerID = await authorIfStillHead(db, source);
    if (ownerID === null) {
      console.error(JSON.stringify({ evt: "proposal_event_no_owner" }));
      await noticeDraftNotMade(db, source);
      return "no_owner";
    }
    const result = await linkAndCreate(db, source, ownerID, ["cleared"]);
    if (result.outcome === "created") {
      await noticeDraftMade(db, source, result.eventID);
      return "created";
    }
    if (result.outcome === "milestone_filed") return "skipped";
    return result.outcome === "in_progress" ? "in_progress" : "already_linked";
  } catch (err) {
    logName("proposal_event_draft_failed", err);
    if (source) await noticeDraftNotMade(db, source);
    return "failed";
  }
}

/**
 * The Create event button. A head of the proposal's CCA, by the strict guard,
 * with both flags on (a failed flag read is off), on an approved proposal
 * (cleared, or finished since: A34). A director who is not also a head cannot
 * press it: the draft belongs to the CCA's heads, who alone can open and
 * publish it. Safe to press again, or at the same moment as the automatic
 * step: only one compare-and-set wins. While another create is still running
 * (a fresh claim) it writes nothing and says so.
 */
export async function createEventFromProposal(
  db: LinkDb,
  userID: string,
  id: string,
): Promise<{ created: boolean; eventID: number | null }> {
  await assertEventsEnabled(db);
  const source = await loadSource(db, id);
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  await assertCcaHead(db, userID, source.ccaID, { hideExistence: true });
  await assertWithinLimit("createEvent", userID);
  if (!BUTTON_STATUSES.includes(source.status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: EVENT_NOT_APPROVED,
    });
  }
  // The draft belongs to the head who pressed the button.
  const result = await linkAndCreate(db, source, userID, BUTTON_STATUSES);
  if (result.outcome === "in_progress") {
    throw new TRPCError({ code: "CONFLICT", message: EVENT_BEING_MADE });
  }
  if (result.outcome === "milestone_filed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: EVENT_MILESTONE_FILED,
    });
  }
  if (result.outcome === "lost_race") {
    const now = await loadSource(db, id);
    return { created: false, eventID: now?.eventID ?? null };
  }
  return { created: result.outcome === "created", eventID: result.eventID };
}
