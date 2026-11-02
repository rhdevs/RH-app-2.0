import { MILESTONES_FLAG_KEY } from "~/server/api/services/milestones/flag";
import { milestoneSeats } from "~/server/api/services/milestones/access";
import { waitingFor } from "~/server/api/services/milestones/waiting";
import type { DueKind } from "./types";

/** Where the person goes to file or rate. */
export const MILESTONE_REMINDER_HREF = "/milestones";

/**
 * Milestones waiting (merge proposal 4.10, A51): ONE inbox notice per person
 * per Singapore day that says how many are waiting, split into those the person
 * has to file (as a head) and those to rate (as a director). Key
 * `due.milestones:<Singapore day>`; the person is appended, so two tabs, a
 * second device or a cron write it once.
 *
 * Runs only while `milestones.enabled` is on, read strictly (a failed read
 * reaches the runner, which logs the error name and writes nothing; it must not
 * look like "nothing is due"). The seats come from the strict head and director
 * reads (access.ts), the counts from the same bounded 90-day window the home
 * entries use (waiting.ts), so the number in the bell is the number on the
 * screen. Canceled and finished (rated) milestones do not count, and a person
 * with nothing waiting gets nothing. No email, no Telegram, no cron: the notice
 * is in the inbox only, written when the person's app runs the due check.
 *
 * Catch-up: only today's state under today's key, so "all" (one notice).
 * This file has no catch.
 */
export const milestoneRemindersKind: DueKind = {
  name: "milestones",
  noticeKind: "milestone.waiting",
  catchUp: "all",
  async due({ db, userID, now, dayKey }) {
    const flag = await db.systemFlag.findUnique({
      where: { key: MILESTONES_FLAG_KEY },
    });
    if (flag?.value !== "on") return [];
    const seats = await milestoneSeats(db, userID);
    if (seats.headed.length === 0 && seats.directed.length === 0) return [];
    const waiting = await waitingFor(db, seats, now);
    let toFile = 0;
    let toRate = 0;
    for (const c of waiting.perCca.values()) {
      toFile += c.toFile;
      toRate += c.toRate;
    }
    const total = toFile + toRate;
    if (total === 0) return [];
    const parts: string[] = [];
    if (toFile > 0) parts.push(`${toFile} to file`);
    if (toRate > 0) parts.push(`${toRate} to rate`);
    return [
      {
        key: `due.milestones:${dayKey}`,
        title:
          total === 1
            ? "1 milestone is waiting"
            : `${total} milestones are waiting`,
        body: `${parts.join(", ")}.`,
        href: MILESTONE_REMINDER_HREF,
      },
    ];
  },
};
