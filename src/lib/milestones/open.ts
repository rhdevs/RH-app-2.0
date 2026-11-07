import { currentAcademicYear } from "~/lib/transcript/academicYear";

/**
 * When a milestone is open (merge proposal 4.10, A53). Pure: nothing here reads
 * a clock or a database. "Open" is COMPUTED from the Event (or a finished
 * proposal with no Event) every time; no completed status exists and none is
 * stored.
 *
 *  - An Event opens one only when its status is exactly `published`, it has a
 *    CCA (a hall-wide event has none, so no head or director to file or rate
 *    it), and its end has passed. Draft, submitted, changes_requested,
 *    declined and canceled never open one, whatever their dates.
 *  - "Its end" is `endTime`, or `startTime` when `endTime` is null. An event
 *    with neither never opens one. A value that is not a positive whole number
 *    of epoch seconds is a bad row: it opens nothing (`null`).
 *  - A proposal with no Event opens one when it is `finished` and its planned
 *    end (`plannedEnd`, else `plannedStart`) has passed. A proposal that has an
 *    Event is handled through the Event.
 *
 * `hasEnded` is THE ONE function that decides "ended"; the queries, the
 * reminders and the screens all go through it.
 */

export const MILESTONE_EVENT_STATUS = "published";
export const MILESTONE_PROPOSAL_STATUS = "finished";

export type MilestoneEventRow = {
  status: string | null;
  ccaID: number | null;
  startTime: number | null;
  endTime: number | null;
};

export type MilestoneProposalRow = {
  status: string;
  ccaID: number;
  eventID: number | null;
  plannedStart: number | null;
  plannedEnd: number | null;
};

const isEpoch = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** `first` when it is set, else `second`. A set but invalid first value is bad, not a fallback. */
function endOf(
  first: number | null | undefined,
  second: number | null | undefined,
): number | null {
  if (first !== null && first !== undefined) {
    return isEpoch(first) ? first : null;
  }
  if (second !== null && second !== undefined) {
    return isEpoch(second) ? second : null;
  }
  return null;
}

/** The end of an event, status aside: `endTime`, else `startTime`, else null. */
export function eventEnd(
  e: Pick<MilestoneEventRow, "startTime" | "endTime">,
): number | null {
  return endOf(e.endTime, e.startTime);
}

/**
 * The end (epoch seconds) of an event that may carry a milestone, or null when
 * it never can: not published, hall-wide, or without a usable time.
 */
export function eventMilestoneEnd(e: MilestoneEventRow): number | null {
  if (e.status !== MILESTONE_EVENT_STATUS) return null;
  if (e.ccaID === null || !Number.isSafeInteger(e.ccaID) || e.ccaID <= 0) {
    return null;
  }
  return eventEnd(e);
}

/** The end of a finished proposal that has no Event, or null. */
export function proposalMilestoneEnd(p: MilestoneProposalRow): number | null {
  if (p.status !== MILESTONE_PROPOSAL_STATUS) return null;
  if (p.eventID !== null && p.eventID !== undefined) return null;
  if (!Number.isSafeInteger(p.ccaID) || p.ccaID <= 0) return null;
  return endOf(p.plannedEnd, p.plannedStart);
}

/**
 * How far back a waiting milestone is counted, in days. Deliberate (B152): so
 * nobody is nagged forever. An older unfiled milestone drops out of the counts
 * and the reminder, and stays on the CCA's yearly view, the full record.
 */
export const MILESTONE_WAITING_WINDOW_DAYS = 90;

/** THE ended check: the end is strictly before now (both epoch seconds). */
export function hasEnded(endSec: number | null, nowSec: number): boolean {
  return endSec !== null && endSec < nowSec;
}

/** Epoch seconds of a Date. */
export const toEpochSec = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * The academic year ("AY2026/27", 1 August to 31 July, Singapore time) of an
 * end time. The year of a milestone is derived from the date, never stored.
 */
export function milestoneYear(endSec: number): string {
  return currentAcademicYear(new Date(endSec * 1000));
}

export type MilestoneRef =
  | { kind: "event"; eventID: number }
  | { kind: "proposal"; proposalID: string };

/** The stored key of a milestone: one filing per key. */
export function milestoneKey(ref: MilestoneRef): string {
  return ref.kind === "event"
    ? `event:${ref.eventID}`
    : `proposal:${ref.proposalID.toLowerCase()}`;
}
