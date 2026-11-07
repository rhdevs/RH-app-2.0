import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { sgtDayKey } from "~/lib/time/sgt";
import { notify } from "~/server/api/services/notifications";
import { DUE_KINDS } from "./registry";
import type { DueCheckResult, DueKind, DueNotice } from "./types";

export const DUE_CHECK_KIND_FAILED = "due_check_kind_failed";

/** The error's class name only: a driver message can carry stored values. */
const errorName = (err: unknown) =>
  err instanceof Error ? err.name : typeof err;

/** Two runs wrote the same key at once; the partial unique index chose one. */
const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Keep the notices a kind may write after a long absence. */
function selectForCatchUp(kind: DueKind, items: DueNotice[]): DueNotice[] {
  if (kind.catchUp === "all" || items.length <= 1) return items;
  let best = items[0]!;
  for (const item of items) {
    if ((item.urgency ?? 0) > (best.urgency ?? 0)) best = item;
  }
  return [best];
}

async function writeOne(
  db: PrismaClient,
  kind: DueKind,
  userID: string,
  item: DueNotice,
): Promise<number> {
  try {
    const res = await notify(db, {
      recipients: [userID],
      kind: kind.noticeKind,
      title: item.title,
      ...(item.body !== undefined && { body: item.body }),
      ...(item.href !== undefined && { href: item.href }),
      once: item.key,
    });
    return res.written;
  } catch (err) {
    // The other run won the unique key between our read and our write: the
    // notice exists once, which is the goal.
    if (isDuplicateKey(err)) return 0;
    throw err;
  }
}

/**
 * THE DUE CHECK. Work out which timed notices are due for ONE person from
 * stored state and write the missing inbox rows. It takes a user id and a
 * client, not a session, so the mutation (the bell) and a later cron route
 * share it.
 *
 *  - It works for the person it is given and nobody else. A kind sees one
 *    user id and writes only to that person.
 *  - Idempotent: every notice carries a unique key (`notify`'s `once`, backed
 *    by the partial unique index on `Notification.noticeKey`), so two tabs,
 *    two devices or a repeat call write each notice once. A person with
 *    nothing due gets nothing.
 *  - Each kind runs alone. A kind that throws is logged by error name and the
 *    others still run; the failed kind writes nothing more.
 *  - It never calls Telegram, email or anything outside the database.
 *  - `notify` writes nothing while `notifications.enabled` is off.
 *
 * `kinds` and `now` are seams for tests; callers use the defaults.
 */
export async function runDueCheck(
  db: PrismaClient,
  userID: string,
  opts: { kinds?: readonly DueKind[]; now?: Date } = {},
): Promise<DueCheckResult> {
  const kinds = opts.kinds ?? DUE_KINDS;
  const now = opts.now ?? new Date();
  const dayKey = sgtDayKey(now);
  let written = 0;
  const failedKinds: string[] = [];

  for (const kind of kinds) {
    try {
      const items = selectForCatchUp(
        kind,
        await kind.due({ db, userID, now, dayKey }),
      );
      for (const item of items) {
        written += await writeOne(db, kind, userID, item);
      }
    } catch (err) {
      failedKinds.push(kind.name);
      console.error(
        JSON.stringify({
          evt: DUE_CHECK_KIND_FAILED,
          kind: kind.name,
          error: errorName(err),
        }),
      );
    }
  }
  return { written, failedKinds };
}
