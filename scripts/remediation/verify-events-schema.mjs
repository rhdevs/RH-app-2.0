/**
 * Events registration rework — schema/data invariant check. READ-ONLY.
 *
 *   node scripts/remediation/verify-events-schema.mjs
 *   node scripts/remediation/verify-events-schema.mjs > events-before.txt
 *
 * THIS SCRIPT PERFORMS NO WRITES AND NO REPAIRS. It issues `listIndexes`,
 * `aggregate` ($match/$count, $group) and `find` — reads only. It must NEVER
 * call createIndexes, dropIndex, createCollection, any update/insert/delete, or
 * `prisma db push`. There is no `--commit` flag; `isCommit()` is consulted ONLY
 * to REFUSE, the same discipline as verify-recruitment-gate.mjs and
 * verify-user-admin-safety.mjs.
 *
 * WHY IT ASSERTS RATHER THAN FIXES. A verification script that silently repairs
 * what it measures is not a verification script, it is an undocumented
 * migration — and the next operator will trust a PASS that the script's own
 * side effects produced. When an index this file requires is missing it says
 * WHICH ONE and exits 1; a human then runs the restore one-liner from
 * docs/plans/events/01-registration-rework.md Appendix A.3 deliberately.
 *
 * THERE IS NO `prisma db push` IN THIS CHANGE (ruling C-1 of the plan). The
 * registration rework drops a field, relaxes a field to nullable and adds four
 * nullable/defaulted fields — none of which is DDL on Mongo — and adds NO
 * index. `prisma generate` is the whole database step. A push on this cluster
 * drops User.email_unique_ci (see index-census.mjs's header and the
 * `email_unique_ci` block above `model User` in prisma/schema.prisma), which is
 * why check [2] below watches an index that has nothing to do with events.
 *
 * WHAT IT CANNOT CHECK, said plainly so nobody reads a PASS as more than it is.
 * This is a plain Mongo script, not a Next request, so it cannot call tRPC and
 * therefore cannot exercise loadOwnedEvent, editScope, the status machine or
 * assertEventsEnabled. It checks the DATA and the INDEXES those depend on. A
 * PASS means the substrate is sound; it says nothing about whether the router's
 * transitions are correct. That is the manual test plan's job (§11 of the plan).
 *
 * WHAT EACH CHECK IS FOR:
 *   [1] the unique indexes the locks + idempotency rest on
 *                                   EventLock.key and BookingLock.key are what
 *                                   make withEventLock/withFacilityLock LOCKS
 *                                   rather than suggestions; Event.eventID,
 *                                   Bookings.bookingID and Counter.key are what
 *                                   make nextEventId/nextBookingId idempotent;
 *                                   EventSignup.event_user is the double-submit
 *                                   backstop the P2002 branch relies on.
 *                                   MATCHED ON KEY PATTERN, NOT NAME — see the
 *                                   comment on hasUniqueOn().
 *   [2] User.email_unique_ci        not this feature's index. It is the one a
 *                                   `db push` drops, and this script may be the
 *                                   only thing an operator runs. The COLLATION
 *                                   is asserted too: a unique index on `email`
 *                                   without locale en / strength 2 does not
 *                                   fold case and is not the guard.
 *   [3] Bookings has no null ccaID  the D-8 invariant, made measurable. A hall
 *                                   event's auto-booking writes ccaID 0 — the
 *                                   RESERVED "no CCA" sentinel that 3,839 rows
 *                                   already carry, that BookingModal.tsx writes
 *                                   and that cascade.ts guards. A null here
 *                                   means someone introduced a SECOND value
 *                                   meaning "absent" into the largest
 *                                   collection in the database.
 *   [4] no Event carries proposalUrl  the column is dropped; a surviving value
 *                                   means a stale client is still writing it.
 *   [5] status vocabulary           a value outside the six is a row
 *                                   normalizeStatus reads silently as "draft" —
 *                                   an approved event displayed to its head as
 *                                   never submitted, with an editable form.
 *   [6] counts (informational)      the pre-flight numbers §9.1 of the plan
 *                                   reads, plus the feature's post-rollout
 *                                   heartbeat.
 *   [7] Counter sanity              a Counter.seq behind max(Event.eventID)
 *                                   means the next nextEventId() collides on
 *                                   the eventID unique index.
 *   [8] EventQuestion.event_question  the compound unique index on
 *                                   {eventID:1, questionID:1}. The question
 *                                   save path's lock is advisory and
 *                                   reclaimable after 30s, so without this index
 *                                   a stale-lock reclaim mid-save writes TWO
 *                                   questions carrying the same questionID and
 *                                   every answer to either one is ambiguous —
 *                                   with no error anywhere. BLOCKING,
 *                                   UNCONDITIONALLY, because PART B HAS NO
 *                                   FEATURE FLAG: there is no set-*-flag.mjs
 *                                   refusing to switch on without the index, so
 *                                   this check is the ONLY gate.
 *                                   MATCHED ON KEY PATTERN, NOT NAME.
 *   [9] EventAttendance.event_attendee  the same, on {eventID:1, userID:1}. It
 *                                   is what makes a re-scan idempotent (P2002 ->
 *                                   alreadyCheckedIn); without it a double scan
 *                                   writes a second row and the turnout number
 *                                   is silently wrong. INFORMATIONAL while the
 *                                   collection does not exist — the correct
 *                                   state before PR 3, since PR 2 must NOT
 *                                   create it — and BLOCKING the moment it does.
 *                                   Part C also gates its flag on this index
 *                                   (set-attendance-flag.mjs), so here it is a
 *                                   second line of defence rather than the only
 *                                   one, which is why it may key off presence.
 *   [10] no half-applied purge      no Event may carry answersPurgedAt while any
 *                                   of its EventSignup rows still holds a
 *                                   non-empty `answers` list. That is the state
 *                                   in which the retention promise is a LIE ON
 *                                   DISK while looking kept. It is unreachable
 *                                   from purge-event-answers.mjs's happy path
 *                                   only because that script CLEARS before it
 *                                   STAMPS; this check is what proves nothing
 *                                   else got there another way. BLOCKING.
 *   [11] phase-2 counts (informational)  question totals, the type vocabulary,
 *                                   attendance split by method, and how OVERDUE
 *                                   the answer purge is. Never affects the exit
 *                                   code.
 *
 * EXIT CODES. The distinction that matters is 1 vs 2: a 1 means the checks RAN
 * and something is wrong with the data; a 2 means nothing was measured at all,
 * so it is NOT evidence the schema is healthy.
 *   0  every blocking check passed. [6] and [11] are informational and never
 *      affect it, and neither does [9] while EventAttendance does not exist.
 *   1  a blocking check failed ([1]-[5], [7], [8], [10] — and [9] once the
 *      EventAttendance collection exists).
 *   2  nothing was measured: could not connect, an unexpected throw before any
 *      blocking failure was recorded, or the script was invoked with --commit /
 *      APPLY=yes. That refusal deliberately does NOT exit 1 — a misuse of the
 *      CLI must not be indistinguishable from a real invariant failure.
 *
 * `process.exitCode`, never `process.exit()`: setting it lets the process end
 * naturally, which runs the `.finally()` and flushes buffered stdout — including
 * the PASS/FAIL banner, which is the single line anyone actually reads.
 */
