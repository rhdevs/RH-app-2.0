/**
 * Erases the custom-question answers on events whose retention window has
 * closed (D-52 layer 2).
 *
 * NOTHING RUNS THIS AUTOMATICALLY. THERE IS NO CRON IN THIS REPOSITORY. There
 * is no `vercel.json`, no cron key in `package.json` or `next.config.js`, and
 * every scheduled-sounding thing in scripts/remediation/ is something a human
 * types. So read the next paragraph before deciding how urgent this is.
 *
 * WHAT THE APP GUARANTEES WITHOUT ANYONE RUNNING THIS (D-52 layer 1). The read
 * cutoff is unconditional and needs no operator: `getAttendees`,
 * `exportAttendees` and `getSignupAnswers` return NO ANSWERS AT ALL once
 * EVENT_ANSWER_RETENTION_DAYS (60) days have passed since `(endTime ??
 * startTime)` — whether or not the rows still hold them, and whether or not
 * `Event.answersPurgedAt` is set. The head sees the retention notice instead.
 * The answers therefore stop being REACHABLE on time regardless of this script.
 * What this script buys is that they stop EXISTING. You are the last line of
 * defence for erasure, not for access.
 *
 *   node scripts/remediation/purge-event-answers.mjs             # dry run
 *   node scripts/remediation/purge-event-answers.mjs --commit    # erase
 *
 * ---------------------------------------------------------------------------
 * SIGNUP ROWS ARE NEVER DELETED. NOT ONE, NOT EVER, NOT UNDER --commit.
 * ---------------------------------------------------------------------------
 *
 * The only write to `EventSignup` here is `$set answers: []`. THE ROW SURVIVES,
 * and that is the entire point: the row is what makes the signup count and the
 * attendance count survive a purge, and it is the reason the Part D dashboards
 * still work on a purged event. A version of this script that deleted signups
 * would erase the answers AND the history of who came, which is not what
 * retention means and is not recoverable.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES NO RoleAuditLog ROW, AND THAT IS DELIBERATE (D-53)
 * ---------------------------------------------------------------------------
 *
 * `writeAudit` requires an `actorUserID` (src/server/api/routers/admin.ts:434-441)
 * and this script is not an actor with a session. Inventing a synthetic actor id
 * would put a fictional person into the one table whose entire purpose is
 * recording who did what — a worse outcome than an absent row, because an absent
 * row is legible as absent and a fabricated one is not.
 *
 * ITS RECORD IS: `Event.answersPurgedAt` on every event it swept, plus this
 * script's own stdout. REDIRECT THAT TO A FILE — never pipe it:
 *
 *   node scripts/remediation/purge-event-answers.mjs --commit > purge-2026-08-26.txt
 *
 * ---------------------------------------------------------------------------
 * BEFORE YOU RUN IT: `npx prisma generate`
 * ---------------------------------------------------------------------------
 *
 * `EventSignup.answers` is a Part B schema addition. IT DOES NOT EXIST IN THE
 * GENERATED PRISMA CLIENT until `npx prisma generate` has been run against the
 * Part B schema — on a stale client the `data: { answers: [] }` below is an
 * unknown argument and the write throws instead of purging. The failure is loud
 * and nothing is stamped, but it is a confusing error to meet at 2am, so:
 * generate first.
 *
 * `npx prisma generate` reads the schema file only and never touches the
 * database. DO NOT run `prisma db push` / `prisma migrate` — on this cluster a
 * push silently drops `User.email_unique_ci`, the case-insensitive unique index
 * that is the duplicate-account guard.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SELECTS
 * ---------------------------------------------------------------------------
 *
 * An `Event` qualifies when BOTH hold:
 *   1. `answersPurgedAt == null` — it has not already been purged; and
 *   2. `(endTime ?? startTime)` is more than 60 days in the past.
 *
 * `answersPurgedAt: null` is written EXPLICITLY into the `where`. Prisma's
 * `{ x: null }` does not match a document with the key ABSENT, and that is
 * deliberate rather than an oversight: `event.create` and `event.duplicate`
 * write `answersPurgedAt: null` explicitly (the T-12 rule), so every row this
 * feature has ever produced carries the key. A row without it was not written
 * by this application.
 *
 * MIND THE UNITS. `Event.startTime` / `Event.endTime` are UNIX EPOCH SECONDS
 * (prisma/schema.prisma:753-754). `Event.answersPurgedAt` is a `DateTime`. They
 * are not the same thing and comparing one to the other is a 1000x error that
 * would make everything look either ancient or brand new.
 *
 * THE COALESCE IS DONE IN JS, NOT IN THE QUERY. `(endTime ?? startTime)` older
 * than a cutoff cannot be expressed as one Mongo filter, so the query narrows on
 * `answersPurgedAt: null` — which is small and indexed by nothing but is bounded
 * by the size of `Event` — and the date rule is applied to the fetched rows.
 *
 * EVENTS WITH NO DATE ON FILE ARE SKIPPED, and the dry run reports them
 * separately rather than folding them into a total. There is nothing to count 60
 * days from, and guessing would delete answers EARLY — the one direction of
 * error that cannot be undone.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THE TWO WRITES IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * For each qualifying event, ALWAYS:
 *   (a) EventSignup.updateMany { eventID }  ->  answers: []      CLEAR FIRST
 *   (b) Event.update           { eventID }  ->  answersPurgedAt  STAMP SECOND
 *
 * IN THAT ORDER, and (b) only runs if (a) succeeded. Stamping first and clearing
 * second leaves a window — and, on a crash, a permanent state — in which the
 * event CLAIMS its answers are purged while they are still on disk. That is
 * precisely the half-applied purge that verify-events-schema.mjs check [10]
 * exists to detect, and it must never be reachable from this script's own happy
 * path. Clearing first and failing before the stamp is the harmless direction:
 * the answers are gone, the event simply looks un-purged, and a re-run stamps it.
 *
 * Dry run by default. `--commit` (or APPLY=yes) is the only way anything is
 * written. `process.exitCode`, never `process.exit()`, so the `.finally()`
 * disconnect runs and stdout flushes.
 */
