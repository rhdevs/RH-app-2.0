import type { PrismaClient } from "@prisma/client";

import {
  eventEnd,
  eventMilestoneEnd,
  hasEnded,
  milestoneKey,
  proposalMilestoneEnd,
  toEpochSec,
  type MilestoneRef,
} from "~/lib/milestones/open";

/**
 * Finding milestones, from stored Events and finished proposals only (merge
 * proposal 4.10, A53). Nothing here is stored: a milestone is open when
 * `lib/milestones/open.ts` says so, and every row a query returns is run
 * through that same pure code again, so the filter and the rule cannot drift.
 * No read here has a catch; a failure reaches the caller.
 *
 * Every list is BOUNDED: by a date range, and by a row cap (one more row than
 * the cap is read so a capped result can be said to be capped). A row with a
 * time that is not a positive whole number is counted and skipped.
 */

/** Most events one list reads, and most finished proposals. */
export const MILESTONE_EVENT_SCAN_MAX = 300;
export const MILESTONE_PROPOSAL_SCAN_MAX = 100;

export type MilestoneState = "open" | "canceled";

export type MilestoneCandidate = {
  ref: MilestoneRef;
  key: string;
  ccaID: number;
  title: string;
  /** Epoch seconds of the end (`endTime`, else `startTime`). */
  endedAt: number;
  /** `canceled` is a published event canceled later; only kept filings show it. */
  state: MilestoneState;
};

export type CandidateList = {
  items: MilestoneCandidate[];
  /** Rows with an unusable time, counted and left out. */
  skipped: number;
  /** A cap was hit; there may be more in the range. */
  capped: boolean;
};

type Db = Pick<PrismaClient, "event" | "proposal">;

export type CandidateRange = {
  /** Inclusive, epoch seconds. */
  fromSec: number;
  /** Exclusive, epoch seconds; never later than now for an "ended" list. */
  toSec: number;
};

const noEnd = (field: "endTime" | "plannedEnd") => ({
  OR: [{ [field]: null }, { [field]: { isSet: false } }],
});

/**
 * The CCA events (published, and canceled when asked) and finished proposals
 * with no Event whose end is inside the range and has passed, newest first.
 * `ccaIDs` empty answers empty without reading.
 */
export async function findEndedMilestones(
  db: Db,
  ccaIDs: readonly number[],
  range: CandidateRange,
  now: Date,
  opts: { includeCanceled?: boolean } = {},
): Promise<CandidateList> {
  const out: CandidateList = { items: [], skipped: 0, capped: false };
  if (ccaIDs.length === 0) return out;
  const nowSec = toEpochSec(now);
  const to = Math.min(range.toSec, nowSec);
  if (to <= range.fromSec) return out;
  const between = { gte: range.fromSec, lt: to };

  const events = await db.event.findMany({
    where: {
      ccaID: { in: [...ccaIDs] },
      status: opts.includeCanceled
        ? { in: ["published", "canceled"] }
        : "published",
      OR: [
        { endTime: between },
        { AND: [noEnd("endTime"), { startTime: between }] },
      ],
    },
    orderBy: { startTime: "desc" },
    take: MILESTONE_EVENT_SCAN_MAX + 1,
    select: {
      eventID: true,
      ccaID: true,
      title: true,
      status: true,
      startTime: true,
      endTime: true,
    },
  });
  if (events.length > MILESTONE_EVENT_SCAN_MAX) out.capped = true;
  for (const e of events.slice(0, MILESTONE_EVENT_SCAN_MAX)) {
    const end = e.status === "canceled" ? eventEnd(e) : eventMilestoneEnd(e);
    if (end === null || e.ccaID === null || !hasEnded(end, nowSec)) {
      out.skipped += 1;
      continue;
    }
    const ref: MilestoneRef = { kind: "event", eventID: e.eventID };
    out.items.push({
      ref,
      key: milestoneKey(ref),
      ccaID: e.ccaID,
      title: e.title?.trim() ? e.title : "Untitled event",
      endedAt: end,
      state: e.status === "canceled" ? "canceled" : "open",
    });
  }

  const proposals = await db.proposal.findMany({
    where: {
      ccaID: { in: [...ccaIDs] },
      status: "finished",
      AND: [
        { OR: [{ eventID: null }, { eventID: { isSet: false } }] },
        {
          OR: [
            { plannedEnd: between },
            { AND: [noEnd("plannedEnd"), { plannedStart: between }] },
          ],
        },
      ],
    },
    orderBy: { plannedStart: "desc" },
    take: MILESTONE_PROPOSAL_SCAN_MAX + 1,
    select: {
      id: true,
      ccaID: true,
      title: true,
      status: true,
      eventID: true,
      plannedStart: true,
      plannedEnd: true,
    },
  });
  if (proposals.length > MILESTONE_PROPOSAL_SCAN_MAX) out.capped = true;
  for (const p of proposals.slice(0, MILESTONE_PROPOSAL_SCAN_MAX)) {
    const end = proposalMilestoneEnd({
      status: p.status,
      ccaID: p.ccaID,
      eventID: p.eventID ?? null,
      plannedStart: p.plannedStart ?? null,
      plannedEnd: p.plannedEnd ?? null,
    });
    if (end === null || !hasEnded(end, nowSec)) {
      out.skipped += 1;
      continue;
    }
    const ref: MilestoneRef = { kind: "proposal", proposalID: p.id };
    out.items.push({
      ref,
      key: milestoneKey(ref),
      ccaID: p.ccaID,
      title: p.title,
      endedAt: end,
      state: "open",
    });
  }
  out.items.sort((a, b) => b.endedAt - a.endedAt);
  return out;
}