import { PrismaClient } from "@prisma/client";
import { countWhere, numify, isCommit, abort, aggregateAll, findAll } from "./lib/rbac.mjs";

/**
 * `--pre-rollout` — "I am running the §12.1 pre-flight, BEFORE the index step."
 * It downgrades check [8]'s absent-collection FAIL to INFO and nothing else. It
 * cannot turn a wrong index, an unreadable cluster, or any other failure into a
 * pass, and it is deliberately opt-IN so the default still fails loudly for an
 * operator who deployed Part B and skipped `create-event-phase2-indexes.mjs`.
 */
const PRE_ROLLOUT = process.argv.slice(2).includes("--pre-rollout");

const db = new PrismaClient();

let failed = 0;
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};

/** Mongo's "namespace does not exist". */
const NS_NOT_FOUND = 26;

/** The six status strings the rework's vocabulary allows. `canceled`, one l. */
const EVENT_STATUSES = [
  "draft",
  "submitted",
  "published",
  "changes_requested",
  "declined",
  "canceled",
];

/**
 * MUST match EVENT_QUESTION_TYPES in src/lib/schemas/eventQuestion.ts, which is
 * the vocabulary the ROUTER enforces. Restated here because a plain Node script
 * cannot import TypeScript. If the two ever disagree, the app's tuple is the
 * truth and this list is the bug — which is why the check that uses it is
 * INFORMATIONAL and never fails the run.
 */
const EVENT_QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multi_choice",
  "checkbox",
  "number",
  "date",
];

/** MUST match EVENT_ANSWER_RETENTION_DAYS in src/lib/schemas/eventQuestion.ts. */
const EVENT_ANSWER_RETENTION_DAYS = 60;
const DAY_SECONDS = 86_400;

/**
 * `listIndexes`, tolerant of BOTH failure shapes — same reasoning as
 * index-census.mjs: $runCommandRaw can report a rejected command as DATA
 * (`{ ok: 0, code, errmsg }`) OR as a throw, and a reader that only catches (or
 * only inspects) mistakes one for success. For an assertion script "success
 * with no indexes" would read as a collection stripped bare, which is exactly
 * the alarm this file exists to raise honestly.
 *
 * Returns { state: "ok" | "absent" | "error", indexes, detail }.
 */
async function listIndexes(coll) {
  let reply;
  try {
    reply = await db.$runCommandRaw({ listIndexes: coll });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/ns does not exist|NamespaceNotFound|Collection.*not found/i.test(msg)) {
      return { state: "absent", indexes: [], detail: msg };
    }
    return { state: "error", indexes: [], detail: `threw: ${msg}` };
  }
  if (numify(reply?.ok) !== 1) {
    const code = numify(reply?.code);
    if (code === NS_NOT_FOUND) {
      return { state: "absent", indexes: [], detail: String(reply?.errmsg ?? "") };
    }
    return {
      state: "error",
      indexes: [],
      detail: `ok=${JSON.stringify(reply?.ok)} code=${code} errmsg=${String(reply?.errmsg ?? "(none)")}`,
    };
  }
  return { state: "ok", indexes: reply?.cursor?.firstBatch ?? [], detail: "" };
}