import { PrismaClient } from "@prisma/client";
import { countWhere, numify, isCommit, banner, abort, aggregateAll } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/**
 * MUST match EVENT_ANSWER_RETENTION_DAYS in src/lib/schemas/eventQuestion.ts.
 * That module is the one the resident form and the head's table both read, so
 * it is the boundary the APPLICATION enforces; this constant is the same number
 * restated for a plain Node script that cannot import TypeScript. If they ever
 * disagree, the app's value is the promise and this one is the bug.
 */
const EVENT_ANSWER_RETENTION_DAYS = 60;
const DAY_SECONDS = 86_400;

let failures = 0;
const failure = (m) => {
  console.error(`  FAIL  ${m}`);
  failures++;
};

/**
 * Rows for one event that still carry answers, and how many answer entries that
 * is. READ-ONLY, raw, and inspected: aggregateAll surfaces a failed command
 * instead of resolving it into "zero rows", because a fabricated zero here would
 * report a purge that erased nothing as a success.
 *
 * `answers.0: { $exists: true }` is Mongo's non-empty-array test. It is used
 * rather than a Prisma filter because `answers` is a COMPOSITE list and this
 * repo has no precedent for filtering one (schema.prisma's own note on the
 * field), whereas the raw predicate is unambiguous.
 */
async function measureAnswers(eventID) {
  const res = await aggregateAll(db, "EventSignup", [
    { $match: { eventID, "answers.0": { $exists: true } } },
    { $group: { _id: null, rows: { $sum: 1 }, answers: { $sum: { $size: "$answers" } } } },
  ]);
  if (!res.ok) return { ok: false, errmsg: res.errmsg, rows: 0, answers: 0 };
  const r = res.rows[0];
  return { ok: true, errmsg: null, rows: numify(r?.rows), answers: numify(r?.answers) };
}