/** Where one milestone stands, for the calls that name it by reference. */
export type ResolvedMilestone = {
  ref: MilestoneRef;
  key: string;
  ccaID: number;
  title: string;
  endedAt: number | null;
  /**
   * `open`: published (or finished) and ended: can be filed and rated.
   * `canceled`: a published event canceled later: the filing stays, no more is
   * accepted. `closed`: anything else (not ended yet, a draft, hall-wide,
   * an Event-linked proposal...): nothing can be filed.
   */
  state: MilestoneState | "closed";
};

/**
 * Read one named milestone's source row, or null when there is no such row or
 * it can never carry a milestone (a hall-wide event). A bad time reads as
 * `closed`. Never throws on a missing row.
 */
export async function resolveMilestone(
  db: Db,
  ref: MilestoneRef,
  now: Date,
): Promise<ResolvedMilestone | null> {
  const nowSec = toEpochSec(now);
  const key = milestoneKey(ref);
  if (ref.kind === "event") {
    const e = await db.event.findUnique({
      where: { eventID: ref.eventID },
      select: {
        ccaID: true,
        title: true,
        status: true,
        startTime: true,
        endTime: true,
      },
    });
    const eventCca = e?.ccaID ?? null;
    if (e === null || eventCca === null) return null;
    const title = e.title?.trim() ? e.title : "Untitled event";
    const base = { ref, key, ccaID: eventCca, title };
    if (e.status === "canceled") {
      const end = eventEnd(e);
      return {
        ...base,
        endedAt: end,
        state: end === null ? "closed" : "canceled",
      };
    }
    const end = eventMilestoneEnd(e);
    return {
      ...base,
      endedAt: end,
      state: hasEnded(end, nowSec) ? "open" : "closed",
    };
  }
  const p = await db.proposal.findUnique({
    where: { id: ref.proposalID },
    select: {
      ccaID: true,
      title: true,
      status: true,
      eventID: true,
      plannedStart: true,
      plannedEnd: true,
    },
  });
  if (p === null) return null;
  const end = proposalMilestoneEnd({
    status: p.status,
    ccaID: p.ccaID,
    eventID: p.eventID ?? null,
    plannedStart: p.plannedStart ?? null,
    plannedEnd: p.plannedEnd ?? null,
  });
  return {
    ref,
    key,
    ccaID: p.ccaID,
    title: p.title,
    endedAt: end,
    state: hasEnded(end, nowSec) ? "open" : "closed",
  };
}