/**
 * Does `indexes` contain a UNIQUE index whose key is exactly `fields`, in that
 * order?
 *
 * MATCHED ON THE KEY PATTERN, NEVER ON THE NAME. `prisma db push` and a
 * hand-run `createIndexes` produce DIFFERENT names for the same index
 * (`EventLock_key_key` vs `key_1`), so a name match would report a false
 * failure on an index that is present and working — the worst outcome for a
 * script whose FAIL is meant to stop a rollout.
 *
 * Field ORDER is significant: for a compound index the order IS the index's
 * meaning, so this compares the key document's own sequence rather than a set.
 */
function hasUniqueOn(indexes, fields) {
  return indexes.some((ix) => {
    if (ix.unique !== true) return false;
    const keys = Object.keys(ix.key ?? {});
    return (
      keys.length === fields.length && keys.every((k, i) => k === fields[i])
    );
  });
}

/** Render one index the way index-census.mjs does, for a legible failure. */
function renderIndex(ix) {
  const opts = [];
  if (ix.unique === true) opts.push("unique=true");
  if (ix.collation) {
    opts.push(
      `collation=locale:${ix.collation.locale} strength:${numify(ix.collation.strength)}`,
    );
  }
  return `${ix.name} ${JSON.stringify(ix.key)}${opts.length ? "  " + opts.join(" ") : ""}`;
}