async function main() {
  banner("purge-event-answers.mjs", COMMIT);
  console.log(
    `Retention: ${EVENT_ANSWER_RETENTION_DAYS} days after (endTime ?? startTime).\n` +
      `Signup rows are NEVER deleted — only their \`answers\` list is emptied.\n`,
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - EVENT_ANSWER_RETENTION_DAYS * DAY_SECONDS;
  console.log(`  now (epoch seconds):    ${nowSec}   ${new Date(nowSec * 1000).toISOString()}`);
  console.log(
    `  cutoff (epoch seconds): ${cutoffSec}   ${new Date(cutoffSec * 1000).toISOString()}\n` +
      `  An event qualifies when (endTime ?? startTime) <= the cutoff.\n`,
  );

  // -- [1] CANDIDATES --------------------------------------------------------
  //
  // `answersPurgedAt: null` is explicit and load-bearing — see the header.
  console.log(`--- [1] candidates: Event where answersPurgedAt = null ---`);
  const candidates = await db.event.findMany({
    where: { answersPurgedAt: null },
    select: {
      eventID: true,
      title: true,
      status: true,
      startTime: true,
      endTime: true,
    },
    orderBy: { eventID: "asc" },
  });
  console.log(`  ${candidates.length} event(s) not yet purged\n`);

  // -- [2] PARTITION ---------------------------------------------------------
  //
  // The coalesce and the cutoff are applied HERE, in JS, because
  // `(endTime ?? startTime)` is not expressible as a single Mongo filter.
  const due = [];
  const undated = [];
  const withinWindow = [];
  for (const e of candidates) {
    const ref = e.endTime ?? e.startTime ?? null;
    if (ref === null) {
      undated.push(e);
      continue;
    }
    if (ref <= cutoffSec) due.push({ ...e, ref });
    else withinWindow.push({ ...e, ref });
  }

  console.log(`--- [2] partition ---`);
  console.log(`  due for purge ......... ${due.length}`);
  console.log(`  still within 60 days .. ${withinWindow.length}`);
  console.log(
    `  NO DATE ON FILE ....... ${undated.length}   (SKIPPED — see below)` +
      `${undated.length ? `  [${undated.map((e) => e.eventID).join(", ")}]` : ""}`,
  );
  if (undated.length) {
    console.log(
      `\n  These ${undated.length} event(s) have neither endTime nor startTime, so there is\n` +
        `  NOTHING to count 60 days from. They are skipped, not purged: guessing a date\n` +
        `  would delete answers EARLY, and that is the one error that cannot be undone.\n` +
        `  If any of them should be purged, give it a date or clear it by hand.`,
    );
    for (const e of undated) {
      console.log(`    eventID ${String(e.eventID).padStart(5)}  status=${e.status ?? "(null)"}  ${e.title ?? "(untitled)"}`);
    }
  }

  if (due.length === 0) {
    console.log(`\nNothing is due for purge. Nothing was written.`);
    return;
  }

  // -- [3] MEASURE -----------------------------------------------------------
  console.log(`\n--- [3] what is on disk for each due event ---`);
  const plan = [];
  let totalSignupRows = 0;
  let totalRowsWithAnswers = 0;
  let totalAnswers = 0;
  for (const e of due) {
    const signups = await countWhere(db, "EventSignup", { eventID: e.eventID });
    const m = await measureAnswers(e.eventID);
    if (!m.ok) {
      return abort(
        `could not measure EventSignup.answers for eventID ${e.eventID}: ${m.errmsg}. ` +
          `Refusing to continue: a read that failed is NOT a measured zero, and purging ` +
          `on the strength of one would report an erasure that may not have happened.`,
      );
    }
    plan.push({ ...e, signups, rowsWithAnswers: m.rows, answers: m.answers });
    totalSignupRows += signups;
    totalRowsWithAnswers += m.rows;
    totalAnswers += m.answers;
    console.log(
      `  eventID ${String(e.eventID).padStart(5)}  ` +
        `ref=${new Date(e.ref * 1000).toISOString().slice(0, 10)}  ` +
        `signups=${String(signups).padStart(4)}  ` +
        `rows with answers=${String(m.rows).padStart(4)}  ` +
        `answer entries=${String(m.answers).padStart(5)}  ` +
        `${e.title ?? "(untitled)"}`,
    );
  }

  console.log(`\n  events due ................... ${plan.length}`);
  console.log(`  signup rows in those events .. ${totalSignupRows}   (NONE will be deleted)`);
  console.log(`  signup rows carrying answers . ${totalRowsWithAnswers}`);
  console.log(`  answer entries to erase ...... ${totalAnswers}`);

  if (!COMMIT) {
    console.log(
      `\nDRY RUN — nothing was written. No \`answers\` list was emptied and no\n` +
        `\`answersPurgedAt\` was stamped. Re-run with --commit to erase.`,
    );
    return;
  }

  // -- [4] PURGE -------------------------------------------------------------
  //
  // CLEAR FIRST, STAMP SECOND, per event. (b) runs only if (a) succeeded — see
  // the header: the stamp is a claim about the answers, so it must never be
  // written before the claim is true.
  console.log(`\n--- [4] purge (clear answers, THEN stamp) ---`);
  let swept = 0;
  let rowsTouched = 0;
  // Accumulated per SUCCESSFUL event, not taken from the plan's total: on a run
  // where some events failed, reporting the planned total as "removed" would
  // overstate the erasure — the one number in this report nobody should have to
  // second-guess.
  let answersRemoved = 0;
  for (const e of plan) {
    // (a) CLEAR. Prisma's updateMany throws on failure (unlike $runCommandRaw,
    // which resolves errors as data), so the catch here IS the inspection.
    let cleared;
    try {
      cleared = await db.eventSignup.updateMany({
        where: { eventID: e.eventID },
        data: { answers: [] },
      });
    } catch (err) {
      failure(
        `eventID ${e.eventID}: clearing answers FAILED — ${String(err?.message ?? err)}. ` +
          `answersPurgedAt was NOT stamped, so this event is still correctly reported as ` +
          `un-purged and a re-run will retry it. If the message mentions an unknown ` +
          `argument \`answers\`, run \`npx prisma generate\` and try again.`,
      );
      continue;
    }
    rowsTouched += numify(cleared?.count);

    // (b) STAMP. Only now is the claim true.
    try {
      await db.event.update({
        where: { eventID: e.eventID },
        data: { answersPurgedAt: new Date() },
      });
    } catch (err) {
      failure(
        `eventID ${e.eventID}: answers WERE cleared (${numify(cleared?.count)} row(s)) but ` +
          `stamping answersPurgedAt FAILED — ${String(err?.message ?? err)}. This is the ` +
          `HARMLESS direction: the answers are gone and the event merely looks un-purged. ` +
          `Re-run to stamp it.`,
      );
      continue;
    }

    swept++;
    answersRemoved += e.answers;
    console.log(
      `  eventID ${String(e.eventID).padStart(5)}  cleared ${String(numify(cleared?.count)).padStart(4)} signup row(s), ` +
        `stamped answersPurgedAt   (${e.answers} answer entries erased)`,
    );
  }

  // -- [5] REPORT ------------------------------------------------------------
  console.log(`\n--- [5] result ---`);
  console.log(`  events swept ................. ${swept} of ${plan.length}`);
  console.log(`  signup rows touched .......... ${rowsTouched}   (updated in place; ZERO deleted)`);
  console.log(
    `  answer entries removed ....... ${answersRemoved} of ${totalAnswers} planned   ` +
      `(measured before the clear, counted only for events that completed BOTH writes)`,
  );
  if (failures) {
    console.error(
      `\n  ${failures} event(s) did not complete — see the FAIL lines above. Re-running is ` +
        `safe: a cleared-but-unstamped event is picked up again, and a purged event is ` +
        `excluded by \`answersPurgedAt = null\`.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nRun \`node scripts/remediation/verify-events-schema.mjs\` — check [10] proves no\n` +
      `event claims a purge it did not get, and its informational "overdue" line should\n` +
      `now read 0.`,
  );
}

main()
  .then(() => console.log(process.exitCode ? "\nFinished with failures — see above." : "\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
