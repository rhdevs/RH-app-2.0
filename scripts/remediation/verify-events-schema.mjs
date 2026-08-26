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
 *
 * EXIT CODES. The distinction that matters is 1 vs 2: a 1 means the checks RAN
 * and something is wrong with the data; a 2 means nothing was measured at all,
 * so it is NOT evidence the schema is healthy.
 *   0  every blocking check passed. [6] is informational and never affects it.
 *   1  a blocking check failed ([1]-[5], [7]).
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
import { countWhere, numify, isCommit, abort } from "./lib/rbac.mjs";

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
