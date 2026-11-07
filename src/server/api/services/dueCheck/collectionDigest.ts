import { DISPOSABLES_HREF } from "~/lib/disposables/links";
import { isSocialDirector } from "~/server/api/services/directorGuard";
import { approvedOn } from "~/server/api/services/disposables/digest";
import { DISPOSABLES_FLAG_KEY } from "~/server/api/services/disposables/flag";
import type { DueKind } from "./types";

/**
 * The Social director's daily digest (F19): ONE inbox notice on a Singapore
 * day that has approved collections, written at their first due check that
 * day, and none on a day with none. Key `due.collection_digest:<Singapore
 * day>`; the person is appended, so a second tab or device finds the row and
 * writes nothing.
 *
 * Runs only while `disposables.enabled` is on (F19 is gated on that flag only),
 * read strictly: `isDisposablesEnabled` swallows a failed read, and a database
 * fault must not look like "no collections today". The Social director is the
 * strict guard's answer, so this cannot disagree with who may decide requests.
 * The body says how many and when, never what was asked for. A bad row is
 * counted and skipped by `approvedOn`; if nothing good remains, nothing is
 * written. None of these reads has a catch: a failure reaches the runner, which
 * logs the kind and error name and writes nothing.
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
    if (flag?.value !== "on") return [];
    if (!(await isSocialDirector(db, userID, now))) return [];

    const { rows, skipped } = await approvedOn(db, dayKey);
    if (skipped > 0) {
      // A count only: never a value from the bad row (A2).
      console.error(
        JSON.stringify({ evt: "collection_digest_rows_skipped", skipped }),
      );
    }
    if (rows.length === 0) return [];
    const times = [...new Set(rows.map((r) => r.collectionTime))].sort();
    return [
      {
        key: `due.collection_digest:${dayKey}`,
        title:
          rows.length === 1
            ? "1 disposables collection today"
            : `${rows.length} disposables collections today`,
        body: `Collection times: ${times.join(", ")}.`.slice(0, 1000),
        href: DISPOSABLES_HREF,
      },
    ];
  },
};