async function main() {
  console.log(
    `\n=== verify-events-schema.mjs (READ-ONLY) ===  ${new Date().toISOString()}\n`,
  );

  if (isCommit()) {
    // abort() sets exitCode 1, this script's "an invariant is broken" signal.
    // Refusing a CLI misuse is a different fact and must not be reported as a
    // data problem, so the code is corrected to 2 (see the exit table above).
    abort(
      "verify-events-schema.mjs is READ-ONLY and has no write path. Drop --commit / APPLY=yes.",
    );
    process.exitCode = 2;
    return;
  }

  /* [1] THE UNIQUE INDEXES THE LOCKS AND IDEMPOTENCY REST ON ---------------- */
  console.log(`[1] unique indexes the locks + idempotency rest on (blocking)`);
  const REQUIRED = [
    ["Event", ["eventID"], "nextEventId idempotency"],
    ["EventSignup", ["eventID", "userID"], "the double-submit backstop (P2002)"],
    ["EventLock", ["key"], "THIS is what makes withEventLock a lock"],
    ["Counter", ["key"], "nextEventId / nextBookingId"],
    ["Bookings", ["bookingID"], "nextBookingId idempotency"],
    ["BookingLock", ["key"], "THIS is what makes withFacilityLock a lock"],
  ];
  for (const [coll, fields, why] of REQUIRED) {
    const res = await listIndexes(coll);
    const label = `${coll}.{${fields.join(",")}}`;
    if (res.state !== "ok") {
      fail(
        `${label} — could not read indexes on ${coll} (${res.state}): ${res.detail}. ` +
          `Cannot prove the index exists, so this is a FAIL, not a pass.`,
      );
      continue;
    }
    if (hasUniqueOn(res.indexes, fields)) {
      const match = res.indexes.find(
        (ix) =>
          ix.unique === true &&
          Object.keys(ix.key ?? {}).join(",") === fields.join(","),
      );
      console.log(`  OK    ${label}  ->  ${renderIndex(match)}`);
    } else {
      fail(
        `${label} has NO unique index (${why}). Present on ${coll}: ` +
          `${res.indexes.map((ix) => renderIndex(ix)).join(" | ") || "(none)"}. ` +
          `Restore it deliberately — see Appendix A of ` +
          `docs/plans/events/01-registration-rework.md. This script will not do it for you.`,
      );
    }
  }

  /* [2] THE GUARD INDEX ----------------------------------------------------- */
  // Not this feature's index. It is the one `prisma db push` drops, and the
  // whole reason ruling C-1 forbids a push in this change.
  console.log(`\n[2] User.email_unique_ci — the duplicate-account guard (blocking)`);
  const userIx = await listIndexes("User");
  if (userIx.state !== "ok") {
    fail(`could not read indexes on User (${userIx.state}): ${userIx.detail}`);
  } else {
    const guard = userIx.indexes.find(
      (ix) => Object.keys(ix.key ?? {}).join(",") === "email" && ix.unique === true,
    );
    if (!guard) {
      fail(
        `User has NO unique index on { email: 1 }. This is THE duplicate-account guard. ` +
          `STOP EVERYTHING ELSE and restore it before this cluster takes another write:\n` +
          `        db.runCommand({ createIndexes: "User", indexes: [{ key: { email: 1 }, ` +
          `name: "email_unique_ci", unique: true, collation: { locale: "en", strength: 2 } }] })`,
      );
    } else {
      const locale = guard.collation?.locale ?? "(none)";
      const strength = guard.collation ? numify(guard.collation.strength) : null;
      console.log(`  found: ${renderIndex(guard)}`);
      if (locale !== "en" || strength !== 2) {
        fail(
          `the unique index on User.email carries collation locale=${locale} strength=${strength} — ` +
            `expected locale "en", strength 2. WITHOUT THAT COLLATION IT DOES NOT FOLD CASE, so ` +
            `"a@u.nus.edu" and "A@u.nus.edu" remain two accounts for one human. A unique index on ` +
            `email is not the same thing as the guard.`,
        );
      } else {
        console.log(`  OK    collation locale "en", strength 2 — case-folding is in force.`);
      }
    }
  }

  /* [3] Bookings.ccaID HAS NO NULL ------------------------------------------ */
  // D-8 made measurable. Event.ccaID is null for a hall-wide event;
  // Bookings.ccaID is 0. Two collections, two spellings, and that is CORRECT —
  // they are different namespaces with different constraints. What is not
  // correct is a null in Bookings: it would be a SECOND value meaning "absent"
  // in a collection that already has one, guarded at cascade.ts:47 and written
  // at BookingModal.tsx:115.
  console.log(`\n[3] Bookings.ccaID has no null — the reserved-sentinel invariant (blocking)`);
  const bookingsNull = await countWhere(db, "Bookings", { ccaID: null });
  const bookingsZero = await countWhere(db, "Bookings", { ccaID: 0 });
  const bookingsTotal = await countWhere(db, "Bookings", {});
  console.log(`  Bookings total:         ${bookingsTotal}`);
  console.log(`  Bookings ccaID = 0:     ${bookingsZero}   (the reserved "no CCA" sentinel)`);
  console.log(`  Bookings ccaID = null:  ${bookingsNull}   (must be 0)`);
  if (bookingsNull > 0) {
    fail(
      `${bookingsNull} Bookings row(s) carry ccaID null. Bookings.ccaID is a REQUIRED Int and 0 is ` +
        `the reserved "no CCA" value. A hall event's auto-booking must write ccaID 0 ` +
        `(event.decide: \`ccaID: event.ccaID ?? 0\`), never null and never \`!\`. ` +
        `cascade.ts guards only 0, so a null-ccaID booking is also outside the RESERVED_CCAID guard.`,
    );
  }

  /* [4] NO Event CARRIES proposalUrl ---------------------------------------- */
  console.log(`\n[4] no Event carries the dropped proposalUrl field (blocking)`);
  const withProposal = await countWhere(db, "Event", {
    proposalUrl: { $exists: true },
  });
  console.log(`  Event with proposalUrl present: ${withProposal}   (must be 0)`);
  if (withProposal > 0) {
    fail(
      `${withProposal} Event row(s) still carry a \`proposalUrl\` key. The column was dropped from ` +
        `the schema, so something is writing a field no reader knows about — most likely a stale ` +
        `deployment. Check which Vercel deployment is live before clearing anything.`,
    );
  }

  /* [5] STATUS VOCABULARY ---------------------------------------------------- */
  // A surviving "approved" or "rejected" is the dangerous case: normalizeStatus
  // maps anything unrecognised to "draft", so such a row reads to its head as
  // "Not submitted" with an editable form.
  console.log(`\n[5] Event.status vocabulary (blocking)`);
  const distinctReply = await db.$runCommandRaw({
    distinct: "Event",
    key: "status",
    query: {},
  });
  const distinct = distinctReply?.values ?? [];
  const rendered = distinct.map((v) => (v === null ? "null" : JSON.stringify(v)));
  console.log(`  distinct statuses: ${rendered.join(", ") || "(none — collection empty)"}`);
  const strays = distinct.filter(
    (v) => v !== null && !EVENT_STATUSES.includes(v),
  );
  if (strays.length > 0) {
    fail(
      `Event.status holds ${strays.map((v) => JSON.stringify(v)).join(", ")}, outside the vocabulary ` +
        `{${EVENT_STATUSES.join(", ")}} (null is allowed — normalizeStatus floors it to "draft"). ` +
        `Every such row is read SILENTLY as "draft": an event the JCRC approved would be shown to its ` +
        `head as never submitted, with an editable form and a Submit button.`,
    );
  }

  /* [6] COUNTS — INFORMATIONAL ---------------------------------------------- */
  // The pre-flight numbers §9.1 of the plan reads (three of its decisions are
  // only valid while Event is empty), plus the feature's heartbeat afterwards.
  console.log(`\n[6] counts (informational — never affects the exit code)`);
  const eventTotal = await countWhere(db, "Event", {});
  const eventHall = await countWhere(db, "Event", { ccaID: null });
  const signupTotal = await countWhere(db, "EventSignup", {});
  const lockTotal = await countWhere(db, "EventLock", {});
  console.log(`  Event (total):                  ${eventTotal}`);
  console.log(
    `  Event where ccaID = null:       ${eventHall}   (hall-wide, JCRC-owned — the number a rollback needs)`,
  );
  console.log(`  EventSignup (total):            ${signupTotal}`);
  console.log(
    `  EventLock (total):              ${lockTotal}   (0 at rest; a standing non-zero is a leaked lock)`,
  );

  // RETIRED actions: both must be 0 before D-22 deletes them from AUDIT_ACTIONS,
  // else an existing row becomes unfilterable in admin.listAuditLog.
  for (const action of ["event.reject", "event.publish"]) {
    const n = await countWhere(db, "RoleAuditLog", { action });
    console.log(
      `  RoleAuditLog ${action.padEnd(24)} ${n}   (RETIRED — must be 0 before it is removed)`,
    );
  }
  // The new vocabulary. After rollout these are the feature's heartbeat, and a
  // hall-event self-approval shows as an event.submit + event.approve pair with
  // ONE actor, seconds apart (D-22). That pairing is the audit record of a
  // self-approval; it is meant to be legible, not collapsed.
  for (const action of [
    "event.submit",
    "event.withdraw",
    "event.approve",
    "event.changes",
    "event.decline",
    "event.cancel",
    "event.duplicate",
    "event.attendees.export",
  ]) {
    const n = await countWhere(db, "RoleAuditLog", { action });
    console.log(`  RoleAuditLog ${action.padEnd(24)} ${n}`);
  }

  /* [7] COUNTER SANITY ------------------------------------------------------- */
  console.log(`\n[7] Counter "eventID".seq >= max(Event.eventID) (blocking)`);
  const counterReply = await db.$runCommandRaw({
    find: "Counter",
    filter: { key: "eventID" },
    projection: { key: 1, seq: 1 },
    limit: 1,
  });
  const counterRow = counterReply?.cursor?.firstBatch?.[0] ?? null;
  const maxReply = await db.$runCommandRaw({
    find: "Event",
    filter: {},
    projection: { eventID: 1 },
    sort: { eventID: -1 },
    limit: 1,
  });
  const maxEventID = numify(maxReply?.cursor?.firstBatch?.[0]?.eventID);
  if (!counterRow) {
    // Not a failure: nextEventId() creates the row on first use, seeding it from
    // max(Event.eventID). Absence before the first event is the normal state.
    console.log(
      `  no Counter row for key "eventID" — normal before the first event. ` +
        `nextEventId() creates it, seeded from max(Event.eventID) = ${maxEventID}.`,
    );
  } else {
    const seq = numify(counterRow.seq);
    console.log(`  Counter.seq: ${seq}    max(Event.eventID): ${maxEventID}`);
    if (seq < maxEventID) {
      fail(
        `Counter "eventID".seq (${seq}) is BEHIND max(Event.eventID) (${maxEventID}). ` +
          `The next nextEventId() will hand out an id that already exists and the create will ` +
          `collide on the Event.eventID unique index. Advance the counter deliberately.`,
      );
    }
  }

  /* [8] EventQuestion.event_question ---------------------------------------- */
  // BLOCKING, unconditionally. Part B ships no feature flag, so nothing else
  // refuses to run without this index — unlike Part C, where
  // set-attendance-flag.mjs will not turn on until [9]'s index exists. If this
  // line fails, the questions feature is live with an advisory lock and no
  // database constraint behind it.
  console.log(`\n[8] EventQuestion.event_question — {eventID:1, questionID:1} unique (blocking)`);
  const questionIx = await listIndexes("EventQuestion");
  const FIX_8 =
    `node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit ` +
    `(dry run first, and take an index-census.mjs before/after)`;
  if (questionIx.state === "error") {
    fail(
      `could not read indexes on EventQuestion: ${questionIx.detail}. Cannot prove the ` +
        `index exists, so this is a FAIL, not a pass.`,
    );
  } else if (questionIx.state === "absent" && PRE_ROLLOUT) {
    // EXPLICIT OPT-OUT, NOT A CHANGED DEFAULT.
    //
    // Absence is blocking by default and must stay that way: Part B ships no
    // feature flag, so an operator who deploys and forgets the index step gets
    // a live question editor with no unique index behind it. Failing loudly is
    // the whole point of this check.
    //
    // But §9.1 of the plan lists `EventQuestion (absent)` as the CORRECT
    // pre-rollout state, while §12.1 runs this script as a pre-flight and
    // requires exit 0 — so with no way to say "I am at that moment", the
    // pre-flight could never pass, and its only printed remedy was to create
    // the index a PR early, which empties PR 2's census diff and defeats §9.2.
    // `--pre-rollout` is how the operator states which moment they are at,
    // rather than the script guessing.
    console.log(
      `  INFO  EventQuestion does not exist, and --pre-rollout was passed, so this is\n` +
        `        the EXPECTED pre-rollout state (plan §9.1). Re-run WITHOUT --pre-rollout\n` +
        `        after ${FIX_8}\n` +
        `        — without that index nothing stops the editor writing two questions with\n` +
        `        the same questionID after a stale-lock reclaim.`,
    );
  } else if (questionIx.state === "absent") {
    fail(
      `the EventQuestion collection does not exist, so neither does its unique index. ` +
        `Part B has NO feature flag: nothing else stops the question editor from saving ` +
        `two questions with the same questionID after a stale-lock reclaim, and every ` +
        `answer to either one is then ambiguous with no error anywhere. Create it: ${FIX_8}. ` +
        `If you are running the §12.1 pre-flight BEFORE the index step, pass --pre-rollout.`,
    );
  } else if (hasUniqueOn(questionIx.indexes, ["eventID", "questionID"])) {
    const match = questionIx.indexes.find(
      (ix) => ix.unique === true && Object.keys(ix.key ?? {}).join(",") === "eventID,questionID",
    );
    console.log(`  OK    EventQuestion.{eventID,questionID}  ->  ${renderIndex(match)}`);
  } else {
    fail(
      `EventQuestion has NO unique index on {eventID:1, questionID:1}. Present on ` +
        `EventQuestion: ${questionIx.indexes.map((ix) => renderIndex(ix)).join(" | ") || "(none)"}. ` +
        `Matched on the KEY PATTERN, not the name — an index under a different name but the ` +
        `same key and unique:true would have passed. Create it: ${FIX_8}`,
    );
  }

  /* [9] EventAttendance.event_attendee --------------------------------------- */
  // INFORMATIONAL until the collection exists, BLOCKING once it does. The
  // collection being absent is the CORRECT state after PR 2 and before PR 3, so
  // an operator running this straight after Part B must not read this line as
  // Part B being broken.
  console.log(
    `\n[9] EventAttendance.event_attendee — {eventID:1, userID:1} unique ` +
      `(INFORMATIONAL until the collection exists; BLOCKING thereafter)`,
  );
  const attendanceIx = await listIndexes("EventAttendance");
  if (attendanceIx.state === "error") {
    fail(
      `could not read indexes on EventAttendance: ${attendanceIx.detail}. The collection ` +
        `could not be shown to be absent either, so this is a FAIL rather than an absence.`,
    );
  } else if (attendanceIx.state === "absent") {
    console.log(
      `  INFO  EventAttendance does not exist. That is the EXPECTED state until PR 3\n` +
        `        (Part C) ships. PART B IS NOT BROKEN BY THIS LINE, and this is not a\n` +
        `        reason to run \`create-event-phase2-indexes.mjs EventAttendance\` now:\n` +
        `        PR 2's census diff is supposed to show only the EventQuestion lines, and\n` +
        `        creating the collection early makes PR 3's own diff empty. This check\n` +
        `        becomes blocking automatically once the collection is there.`,
    );
  } else if (hasUniqueOn(attendanceIx.indexes, ["eventID", "userID"])) {
    const match = attendanceIx.indexes.find(
      (ix) => ix.unique === true && Object.keys(ix.key ?? {}).join(",") === "eventID,userID",
    );
    console.log(`  OK    EventAttendance.{eventID,userID}  ->  ${renderIndex(match)}`);
  } else {
    fail(
      `EventAttendance EXISTS but has NO unique index on {eventID:1, userID:1} — so this ` +
        `check is blocking now. Present on EventAttendance: ` +
        `${attendanceIx.indexes.map((ix) => renderIndex(ix)).join(" | ") || "(none)"}. ` +
        `Without it a re-scan writes a SECOND row instead of raising P2002, the count and ` +
        `the turnout percentage are wrong, and undoCheckIn deletes one of two. Create it: ` +
        `node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit`,
    );
  }

  /* [10] NO HALF-APPLIED PURGE ---------------------------------------------- */
  // The state purge-event-answers.mjs is written to make unreachable: it clears
  // the answers BEFORE it stamps answersPurgedAt, so a crash leaves an event
  // that looks un-purged (harmless) rather than one that claims a purge it did
  // not get (a lie on disk that looks kept). Anything found here arrived by
  // another route.
  console.log(`\n[10] no Event claims a purge its signups did not get (blocking)`);
  const purgedReply = await db.$runCommandRaw({
    distinct: "Event",
    key: "eventID",
    query: { answersPurgedAt: { $ne: null } },
  });
  if (numify(purgedReply?.ok) !== 1) {
    fail(
      `could not list purged events: ok=${JSON.stringify(purgedReply?.ok)} ` +
        `errmsg=${String(purgedReply?.errmsg ?? "(none)")}. A read that failed is NOT a ` +
        `measured zero.`,
    );
  } else {
    const purgedIDs = (purgedReply?.values ?? []).map((v) => numify(v));
    console.log(`  Event with answersPurgedAt set: ${purgedIDs.length}`);
    if (purgedIDs.length === 0) {
      console.log(`  OK    nothing has been purged yet, so nothing can be half-purged.`);
    } else {
      // `answers.0: { $exists: true }` is Mongo's non-empty-array test, used
      // rather than a Prisma filter because `answers` is a COMPOSITE list.
      //
      // aggregateAll, NOT countWhere — AND THAT IS THE WHOLE POINT OF THIS
      // BLOCK. `countWhere` (lib/rbac.mjs) returns
      // `numify(r?.cursor?.firstBatch?.[0]?.n)` and NEVER inspects `ok`, so an
      // `{ ok: 0 }` reply — a permissions error, a dropped connection, a
      // renamed collection — comes back as the number 0. This check's verdict
      // hinges on exactly that number: 0 prints "(must be 0)" and PASSES. A
      // failed read would therefore have certified "no half-applied purge" on
      // a cluster nobody successfully read, which is the precise false
      // all-clear the `ok` inspection eleven lines above exists to prevent.
      // rbac.mjs's own header on aggregateAll names this trap ("Unlike
      // countWhere() this also surfaces command failure"), and both sibling
      // scripts already avoid it — purge-event-answers.mjs refuses to purge on
      // an unreadable measurement, create-event-phase2-indexes.mjs refuses to
      // index on one. This check is the last one that did not.
      const strandedRes = await aggregateAll(db, "EventSignup", [
        { $match: { eventID: { $in: purgedIDs }, "answers.0": { $exists: true } } },
        { $count: "n" },
      ]);
      // NO EARLY `return` ON FAILURE — `fail()` records and execution
      // continues, exactly as every other check in this file does, so [11]
      // still runs and the summary banner at the end still prints. Returning
      // from main() here would suppress both.
      if (!strandedRes.ok) {
        fail(
          `could not count EventSignup rows still holding answers on purged events: ` +
            `${strandedRes.errmsg}. A read that failed is NOT a measured zero, and ` +
            `passing this check on one would report a retention guarantee nobody verified.`,
        );
      } else {
        // $count emits NO row when nothing matches, so an absent `n` is a real 0.
        const stranded = numify(strandedRes.rows[0]?.n);
        console.log(`  EventSignup rows that still hold answers on those events: ${stranded}   (must be 0)`);
        if (stranded > 0) {
          const which = await aggregateAll(db, "EventSignup", [
            { $match: { eventID: { $in: purgedIDs }, "answers.0": { $exists: true } } },
            { $group: { _id: "$eventID", rows: { $sum: 1 } } },
            { $sort: { rows: -1 } },
            { $limit: 20 },
          ]);
          const detail = which.ok
            ? which.rows.map((r) => `eventID ${numify(r?._id)} x${numify(r?.rows)}`).join(", ")
            : `(could not break it down: ${which.errmsg})`;
          fail(
            `${stranded} EventSignup row(s) still carry answers on events whose ` +
              `answersPurgedAt is SET: ${detail}. The retention promise is a lie on disk for ` +
              `those events — they report themselves purged and the answers are still there. ` +
              `Re-running purge-event-answers.mjs --commit clears them (it clears before it ` +
              `stamps, so it is safe to repeat), but find out what stamped them first: no ` +
              `path in this repository writes answersPurgedAt except that script.`,
          );
        }
      }
    }
  }

  /* [11] PHASE-2 COUNTS — INFORMATIONAL -------------------------------------- */
  // Four lines, none of which can fail the run. Each says what it can and
  // cannot tell you, because an informational line read as a guarantee is worse
  // than no line at all.
  console.log(`\n[11] questions / attendance / retention (informational — never affects the exit code)`);

  // (i) EventQuestion total. Says how much of the feature is in use. It CANNOT
  // tell you whether those questions are attached to live events, or whether any
  // resident has answered them.
  if (questionIx.state === "ok") {
    const questionTotal = await countWhere(db, "EventQuestion", {});
    const eventsWithQuestions = await aggregateAll(db, "EventQuestion", [
      { $group: { _id: "$eventID" } },
      { $count: "n" },
    ]);
    const distinctEvents = eventsWithQuestions.ok
      ? numify(eventsWithQuestions.rows?.[0]?.n)
      : "(unreadable)";
    console.log(
      `  EventQuestion (total):          ${questionTotal}   across ${distinctEvents} event(s). ` +
        `Says nothing about whether anyone ANSWERED them.`,
    );
  } else {
    console.log(
      `  EventQuestion (total):          (collection ${questionIx.state}) — no rows to count.`,
    );
  }

  // (ii) The type vocabulary. INFORMATIONAL and not blocking on purpose: the
  // list above is a hand copy of a TypeScript tuple this script cannot import,
  // so a mismatch is at least as likely to mean the copy went stale as it is to
  // mean a bad row. The ROUTER is what enforces the vocabulary; this only shows
  // you what is on disk.
  if (questionIx.state === "ok") {
    const typeReply = await db.$runCommandRaw({ distinct: "EventQuestion", key: "type", query: {} });
    if (numify(typeReply?.ok) !== 1) {
      console.log(
        `  EventQuestion.type vocabulary:  (unreadable: ${String(typeReply?.errmsg ?? "(none)")})`,
      );
    } else {
      const types = typeReply?.values ?? [];
      const strays = types.filter((v) => v !== null && !EVENT_QUESTION_TYPES.includes(v));
      console.log(
        `  EventQuestion.type values:      ${types.map((v) => (v === null ? "null" : JSON.stringify(v))).join(", ") || "(none)"}`,
      );
      console.log(
        `                                  expected ⊆ {${EVENT_QUESTION_TYPES.join(", ")}}` +
          `${strays.length ? `   *** OUTSIDE: ${strays.map((v) => JSON.stringify(v)).join(", ")} — check src/lib/schemas/eventQuestion.ts before treating this as a data problem` : `   (all inside)`}`,
      );
    }
  } else {
    console.log(`  EventQuestion.type values:      (collection ${questionIx.state})`);
  }

  // (iii) Attendance by method. The Part C heartbeat. It CANNOT tell you whether
  // a check-in was legitimate, only how each one was recorded.
  if (attendanceIx.state === "ok") {
    const byMethod = await aggregateAll(db, "EventAttendance", [
      { $group: { _id: "$method", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    if (!byMethod.ok) {
      console.log(`  EventAttendance by method:      (unreadable: ${byMethod.errmsg})`);
    } else {
      const total = byMethod.rows.reduce((a, r) => a + numify(r?.n), 0);
      const split =
        byMethod.rows
          .map((r) => `${r?._id === null || r?._id === undefined ? "(unset)" : String(r._id)}=${numify(r?.n)}`)
          .join(" ") || "(none)";
      console.log(`  EventAttendance (total):        ${total}   [${split}]`);
    }
  } else {
    console.log(
      `  EventAttendance (total):        (collection ${attendanceIx.state} — expected before PR 3)`,
    );
  }

  // (iv) HOW OVERDUE THE PURGE IS. The one line an operator should be able to
  // read at a glance. Nothing runs purge-event-answers.mjs automatically — there
  // is no cron in this repository — so this is the backlog.
  //
  // It CANNOT tell you the answers are still readable: the app's read cutoff
  // (D-52 layer 1) already refuses to return answers past the same 60 days
  // whether or not this number is zero. A non-zero here means they still EXIST,
  // not that they are reachable.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - EVENT_ANSWER_RETENTION_DAYS * DAY_SECONDS;
    // Whole-collection read with a narrow projection: `(endTime ?? startTime)`
    // older than a cutoff is not expressible as one Mongo filter, so the
    // coalesce is done in JS. findAll self-verifies against an independent
    // $count and throws rather than returning a prefix.
    const allEvents = await findAll(db, "Event", {
      eventID: 1,
      startTime: 1,
      endTime: 1,
      answersPurgedAt: 1,
    });
    let overdue = 0;
    let overdueKeyAbsent = 0;
    let undated = 0;
    for (const e of allEvents) {
      const purged = e?.answersPurgedAt;
      // null AND absent both mean "not purged" for this count. They are not the
      // same to the purge script: its Prisma `where: { answersPurgedAt: null }`
      // matches a STORED null and NOT an absent key, so a row missing the key
      // shows up here and would NOT be swept. That gap is counted separately.
      if (purged !== null && purged !== undefined) continue;
      const ref = e?.endTime ?? e?.startTime ?? null;
      if (ref === null || ref === undefined) {
        undated++;
        continue;
      }
      if (numify(ref) <= cutoffSec) {
        overdue++;
        if (purged === undefined) overdueKeyAbsent++;
      }
    }
    console.log(
      `  answer purge OVERDUE by event:  ${overdue}   Event(s) past the ${EVENT_ANSWER_RETENTION_DAYS}-day cutoff ` +
        `with answersPurgedAt unset.`,
    );
    console.log(
      `                                  Run \`node scripts/remediation/purge-event-answers.mjs\` ` +
        `(dry run) to see what it would erase.\n` +
        `                                  Nothing runs it automatically; there is no cron in this repository. ` +
        `The app's read\n` +
        `                                  cutoff already hides these answers, so this is a backlog of EXISTENCE, ` +
        `not of access.`,
    );
    if (overdueKeyAbsent > 0) {
      console.log(
        `                                  of those, ${overdueKeyAbsent} have NO answersPurgedAt KEY at all — ` +
          `the purge script's\n` +
          `                                  \`where: { answersPurgedAt: null }\` would NOT match them. Clear those by hand.`,
      );
    }
    console.log(
      `  Event with no date on file:     ${undated}   (skipped by the purge: nothing to count 60 days from)`,
    );
  } catch (e) {
    console.log(
      `  answer purge OVERDUE by event:  (unreadable: ${String(e?.message ?? e)}) — informational only, ` +
        `the exit code is unaffected.`,
    );
  }

  console.log(`\n=== ${failed === 0 ? "PASS" : `FAIL (${failed} blocking)`} ===\n`);
  console.log(`Nothing was written.\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(`\nUNEXPECTED: ${e?.stack ?? e}\n`);
    // NOT an unconditional 2. A run that has ALREADY recorded a blocking failure
    // and then loses the connection would otherwise report 2, whose documented
    // meaning is "nothing was measured, this is NOT evidence the schema is
    // healthy" — and CI could not tell a missing EventLock index from a network
    // blip. A detected DATA failure outranks a later connectivity problem.
    process.exitCode = failed > 0 ? 1 : 2;
  })
  .finally(() => db.$disconnect());
