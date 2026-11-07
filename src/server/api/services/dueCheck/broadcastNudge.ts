import { NUDGE_STAGES, addDays, daysBetween } from "~/lib/reminders/days";
import { REMINDERS_HREF } from "~/lib/reminders/links";
import { sgtDayKey } from "~/lib/time/sgt";
import { REMINDERS_FLAG_KEY } from "~/server/api/services/reminders/flag";
import {
  BROADCAST_SELECT,
  storedBroadcast,
} from "~/server/api/services/reminders/read";
import type { DueKind, DueNotice } from "./types";

const HEX_ID = /^[a-f\d]{24}$/i;

/** Most active, unexpired broadcasts one run reads; far above a real term. */
export const BROADCAST_SCAN_MAX = 500;

/**
 * Deadline nudges for the heads of a broadcast's CCAs (F22): 3 days and 1 day
 * before the deadline, written at the head's due check, not by a clock.
 *
 *  - RECIPIENTS are computed here, from the CcaHead rows as they are NOW (A30):
 *    the due check is run for one person, and a person is nudged only for a CCA
 *    they head at this moment. A head replaced since the broadcast was sent
 *    gets nothing, and their replacement does.
 *  - A target marked done is never nudged, and a cancelled or expired
 *    broadcast is not even read (active, deadline today or later, bounded).
 *  - A stage is due from its day until the deadline day. A stage whose day is
 *    not after the day the broadcast was sent is skipped: the send notice
 *    already told them.
 *  - Key `nudge.broadcast:<broadcast>:<cca>:<stage>`; the person is appended,
 *    so a second tab writes nothing. `catchUp: "mostUrgent"` with a `group` per
 *    broadcast and CCA: a head back after a long absence gets the most urgent
 *    stage of EACH broadcast, not every stage.
 *
 * Runs only while `reminders.enabled` is on, read strictly (a failed read
 * must not look like "nothing due"). No read here has a catch: a failure
 * reaches the runner, which logs the kind and error name and writes nothing.
 * A malformed row (A2) is counted, logged by count, and skipped.
 */
export const broadcastNudgeKind: DueKind = {
  name: "broadcast_nudge",
  noticeKind: "reminder.nudge",
  catchUp: "mostUrgent",
  async due({ db, userID, dayKey }) {
    const flag = await db.systemFlag.findUnique({
      where: { key: REMINDERS_FLAG_KEY },
    });
    if (flag?.value !== "on") return [];

    const headed = await db.ccaHead.findMany({
      where: { userID },
      select: { ccaID: true },
    });
    const ccaIDs = [...new Set(headed.map((h) => h.ccaID))];
    if (ccaIDs.length === 0) return [];

    // Broadcasts first: only active ones whose deadline has not passed, soonest
    // first, through the (status, deadline) index. Cancelled and expired
    // broadcasts, and their targets, are never read.
    const rows = await db.reminderBroadcast.findMany({
      where: { status: "active", deadline: { gte: dayKey } },
      orderBy: { deadline: "asc" },
      take: BROADCAST_SCAN_MAX + 1,
      select: BROADCAST_SELECT,
    });
    if (rows.length > BROADCAST_SCAN_MAX) {
      console.error(
        JSON.stringify({
          evt: "reminder_nudge_scan_capped",
          error: "ScanCapReached",
          count: BROADCAST_SCAN_MAX,
        }),
      );
    }
    let skipped = 0;
    const broadcasts = new Map<
      string,
      ReturnType<typeof storedBroadcast.parse>
    >();
    for (const row of rows.slice(0, BROADCAST_SCAN_MAX)) {
      const parsed = storedBroadcast.safeParse(row);
      if (parsed.success && HEX_ID.test(parsed.data.id)) {
        broadcasts.set(parsed.data.id, parsed.data);
      } else skipped += 1;
    }
    if (broadcasts.size === 0) return logSkipped(skipped);
    const open = await db.reminderTarget.findMany({
      where: {
        broadcastID: { in: [...broadcasts.keys()] },
        ccaID: { in: ccaIDs },
        doneAt: null,
      },
      select: { broadcastID: true, ccaID: true },
    });
    const names = new Map(
      (
        await db.cCA.findMany({
          where: { ccaID: { in: ccaIDs } },
          select: { ccaID: true, ccaName: true },
        })
      ).map((r) => [r.ccaID, r.ccaName]),
    );

    const items: DueNotice[] = [];
    for (const target of open) {
      const b = broadcasts.get(target.broadcastID);
      if (!b || dayKey > b.deadline) continue;
      const sentOn = sgtDayKey(b.createdAt);
      for (const stage of NUDGE_STAGES) {
        const from = addDays(b.deadline, -stage.daysBefore);
        if (dayKey < from || from <= sentOn) continue;
        const daysLeft = daysBetween(dayKey, b.deadline);
        items.push({
          key: `nudge.broadcast:${b.id}:${target.ccaID}:${stage.name}`,
          group: `${b.id}:${target.ccaID}`,
          urgency: stage.urgency,
          title:
            `${daysLeft <= 0 ? "Due today" : daysLeft === 1 ? "Due tomorrow" : `Due in ${daysLeft} days`}: ${b.title}`.slice(
              0,
              200,
            ),
          body: `${names.get(target.ccaID) ?? `CCA ${target.ccaID}`}: deadline ${b.deadline}. Open Reminders and mark it done when your CCA has finished.`,
          href: REMINDERS_HREF,
        });
      }
    }
    return logSkipped(skipped, items);
  },
};

/** Say how many rows were skipped (a count, never a value), then return. */
function logSkipped(skipped: number, items: DueNotice[] = []): DueNotice[] {
  if (skipped > 0) {
    console.error(
      JSON.stringify({ evt: "reminder_nudge_rows_skipped", skipped }),
    );
  }
  return items;
}
