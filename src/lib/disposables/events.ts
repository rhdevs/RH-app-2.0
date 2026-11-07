import { normalizeStatus } from "~/lib/schemas/event";
import { sgtDayKey } from "~/lib/time/sgt";

/**
 * Which events a disposable request may be tagged to, and how a tagged
 * request shows its event (merge proposal 4.9, A66). Pure and server-import
 * free: the server runs it to refuse, the picker's read runs it to list, and
 * the screens run it to draw, so the three cannot disagree.
 *
 * An event can be tagged unless it is canceled, declined or ended. `endTime` is
 * UNIX epoch SECONDS (UTC). A status the app does not know counts as a draft
 * (`normalizeStatus`), which is taggable. An event with no title cannot say
 * what the request is for, so it is not taggable either.
 */

export const TAG_PROBLEMS = [
  "canceled",
  "declined",
  "ended",
  "untitled",
] as const;
export type TagProblem = (typeof TAG_PROBLEMS)[number];

export const TAG_PROBLEM_CODES: Record<TagProblem, string> = {
  canceled: "DISPOSABLE_EVENT_CANCELED",
  declined: "DISPOSABLE_EVENT_DECLINED",
  ended: "DISPOSABLE_EVENT_ENDED",
  untitled: "DISPOSABLE_EVENT_UNTITLED",
};

export type TagCheckEvent = {
  status: string | null;
  endTime: number | null;
  title: string | null;
};

/** Why this event cannot be tagged, or null when it can. */
export function tagProblem(
  event: TagCheckEvent,
  nowSeconds: number,
): TagProblem | null {
  const status = normalizeStatus(event.status);
  if (status === "canceled") return "canceled";
  if (status === "declined") return "declined";
  if (event.endTime !== null && event.endTime <= nowSeconds) return "ended";
  if ((event.title ?? "").trim() === "") return "untitled";
  return null;
}

/** How a request's event stands, worked out when the request is read. */
export type EventState = "ok" | "canceled" | "declined" | "gone";

export function eventStateOf(
  event: { status: string | null } | null,
): EventState {
  if (event === null) return "gone";
  const status = normalizeStatus(event.status);
  if (status === "canceled") return "canceled";
  if (status === "declined") return "declined";
  return "ok";
}

/**
 * The collection day the form starts with for an event: the Singapore day the
 * event starts, or today when it started earlier (a collection cannot be in the
 * past). "" when the event has no start yet. The person can change it.
 */
export function defaultCollectionDay(
  startTime: number | null,
  todayKey: string,
): string {
  if (startTime === null) return "";
  const start = sgtDayKey(new Date(startTime * 1000));
  return start < todayKey ? todayKey : start;
}
