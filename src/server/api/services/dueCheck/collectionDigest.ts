import { DISPOSABLES_HREF } from "~/lib/disposables/links";
import { EQUIPMENT_HREF } from "~/lib/equipment/links";
import { isSocialDirector } from "~/server/api/services/directorGuard";
import { approvedOn } from "~/server/api/services/disposables/digest";
import { DISPOSABLES_FLAG_KEY } from "~/server/api/services/disposables/flag";
import { EQUIPMENT_FLAG_KEY } from "~/server/api/services/equipment/flag";
import { overdueLoans } from "~/server/api/services/equipment/overdue";
import type { DueKind } from "./types";

/**
 * The Social director's daily digest (F19): ONE inbox notice on a Singapore
 * day that has approved collections, written at their first due check that
 * day, and none on a day with none. Key `due.collection_digest:<Singapore
 * day>`; the person is appended, so a second tab or device finds the row and
 * writes nothing.
 *
 * Runs only while `disposables.enabled` or `equipment.enabled` is on, each read
 * strictly: `isDisposablesEnabled` swallows a failed read, and a database
 * fault must not look like "no collections today". The Social director is the
 * strict guard's answer, so this cannot disagree with who may decide requests.
 * The body says how many and when, never what was asked for. A bad row is
 * counted and skipped by `approvedOn`; if nothing good remains, nothing is
 * written. None of these reads has a catch: a failure reaches the runner, which
 * logs the kind and error name and writes nothing.
 *
 * Equipment (14b): while `equipment.enabled` is on, the same notice also counts
 * the equipment loans that are overdue (approved or collected, past their
 * return time) and names a few by event and CCA, "hall-wide" when there is
 * none. An approved loan that was never collected, for an event that was
 * canceled or declined, is left out. A scan that reaches its bound says
 * "100+" instead of an exact-looking count. A day with overdue loans and no collections still gets the notice.
 *
 * A request approved later the same day is covered only if no digest was
 * written yet; a person who already has the day's notice is not told twice.
 * Catch-up: only today's state under today's key is computed, so there are no
 * missed days to collapse. Hence "all" (there is one notice).
 */
export const collectionDigestKind: DueKind = {
  name: "collection_digest",
  noticeKind: "disposable.digest",
  catchUp: "all",
  async due({ db, userID, now, dayKey }) {
    const flag = await db.systemFlag.findUnique({
      where: { key: DISPOSABLES_FLAG_KEY },
    });
    const equipmentFlag = await db.systemFlag.findUnique({
      where: { key: EQUIPMENT_FLAG_KEY },
    });
    const disposablesOn = flag?.value === "on";
    const equipmentOn = equipmentFlag?.value === "on";
    if (!disposablesOn && !equipmentOn) return [];
    if (!(await isSocialDirector(db, userID, now))) return [];

    const { rows, skipped } = disposablesOn
      ? await approvedOn(db, dayKey)
      : { rows: [], skipped: 0 };
    if (skipped > 0) {
      // A count only: never a value from the bad row (A2).
      console.error(
        JSON.stringify({ evt: "collection_digest_rows_skipped", skipped }),
      );
    }
    const overdue = equipmentOn
      ? await overdueLoans(db, Math.floor(now.getTime() / 1000))
      : { count: 0, labels: [], more: false };
    if (rows.length === 0 && overdue.count === 0) return [];

    const titles: string[] = [];
    const bodies: string[] = [];
    if (rows.length > 0) {
      const times = [...new Set(rows.map((r) => r.collectionTime))].sort();
      titles.push(
        rows.length === 1
          ? "1 disposables collection today"
          : `${rows.length} disposables collections today`,
      );
      bodies.push(`Collection times: ${times.join(", ")}.`);
    }
    if (overdue.count > 0) {
      // A scan that hit its bound says "100+", never an exact-looking count.
      const shownCount = overdue.more ? `${overdue.count}+` : overdue.count;
      const many =
        shownCount === 1
          ? "1 overdue equipment loan"
          : `${shownCount} overdue equipment loans`;
      titles.push(many);
      bodies.push(
        `Overdue equipment: ${overdue.labels.join(", ")}${overdue.more || overdue.count > overdue.labels.length ? ", and more" : ""}.`,
      );
    }
    return [
      {
        key: `due.collection_digest:${dayKey}`,
        title: titles.join(" and ").replace(/^./, (c) => c.toUpperCase()),
        body: bodies.join(" ").slice(0, 1000),
        href: rows.length > 0 ? DISPOSABLES_HREF : EQUIPMENT_HREF,
      },
    ];
  },
};
