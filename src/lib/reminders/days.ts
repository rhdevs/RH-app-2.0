import { isRealDayKey } from "~/lib/schemas/disposable";

const DAY_MS = 86_400_000;

const toUtc = (key: string) => Date.parse(`${key}T00:00:00Z`);

/** The Singapore date key `n` days from `key` (n may be negative). */
export function addDays(key: string, n: number): string {
  return new Date(toUtc(key) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromKey` to `toKey`; negative when `toKey` is earlier. */
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / DAY_MS);
}

export { isRealDayKey };

/**
 * The nudge stages, in the order they come due. A stage is due from
 * `daysBefore` days before the deadline until the deadline day itself. Higher
 * `urgency` wins when several are due at once (a long absence).
 */
export const NUDGE_STAGES = [
  { name: "d3", daysBefore: 3, urgency: 1 },
  { name: "d1", daysBefore: 1, urgency: 2 },
] as const;
export type NudgeStageName = (typeof NUDGE_STAGES)[number]["name"];
